# Pawsome3D in-house 3D handoff

Last updated: 2026-08-05 10:30 MDT

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
- The gated DINOv3/RMBG bundle contains 9 scanned text/code/config files with zero private-key, live-token, Azure-connection-string, credential-URL, or email-shaped flags. No candidate values or filenames were printed.
- The first full worker image `7a3dbcc` compiled successfully but is rejected: `pip check` failed and importing Transformers raised an error because Hugging Face Hub 0.34.4 was incompatible with Transformers 5.14.1.
- Commit `ab389ca` pins the compatible runtime pair, adds a mandatory `pip check`, and separates the expensive CUDA-extension layer from the small runtime layer. Its persistent Azure build passed and produced the candidate image `paws-trellis2:75fbf018-ab389ca` at 9,112,738,036 bytes with no broken package requirements. The candidate is rejected pending repair because offline smoke tests found the TRELLIS source missing from Python's import path and CuMesh loading an older Conda `libstdc++` without `GLIBCXX_3.4.30`.
- Commit `b74ca0c` applies the verified runtime-only repair while preserving the cached CUDA-extension layer. Persistent Azure build unit `paws-trellis-build-b74ca0c` exited successfully and produced `paws-trellis2:75fbf018-b74ca0c` at 9,112,739,312 bytes. No deployability is claimed until it passes offline smoke tests; provenance currently rests on the immutable build-context check and tag because the image has no source-revision label.
- Existing Azure Blender proof for an imported textured pet remains valid: 16-bone rig, 16,085 weighted vertices, zero unweighted islands, 15 clips, and saved `idle` and `walk` animations. This proves rig/animation for an existing GLB, not image-to-mesh generation.
- Local strict mode blocks known Tripo/fal calls and legacy external-generation routes before their handlers. Production still runs the older external-provider release and has not been cut over.
- The active worktree is expected to remain clean after each checkpoint. Local `main` is intentionally ahead of `origin/main`; nothing in this handoff claims a production deployment.

## Current blocker and next action

1. Package the CPU-accepted `b74ca0c` image into the private Azure cache with hash readback.
2. Obtain 24 `NCADS_A100_v4` family vCPUs in East US and allocate the private GPU worker.
3. Prove the remaining `o_voxel`/FlexGEMM imports on the NVIDIA driver.
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
- 2026-08-05 10:14 MDT — PASS — Gated DINOv3/RMBG sensitive-string scan: 9 text/code/config files; zero private-key, live-token, Azure connection-string, credential-URL, or email-shaped flags; values printed `false`.
- 2026-08-05 10:18 MDT — PASS — Corrected worker image build: persistent Azure unit exited cleanly, produced `paws-trellis2:75fbf018-ab389ca` at 9,112,738,036 bytes, and mandatory `pip check` reported no broken requirements.
- 2026-08-05 10:19 MDT — MIXED / REJECTED — Offline image smoke: dependency check passed; PyTorch 2.6.0+cu124, Transformers 5.14.1, Hub 1.26.0, and CUDA build 12.4 imported. `trellis2` import failed because `/opt/trellis2` was absent from Python's path. Extension import failed because Conda's `libstdc++.so.6` lacked `GLIBCXX_3.4.30`. Candidate `ab389ca` must not be deployed.
- 2026-08-05 10:20 MDT — FAIL — Environment-only repair probe: adding `PYTHONPATH=/opt/trellis2` allowed the TRELLIS import to proceed, but prepending the system library directory to `LD_LIBRARY_PATH` did not override Conda Python's own `libstdc++` resolution. A real library repair is required; no image change was accepted.
- 2026-08-05 10:21 MDT — MIXED — Ephemeral C++ runtime repair probe: redirecting Conda's `libstdc++.so.6` to Ubuntu's installed runtime cleared the `GLIBCXX_3.4.30` error and allowed TRELLIS, FlashAttention, nvdiffrast, and CuMesh imports to proceed. Importing FlexGEMM then reached Triton and correctly stopped because the core VM has zero active GPU drivers. The library repair is viable; FlexGEMM still requires a real GPU import test.
- 2026-08-05 10:24 MDT — PASS — Runtime repair regression test: 3/3 immutable model/runtime/security tests passed and the full TypeScript check passed. The worker now exposes `/opt/trellis2` on Python's import path and verifies then selects Ubuntu's `GLIBCXX_3.4.30` C++ runtime after the reusable CUDA-extension layer.
- 2026-08-05 10:24 MDT — PASS — Runtime repair checkpoint pre-commit TypeScript verification passed with clean types. The repair, its regression assertions, and all accumulated handoff evidence were staged together.
- 2026-08-05 10:26 MDT — PASS — Active Azure billing classification check: the CLI-selected subscription is enabled under the Sponsored offer with its spending limit off. The Marketplace page labeled “Free trial” is not proof that the active Trellis subscription is a free-trial subscription; compatible GPU-family quota remains the actual provisioning gate.
- 2026-08-05 10:27 MDT — PASS — Immutable Azure build-context transfer: committed revision `b74ca0c` was archived into its own remote directory, and the worker Dockerfile SHA-256 matched the committed local source exactly. No uncommitted handoff content entered the image context.
- 2026-08-05 10:28 MDT — PASS — Corrected worker image build: persistent unit result `success` with exit status 0; image export, naming, and unpack completed. Candidate size is 9,112,739,312 bytes. The core host retained about 152 GB disk and 30.6 GB memory available with zero swap use.
- 2026-08-05 10:29 MDT — MIXED / GPU TEST REQUIRED — Offline all-module import with Docker networking disabled passed the repaired Python path, C++ symlink, and package dependency check. Import progressed through TRELLIS and the compiled libraries until `o_voxel` loaded FlexGEMM; Triton then reported zero active drivers on the CPU-only core host. This is the expected GPU boundary, not evidence of a passing GPU runtime; `o_voxel`/FlexGEMM must import again on the allocated NVIDIA worker.
- 2026-08-05 10:29 MDT — PASS — CPU-safe offline import smoke with Docker networking disabled: TRELLIS, FlashAttention, nvdiffrast, and CuMesh imported successfully. Exact assertions passed for PyTorch `2.6.0+cu124`, Transformers `5.14.1`, Hugging Face Hub `1.26.0`, and CUDA build `12.4`.
- 2026-08-05 10:30 MDT — PASS — Offline worker service/auth smoke: with no Docker network, no model mount, and preload disabled, `/healthz` returned 200; unauthenticated `/readyz` returned 401; authenticated `/readyz` returned 503 with `not_ready`. This proves startup and fail-closed authorization/readiness behavior on the CPU host without falsely claiming GPU/model readiness.
- 2026-08-05 10:30 MDT — PASS — Simple status tracker readback: the local HTTP page serves the corrected image result, exact candidate byte count, and the 24-vCPU `NCADS_A100_v4` quota action. Three expected sections matched the live response.

## Operational references

- Local status: `http://127.0.0.1:8765/AZURE_TRELLIS_STATUS.html`
- Model intake: `http://127.0.0.1:8765/MODEL_INTAKE_REPORT.html`
- Tracked status source: `docs/AZURE_TRELLIS_STATUS.html`
- Model lock: `infra/azure/models/trellis2.lock.json`
- Secure gated staging helper: `infra/azure/scripts/complete-trellis-gated-staging.sh`
- Worker Dockerfile: `trellis-worker/Dockerfile`
- Active corrected build unit: `paws-trellis-build-b74ca0c`
