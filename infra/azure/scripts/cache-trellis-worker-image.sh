#!/usr/bin/env bash
set -euo pipefail

image_ref="${1:-}"
storage_account="${2:-}"
container_name="${3:-model-cache}"
build_revision="${4:-}"
cache_root="${PAWS_IMAGE_CACHE_ROOT:-/opt/paws-image-cache}"
readback_root="${PAWS_IMAGE_READBACK_ROOT:-/opt/paws-image-readbacks}"

if [[ -z "$image_ref" || -z "$storage_account" || -z "$build_revision" ]]; then
  echo "Usage: cache-trellis-worker-image.sh IMAGE_REF STORAGE_ACCOUNT [CONTAINER] BUILD_REVISION"
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
if [[ ! "$build_revision" =~ ^[a-f0-9]{7,40}$ ]]; then
  echo "Invalid build revision"
  exit 2
fi

for required_command in azcopy docker jq sha256sum zstd; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command"
    exit 1
  fi
done

bundle_dir="${cache_root}/${build_revision}"
readback_dir="${readback_root}/${build_revision}"
archive_name="paws-trellis2.oci.tar.zst"
manifest_name="paws-trellis2-image-manifest.json"
archive_path="${bundle_dir}/${archive_name}"
manifest_path="${bundle_dir}/${manifest_name}"
readback_archive="${readback_dir}/${archive_name}"
readback_manifest="${readback_dir}/${manifest_name}"
azcopy_log_dir="${bundle_dir}/azcopy-logs"

install -d -m 0700 "$bundle_dir" "$readback_dir" "$azcopy_log_dir"
docker image inspect "$image_ref" >/dev/null

if [[ ! -f "$archive_path" ]]; then
  docker save "$image_ref" | zstd -T0 -10 -f -o "$archive_path"
fi

archive_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
archive_bytes="$(stat -c '%s' "$archive_path")"
image_id="$(docker image inspect --format '{{.Id}}' "$image_ref")"

jq -n \
  --arg schemaVersion "1" \
  --arg imageRef "$image_ref" \
  --arg imageId "$image_id" \
  --arg buildRevision "$build_revision" \
  --arg archive "$archive_name" \
  --arg sha256 "$archive_sha256" \
  --argjson bytes "$archive_bytes" \
  --arg createdAt "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  '{
    schemaVersion: ($schemaVersion | tonumber),
    imageRef: $imageRef,
    imageId: $imageId,
    buildRevision: $buildRevision,
    archive: $archive,
    sha256: $sha256,
    bytes: $bytes,
    createdAt: $createdAt
  }' >"$manifest_path"

export AZCOPY_AUTO_LOGIN_TYPE=MSI
export AZCOPY_LOG_LOCATION="$azcopy_log_dir"
export AZCOPY_JOB_PLAN_LOCATION="$azcopy_log_dir"
blob_root="https://${storage_account}.blob.core.windows.net/${container_name}/runtime-images/${build_revision}"

azcopy copy "$archive_path" "${blob_root}/${archive_name}" \
  --from-to=LocalBlob --overwrite=false --check-length=true --put-md5 \
  --output-type=json >"${azcopy_log_dir}/archive-upload.json" 2>&1
azcopy copy "$manifest_path" "${blob_root}/${manifest_name}" \
  --from-to=LocalBlob --overwrite=false --check-length=true --put-md5 \
  --output-type=json >"${azcopy_log_dir}/manifest-upload.json" 2>&1

archive_part="${readback_archive}.part"
manifest_part="${readback_manifest}.part"
rm -f "$archive_part" "$manifest_part"
azcopy copy "${blob_root}/${archive_name}" "$archive_part" \
  --from-to=BlobLocal --overwrite=true --check-length=true \
  --output-type=json >"${azcopy_log_dir}/archive-readback.json" 2>&1
azcopy copy "${blob_root}/${manifest_name}" "$manifest_part" \
  --from-to=BlobLocal --overwrite=true --check-length=true \
  --output-type=json >"${azcopy_log_dir}/manifest-readback.json" 2>&1

test "$(sha256sum "$archive_part" | awk '{print $1}')" = "$archive_sha256"
cmp --silent "$manifest_path" "$manifest_part"
mv "$archive_part" "$readback_archive"
mv "$manifest_part" "$readback_manifest"

jq -n \
  --arg state complete \
  --arg buildRevision "$build_revision" \
  --arg sha256 "$archive_sha256" \
  --argjson bytes "$archive_bytes" \
  '{state: $state, buildRevision: $buildRevision, bytes: $bytes, sha256: $sha256, privateReadback: true, valuesPrinted: false}'
