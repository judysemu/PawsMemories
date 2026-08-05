#!/usr/bin/env bash
set -euo pipefail

phase="${1:-plan}"
if [[ "$phase" != "plan" && "$phase" != "foundation" && "$phase" != "serving" ]]; then
  echo "Usage: $0 [plan|foundation|serving]"
  exit 2
fi

target_subscription_id="${AZURE_ACA_SUBSCRIPTION_ID:-}"
target_tenant_id="${AZURE_ACA_TENANT_ID:-}"
target_location="${AZURE_ACA_LOCATION:-}"
resource_group="${AZURE_ACA_RESOURCE_GROUP:-Trellis-ACA-A100}"
prefix="${AZURE_ACA_PREFIX:-pawstrellis}"
environment_name="${AZURE_ACA_ENVIRONMENT_NAME:-${prefix}-aca-a100-env}"
ingress_mode="${AZURE_ACA_INGRESS_MODE:-external-allowlist}"
core_source_cidr="${AZURE_ACA_CORE_SOURCE_CIDR:-}"
worker_secret_name="${AZURE_ACA_WORKER_SECRET_NAME:-worker-shared-secret}"
trellis_repository="${AZURE_ACA_TRELLIS_REPOSITORY:-paws-trellis2}"
trellis_digest="${AZURE_ACA_TRELLIS_DIGEST:-0000000000000000000000000000000000000000000000000000000000000000}"
blender_repository="${AZURE_ACA_BLENDER_REPOSITORY:-paws-blender-worker}"
blender_digest="${AZURE_ACA_BLENDER_DIGEST:-0000000000000000000000000000000000000000000000000000000000000000}"
runtime_repository_revision="${AZURE_ACA_RUNTIME_REPOSITORY_REVISION:-e2cb178e349f5907d354a1b597e24d7a4ee57438}"
models_manifest_sha256="${AZURE_ACA_MODELS_MANIFEST_SHA256:-}"
gpu_profile_type="Consumption-GPU-NC24-A100"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
runtime_lock="${repo_root}/infra/azure/runtime/gpu-runtime.lock.json"
model_staging_lock="${repo_root}/infra/azure/models/trellis2-staging.lock.json"
manifest_readback=""
cleanup_manifest_readback() {
  [[ -z "$manifest_readback" ]] || rm -f "$manifest_readback"
}
trap cleanup_manifest_readback EXIT

for required_command in az jq openssl python3; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "FAIL missing command: $required_command"
    exit 1
  fi
done

if [[ -z "$target_subscription_id" || -z "$target_tenant_id" || -z "$target_location" ]]; then
  echo "FAIL AZURE_ACA_SUBSCRIPTION_ID, AZURE_ACA_TENANT_ID, and AZURE_ACA_LOCATION are required; this lane never falls back to the core account context"
  exit 1
fi

if [[ "$ingress_mode" != "external-allowlist" && "$ingress_mode" != "internal" ]]; then
  echo "FAIL AZURE_ACA_INGRESS_MODE must be external-allowlist or internal"
  exit 1
fi

if [[ "$phase" == "serving" && "$ingress_mode" == "external-allowlist" ]]; then
  if [[ -z "$core_source_cidr" || "$core_source_cidr" == "192.0.2.0/32" ]]; then
    echo "BLOCKED external serving requires the core's exact fixed egress CIDR in AZURE_ACA_CORE_SOURCE_CIDR"
    exit 2
  fi
  if ! python3 - "$core_source_cidr" <<'PY'
import ipaddress
import sys

try:
    network = ipaddress.ip_network(sys.argv[1], strict=False)
except ValueError:
    raise SystemExit(1)
if network.version != 4 or network.prefixlen != 32 or "/" not in sys.argv[1]:
    raise SystemExit(1)
PY
  then
    echo "BLOCKED AZURE_ACA_CORE_SOURCE_CIDR must be one exact IPv4 /32 CIDR"
    exit 2
  fi
fi

if [[ "$phase" == "serving" ]]; then
  if [[ "${AZURE_ACA_AGGREGATE_READINESS_IMAGES_ACCEPTED:-}" != "YES" ]]; then
    echo "BLOCKED serving requires rebuilt and reaccepted TRELLIS plus Blender images that implement aggregate readiness"
    exit 2
  fi
  if [[ ! "$trellis_digest" =~ ^[0-9a-f]{64}$ || ! "$blender_digest" =~ ^[0-9a-f]{64}$ \
    || "$trellis_digest" == "0000000000000000000000000000000000000000000000000000000000000000" \
    || "$blender_digest" == "0000000000000000000000000000000000000000000000000000000000000000" ]]; then
    echo "BLOCKED serving requires two non-placeholder lowercase sha256 image digests"
    exit 2
  fi
  if [[ ! "$runtime_repository_revision" =~ ^[0-9a-f]{40}$ ]]; then
    echo "BLOCKED AZURE_ACA_RUNTIME_REPOSITORY_REVISION must be one full lowercase 40-hex Git revision"
    exit 2
  fi
  if [[ "$runtime_repository_revision" == "e2cb178e349f5907d354a1b597e24d7a4ee57438" ]]; then
    echo "BLOCKED the previous repository revision predates aggregate-readiness images"
    exit 2
  fi
  if [[ ! -f "$runtime_lock" ]] || ! jq -e '.schemaVersion == 1 and (.images | type == "array")' "$runtime_lock" >/dev/null 2>&1; then
    echo "BLOCKED the local GPU runtime lock is missing or invalid"
    exit 2
  fi
  if [[ ! -f "$model_staging_lock" ]] || ! jq -e \
    '.schemaVersion == 1 and .acceptance == "private-readback-verified"' \
    "$model_staging_lock" >/dev/null 2>&1; then
    echo "BLOCKED the accepted model staging lock is missing or invalid"
    exit 2
  fi
  accepted_manifest_sha256="$(jq -r '.manifestSha256' "$model_staging_lock")"
  if [[ ! "$models_manifest_sha256" =~ ^[0-9a-f]{64}$ \
    || "$models_manifest_sha256" != "$accepted_manifest_sha256" ]]; then
    echo "BLOCKED AZURE_ACA_MODELS_MANIFEST_SHA256 must match the private-readback-verified staging lock"
    exit 2
  fi
  locked_repository_revision="$(jq -r '.repositoryRevision // ""' "$runtime_lock")"
  locked_trellis_ref="$(jq -r '.images[] | select(.component == "trellis2") | .registryImageRef // ""' "$runtime_lock")"
  locked_blender_ref="$(jq -r '.images[] | select(.component == "blender-worker") | .registryImageRef // ""' "$runtime_lock")"
  locked_trellis_state="$(jq -r '.images[] | select(.component == "trellis2") | .cacheState' "$runtime_lock")"
  locked_blender_state="$(jq -r '.images[] | select(.component == "blender-worker") | .cacheState' "$runtime_lock")"
  if [[ "$locked_repository_revision" != "$runtime_repository_revision" \
    || "$locked_trellis_state" != "verified-private-readback" \
    || "$locked_blender_state" != "verified-private-readback" ]]; then
    echo "BLOCKED repository revision must match a fully private-readback-verified runtime lock"
    exit 2
  fi
fi

account_json="$(az account show --subscription "$target_subscription_id" --query '{state:state,tenantId:tenantId}' -o json 2>/dev/null || true)"
account_state="$(jq -r '.state // ""' <<<"$account_json")"
account_tenant_id="$(jq -r '.tenantId // ""' <<<"$account_json")"
if [[ "$account_state" != "Enabled" ]]; then
  echo "BLOCKED the explicitly selected Container Apps subscription is not available through the current CLI profile"
  exit 2
fi
if [[ "$account_tenant_id" != "$target_tenant_id" ]]; then
  echo "BLOCKED the selected subscription does not match AZURE_ACA_TENANT_ID; authenticate the target tenant in an isolated CLI profile"
  exit 2
fi
echo "PASS explicit target subscription and tenant context"

blocked=0
for provider in \
  Microsoft.App \
  Microsoft.ContainerRegistry \
  Microsoft.Storage \
  Microsoft.KeyVault \
  Microsoft.ManagedIdentity \
  Microsoft.OperationalInsights \
  Microsoft.Authorization \
  Microsoft.Quota; do
  state="$(az provider show \
    --subscription "$target_subscription_id" \
    --namespace "$provider" \
    --query registrationState -o tsv 2>/dev/null || true)"
  if [[ "$state" == "Registered" ]]; then
    echo "PASS provider $provider"
  else
    echo "BLOCKED provider $provider is ${state:-unknown}; preflight never registers providers"
    blocked=1
  fi
done

supported_profiles_json="$(az containerapp env workload-profile list-supported \
  --subscription "$target_subscription_id" \
  --location "$target_location" -o json 2>/dev/null || true)"
if jq -e --arg profile "$gpu_profile_type" '.. | strings | select(. == $profile)' \
  <<<"$supported_profiles_json" >/dev/null 2>&1; then
  echo "PASS region advertises $gpu_profile_type"
else
  echo "BLOCKED region does not advertise $gpu_profile_type to the selected subscription"
  blocked=1
fi

regional_usage_url="https://management.azure.com/subscriptions/${target_subscription_id}/providers/Microsoft.App/locations/${target_location}/usages?api-version=2026-01-01"
regional_usage_json="$(az rest --method get --url "$regional_usage_url" --subscription "$target_subscription_id" -o json 2>/dev/null || true)"
if jq -e '.value | type == "array"' <<<"$regional_usage_json" >/dev/null 2>&1; then
  echo "PASS Microsoft.App regional usage endpoint is readable"
else
  echo "BLOCKED Microsoft.App regional usage endpoint is not readable"
  blocked=1
fi

if [[ "$phase" == "foundation" ]]; then
  if [[ "${AZURE_ACA_NCA100_QUOTA_CONFIRMED:-}" == "YES" ]]; then
    echo "PASS operator confirmed the target subscription's Managed Environment Consumption NCA100 approval"
  else
    echo "BLOCKED foundation apply requires AZURE_ACA_NCA100_QUOTA_CONFIRMED=YES after the target tenant's approval is visible"
    blocked=1
  fi
fi

if [[ "$phase" == "serving" ]]; then
  if ! az containerapp env show \
    --subscription "$target_subscription_id" \
    --resource-group "$resource_group" \
    --name "$environment_name" -o none >/dev/null 2>&1; then
    echo "BLOCKED target-local Container Apps environment does not exist; apply the foundation first"
    blocked=1
  else
    environment_usage_url="https://management.azure.com/subscriptions/${target_subscription_id}/resourceGroups/${resource_group}/providers/Microsoft.App/managedEnvironments/${environment_name}/usages?api-version=2026-01-01"
    environment_usage_json="$(az rest --method get --url "$environment_usage_url" --subscription "$target_subscription_id" -o json 2>/dev/null || true)"
    quota_row="$(jq -r '
      [
        .value[]?
        | . as $item
        | (((.name.value // "") + " " + (.name.localizedValue // "")) | ascii_downcase) as $label
        | select(($label | contains("consumption")) and ($label | contains("nca100")))
        | [
            ($item.currentValue // 0),
            (if ($item.limit | type) == "object" then ($item.limit.value // 0) else ($item.limit // 0) end)
          ]
      ][0] // [] | @tsv
    ' <<<"$environment_usage_json")"
    if [[ -z "$quota_row" ]]; then
      echo "BLOCKED managed-environment usage does not expose the Consumption NCA100 quota"
      blocked=1
    else
      read -r gpu_usage gpu_limit <<<"$quota_row"
      if jq -n -e --argjson usage "$gpu_usage" --argjson limit "$gpu_limit" \
        '($limit - $usage) >= 1' >/dev/null; then
        echo "PASS managed environment has at least one available Consumption NCA100 GPU"
      else
        echo "BLOCKED managed environment does not have one available Consumption NCA100 GPU"
        blocked=1
      fi
    fi
  fi

  registry_name="$(az acr list \
    --subscription "$target_subscription_id" \
    --resource-group "$resource_group" \
    --query "[?tags.workload=='paws-aca-a100'].name | [0]" -o tsv 2>/dev/null || true)"
  if [[ -z "$registry_name" ]]; then
    echo "BLOCKED target-local ACR was not found"
    blocked=1
  else
    registry_server="$(az acr show \
      --subscription "$target_subscription_id" \
      --name "$registry_name" \
      --query loginServer -o tsv 2>/dev/null || true)"
    expected_trellis_ref="${registry_server}/${trellis_repository}@sha256:${trellis_digest}"
    expected_blender_ref="${registry_server}/${blender_repository}@sha256:${blender_digest}"
    if [[ -z "$registry_server" \
      || "$locked_trellis_ref" != "$expected_trellis_ref" \
      || "$locked_blender_ref" != "$expected_blender_ref" ]]; then
      echo "BLOCKED runtime lock registry digests do not match the target-local ACR"
      blocked=1
    fi
    for descriptor in \
      "${trellis_repository}@sha256:${trellis_digest}" \
      "${blender_repository}@sha256:${blender_digest}"; do
      resolved_digest="$(az acr manifest show-metadata \
        --registry "$registry_name" \
        --name "$descriptor" \
        --query digest -o tsv 2>/dev/null || true)"
      if [[ "$resolved_digest" == "sha256:${descriptor##*sha256:}" ]]; then
        echo "PASS immutable accepted image digest is staged in the target-local ACR"
      else
        echo "BLOCKED an immutable accepted image digest is absent from the target-local ACR"
        blocked=1
      fi
    done
  fi

  storage_name="$(az storage account list \
    --subscription "$target_subscription_id" \
    --resource-group "$resource_group" \
    --query "[?tags.workload=='paws-aca-a100'].name | [0]" -o tsv 2>/dev/null || true)"
  if [[ -z "$storage_name" ]]; then
    echo "BLOCKED target-local model/job storage was not found"
    blocked=1
  elif ! az storage share-rm show \
    --subscription "$target_subscription_id" \
    --resource-group "$resource_group" \
    --storage-account "$storage_name" \
    --name models -o none >/dev/null 2>&1; then
    echo "BLOCKED target-local models share was not found"
    blocked=1
  else
    manifest_readback="$(mktemp "${TMPDIR:-/tmp}/paws-aca-model-manifest.XXXXXX")"
    if ! az storage file download \
      --subscription "$target_subscription_id" \
      --account-name "$storage_name" \
      --share-name models \
      --path trellis2-staging-manifest.json \
      --dest "$manifest_readback" \
      --auth-mode login \
      --only-show-errors >/dev/null 2>&1; then
      echo "BLOCKED target-local model manifest cannot be read with identity-based access"
      blocked=1
    elif [[ "$(openssl dgst -sha256 -r "$manifest_readback" | awk '{print $1}')" != "$accepted_manifest_sha256" ]]; then
      echo "BLOCKED target-local model manifest differs from the accepted private readback"
      blocked=1
    elif ! jq -e \
      --arg lockSha256 "$(jq -r '.modelLockSha256' "$model_staging_lock")" \
      --arg sourceRevision "$(jq -r '.sourceRevision' "$model_staging_lock")" \
      --argjson modelCount "$(jq -r '.modelCount' "$model_staging_lock")" \
      --argjson trackedFiles "$(jq -r '.trackedFiles' "$model_staging_lock")" \
      --argjson trackedBytes "$(jq -r '.trackedBytes' "$model_staging_lock")" \
      '(.schemaVersion == 1)
       and (.state == "complete")
       and (.runtimeNetworkPolicy == "offline")
       and (.awaitingAccess == [])
       and (.lockSha256 == $lockSha256)
       and (.source.revision == $sourceRevision)
       and ((.models | length) == $modelCount)
       and (([.models[].files[]] | length) == $trackedFiles)
       and (([.models[].files[].bytes] | add) == $trackedBytes)' \
      "$manifest_readback" >/dev/null; then
      echo "BLOCKED target-local model manifest inventory is not accepted"
      blocked=1
    else
      echo "PASS target-local offline model manifest matches the accepted private readback; worker readiness rehashes every file"
    fi
  fi

  key_vault_name="$(az keyvault list \
    --subscription "$target_subscription_id" \
    --resource-group "$resource_group" \
    --query "[?tags.workload=='paws-aca-a100'].name | [0]" -o tsv 2>/dev/null || true)"
  if [[ -z "$key_vault_name" ]]; then
    echo "BLOCKED target-local Key Vault was not found"
    blocked=1
  else
    secret_enabled="$(az keyvault secret show \
      --subscription "$target_subscription_id" \
      --vault-name "$key_vault_name" \
      --name "$worker_secret_name" \
      --query attributes.enabled -o tsv 2>/dev/null || true)"
    if [[ "$secret_enabled" == "true" ]]; then
      echo "PASS target-local Key Vault secret metadata is present and enabled"
    else
      echo "BLOCKED required target-local Key Vault secret is absent or disabled"
      blocked=1
    fi
  fi
fi

if (( blocked != 0 )); then
  exit 2
fi

echo "PASS optional Container Apps A100 $phase preflight"
