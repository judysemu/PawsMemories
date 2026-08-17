# Azure TRELLIS.2 Platform

This directory keeps the stable Paws core/GibiWorld foundation separate from a
replaceable GPU worker lane. A GPU quota grant can now name any Azure region or
an additional startup-credit subscription without moving or redeploying the
existing East US services.

Azure remains separate from the current Hostinger and Render production
deployments. No DNS, paid customer traffic, or database writes move until the
live acceptance gates below pass.

## Topology and ownership

- `main.bicep` + `platform.bicep`: stable core/orchestrator, storage, Key Vault,
  and optional GibiWorld resources in `coreLocation` (currently East US).
- `container-apps-gpu-main.bicep` + `container-apps-gpu.bicep`: the serverless
  A100 lane (see below). This is the only supported GPU path.
- `pbr-worker-main.bicep`: the PBR worker environment and registry.

The stable VNet uses `10.42.0.0/16`, with the exact core subnet `10.42.1.0/24`.

The dedicated GPU VM lane that formerly occupied this section was retired; see
"GPU: the dedicated VM lane is retired" below.


## Foundation commands

Foundation only:

```bash
CONFIRM_AZURE_SPEND=YES ./infra/azure/scripts/deploy.sh foundation
```

Core plus isolated GibiWorld VM:

```bash
CONFIRM_AZURE_SPEND=YES ./infra/azure/scripts/deploy.sh core-gibi
```

`deploy.sh full` is intentionally refused. The GPU lane must never be smuggled
into a foundation redeployment.

## GPU: the dedicated VM lane is retired

The dedicated GPU VM lane (`gpu-lane.bicep`, `gpu-lane-main.bicep`,
`core-gpu-integration.bicep`, `deploy-gpu-lane.sh`, `preflight.sh`,
`validate-gpu-network.py`) has been removed from this repository.

It was never deployable. GPU VM quota is **0 across all 63 physical Azure
regions** on both subscriptions in this account, for every NC/ND/NV family, and
`Subscription Dedicated NCA100 Gpus` is 0/0. The cross-subscription escape
hatch it was built around does not help: the second subscription is empty, has
no resource providers registered, and holds no GPU quota either. A pinned A100
would also cost four figures a month and idle at full price.

**Use the serverless Container Apps A100 lane below instead.** It bills per
second of actual use with no idle charge, uses a different quota system from
GPU VM quota, and a `Consumption-GPU-NC24-A100` workload profile is already
provisioned and accepted on `pawspbr-pbr-a100-env` in East US.


## Optional cross-tenant Container Apps A100 lane

`container-apps-gpu-main.bicep` and
`container-apps-gpu.bicep` add a separate, optional serverless-A100 target for
an explicitly selected subscription and tenant. They never reference the core
resource group, VNet, Key Vault, storage, or identity. This makes the lane
suitable for an A100 entitlement held by a different organization: the core
calls authenticated HTTPS ingress instead of relying on cross-tenant VNet
peering or role assignments.

The target-local foundation contains:

- a Premium, admin-disabled ACR for independently accepted runtime images;
- non-public model/job file shares, with the model share mounted read-only;
- an RBAC Key Vault containing only an operator-staged worker secret;
- a user-assigned identity with only ACR pull and Key Vault secret-read roles;
- Log Analytics and a workload-profile Container Apps environment; and
- `Consumption-GPU-NC24-A100`, with TRELLIS first and the Blender worker as its
  CPU sidecar.

The template has no model downloader or serving-time registry build. TRELLIS
runs with `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`, reads the pre-staged
`/models/TRELLIS.2-4B` tree, and shares `/jobs` with Blender at
`/shared-model-artifacts`. The image defaults record the previously accepted
runtime lock:
`paws-trellis2:75fbf018-b74ca0c` and
`paws-blender-worker:e2cb178`. Those images predate aggregate readiness: the
cached TRELLIS image does not return Blender readiness and the cached Blender
image does not return its worker revision. They remain provenance inputs for
foundation planning, but the template and preflight refuse to create a serving
app from those tags or their old full repository revision. Azure Files currently requires an account key
at the Container Apps environment storage boundary; ARM resolves that value
internally. It is not a template parameter, output, command argument, or
repository value.

The TRELLIS container also carries the full pinned source/model revisions plus
the expected Blender `5.1.2` version and the explicit
`runtimeRepositoryRevision`. The Blender sidecar reports that same revision.
The serving preflight requires one lowercase 40-hex revision, rejects the old
checkpoint, and verifies that the revision and both image references exactly
match a runtime lock where both cache states are `verified-private-readback`.
The current pre-aggregate lock intentionally has no top-level
`repositoryRevision`: its historical TRELLIS and Blender images came from two
different Paws commits. The field becomes required only when both replacements
are rebuilt from one checkpoint.
Container startup uses only secret-free TCP
process probes; the backend's precharge gate remains authenticated `/readyz`,
which must match those revisions and prove CUDA, loaded models, and a connected
Blender bridge before a customer job or credit event can begin.

Deployment is deliberately two-phase. Foundation creation comes first. Before
serving, both images must be rebuilt from an implementation checkpoint that
contains aggregate readiness, pass private-cache readback and runtime tests,
and receive new accepted tags in `runtime/gpu-runtime.lock.json`. An operator
then copies those new images into the target ACR, stages and hash-verifies the
locked model bundle in the target model share, and adds the worker secret to
the target Key Vault through a private user-controlled process. Only the
serving phase can create the Container App, and its preflight fails closed
unless the new tags, explicit aggregate-readiness acceptance, secret metadata,
model-staging attestation, and live managed-environment NCA100 quota all pass.

Set the target context explicitly; neither helper falls back to the currently
selected core subscription:

```bash
export AZURE_ACA_SUBSCRIPTION_ID="<target-subscription-id>"
export AZURE_ACA_TENANT_ID="<target-tenant-id>"
export AZURE_ACA_LOCATION="<approved-A100-region>"
```

The default command is a What-If of the foundation and performs no write:

```bash
./infra/azure/scripts/deploy-container-apps-gpu.sh
```

An authorized foundation apply requires both the normal spend confirmation and
an explicit attestation that Managed Environment Consumption NCA100 access is
visible in the target tenant:

```bash
CONFIRM_AZURE_SPEND=YES \
AZURE_ACA_NCA100_QUOTA_CONFIRMED=YES \
./infra/azure/scripts/deploy-container-apps-gpu.sh apply-foundation
```

For cross-tenant public ingress, provide only the core service's exact fixed
egress CIDR. The template emits one allow rule and TLS-only ingress; the worker
still requires `X-Worker-Secret`. `AZURE_ACA_INGRESS_MODE=internal` is also
available, but it is usable only after separately providing private network
connectivity to that environment.

```bash
export AZURE_ACA_INGRESS_MODE=external-allowlist
export AZURE_ACA_CORE_SOURCE_CIDR="<core-fixed-egress-ip>/32"
export AZURE_ACA_MODELS_MANIFEST_SHA256="e3a4d702026090228807307c073f4171dbefd4db456a28a92e8a014669c0819c"
export AZURE_ACA_TRELLIS_DIGEST="<64-lowercase-hex-manifest-digest>"
export AZURE_ACA_BLENDER_DIGEST="<64-lowercase-hex-manifest-digest>"
export AZURE_ACA_RUNTIME_REPOSITORY_REVISION="<full-40-hex-build-revision>"
export AZURE_ACA_AGGREGATE_READINESS_IMAGES_ACCEPTED=YES

./infra/azure/scripts/deploy-container-apps-gpu.sh what-if-serving
```

At the current checkpoint this command is expected to stop at the image gate;
no new aggregate-readiness images have been built or accepted yet.
Serving never accepts mutable tags. Both full target-ACR `@sha256:` references
must exactly match `registryImageRef` values in the shared-revision runtime lock.

Serving apply has a second A100-specific spend gate:

```bash
CONFIRM_AZURE_SPEND=YES \
CONFIRM_AZURE_ACA_A100_SPEND=YES \
AZURE_ACA_MODELS_MANIFEST_SHA256=e3a4d702026090228807307c073f4171dbefd4db456a28a92e8a014669c0819c \
AZURE_ACA_AGGREGATE_READINESS_IMAGES_ACCEPTED=YES \
./infra/azure/scripts/deploy-container-apps-gpu.sh apply-serving
```

Important: although Azure's serverless GPU platform supports scale-to-zero,
this initial TRELLIS service intentionally sets `minReplicas=1` and
`maxReplicas=1`. Jobs currently execute in-process and use SQLite state on the
shared job volume, so scale-to-zero or concurrent replicas are not recovery
safe. Once serving is applied, one A100 replica can remain allocated and billed
until it is disabled or removed. Do not describe this configuration as
scale-to-zero or idle-free. That cost optimization requires a durable external
queue, leased job ownership, and restart-safe orchestration first.

The preflight reads provider registration, the region's advertised workload
profiles, Microsoft.App regional usage, and—after foundation creation—the
official managed-environment usage endpoint. It never registers a provider,
requests quota, stages a secret, moves a model, builds an image, or deploys a
resource. Primary references: [serverless GPUs](https://learn.microsoft.com/en-us/azure/container-apps/gpu-serverless-overview),
[workload profiles](https://learn.microsoft.com/en-us/azure/container-apps/workload-profiles-overview),
[IP restrictions](https://learn.microsoft.com/en-us/azure/container-apps/ip-restrictions),
[storage mounts](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts),
and [managed-environment usage](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/managed-environment-usages/list?view=rest-resource-manager-containerapps-2026-01-01).

## Accepted worker and model contract

The pinned source and four-model set are recorded in
`models/trellis2.lock.json`. The accepted worker image is
`paws-trellis2:75fbf018-b74ca0c`; its private-cache readback is the deployment
source. `compose/gpu.compose.yml` uses that exact tag by default and no longer
rebuilds a different image on the GPU host. A later accepted image can be
selected with `TRELLIS_WORKER_IMAGE` without changing the infrastructure.
This earlier acceptance covers the recorded offline/runtime checks, not the
new aggregate TRELLIS-plus-Blender readiness contract. It must not be selected
for the Container Apps serving phase.

The image uses the Miniconda `base` environment. Model initialization invokes
`/opt/conda/bin/hf` directly; there is no nonexistent `trellis2` Conda
environment. Serving remains offline with `HF_HUB_OFFLINE=1` and
`TRANSFORMERS_OFFLINE=1`.

The already-verified image archive and model bundle can be transferred from the
core cache to `10.43.2.10` over the private peering. Reverify the recorded
archive SHA-256, manifest bytes, 37 model-file hashes, and lock revision before
loading the image or starting Compose. Do not download models from Hugging Face
during serving.

Compose binds both host ports to `GPU_PRIVATE_IP` rather than every interface.
The TRELLIS healthcheck calls authenticated `/readyz` and requires CUDA plus a
loaded model. It reads the secret inside the check process without placing its
value in Compose, command arguments, or logs. Blender is healthy only when its
Express relay reports the Blender bridge connected.

## Live acceptance gates

Infrastructure deployment alone is not completion. Verify independently:

1. GPU VM has no public IP and the two peerings report connected.
2. The subnet's NAT gateway provides outbound bootstrap/Azure access but no
   unsolicited inbound route to the VM.
3. TCP 22, 8000, and 10000 work from the exact core subnet and are rejected
   from public and other peered sources.
4. NVIDIA driver, CUDA runtime, and `nvidia-smi` pass.
5. The accepted image and complete model manifest pass private-cache readback.
6. Authenticated `/readyz` proves CUDA, the pinned model, and the pipeline are
   loaded; `/healthz` alone is insufficient.
7. A real pet image produces a valid PBR GLB with finite geometry and no
   external URIs.
8. The same job completes in-house Blender rigging and animation and returns a
   verified final GLB.
9. Restart recovery is tested and the VM is explicitly deallocated afterward.
   Guest shutdown alone does not stop compute billing.
10. GibiWorld is evaluated separately with a real backend and Unity-client
   contract test; GPU success does not imply GibiWorld readiness.

## Customer cutover switches

Keep customer work closed until all live gates pass:

```dotenv
PAWS_3D_PROVIDER=trellis2
PAWS_3D_INHOUSE_ONLY=true
PAWS_3D_EXTERNAL_PROVIDER_IDS=tripo,fal
PET_GLB_ENABLED=false
PET_GLB_BODY_RIG_ENABLED=false
```

Strict mode rejects an external-provider SKU rather than falling back. Enable
the two customer switches only after the real image-to-rigged/animated-GLB run
and the paid-order refund/recovery lifecycle pass.
