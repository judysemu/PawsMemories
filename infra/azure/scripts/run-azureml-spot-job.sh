#!/usr/bin/env bash
set -euo pipefail

action="${1:-plan}"
case "$action" in
  plan|validate|submit) ;;
  *) echo "Usage: $0 [plan|validate|submit]" >&2; exit 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
preflight="${repo_root}/infra/azure/scripts/preflight-azureml-spot-job.sh"
template="${repo_root}/infra/azure/azureml-job/pipeline.template.yml"
code_path="${repo_root}/infra/azure/azureml-job/code"
AZURE_CLI="${AZURE_CLI:-az}"

"$preflight"

: "${AZURE_ML_INPUT_IMAGE:?AZURE_ML_INPUT_IMAGE is required}"
: "${AZURE_ML_OUTPUT_DIR:?AZURE_ML_OUTPUT_DIR is required}"
[[ "$AZURE_ML_INPUT_IMAGE" == /* && -f "$AZURE_ML_INPUT_IMAGE" ]] || { echo "Input must be an absolute local image path" >&2; exit 2; }
[[ ! -e "$AZURE_ML_OUTPUT_DIR" ]] || { echo "Output path already exists; choose a new directory" >&2; exit 2; }
[[ "$AZURE_ML_INPUT_IMAGE" != *['"\']* && "$AZURE_ML_INPUT_IMAGE" != *$'\n'* ]] || { echo "Input path contains unsupported YAML characters" >&2; exit 2; }
[[ "$AZURE_ML_MODELS_URI" != *['"\']* && "$AZURE_ML_MODELS_URI" != *$'\n'* ]] || { echo "Model URI contains unsupported YAML characters" >&2; exit 2; }
[[ "$code_path" != *['"\']* && "$code_path" != *$'\n'* ]] || { echo "Repository path contains unsupported YAML characters" >&2; exit 2; }

rendered="$(mktemp "${TMPDIR:-/tmp}/paws-azureml-spot.XXXXXX")"
cleanup() { rm -f "$rendered"; }
trap cleanup EXIT
cp "$template" "$rendered"
replace() {
  PAWS_TEMPLATE_VALUE="$2" perl -0pi -e "s|$1|\$ENV{PAWS_TEMPLATE_VALUE}|g" "$rendered"
}
replace __INPUT_IMAGE__ "$AZURE_ML_INPUT_IMAGE"
replace __MODELS_URI__ "$AZURE_ML_MODELS_URI"
replace __MODELS_MANIFEST_SHA256__ "$AZURE_ML_MODELS_MANIFEST_SHA256"
replace __TRELLIS_IMAGE__ "$AZURE_ML_TRELLIS_IMAGE"
replace __BLENDER_IMAGE__ "$AZURE_ML_BLENDER_IMAGE"
replace __RUNTIME_REPOSITORY_REVISION__ "$AZURE_ML_RUNTIME_REPOSITORY_REVISION"
replace __CODE_PATH__ "$code_path"

python3 - "$rendered" <<'PY'
import sys
import yaml
with open(sys.argv[1], encoding="utf-8") as handle:
    value = yaml.safe_load(handle)
if value.get("type") != "pipeline" or set(value.get("jobs", {})) != {"trellis_generate", "blender_finalize"}:
    raise SystemExit("Rendered Azure ML pipeline is invalid")
PY

if [[ "$action" == "plan" ]]; then
  echo "PASS: read-only preflight and local pipeline rendering passed; no job was submitted."
  exit 0
fi

export AZURE_CONFIG_DIR="$AZURE_ML_CONFIG_DIR"
$AZURE_CLI ml job validate \
  --subscription "$AZURE_ML_SUBSCRIPTION_ID" \
  --resource-group "$AZURE_ML_RESOURCE_GROUP" \
  --workspace-name "$AZURE_ML_WORKSPACE" \
  --file "$rendered" \
  --output none
if [[ "$action" == "validate" ]]; then
  echo "PASS: Azure ML accepted the pipeline specification; no job was submitted."
  exit 0
fi

[[ "${CONFIRM_AZURE_SPEND:-}" == "YES" ]] || { echo "Submission refused: set CONFIRM_AZURE_SPEND=YES" >&2; exit 2; }
[[ "${CONFIRM_AZURE_ML_SPOT_SPEND:-}" == "YES" ]] || { echo "Submission refused: set CONFIRM_AZURE_ML_SPOT_SPEND=YES" >&2; exit 2; }
[[ "${CONFIRM_ONE_REAL_IMAGE_E2E:-}" == "YES" ]] || { echo "Submission refused: set CONFIRM_ONE_REAL_IMAGE_E2E=YES" >&2; exit 2; }

job_name="$($AZURE_CLI ml job create \
  --subscription "$AZURE_ML_SUBSCRIPTION_ID" \
  --resource-group "$AZURE_ML_RESOURCE_GROUP" \
  --workspace-name "$AZURE_ML_WORKSPACE" \
  --file "$rendered" \
  --query name --output tsv)"
[[ -n "$job_name" ]] || { echo "Azure ML returned no job name" >&2; exit 1; }
printf 'Submitted finite Spot job: %s\n' "$job_name"
printf 'Safe stop: az ml job cancel -n %q -g "$AZURE_ML_RESOURCE_GROUP" -w "$AZURE_ML_WORKSPACE" --subscription "$AZURE_ML_SUBSCRIPTION_ID"\n' "$job_name"
printf 'Resume: az ml job stream -n %q -g "$AZURE_ML_RESOURCE_GROUP" -w "$AZURE_ML_WORKSPACE" --subscription "$AZURE_ML_SUBSCRIPTION_ID"\n' "$job_name"

$AZURE_CLI ml job stream \
  --subscription "$AZURE_ML_SUBSCRIPTION_ID" \
  --resource-group "$AZURE_ML_RESOURCE_GROUP" \
  --workspace-name "$AZURE_ML_WORKSPACE" \
  --name "$job_name"
status="$($AZURE_CLI ml job show \
  --subscription "$AZURE_ML_SUBSCRIPTION_ID" \
  --resource-group "$AZURE_ML_RESOURCE_GROUP" \
  --workspace-name "$AZURE_ML_WORKSPACE" \
  --name "$job_name" \
  --query status --output tsv)"
[[ "$status" == "Completed" ]] || { echo "Azure ML pipeline did not complete: ${status}" >&2; exit 1; }

mkdir -p "$(dirname "$AZURE_ML_OUTPUT_DIR")"
$AZURE_CLI ml job download \
  --subscription "$AZURE_ML_SUBSCRIPTION_ID" \
  --resource-group "$AZURE_ML_RESOURCE_GROUP" \
  --workspace-name "$AZURE_ML_WORKSPACE" \
  --name "$job_name" \
  --output-name final_glb \
  --download-path "$AZURE_ML_OUTPUT_DIR"
final_count="$(find "$AZURE_ML_OUTPUT_DIR" -type f -name final.glb -print | wc -l | tr -d ' ')"
acceptance_count="$(find "$AZURE_ML_OUTPUT_DIR" -type f -name acceptance.json -print | wc -l | tr -d ' ')"
[[ "$final_count" == "1" && "$acceptance_count" == "1" ]] || { echo "Downloaded output is incomplete or ambiguous" >&2; exit 1; }
final_path="$(find "$AZURE_ML_OUTPUT_DIR" -type f -name final.glb -print)"
acceptance_path="$(find "$AZURE_ML_OUTPUT_DIR" -type f -name acceptance.json -print)"
artifact_directory="$(dirname "$final_path")"
[[ "$(dirname "$acceptance_path")" == "$artifact_directory" ]] || { echo "Downloaded acceptance envelope is detached" >&2; exit 1; }
"${repo_root}/node_modules/.bin/tsx" \
  "${repo_root}/infra/azure/azureml-job/validate-output.mjs" \
  --directory "$artifact_directory" \
  --repository-revision "$AZURE_ML_RUNTIME_REPOSITORY_REVISION"
printf 'IN-HOUSE AZURE ML E2E PASS: %s\n' "$artifact_directory"
