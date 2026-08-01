# PawsMemories — First Paid Pet GLB: Full Architecture Specification (G3 → G13)

**Version:** 1.0 · **Date:** 2026-07-27
**Scope:** everything after G2. G0–G2 are complete; this specifies the remaining build-out.
**Governing decision:** Gate A / Path 1 (`docs/decisions/2026-07-27-first-sale-provider-path.md`)

> **Current release update — 2026-07-31:** this historical specification's
> mandatory customer/operator GLB review stops are superseded. The customer
> approves the generated reference set once; validated persisted GLB stages then
> advance automatically and every model version is registered in Fur Bin. Fur
> Bin Keep/Toss feedback replaces the private release gate. Validation,
> ownership, provider-handle, credit/refund, and immutable-version evidence stay
> mandatory.

---

## 0. Verification method and status

Every structural claim below was verified by reading source at the cited `file:line` on 2026-07-27. Nothing here is inferred from prior documents. Where something is genuinely unknown it is marked **OPEN** rather than guessed.

Two caveats the reader must hold:

1. **Schema version depends on merge state.** `CURRENT_SCHEMA_VERSION = 35` at `server/migrations/runner.ts:4` on `c03d963`. Migration 36 (Nurse-Saul maturity index) lives on `phase/bo-4-spatial-generator`. **Post-consolidation onto `main`, the next free migration is 37.** Verify before writing any migration.
2. **This document does not verify runtime behaviour.** It verifies structure — signatures, schemas, call sites, state transitions. Behavioural claims (does the webhook actually dedupe under concurrency?) require a live DB and are marked as such.

---

## 1. Correction to earlier review docs — read this first

`G1_REVIEW_AND_CORRECTIONS.md` and my earlier summaries stated that `/jobs/:jobUuid/review` is *customer-scoped only*. **That is incomplete and I am correcting it.**

`server/spatial-generator/service.ts:865–880`:

```ts
async reviewJob(ownerPhone: string, jobUuid: string, input: ReviewSpatialJobInput) {
  const job = await this.repo.getJobByUuid(conn, jobUuid);
  if (!job) throw new SpatialGeneratorServiceError("NOT_FOUND", ...);
  if (job.owner_phone !== ownerPhone) {
    const isAdmin = await this.isAdmin(ownerPhone);        // <-- admin bypass EXISTS
    if (!isAdmin) throw new SpatialGeneratorServiceError("FORBIDDEN", ...);
  }
  if (job.state !== "awaiting_human_review") throw ... "Job is not awaiting review";
```

So an admin **can** already review another user's job. The real gap is narrower and more precise than previously stated:

- There is **no distinction between a customer approving their own job and an operator approving on the platform's behalf**. Both take the identical code path and identical input schema.
- **The approving role is not recorded.** Nothing in the audit trail distinguishes the two.
- `isAdmin` is a boolean on `users` (`db.ts:2378–2385`, with an `ADMIN_KEY` bypass), not a role model.

This changes G6's design: it is **not** "build an authorisation check from nothing," it is "introduce an operator role distinct from `is_admin`, and record which role decided." Smaller, but subtler — an admin bypass that silently satisfies a mandatory-operator-approval requirement is worse than no check, because it looks compliant.

---

## 2. Verified baseline

### 2.1 Asset and version model — `server/assets/types.ts`

```ts
AssetRecord {
  id, asset_uuid, owner_id, asset_type, visibility, status,
  current_version_id, created_at, updated_at
}
AssetVersionRecord {
  id, asset_id, version_number, sha256, mime_type, size_bytes,
  bucket: "public"|"private", object_key, metadata: Record<string,any>|null,
  source_provider, license, commercial_use_eligible, created_at
}
AssetRelationRecord { id, parent_version_id, child_version_id, relation_type, created_at }
```

**This is a genuine immutable-version model already.** `version_number` + `sha256` + `object_key` per row, with `current_version_id` as the pointer. G5 does **not** need a second version table — a finding that materially reduces scope.

`AssetType` already includes every type this SKU needs: `model_rigged_glb`, `animation_clip`, `validation_report`, `provider_manifest`, `reference_front|left|right|back|three_quarter`, `thumbnail`, `turntable_video`. The union also ends in `| string`, so it is open — but **use the existing literals**, do not invent parallel names.

`relation_type` includes `rig`, `mesh`, `render`, `derivative` — sufficient to link a rigged GLB to its source mesh and its previews.

### 2.2 Access control and signed delivery — `server/assets/access.ts`

```ts
authorizeAssetAccess(asset, requestingUserPhone?, userIsAdmin=false): {
  allowed, reason?, isOwner, isAdmin
}
generateSignedUrlForVersion(asset, version, phone?, isAdmin=false, ttlSeconds=900): Promise<string>
```

Logic (`access.ts:13–36`): admin → allow; `visibility` public/published → allow; owner → allow; else deny.
Private bucket → `getPrivateSignedUrl(object_key, ttl)` (`storage.private.ts:298`) returning `{url, expiresAt, ttlSeconds}` via S3 `GetObjectCommand` presign.

**G7 needs no new download mechanism.** It needs: a default TTL policy for this SKU, a download-completion audit row, and a delivery-once guard.

⚠️ **Known hazard.** `server/spatial-generator/provider.ts` calls `generateSignedUrlForVersion(asset, version, undefined, true, 300)` — `isAdmin=true` hardcoded for server-to-server Layer8 calls. Any new code path must not reuse that pattern. G6's operator check must be a *separate* concern from this bypass.

### 2.3 Payments — `server/wags-v2/stripeAdapter.ts`

```ts
verifyAndNormalize(rawBody: Buffer, signature: string): Promise<NormalizedStripeEvent>
// asserts Buffer, asserts signature, then stripe.webhooks.constructEvent(...)  :214–217
// requires WAGS_STRIPE_WEBHOOK_SECRET                                          :211
// charge path passes { idempotencyKey: `wags:${input.idempotencyKey}` }        :278
```

Signature verification and Stripe-side idempotency both exist. **What is unverified: application-level replay defence** — whether a duplicate `payment_intent.succeeded` with the same event id can create two orders. Stripe's `idempotencyKey` protects *outbound* calls, not *inbound* event replay. G3 must add an inbound event-id ledger. Marked **OPEN — requires live-DB concurrency test.**

### 2.4 Reference intake — `server/reference-sessions/`

Modules: `consistency.ts`, `featureFlag.ts`, `provider.ts`, `repository.ts`, `routes.ts`, `schemas.ts`, `service.ts`, `storage.ts`, `types.ts`.

```ts
computeReportHash(payload): string                  // consistency.ts:8
evaluateReferenceConsistency(...)                   // consistency.ts:13
MIN_REFERENCE_DIMENSION_PX = 1024                   // provider.ts:6
MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024        // provider.ts:7
interface ReferenceImageProvider                    // provider.ts:10
inspectReferenceImage(...)                          // provider.ts:19
FakeReferenceImageProvider / GeminiReferenceImageProvider  // :39 / :75
isMultiviewApprovalEnabled()                        // featureFlag.ts:1
```

Produces five canonical views plus a hashed consistency report, with a fake provider for CI and dimension/size limits already enforced. **G4 is largely an extension exercise, not new construction:** add pet name, species, optional breed, optional measurements, markings notes; add the customer-facing guidance copy; bind sessions to order + generation job.

### 2.5 Generation workers — `blender-worker/server.js`

Routes present: `/health:303`, `/scene:462`, `/viewport:472`, `/execute:484`, `/viewport/angle:496`, `/undo:507`, `/checkpoint/save:517`, `/checkpoint/restore:539`, `/export-glb:539`, plus `/ifc/convert:380` and `/ifc/export:402` (BIM, frozen).

The four routes BO-4 needs already exist. Auth is `WORKER_SHARED_SECRET`, which **must be byte-identical** between the app and the Render worker.

### 2.6 State machine — `server/spatial-generator/`

`SpatialJobState` (`types.ts`): `draft | observing | planning | awaiting_math_worker | validating_math | building_draft | verifying_draft | awaiting_human_review | correction_requested | approved | finalizing | completed | failed | cancelled`.

Verified transition call sites in `service.ts`: `draft:718`, `correction_requested:793,940`, `cancelled:845`, `finalizing:923,1647`, `observing:990`, `planning:1038`, `awaiting_math_worker:1103`, `validating_math:1169`, `building_draft:1323`, `verifying_draft:1373`, `awaiting_human_review|correction_requested:1553`, `completed:1706`, `failed:1735`.

All transitions funnel through `repo.updateJobState(conn, jobId, state, extras?)` inside a connection/transaction — a single chokepoint. **This is where G3's audit row is written.** One insertion point, not fourteen.

### 2.7 Scoring — `server/spatial-generator/gent-scoring.ts` (691 lines, in-repo)

```ts
GENT_SCORING_VERSION = "pawsome.gent-scoring.v1"
computeEffectiveTemperature({samplingTemperature, uncertainty, evidenceDivergence, schemaRepairRatio})
  = 30 * clamp(0.45*t + 0.20*u + 0.20*d + 0.15*r, 0, 1)
scoreGenerativeStage(...) / createInitialEpisodeState() / validateGentReport(...)
HIGH_HEAT_THRESHOLD = 28 ; cold ≤ 4 ; favorable 16–28
penalties: −20 @6 consecutive high-heat, −10 @2 cold-stress, +20 @6 favorable
routing: ≥85 human_review ; ≥65 structured_correction ; else reject_to_planning
MATURITY_SCHEMA_VERSION = "pawsome.maturity-index.v1"
MATURITY_ROLLING_WINDOW = 5 ; MATURITY_HARD_FAIL_STREAK = 4 ; MATURITY_PREDICTIVE_LOOKAHEAD = 1
```

**Non-negotiable:** reused unmodified, new call sites only, never forked.

**Canonical-hash rule.** `computeMaturityStateHash()` originally used plain `JSON.stringify()`; MySQL JSON columns reorder keys, so the stored hash never matched after round-trip and `recordMaturityReading()` silently discarded all history — non-determinism detection and the 4-attempt hard fail never fired in production. Fixed with recursive key-sorted stringify. **Every new hash over MySQL-JSON-persisted state must use it.**

### 2.8 Migration pattern — `server/migrations/runner.ts`

```ts
{ version: 35,
  name: "spatial_attempt_idempotency_key",
  skipWhenTableMissing: "spatial_generation_attempts",
  statements: [
    `SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='...' AND COLUMN_NAME='...'`,
    `SET @stmt = IF(@col_exists = 0, 'ALTER TABLE ... ADD COLUMN ...', 'SELECT 1')`,
    `PREPARE stmt FROM @stmt`, `EXECUTE stmt`, `DEALLOCATE PREPARE stmt`,
  ] }
```

Every migration is **idempotent by information_schema guard + PREPARE/EXECUTE/DEALLOCATE**. Follow this exactly; a raw `ALTER TABLE` will break re-runs.

### 2.9 Viewer — `src/`

`src/three/AvatarModel.tsx`, `src/three/objects/SceneActorModel.tsx`, `src/animator/controller/createAnimationController.ts`, and `src/components/Avatar3DPlaypen.tsx:160,183` (`meta.animations[action]` — **named-clip selection already exists**). G7's idle/walk selector extends this rather than building a player.

---

## 3. Data model additions

### 3.1 Migration 37 — order and delivery

```sql
pet_glb_orders
  id BIGINT PK AUTO_INCREMENT
  order_uuid CHAR(36) NOT NULL UNIQUE
  owner_phone VARCHAR(32) NOT NULL
  sku VARCHAR(64) NOT NULL                    -- CUSTOM_RIGGED_PET_GLB_V1
  state VARCHAR(40) NOT NULL
  reference_session_id BIGINT NULL            -- FK reference_sessions
  generation_job_id CHAR(36) NULL             -- our provider jobId
  asset_id BIGINT NULL                        -- FK assets
  approved_version_id BIGINT NULL             -- FK asset_versions (immutable once set)
  credits_reserved INT NOT NULL DEFAULT 0
  credits_disposition ENUM('reserved','charged','refunded','none') DEFAULT 'none'
  delivered_at DATETIME NULL
  created_at / updated_at
  INDEX (owner_phone, state), INDEX (state, created_at)

pet_glb_order_events                          -- audit; written at the updateJobState chokepoint
  id, order_id FK, from_state, to_state,
  actor_type ENUM('system','customer','operator'),
  actor_id VARCHAR(64) NULL,
  reason VARCHAR(190) NULL,
  request_id CHAR(36) NULL, job_id CHAR(36) NULL,
  created_at
  INDEX (order_id, created_at)

stripe_event_ledger                           -- inbound replay defence (§2.3 gap)
  event_id VARCHAR(190) PRIMARY KEY           -- Stripe's evt_...
  event_type VARCHAR(80), order_id BIGINT NULL,
  processed_at DATETIME NOT NULL
  -- INSERT IGNORE / ON DUPLICATE KEY => second delivery is a no-op

provider_generation_jobs                      -- G3 entry gate: durable ProviderJobStore
  job_id CHAR(36) PRIMARY KEY
  order_id BIGINT NULL
  provider_id VARCHAR(40), provider_version VARCHAR(80)
  provider_task_handle VARCHAR(190)
  model VARCHAR(120), config_hash CHAR(64)
  cancelled TINYINT(1) NOT NULL DEFAULT 0
  glb_url TEXT NULL                           -- INTERNAL ONLY, never serialised outward
  created_at, updated_at
  INDEX (order_id), INDEX (provider_task_handle)
```

### 3.2 Migration 38 — SALTI forward-compatibility (columns now, populated at G10)

Per §4B.1 of the agent prompt — added early because a later migration on a populated table costs far more than three unused columns:

```sql
ALTER TABLE asset_versions
  ADD COLUMN salti_condition JSON NULL,        -- per-channel results
  ADD COLUMN salti_damage    JSON NULL,        -- persistent defect state
  ADD COLUMN salti_margin    DECIMAL(6,3) NULL -- signed; worst critical margin
```

**Resolving the carried-forward `salti_margin` type question:** the earlier proposal was `VARCHAR(20)`. **Reject it.** Margin is signed and numerically compared (`< 0` blocks readiness); a string column forces lossy casts in every query. Use `DECIMAL(6,3) NULL`, where `NULL` means `UNMEASURED`. `salti_condition`/`salti_damage` are structured per-channel and belong in JSON — and any hash over them uses the canonical stringify (§2.7).

---

## 4. G3 — Order state machine, payments, durable job store

**Entry gate:** replace `InMemoryJobStore` with `MySqlProviderJobStore implements ProviderJobStore` against `provider_generation_jobs`. The interface already exists (`server/pet-generation/provider.ts`); the adapter requires **no change** — that was the point of the seam.

### 4.1 State mapping

Reuse `SpatialJobState` names where semantics match; add order-level states it lacks. Generation sub-states (`observing`…`verifying_draft`) stay internal and are **not** exposed as order states.

| Order state | Source |
|---|---|
| `draft`, `cancelled`, `failed`, `approved`, `completed` | exist |
| `awaiting_human_review` → operator queue | exists |
| `correction_requested` → repair | exists |
| `awaiting_payment`, `paid`, `awaiting_references`, `references_received`, `queued`, `generating`, `validating`, `repair_required`, `delivering`, `delivered`, `refund_pending`, `refunded` | **new** |

### 4.2 Invariants (each maps to a test)

1. Only a signature-verified webhook sets `paid`. `verifyAndNormalize` (`stripeAdapter.ts:214`) is the sole entry.
2. Inbound replay is a no-op via `stripe_event_ledger` PK.
3. `generating` unreachable unless `paid` **and** references complete.
4. Retry reuses `generation_job_id`; never re-charges.
5. `approved_version_id` is write-once — enforce with a guard *and* a DB-level check (application-only enforcement has failed in this repo before).
6. `delivered_at` write-once → delivery-exactly-once.
7. Every transition writes `pet_glb_order_events` **inside the same transaction** as the state change, at the `updateJobState` chokepoint (§2.6).

---

## 5. G4 — Reference intake

Extend `server/reference-sessions/`. Reuse `inspectReferenceImage`, `MIN_REFERENCE_DIMENSION_PX`, `MAX_REFERENCE_IMAGE_BYTES`, `evaluateReferenceConsistency`, `computeReportHash`, and `FakeReferenceImageProvider` for CI.

Add: `pet_name`, `species`, `breed?`, `shoulder_height_mm?`, `body_length_mm?`, `markings_notes?`; link session → order → job; store references as `assets` rows with the existing `reference_*` types, private bucket, `sha256` preserved.

**Mandatory disclosure copy** — full pet visible; consistent lighting; no filters or motion blur; show distinctive markings; measurements improve scale confidence; hidden anatomy and exact dimensions cannot be reliably inferred from photographs; **an operator reviews before delivery**.

⚠️ **Path 1 truth-in-advertising.** `server/model-builds/provider.ts:100–110` maps five views onto Tripo's four slots and **drops `three_quarter`** ("Tripo has no fifth slot"). Five are collected; four reach the model. The UI must not claim otherwise. Resolved at G12.

---

## 6. G5 — Generation, validators, GENT

Pipeline: references → evidence manifest → reconstruction → scale/axis normalisation → cleanup → topology repair → UV/material → rigging → skin weights → idle → walk → contact/root-motion → GLB export → parse validation → GENT → bounded repair → operator review.

**Deterministic work belongs to Blender/geometry/rigging/animation solvers, never to an LLM.** Advisory stages are observe/plan/verify only. No sampling-temperature variance in any deterministic stage — that is `MATH_NONDETERMINISM_DETECTED`, a hard fail, not a tunable.

### 6.1 Validators → future SALTI channel (tag at write time, §4B.3)

| Validator | Channel | Critical |
|---|---|---|
| GLB parses; scene/mesh/materials resolve; buffers+textures resolve | X | ✔ |
| Skin exists; skeleton nodes exist | S/R | ✔ |
| Idle clip exists; walk clip exists; targets resolve; names stable | A | ✔ |
| Production viewer loads the exact stored file | X | ✔ |
| Vertex/triangle counts, bounds, orientation, ground plane | T/P | — |
| Degenerate faces, invalid normals, non-manifold, self-intersection | T | ✔ (manifold) |
| Required quadruped joints per `bonemap.json`, bind pose, normalised weights, max influences, no major unweighted region, pose-test no collapse | R | ✔ |
| Walk does not catastrophically distort; foot-contact/sliding where supported | A/P | ✔ |
| Approved hash == delivered hash == downloaded hash | Z | ✔ |
| Provenance complete | Z | ✔ |

**`UNMEASURED` is a first-class value, never a number, never a zero.** This single rule is what makes G10 trustworthy.

### 6.2 Hard gates — B-HDSR precursor

Each failure mode is an **independent named boolean evaluated outside any aggregate**: invalid GLB · empty mesh · missing skeleton · broken weights · missing idle · missing walk · catastrophic deformation · severe contact failure · missing textures · broken authorisation · missing provenance. G11 promotes these to `min()` over normalized critical channels — a refactor, not a rewrite.

### 6.3 Repair

Reasons: `GEOMETRY_SCALE`, `GEOMETRY_PROPORTION`, `REFERENCE_MISMATCH`, `TOPO_NONMANIFOLD`, `TOPO_DEFORMATION`, `MATERIAL_UV`, `RIG_HIERARCHY`, `RIG_WEIGHTS`, `ANIM_RETARGET`, `ANIM_CONTACT`, `EXPORT_INVALID`, `REPEATED_UNKNOWN`.

Each repair: preserve failed version → record reason → specialist module → **new `asset_versions` row** (never mutate) → rerun affected + critical downstream validators → compare before/after → revert unacceptable cross-channel regression → increment strategy/reason/asset counters → escalate at limits. **No success credit without measured improvement. Internal repairs never re-charge.**

---

## 7. G6 — Operator console and approval

**Build the role first** (§1). `is_admin` is not an operator role, and the existing admin bypass in `reviewJob` must not be allowed to satisfy the mandatory-approval requirement by accident.

- Add `users.is_operator` (migration 39) or an explicit role table. Do **not** overload `is_admin`.
- New route, distinct from `/jobs/:jobUuid/review`: operator decisions never share a path with customer review.
- Record `actor_type='operator'` and `actor_id` in `pet_glb_order_events`.
- Approval binds **one** `approved_version_id` and records operator id, version id, timestamp, decision note, validation report id, file hash, audit event.
- Automation may reach `awaiting_human_review` and **never** `approved`/`delivered`.

Extend `MarketplaceAdminScreen.tsx` / `WagsAdminPanel.tsx` / `AdminRequestPanel.tsx`. Queue: order, customer, pet, payment state, current state, candidate version, preview, worst failing gate, GENT routing+score, repair attempts, queue age, priority. Detail adds: requirements, references, measurements, turntable, wireframe, skeleton, idle playback, walk playback, validation report, GENT results **including every `UNMEASURED`**, repair history, hash — and approve / reject / request-repair / refund-escalate.

---

## 8. G7 — Checkout, gallery, delivery

Pricing **unchanged**: credits, `baseCredits * viewMultiplier` (`spatial-generator/service.ts:~617`), reserve/charge/release lifecycle as-is. Physical goods stay server-owned via `PAWPRINT_PRINT_PRODUCTS_JSON` (`server/pawprintProducts.ts`).

Delivery: `generateSignedUrlForVersion(asset, version, phone, false, TTL)` — **`isAdmin=false` on every customer path.** Gallery item points at `approved_version_id`; idle/walk selection extends `Avatar3DPlaypen.tsx:160,183`. Never expose bucket paths or permanent public URLs. Never show unapproved candidates.

Funnel events (no private images in payloads): `product_viewed`, `checkout_started`, `payment_succeeded`, `references_completed`, `generation_started`, `validation_completed`, `operator_review_started`, `operator_approved`, `asset_delivered`, `download_completed`, `refund_requested`, `refund_completed`. **Tag and exclude internal smoke transactions from revenue.**

---

## 9. G8 — Observability and CI

Metrics: orders by state · payment failures · generation duration · worker failures · validation failures by reason · repair success by reason · attempts per asset · operator queue age · approval/rejection rate · delivery failures · download failures · refund rate · cost per approved model · provider resolution counts · **third-party generation-API invocations for this SKU (budgeted + alarmed under Path 1; must reach zero at G13)**.

CI gate on the pinned Node (`>=24.15 <25`): `npm test` (`tsx --test tests/*.test.mjs`), `npm run lint` (`tsc --noEmit`), `node scripts/build.mjs`, migrations, health, gitleaks. Close the sandbox-only gaps in `phase-evidence/BO_4_THERMAL_CASCADE.md` §15 on a real runner.

---

## 10. G9–G11 — SALTI and B-HDSR

**G9 (spec only).** Channel definitions G/T/P/S/M/R/A/X/Z; normalization with stated range and failure floor per validator; damage-vs-condition semantics (when damage sets, whether it can clear — a defect that silently heals hides regressions); margin sign convention stated once; cross-channel regression detection; evidence confidence bounding reference-dependent channels (G, P) by view count and image quality; explicit relationship to GENT; v1 non-goals.

**G10 (implementation).** New `server/salti/`, alongside `gent-scoring.ts`, never forking it. Populate the migration-38 columns. Backfill historical versions as `UNMEASURED` — **never invent retroactive scores.** `salti_report_hash` via canonical stringify with a live-MySQL round-trip test (§2.7).

**G11 (B-HDSR).** `critical_readiness = min(normalized_result for each ACTIVE CRITICAL channel)`. That is the entire software contribution — **do not port beaver-dam hydraulic equations.** It **blocks only**; it can never approve, never shorten review, never override the human gate. `UNMEASURED` on a critical channel blocks.

---

## 11. G12 — Organic cascade (Tripo replacement)

Phases 2–3 of `IN_HOUSE_3D_CASCADE_PHASED_PLAN.md`; largest unscoped body of work. Spec (`ORGANIC_CASCADE_ARCHITECTURE_SPEC.md`) approved before code.

1. Observation reuses `server/reference-sessions/`.
2. **Rigged base-template mesh library** by species / breed-size class — the deterministic backbone, since no solver generates arbitrary organic meshes. A content-creation task requiring its own ownership and rig contract (`bonemap.json` conventions).
3. Plan stage proposes **deformation parameters** (limb ratios, torso/muzzle scale, ear category, coat length), schema-constrained — never a free-form mesh.
4. Deterministic deform stage: compiled allowlisted Blender program, same input → same output.
5. Verify: visual comparison plus `PAWSOME3D_REDRESS_PLAN.md` §5.4 rig gates promoted to mandatory.
6. **Texture/fur — the genuinely open question.** Decide procedural+photo-projection vs. generative, and state determinism/hash implications.
7. `gent-scoring.ts` and `server/salti/` reused unmodified.
8. Explicit v1 non-goals.

Gated by `INHOUSE_ORGANIC_GENERATOR_ENABLED`, never sharing the accessory flag. **Exit:** a real pet job passes the same G5 validators and G10 SALTI scoring Tripo output passes, side-by-side, plus a Tripo-isolation test.

---

## 12. G13 — Cutover and complete Tripo removal

1. Shadow mode, compared **channel-by-channel via SALTI**, not on aggregate or impression. Owner sign-off.
2. Cut over — should be a **config change** because of G2's boundary. If it is not, stop and report: that is a late-surfacing G2 violation and important information.
3. Remove: `tripo.ts`; `TripoModelBuildAdapter`; `server/pet-generation/tripoAdapter.ts`; the six `startImageTo3D()` and three `pollImageTo3D()` call sites in `server.ts`; `startRig`, `pollTripoTask`, `isTripoInsufficientCredit`, `isTripoHandle`; `TRIPO_API_KEY` from `.env.example` and all deploy configs; references in `rigBudget.ts`, `textureLikeness.ts`, `petRig.ts`, `legacy-asset-registration.ts`, `snapgen.ts`, `avatarPrompts.ts`, `agent/graph/nodes/act.ts`, `scripts/manual/*`.
4. Legacy orders: migration, not deletion. A read-only legacy adapter may survive **only** to inspect historical orders — disabled for new orders, with a test proving it cannot be selected.
5. Remove the Tripo COGS line; update pricing/marketing copy.
6. Remove the legacy Furball3D flow and superseded rig fallbacks.
7. Honest `handoff.md` / `README.md`, including what remains genuinely unsupported.

**Definition of done, no substitutions:** `grep -ri tripo` across live code (excluding `phase-evidence/`, `handoff.md`, `docs/`) returns **zero**, pasted with empty output; a real user-facing generation completes with **zero external 3D-provider calls**, evidenced by network trace; full CI green on `main`.

---

## 13. Open items and risks

| # | Item | Status |
|---|---|---|
| 1 | Inbound Stripe replay defence unproven under concurrency | **OPEN** — needs live-DB test (§2.3) |
| 2 | `MySqlProviderJobStore` | **G3 entry gate** — in-memory store loses paid jobs on restart |
| 3 | Operator role vs. `is_admin` bypass in `reviewJob` | **G6 blocker** (§1) |
| 4 | Appendix A accumulator review (`adjustmentAccumulator` vs `cumulativeIndex`) | **still owed**, twice inferred, never read from source |
| 5 | `salti_margin` type | **RESOLVED here** → `DECIMAL(6,3) NULL` |
| 6 | Layer8 spatial endpoints undeployed; B2 creds; worker secret parity | blocks in-house path, not Path 1 |
| 7 | Fur/texture replacement | **OPEN** — highest-risk unscoped item in the programme |
| 8 | `three_quarter` collected but unconsumed | Path 1 limitation; disclose, resolve at G12 |
| 9 | G0.5 "Adapt" test rows matched by filename only | confirm before planning against them |
| 10 | Schema version depends on merge state (35 vs 36) | verify before writing migration 37 |
