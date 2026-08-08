#!/usr/bin/env bash
# infra/azure/scripts/deploy-pbr-worker.sh
#
# Deploy Azure Container Apps PBR worker infrastructure.
#
# Usage:
#   ./infra/azure/scripts/deploy-pbr-worker.sh what-if
#   CONFIRM_AZURE_SPEND=YES AZURE_ACA_NCA100_QUOTA_CONFIRMED=YES \
#     ./infra/azure/scripts/deploy-pbr-worker.sh apply-foundation
#   ./infra/azure/scripts/deploy-pbr-worker.sh build-push
#   ./infra/azure/scripts/deploy-pbr-worker.sh deploy-worker
#   ./infra/azure/scripts/deploy-pbr-worker.sh status
#   ./infra/azure/scripts/deploy-pbr-worker.sh teardown-worker

set -euo pipefail

COMMAND="${1:?Usage: $0 <what-if|apply-foundation|build-push|deploy-worker|status|teardown-worker>}"

: "${AZURE_ACA_SUBSCRIPTION_ID:?Set AZURE_ACA_SUBSCRIPTION_ID}"
: "${AZURE_ACA_LOCATION:?Set AZURE_ACA_LOCATION}"

resource_group="${AZURE_ACA_RESOURCE_GROUP:-Paws-PBR-Worker}"
prefix="${AZURE_ACA_PREFIX:-pawspbr}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
template_file="${repo_root}/infra/azure/pbr-worker-main.bicep"

log()  { printf "🔧 %s\n" "$1"; }
ok()   { printf "✅ %s\n" "$1"; }
fail() { printf "❌ %s\n" "$1"; exit 1; }

ensure_rg() {
  if ! az group exists --name "$resource_group" \
       --subscription "$AZURE_ACA_SUBSCRIPTION_ID" 2>/dev/null | grep -q true; then
    log "Creating resource group $resource_group in $AZURE_ACA_LOCATION"
    az group create \
      --name "$resource_group" \
      --location "$AZURE_ACA_LOCATION" \
      --subscription "$AZURE_ACA_SUBSCRIPTION_ID" \
      --output none
  fi
  ok "Resource group $resource_group exists"
}

case "$COMMAND" in
  what-if)
    az bicep build --file "$template_file" --stdout >/dev/null
    ensure_rg
    az deployment group what-if \
      --resource-group "$resource_group" \
      --subscription "$AZURE_ACA_SUBSCRIPTION_ID" \
      --template-file "$template_file" \
      --parameters \
        location="$AZURE_ACA_LOCATION" \
        prefix="$prefix" \
      --result-format ResourceIdOnly
    ;;

  apply-foundation)
    if [[ "${CONFIRM_AZURE_SPEND:-}" != "YES" ]]; then
      fail "Set CONFIRM_AZURE_SPEND=YES to confirm Azure spend"
    fi
    if [[ "${AZURE_ACA_NCA100_QUOTA_CONFIRMED:-}" != "YES" ]]; then
      fail "Set AZURE_ACA_NCA100_QUOTA_CONFIRMED=YES to confirm GPU quota"
    fi

    az bicep build --file "$template_file" --stdout >/dev/null
    ensure_rg

    log "Deploying PBR worker foundation..."
    az deployment group create \
      --resource-group "$resource_group" \
      --subscription "$AZURE_ACA_SUBSCRIPTION_ID" \
      --template-file "$template_file" \
      --parameters \
        location="$AZURE_ACA_LOCATION" \
        prefix="$prefix" \
      --query properties.outputs -o json

    ok "PBR worker foundation deployed"
    ;;

  build-push)
    # Discover the ACR login server from the deployment
    acr_server=$(az deployment group show \
      --resource-group "$resource_group" \
      --subscription "$AZURE_ACA_SUBSCRIPTION_ID" \
      --name "pbr-worker-main" \
      --query 'properties.outputs.registryLoginServer.value' -o tsv 2>/dev/null || true)

    if [[ -z "$acr_server" ]]; then
      # Fallback: list registries in the resource group
      acr_server=$(az acr list \
        --resource-group "$resource_group" \
        --subscription "$AZURE_ACA_SUBSCRIPTION_ID" \
        --query '[0].loginServer' -o tsv 2>/dev/null || true)
    fi

    if [[ -z "$acr_server" ]]; then
      fail "Could not find ACR login server. Run apply-foundation first."
    fi

    acr_name=$(echo "$acr_server" | cut -d. -f1)
    log "Building PBR worker image in ACR: $acr_name"

    az acr build \
      --registry "$acr_name" \
      --subscription "$AZURE_ACA_SUBSCRIPTION_ID" \
      --image paws-pbr-worker:latest \
      --file blender-worker/Dockerfile.pbr \
      "$repo_root"

    ok "Image pushed to $acr_server/paws-pbr-worker:latest"
    ;;

  deploy-worker)
    log "Re-deploying with worker image..."
    ensure_rg

    az deployment group create \
      --resource-group "$resource_group" \
      --subscription "$AZURE_ACA_SUBSCRIPTION_ID" \
      --template-file "$template_file" \
      --parameters \
        location="$AZURE_ACA_LOCATION" \
        prefix="$prefix" \
        workerImageName="paws-pbr-worker" \
        workerImageTag="latest" \
      --query properties.outputs -o json

    ok "PBR worker deployed"
    ;;

  status)
    log "Checking PBR worker status..."
    az containerapp show \
      --name "${prefix}-pbr-worker" \
      --resource-group "$resource_group" \
      --subscription "$AZURE_ACA_SUBSCRIPTION_ID" \
      --query '{name:name, fqdn:properties.configuration.ingress.fqdn, replicas:properties.template.scale, status:properties.provisioningState}' \
      -o json 2>/dev/null || echo "Worker not deployed yet"
    ;;

  teardown-worker)
    log "Deleting PBR worker container app (keeping ACR, Key Vault, storage)..."
    az containerapp delete \
      --name "${prefix}-pbr-worker" \
      --resource-group "$resource_group" \
      --subscription "$AZURE_ACA_SUBSCRIPTION_ID" \
      --yes 2>/dev/null || true
    ok "PBR worker removed. Re-deploy with: $0 deploy-worker"
    ;;

  *)
    echo "Usage: $0 <what-if|apply-foundation|build-push|deploy-worker|status|teardown-worker>"
    exit 2
    ;;
esac
