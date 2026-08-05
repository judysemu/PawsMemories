#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'BLOCKED: %s\n' "$1" >&2
  exit 2
}

required=(
  AZURE_ML_CONFIG_DIR
  AZURE_ML_SUBSCRIPTION_ID
  AZURE_ML_TENANT_ID
  AZURE_ML_RESOURCE_GROUP
  AZURE_ML_WORKSPACE
  AZURE_ML_LOCATION
  AZURE_ML_TRELLIS_IMAGE
  AZURE_ML_BLENDER_IMAGE
  AZURE_ML_MODELS_URI
  AZURE_ML_MODELS_MANIFEST_SHA256
  AZURE_ML_RUNTIME_REPOSITORY_REVISION
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || fail "${name} is required; implicit Azure account context is forbidden"
done
[[ "$AZURE_ML_CONFIG_DIR" == /* && -d "$AZURE_ML_CONFIG_DIR" ]] || fail "AZURE_ML_CONFIG_DIR must be an existing absolute isolated CLI profile"
uuid_pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
[[ "$AZURE_ML_SUBSCRIPTION_ID" =~ $uuid_pattern ]] || fail "target subscription format is invalid"
[[ "$AZURE_ML_TENANT_ID" =~ $uuid_pattern ]] || fail "target tenant format is invalid"
[[ "$AZURE_ML_RESOURCE_GROUP" =~ ^[A-Za-z0-9._()\-]{1,90}$ ]] || fail "target resource group name is invalid"
[[ "$AZURE_ML_WORKSPACE" =~ ^[A-Za-z0-9][A-Za-z0-9-]{2,32}$ ]] || fail "target workspace name is invalid"
[[ "$AZURE_ML_LOCATION" =~ ^[a-z0-9]+$ ]] || fail "target location must be the normalized Azure region name"
[[ "$AZURE_ML_MODELS_MANIFEST_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail "model manifest SHA-256 is invalid"
[[ "$AZURE_ML_RUNTIME_REPOSITORY_REVISION" =~ ^[a-f0-9]{40}$ ]] || fail "runtime repository revision must be one full lowercase 40-hex Git revision"
[[ "$AZURE_ML_MODELS_URI" =~ ^azureml://datastores/([A-Za-z0-9._-]+)/paths/.+ ]] || fail "models must use an explicit workspace datastore URI"
models_datastore="${BASH_REMATCH[1]}"

AZURE_CLI="${AZURE_CLI:-az}"
command -v "$AZURE_CLI" >/dev/null 2>&1 || fail "Azure CLI is unavailable"
command -v jq >/dev/null 2>&1 || fail "jq is unavailable"
command -v git >/dev/null 2>&1 || fail "git is unavailable"
export AZURE_CONFIG_DIR="$AZURE_ML_CONFIG_DIR"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
runtime_lock="${repo_root}/infra/azure/runtime/gpu-runtime.lock.json"
model_staging_lock="${repo_root}/infra/azure/models/trellis2-staging.lock.json"
[[ -f "$runtime_lock" ]] || fail "runtime image lock is missing"
[[ -f "$model_staging_lock" ]] || fail "accepted model staging lock is missing"
[[ "$(jq -r '.acceptance // ""' "$model_staging_lock")" == "private-readback-verified" \
  && "$(jq -r '.manifestSha256 // ""' "$model_staging_lock")" == "$AZURE_ML_MODELS_MANIFEST_SHA256" ]] \
  || fail "model manifest hash is not the private-readback-verified acceptance lock"
repo_head="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || true)"
[[ "$repo_head" == "$AZURE_ML_RUNTIME_REPOSITORY_REVISION" ]] \
  || fail "local execution code is not checked out at the requested runtime repository revision"
execution_paths=(
  infra/azure/azureml-job/pipeline.template.yml
  infra/azure/azureml-job/code
  infra/azure/azureml-job/validate-output.mjs
  infra/azure/runtime/gpu-runtime.lock.json
  infra/azure/models/trellis2-staging.lock.json
  infra/azure/scripts/preflight-azureml-spot-job.sh
  infra/azure/scripts/run-azureml-spot-job.sh
  server/pet-generation/validation.ts
  server/pet-generation/contracts.ts
  package.json
  package-lock.json
)
execution_status="$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all -- "${execution_paths[@]}")"
[[ -z "$execution_status" ]] || fail "local execution code differs from the committed runtime revision"
[[ "$(jq -r '.repositoryRevision // ""' "$runtime_lock")" == "$AZURE_ML_RUNTIME_REPOSITORY_REVISION" ]] \
  || fail "runtime lock is not bound to the requested shared repository revision"

parse_image() {
  local reference="$1"
  [[ "$reference" =~ ^([a-z0-9][a-z0-9.-]*\.azurecr\.io)/([a-z0-9][a-z0-9._/-]*)@sha256:([a-f0-9]{64})$ ]] \
    || fail "runtime images must be target ACR references pinned by sha256 digest"
  IMAGE_SERVER="${BASH_REMATCH[1]}"
  IMAGE_REPOSITORY="${BASH_REMATCH[2]}"
  IMAGE_DIGEST="${BASH_REMATCH[3]}"
}

parse_image "$AZURE_ML_TRELLIS_IMAGE"
trellis_server="$IMAGE_SERVER"
trellis_repository="$IMAGE_REPOSITORY"
trellis_digest="$IMAGE_DIGEST"
parse_image "$AZURE_ML_BLENDER_IMAGE"
blender_server="$IMAGE_SERVER"
blender_repository="$IMAGE_REPOSITORY"
blender_digest="$IMAGE_DIGEST"
[[ "$trellis_server" == "$blender_server" ]] || fail "both accepted images must be in the same target ACR"

for binding in "trellis2|${AZURE_ML_TRELLIS_IMAGE}" "blender-worker|${AZURE_ML_BLENDER_IMAGE}"; do
  component="${binding%%|*}"
  supplied_ref="${binding#*|}"
  lock_line="$(jq -r --arg component "$component" '
    [.images[]? | select(.component == $component)]
    | if length == 1 then "\(.[0].cacheState // "")|\(.[0].repositoryRevision // "")|\(.[0].registryImageRef // "")" else empty end
  ' "$runtime_lock")"
  [[ -n "$lock_line" ]] || fail "runtime lock does not contain one unique component image"
  lock_state="${lock_line%%|*}"
  lock_binding="${lock_line#*|}"
  lock_revision="${lock_binding%%|*}"
  lock_ref="${lock_binding#*|}"
  [[ "$lock_state" == "verified-private-readback" ]] || fail "runtime lock image is not verified by private readback"
  [[ "$lock_revision" == "$AZURE_ML_RUNTIME_REPOSITORY_REVISION" ]] || fail "runtime lock image is not bound to the shared repository revision"
  [[ "$lock_ref" == "$supplied_ref" ]] || fail "runtime image reference is not the immutable registry reference in the accepted lock"
done

account_json="$($AZURE_CLI account show --output json 2>/dev/null)" || fail "isolated Azure CLI profile is not authenticated"
[[ "$(jq -r '.id // ""' <<<"$account_json")" == "$AZURE_ML_SUBSCRIPTION_ID" ]] || fail "isolated profile is authenticated to a different subscription"
[[ "$(jq -r '.tenantId // ""' <<<"$account_json")" == "$AZURE_ML_TENANT_ID" ]] || fail "isolated profile is authenticated to a different tenant"
[[ "$(jq -r '.state // ""' <<<"$account_json")" == "Enabled" ]] || fail "target subscription is not enabled"
$AZURE_CLI account get-access-token \
  --subscription "$AZURE_ML_SUBSCRIPTION_ID" \
  --tenant "$AZURE_ML_TENANT_ID" \
  --resource-type arm \
  --output none >/dev/null 2>&1 || fail "target ARM token is unavailable"

provider_state="$($AZURE_CLI provider show \
  --subscription "$AZURE_ML_SUBSCRIPTION_ID" \
  --namespace Microsoft.MachineLearningServices \
  --query registrationState --output tsv 2>/dev/null || true)"
[[ "$provider_state" == "Registered" ]] || fail "Microsoft.MachineLearningServices is not registered in the target subscription"

api_root="https://management.azure.com/subscriptions/${AZURE_ML_SUBSCRIPTION_ID}/providers/Microsoft.MachineLearningServices/locations/${AZURE_ML_LOCATION}"
usage_json="$($AZURE_CLI rest --method get --url "${api_root}/usages?api-version=2025-12-01" --output json 2>/dev/null)" \
  || fail "Azure ML regional usage is unreadable"
quota_line="$(jq -r '
  [.value[]? | select(
    (.type // "" | endswith("/lowPriorityCores/usages"))
    and ((.id // "") | contains("/workspaces/") | not)
  )] | if length == 1 then "\(.[0].currentValue) \(.[0].limit)" else empty end
' <<<"$usage_json")"
[[ -n "$quota_line" ]] || fail "Azure ML Total Cluster LowPriority Regional vCPU quota was not returned uniquely"
read -r low_priority_used low_priority_limit <<<"$quota_line"
[[ "$low_priority_used" =~ ^[0-9]+$ && "$low_priority_limit" =~ ^[0-9]+$ ]] || fail "Azure ML low-priority quota response is invalid"
low_priority_remaining=$((low_priority_limit - low_priority_used))
(( low_priority_remaining >= 24 )) || fail "Azure ML low-priority quota has fewer than 24 regional vCPUs available"

workspace_marker="$(printf '%s' "/resourcegroups/${AZURE_ML_RESOURCE_GROUP}/providers/microsoft.machinelearningservices/workspaces/${AZURE_ML_WORKSPACE}/" | tr '[:upper:]' '[:lower:]')"
workspace_low_priority_remaining="$(jq -r --arg marker "$workspace_marker" '
  def normalized: ascii_downcase | gsub("[^a-z0-9]"; "");
  [.value[]?
    | select(((.id // "") | ascii_downcase | contains($marker)))
    | ((.name.value // .name.localizedValue // "") | normalized) as $name
    | select(
        ($name | contains("lowpriority"))
        and (($name | contains("ncadsa100v4")) or ($name | contains("totalclusterlowpriorityregionalvcpus")))
      )
  ] as $matches
  | if ($matches | length) == 0 then "INHERIT"
    elif any($matches[]; ((.currentValue | type) != "number") or ((.limit | type) != "number")) then "INVALID"
    else ([$matches[] | if .limit == -1 then 999999999 else (.limit - .currentValue) end] | min | tostring)
    end
' <<<"$usage_json")"
case "$workspace_low_priority_remaining" in
  INHERIT) ;;
  INVALID|''|*[!0-9]*) fail "Azure ML workspace low-priority quota response is invalid" ;;
  *) (( workspace_low_priority_remaining >= 24 )) || fail "Azure ML workspace low-priority quota has fewer than 24 vCPUs available" ;;
esac

sizes_json="$($AZURE_CLI rest --method get --url "${api_root}/vmSizes?api-version=2025-12-01" --output json 2>/dev/null)" \
  || fail "Azure ML supported VM sizes are unreadable"
jq -e '
  any(.value[]?;
    (.name | ascii_downcase) == "standard_nc24ads_a100_v4"
    and .lowPriorityCapable == true
    and .gpus == 1
    and .vCPUs == 24
    and .memoryGB >= 220
    and any(.supportedComputeTypes[]?; . == "AmlCompute")
  )
' <<<"$sizes_json" >/dev/null || fail "Azure ML does not advertise low-priority NC24ads A100 in the target region"
jq -e '
  any(.value[]?;
    (.name | ascii_downcase) == "standard_a8m_v2"
    and .lowPriorityCapable == true
    and .gpus == 0
    and .vCPUs == 8
    and .memoryGB >= 64
    and any(.supportedComputeTypes[]?; . == "AmlCompute")
  )
' <<<"$sizes_json" >/dev/null || fail "Azure ML does not advertise the low-priority A8m v2 Blender shape in the target region"

workspace_url="https://management.azure.com/subscriptions/${AZURE_ML_SUBSCRIPTION_ID}/resourceGroups/${AZURE_ML_RESOURCE_GROUP}/providers/Microsoft.MachineLearningServices/workspaces/${AZURE_ML_WORKSPACE}?api-version=2025-12-01"
workspace_json="$($AZURE_CLI rest --method get --url "$workspace_url" --output json 2>/dev/null)" \
  || fail "target Azure ML workspace is unavailable"
[[ "$(jq -r '.location // "" | ascii_downcase | gsub(" "; "")' <<<"$workspace_json")" == "$AZURE_ML_LOCATION" ]] \
  || fail "workspace location does not match the quota region"
workspace_identity="$(jq -r '
  (.identity.userAssignedIdentities // {}) as $identities
  | (.properties.primaryUserAssignedIdentity // "") as $primary
  | if ($primary != "" and $identities[$primary] != null) then $primary
    elif ($identities | keys | length) == 1 then ($identities | keys[0])
    else empty end
' <<<"$workspace_json")"
[[ -n "$workspace_identity" ]] || fail "serverless managed identity requires an unambiguous workspace user-assigned identity"

datastore_url="${workspace_url%%\?*}/datastores/${models_datastore}?api-version=2025-12-01"
$AZURE_CLI rest --method get --url "$datastore_url" --output none >/dev/null 2>&1 \
  || fail "model datastore does not exist in the target workspace"

registry_json="$($AZURE_CLI acr list --subscription "$AZURE_ML_SUBSCRIPTION_ID" --output json 2>/dev/null \
  | jq -c --arg server "$trellis_server" '[.[] | select(.loginServer == $server)] | if length == 1 then .[0] else empty end')"
[[ -n "$registry_json" ]] || fail "target ACR could not be resolved uniquely"
[[ "$(jq -r '.adminUserEnabled // false' <<<"$registry_json")" == "false" ]] || fail "target ACR admin credentials must remain disabled"
registry_id="$(jq -r '.id' <<<"$registry_json")"
registry_name="$(jq -r '.name' <<<"$registry_json")"
workspace_principal="$($AZURE_CLI identity show --ids "$workspace_identity" --query principalId --output tsv 2>/dev/null || true)"
[[ -n "$workspace_principal" ]] || fail "workspace user-assigned identity principal is unavailable"
role_json="$($AZURE_CLI role assignment list \
  --assignee-object-id "$workspace_principal" \
  --scope "$registry_id" \
  --include-inherited \
  --output json 2>/dev/null || true)"
jq -e 'any(.[]?; .roleDefinitionName == "AcrPull")' <<<"${role_json:-[]}" >/dev/null \
  || fail "workspace identity lacks AcrPull on the accepted image registry"

for descriptor in \
  "${trellis_repository}@sha256:${trellis_digest}" \
  "${blender_repository}@sha256:${blender_digest}"; do
  resolved="$($AZURE_CLI acr manifest show-metadata \
    --registry "$registry_name" \
    --name "$descriptor" \
    --query digest --output tsv 2>/dev/null || true)"
  [[ "$resolved" == "${descriptor##*@}" ]] || fail "an accepted runtime image digest is absent from target ACR"
done

ml_version="$($AZURE_CLI extension show --name ml --query version --output tsv 2>/dev/null || true)"
[[ -n "$ml_version" ]] || fail "Azure CLI ml extension 2.15.0 or newer is required"
[[ "$ml_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]] || fail "Azure CLI ml extension version is invalid"
ml_major="${BASH_REMATCH[1]}"
ml_minor="${BASH_REMATCH[2]}"
(( ml_major > 2 || (ml_major == 2 && ml_minor >= 15) )) || fail "Azure CLI ml extension 2.15.0 or newer is required"

printf 'PASS: Azure ML Spot lane is ready (low-priority vCPU remaining=%s; A100 and Blender shapes advertised; images=digest-pinned; models=manifest-bound).\n' \
  "$low_priority_remaining"
