#!/usr/bin/env bash
set -euo pipefail

repo_revision="${1:-}"
if [[ ! "$repo_revision" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Usage: build-runtime-images.sh PAWS_REPOSITORY_COMMIT"
  exit 2
fi

for required_command in curl docker git jq openssl; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command"
    exit 1
  fi
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if ! git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Runtime images must be built from a Git checkout of the accepted checkpoint"
  exit 1
fi
actual_repo_revision="$(git -C "$repo_root" rev-parse HEAD)"
if [[ "$actual_repo_revision" != "$repo_revision" ]]; then
  echo "Requested runtime revision does not match checkout HEAD"
  exit 1
fi
if [[ -n "$(git -C "$repo_root" status --porcelain --untracked-files=all)" ]]; then
  echo "Runtime image checkout must be clean before build"
  exit 1
fi
model_lock="${repo_root}/infra/azure/models/trellis2.lock.json"
if [[ ! -f "$model_lock" ]]; then
  echo "Pinned TRELLIS model lock is missing"
  exit 1
fi

trellis_source_revision="$(jq -r '.source.revision' "$model_lock")"
trellis_model_revision="$(jq -r '.models[] | select(.repoId == "microsoft/TRELLIS.2-4B") | .revision' "$model_lock")"
if [[ ! "$trellis_source_revision" =~ ^[a-f0-9]{40}$ || ! "$trellis_model_revision" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Pinned TRELLIS revisions are invalid"
  exit 1
fi

short_revision="${repo_revision:0:7}"
trellis_image="paws-trellis2:${trellis_source_revision:0:8}-${short_revision}"
blender_image="paws-blender-worker:${short_revision}"

docker build --pull=false \
  --label "org.opencontainers.image.revision=${repo_revision}" \
  --label "org.opencontainers.image.source=local-paws-repository" \
  --build-arg "TRELLIS2_COMMIT=${trellis_source_revision}" \
  --build-arg "PAWS_RUNTIME_REPOSITORY_REVISION=${repo_revision}" \
  --tag "$trellis_image" \
  "${repo_root}/trellis-worker"

docker build --pull=false \
  --label "org.opencontainers.image.revision=${repo_revision}" \
  --label "org.opencontainers.image.source=local-paws-repository" \
  --build-arg "PAWS_RUNTIME_REPOSITORY_REVISION=${repo_revision}" \
  --tag "$blender_image" \
  "${repo_root}/blender-worker"

for image_ref in "$trellis_image" "$blender_image"; do
  actual_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_ref")"
  if [[ "$actual_revision" != "$repo_revision" ]]; then
    echo "Built image revision label mismatch"
    exit 1
  fi
done

worker_secret="$(openssl rand -hex 32)"
smoke_nonce="$(openssl rand -hex 4)"
blender_container="paws-blender-smoke-${short_revision}-${smoke_nonce}"
trellis_container="paws-trellis-smoke-${short_revision}-${smoke_nonce}"
smoke_network="paws-runtime-smoke-${short_revision}-${smoke_nonce}"
blender_container_id=""
trellis_container_id=""
smoke_network_created=false
cleanup() {
  [[ -z "$trellis_container_id" ]] || docker stop "$trellis_container_id" >/dev/null 2>&1 || true
  [[ -z "$blender_container_id" ]] || docker stop "$blender_container_id" >/dev/null 2>&1 || true
  [[ "$smoke_network_created" != true ]] || docker network rm "$smoke_network" >/dev/null 2>&1 || true
  unset worker_secret
}
trap cleanup EXIT

docker network create "$smoke_network" >/dev/null
smoke_network_created=true
blender_container_id="$(docker run --detach --rm \
  --name "$blender_container" \
  --network "$smoke_network" \
  --network-alias blender-worker \
  --env "WORKER_SHARED_SECRET=${worker_secret}" \
  --env "BLENDER_WORKER_REVISION=${repo_revision}" \
  --publish 127.0.0.1::10000 \
  "$blender_image")"
blender_port="$(docker port "$blender_container" 10000/tcp | awk -F: 'NR == 1 {print $NF}')"
if [[ ! "$blender_port" =~ ^[0-9]+$ ]]; then
  echo "Blender smoke-test port could not be resolved"
  exit 1
fi

blender_ready=false
for _attempt in $(seq 1 90); do
  health="$(curl --silent --show-error --max-time 5 "http://127.0.0.1:${blender_port}/health" 2>/dev/null || true)"
  if jq -e \
    --arg revision "$repo_revision" \
    '(.status == "ok")
     and (.bridge == "connected")
     and (.blenderVersion == "5.1.2")
     and (.workerRevision == $revision)
     and (.revisionVerified == true)' \
    <<<"$health" >/dev/null 2>&1; then
    blender_ready=true
    break
  fi
  sleep 2
done
if [[ "$blender_ready" != true ]]; then
  echo "Blender image did not pass its bridge/version/revision smoke test"
  docker logs --tail 100 "$blender_container" >&2 || true
  exit 1
fi

trellis_container_id="$(docker run --detach --rm \
  --name "$trellis_container" \
  --network "$smoke_network" \
  --env "WORKER_SHARED_SECRET=${worker_secret}" \
  --env "TRELLIS_PRELOAD=false" \
  --env "TRELLIS_MODEL_REVISION=${trellis_model_revision}" \
  --env "TRELLIS_SOURCE_REVISION=${trellis_source_revision}" \
  --env "BLENDER_VERSION=5.1.2" \
  --env "BLENDER_WORKER_REVISION=${repo_revision}" \
  --env "BLENDER_WORKER_URL=http://blender-worker:10000" \
  --env "BLENDER_INTERNAL_HOSTS=blender-worker" \
  --publish 127.0.0.1::8000 \
  "$trellis_image")"
trellis_port="$(docker port "$trellis_container" 8000/tcp | awk -F: 'NR == 1 {print $NF}')"
if [[ ! "$trellis_port" =~ ^[0-9]+$ ]]; then
  echo "TRELLIS smoke-test port could not be resolved"
  exit 1
fi

trellis_started=false
for _attempt in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:${trellis_port}/healthz" >/dev/null 2>&1; then
    trellis_started=true
    break
  fi
  sleep 2
done
if [[ "$trellis_started" != true ]]; then
  echo "TRELLIS image did not start for its contract smoke test"
  docker logs --tail 100 "$trellis_container" >&2 || true
  exit 1
fi

readiness="$(curl --silent --show-error --max-time 15 \
  --header "X-Worker-Secret: ${worker_secret}" \
  "http://127.0.0.1:${trellis_port}/readyz")"
jq -e \
  --arg modelRevision "$trellis_model_revision" \
  --arg sourceRevision "$trellis_source_revision" \
  --arg repositoryRevision "$repo_revision" \
  '(.status == "not_ready")
   and (.cuda == false)
   and (.modelRevision == $modelRevision)
   and (.sourceRevision == $sourceRevision)
   and (.runtimeRepositoryRevision == $repositoryRevision)
   and (.runtimeRevisionVerified == true)
   and (.blender.status == "ready")
   and (.blender.bridgeConnected == true)
   and (.blender.version == "5.1.2")
   and (.blender.revision == $repositoryRevision)' \
  <<<"$readiness" >/dev/null

jq -n \
  --arg state complete \
  --arg repositoryRevision "$repo_revision" \
  --arg trellisImage "$trellis_image" \
  --arg blenderImage "$blender_image" \
  '{
    state: $state,
    repositoryRevision: $repositoryRevision,
    images: [$trellisImage, $blenderImage],
    blenderBridgeSmoke: true,
    trellisContractSmoke: true,
    liveCudaAcceptance: false,
    secretPrinted: false
  }'
