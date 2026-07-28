# PawsMemories Final Build-Out Architecture

Status: controlling specification for the final phased build-out
Date: 2026-07-23
Owner surfaces: pawsome3d.com · repo `robs46859-eng/PawsMemories` · gateway `robs46859-eng/layer8`
Companion documents: `INHOUSE_SPATIAL_GENERATOR_ARCHITECTURE.md` (controlling for the
accessory/hard-surface generator), `PHASED_IMPLEMENTATION.md` (historical phase tracker),
`handoff.md` (release history), `PRINT_FULFILLMENT.md`, `MARKETPLACE_CUSTOMIZER_SPEC.md`,
`WARDROBE_WAGS_AND_TEXTURIZER_SPEC.md`.

> Note on `ARCHITECTURAL_REVIEW.md`: that document describes PostgreSQL/Redis/JWT-HS256
> infrastructure that does not match this repository (the app is MySQL 8.4 on Hostinger,
> no Redis, schema-ledger migrations in `server/migrations/`). Treat it as non-controlling
> background. Everything in THIS document was verified against the working tree.

---

## 1. Executive Summary

Five outcomes define "done" for this build-out:

1. **A model a customer pays for always lands in their profile** — durable,
   server-authoritative completion; no fire-and-forget in-process builds.
2. **Printful products are authored visually and appear in the shop** — the admin never
   types a Printful ID; buyers see and can order every published product.
3. **Wags boxes deliver real generated content** — the Gemini plan materializes into
   actual sticker PNGs, pawprint art, and (later) generated 3D accessories/minimodels,
   not text rows and color-matched picks from a small static catalog.
4. **Facial rigging is real** — measured Blender-worker blend shapes and jaw/blink
   deformation via the already-built Phase-4 rig pipeline, not renamed provider morphs.
5. **Tripo3D receives zero calls** — accessories/hard-surface via the in-house spatial
   generator (Layer8-fronted), organic pet/human reconstruction via a self-hosted GPU
   reconstruction worker, and the whole stack exposed as a hostable API for enterprise
   and big-box retail tenants.

The build proceeds in nine phases (BO-0 … BO-8, §10) so revenue-critical bugs ship first
and the Tripo replacement lands on proven contracts. Each phase has an exit gate and a
copy-paste coding-agent prompt (§12).

---

## 2. Verified Current-State Findings

### 2.1 Bug 1 — 3D model not saved to profile after image approval

There are **three parallel create paths**, each with different persistence semantics:

| Path | Entry | Completion driver | Loss points |
|---|---|---|---|
| Legacy avatars | `POST /api/avatars` → `GET /api/avatars/:id/status` (`server.ts:4361`) | **Client polling.** When Tripo reports done, the status GET spawns a fire-and-forget in-process pipeline (`server.ts:4436`) | User closes tab → nothing advances until reaper fails it. Process recycle mid-build → model never saved; `resumeStalledBuilds` (`server.ts:4316`) restarts from Tripo (re-spend), 45-min reaper is the backstop |
| Create pipeline | `POST /api/create-pipeline/approve` (`server.ts:6676`) → `generation_jobs` row | Client poll of `/api/jobs/:id` (`server.ts:7071`) **plus** a 60s background sweep (`server.ts:7238`) | Model stored to `creations.model_url` first (good), but when rigging was purchased, `finishStoredPipelineModel` (`server.ts:208`) hands off to the Blender-worker rig stage — worker down/misconfigured → attempt failures the profile UI shows only as a perpetual "Building" card; no canonical asset registration; SMS is the only success signal |
| Durable V3 | `server/model-builds/` state machine, migration 22 | Server-authoritative leases, atomic billing, hash-bound acceptance | **Dark** (`MODEL_BUILD_V3_ENABLED=false`), never wired to the Create UI |

The architectural defect is that the correct machine (V3) exists but the live product runs
the two fragile paths. Fix: converge on the durable machine (§4).

### 2.2 Bug 2 — Printful products invisible after adding; unknown product IDs

Everything server-side exists and **no frontend consumes any of it**
(`grep -r customizer src/` returns nothing):

- Catalogue browse routes: `GET /api/admin/customizer/products`, `.../variants`,
  `.../template` (`server.ts:2957-3001`) backed by `server/printfulCatalog.ts`
  (search by title, variant list, authoritative print-file px/DPI per placement).
- Admin CRUD: `POST/GET /api/admin/customizer/customizable-products`
  (`server/customizerCheckout.ts:165,208`).
- Tables: `customizable_products`, `customize_orders` (`db.ts:1559,1583`).
- Buyer checkout: `POST /api/customize/checkout` (`server/customizerCheckout.ts:264`).

So "adding a product" today writes a row that nothing renders, and the admin API expects
raw `printful_product_id`/`printful_variant_id` integers the owner has no way to know.
Fix (§5): an admin picker UI that browses the catalogue **by name and thumbnail** and
auto-fills every ID and print-file dimension, plus a Shop surface and buyer customizer.
Related known gap from `wags.md`: marketplace digital checkout creates orders with no
Stripe session (`checkoutDigital()` returns no `checkout_url`) — closed in the same phase.

### 2.3 Bug 3 — Wags not wired with intelligence

`server/wags/planner.ts` produces a rich Gemini plan (theme, per-slot items, colors,
history-aware). But `server/wags/delivery.ts` materializes it as:

- accessory slots → nearest **color match** from the small static `WAGS_EXCLUSIVE_CATALOG`;
- `credit_pack` → +20 credits;
- **everything else (stickers, seasonal, minimodel, pawprint) → a text-only
  `box_items` row.** No sticker PNG, no pawprint art, no 3D object is ever generated.

The intelligence exists only on paper. Fix (§6): a per-slot **materializer** that
generates real assets (Gemini image gen for 2D slots now; the in-house spatial generator
for 3D slots once it ships), stored as canonical private assets and rendered in the Wags
inbox. Admin review stays before delivery. Stripe price IDs checklist from `wags.md`
remains a deployment gate.

### 2.4 Bug 4 — Facial rigging isn't real

The live build pipeline's "facial rig" (`agent/graph/nodes/facialVisemes.ts`) only
**renames/copies provider-authored shape keys** into the A–X viseme contract and states
"Never fabricate a mouth shape." Tripo GLBs ship with no shape keys, so every production
model degrades to the jaw-bone fallback in `agent/graph/nodes/act.ts`. Meanwhile the real
implementation — `server/rig-pipeline/` (Phase 4, migration 23/25): semantic facial
targets A–H/X + jaw + bilateral blink with **measured deformation/locality/reopen
evidence** via the authenticated Blender worker — is dark
(`RIG_PIPELINE_V4_ENABLED=false`) and deliberately terminates with
`RIG_WORKER_NOT_INTEGRATED`. Fix (§7): integrate the worker adapter, run the acceptance
fixtures, enable the flag, and route Create-flow rigging purchases through it
(this also removes the `startRig` Tripo call).

### 2.5 Complete Tripo call-site inventory

All Tripo traffic flows through `tripo.ts` (`api.tripo3d.ai/v2/openapi`):

| Call site | Purpose | Replacement lane |
|---|---|---|
| `server.ts:4274,4347,4612` (legacy avatars start/resume/retry) | image→3D organic | Reconstruction worker (§8) |
| `server.ts:4377` + poll loops `7030,7118,7309` | task polling | internal job status |
| `server.ts:6746` (create-pipeline approve) | image→3D organic | Reconstruction worker |
| `server.ts:6839` (`/api/create-3d-model`) | image→3D | Reconstruction worker |
| `server.ts:6975` (`/api/image-to-3d`) | image/multiview→3D | Reconstruction worker; accessory/hard-surface subjects → in-house spatial generator |
| `server.ts:4957` (`startRig` in create pipeline) | provider rigging | Phase-4 rig pipeline (§7) |
| `server/petRig.ts` | pet-sim rig (disabled, `PETSIM_RIG_ENABLED=false`) | Phase-4 rig pipeline or removal |
| `server/model-builds/provider.ts` `TripoModelBuildAdapter` | dark V3 provider | new `ReconModelBuildAdapter` behind the same `ModelBuildProvider` port |

The `ModelBuildProvider` port in V3 is the correct seam: the cutover is an adapter swap,
not a rewrite — one more reason BO-0 converges the product onto V3.

### 2.6 Resolved design conflict: the spatial-math executor

`INHOUSE_SPATIAL_GENERATOR_ARCHITECTURE.md` assigns `spatial.math.v1` to Gemma on the
Pixel via a VPS Hermes workspace. But `handoff.md` (2026-07-20) records that
**Hermes/Gemma was decommissioned and replaced by Gemini**, and the in-house doc itself
makes deterministic recomputation the acceptance boundary — every Gemma number is
recomputed and rejected on >0.05 mm mismatch, meaning the LLM adds no authority.

**Decision for this build-out (recommended default):** implement `spatial.math.v1` as a
**deterministic server-side solver** (pure TypeScript: normalized-size × envelope,
position × half-envelope, bounds, volume — the exact formulas the validator already must
implement). The Layer8 operation contract is unchanged; its executor is pluggable, so the
Pixel/Gemma worker described in the in-house doc can be added later as an alternative
executor without touching any consumer. This removes a physical Android availability
dependency from the revenue path while honoring every contract, gate, and schema in the
controlling generator spec.

---

## 3. Target System Topology

```text
Browser (customer)            Enterprise / big-box tenant systems
   |                                   |
   v                                   v
Hostinger app (Express + MySQL) — durable jobs, credits, canonical assets, review gates
   |            \
   |             \-- Partner API surface (/api/partner/v1/*) — §9
   v
Layer8 AI control plane (robs46859-eng/layer8) — tenant auth, pinned roles, quotas, audit
   ├─ spatial.observe.v1   → Gemini Vision (reference observation)
   ├─ spatial.plan.v1      → OpenAI Responses (declarative construction plan)
   ├─ spatial.math.v1      → deterministic solver (Pixel/Gemma optional later)
   ├─ spatial.verify.v1    → Gemini Vision (draft adherence report)
   └─ spatial.reconstruct.v1 → GPU reconstruction worker (organic image/multiview→3D)
   |
   ├─ Render Blender worker (existing; draft/final builds, rig pipeline, print prep)
   ├─ GPU reconstruction worker (new; self-hosted open-weights image→3D)
   └─ Backblaze B2 private/public buckets (canonical asset registry)
```

Rules carried over from the in-house doc and repo conventions:

- Layer8 pins each operation to its provider; **no silent model fallback**; provider
  outage returns a stable retryable error.
- GLB/STL/renders never traverse the inference gateway; Blender and the reconstruction
  worker are called by the app with dedicated shared secrets.
- PawsMemories stays authoritative for workflow state, credits, hashes, artifacts,
  lineage; Layer8 audit IDs correlate, never replace, local records.
- Every feature ships default-off behind a server-authoritative flag with
  `phase-evidence/` records before enablement.

---

## 4. Workstream A — Durable Model Persistence (Bug 1)

### 4.1 Immediate hardening (BO-0, part 1)

1. **Server-authoritative completion for the legacy paths.** The `generation_jobs`
   sweep (`server.ts:7238`) already exists; extend the same treatment to the legacy
   avatars path or (preferred) stop creating new legacy-path builds entirely and route
   `POST /api/avatars` 3D generation into the create-pipeline job machinery. No path may
   depend on a browser poll to persist a paid artifact.
2. **Post-store failure isolation.** A rig-stage failure after the static GLB is stored
   must resolve the job as `done_static_fallback` **visible to the user** (model in
   profile, rigging refunded per the existing idempotent refund markers) — never a
   terminal "Building"/failed card with a stored model behind it.
3. **Canonical registration.** Every finished GLB registers in the Phase-1 canonical
   asset registry (`server/assets/`) with lineage (source image → reference views →
   provider task → GLB). FurBin/profile listing reads one endpoint that unions creations
   with canonical assets; no orphaned URLs.
4. **Truthful status.** `/api/creations` rows expose `billingDisposition` and a
   sanitized `failure_code` so the UI can say "Model ready (rigging refunded)" instead
   of spinning forever.
5. **Diagnosis capture.** Add an append-only `model_persistence_events` audit (or reuse
   `spatial_generation_events` conventions) so the next "it didn't save" report is
   answerable from the DB in minutes.

### 4.2 Strategic convergence (BO-0, part 2)

Wire the Create flow to the **durable V3 model-builds machine** (`server/model-builds/`),
which already has: draft→…→accepted state machine, leases, atomic billing, provider
port, GLB validation, hash-bound acceptance, recovery worker, and a mounted router.
Work remaining is integration, not construction:

- Frontend: point the Create build/review screens at `/api/model-builds` (API client
  functions already exist in `src/api.ts`).
- Preflight: consume the Phase-2 approved reference manifest when multiview approval is
  enabled; single-reference mode otherwise.
- Migration: keep legacy rows readable; new builds only on V3. Retire
  `resumeStalledBuilds` and the in-process `runBuildPipeline` invocation from the
  status route once V3 is live.
- Enable `MODEL_BUILD_V3_ENABLED=true` only after the BO-0 exit gate (§10).

Migration number: **32** (31 stays reserved for the spatial generator) — only if new
columns are needed; prefer zero-schema changes in BO-0.

---

## 5. Workstream B — Printful Customizer Surfaces (Bug 2)

### 5.1 Admin: visual product authoring (no raw IDs, ever)

New `CustomizerAdminScreen` (admin-gated like `MarketplaceAdminScreen.tsx`):

1. **Catalogue browser** — search box → `GET /api/admin/customizer/products?q=` →
   thumbnail grid (title, brand, type, variant count). Click → variant list with
   size/color chips and Printful base cost.
2. **Template editor** — selecting a variant calls
   `.../variants/:variantId/template`, which returns the authoritative placements and
   print-file px/DPI (`getTemplateContext`). Admin drags/resizes the placement box on
   the product mockup; box coords stored normalized (matches `customizable_products`
   columns). Retail price field shows computed margin vs. Printful base cost and blocks
   negative margin.
3. **Publish** — status `draft → published`. The row carries the IDs; the admin only
   ever saw names and pictures.
4. Fix noted upstream bug: `POST /api/print-uploads` must pass the real image MIME
   (currently defaults to `model/gltf-binary` — see `MARKETPLACE_CUSTOMIZER_SPEC.md` §1).

### 5.2 Buyer: shop surface and customizer

1. `GET /api/customize/products` (new, public, published-only) feeding a "Custom Prints
   & Gear" section in `MarketplaceScreen.tsx` (or Shop route) — card per published
   product with mockup, price, "Customize" CTA.
2. `CustomizeScreen`: pick photo (upload or FurBin), position inside the placement box
   (reuse the `PawprintsStudio.tsx` compositor primitives), live preview, checkout via
   existing `POST /api/customize/checkout` → Stripe → webhook confirms the Printful
   draft (the draft-then-confirm lifecycle in `server/printful.ts` is already correct).
3. Order visibility: customize orders appear in FurBin order history with provider
   tracking, same as pawprint print orders.

### 5.3 Same phase: close the marketplace digital-checkout gap

`checkoutDigital()` in `marketplacePublic.ts` must create the Stripe Checkout session,
persist `stripe_session_id`/`checkout_url`, and grant the entitlement on the verified
webhook — copy the existing pattern from the credits/prints call sites. Decision
defaults (changeable by owner): one-time payments (no Connect) and entitlement grant on
`checkout.session.completed`.

Migration number: **33** if customizer tables need managed-migration adoption or new
columns (they are currently created ad-hoc in `db.ts`; adopt them into the ledger
without altering historical checksums).

---

## 6. Workstream C — Wags Intelligence (Bug 3)

### 6.1 Slot materializers (BO-3)

Delivery becomes plan → **assets**, executed at admin-approval time (keeps the human
gate; generation cost incurred only for approved boxes):

| Slot | Materializer | Output |
|---|---|---|
| `sticker_1..5` | Gemini image gen (existing chain) with transparent-background prompt + server-side background verification; 1024×1024 PNG | Canonical private asset per sticker, rendered in Wags inbox, downloadable |
| `pawprint` | Server-side render through the existing Pawprints template pipeline using the plan's theme + pet photo | 2400×3000 pawprint master in FurBin + inbox |
| `seasonal` | Gemini image gen themed collectible card/art | Canonical asset in inbox |
| `accessory*` | Near-term: keep catalog matching but grow `WAGS_EXCLUSIVE_CATALOG` monthly via authored GLBs. Post-BO-5: in-house spatial generator job (`subject_kind=accessory`, attachment interface from the pet's rig contract) with admin approving the draft render as part of box review | Wearable GLB granted to wardrobe |
| `minimodel` | Post-BO-5: spatial generator `hard_surface` job (toy/food/furniture prompts from the plan) | Prefab GLB granted; near-term from a curated prefab library |
| `credit_pack`, `video_gen`, `restyle` | Already-functional entitlements | unchanged |

Rules: materialization is idempotent per `(box_id, slot)`; a failed slot regenerates
without re-granting others; the box cannot reach `delivered` with missing paid slots;
all generated assets are private canonical assets with lineage to the plan hash.

### 6.2 Deployment gates (from `wags.md`, still owner actions)

Four Stripe price IDs in env (`WAGS_BASIC_MONTHLY_PRICE_ID` … `WAGS_PLUS_ANNUAL_PRICE_ID`),
cron for plan generation on the 1st, admin review panel, then `WAGS_V2_ENABLED`
per the Phase-7 acceptance items in `PHASED_IMPLEMENTATION.md`.

Migration number: **34** (`wags_box_item_assets` or added columns on
`wardrobe_wags_box_items` for asset UUID/version references + materialization state).

---

## 7. Workstream D — Real Facial Rigging (Bug 4)

1. **Integrate the Phase-4 worker adapter** (`server/rig-pipeline/worker.ts`): deploy
   the Blender-worker rig endpoints on Render, authenticate with the existing
   `WORKER_SHARED_SECRET` conventions, and remove the deliberate
   `RIG_WORKER_NOT_INTEGRATED` termination only when the worker round-trip passes
   fixtures.
2. **Acceptance fixtures** (per `PHASED_IMPLEMENTATION.md` Phase-4 exit): representative
   human/quadruped/accessory fixtures on Render; measured deformation, locality, and
   reopen checks; animation inspection; slicer output for the fused print derivative.
3. **Enable** `RIG_PIPELINE_V4_ENABLED=true` after evidence; record in
   `phase-evidence/PHASE_4.md`.
4. **Route the product through it**: Create-flow rigging purchases
   (`pipelineRiggingSelection`) call the internal pipeline instead of Tripo `startRig`
   (`server.ts:4957`); the viseme-rename script in `agent/graph/nodes/facialVisemes.ts`
   is demoted to an explicit "provider morph passthrough" step that runs **in addition
   to**, never instead of, worker-synthesized targets.
5. **Truthful capability badges**: facial capability displays only with measured
   deformation evidence (already the Phase-4 rule — keep it).

Pet visemes: quadrupeds get the reduced set (jaw + A/D/E/F/X + blink) per the rig
contract in `skeletonContract.ts`; humans get the full A–H/X set. Voice Test and the
animator L2 face layer consume the same canonical target names — no renames downstream.

---

## 8. Workstream E — Tripo Removal

### 8.1 Lane 1: accessories & hard-surface (BO-4/BO-5)

Implement `INHOUSE_SPATIAL_GENERATOR_ARCHITECTURE.md` exactly as written (its Phases
0–6 map to BO-4/BO-5 here), with the single §2.6 amendment: `spatial.math.v1` executes
on the deterministic server solver first; the Hermes/Pixel lane is an optional future
executor. Everything else — migration 31 schema, state machine, hash-bound review,
deterministic compiler, Blender draft/final, licensing, billing — is unchanged and
controlling. Load `SPAT-007`/`SPAT-008` skills before touching Layer8 or licensing.

### 8.2 Lane 2: organic pet/human reconstruction (BO-6)

Replace Tripo's mesh generation with a **self-hosted reconstruction worker**:

- **Subject taxonomy (canonical, new).** The current app knows only
  `dog | human | object` (`db.ts:2445`). The reconstruction contract adopts a
  four-value canonical `subjectClass` that every lane, rig profile, and acceptance
  corpus keys off:

  | subjectClass | Meaning | Rig profile | Triage rules |
  |---|---|---|---|
  | `pet` | Real animal (quadruped/winged/other, species from triage) | quadruped/species contract, reduced viseme set | existing pet triage |
  | `human` | Real-person likeness from photos | full biped, A–H/X + blink, finger-rig hints | strict full-body framing gates (fail closed on crop) |
  | `humanoid` | Stylized human-like character — mascots, cartoon/anthro figures, toys with arms/legs | full biped contract, but likeness triage relaxed (no real-person identity claim) | full-body framing required; anatomy-anomaly checks advisory, not fatal |
  | `object` | Inanimate, no rig | none (static, placement profile) | existing object triage |

  Legacy `avatar_type` values map 1:1 (`dog`→`pet`, `human`→`human`,
  `object`→`object`); `humanoid` is user-selectable at create time and is the correct
  class for big-box/enterprise mascot and character work. Migration for the added
  enum value rides the BO-6 migration.

- **GPU hardware spec** (sized for Hunyuan3D-2.x-class shape+texture or TRELLIS):

  | Component | Minimum (works) | Recommended (production) |
  |---|---|---|
  | GPU | 1× 24 GB VRAM (RTX 4090 / L4 24 GB / A10G) | 1× 48 GB (L40S / RTX 6000 Ada) or A100 40 GB — headroom for texture stages + larger face limits without OOM retries |
  | CUDA | 12.x, driver ≥ 550 | same |
  | System RAM | 32 GB | 64 GB |
  | Disk | 100 GB NVMe | 200 GB NVMe (model weights ~10–40 GB per candidate + cache + scratch) |
  | Precision | fp16/bf16 inference | same; no quantization below fp16 until the acceptance corpus passes with it |
  | Throughput planning | ~1–4 min/job on 24 GB | serialized, one job per GPU (`max_concurrency=1` in v1); scale by adding workers, not by co-scheduling jobs on one card |

  Hosting shapes, in order of preference for cost control: (1) **serverless GPU**
  (RunPod serverless / Modal) with scale-to-zero — you pay only for job seconds,
  which pairs naturally with the Layer8 metering below; (2) dedicated GPU VPS with
  an idle auto-suspend script; (3) colo. Same worker-secret conventions as the
  Blender worker; HTTPS; never exposed unauthenticated; loopback-only model
  endpoint inside the host.
- **Model candidates** (evaluation matrix — pick by evidence, not fashion):

| Model | License posture | Strengths | Risks |
|---|---|---|---|
| TRELLIS (Microsoft) | MIT | Strong single/multi-image quality, SLAT→mesh/GS outputs | Texture pipeline needs post-bake |
| Hunyuan3D-2.x (+ mv variant) | Tencent community license — **legal review required** (territory/MAU clauses) | Best open shape+texture quality; multiview conditioning matches our 4–5 canonical views | License restrictions may bar enterprise resale |
| TripoSR / Stable Fast 3D | MIT / Stability community | Fast, cheap | Lower fidelity; likely below acceptance bar alone |

  The worker exposes a stable internal contract so the model is swappable:
  `POST /reconstruct {referenceViews[], subjectClass, faceLimit} → {glb, metrics}` with
  the same magic/bounds/topology validation the V3 `validation.ts` already performs.
- **Layer8 operation**: `spatial.reconstruct.v1`, pinned to the reconstruction worker,
  durable async job semantics identical to `spatial.math.v1`; no fallback to Tripo or
  any hosted provider on failure — fail closed with `RECON_WORKER_UNAVAILABLE`.

- **Strict GPU-time gating at Layer8.** GPU seconds are the unit of spend; every one
  of them is authorized, bounded, and metered *before* the worker runs:

  1. **Admission control (pre-GPU).** A job enters the queue only after Layer8
     verifies tenant scope/entitlement for `spatial.reconstruct.v1`, the per-tenant
     quota has headroom, and PawsMemories has reserved credits. No speculative or
     retry-storm GPU work.
  2. **Per-job hard budget.** Policy fields on the operation:
     `max_gpu_seconds_per_job` (default 300), `max_wall_seconds` (default 600
     including queue+download), `max_face_limit`, `max_reference_views` (5). The
     worker receives the budget in the lease and self-terminates the job at the
     limit with `RECON_BUDGET_EXCEEDED`; Layer8 independently expires the lease at
     `max_wall_seconds` and refuses late results (`LATE_LEASE_RESULT` pattern from
     the in-house doc).
  3. **Per-tenant quotas.** `gpu_seconds_per_day`, `gpu_seconds_per_month`,
     `jobs_per_hour`, `concurrent_jobs` (consumer product: 1; enterprise: per
     contract). Enforcement is fail-closed at Layer8 with a stable retryable
     `QUOTA_EXHAUSTED`; PawsMemories mirrors the counters in its usage ledger and
     reconciles nightly — a >2 % drift is an alert, not a silent write-off.
  4. **Global kill switch and circuit breaker.** `RECON_ENABLED` app-side plus a
     Layer8 provider circuit breaker: N consecutive worker failures or
     health-check timeouts open the circuit, queue new jobs as
     `RECON_WORKER_UNAVAILABLE`, and page the owner — no blind retry loop burning
     GPU minutes.
  5. **Attempt caps.** Max 2 worker attempts per job (matching the Hermes lease
     rules), max 3 user-visible correction attempts; a job can never consume more
     than `2 × max_gpu_seconds_per_job` of GPU time regardless of retries.
  6. **Metering.** The worker reports measured `gpu_seconds`, model digest, and
     VRAM peak in every completion; Layer8 writes the redacted usage-audit row;
     PawsMemories prices credits (and BO-8 partner invoices) off *measured* GPU
     seconds, not estimates. Idle scale-to-zero on serverless hosting means quota
     math ≈ bill math.
- **Adapter**: implement `ReconModelBuildAdapter` against the existing
  `ModelBuildProvider` port (`server/model-builds/provider.ts`), so the durable V3
  machine drives it with zero state-machine changes.
- **Acceptance bar (the in-house doc's own criterion)**: equivalent visual, topology,
  rigging, and manufacturing acceptance vs. a frozen Tripo baseline corpus —
  ≥20 pet + ≥10 human fixtures: blind side-by-side visual review by the owner,
  Phase-4 rig pipeline success rate parity, print-STL validation parity, plus GLB
  reopen checks. Record everything in `phase-evidence/BO_6.md`.

### 8.3 Cutover and proof (BO-7)

1. Route all §2.5 call sites through the internal lanes; keep
   `TRIPO_ROLLBACK_ENABLED` as an **admin-only, default-off** flag (not a runtime
   fallback) during one release cycle.
2. **Zero-Tripo proof**: the provider-spy test pattern already used in Phase 2
   ("3D provider spy verified zero calls") becomes a permanent suite-wide assertion —
   any code path reaching `api.tripo3d.ai` fails CI.
3. After burn-in: delete `TRIPO_API_KEY` from all environments, remove `tripo.ts` and
   the adapter, close the account.

---

## 9. Workstream F — Enterprise & Big-Box Retail API (BO-8)

Product: **Pawsome Spatial API** — the same in-house stack, hostable for tenants
(e.g., a retailer digitizing a pet-accessory catalog, or an in-store kiosk generating a
customer's pet model for personalized merchandise).

- **Tenancy**: each enterprise customer is a Layer8 tenant with its own API key,
  scopes/entitlements (which operations, which models), quotas, and rate limits —
  exactly the mechanism PawsMemories itself uses as tenant #1. Paws-side, a
  `partner_accounts` record correlates tenant → billing → usage ledger (migration 35).
- **Surface** (`/api/partner/v1/*`, served by the Hostinger app or a dedicated
  deployment of the same codebase):
  - `POST /spatial/jobs` (accessory/hard-surface generation; same contract as the
    internal spatial generator API, tenant-scoped)
  - `POST /reconstruction/jobs` (organic image/multiview→3D)
  - `GET /jobs/:uuid`, `POST /jobs/:uuid/cancel`, webhook callbacks with HMAC
    signatures (reuse the Phase-6 outbox/callback conventions)
  - Artifact delivery via short-lived signed URLs; optional license certificate
    issuance per the licensing module in the in-house doc (SPAT-008)
- **Metering & billing**: per-operation usage events → append-only ledger → monthly
  invoice export (Stripe invoicing); hard quota enforcement at Layer8, soft alerts at
  80 %.
- **Isolation guarantees** (contractual): tenant-partitioned caches and storage
  prefixes, no cross-tenant lineage, redacted audit logs, per-tenant model pinning
  (a big-box tenant can be pinned to a license-cleared model even if the consumer
  product uses another).
- **SLA machinery**: `/api/partner/v1/health` per-tenant status, status page, error
  budgets measured from the observability metrics in the in-house doc §Observability.
- **Not in v1**: self-serve signup, per-seat dashboards, on-prem deployment. Tenants
  are onboarded manually by the owner.

Human review note: the consumer product keeps mandatory human approval. Enterprise
tenants may opt into **auto-accept** only for the reconstruction lane with explicit
contract terms; the spatial-generator lane keeps the automated adherence gate as the
minimum bar with review decisions delegated to the tenant via API
(`POST /jobs/:uuid/review` mirroring the internal hash-bound contract).

---

## 10. Phased Plan

Migration ledger: current schema **30**; **31 = spatial generator (reserved, unchanged)**;
32 = model-persistence (only if needed); 33 = customizer adoption; 34 = wags assets;
35 = partner accounts/usage. Never alter historical checksums.

| Phase | Scope | Depends on | Exit gate |
|---|---|---|---|
| **BO-0** Durable model persistence | §4: harden legacy completion, canonical registration, truthful status; converge Create flow onto V3; enable `MODEL_BUILD_V3_ENABLED` | — | E2E: create → approve → close browser → kill/restart server mid-build → model appears in FurBin with canonical asset + correct billing disposition; zero perpetual "Building" states across 20 fixture runs; full suite + build green |
| **BO-1** Printful surfaces + marketplace checkout | §5: admin picker, template editor, shop cards, buyer customizer, digital-checkout Stripe gap | — (parallel with BO-0) | Owner authors a product end-to-end by name search **without seeing a raw ID**; product visible in Shop; sandbox order reaches Printful draft and confirms on webhook; digital marketplace purchase completes with entitlement |
| **BO-2** Real rigging & facial | §7: worker adapter, fixtures, enable V4, route purchases internally | BO-0 (V3 live) | Rig fixtures pass on Render with measured deformation evidence; a purchased rig produces worker-synthesized facial targets on a real model; `startRig` (Tripo) unreachable from product code |
| **BO-3** Wags intelligence (2D) | §6: sticker/pawprint/seasonal materializers, idempotent delivery, admin review of generated assets | — (parallel after BO-1) | An approved test box delivers real PNG stickers + rendered pawprint into the inbox; re-delivery grants nothing twice; failed slot regenerates independently |
| **BO-4** Spatial generator core | In-house doc Phases 0–3 (contracts, deterministic math, observe/plan, Blender draft) + §2.6 math decision | BO-0 | The in-house doc's own Phase 0–3 exits: wrong-math fixtures rejected pre-Blender; ten fixtures within 0.5 mm; drafts reopen correctly |
| **BO-5** Spatial generator release + Wags 3D | In-house doc Phases 4–6 (review, finalize, licensing, limited release); wags accessory/minimodel slots consume it | BO-3, BO-4 | In-house doc Phase 4–6 exits; a Wags box grants a generated accessory GLB approved through the standard review screen |
| **BO-6** Reconstruction worker | §8.2: GPU worker, model evaluation, `spatial.reconstruct.v1`, `ReconModelBuildAdapter` | BO-0, BO-2 (rig parity is part of acceptance) | Acceptance corpus passes vs. Tripo baseline (visual/topology/rig/print parity); worker failure fails closed; adapter drives V3 end-to-end behind `RECON_ENABLED=false→admin-only` |
| **BO-7** Tripo cutover | §8.3: route everything internal, zero-Tripo CI proof, credential removal after burn-in | BO-5, BO-6 | CI provider-spy proves zero Tripo reachability; one full release cycle on internal lanes; `TRIPO_API_KEY` deleted |
| **BO-8** Enterprise API | §9: tenants, partner surface, metering, webhooks, SLAs | BO-5, BO-6, BO-7 | A pilot tenant key runs both lanes end-to-end with quotas, webhook delivery, usage ledger reconciliation, and isolation tests passing |

Parallelization: BO-0 and BO-1 immediately and in parallel (disjoint files); BO-3 after
BO-1; BO-2 after BO-0; BO-4 alongside BO-2/BO-3; BO-6 needs BO-2's rig parity bar.

---

## 11. Environment Variables (delta)

Existing variables (Gemini, Stripe, B2, `BLENDER_WORKER_URL`, `WORKER_SHARED_SECRET`,
Slant/Printful, feature flags listed in `handoff.md`) are unchanged. New/changed:

| Variable | Where | Rule |
|---|---|---|
| `MODEL_BUILD_V3_ENABLED` | Hostinger | `true` after BO-0 exit evidence |
| `RIG_PIPELINE_V4_ENABLED` | Hostinger | `true` after BO-2 exit evidence |
| `WAGS_V2_ENABLED` + four Stripe price IDs | Hostinger | BO-3 deployment gate |
| `INHOUSE_SPATIAL_GENERATOR_ENABLED` | Hostinger | per in-house doc |
| `LAYER8_BASE_URL`, `LAYER8_TENANT_API_KEY`, `LAYER8_SPATIAL_TIMEOUT_MS` | Hostinger | per in-house doc |
| `SPATIAL_MATH_EXECUTOR` | Layer8 | `deterministic` (default) or `hermes-pixel` (§2.6) |
| `RECON_WORKER_URL`, `RECON_WORKER_SECRET` | Hostinger (or Layer8 adapter) | dedicated secret, never shared with Blender/Pixel |
| `RECON_MODEL_ID` | Recon worker | evaluation-pinned model + digest |
| `RECON_ENABLED` | Hostinger | `false` → admin-only → cohort |
| `TRIPO_ROLLBACK_ENABLED` | Hostinger | admin-only, default `false`, removed at BO-7 close |
| `PARTNER_API_ENABLED` | Hostinger | `false` until BO-8 pilot |

---

## 12. Coding-Agent Prompts

Paste one prompt per session. Every prompt inherits these standing orders:

> **Standing orders (include with every phase prompt):**
> Read `FINAL_BUILDOUT_ARCHITECTURE.md` (this file), `handoff.md` (top sections),
> `PHASED_IMPLEMENTATION.md`, and the phase-specific documents named below before
> editing. Create a dedicated branch from current `main`; never overwrite uncommitted
> user changes. Preserve all historical migrations and checksums; use only the
> migration number assigned to your phase. All new features default-off behind
> server-authoritative flags. Never execute raw model-generated code. Tests use
> injected fakes and must assert zero unintended provider/storage/billing calls.
> Before requesting review run: `npm run lint`, `npm run test`, `npm run build`,
> `node scripts/animator-doctor.mjs`, plus phase-specific suites; report exact totals,
> branch, commit, migration version, and remaining live gates. Write
> `phase-evidence/BO_<n>.md`. Do not claim a gate passed that requires deployed
> infrastructure you did not exercise.

### BO-0 prompt

```text
You are implementing Phase BO-0 (Durable Model Persistence) of
FINAL_BUILDOUT_ARCHITECTURE.md §4. [Standing orders apply.]
Also read: server/model-builds/* (all files), server/pipeline-rig-recovery.ts,
server.ts sections at lines ~4300-4660 and ~6676-7390, server/assets/service.ts,
src/api.ts model-build functions, src/components/create-flow/*.

Deliver, in order:
1. Server-authoritative completion for every 3D build path: no paid artifact may
   depend on a browser poll to persist. Extend the generation_jobs background sweep
   pattern; route new legacy-avatar 3D builds through the same durable machinery.
2. done_static_fallback resolution: a rig failure after the static GLB is stored
   resolves the job visibly with the model in the profile and the rigging portion
   refunded via the existing idempotent refund markers.
3. Canonical asset registration with lineage for every finished GLB; profile/FurBin
   listing reads a single unioned endpoint; truthful billingDisposition and
   failure_code on creations DTOs.
4. Converge the Create flow onto server/model-builds (V3): wire the UI to
   /api/model-builds, preflight from the approved reference, keep legacy rows
   readable, retire resumeStalledBuilds and the in-process runBuildPipeline call
   from the status route behind the flag.
Exit evidence (phase-evidence/BO_0.md): 20 fixture runs of create→approve with
browser closed and a mid-build server restart, all models land in FurBin with
canonical assets and correct billing; zero perpetual Building states.
Keep MODEL_BUILD_V3_ENABLED=false in committed defaults; enablement is an owner
action after evidence review. Migration 32 only if strictly needed.
```

### BO-1 prompt

```text
You are implementing Phase BO-1 (Printful Customizer Surfaces) of
FINAL_BUILDOUT_ARCHITECTURE.md §5. [Standing orders apply.]
Also read: MARKETPLACE_CUSTOMIZER_SPEC.md, server/customizerCheckout.ts,
server/printfulCatalog.ts, server/printful.ts, server.ts lines ~2957-3001,
db.ts customizable_products/customize_orders, src/components/MarketplaceAdminScreen.tsx,
src/components/MarketplaceScreen.tsx, src/components/PawprintsStudio.tsx,
server/marketplacePublic.ts checkoutDigital, wags.md marketplace section.

Deliver:
1. CustomizerAdminScreen: catalogue search by name with thumbnails, variant picker,
   template editor with draggable placement box, auto-filled print-file px/DPI and
   provider IDs (the admin never types or sees a raw Printful ID as an input),
   margin guard, draft/publish lifecycle.
2. Public GET /api/customize/products (published only) + "Custom Prints & Gear"
   section in the Shop with product cards.
3. CustomizeScreen buyer flow: photo from upload or FurBin, composited preview at the
   placement's exact print resolution, checkout via POST /api/customize/checkout;
   orders visible in FurBin with tracking.
4. Fix POST /api/print-uploads MIME default; wire Stripe Checkout into
   marketplacePublic.checkoutDigital with webhook entitlement grant on
   checkout.session.completed (one-time payments, no Connect).
Migration 33 for managed-migration adoption of the customizer tables if needed.
Exit evidence (phase-evidence/BO_1.md): author-by-search walkthrough with
screenshots, sandbox Printful draft→confirm cycle, digital purchase entitlement.
```

### BO-2 prompt

```text
You are implementing Phase BO-2 (Real Rigging & Facial) of
FINAL_BUILDOUT_ARCHITECTURE.md §7. [Standing orders apply.]
Also read: server/rig-pipeline/* (all), blender-worker/server.js,
skills/animator/*.md, skeletonContract.ts, agent/graph/nodes/facialVisemes.ts,
server.ts pipelineRiggingSelection and startRig call site (~4957),
phase-evidence/PHASE_4.md, AGENT_PROMPT_PHASE_4_TO_PHASE_5.md.

Deliver:
1. The authenticated Phase-4 worker adapter integrated with the Render Blender
   worker rig endpoints (same WORKER_SHARED_SECRET conventions), removing
   RIG_WORKER_NOT_INTEGRATED only when the round-trip passes fixtures.
2. Acceptance fixtures: human, quadruped, accessory; measured deformation/locality/
   reopen evidence persisted; slicer-valid fused print derivative.
3. Create-flow rigging purchases routed to the internal pipeline; the Tripo startRig
   path must become unreachable from product code (keep the import only if a test
   asserts its non-use).
4. facialVisemes.ts demoted to explicit provider-morph passthrough that runs in
   addition to worker-synthesized targets; capability badges only with measured
   evidence.
RIG_PIPELINE_V4_ENABLED stays false in committed defaults. Exit evidence in
phase-evidence/BO_2.md; note explicitly which checks require the deployed Render
worker and were exercised there.
```

### BO-3 prompt

```text
You are implementing Phase BO-3 (Wags Intelligence, 2D) of
FINAL_BUILDOUT_ARCHITECTURE.md §6. [Standing orders apply.]
Also read: WARDROBE_WAGS_AND_TEXTURIZER_SPEC.md, wags.md, server/wags/planner.ts,
server/wags/delivery.ts, server/wags-v2/*, src/wardrobe/catalog.ts, the Pawprints
server render path, and the Gemini image generation chain in server.ts.

Deliver:
1. A per-slot materializer executed at admin approval: sticker slots generate
   1024x1024 transparent PNGs (server-verified alpha), pawprint slot renders through
   the existing Pawprints template pipeline with the plan theme + pet photo,
   seasonal slot generates themed art. All outputs are canonical private assets with
   lineage to the plan hash.
2. Idempotent per (box_id, slot); failed slots regenerate independently; a box
   cannot reach delivered with missing paid slots; admin review screen shows the
   generated assets before delivery.
3. Wags inbox renders real assets (view/download), not text rows.
4. Accessory/minimodel slots: keep current catalog behavior, but structure the
   materializer so a spatial-generator-backed executor can be added in BO-5 without
   schema changes.
Migration 34 for box-item asset references and materialization state.
Exit evidence (phase-evidence/BO_3.md): an approved test box delivering real
stickers + pawprint; double-delivery grants nothing twice.
```

### BO-4 / BO-5 prompts

```text
You are implementing Phase BO-4 (respectively BO-5) — the in-house spatial
generator. [Standing orders apply.]
The controlling specification is INHOUSE_SPATIAL_GENERATOR_ARCHITECTURE.md; follow
its Phases 0-3 (BO-4) / 4-6 (BO-5), its Coding Agent Instructions, and its
checklist verbatim, with one amendment from FINAL_BUILDOUT_ARCHITECTURE.md §2.6:
spatial.math.v1 executes on a deterministic server-side solver (pure TypeScript,
same formulas as the validator); the Hermes/Pixel Gemma worker is NOT built now —
keep the operation contract executor-pluggable via SPATIAL_MATH_EXECUTOR.
Load SPAT-007 before Layer8 work and SPAT-008 before licensing work. Migration 31.
BO-5 additionally: implement the Wags accessory/minimodel materializer executor
against the generator's job API per FINAL_BUILDOUT_ARCHITECTURE.md §6.
```

### BO-6 prompt

```text
You are implementing Phase BO-6 (In-House Organic Reconstruction) of
FINAL_BUILDOUT_ARCHITECTURE.md §8.2. [Standing orders apply.]
Also read: server/model-builds/provider.ts and validation.ts, tripo.ts,
blender-worker deployment conventions, INHOUSE_SPATIAL_GENERATOR_ARCHITECTURE.md
(Layer8 operation patterns), phase-evidence/BO_2.md.

Deliver:
1. The canonical subjectClass taxonomy (pet | human | humanoid | object) per §8.2:
   legacy avatar_type mapping, user-selectable humanoid at create time, rig-profile
   and triage rules per class (humanoid = full biped rig, relaxed likeness triage,
   anatomy anomalies advisory). Enum/migration changes ride the BO-6 migration.
2. A GPU reconstruction worker service (separate repo dir `recon-worker/`):
   POST /reconstruct accepting 1-5 reference views + subjectClass + faceLimit +
   the lease's GPU budget, returning GLB + metrics including measured gpu_seconds
   and VRAM peak; authenticated by RECON_WORKER_SECRET; model pinned via
   RECON_MODEL_ID with digest logging; fp16 minimum precision; max_concurrency=1;
   self-terminates at max_gpu_seconds_per_job with RECON_BUDGET_EXCEEDED; input
   images validated with the existing decoder conventions; the ML model behind a
   thin internal port so TRELLIS / Hunyuan3D-mv / others are swappable. Target the
   §8.2 hardware table; flag the Hunyuan license question for owner legal review in
   the evidence file — do not resolve it yourself.
3. Layer8 operation spatial.reconstruct.v1 pinned to the worker, durable async, fail
   closed with RECON_WORKER_UNAVAILABLE; zero fallback to any hosted provider; the
   full §8.2 gating stack: admission control before any GPU work, per-job
   max_gpu_seconds/max_wall_seconds policy, per-tenant gpu_seconds_per_day/month +
   jobs_per_hour + concurrent_jobs quotas failing closed with QUOTA_EXHAUSTED,
   2-attempt cap, circuit breaker, late-result rejection, and measured-gpu-second
   usage audit reconciled against the Paws ledger.
4. ReconModelBuildAdapter implementing the existing ModelBuildProvider port so the
   V3 machine drives reconstruction unchanged; provider-spy tests prove no Tripo
   reachability in the new lane.
5. The acceptance harness: frozen fixture corpus (>=20 pets across species/coat
   colors, >=10 humans across builds and skin tones, >=5 humanoid characters),
   automated topology/reopen/print parity vs recorded Tripo baselines, and an
   owner-facing blind A/B review page; rig-pipeline success parity using BO-2.
RECON_ENABLED stays false. Exit evidence in phase-evidence/BO_6.md including
hardware, model digest, latency, measured gpu_seconds, and cost per generation.
```

### BO-7 prompt

```text
You are implementing Phase BO-7 (Tripo Cutover) of
FINAL_BUILDOUT_ARCHITECTURE.md §8.3. [Standing orders apply.]
Precondition: BO-5 and BO-6 exit evidence approved by the owner.
Deliver: route every call site in §2.5 through the internal lanes; add the
permanent CI provider-spy asserting zero api.tripo3d.ai reachability from any
production code path; keep TRIPO_ROLLBACK_ENABLED as an admin-only default-off
flag for one release cycle with a documented rollback runbook; after owner-declared
burn-in, remove tripo.ts, the adapter, the flag, and document credential deletion
steps for the owner. Exit evidence in phase-evidence/BO_7.md.
```

### BO-8 prompt

```text
You are implementing Phase BO-8 (Enterprise & Big-Box API) of
FINAL_BUILDOUT_ARCHITECTURE.md §9. [Standing orders apply.]
Also read: Layer8 tenant/auth/policy/audit documentation in robs46859-eng/layer8,
the Phase-6 outbox/HMAC callback conventions, and the licensing module spec
(SPAT-008 + INHOUSE doc licensing section).
Deliver: partner_accounts + usage ledger (migration 35); /api/partner/v1 surface
(spatial jobs, reconstruction jobs, status, cancel, hash-bound review, HMAC
webhooks, signed-URL artifact delivery, optional license certificates); Layer8
tenant provisioning runbook; per-tenant quotas/rate limits enforced at Layer8 with
Paws-side reconciliation; isolation tests (cross-tenant reads, cache partitioning,
storage prefixes); metering -> monthly Stripe invoice export; per-tenant health
endpoint. PARTNER_API_ENABLED stays false until the pilot tenant walkthrough is
recorded in phase-evidence/BO_8.md.
```

---

## 13. Verification & Evidence Rules

- Gates per phase: `npm run lint` · `npm run test` · `npm run build` ·
  `node scripts/animator-doctor.mjs` · `npm run test:ifc` when worker code changes ·
  focused new suites per phase · release archive via `scripts/build-deploy-zip.sh`
  with extracted-zip verification for any deploy candidate.
- Evidence lives in `phase-evidence/BO_<n>.md`: branch, commit, migration version,
  exact test totals, artifact hashes, screenshots for UI phases, and an explicit list
  of checks that require deployed infrastructure with their status.
- The tracker table in `PHASED_IMPLEMENTATION.md` gains a BO section; a phase is
  complete only when its exit gate passed on the intended release commit.
- Deployment order for any release: Render worker first (preserving
  `WORKER_SHARED_SECRET`), then the Hostinger archive built from the clean merged
  commit, per `handoff.md` and `RELEASE_DEPLOYMENT_INSTRUCTIONS.md`.
