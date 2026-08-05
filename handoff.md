# Pawsome3D in-house 3D handoff

Last updated: 2026-08-05 11:20 MDT

## Definition of done

One real pet image must complete this path without an outside 3D, rigging, texturing, or animation API:

`image -> TRELLIS.2 PBR mesh -> mesh validation -> in-house Blender rig -> animation bake -> verified final GLB`

A provisioned VM, complete model cache, built image, health endpoint, existing input GLB, or local test is not end-to-end completion by itself.

## Current state

- **GPU provisioning remains paused.** At 2026-08-05 11:04 MDT the user explicitly authorized Azure Quota API work only. Quota inspection/request repair may proceed, but do not provision a GPU, deploy production, or resume model installation until quota is applied and the user authorizes the next phase.
- Azure resource group `Trellis` contains the running core/orchestrator VM and an isolated GibiWorld VM. Resource addresses, subscription identifiers, tenant identifiers, and secrets are deliberately omitted here.
- GPU-family quota remains zero in the checked US regions. The manual East US 2 A100 request was denied with Azure code `QuotaNotAvailableForResource`; no compatible private GPU worker has been allocated and no real TRELLIS inference has run.
- Exact TRELLIS.2 source revision: `75fbf0183001ed9876c8dbb35de6b68552ee08bd`.
- The immutable four-model bundle is complete in Azure: 37 manifest-tracked files and 18,482,646,202 bytes.
- A fresh private Blob readback transferred 113 objects and independently rehashed all 37 tracked files with zero failures. The manifest state, lock hash, and local runtime model paths pass.
- Hugging Face was used only to download the two approved gated repositories. The token was streamed through standard input, was not printed or written to Docker metadata/disk by the staging tools, and is no longer required. Runtime serving is configured offline.
- The gated DINOv3/RMBG bundle contains 9 scanned text/code/config files with zero private-key, live-token, Azure-connection-string, credential-URL, or email-shaped flags. No candidate values or filenames were printed.
- The first full worker image `7a3dbcc` compiled successfully but is rejected: `pip check` failed and importing Transformers raised an error because Hugging Face Hub 0.34.4 was incompatible with Transformers 5.14.1.
- Commit `ab389ca` pins the compatible runtime pair, adds a mandatory `pip check`, and separates the expensive CUDA-extension layer from the small runtime layer. Its persistent Azure build passed and produced the candidate image `paws-trellis2:75fbf018-ab389ca` at 9,112,738,036 bytes with no broken package requirements. The candidate is rejected pending repair because offline smoke tests found the TRELLIS source missing from Python's import path and CuMesh loading an older Conda `libstdc++` without `GLIBCXX_3.4.30`.
- Commit `b74ca0c` applies the verified runtime-only repair while preserving the cached CUDA-extension layer. Persistent Azure build unit `paws-trellis-build-b74ca0c` exited successfully and produced `paws-trellis2:75fbf018-b74ca0c` at 9,112,739,312 bytes. No deployability is claimed until it passes offline smoke tests; provenance currently rests on the immutable build-context check and tag because the image has no source-revision label.
- The accepted image is also preserved in private Blob storage as a 9,083,773,141-byte compressed OCI archive. Managed-identity upload and fresh private readback completed with integrity checks; the transfer emitted no sensitive values.
- Existing Azure Blender proof for an imported textured pet remains valid: 16-bone rig, 16,085 weighted vertices, zero unweighted islands, 15 clips, and saved `idle` and `walk` animations. This proves rig/animation for an existing GLB, not image-to-mesh generation.
- Local strict mode blocks known Tripo/fal calls and legacy external-generation routes before their handlers. Production still runs the older external-provider release and has not been cut over.
- The active worktree is expected to remain clean after each checkpoint. Local `main` is intentionally ahead of `origin/main`; nothing in this handoff claims a production deployment.

## Pause boundary

- East US 2 denial is confirmed as `QuotaNotAvailableForResource`; the user is manually trying other Azure regions.
- The user subsequently authorized Azure Quota API work across the requested regions. This narrow authorization does not permit VM creation or production deployment.
- Live Quota API reads show the A100 family is quota-applicable in Canada Central, Canada East, Central US, East US 2, Mexico Central, North Central US, and West Central US, but every region still has usage 0 and applied limit 0.
- Quota history confirms the user's seven-region portal batch was processed, not left pending. Canada Central, Central US, and East US 2 failed with `QuotaNotAvailableForResource`. Canada East, Mexico Central, North Central US, and West Central US failed with `ContactSupport`. East US 2, Central US, and North Central US also have earlier failed attempts. Retrying those same region/family pairs without Microsoft intervention is not useful.
- The exact `Standard_NC24ads_A100_v4` size is listed for this subscription in five additional standard US regions: East US, South Central US, West US, West US 2, and West US 3. It is not listed in North Central US or West Central US. A listing is only an eligibility hint, not capacity proof.
- Quota API checks show the A100 family is applicable with usage 0 / applied limit 0 in all five candidates. East US already failed a 24-vCPU request with `ContactSupport`; South Central US, West US, West US 2, and West US 3 have no prior A100-family request record.
- The new 24-vCPU South Central US Quota API request progressed and then failed with `ContactSupport`. Usage and applied limit remain 0. Do not retry that region.
- At the last live check, the compatible GPU-family limit was still zero. A portal request marked received or pending is not approval; resume only after the CLI reports a sufficient applied limit.
- No GPU VM exists, so no GPU charge is running. The completed build and private-cache units are inactive/dead.
- Implementation checkpoint `e408662` adds the value-safe, managed-identity image-cache helper. The accepted `b74ca0c` worker image and all four pinned model repositories passed private Blob readback.
- The next agent must preserve the provider-neutral adapters and strict no-external-provider policy. Do not restore archived Tripo/remediation material or introduce a silent fallback.

## Current blocker and next action

1. Wait for the user to resume, then identify which manually tried region—if any—has an applied compatible GPU-family limit.
2. If none is approved, escalate `QuotaNotAvailableForResource` through Microsoft for Startups Program Support; do not create a CPU substitute or Marketplace image.
3. If quota is live, allocate only the private GPU worker in that region; keep the East US core and GibiWorld hosts intact.
4. Restore the hash-verified worker image and four-model bundle from private Blob storage.
5. Prove `o_voxel`/FlexGEMM on the NVIDIA driver, load models offline, and run the real pet image through TRELLIS, Blender rigging, animation bake, and final GLB validation.
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
- 2026-08-05 10:32 MDT — INCONCLUSIVE — Initial CLI quota/SKU verification used an Azure response-name filter that returned no matching rows for either region and therefore did not independently confirm the portal result. The portal shows a request for 24 `NCADS_A100_v4` family vCPUs in East US 2; a broader read-only quota lookup was required before provisioning.
- 2026-08-05 10:33 MDT — CONFIRMED PENDING — Broader live quota lookup found `StandardNCADSA100v4Family` in East US 2 at current 0 / limit 0, while `Standard_NC24ads_A100_v4` is listed as a 24-vCPU regional size. Azure has received the 24-vCPU request but has not approved/applied it. No GPU VM will be created until the live limit becomes 24.
- 2026-08-05 10:34 MDT — PASS — Private image-cache preflight on the core host: AzCopy, Zstandard, and SHA-256 tooling are installed; the accepted `b74ca0c` image is present; and more than 100 GB of `/opt` disk headroom remains. No archive or upload was started by this test.
- 2026-08-05 10:36 MDT — PASS — Private image-cache helper validation: shell syntax passed, 4/4 immutable model/runtime/cache security tests passed, and the full TypeScript check passed. The helper uses managed identity, refuses credential query strings, keeps transfer details out of standard output, and requires SHA-256 plus manifest byte comparison after a fresh private Blob readback.
- 2026-08-05 10:36 MDT — FAIL / NO EXECUTION — First helper transfer stopped because its new revision-specific destination directory did not exist. The helper was not installed or run, and no archive/upload began. The already transferred temporary file remains isolated for the directory-creation retry.
- 2026-08-05 10:36 MDT — PASS — Helper transfer retry created the exact revision-specific tool directory, installed commit `e408662`, removed the temporary transfer, and matched the committed local script SHA-256. No archive/upload began during the verification.
- 2026-08-05 10:36 MDT — IN PROGRESS — Persistent unit `paws-trellis-cache-b74ca0c` started the accepted image export, managed-identity private upload, and fresh Blob readback. Completion requires unit success plus the helper's archive SHA-256 and manifest byte comparisons.
- 2026-08-05 10:40 MDT — PASS — Private worker-image cache: persistent unit exited with result `success` and status 0. The helper reported state `complete`, build revision `b74ca0c`, 9,083,773,141 archive bytes, private readback `true`, and values printed `false`; host disk headroom remained healthy.
- 2026-08-05 10:41 MDT — INCONCLUSIVE — First sanitized Azure quota-request history query returned one record but the expected status/message fields were absent under the assumed schema. No request or account identifiers were printed. A key-only schema inspection is required to locate Azure's denial reason safely.
- 2026-08-05 10:41 MDT — PASS — Key-only quota schema inspection found Azure returns denial status, message, error, submission time, and requested values at the top level rather than under `properties`. No field values, request IDs, or account identifiers were printed by this schema check.
- 2026-08-05 10:42 MDT — DENIED / ACTION REQUIRED — Sanitized Azure quota history confirms the 24-vCPU `STANDARDNCADSA100V4FAMILY` request failed with `QuotaNotAvailableForResource`. Azure supplied no more specific explanation than “Request failed.” The live limit remains zero; no GPU resource exists or is accruing charges.
- 2026-08-05 10:43 MDT — INCONCLUSIVE — First cross-region A100/H100 SKU query returned no rows under the selected `list-skus --size` filter, so it provides no regional recommendation. No provisioning or quota request occurred; a broader SKU query is required if alternate-region evidence is needed for support.
- 2026-08-05 10:44 MDT — INCONCLUSIVE — The unfiltered `list-skus --all` catalog also returned no exact A100/H100 rows for this subscription, despite the legacy regional size catalog listing A100 in East US 2. This mismatch cannot prove capacity or approval eligibility. Regional size and live quota checks remain the safer evidence while manual requests are tried.
- 2026-08-05 10:45 MDT — PAUSED — User is trying quota requests in other regions and explicitly paused the goal. No active worker/cache job remains, no GPU VM exists, and no further Azure mutation or model-chain implementation is authorized until resume.
- 2026-08-05 10:45 MDT — PASS — Pause-checkpoint whitespace validation passed before commit. Only the handoff and simple status tracker were included; no runtime, Azure resource, or production change was made.
- 2026-08-05 11:04 MDT — INCONCLUSIVE / NO CHANGE — First sanitized Quota API probe used an incorrect top-level value path, and Azure rejected a request-history resource-name filter that its endpoint does not support in that form. No request, quota, VM, or other Azure resource was changed; no account identifiers or secret values were printed.
- 2026-08-05 11:04 MDT — PASS — Key-only Quota API schema inspection confirmed that compute quota applicability, limit, unit, and usage are nested under `properties`. The probe printed schema keys only and made no Azure change.
- 2026-08-05 11:05 MDT — CONFIRMED NOT APPLIED — Sanitized Quota API reads covered all seven requested regions. `StandardNCADSA100v4Family` is applicable in each, but Canada Central, Canada East, Central US, East US 2, Mexico Central, North Central US, and West Central US each remain at usage 0 / applied limit 0. The request-list schema was inspected by field names only; no request IDs or account identifiers were emitted.
- 2026-08-05 11:06 MDT — INCONCLUSIVE / NO CHANGE — A sanitized seven-region request-history query assumed the opaque request identifier contained the quota-family name and therefore returned no matched records. This does not mean requests are absent. No Azure state changed and no identifiers were printed; the next query must select by the request value payload instead.
- 2026-08-05 11:07 MDT — DENIED / NO CHANGE — Correct East US 2 Quota API history inspection found two 24-vCPU `StandardNCADSA100v4Family` attempts, both failed with `QuotaNotAvailableForResource`. The applied limit remains 0. No new request was sent by this check, and request identifiers are omitted from this handoff and tracker.
- 2026-08-05 11:08 MDT — DENIED / BATCH RESOLVED — Sanitized Quota API history proved all seven 24-vCPU portal requests were processed and failed. Canada Central, Central US, and East US 2 returned `QuotaNotAvailableForResource`; Canada East, Mexico Central, North Central US, and West Central US returned `ContactSupport`. All seven applied limits remain 0. No new request was sent, and no request/account identifiers were emitted.
- 2026-08-05 11:09 MDT — INCONCLUSIVE / NO CHANGE — The subscription-aware `list-skus --all` query still returned no exact `Standard_NC24ads_A100_v4` row, so it cannot identify an eligible region for this subscription. Microsoft documentation independently confirms that size is a 24-vCPU, single 80-GB A100 VM, but documentation does not prove regional allocation capacity. No Azure state changed.
- 2026-08-05 11:10 MDT — PASS / INVENTORY ONLY — Azure location metadata enumerated the standard US regions separately from preview, EUAP, staging, and STG locations. Only standard public US regions will be considered for another quota request; this query made no Azure change.
- 2026-08-05 11:11 MDT — PASS / CANDIDATES FOUND — Region-by-region size reads found `Standard_NC24ads_A100_v4` listed in Central US, East US, East US 2, South Central US, West US, West US 2, and West US 3. The exact size was not listed in North Central US or West Central US. Removing already failed regions leaves five untried US candidates. No quota or resource changed.
- 2026-08-05 11:12 MDT — PASS / FOUR CLEAN TARGETS — Quota API checks confirmed `StandardNCADSA100v4Family` is applicable with usage 0 / applied limit 0 in East US, South Central US, West US, West US 2, and West US 3. East US has one prior family request record; the other four have none. No quota or resource changed and no identifiers were emitted.
- 2026-08-05 11:13 MDT — DENIED / EAST US — Sanitized request history classified East US's existing 24-vCPU A100 request as failed with `ContactSupport`. South Central US, West US, West US 2, and West US 3 remain the four untried API targets. The query changed nothing and emitted no identifiers.
- 2026-08-05 11:14 MDT — NO EXECUTION / NO CHANGE — The first South Central US submission wrapper was rejected locally before process creation because its temporary-file cleanup pattern violated the workspace safety guard. Azure was not contacted and no quota request or resource change occurred. The retry must keep the sanitized response in memory without temporary cleanup commands.
- 2026-08-05 11:15 MDT — INCONCLUSIVE / VERIFY BEFORE RETRY — The in-memory South Central US `az quota update` process completed but yielded no observable sanitized response or follow-up read. It may have contacted Azure; no success or failure is inferred. Do not resend until a fresh applied-limit and request-history check establishes the actual state.
- 2026-08-05 11:16 MDT — CONFIRMED IN PROGRESS — Fresh Quota API evidence shows the South Central US A100-family request is processing for limit 24. The family is applicable, usage is 0, and the applied limit is still 0. No duplicate request or VM was created; request and account identifiers remain omitted.
- 2026-08-05 11:17 MDT — FAILED / SOUTH CENTRAL US — A bounded Quota API monitor observed the new 24-vCPU request transition from `InProgress` to `Failed`; a fresh quota read remains usage 0 / applied limit 0. No duplicate was sent and no VM exists. The error code was not included in this monitor output and must be read separately.
- 2026-08-05 11:18 MDT — CONFIRMED CONTACT SUPPORT — Sanitized history classified the failed South Central US request as `ContactSupport`. West US, West US 2, and West US 3 remain the clean API targets. No identifiers were emitted and no Azure state changed during this read.
- 2026-08-05 11:19 MDT — PASS — Quota-tracker checkpoint passed Git whitespace validation. Only `handoff.md` and the simple HTML tracker are modified; no runtime, infrastructure template, secret, or model file changed.
- 2026-08-05 11:20 MDT — PASS — Category-only scan of the quota handoff and HTML tracker found zero private-key, live-token, Azure-connection-string, credential-URL, email, subscription-ID, tenant-ID, or request-ID flags. No candidate value was printed.

## Operational references

- Local status: `http://127.0.0.1:8765/AZURE_TRELLIS_STATUS.html`
- Model intake: `http://127.0.0.1:8765/MODEL_INTAKE_REPORT.html`
- Tracked status source: `docs/AZURE_TRELLIS_STATUS.html`
- Model lock: `infra/azure/models/trellis2.lock.json`
- Secure gated staging helper: `infra/azure/scripts/complete-trellis-gated-staging.sh`
- Worker Dockerfile: `trellis-worker/Dockerfile`
- Completed corrected build unit: `paws-trellis-build-b74ca0c`
- Completed private image-cache unit: `paws-trellis-cache-b74ca0c`
