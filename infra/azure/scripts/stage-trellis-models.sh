#!/usr/bin/env bash
set -euo pipefail
umask 027

mode="${1:-complete}"
if [[ "$mode" != "complete" && "$mode" != "public-only" ]]; then
  echo "Usage: $0 [complete|public-only]"
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
lock_file="${repo_root}/infra/azure/models/trellis2.lock.json"
stage_root="${TRELLIS_STAGE_ROOT:-/opt/paws-model-staging}"
source_root="${stage_root}/source"
source_dir="${source_root}/TRELLIS.2"
models_root="${stage_root}/models"

for dependency in docker git jq; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    echo "Missing required staging dependency: $dependency"
    exit 1
  fi
done

source_repository="$(jq -er '.source.repository' "$lock_file")"
source_revision="$(jq -er '.source.revision' "$lock_file")"

install -d -m 0750 "$stage_root" "$source_root" "$models_root"
if [[ ! -d "${source_dir}/.git" ]]; then
  if [[ -e "$source_dir" ]]; then
    echo "Refusing to replace a non-Git source path: $source_dir"
    exit 1
  fi
  git clone --filter=blob:none --no-checkout "$source_repository" "$source_dir"
fi

git -C "$source_dir" remote set-url origin "$source_repository"
git -C "$source_dir" fetch --depth 1 origin "$source_revision"
git -C "$source_dir" checkout --detach "$source_revision"
git -C "$source_dir" submodule update --init --recursive
actual_source_revision="$(git -C "$source_dir" rev-parse HEAD)"
if [[ "$actual_source_revision" != "$source_revision" ]]; then
  echo "Pinned TRELLIS source revision did not verify"
  exit 1
fi

docker_environment=(
  --env HOME=/tmp
  --env HF_HUB_DISABLE_TELEMETRY=1
)
if [[ -n "${HF_TOKEN:-}" ]]; then
  docker_environment+=(--env HF_TOKEN)
fi

downloader_args=(
  --lock /work/infra/azure/models/trellis2.lock.json
  --output /stage
  --source-revision "$actual_source_revision"
)
if [[ "$mode" == "public-only" ]]; then
  downloader_args+=(--public-only)
fi

docker run --rm \
  --user "$(id -u):$(id -g)" \
  "${docker_environment[@]}" \
  --volume "${repo_root}:/work:ro" \
  --volume "${stage_root}:/stage" \
  python:3.11-slim \
  sh -euc \
    'python -m pip install --quiet --disable-pip-version-check --target /tmp/hfclient huggingface-hub==0.34.4 && PYTHONPATH=/tmp/hfclient python /work/infra/azure/scripts/stage_trellis_models.py "$@"' \
  _ "${downloader_args[@]}"

echo "TRELLIS staging manifest: ${stage_root}/trellis2-staging-manifest.json"
