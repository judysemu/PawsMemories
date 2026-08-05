# Pawsome3D in-house 3D handoff

Last updated: 2026-08-05 10:13 MDT

## Definition of done

One real pet image must complete this path without an outside 3D, rigging, texturing, or animation API:

`image -> TRELLIS.2 PBR mesh -> mesh validation -> in-house Blender rig -> animation bake -> verified final GLB`

A provisioned VM, complete model cache, built image, health endpoint, existing input GLB, or local test is not end-to-end completion by itself.

## Current state

- Azure resource group `Trellis` contains the running core/orchestrator VM and an isolated GibiWorld VM. Resource addresses, subscription identifiers, tenant identifiers, and secrets are deliberately omitted here.
- GPU-family quota remains zero in the checked US regions. No compatible private GPU worker has been allocated and no real TRELLIS inference has run.
- Exact TRELLIS.2 source revision: `75fbf0183001ed9876c8dbb35de6b68552ee08bd`.
- The immutable four-model bundle is complete in Azure: 37 manifest-tracked files and 18,482,646,202 bytes.
- A fresh private Blob readback transferred 113 objects and independently rehashed all 37 tracked files with zero failures. The manifest state, lock hash, and local runtime model paths pass.
- Hugging Face was used only to download the two approved gated repositories. The token was streamed through standard input, was not printed or written to Docker metadata/disk by the staging tools, and is no longer required. Runtime serving is configured offline.
- The first full worker image `7a3dbcc` compiled successfully but is rejected: `pip check` failed and importing Transformers raised an error because Hugging Face Hub 0.34.4 was incompatible with Transformers 5.14.1.
- Commit `ab389ca` pins the compatible runtime pair, adds a mandatory `pip check`, and separates the expensive CUDA-extension layer from the small runtime layer. Its persistent Azure build is currently running.
- Existing Azure Blender proof for an imported textured pet remains valid: 16-bone rig, 16,085 weighted vertices, zero unweighted islands, 15 clips, and saved `idle` and `walk` animations. This proves rig/animation for an existing GLB, not image-to-mesh generation.
- Local strict mode blocks known Tripo/fal calls and legacy external-generation routes before their handlers. Production still runs the older external-provider release and has not been cut over.
- The active worktree is expected to remain clean after each checkpoint. Local `main` is intentionally ahead of `origin/main`; nothing in this handoff claims a production deployment.

## Current blocker and next action

1. Finish and smoke-test the corrected `ab389ca` worker image without a GPU.
2. Package the accepted image into the private Azure cache with hash readback.
3. Obtain compatible Azure GPU quota and allocate the private GPU worker.
4. Load all four local models with outbound model access disabled.
5. Run one real pet image through TRELLIS, Blender rigging, animation bake, and final GLB validation.
6. Only after that proof, deploy the strict in-house customer path and verify production with external provider calls disabled.

## Test ledger

All entries record evidence, not intent. Secret values are never included.

- 2026-08-05 09:53 MDT — PASS — `trellis_model_lock` tests: 3/3. Full TypeScript check passed. Commit `7a3dbcc` pins PyTorch 2.6.0, torchvision 0.21.0, and CUDA 12.4 wheels.
- 2026-08-05 09:58 MDT — PASS — Secure gated-token handoff: shell syntax, 3/3 model-lock/security tests, and full TypeScript check passed. Commit `5cca002` streams the token through privileged Docker standard input.
- 2026-08-05 09:59 MDT — PASS — Exact remote staging script and model lock SHA-256 values matched local commit `5cca002`.
- 2026-08-05 10:00 MDT — PASS — Non-secret sentinel crossed the exact `sudo docker run --interactive` path and returned `private-input-pass`.
- 2026-08-05 10:01 MDT — PASS — Gated download completed: `awaitingAccess=0`, `staged=4`, manifest state `complete`.
- 2026-08-05 10:02 MDT — PASS — Staging rehash: 37 files, 18,482,646,202 bytes, zero failures; lock, source revision, and all runtime paths passed.
- 2026-08-05 10:04 MDT — PASS — Private Blob promotion: 37 gated-model files plus complete manifest and lock uploaded with zero transfer failures.
- 2026-08-05 10:05 MDT — FAIL / REJECTED — Image `7a3dbcc` built, but `pip check` returned 1 and Transformers import failed on the Hub-version mismatch. This image must not be deployed.
- 2026-08-05 10:06 MDT — PASS — Fresh private Blob readback: 113 transfers, 18,482,650,117 transferred bytes including cache metadata, zero transfer failures; all 37 manifest files and 18,482,646,202 tracked bytes rehashed with zero failures; lock passed.
- 2026-08-05 10:08 MDT — PASS — Runtime alignment tests: 3/3 model-lock tests and full TypeScript check passed for commit `5b458ab`; Hugging Face Hub 1.26.0 and Transformers 5.14.1 are pinned and `pip check` is mandatory.
- 2026-08-05 10:10 MDT — PASS — Cache-layer refactor: 3/3 model-lock tests and full TypeScript check passed for commit `ab389ca`.
- 2026-08-05 10:13 MDT — PASS — Category-only model scanner validation: shell syntax, 3/3 model-lock/security tests, and the full TypeScript check passed. The scanner emits counts only and never matching filenames or values.

## Operational references

- Local status: `http://127.0.0.1:8765/AZURE_TRELLIS_STATUS.html`
- Model intake: `http://127.0.0.1:8765/MODEL_INTAKE_REPORT.html`
- Tracked status source: `docs/AZURE_TRELLIS_STATUS.html`
- Model lock: `infra/azure/models/trellis2.lock.json`
- Secure gated staging helper: `infra/azure/scripts/complete-trellis-gated-staging.sh`
- Worker Dockerfile: `trellis-worker/Dockerfile`
- Active corrected build unit: `paws-trellis-build-ab389ca`
