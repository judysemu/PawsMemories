#!/usr/bin/env bash
set -euo pipefail

lock_file="${1:-}"
component="${2:-}"
storage_account="${3:-}"
container_name="${4:-model-cache}"
restore_root="${PAWS_RUNTIME_RESTORE_ROOT:-/opt/paws-gpu/releases/runtime-images}"

if [[ -z "$lock_file" || -z "$component" || -z "$storage_account" ]]; then
  echo "Usage: restore-runtime-image.sh LOCK_FILE COMPONENT STORAGE_ACCOUNT [CONTAINER]"
  exit 2
fi
if [[ ! -f "$lock_file" ]]; then
  echo "Runtime lock file does not exist"
  exit 2
fi
if [[ ! "$component" =~ ^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$ ]]; then
  echo "Invalid runtime component"
  exit 2
fi
if [[ ! "$storage_account" =~ ^[a-z0-9]{3,24}$ ]]; then
  echo "Invalid storage account name"
  exit 2
fi
if [[ ! "$container_name" =~ ^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$ ]]; then
  echo "Invalid Blob container name"
  exit 2
fi

for required_command in azcopy docker jq sha256sum zstd; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command"
    exit 1
  fi
done

locked_image="$(jq -c --arg component "$component" '.images[] | select(.component == $component)' "$lock_file")"
if [[ -z "$locked_image" ]]; then
  echo "Runtime component is not present in the lock"
  exit 2
fi
if [[ "$(jq -r '.cacheState // ""' <<<"$locked_image")" != "verified-private-readback" ]]; then
  echo "Runtime component is not verified by private readback"
  exit 2
fi

image_ref="$(jq -r '.imageRef' <<<"$locked_image")"
build_revision="$(jq -r '.buildRevision' <<<"$locked_image")"
blob_prefix="$(jq -r '.blobPrefix' <<<"$locked_image")"
archive_name="$(jq -r '.archiveName' <<<"$locked_image")"
manifest_name="$(jq -r '.manifestName' <<<"$locked_image")"
locked_archive_sha256="$(jq -r '.archiveSha256 // ""' <<<"$locked_image")"
locked_archive_bytes="$(jq -r '.archiveBytes // 0' <<<"$locked_image")"
locked_image_id="$(jq -r '.imageId // ""' <<<"$locked_image")"
locked_manifest_sha256="$(jq -r '.manifestSha256 // ""' <<<"$locked_image")"
locked_repository_revision="$(jq -r '.repositoryRevision // ""' <<<"$locked_image")"

if [[ ! "$build_revision" =~ ^[a-f0-9]{7,40}$ ]]; then
  echo "Locked build revision is invalid"
  exit 2
fi
if [[ ! "$locked_archive_sha256" =~ ^[a-f0-9]{64}$ \
  || ! "$locked_manifest_sha256" =~ ^[a-f0-9]{64}$ \
  || ! "$locked_image_id" =~ ^sha256:[a-f0-9]{64}$ \
  || ! "$locked_repository_revision" =~ ^[a-f0-9]{40}$ \
  || ! "$locked_archive_bytes" =~ ^[1-9][0-9]*$ ]]; then
  echo "Runtime lock lacks complete local trust anchors"
  exit 2
fi
if [[ ! "$blob_prefix" =~ ^runtime-images/[a-zA-Z0-9._/-]+$ || "$blob_prefix" == *".."* ]]; then
  echo "Locked Blob prefix is invalid"
  exit 2
fi
for locked_name in "$archive_name" "$manifest_name"; do
  if [[ ! "$locked_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]+$ ]]; then
    echo "Locked runtime filename is invalid"
    exit 2
  fi
done

restore_dir="${restore_root}/${component}/${build_revision}"
azcopy_log_dir="${restore_dir}/azcopy-logs"
manifest_path="${restore_dir}/${manifest_name}"
archive_path="${restore_dir}/${archive_name}"
manifest_part="${manifest_path}.part"
archive_part="${archive_path}.part"
install -d -m 0700 "$restore_dir" "$azcopy_log_dir"

export AZCOPY_AUTO_LOGIN_TYPE=MSI
export AZCOPY_LOG_LOCATION="$azcopy_log_dir"
export AZCOPY_JOB_PLAN_LOCATION="$azcopy_log_dir"
blob_root="https://${storage_account}.blob.core.windows.net/${container_name}/${blob_prefix}"

rm -f "$manifest_part" "$archive_part"
azcopy copy "${blob_root}/${manifest_name}" "$manifest_part" \
  --from-to=BlobLocal --overwrite=true --check-length=true \
  --output-type=json >"${azcopy_log_dir}/manifest-download.json" 2>&1
test "$(sha256sum "$manifest_part" | awk '{print $1}')" = "$locked_manifest_sha256"

jq -e \
  --arg component "$component" \
  --arg imageRef "$image_ref" \
  --arg buildRevision "$build_revision" \
  --arg repositoryRevision "$locked_repository_revision" \
  --arg archive "$archive_name" \
  --arg sha256 "$locked_archive_sha256" \
  --arg imageId "$locked_image_id" \
  --argjson bytes "$locked_archive_bytes" \
  '(.schemaVersion == 1)
   and ((.component // $component) == $component)
   and (.imageRef == $imageRef)
   and (.buildRevision == $buildRevision)
   and (.repositoryRevision == $repositoryRevision)
   and (.archive == $archive)
   and (.sha256 == $sha256)
   and (.bytes == $bytes)
   and (.imageId == $imageId)' \
  "$manifest_part" >/dev/null

expected_sha256="$locked_archive_sha256"
expected_bytes="$locked_archive_bytes"
expected_image_id="$locked_image_id"

azcopy copy "${blob_root}/${archive_name}" "$archive_part" \
  --from-to=BlobLocal --overwrite=true --check-length=true \
  --output-type=json >"${azcopy_log_dir}/archive-download.json" 2>&1
test "$(stat -c '%s' "$archive_part")" = "$expected_bytes"
test "$(sha256sum "$archive_part" | awk '{print $1}')" = "$expected_sha256"
mv "$manifest_part" "$manifest_path"
mv "$archive_part" "$archive_path"

zstd -dc "$archive_path" | docker load >/dev/null
actual_image_id="$(docker image inspect --format '{{.Id}}' "$image_ref")"
test "$actual_image_id" = "$expected_image_id"

jq -n \
  --arg state loaded \
  --arg component "$component" \
  --arg buildRevision "$build_revision" \
  '{state: $state, component: $component, buildRevision: $buildRevision, privateReadbackVerified: true, imageIdVerified: true, valuesPrinted: false}'
