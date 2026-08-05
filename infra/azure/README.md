# Azure TRELLIS.2 Platform

This directory defines the Azure foundation for PawsMemories/Pawsome3D and
GibiWorld. It is intentionally separate from the current Hostinger and Render
production deployments. Azure must pass readiness checks before any DNS or
customer traffic is moved.

## Topology

- `pawstrellis-core-01` (`Standard_D8ads_v7`): public HTTPS entry point,
  backend services, durable orchestration, and CPU workers.
- `pawstrellis-gpu-01` (`Standard_NC40ads_H100_v5`): private-only 94 GB H100
  worker for TRELLIS.2 plus Blender/rigging/animation jobs. Only the core subnet
  can reach its worker ports.
- `pawstrellis-gibi-01` (`Standard_D4ads_v7`): separate GibiWorld backend lane.
- Key Vault: secrets are retrieved through VM managed identities; secrets are
  not embedded in Bicep, cloud-init, Git, or VM command history.
- Blob Storage: private model cache and generated artifact containers.
- Daily GPU auto-shutdown: a cost-containment backstop, not a substitute for
  explicit deallocation after validation.

## Why the H100 VM

Microsoft's TRELLIS.2 repository requires Linux, CUDA, and at least 24 GB of
NVIDIA VRAM, and reports its reference timings on H100. Azure's
`Standard_NC40ads_H100_v5` provides one 94 GB H100, 40 vCPUs, and 320 GiB RAM.
Microsoft states that net-new NC capacity is being added to the H100 v5 family,
whereas A100 v4 is no longer the net-new-capacity line.

At the 2026-08-05 East US retail rates observed during setup:

- H100 worker: about USD 6.98/hour, about USD 5,095/month if left on 24/7.
- D8 core: about USD 0.456/hour, about USD 333/month if left on 24/7.
- GibiWorld D4: about USD 0.228/hour, about USD 166/month, plus disks/logs.

The worker must be deallocated when it is not serving or building. Stopping the
guest OS is not enough; verify Azure reports `PowerState/deallocated`.

## Deployment gates

1. `Microsoft.Compute`, `Microsoft.Network`, `Microsoft.Storage`,
   `Microsoft.KeyVault`, `Microsoft.ManagedIdentity`,
   `Microsoft.OperationalInsights`, `Microsoft.DevTestLab`, and
   `Microsoft.Quota` are registered.
2. East US quota for `StandardNCadsH100v5Family` is at least 40 vCPUs.
3. Total regional vCPU quota is at least 52 vCPUs for the three-VM layout.
4. `infra/azure/main.bicep` compiles and Azure What-If reports only the expected
   resource changes.
5. The operator has explicitly acknowledged current Azure spend.

## Commands

Read-only preflight:

```bash
./infra/azure/scripts/preflight.sh
```

Foundation only, while GPU quota is pending:

```bash
CONFIRM_AZURE_SPEND=YES ./infra/azure/scripts/deploy.sh foundation
```

Core plus isolated GibiWorld VM, while GPU quota is pending:

```bash
CONFIRM_AZURE_SPEND=YES ./infra/azure/scripts/deploy.sh core-gibi
```

Full three-VM layout after H100 quota approval:

```bash
CONFIRM_AZURE_SPEND=YES ./infra/azure/scripts/deploy.sh full
```

The script uses `/Users/robert/.ssh/id_ed25519.pub` by default and restricts SSH
to the current public IP. Override with `AZURE_SSH_PUBLIC_KEY_FILE` or
`AZURE_ADMIN_IP` when necessary.

## Service readiness contract

Infrastructure deployment alone is not completion. Before Azure is called
ready, verify separately:

- Core liveness and authenticated backend readiness.
- GPU driver, CUDA 12.4-compatible runtime, and `nvidia-smi`.
- TRELLIS.2 model load and a real image-to-GLB job.
- GLB geometry, PBR textures, finite transforms, and no external URIs.
- Blender worker health plus a real rig/animation fixture.
- Private core-to-GPU connectivity and rejection from the public internet.
- GibiWorld backend readiness and a real Unity-client contract test.
- GPU deallocation behavior and restart/cold-start recovery.

Do not cut over DNS, database writes, credit charging, or customer jobs until
these gates pass.
