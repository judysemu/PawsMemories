#!/usr/bin/env bash
set -euo pipefail

mode="${1:-what-if}"
case "$mode" in
  what-if)
    deploy_serving_app=false
    aggregate_readiness_images_accepted=false
    preflight_phase=plan
    ;;
  what-if-serving)
    deploy_serving_app=true
    aggregate_readiness_images_accepted=true
    preflight_phase=serving
    ;;
  apply-foundation)
    deploy_serving_app=false
    aggregate_readiness_images_accepted=false
    preflight_phase=foundation
    ;;
  apply-serving)
    deploy_serving_app=true
    aggregate_readiness_images_accepted=true
    preflight_phase=serving
    ;;
  *)
    echo "Usage: $0 [what-if|what-if-serving|apply-foundation|apply-serving]"
    exit 2
    ;;
esac

if [[ "$mode" == apply-* && "${CONFIRM_AZURE_SPEND:-}" != "YES" ]]; then
  echo "Refusing Azure changes. Set CONFIRM_AZURE_SPEND=YES only after reviewing the target-local foundation and current pricing."
  exit 2
fi
if [[ "$mode" == "apply-serving" && "${CONFIRM_AZURE_ACA_A100_SPEND:-}" != "YES" ]]; then
  echo "Refusing A100 activation. Set CONFIRM_AZURE_ACA_A100_SPEND=YES only after reviewing per-second A100 pricing and the fixed one-replica policy."
  exit 2
fi

target_subscription_id="${AZURE_ACA_SUBSCRIPTION_ID:-}"
target_tenant_id="${AZURE_ACA_TENANT_ID:-}"
target_location="${AZURE_ACA_LOCATION:-}"
resource_group="${AZURE_ACA_RESOURCE_GROUP:-Trellis-ACA-A100}"
prefix="${AZURE_ACA_PREFIX:-pawstrellis}"
ingress_mode="${AZURE_ACA_INGRESS_MODE:-external-allowlist}"
core_source_cidr="${AZURE_ACA_CORE_SOURCE_CIDR:-192.0.2.0/32}"
worker_secret_name="${AZURE_ACA_WORKER_SECRET_NAME:-worker-shared-secret}"
trellis_repository="${AZURE_ACA_TRELLIS_REPOSITORY:-paws-trellis2}"
trellis_digest="${AZURE_ACA_TRELLIS_DIGEST:-0000000000000000000000000000000000000000000000000000000000000000}"
blender_repository="${AZURE_ACA_BLENDER_REPOSITORY:-paws-blender-worker}"
blender_digest="${AZURE_ACA_BLENDER_DIGEST:-0000000000000000000000000000000000000000000000000000000000000000}"
runtime_repository_revision="${AZURE_ACA_RUNTIME_REPOSITORY_REVISION:-e2cb178e349f5907d354a1b597e24d7a4ee57438}"

if [[ -z "$target_subscription_id" || -z "$target_tenant_id" || -z "$target_location" ]]; then
  echo "AZURE_ACA_SUBSCRIPTION_ID, AZURE_ACA_TENANT_ID, and AZURE_ACA_LOCATION are required; no current-account fallback is allowed"
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
template_file="${repo_root}/infra/azure/container-apps-gpu-main.bicep"

AZURE_ACA_SUBSCRIPTION_ID="$target_subscription_id" \
AZURE_ACA_TENANT_ID="$target_tenant_id" \
AZURE_ACA_LOCATION="$target_location" \
AZURE_ACA_RESOURCE_GROUP="$resource_group" \
AZURE_ACA_PREFIX="$prefix" \
AZURE_ACA_INGRESS_MODE="$ingress_mode" \
AZURE_ACA_CORE_SOURCE_CIDR="$core_source_cidr" \
AZURE_ACA_WORKER_SECRET_NAME="$worker_secret_name" \
AZURE_ACA_TRELLIS_REPOSITORY="$trellis_repository" \
AZURE_ACA_TRELLIS_DIGEST="$trellis_digest" \
AZURE_ACA_BLENDER_REPOSITORY="$blender_repository" \
AZURE_ACA_BLENDER_DIGEST="$blender_digest" \
AZURE_ACA_RUNTIME_REPOSITORY_REVISION="$runtime_repository_revision" \
  "${repo_root}/infra/azure/scripts/preflight-container-apps-gpu.sh" "$preflight_phase"

az bicep build --file "$template_file" --stdout >/dev/null

deployment_arguments=(
  --subscription "$target_subscription_id"
  --name "paws-aca-a100-lane"
  --location "$target_location"
  --template-file "$template_file"
  --parameters
    targetLocation="$target_location"
    resourceGroupName="$resource_group"
    prefix="$prefix"
    deployServingApp="$deploy_serving_app"
    aggregateReadinessImagesAccepted="$aggregate_readiness_images_accepted"
    ingressMode="$ingress_mode"
    coreSourceCidr="$core_source_cidr"
    workerSecretName="$worker_secret_name"
    trellisImageRepository="$trellis_repository"
    trellisImageDigest="$trellis_digest"
    blenderImageRepository="$blender_repository"
    blenderImageDigest="$blender_digest"
    runtimeRepositoryRevision="$runtime_repository_revision"
)

if [[ "$mode" == what-if* ]]; then
  az deployment sub what-if "${deployment_arguments[@]}" --result-format ResourceIdOnly
  exit 0
fi

az deployment sub create "${deployment_arguments[@]}" --query properties.outputs -o json
