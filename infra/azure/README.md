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
- `gpu-lane-main.bicep`: independent subscription-level GPU entry point. It
  creates only the GPU resource group and delegates the private lane and core
  integration modules.
- `gpu-lane.bicep`: one private-only TRELLIS/Blender VM, its non-overlapping
  regional VNet, NSG, managed identity, NVIDIA extension, and shutdown guard.
- `core-gpu-integration.bicep`: adds the reverse VNet peering and grants the GPU
  identity access to the existing private model/artifact storage and Key Vault.
  It does not redeploy the core VM, GibiWorld VM, their NICs, or their disks.

The stable VNet uses `10.42.0.0/16`, with the exact core subnet
`10.42.1.0/24`. The independent GPU VNet defaults to `10.43.0.0/16`, with the
worker at `10.43.2.10`. Two-way global VNet peering provides private routing.
The GPU VM has no public IP. Its subnet uses an explicit egress-only NAT
gateway because new Azure VNets do not receive implicit default outbound
access. The NAT address is not attached to the VM and creates no inbound path.
The NSG allows TCP 22, 8000, and 10000 only from `10.42.1.0/24`, then explicitly
denies other peered-network and Internet inbound traffic.

At runtime, TRELLIS and Blender exchange artifacts only on the private GPU
host. `/opt/paws-gpu/jobs` is writable by TRELLIS and mounted read-only at
`/shared-model-artifacts` in Blender. The shared `WORKER_SHARED_SECRET`
authenticates service calls and belongs only in the VM secret files.

## Same-subscription and cross-subscription modes

The default is the existing subscription:

```bash
export AZURE_CORE_SUBSCRIPTION_ID="<existing-core-subscription-id>"
export AZURE_GPU_LOCATION="<approved-region>"
```

If Microsoft grants GPU quota on another subscription under the same startup
billing account, add:

```bash
export AZURE_GPU_SUBSCRIPTION_ID="<gpu-quota-subscription-id>"
```

The deploy helper keeps the core subscription unchanged and submits the GPU
deployment to `AZURE_GPU_SUBSCRIPTION_ID`. Cross-subscription mode requires:

1. Both subscriptions are enabled in the same Microsoft Entra tenant.
2. The deployment identity can create resources in the GPU subscription.
3. It has Network Contributor permission on the existing core VNet so it can
   add the reverse peering.
4. It has permission to create role assignments on the existing Key Vault and
   storage account (Owner or User Access Administrator plus the needed resource
   write permissions).
5. `Microsoft.Network` is registered in both subscriptions; the GPU
   subscription also has the providers checked by `preflight.sh` registered.
6. The two VNet address spaces remain non-overlapping.

The script stops if the subscription tenant IDs differ. Cross-tenant peering is
deliberately outside this deployment contract. It reads every address prefix on
the existing core VNet plus the exact core subnet before planning, and rejects
any overlapping or invalid GPU network range before any Azure write.

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

## GPU quota and regional preflight

Set the exact region and SKU from the approved support response. The current
24-vCPU A100 request is the default:

```bash
AZURE_GPU_LOCATION="<approved-region>" \
AZURE_GPU_VM_SIZE=Standard_NC24ads_A100_v4 \
./infra/azure/scripts/preflight.sh
```

Preflight reads quota and usage from the GPU subscription and GPU region only.
It does not add core or GibiWorld vCPUs to the regional requirement. It verifies
the applied family limit, remaining family and total regional quota, the SKU's
subscription restriction list, providers, and current retail rate. Quota and a
clean SKU listing do not guarantee physical capacity; the first allocation is
still the capacity proof.

For an H100 approval, override the size explicitly:

```bash
AZURE_GPU_LOCATION="<approved-region>" \
AZURE_GPU_VM_SIZE=Standard_NC40ads_H100_v5 \
./infra/azure/scripts/preflight.sh
```

## GPU plan and deployment

The GPU helper defaults to a read-only What-If. Review it and confirm that the
stable core and GibiWorld VMs, NICs, public IPs, and disks have no changes:

```bash
AZURE_GPU_LOCATION="<approved-region>" \
./infra/azure/scripts/deploy-gpu-lane.sh what-if
```

Only after quota, physical capacity expectations, What-If, and spend are
accepted:

```bash
CONFIRM_AZURE_SPEND=YES \
AZURE_GPU_LOCATION="<approved-region>" \
./infra/azure/scripts/deploy-gpu-lane.sh apply
```

The deployment adds a peering and two narrowly scoped managed-identity roles to
the existing foundation. It does not run `main.bicep` and does not move or
recreate core/GibiWorld.

## Accepted worker and model contract

The pinned source and four-model set are recorded in
`models/trellis2.lock.json`. The accepted worker image is
`paws-trellis2:75fbf018-b74ca0c`; its private-cache readback is the deployment
source. `compose/gpu.compose.yml` uses that exact tag by default and no longer
rebuilds a different image on the GPU host. A later accepted image can be
selected with `TRELLIS_WORKER_IMAGE` without changing the infrastructure.

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
