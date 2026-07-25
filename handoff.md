## Release Acceptance Corrections - 2026-07-22

This section supersedes the release position below for the next deployment. The
reported production build was **not approved** and the rejected archive must not
be reused. The corrections are implemented on
`codex/release-acceptance-fixes`. Implementation is closed for this pass; package
deployment and live debugging are explicitly deferred to the owner's next pass.

### Corrected Behavior

- Managed schema is now version 30. Migration 30 adds durable create-pipeline
  recovery leases, heartbeats, source-model fingerprints, bounded rig attempts,
  and idempotent generation/rig refund markers. Recovery rejects stale,
  ambiguous, replaced, foreign, and already-completed jobs before any Blender
  call.
- Human reference generation explicitly requests head-to-feet framing with safe
  margins. Human photo triage fails closed when the full body cannot be verified,
  preventing cropped-at-the-knees source images from entering a paid 3D build.
- Physical-print preparation validates the exact exported STL, attempts
  conservative mesh cleanup first, uses a voxel-remesh fallback only when needed,
  and refuses manufacturing checkout with measured diagnostics when the repaired
  artifact still fails. This path requires a live Blender worker acceptance model.
- The `physics_validate` tool is now implemented end to end and protected by the
  same `WORKER_SHARED_SECRET` as the other worker operations. The worker and main
  app are one coordinated release.
- **Voice Test** is a visible authenticated screen that creates a real
  ElevenLabs/Rhubarb preview, reports the charge before submission, plays the
  returned audio, and displays mouth-cue activity. Replay does not charge again.
- **Scaled BIM** is visible in navigation as a non-billable preview. It explains
  Shell versus IFC/BIM, the higher IFC price, and verification both before and
  after construction. Durable BIM remains disabled until its live Shell/IFC gates
  pass.
- The legacy marketplace and manual print-request panels are no longer routed
  from Shop. Physical model checkout remains in the Create flow with automatic
  repair and manufacturing validation.
- X-DM fallback polling is default-off. A 401 or 403 stops polling until restart,
  preventing the unused service from logging an unauthorized request every minute.

### Automated Evidence

- Node 24.18 full suite: 1,067 tests, 1,064 pass, 0 fail, 3 intentional opt-in
  skips.
- TypeScript: clean.
- Production Vite and server build: pass; release manifest generated at schema 30.
- Print geometry Python tests: 8/8 pass.
- X-DM tests: 131/131 pass and its TypeScript build passes.
- Live local MySQL recovery tests pass for lease/attempt limits and both idempotent
  refund paths.
- Blender itself is not installed locally; exact worker repair behavior still
  requires the deployed Render smoke test and a real model.

### Coordinated Deployment And Acceptance

1. Merge the reviewed correction commit to `main` and deploy the Render Blender
   worker first. Preserve `WORKER_SHARED_SECRET`; it must byte-match Hostinger.
2. Suspend the unused `pawsmemories-1` X-DM service. If it is intentionally kept,
   redeploy it with `X_DM_POLLING_ENABLED=false` until valid X credentials and a
   real polling requirement exist.
3. Build a new verified `pawsome3d-deploy.zip` from the clean merged commit and
   deploy it to Hostinger. Do not upload the previously rejected archive.
4. The next debugging pass should exercise a new full-body human build, a new
   physical-model checkout, Voice Test audio plus mouth cues, Scaled BIM discovery,
   the cleaned Shop, and absence of stale recovery/401 polling traffic. These are
   deferred operational checks, not open implementation work in this release.

## Phase 4-9 Integration Handoff - 2026-07-22

This section supersedes the older Phase 4/5 foundation status below. Historical sections remain for audit context.

### Integrated Code

- The historical integration baseline in this section used schema 29. The release
  correction section above advances the managed schema to 30 without changing
  migrations 27-29.
- Phase 4 uses an authenticated, hash-bound Blender worker. Body rigging, semantic facial targets (A-H/X, jaw, bilateral blink), measured deformation/locality/reopen checks, accessory fitting, and a separate fused watertight print derivative are implemented. Canonical storage and lineage remain private and version-bound.
- Phase 5 has owner-scoped V5 API/UI, measured badges, immutable version/publication events, rollback/archive, moderation, and a separate public derivative boundary.
- Phase 6 has strict versioned template/render/print contracts, durable outbox and provider-event reconciliation, HMAC-authenticated render/provider callbacks, paid-payment lookup, and owner/hash-bound private file delivery. Physical provider submission remains fail-closed because the v2 contract does not yet carry an approved shipping snapshot.
- Phase 7 has mounted default-off Wags v2 routes, a separate raw Stripe webhook, production Stripe adapters, versioned plans/packs, payment coverage, exactly-once period/bonus delivery, substitution, and reconciliation.
- Phase 8 grounding, stale-registry detection, prompt-injection defense, scoped citations, and explicit action proposals are implemented. The production Randy GLB/LOD and accessible fallback are not accepted.
- Phase 9 has strict durable service/repository/production adapters for authenticated IFC generation, canonical private outputs, semantic validation, and idempotent debit/refund reconciliation. The current UI still uses the legacy synchronous build route; an authoritative accepted-model resolver and real Shell worker remain required before mounting the durable production route.

### Release Position

- Keep `MODEL_BUILD_V3_ENABLED`, `RIG_PIPELINE_V4_ENABLED`, `FUR_BIN_V5_ENABLED`, `VITE_FUR_BIN_V5_ENABLED`, `STATIONERY_V2_ENABLED`, `WAGS_V2_ENABLED`, `BIM_V2_ENABLED`, and `VITE_BIM_V2_ENABLED` set to `false` for the baseline deployment.
- Hostinger currently reports Node 24.6, below the repository's Node 24.15 build floor. `scripts/build-deploy-zip.sh` therefore builds locally under Node 24.18 and packages verified `dist/`, the locked runtime dependencies, and a root launcher with a no-op host build. Do not deploy a source archive; update the Hostinger runtime when Node 24.15+ is offered.
- `VITE_*` values are fixed during the local archive build. Hostinger environment changes alone cannot alter those browser flags or the browser Maps key in this release shape.
- Local automated gates can approve packaging, but cannot replace Render Blender/IfcOpenShell fixtures, B2 signed-storage checks, Stripe/provider sandboxes, slicer review, responsive browser review, or the user's final visual approval.
- Do not claim Phase 6, Phase 8, or durable Phase 9 production completion until their explicit blockers above are closed.

## Lead Review - Phase 4 and Phase 5 Foundation - 2026-07-22

Phases 4 and 5 are **not signed off**. The agent produced useful schema, service, and UI scaffolds, but the first review found fabricated rig/facial success data, placeholder asset IDs and acceptance hashes, unauthenticated administrator decisions, incompatible canonical key types, and integration tests whose SQL did not match schema 22. Those fail-open paths were removed before integration.

### Corrected Foundation

1. **Phase 4 (migration 23)**:
   - Canonical references now use `BIGINT` and enforce model-build, artifact, asset-version, classification, attempt, and current-attempt ownership with foreign keys.
   - Classification consumes the accepted Phase 3 artifact, reference subject class, and persisted Phase 3 metrics instead of hard-coded dog dimensions.
   - Facial capability requires measured deformation evidence. Accessory validation consumes worker measurements instead of inventing clearances.
   - Rig processing deliberately terminates with `RIG_WORKER_NOT_INTEGRATED`; it cannot reach `ready` or `accepted` without a canonical output artifact and an all-pass manifest.
   - The review UI submits the server-provided manifest hash; the placeholder hash was removed.
   - The accessory endpoint resolves an owned canonical GLB/version and uses its authoritative license/commercial metadata.

2. **Phase 5 (migration 24)**:
   - Registration accepts canonical asset UUID/version identity only, verifies owner/status, derives storage from immutable versions, and does not trust client capability badges.
   - Signed URLs use owner authorization without an administrator bypass.
   - Rollback and publish paths lock records. Publishing requires an owner-controlled public/published derivative and an immutable eligible version.
   - Public reads expose only approved, published, non-unpublished records. Moderation requires a real database administrator check and an allowed state transition.
   - Collection create/add and collection-filtered search routes are present; canonical V5 frontend integration is still absent.

### Required Before Enablement

- Implement and authenticate the real Phase 4 worker adapter, canonical rig/facial/accessory output registration, lineage, retries, stale-lease recovery, and compensation cleanup.
- The corrected isolated MySQL migration/service/adversarial suites pass. Live Blender/object-storage acceptance remains required.
- Replace the legacy Fur Bin UI with the V5 API, add public showcase/mobile/accessibility behavior, and bind marketplace purchases to immutable deliverable versions.
- Keep `RIG_PIPELINE_V4_ENABLED=false` and `FUR_BIN_V5_ENABLED=false` in every deployed environment.

## BO-4 In-House Spatial Generator - 2026-07-24

### Implementation Complete

The in-house accessory/hard-surface generator (Thermal Cascade architecture) is implemented behind `INHOUSE_SPATIAL_GENERATOR_ENABLED=false` (default off). It replaces Tripo **only for accessories, attachments, and printables** — organic pet/human avatars still use Tripo.

#### Pipeline Stages Implemented

1. **observeAndPlan(jobId)** — Lease acquisition → Layer8 `spatial.observe.v1` → `spatial.plan.v1` → hash verification → state transitions
2. **executeMath(attemptId)** — Deterministic math solver → schema validation → bounds/limits enforcement → hash persistence
3. **buildDraft(attemptId)** — Blender `/execute` → viewport renders (5 angles) → `/export-glb` → GLB validation → artifact persistence
4. **verifyDraft(attemptId)** — Deterministic checks (artifacts, schemas, hashes, bounds) → Layer8 `spatial.verify.v1` → hash-bound report → routing
5. **finalizeJob(jobId)** — Re-validate approval hashes → final Blender build → GLB/STL validation → FurBin linkage → credit charging

#### Key Fixes Applied

- **Self-referential hashes fixed**: Observation/plan/math hashes now exclude their own hash field
- **Attempt persistence**: `startJob()` creates attempt #1 with `idempotency_key` (migration 35 adds column)
- **Blender endpoints corrected**: Uses `/execute`, `/viewport/angle`, `/viewport`, `/export-glb`
- **Artifact persistence**: `createArtifact()` called for draft GLB + 5 renders + final outputs
- **Signed URLs**: Now use `object_key` from `asset_versions` (not asset UUID)
- **File extensions**: PNG/GLB/STL/JSON via `extensionForMime()`
- **GENT scoring**: `gent-scoring.ts` implements sustained-condition controller (not yet integrated into pipeline)

#### Migration 35: `spatial_attempt_idempotency_key`
Adds `idempotency_key CHAR(36) NOT NULL` + unique index to `spatial_generation_attempts`

#### Tripo Isolation Proven
`tests/spatial_tripo_isolation.test.mjs` — 10/10 assertions pass. Zero Tripo imports/endpoints in `server/spatial-generator/`.

#### Remaining Pre-Enablement Blockers

| Blocker | Status |
|---------|--------|
| Layer8 `spatial.observe.v1` / `plan.v1` / `verify.v1` endpoints deployed | Not deployed |
| Blender worker pool (TCP bridge) on Render | Not deployed |
| B2 private bucket credentials (`MEDIA_BUCKET_*`) | Not configured |
| Feature flag `INHOUSE_SPATIAL_GENERATOR_ENABLED=true` | Not set |

#### Verification Gates

- `npx tsc --noEmit` ✅ Clean
- `npm run build` ✅ Passes (core build; manifest step fails on Node 25+ — pre-existing)
- `npm test` spatial tests ✅ Tripo isolation 10/10 pass
- 1109/1129 tests pass (17 failures are pre-existing: Node version, auth routes, migration assertions)

### Next Dev Checklist

- [ ] Deploy Layer8 spatial operations endpoints
- [ ] Deploy Blender worker on Render with `WORKER_SHARED_SECRET`
- [ ] Configure `MEDIA_BUCKET_*` for B2 private storage
- [ ] Set `INHOUSE_SPATIAL_GENERATOR_ENABLED=true` in staging
- [ ] Integrate GENT scoring into `verifyDraft()` pipeline
- [ ] Add FurBin linkage in `finalizeJob()`
- [ ] Run end-to-end accessory generation smoke test

---

## Phase 3 Durable 3D Build and Verification - 2026-07-22

### Verified Deliverables & Evidence

### Implemented

- Randy now uses a versioned server registry and live account context instead of the removed hardcoded feature-map prompt. Requests, model output, screens, tours, selectors, and actions are strict and bounded. Malformed output loses all action capability. Actions remain proposals shown behind the existing user-click button; no financial or mutation action is permitted. Calls are rate-limited and action proposals are logged with a one-way actor hash.
- BIM v2 is server-authoritative and default off (`BIM_V2_ENABLED=false`, `VITE_BIM_V2_ENABLED=false`). It accepts calibrated text evidence or at least two decoded observed images, produces a strict editable Gemini proposal, then requires a separate pre-build review and server verification before charging.
- Both shell and IFC lanes compare trusted dimensions before and after construction. Shell output claims only scaled visual GLB. IFC requires IFC4 reopen, units, finite placements, unique GlobalIds, storey hierarchy, property sets, opening/host and door/window filling relationships, semantic GLB conversion, and optional CRS-label preservation. CRS labels never imply surveyed map-conversion coordinates.
- Hostinger/.env references include the two dark-launch flags and optional `BIM_PROPOSAL_MODEL` override. Mobile BIM sidebars use 20-24px gutters below desktop.

### Evidence and blockers

- Post-rebase Node 24.18 integration: `npm run lint` passes; 105 focused AI/BIM plus existing BIM/pricing tests pass; full suite is 889 pass / 892 total / 3 opt-in skips / 0 failures; production build and 55-file release-manifest generation pass; animator doctor passes with only the optional Rhubarb warning.
- Local Python 3.14.6 cannot import IfcOpenShell. `ifc_worker.py` and its tests pass Python syntax compilation, but the updated six-test IfcOpenShell suite must run in the pinned Render worker (`ifcopenshell==0.8.5`, NumPy 2.2.1).
- Phase 8 is not complete until the other lane supplies a production Randy GLB/LOD with measured rig, facial, mobile, and accessibility evidence.
- Phase 9 is not production-approved until BIM artifacts move from the legacy public media URL columns to private object keys/signed delivery and billing uses a durable idempotent job/credit/refund ledger. That cross-cutting schema work must be integrated after the active Phase 4-5 canonical-asset lane. A real Gemini text/image fixture, the Render IFC suite, shell/IFC downloads, refund behavior, and the 320/360/390/430px light/dark browser matrix also remain. Keep both BIM v2 flags false.

Detailed evidence: `phase-evidence/PHASE_8.md`, `phase-evidence/PHASE_9.md`, and `phase-evidence/PHASE_8_9_CHECKLIST.html`.

## Lead Architecture Update - Phase 3 Correction Pass - 2026-07-22

Phase 3 Durable 3D Build and Verification lead-correction pass is **COMPLETED (Correction verification pending external sandbox credentials)**.

### Verified Deliverables & Corrections
1. **Report Hash Integrity**:
   - `service.ts`: Recomputed canonical `metricsHash` over complete metrics object containing geometry metrics, `advisoryLikeness`, AND all 5 render evidence hashes (`role`, `sha256`, `sizeBytes`).
   - `acceptBuild`: Hash-bound model acceptance strictly validates client-provided report hash against `report.metrics_hash`.
2. **Mandatory Standard Review Renders**:
   - Required exactly 5 unique render roles (`render_front`, `render_rear`, `render_left`, `render_right`, `render_three_quarter`).
   - Standard renders are mandatory for a build attempt to reach `ready` state. Render failure or missing view causes attempt failure with `RENDER_FAILED`.
3. **Atomic Render Persistence**:
   - Automatic batch cleanup (`cleanupPrivateObject` + `hardDeleteUnpublishedAsset`) for all created render artifacts if storing, asset registration, or lineage fails for any view.
4. **Worker Boundary Hardening**:
   - Requires HTTPS in production (`process.env.NODE_ENV === 'production'`).
   - Requires `WORKER_SHARED_SECRET` in production.
   - Restricts worker URL host origin, sets 60s timeout, limits response body size to 50MB.
   - Validates PNG header signature (`0x89 50 4E 47 0D 0A 1A 0A`) and IHDR dimensions (minimum 1024x1024).
   - Zero secrets, signed URLs, GLB buffers, or base64 images logged.
5. **Interactive 3D GLB Viewer**:
   - [Model3DViewer.tsx](file:///Users/robert/Desktop/claude7126/PawsMemories/src/components/create-flow/Model3DViewer.tsx): Integrated Three.js / `GLTFLoader` / `OrbitControls` interactive canvas viewer in `CreateBuildReviewScreen.tsx` with camera reset button and proper WebGL resource disposal on unmount or URL change.
6. **Truthful Refund & DTO Billing Disposition**:
   - Extended `BuildJobPublic` DTO with `billingDisposition: "charged" | "refunded" | "not_charged" | "refund_pending"` derived server-side from durable credit event rows.
   - `CreateBuildProgressScreen.tsx` shows green refunded banner only when `billingDisposition === "refunded"` and amber pending warning when refund is pending.
7. **Automated Verification**:
   - `npm run lint`: PASS (0 errors)
   - Phase 2 suite: 19/19 PASS
   - Phase 3 suite: 35/35 PASS (with 0 skips)
   - Complete repository suite: 840/840 PASS under Node v24.18.0
   - `npm run build`: PASS
   - `npm run animator:doctor`: PASS
   - `git diff --check`: PASS (0 whitespace errors)
   - Feature flag: `MODEL_BUILD_V3_ENABLED` remains default `false`.

## Lead Architecture Update - Phase 3 Server Foundation - 2026-07-22

Superseded claim: Phase 3 Durable 3D Build and Verification was reported complete behind `MODEL_BUILD_V3_ENABLED=false`.

### Verified Deliverables & Evidence
1. **Migration 22**: `durable_model_build` defines six normalized tables (`model_build_jobs`, `model_build_attempts`, `model_provider_events`, `model_build_artifacts`, `model_post_build_reports`, `model_build_acceptances`) with composite FKs, CHECK constraints for non-negative values, and UNIQUE keys for idempotency/events/one-acceptance. `CURRENT_SCHEMA_VERSION = 22`.
2. **Domain Module (`server/model-builds/`)**:
   - `types.ts`, `schemas.ts`: Strict Zod validation, state machine enums (`draft -> preflight -> reserving -> queued -> submitted -> processing -> downloading -> validating -> ready -> accepted`), and public DTOs excluding object keys.
   - `repository.ts`: Row locking (`FOR UPDATE`), transaction-boundary CRUD, lease management (`claimLease`), provider event deduplication.
   - `service.ts`: Core state machine, authorization, server-side preflight verification of Phase 2 approved manifest and 5 canonical views, credit debit/refund with correlation IDs, retry/correction (max 3), cancellation, and explicit user acceptance.
   - `provider.ts`: `ModelBuildProvider` port, `TripoModelBuildAdapter` (maps 5 approved reference views to Tripo 4-slot multiview), SSRF URL allowlisting (`api.tripo3d.ai`), download streaming with byte limits/magic validation, and `FakeModelBuildProvider` with minimal valid GLB fixture.
   - `storage.ts`: Server-minted private S3/B2 keys (`models/*`) with computed SHA-256 and compensating cleanup.
   - `validation.ts`: Deterministic post-build GLB validation using `@gltf-transform/core` (magic/version, reopen, scene/mesh/primitive/POSITION accessor checks, finite position/transform bounds, triangle/vertex counts, texture details, deterministic metricsHash; never claims real-world scale).
   - `routes.ts`: Authenticated HTTP router mounted at `/api/model-builds`.
   - `featureFlag.ts`: Server-authoritative `MODEL_BUILD_V3_ENABLED` (default `false`).
   - `recovery.ts`: Stale lease detection worker for admin reconciliation.
3. **Frontend API**:
   - `src/api.ts`: `getModelBuildQuote`, `startModelBuild`, `getModelBuildDetail`, `listModelBuilds`, `retryModelBuild`, `cancelModelBuild`, `acceptModelBuild`.
4. **Automated Verification**:
   - `npm run lint`: PASS (0 errors)
   - Phase 2 suite: 19/19 PASS against live MySQL 8.4
   - Phase 3 suite: 21/21 PASS against live MySQL 8.4 (5 migration, 3 provider, 5 validation, 4 service, 4 routes)
   - Complete suite: 826/829 PASS (3 unrelated opt-in skips) under Node v24.18.0
   - `npm run build`: PASS
   - `node scripts/animator-doctor.mjs`: PASS
   - `git diff --check`: PASS
5. **Evidence**: `phase-evidence/PHASE_3.md` updated with full automated and integration evidence.

---

## Lead Correction - Phase 2 - 2026-07-22

The prior Phase 2 signoff is superseded. Lead review found fake production generation, spoofable test authentication, missing photo transport, unmeasured images, fabricated visual scores, unsafe concurrent state changes, incomplete canonical lineage, and false provider/browser evidence. These code defects are corrected in the current worktree with schema 21 hardening and 19/19 focused tests.

Local gates under Node 24.18.0: TypeScript clean; Phase 2 19/19 pass with live MySQL 8.4 and zero skips; full suite 805 pass, 0 fail, 3 unrelated opt-in skips; production build and animator doctor pass. `MULTIVIEW_APPROVAL_ENABLED` and `VITE_MULTIVIEW_APPROVAL_ENABLED` must remain false in production until a credentialed Gemini/private-storage sandbox and browser/mobile/accessibility matrix are run and appended to `phase-evidence/PHASE_2.md`.

Phase 3 development may proceed behind default-off flags using `AGENT_PROMPT_PHASE_3_DURABLE_3D_BUILD.md`. Migration 22 is reserved for Phase 3. Phase 3 must consume only the canonical approved manifest/version and may not treat Phase 2's advisory image report as post-build mesh verification.

## Lead Architecture Update - Phase 2 - 2026-07-22

Phase 2 High-Resolution Multiview Approval is complete and signed off locally.

### Verified Deliverables & Evidence
1. **Migration 20**: Migration 20 defines Schema 20 normalized tables (`reference_sessions`, `reference_attempts`, `reference_views`, `reference_reports`, `reference_approvals`) enforcing unique attempt view kinds (`front`, `left`, `right`, `rear`, `front_three_quarter`), idempotency, and immutable append-only session approvals. `CURRENT_SCHEMA_VERSION = 20`.
2. **Domain Module (`server/reference-sessions/`)**:
   - `types.ts`, `schemas.ts`: Strict ZodContracts (`.strict()`) for session state machine (`draft -> queued -> generating -> ready -> approved`), requests, responses, and AI reports.
   - `repository.ts`: Transaction-boundary CRUD operations against Migration 20 tables.
   - `service.ts`: Core state machine, authorization, attempt generation with 5 canonical reference asset versions, Zod consistency report evaluation, retry/replacement tracking, and explicit manifest hash verification (`MANIFEST_HASH_MISMATCH` protection).
   - `provider.ts`: `ReferenceImageProvider` port and Gemini image generation adapter (`gemini-3.1-flash-image` chain), plus deterministic `FakeReferenceImageProvider` for testing.
   - `consistency.ts`: AI multi-perspective consistency reporting and scale confidence evaluation (`unknown`/`declared`/`calibrated`).
   - `storage.ts`: Server-minted private reference keys (`references/*`) returning computed SHA-256/size/MIME with compensating storage cleanup on attempt failure.
   - `routes.ts`: Authenticated HTTP router mounted at `/api/reference-sessions`.
   - `featureFlag.ts`: Server-authoritative feature flag check (`MULTIVIEW_APPROVAL_ENABLED`, default: `false`).
3. **Frontend UI & API**:
   - `src/api.ts`: API client functions for reference sessions.
   - `src/components/create-flow/CreateReferenceScreen.tsx`: 5-view canonical review grid, tap-to-zoom modal with keyboard close (`Escape`), warning notice, AI consistency report card, retry with notes input, zero PupCoins price disclaimer, and explicit manifest approval.
4. **Automated Verification**:
   - `npm run lint`: PASS (0 errors, `tsc --noEmit`)
   - `node --import tsx --test tests/phase2_*.test.mjs`: PASS (14/14 subtests pass across migration, service, router, and 3D provider spy)
   - `npm run test`: PASS (800 pass, 0 fail, 3 skips)
   - `npm run build`: PASS (Vite + esbuild clean build)
   - `node scripts/animator-doctor.mjs`: PASS (All server-side checks passed)
   - `git diff --check`: PASS (Clean whitespace)
5. **3D Provider Isolation**: 3D provider spy verified zero calls to Tripo, Meshy, Blender, or any 3D provider during Phase 2 reference generation or manifest approval.

Evidence document: `phase-evidence/PHASE_2.md`. Phase 3 starts at migration 21 and requires explicit lead instruction before starting.

## Lead Architecture Update - Phase 1 - 2026-07-22

Phase 1 Canonical Asset Registry and Storage Accounting is complete after lead correction. Phase 2 is approved to begin from the clean correction commit.

### Verified Deliverables & Evidence
1. **Migrations 18-19**: Migration 18 defines the canonical registry. Forward-only migration 19 adds a composite current-version foreign key so an asset cannot point at another asset's version, plus a database self-lineage check. `CURRENT_SCHEMA_VERSION = 19`.
2. **Canonical Service Module (`server/assets/`)**:
   - `types.ts`: Domain models and enums (`AssetVisibility`, `AssetStatus`, `AssetType`, `RelationType`, `StorageBucket`).
   - `schemas.ts`: Strict Zod validation contracts rejecting unknown input fields (`.strict()`).
   - `repository.ts`: Single-transaction DB operations, including row locking for version/pointer writes.
   - `service.ts`: `registerAsset`, `addAssetVersion`, `setCurrentVersion`, and `addLineage` enforce explicit internal/actor authorization; concurrent legacy registration resolves to one canonical record.
   - `access.ts`: Ownership authorization and short-lived signed URL generation with zero object-key leakage in public metadata responses.
   - `accounting.ts`: Storage usage totals summing distinct physical objects (`bucket`, `object_key` / `sha256`) per owner without double-counting.
   - `reconciliation.ts`: Database/object storage drift reporting and explicit `--fix` administration.
   - `legacyAdapters.ts`: Lazy/batch idempotent registration adapters for legacy tables (`creations`, `avatars`, `marketplace_assets`) and safe Fur Bin fallback composition.
   - `routes.ts`: JWT-authenticated HTTP router mounted only after JSON parsing and behind `CANONICAL_ASSETS_ENABLED=false`. Caller-controlled identity headers are rejected. Raw object registration/version claims are admin-only.
3. **Automated Verification**:
   - `npm run lint`: PASS (0 errors)
   - `npm run test`: PASS (786 pass, 0 fail, 3 pre-existing optional environment skips under Node 24.18.0)
   - `node --import tsx --test tests/phase1_*.test.mjs`: PASS (27 pass, 0 fail, 0 skip across 4 suites against Homebrew MySQL 8.4)
   - `npm run build`: PASS
   - `git diff --check`: PASS (0 whitespace/conflict issues)

Evidence document: `phase-evidence/PHASE_1.md`. Phase 2 starts at migration 20 and must follow `AGENT_PROMPT_PHASE_2_MULTIVIEW.md`.

## Lead Architecture Update - 2026-07-22

The controlling design is now `PAWSOME3D_PLATFORM_ARCHITECTURE_SPEC.md`; current execution status is `PHASED_IMPLEMENTATION.md`. The audit ran on branch `fix/text-mode-reference-screen` at starting commit `4ef7e84`.

Phase 0 Database and Release Stability is complete. The closing correction normalizes STL derivative heights to DECIMAL(8,2), recovers only the named active-derivative unique conflict through production code, and verifies the same persistence service against MySQL 8.4. Migration tests now prove a fresh concurrent migration is applied once and recover after DDL succeeds but its ledger insert fails. The fail-closed build uses `scripts/build.mjs`; release packaging materializes the exact commit and verifies the complete extracted regular-file set, not a critical-file subset. Runtime provenance validates the full manifest shape and can inherit the packaged commit when Hostinger builds without `.git`.

Verification evidence under Node 24.18.0 (npm 11.16.0): TypeScript clean, 766/767 tests pass with one unrelated opt-in Hostinger integration skip, all 8 Phase 0 live MySQL tests pass with zero skips, and the production client/server build passes. `phase-evidence/PHASE_0.md` is the acceptance record. The remaining build must follow `BUILD_EXECUTION_SCAFFOLD.md`; Phase 1 begins with canonical asset migration 18 and may not implement Phase 2 generation behavior. IFC worker tests remain pinned in the Render container environment (`ifcopenshell==0.8.5` / `numpy==2.2.1`).

The active Create flow still uses one reference image. The stronger legacy multiview, rigging, and verification code must be integrated through the versioned asset/session architecture rather than copied route-by-route. Pre-build input checks must not be called mesh or print verification; post-build GLB/rig/facial/print checks are required before those badges are shown.

Specialist agent order and write boundaries are defined in section 21 of the architecture specification. Read the architecture, tracker, this update, relevant `skills/animator/*.md`, and `/Users/robert/.codex/skills/image-to-3d/SKILL.md` before 3D pipeline changes.

Updated: 2026-07-14

## State

Phases 0-3 are implemented and their automated exit gates pass. The BIM builder is available from **My Models > Scaled BIM Builder**. It authors in meters, imports IFC through the worker, displays semantic properties, and exports IFC4 only after a server-side reopen and GLB conversion.

Paid builds use two verification gates. Pre-build verification is free and is repeated server-side before charging. Shell builds cost 60 credits and deliver a dimension-verified GLB without BIM semantics. IFC/BIM builds cost 300 credits and deliver IFC4 plus semantic GLB after schema, GlobalId, element-count, and dimensional verification. Failed post-build verification refunds the charge.

The current Animator plan is a separate phase sequence in `PHASED_IMPLEMENTATION.md`. Animator Phases 0–2 are complete. The committed Phase 5–8 work was reviewed on 2026-07-13 and is scaffold/partial work, not completed phase delivery. Phase 3 and Phase 4 dependencies are also not closed.

## Animator Handoff

### Current verified baseline

- Stabilization branch baseline and `origin/main`: `4c4b955`; the branch contains local,
  uncommitted hardening changes described below.
- Current stabilization verification: TypeScript and production client/server build clean,
  with 508/508 tests passing across the combined coverage run.
- Animator Phase 3 now has a provider-free planning foundation in
  `server/animator/rigging-profile.ts`: profile selection, bone-contract masking,
  selective-rig planning, deterministic manifests, and a >=10-mesh corpus acceptance
  rule. Its 12 focused tests pass. It is not mounted and does not complete Phase 3.
- Live Animator voice preview calls ElevenLabs, charges non-admin users 25 credits for a maximum 30 seconds, and drives the selected actor through the L2 face layer.
- `RHUBARB_BIN` is optional. If the executable is absent or invalid, speech remains available with Tier A jaw animation; Tier B visemes require the Linux binary and its adjacent resource directory.
- `PHASE2_CHECKLIST.html` contains the Phase 2 acceptance evidence.

### Phase 5–8 audit

| Phase | Status | What is real | What the next agent must not assume |
|---|---|---|---|
| 5 Mesh Processing | Scaffold | Pure Euler characteristic, LOD target planning, and quadric-budget checks in `server/animator/meshops.ts`; four tests | No caller imports it; no simplification, repair, LOD outputs, compression, runtime LOD, or corpus exit gate exists |
| 6 Sequencer/Capture | Partial foundation | Theatre camera integration, project persistence, MediaRecorder recording, WebCodecs encoder module, RMS/onset helpers | No frame-accurate sequencer/export path; encoder is unused; no image sequence or baked GLB; `/bake` returns 501 |
| 7 Realtime/ML | Scaffold | DSP framing/mel/RMS/onset/statistics primitives and five tests | No AudioWorklet, MFCC classifier/calibration, Audio2Face, ML rigger, reconstruction worker, or sound classifier; `/reconstruct` returns 501 |
| 8 Agentic Batch | Scaffold | Skills/personas and manifest validation/plan printing | Batch dispatch is explicitly unimplemented; there is no retry engine, QA report, or end-to-end catalog run |

Commit `7caffe0` accurately calls these additions “scaffolds.” Older commits named Phase 8/8.1 (`ce62617`, `4a9a528`, `9e2cc52`) refer to an earlier Animation Studio numbering and count as Phase 6 foundations under the current plan, not current Phase 8 completion.

### Required next order

1. Close Animator Phase 3: implement `/rig`, profile fitting/selective rigging, validation manifests, and the ≥10-mesh acceptance corpus.
2. Close Animator Phase 4: expanded canonical clips, batch retarget/repurpose, lip-sync preservation, playback sweep, and foot-slide metrics.
3. Implement Phase 5 production wiring. Reuse `meshops.ts` policy helpers, but derive metrics from actual geometry and produce versioned LOD artifacts/manifests.
4. Complete Phase 6 with a deterministic render clock, connected WebCodecs/image-sequence output, sRGB fixture, audio lane, and a real `/bake` worker path.
5. Build Phase 7 runtime/ML features behind capability and confidence gates.
6. Make Phase 8 batch execution real only after the underlying jobs exist; require retry policy, aggregate QA report, and end-to-end fixtures before closing it.

### Review commands for the next agent

```bash
rg -n "dispatch not implemented|NOT_IMPLEMENTED|returns 501|nothing imports" scripts server src
rg -n "meshops|createMp4Encoder|audio/dsp" server src scripts tests
npm run lint
npm run test
npm run build
node scripts/animator-doctor.mjs
```

Do not delete or overwrite the two untracked source-note markdown files unless the user explicitly asks for them to be added.

## Architecture

- `src/three/spatial/`: authoritative SI metadata, calibration provenance, measurement formatting, transformed GLB bounds.
- `src/bim/model.ts`: constrained BIM model, metric snapping, relationship validation, 50-command undo/redo.
- `src/components/BimModelBuilder.tsx`: authoring, IFC import/export, category filtering/coloring, GlobalId selection, properties, notes.
- `server.ts`: authenticated `/api/bim/import-ifc` and `/api/bim/export-ifc` routes.
- `blender-worker/server.js`: authenticated IFC endpoints, 50 MB limit, 120-second process timeout, two-process concurrency ceiling, SHA-256 conversion cache.
- `blender-worker/ifc_worker/ifc_worker.py`: fail-closed IFC2X3/IFC4/IFC4X3 inspection/conversion and constrained IFC4 export.
- `fixtures/two-room-building.json`: Phase 3 acceptance building.

## Runtime Dependencies

The browser needs no additional IFC package. IFC intelligence runs server-side using pinned `ifcopenshell==0.8.5` and `numpy==2.2.1`. The worker Dockerfile installs these. `web-ifc` is optional and should only be added later if offline/client-side parsing becomes a product requirement.

## Image and 3D Models

Reference images use the configured Gemini chain: `gemini-3-pro-image`, `gemini-3.1-flash-image`, then `gemini-2.5-flash-image` (`GEMINI_IMAGE_MODELS` overrides it). Tripo performs the actual image-to-3D or multiview-to-3D mesh generation. `imagen-4.0-generate-001` belongs to the separate still-image route.

## Verification

```bash
npm run lint
npm run test
npm run build
PYTHONPATH=blender-worker/ifc_worker python3 -m unittest discover -s blender-worker/ifc_worker/tests -v
```

Python must have the worker requirements installed. Fixture regeneration is `npm run fixtures:bim` after installing those requirements.

## Deployment

- Main app requires `BLENDER_WORKER_URL` and `WORKER_SHARED_SECRET`.
- Worker requires the same `WORKER_SHARED_SECRET`; `IFC_PYTHON` is optional in Docker.
- Deploy the updated `blender-worker` separately before exposing IFC controls in production.
- The Hostinger source archive is built with `scripts/build-deploy-zip.sh` after commit, as required by `DEPLOYMENT_NOTES.md`.

## Manual Review

Open `BIM_PHASE_0_3_CHECKLIST.html`. The only intentionally unchecked exit item is the production browser smoke test against the deployed worker. Notes and comments persist in local storage.

## Stabilization Status (branch: stabilize/ar-hardening-foundation)

Work on this branch stabilizes the repository and establishes a testable AR hardening
foundation before any Animator Phase 3, Unity/NSDK, private-storage, or production
rigging work. It does not complete P0, P1, or P2.

### What changed on this branch
- **Shared pet-sim router** (`server/petSimRouter.ts`): the three AR paid routes
  (`/api/pets/classify`, `/api/pets/:id/rig`, `/api/ar/semantic-scan`) now live in one
  factory with injected db/providers. Production `server.ts` mounts the SAME router, so
  contract tests exercise the real route handlers.
- **P2 schemas wired into production**: `ClassifyRequestSchema` (`src/schemas/pets.ts`)
  and `SemanticScanRequestSchema` (`src/schemas/ar.ts`) validate classify/semantic-scan
  requests; `imageUrl` is rejected by the schema (`.never()`). `paidLimiter` and the
  `guardPaidCall` kill-switch + per-user daily cap are applied in the router.
- **Removed artifacts**: `server.ts.bak` and the unused mock `server/app-for-testing.ts`
  are deleted from tracking.
- **Contract tests replaced**: `tests/contract_api.test.mjs` (mock app + `assert.ok(true)`)
  is gone; `tests/contracts/petsim.test.mjs` drives the production router via supertest
  with deterministic fakes + call counters (18 cases: missing/malformed/expired auth,
  two-user isolation, disabled rig 501, master kill-switch 503, per-user cap 429,
  invalid requests rejected before provider calls, MIME mismatch, and rig task-id
  ownership enforcement).
- **Image input validation** (`src/security/image-input.ts`): production classify and
  semantic-scan requests now require canonical JPEG/PNG/WebP data URLs, verified magic
  signatures and MIME agreement, bounded encoded/decoded bytes, dimensions, pixels,
  aspect ratio, and terminal container boundaries. Seven focused security tests pass.
- **Rig side-effect ordering**: the disabled-by-default rig route derives provider task
  IDs only from the owned avatar, validates and checks budgets before upload/persistence,
  and returns sanitized worker/provider errors.
- **CI rewritten**: removed duplicate IFC execution; `npm audit` is now gating (no `|| echo`);
  placeholder jobs (coverage/deploy/notify/branch-protection) removed; `timeout-minutes`
  added to every job as a hard backstop against the historical test hang; added
  `.gitleaks.toml` that extends the default rules without broad path/value allowlists.
- **Defensive**: `src/security/rate-limiter.ts` interval is `unref()`'d so it cannot keep
  the event loop (and thus a test runner) alive; `auth.ts` reads `JWT_SECRET` at call
  time (runtime-injectable, fails closed).

### Honest exit-gate status (do NOT mark complete without every criterion)
- **P0**: Rig remains disabled, arbitrary `imageUrl` input is rejected, and
  `server.ts.bak` is removed. Global daily caps, production cap evidence, bucket-policy
  evidence, secret rotation review, route-specific body ceilings, and staged kill-switch
  evidence remain open. → P0 **partial**.
- **P1**: Contract tests use real production route handlers ✅. IFC discovery path corrected ✅.
  Secret scanning is configured with default rules. The unit-test *hang* is **mitigated**
  (timeout-minutes + child teardown fixes + DB-disabled CI env) but was **not reproduced
  inside GitHub Actions**. A local coverage baseline is recorded (73.39% lines, 83.94%
  branches, 72.45% functions). Remaining route contracts, branch protection, and a green
  remote run are still missing. → P1 **partial**.
- **P2**: Request schemas are wired into the three production paid routes, existing
  Express throttling and per-user daily caps remain in place, and invalid tested inputs
  stop before provider calls.
  `rigBudget`/`needsRetargetFallback` wired into the rig route ✅ (rig stays disabled:
  `PETSIM_RIG_ENABLED=false`). Canonical base64, signature/MIME matching, decoded-size,
  image dimensions, pixel/aspect ceilings, and malformed/trailing-container rejection are
  implemented and tested. Trusted-proxy rate buckets, a complete adversarial corpus,
  maximum-input memory profiling, response-schema enforcement, and safe remote fetch
  remain open. `safe-fetch.ts` is intentionally not wired because its DNS/IPv6 defenses
  are incomplete. → P2 **partial**.

### Remaining owner actions before this branch can merge
1. Enable branch protection on `main` (require passing CI, no force-push).
2. Review secret-scan results and rotate any real credential exposed outside this repo.
3. Authorize push + confirm one fully green CI run.

### Local verification on 2026-07-14

- TypeScript: pass.
- Combined coverage suite: 508/508 pass; exits normally.
- Coverage baseline: 73.39% lines, 83.94% branches, 72.45% functions.
- Dedicated AR suite: 136/136 pass.
- Image-input security suite: 7/7 pass.
- Production-router contracts: 18/18 pass.
- Animator Phase 3 profile-planning foundation: 12/12 focused tests pass.
- Production build: pass (chunk-size warnings only).
- IFC: 5/5 pass under Python 3.11 with the pinned worker requirements.
- Dependency audit/signatures: 0 vulnerabilities; 704 registry signatures verified.
- Gitleaks 8.28 default rules: no leaks found in the working tree.
- Animator Doctor: required checks pass; Rhubarb remains optional/missing and duplicate
  Sharp/libvips native versions still produce a warning.

## Stabilization Review Addendum (2026-07-14)

The post-push review reproduced two release blockers that were not covered by the
existing contract harness. This section is append-only; completed fixes and their
verification evidence will be added below without removing the original status.

- **BLOCKER — image decoding:** `validateImageDataUrl` accepts header-only PNG/JPEG
  fixtures that Sharp cannot decode. A malformed payload can therefore pass validation,
  consume quota, and reach a paid provider.
- **BLOCKER — body-limit mismatch:** production installs the global 1 MB JSON parser
  before the pet-sim routes, while image validation advertises an encoded limit of 5 MB.
  Valid image requests above the global limit are rejected before route validation.
- **BLOCKER — production-app coverage:** contract tests mount `createPetSimRouter` on a
  separate Express app, so production middleware ordering and startup wiring are not
  covered. The fixed-port spawned auth test also remains a possible CI child-process
  teardown risk.

No deployment approval should be inferred from the earlier local verification while
these blockers remain open.

### Fix note — complete image decoding

- **Applied:** image validation now performs a bounded Sharp metadata check and full
  decode after the existing encoded-size, signature, container, dimension, pixel, and
  aspect-ratio checks. Multi-page inputs are rejected. Decoding finishes before
  ownership usage is incremented or a paid provider is called.
- **Tests corrected:** positive JPEG/PNG/WebP fixtures are real decodable images. The
  former header-only PNG/JPEG samples are retained as negative regression fixtures and
  must return `INVALID_IMAGE`.
- **Verification:** `npm run test:security` passes 8/8 and `npm run lint` passes.

### Fix note — production parser and contract app

- **Applied:** `server/petSimApp.ts` is now the importable production app for the
  classify, rig, and semantic-scan routes. It owns the narrowly scoped 6 MiB JSON
  envelope and mounts the shared production router. `server.ts` preserves those two
  image request streams from the global 1 MiB parser and mounts that exact app after
  constructing real provider adapters.
- **Boundary coverage:** contracts prove that a valid, fully decoded image request above
  1 MiB succeeds and that a request above the 6 MiB JSON ceiling returns a sanitized
  413 before quota or provider calls. A trailing slash receives the same parser policy.
- **Isolation coverage:** the two-user semantic-scan contract now uses the same anchor
  key for both users. Each user receives a separate first scan, and only the owner can
  reuse their cached result.
- **Verification:** production paid-route contracts pass 21/21 and TypeScript passes.

### Fix note — full-server smoke-test lifecycle

- **Applied:** `tests/auth-routes.test.mjs` now starts the repository-local `tsx`
  executable directly on a dynamically reserved port. On macOS/Linux it creates and
  terminates a process group, with bounded SIGTERM/SIGKILL fallback, so a wrapper or
  descendant cannot remain alive after the test.
- **Verification:** the focused full-server auth/route-order smoke test passes 4/4 and
  exits normally. This test intentionally binds a port because it checks assembled
  full-server startup; paid-route contracts remain entirely in-process.

### Superseding verification and remaining gates

Local verification after the fixes:

- TypeScript: pass.
- Root unit suite: 483/483 pass and exits normally.
- Dedicated AR suite: 136/136 pass.
- Image-input security suite: 8/8 pass.
- Production paid-route contracts: 21/21 pass.
- Combined coverage: 512/512 pass; 73.55% lines, 83.76% branches, 72.69% functions.
- Production build: pass; existing chunk-size warnings only.
- IFC worker: 5/5 pass with the pinned Python 3.11 requirements. The machine's default
  Python 3.14 lacks `ifcopenshell`, so `npm run test:ifc` fails unless the pinned worker
  environment is activated; this is an environment prerequisite, not a code failure.
- Dependency audit: zero vulnerabilities.
- Animator Doctor: required checks pass; Rhubarb remains optional/missing and the
  duplicate Sharp/libvips warning remains.
- Diff whitespace check: pass. The local Gitleaks binary is unavailable, so the remote
  security-scan job remains required.

The three blockers recorded at the start of this addendum are fixed locally. P0, P1,
and P2 remain **partial** under `AR_PET_SIM_HARDENING_PLAN_V2.md`; this work does not
change their completion labels. Remaining release/merge gates are a pushed fix commit,
a pull request with a fully green GitHub Actions run (including Gitleaks), and owner
configuration of `main` branch protection. Production rigging remains disabled unless
`PETSIM_RIG_ENABLED=true`; do not enable it as part of this stabilization phase.

### Remote verification note — blocker discovered

- Fix commit `de4a1a0` was pushed to `stabilize/ar-hardening-foundation` and draft PR
  [#1](https://github.com/robs46859-eng/PawsMemories/pull/1) was opened to obtain real
  GitHub Actions evidence.
- Actions run `29350629818` passed Type Check, IFC Tests, and Unit & AR Tests, but its
  Security Scan job failed. Production Build and Contract Tests were still running when
  this blocker was recorded.
- This failed check is a merge/deployment blocker until its log is diagnosed, any real
  finding is fixed without broad scanner exclusions, and a replacement run is green.

### Fix note — Gitleaks pull-request authentication

- **Diagnosed:** the Security Scan did not report a secret. `gitleaks-action@v2`
  stopped before scanning because its current release requires `GITHUB_TOKEN` for
  pull-request events.
- **Applied:** CI now grants only `contents: read` and `pull-requests: read`, then passes
  the standard ephemeral `${{ secrets.GITHUB_TOKEN }}` to the Gitleaks step. Default
  Gitleaks rules remain enabled and no path, value, finding, or fingerprint was
  allowlisted.
- **Required evidence:** the replacement GitHub Actions run must complete the actual
  secret scan successfully before this blocker is closed.

### Remote verification note — shallow-history blocker

- Replacement run `29350820825` authenticated Gitleaks, but the scanner failed closed
  after scanning zero bytes because the security job's default shallow checkout omitted
  the parent of the pull-request commit range (`50c120a^`). Its SARIF report contained
  zero findings because no repository content was scanned; this is not a green result.
- **Applied:** only the security job now uses `actions/checkout` with `fetch-depth: 0`,
  allowing Gitleaks to inspect the complete PR range. No detection rule or source path
  was excluded.
- **Required evidence:** a new run must show a completed, non-partial Gitleaks scan and
  all six CI jobs green.

### Remote verification note — blockers closed

- Commit `703dcbc` completed GitHub Actions run
  [29351042405](https://github.com/robs46859-eng/PawsMemories/actions/runs/29351042405)
  with all six gating jobs green: Type Check, Unit & AR Tests, IFC Tests, Security Scan,
  Contract Tests, and Production Build.
- The Security Scan completed `npm audit`, registry-signature verification, and a real
  full-history Gitleaks scan with default rules. It did not rely on a partial/zero-byte
  scan or a broad allowlist.
- The earlier Security Scan failures remain documented above as an audit trail. Their
  causes were missing pull-request authentication and shallow Git history; both workflow
  defects are corrected.
- GitHub's Node 20 action-runtime deprecation messages remain non-gating warnings in
  upstream `actions/*` dependencies; repository application jobs run on Node 22.

The stabilization fix set is now approved at the code-and-CI level for review. This does
not mark P0, P1, or P2 complete and does not authorize merge, production deployment, or
rigging enablement. Remaining owner actions are review/merge of draft PR #1 and enabling
`main` branch protection with the six CI jobs required and force-push disabled.

## Hermes server integration note (2026-07-15)

- Added a disabled-by-default, authenticated Hermes producer relay under
  `/api/hermes/translate`, `/api/hermes/knowledge`, and `/api/hermes/jobs/:id`.
- The integration uses local UUIDs at the API boundary and keeps edge bridge job IDs
  private in the dedicated `hermes_jobs` table. Owner-scoped lookups return the same
  404 for missing and foreign jobs.
- Requests and bridge responses use strict schemas. The edge client requires HTTPS in
  production, sends the producer Bearer secret and local UUID idempotency key, forbids
  redirects, applies a bounded timeout, and returns only sanitized failures.
- Per-user and per-IP minute limits are stacked with the existing atomic daily usage
  counter. Authentication and validation complete before daily usage or provider work.
- Added deterministic production-router contracts for auth, ownership, disabled mode,
  all minute and daily limits, provider gating, timeout/error sanitization, response
  validation, and bridge-ID non-disclosure. The focused Hermes contract file passes
  15/15 locally; broader repository verification follows separately.

### Hermes verification note

- TypeScript passes, focused Hermes contracts pass 15/15, all production-router
  contracts pass 36/36, security tests pass 8/8, and the assembled full-server auth
  smoke test passes 4/4.
- The production frontend and bundled Node server both build successfully. Vite reports
  only the repository's existing large-chunk advisory.
- The full root unit run reports 482/483 passing. Its sole failure is the pre-existing
  `tests/model-url-durability.test.mjs` assertion that expects the staged server code to
  persist `riggedGlbBase64`; the already-staged avatar change intentionally removed that
  path. Hermes does not touch that behavior, and the staged change was preserved.

### Model durability guard reconciliation (2026-07-15)

- The stale unit-test assertion above was corrected without restoring Phase 5 clip
  baking. The durability guard still rejects raw provider URL persistence and any GLB
  upload through the image uploader, and it still proves the remaining
  `buildState.riggedGlbBase64` path uses `uploadBase64Binary(...,
  "model/gltf-binary")`.
- The removed assertion required a second standalone `riggedGlbBase64` upload path that
  no longer exists after the intentional Phase 5 retirement. Requiring deleted behavior
  made a safe removal look like a regression; no production runtime behavior was changed
  by this test-only fix.
- Full verification must be rerun before deployment. Keep Hermes disabled until the
  hardened relay is live and its end-to-end smoke tests pass.

## Hermes end-to-end hardening evidence (2026-07-15)

This note appends the completed relay and Pixel evidence without changing the earlier
blocker history.

- The public relay at `https://hermes.pawsome3d.com` is healthy and uses separate
  worker, Judy, and Pawsome3D credentials. Producer cross-tenant job reads return the
  same `404` as missing jobs, and the public worker path returns `404`.
- Pause/resume, Wi-Fi loss/recovery, and severe thermal throttling were exercised on the
  Pixel. Work remained queued while the device was unavailable or thermally paused and
  completed after recovery. Pixel shell battery overrides do not propagate to Android's
  capacity API, so the battery policy remains unit-tested rather than falsely claimed as
  hardware-validated.
- Translation job `ccde7fd7-224f-43f2-9ae2-ec94c908c00b` was force-stopped while
  processing. The relay retained the lease with no result, the relaunched worker resumed
  the same job, and it completed in 9,304 ms. The production database contains one job
  row, one create event, one claim event, one completion event, and `attempt_count=1`.
- A normal post-restart knowledge job (`8ebec073-0fc8-494c-a1d9-24965ac3d712`)
  completed with grounded AR citations. The earlier oversized restart failures remain
  recorded in the worker test log; relay, Android, Paws, and Judy validation now enforce
  matching UTF-8 input budgets of 6,000 bytes for translation and 8,000 bytes for
  knowledge.
- Relay verification passes 55 tests and Ruff. A post-deployment Judy smoke job
  (`6a6cebd5-b4a8-4c6f-9dfb-a5bf63b13878`) completed successfully.
- Paws verification now passes lint, 483/483 root tests, 36/36 production contracts,
  8/8 security tests, and the production build. IFC passes 5/5 with the pinned
  requirements in an isolated Python 3.12 environment; this supersedes the earlier local
  note that referenced Python 3.11. Animator Doctor passes every required check.
- Animator Doctor still reports an optional missing Rhubarb executable and a macOS
  duplicate Sharp/libvips warning. Neither fails the required checks. Rhubarb affects
  automatic phoneme-quality lip sync only; its absence degrades to the supported
  fallback and does not block the Hermes/Paws integration.

### Remaining production enablement blockers

- Do not deploy the current dirty Paws working tree. It contains paused UI work mixed
  with the Hermes integration. Build any release from an isolated, reviewed source tree
  containing only the approved integration files.
- Before setting `HERMES_ENABLED=true`, apply `server/migrations/009_hermes_jobs.sql`
  to the production database and configure the Paws producer relay variables in
  Hostinger. Then run an authenticated owner-scoped live smoke test and confirm daily
  quota behavior.
- The signed Android release APK installs and cold-launches, but it intentionally does
  not inherit the debug app's encrypted bridge secret or selected model. The configured
  debug worker remains the validated active worker; provisioning the release package is
  a separate human-on-device production step.
- UI changes remain paused by owner direction and are outside this deployment scope.

## Signed Hermes worker scope close-out (2026-07-15)

- The owner set the stopping boundary at a privately signed Android release. The signed
  APK verifies with APK Signature Scheme v2, installed on the Pixel, and cold-launched
  without a crash.
- APK SHA-256:
  `680a4a3cfd06df7f1b3168b933d4341540c6f073c36462493df9484e5231ff6a`.
- Signer certificate SHA-256:
  `0336899672a6d12ec41e0eb876cd9b7aa084726a5b004125893b719a12a8f91a`.
- The complete signed-worker handoff is
  `/Users/robert/Projects/HermesEdgeWorker/handoff.md`.
- Paws and Judy environment provisioning, migrations, deployment, and live site smoke
  tests are explicitly deferred. `HERMES_ENABLED` remains `false`; paused UI changes
  remain untouched.
- A clean future Paws integration worktree is preserved at
  `/Users/robert/Desktop/claude7126/PawsMemories-hermes-prod`. It is uncommitted and must
  complete its remaining build/CI/live gates before deployment.

`FINAL FINISH MARKER: HERMES_EDGE_SIGNED_RELEASE_READY`

## Production Readiness Swarm Addendum (2026-07-14)

- The requested release scope now includes exact 10-second prompt-to-video outputs using
  owned models, objects, and optional BIM building models; full AR hardening with explicit
  human confirmation; production Pawprints templates/customization; global shell cleanup;
  and a complete route/action map for visible buttons and cards.
- The stabilization and hardening-plan changes are merged on protected `main` at
  `5085d0b`. The earlier branch-protection and CI owner actions in this handoff are closed.
- A first delegated P0 implementation on `swarm/p0-containment` was rejected during review
  because it replaced large production modules, mixed database access into pure guard
  configuration, broke zero-cap semantics, and did not reserve user/global capacity
  atomically. The branch is quarantined and must not be merged or cherry-picked. Canonical
  source and `main` were not modified by that patch.
- Clean isolated discovery lanes now exist for video, Pawprints/UI, and shell/release/AR
  evidence. Their output must be reviewed before implementation is accepted.
- `docs/PRODUCTION_READINESS_SWARM_PLAN.md` is the authoritative cross-workstream release
  plan. It supplements but does not weaken `AR_PET_SIM_HARDENING_PLAN_V2.md`.
- Production deployment remains on hold. `PETSIM_RIG_ENABLED=false` is mandatory, and a
  named human AR acceptance record is required before a production GO decision.

## Gemini-for-Hermes replacement (2026-07-20)

**Decision:** Hermes/Gemma replaced by Gemini for all three job types. `hermes-looks-worker/` (Outlines + Gemma 4 E2B) is no longer needed and can be decommissioned. The VPS Hermes endpoint and `HERMES_EDGE_BRIDGE_URL` / `HERMES_EDGE_PRODUCER_SECRET` configuration is not required.

**What changed:**

| File | Change |
|---|---|
| `server/hermes/gemini_adapter.ts` | **New.** `GeminiAdapter` interface + `GeminiHermesAdapter` class. `run(type, payload)` dispatches to `planLooks` / `translateText` / `answerKnowledge` via `generateContent`. |
| `server/hermes/router.ts` | `HermesRouterDeps.geminiAdapter?: GeminiAdapter` added. `createHandler` uses Gemini synchronously when bridge disabled: job created (`status=submitting`), Gemini called, result stored (`status=completed`), 202 returned with `status=completed`. GET handler restructured: terminal-cache early-return now comes before the 503 guard so completed Gemini jobs are readable when `HERMES_ENABLED=false`. |
| `server/hermes/app.ts` | Imports `GeminiHermesAdapter`, constructs it from `GEMINI_API_KEY` + `GEMINI_HERMES_MODEL` (default `gemini-2.5-flash`), passes as `geminiAdapter` dep. |

**How it works at runtime:**

`HERMES_ENABLED=false` (unchanged). Gemini adapter is active. POST to `/api/hermes/looks` (or `translate`, `knowledge`) runs the Gemini call synchronously within the request (~1–5 s), stores the result as `completed`, returns 202 with `status: "completed"`. Frontend polling with GET `/api/hermes/jobs/:id` returns the cached result immediately (no bridge round-trip needed).

`looks` result is validated against `HermesLookSpecSchema` (same as the bridge path) before storage. Gemini's `responseSchema` constrained decoding at the token level means schema mismatches are rare; the Zod gate catches any remaining edge cases.

**New env var:**

```
GEMINI_HERMES_MODEL="gemini-2.5-flash"   # optional, this is the default
```

`GEMINI_API_KEY` is already set (same key as image generation). No new credentials needed.

**Latency spike (July 9):** The GenerateContent latency increase (49 ms → 7–25 s) correlates with Hermes/Gemma installation. With the bridge disabled and Gemma no longer running, the quota contention source is removed. Monitor GCP after deploy to confirm recovery. If latency persists, investigate `gemini-2.0-flash-exp` usage in three places in `server.ts` (L2113, L3657, L3764) — this model is not in the current stable lineup and may be throttled.

**Still pending from GEMINI_CALL_AUDIT.md:**

- Fix misleading error log at `server.ts` L3762 (says `gemini-2.5-flash-image`, calls `gemini-2.0-flash-exp`)
- Replace `gemini-2.0-flash-exp` (3 uses) with stable equivalents (`gemini-2.5-flash` for text, `gemini-3.1-flash-image` for image fallback)
- Wire or delete dead `GEMINI_TEXT_FALLBACK_MODEL` env var
- Add `gemini-3.1-flash-lite-image` to image chain for Fido's Styles Draft tier (MARKETPLACE_AND_STYLES_SPEC.md Phase 6)

**MARKETPLACE_AND_STYLES_SPEC.md Phase 0 status:** Resolved. Phase 0 was "repoint Hermes at VPS worker" — superseded by this Gemini replacement. Blocking item "VPS Hermes endpoint + secret" is no longer required. Phase 1 (hero copy, featured models, Coming Soon removal) remains unblocked.
