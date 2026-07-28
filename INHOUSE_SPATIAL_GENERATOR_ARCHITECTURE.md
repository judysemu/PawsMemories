# In-House Spatial Generator Architecture

Status: controlling implementation specification  
Scope: accessories and hard-surface meshes  
Organic pet/human reconstruction: Tripo remains available until an in-house
reconstruction path passes equivalent visual, topology, rigging, and manufacturing
acceptance.

## Objective

Create scaled 3D accessories and hard-surface assets from text plus one to four
reference images without asking an external text/image-to-3D provider to generate
the mesh.

The intelligence is split by responsibility:

1. **Gemini Vision through Layer8** observes the reference images, reports visible features,
   occlusions, normalized bounds, and scale evidence.
2. **GPT through Layer8** converts those observations and the user's request into a constrained
   spatial construction plan. GPT never returns executable Python.
3. **Gemma on the Pixel** resolves normalized geometry into concrete millimeter
   dimensions and constraint calculations. Layer8 submits this role to the durable
   Hermes workspace on the VPS.
4. **Deterministic application code** recomputes and validates every number. A
   Gemma answer that does not match the formulas is rejected.
5. **Blender on Render** compiles the validated primitive plan, creates a draft,
   and renders standard review views.
6. **Gemini Vision** compares the draft views with the original references and
   produces a bounded visual-adherence report.
7. **The user** must approve the draft before final GLB/STL export and publication.

## Why Tripo Still Exists

OpenAI and Gemini can analyze images, reason about geometry, and generate plans,
but they do not directly return a production GLB mesh. The in-house path closes
that gap for geometry that can be expressed as controlled Blender primitives,
curves, booleans, and modifiers. Organic reconstruction from a pet or human photo
still needs a reconstruction model or provider. Removing Tripo from that lane
before an equivalent replacement exists would turn a measurable mesh pipeline into
unbounded script generation.

## System Topology

```text
Browser
  -> Hostinger API and durable job state
       -> Layer8 AI control plane
            -> Gemini Vision: observe reference images
            -> OpenAI Responses API: produce construction plan
            -> Hermes producer API on VPS: submit spatial_math job
                 -> Pixel worker: lease job over outbound authenticated connection
                      -> local Gemma: resolve dimensions and constraints
                 <- heartbeat and schema-constrained result
       -> deterministic math and safety validator
       -> authenticated Render Blender worker: build draft and render views
       -> Layer8 -> Gemini Vision: post-build adherence report
  <- review screen: automated report plus front/right/back/left views
  -> approve or request correction
       -> approved: final validation and GLB/STL export
       -> correction: GPT revises plan, Gemma recomputes, Blender rebuilds
```

The Pixel initiates the connection to the VPS. The Pixel is never exposed directly
to the public internet and Hostinger does not need to know its address.

## Layer8 Control Plane Integration

Use `robs46859-eng/layer8` as the secure inference gateway rather than building a
second provider router in PawsMemories. Its existing authentication, policy, rate
limit, plugin, cache, provider, and audit pipeline is the correct foundation, but
the current generic text inference contract is not sufficient for this workflow.

Layer8 must add four versioned service operations:

| Operation | Pinned role | Behavior |
|---|---|---|
| `spatial.observe.v1` | Gemini Vision | Produce strict observations from owned private references |
| `spatial.plan.v1` | OpenAI Responses | Produce or revise the declarative construction plan |
| `spatial.math.v1` | Hermes/Pixel Gemma | Run durable asynchronous spatial math with no provider fallback |
| `spatial.verify.v1` | Gemini Vision | Compare fixed draft renders to the original references |

The operation is client-selectable, but the provider is not. Layer8 policy pins
each operation to its approved adapter, model, schema, timeout, quota, and cache
rule. A provider outage must return a stable retryable error; it must not assign the
role to a different model.

Layer8 requires strict multimodal asset-reference contracts, structured output
profiles, tenant scopes, owner-scoped idempotency, durable async job status,
provider health/circuit breakers, and redacted usage audit. It must never fetch an
arbitrary user URL. Private image observation, verification, and corrections are
not cached by default. Any deterministic math cache is tenant-partitioned and keyed
by the schema, plan hash, model digest, and policy version.

PawsMemories remains authoritative for workflow state, credits, review hashes,
correction attempts, artifacts, and lineage. Layer8 audit IDs are correlated to a
Paws attempt but do not replace local records. Blender remains a separate execution
service called directly by PawsMemories; GLB, STL, IFC, textures, and render archives
do not traverse the generic inference gateway.

Load SPAT-007 before changing either side of this integration.

## Durable State Machine

```text
draft
  -> observing
  -> planning
  -> awaiting_math_worker
  -> validating_math
  -> building_draft
  -> verifying_draft
  -> awaiting_human_review
       -> correction_requested -> planning
       -> approved -> finalizing
  -> completed

Any state may move to failed. There is no provider fallback after a Gemma or
visual-adherence failure. A retry creates a new numbered attempt.
```

Maximum correction attempts: 3. A fourth rejection closes the job for manual CAD
work instead of repeatedly spending model and worker compute.

## Human Review Stop

Final export is forbidden until all of the following are true:

- The deterministic dimensions and bounds checks pass.
- Gemini's visual-adherence report has no critical issue and meets the configured
  silhouette, proportion, feature-presence, and view-consistency thresholds.
- The user explicitly approves the exact attempt and report hash.

The review screen must show:

- Original references beside front, right, back, left, and three-quarter draft
  renders.
- Target and measured dimensions in millimeters.
- Gemini's issue list with confidence and the affected view.
- Buttons for **Approve draft** and **Request correction**.
- Correction tags: proportions, missing feature, wrong placement, wrong thickness,
  wrong color/material, attachment fit, and other.
- A required comment when **other** is chosen.

Approval is hash-bound. Approving attempt 1 cannot finalize a rebuilt attempt 2.

## In-The-Moment Owner Steps

You do not need to teach or fine-tune an LLM during normal use.

1. Upload at least a front image. Add side/back images whenever available.
2. Enter one real measurement, such as total width, collar diameter, or attachment
   spacing. This anchors image proportions to physical scale.
3. Wait for the draft review views.
4. Compare the silhouette and attachment points first, then thickness and details.
5. If correct, select **Approve draft**.
6. If incorrect, select the closest correction tag and write one concrete sentence,
   for example: `The buckle is 8 mm too far left and the band should be 3 mm
   thicker.`
7. Review the rebuilt attempt. Stop after three unsuccessful attempts and route the
   asset to manual CAD review.

The application stores these decisions as labeled evaluation records. They can be
used later to measure prompts or create a supervised fine-tuning dataset, but no
automatic training occurs.

## Contracts

### Vision Observation

Gemini returns bounded JSON containing:

- subject class and summary
- source image count and view labels
- visible features with confidence
- normalized feature bounds
- scale evidence and uncertainty
- occlusions and ambiguous geometry

It may report observations, not invented millimeter values. Physical scale comes
from a user measurement or an accepted canonical model.

### GPT Construction Plan

GPT returns only a declarative plan:

- target envelope in millimeters
- primitive type and normalized size/position
- additive or subtractive role
- rotation, symmetry, clearance, and minimum-wall constraints
- material/color intent
- manufacturing intent

Raw Python, shell commands, file paths, URLs, imports, and Blender operators are
not accepted fields.

### Gemma Math Result

Gemma receives the plan hash and normalized geometry. It returns:

- the same plan hash
- concrete millimeter dimensions and positions
- derived bounds and volume estimate
- a short list of formulas used

The server recomputes every value and rejects mismatches beyond 0.05 mm.

## Pixel Worker Requirements

The Pixel runs Gemma locally and acts only as a Hermes worker.

- Model default: `gemma3:4b` (approximately 4.3B parameters).
- The local inference endpoint is loopback-only.
- The worker maintains one outbound authenticated connection to the VPS.
- One job lease at a time.
- Heartbeat every 15 seconds; lease expires after 60 seconds without heartbeat.
- Results are strict JSON and never include model thinking or raw prompts.
- Auto-reconnect uses capped exponential backoff.
- Android battery optimization must be disabled for the runner.
- The runner must use a foreground service or Termux wake lock and start on boot.

Android cannot provide server-grade availability. Hermes must expose worker health,
and the generator must stop with `MATH_WORKER_UNAVAILABLE` when the Pixel is asleep,
offline, overheated, or disconnected. It must not silently use GPT or Gemini for
Gemma's assigned math step.

## Security Boundaries

- Browser image inputs use the existing complete JPEG/PNG/WebP decoder and size
  limits before any paid model call.
- Only authenticated administrators may use the first release.
- All model outputs are strict schemas with unknown fields rejected.
- The Pixel and Blender worker use separate secrets.
- No OpenAI, Gemini, object-storage, or Blender secret is sent to the Pixel.
- No raw LLM-generated code is executed.
- Blender receives only code compiled from validated allowlisted primitives.
- Draft GLBs and renders remain private until approval.
- Logs contain job IDs, hashes, timings, and error codes, never image bytes,
  prompts, access tokens, or model output bodies.

## Environment Variables

### Hostinger

| Variable | Initial value or rule |
|---|---|
| `INHOUSE_SPATIAL_GENERATOR_ENABLED` | `false` until the full worker chain is deployed |
| `LAYER8_BASE_URL` | HTTPS base URL of the deployed Layer8 gateway |
| `LAYER8_TENANT_API_KEY` | Dedicated PawsMemories tenant key; secret, never browser-exposed |
| `LAYER8_SPATIAL_TIMEOUT_MS` | `30000` for synchronous submit calls; poll durable jobs separately |
| `SPATIAL_MATH_TIMEOUT_MS` | `180000` |
| `BLENDER_WORKER_URL` | Existing Render worker URL |
| `WORKER_SHARED_SECRET` | Existing Blender worker secret |

Remove direct Gemini, OpenAI, and Hermes producer credentials from Hostinger only
after Layer8 parity and rollback tests pass. During migration, direct adapters may
remain disabled behind an administrator-only rollback flag; they are not runtime
fallbacks.

### Layer8

| Variable | Initial value or rule |
|---|---|
| `GEMINI_API_KEY` | Existing provider key, stored only in Layer8 secret storage |
| `GEMINI_SPATIAL_VISION_MODEL` | Evaluation-pinned model; do not silently follow provider defaults |
| `OPENAI_API_KEY` | Existing provider key, stored only in Layer8 secret storage |
| `OPENAI_SPATIAL_MODEL` | Evaluation-pinned GPT model with strict structured outputs |
| `HERMES_EDGE_BRIDGE_URL` | HTTPS URL of the VPS Hermes workspace |
| `HERMES_EDGE_PRODUCER_SECRET` | Layer8-specific Hermes producer secret |
| `SPATIAL_SERVICE_POLICY_ENABLED` | `false` until each operation's acceptance tests pass |
| `SPATIAL_PRIVATE_CACHE_ENABLED` | `false` |

### Pixel Worker

| Variable | Initial value or rule |
|---|---|
| `HERMES_WORKER_URL` | WSS worker endpoint on the VPS workspace |
| `HERMES_WORKER_TOKEN` | Pixel-specific secret |
| `HERMES_WORKER_ID` | `pixel-spatial-1` |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` |
| `OLLAMA_SPATIAL_MODEL` | `gemma3:4b` |
| `OLLAMA_TIMEOUT_MS` | `120000` |

## Known Problem Areas

1. Single-view measurements are underdetermined. Never infer absolute scale without
   a user measurement or canonical dimension.
2. LLM arithmetic is advisory. Deterministic recomputation is the acceptance
   boundary, even when Gemma returns a confident explanation.
3. Boolean order changes topology. Compile operations in stable plan order and
   record that order in the attempt hash.
4. Shared Blender scenes cause cross-job contamination. Draft generation must be a
   serialized worker operation that clears and validates the scene before build.
5. Mobile worker availability is not durable compute. Leases and heartbeats prevent
   a sleeping phone from leaving jobs permanently `running`.
6. Visual similarity is not dimensional accuracy. The automated visual report and
   numerical bounds report are separate gates.
7. User feedback is valuable training data only after identity, privacy, licensing,
   and quality review. Store it as evaluation evidence first.

## Exit Criteria

- Ten accessory fixtures with known dimensions build within 0.5 mm envelope error.
- Every deliberately wrong Gemma result is rejected before Blender execution.
- Every low-adherence render stops at human review and cannot be finalized.
- An approval for an old attempt/report hash is rejected.
- Pixel disconnect expires the lease and leaves the job safely retryable.
- No Tripo request occurs in the accessory/hard-surface path.
- GLB reopen and STL manufacturing validation both pass for approved print assets.

## Functional Scope

### Included In Version 1

- Text-to-accessory generation.
- Image-plus-measurement accessory generation using one to four views.
- Hard-surface objects composed from allowlisted primitives, curves, booleans,
  bevels, arrays, mirrors, and controlled modifiers.
- Pet and human wearable attachment geometry, provided an authoritative target
  envelope or attachment interface is supplied.
- Scaled digital GLB output.
- Optional print STL output after manufacturing validation.
- Draft multiview renders, automated visual review, and mandatory human approval.
- Up to three correction attempts.
- Private attempt history and labeled user feedback.

### Explicitly Excluded From Version 1

- Organic pet or human body reconstruction from photographs.
- Unconstrained topology generated directly by an LLM.
- Automatic rigging or facial blend-shape generation.
- Automatic training or fine-tuning from production feedback.
- Unreviewed publication to Fur Bin or the marketplace.
- IFC/BIM generation. The BIM pipeline may reuse the spatial math service later,
  but its semantics and IFC validation remain separate.
- Running Gemini, GPT, or Blender on the Pixel.
- Treating visual similarity as proof of dimensional accuracy.

## Component Responsibilities

### Browser

- Collect prompt, target use, reference images, scale anchor, envelope, and optional
  attachment interface.
- Display estimated cost before submission.
- Poll durable job state; never hold authoritative workflow state in React memory.
- Display draft renders, automated scores, measured dimensions, and issues.
- Submit a hash-bound approval or a correction request.
- Never receive provider secrets, private object keys, raw prompts, or unapproved
  manufacturing files.

### Hostinger Application

- Authenticate and authorize the owner.
- Validate and decode all image inputs before provider calls.
- Own durable job/attempt state, billing, leases, hashes, and audit events.
- Call versioned Layer8 spatial operations using a tenant-scoped server credential.
- Submit and poll Layer8's durable `spatial.math.v1` job.
- Recompute all Gemma values deterministically.
- Compile the declarative plan into allowlisted Blender operations.
- Call the authenticated Render worker.
- Store private artifacts and expose short-lived signed URLs.
- Enforce automated and human approval gates.

### Layer8 AI Control Plane

- Authenticate the PawsMemories tenant and enforce spatial scopes/entitlements.
- Pin each spatial operation to its approved model/provider role.
- Validate private asset references and strict input/output profiles.
- Apply rate limits, quotas, redaction, idempotency, and correlated usage audit.
- Hold Gemini, OpenAI, and Hermes producer credentials outside PawsMemories.
- Submit durable Gemma math to Hermes and expose bounded status/cancel operations.
- Fail closed on unavailable roles; never silently substitute a different model.
- Keep Blender execution and model binary transfer outside the inference pipeline.

### VPS Hermes Workspace

- Accept authenticated producer jobs from Hostinger.
- Persist `spatial_math` jobs independently of the Pixel connection.
- Lease one job at a time to a capable worker.
- Authenticate the Pixel with a dedicated worker token.
- Track heartbeat, lease expiry, attempt count, completion, and sanitized failure.
- Reject late results from an expired or replaced lease.
- Never perform LLM inference on the CPU-only VPS.

### Pixel Gemma Worker

- Maintain an outbound connection to Hermes.
- Advertise the exact schema and model capability.
- Claim only `spatial_math` jobs.
- Call the local loopback inference endpoint.
- Validate Gemma output locally before submitting it.
- Send heartbeats while inference runs.
- Return one bounded result or one sanitized error.
- Process no more than one job concurrently in version 1.

### Render Blender Worker

- Accept an authenticated, validated declarative build request.
- Serialize draft-build operations to prevent scene contamination.
- Start from a clean scene.
- Build geometry using deterministic templates.
- Report actual scene bounds, mesh counts, manifold/topology metrics, and timings.
- Render fixed review views.
- Keep draft and final export operations separate.
- Reopen final exports and run the existing manufacturing gates when STL is
  requested.

## Database Specification

Reserve managed migration **31** for the in-house spatial generator. Do not alter
historical migration checksums.

### `spatial_generation_jobs`

| Column | Type | Rule |
|---|---|---|
| `id` | `BIGINT UNSIGNED AUTO_INCREMENT` | Primary key |
| `job_uuid` | `CHAR(36)` | Unique public identity |
| `owner_phone` | `VARCHAR(32)` | FK to users; never accepted from client body |
| `subject_kind` | `ENUM('accessory','hard_surface')` | Version 1 scope |
| `target_use` | `ENUM('digital','attachment','print')` | Controls validation |
| `state` | bounded enum | State machine value |
| `current_attempt_id` | `BIGINT UNSIGNED NULL` | FK added after attempts table |
| `credits_reserved` | `INT UNSIGNED` | Server-calculated |
| `credits_disposition` | bounded enum | `reserved`, `charged`, `refunded`, `none` |
| `idempotency_key` | `VARCHAR(128)` | Unique per owner |
| `failure_code` | `VARCHAR(64) NULL` | Sanitized stable code |
| `failure_detail` | `VARCHAR(512) NULL` | Sanitized owner-facing detail |
| `created_at` / `updated_at` | timestamp | Managed by database |

Required uniqueness: `(owner_phone, idempotency_key)` and `job_uuid`.

### `spatial_generation_inputs`

One immutable row per job containing canonical prompt, envelope JSON, scale-anchor
JSON, attachment JSON, input hash, and private reference asset-version IDs. Do not
store image bytes or public provider URLs in this table.

### `spatial_generation_attempts`

| Column | Purpose |
|---|---|
| `attempt_number` | 1-3; unique per job |
| `state` | Attempt-specific state |
| `observation_json` / `observation_hash` | Validated Gemini evidence |
| `plan_json` / `plan_hash` | Validated GPT declarative plan |
| `math_json` / `math_hash` | Validated Gemma result |
| `compiled_program_hash` | Hash of deterministic Blender program |
| `automated_report_json` / `automated_report_hash` | Gemini adherence result |
| `lease_owner` / `lease_expires_at` / `last_heartbeat_at` | Recovery boundary |
| `started_at` / `completed_at` | Timing evidence |
| `failure_code` | Stable failure token |

Attempt state may advance only through locked repository transitions. Never accept a
client-provided attempt number or state.

### `spatial_generation_artifacts`

References immutable private asset versions. Allowed roles:

- `reference_front`, `reference_right`, `reference_back`, `reference_left`
- `draft_glb`
- `draft_render_front`, `draft_render_right`, `draft_render_back`,
  `draft_render_left`, `draft_render_three_quarter`
- `final_glb`
- `final_stl`
- `manufacturing_report`

Unique key: `(attempt_id, role)`. Store object keys only in the canonical asset
registry; public API responses contain signed URLs, never keys.

### `spatial_generation_reviews`

One immutable review event per decision. Fields include owner, attempt ID, attempt
hash, report hash, decision, correction tags, comment, created timestamp, and a
privacy-safe actor audit hash. An approval must target the job's locked current
attempt and exact current report hash.

### `spatial_generation_events`

Append-only audit ledger for state changes, model dispatch/completion, lease changes,
refunds, review decisions, finalization, and publication. Event payloads are bounded
JSON and must not contain secrets, image bytes, prompts, or provider responses.

## Public API Specification

Every route requires the existing authenticated session. Version 1 additionally
requires administrator authorization and
`INHOUSE_SPATIAL_GENERATOR_ENABLED=true`.

### `POST /api/spatial-generator/jobs`

Creates a durable job and returns HTTP 202.

Request fields:

- `idempotencyKey`: 16-128 safe characters.
- `subjectKind`: `accessory` or `hard_surface`.
- `targetUse`: `digital`, `attachment`, or `print`.
- `prompt`: 3-2,000 characters.
- `targetEnvelopeMm`: finite positive `x`, `y`, and `z`, each at most 5,000 mm.
- `referenceAssetVersionIds`: zero to four owned private image versions.
- `scaleAnchor`: required when references are present; axis, millimeters, label.
- `attachment`: required for attachment use; target asset version plus clearance.

The server validates ownership and immutable versions. It never accepts arbitrary
remote image URLs.

Response fields: job UUID, state, attempt number, reserved credits, and status URL.

### `GET /api/spatial-generator/jobs/:jobUuid`

Returns sanitized state, current attempt number, progress stage, failure code,
current automated report, dimensions, and signed review artifacts. It does not
return model prompts, private keys, Blender code, raw provider output, or worker IDs.

### `POST /api/spatial-generator/jobs/:jobUuid/review`

Request fields: attempt hash, report hash, decision, correction tags, comment.

- `approve`: accepted only from `awaiting_human_review` after automated pass.
- `request_correction`: creates the next attempt if fewer than three attempts exist.
- Repeated identical approval is idempotent.
- Approval for a stale attempt returns HTTP 409.

### `POST /api/spatial-generator/jobs/:jobUuid/cancel`

Cancels only before finalization. Releases an unconsumed reservation exactly once.
It cannot delete immutable audit or review records.

### `GET /api/spatial-generator/health`

Administrator-only readiness view containing Gemini configured, OpenAI configured,
Hermes producer reachable, Pixel worker online/capability/model, Blender healthy,
and feature-flag state. It must not reveal URLs containing credentials or secrets.

## Internal Hermes Contract

### Producer Submission

Hostinger submits to the existing Hermes producer API:

```json
{
  "type": "spatial_math",
  "payload": {
    "schema_version": "pawsome.spatial-math-request.v1",
    "plan_hash": "64 lowercase hex characters",
    "envelope_mm": { "x": 120, "y": 80, "z": 35 },
    "minimum_wall_mm": 1.6,
    "primitives": [],
    "constraints": []
  }
}
```

The payload excludes images, user identity, provider credentials, and GPT reasoning.
The producer idempotency key is the local attempt UUID plus plan hash.

### Worker Session

The Pixel opens `wss://<hermes-host>/v1/workers/connect` using a Bearer token and
sends:

```json
{
  "type": "hello",
  "worker_id": "pixel-spatial-1",
  "protocol": "pawsome.hermes-worker.v1",
  "capabilities": ["spatial_math.v1"],
  "models": ["gemma3:4b"],
  "max_concurrency": 1
}
```

Hermes sends a lease message containing job ID, lease token, lease expiry, type, and
payload. The worker sends heartbeat messages every 15 seconds and returns completion
with the same job ID and lease token. Hermes rejects missing, expired, mismatched,
duplicate, or replaced lease tokens.

Disconnect behavior:

1. A running lease remains valid for at most 60 seconds without heartbeat.
2. After expiry, Hermes marks it retryable and may issue one new lease.
3. A late Pixel result is discarded and logged as `LATE_LEASE_RESULT`.
4. After two worker attempts, the job fails `MATH_WORKER_FAILED`.

### Gemma Output Contract

```json
{
  "schemaVersion": "pawsome.spatial-math.v1",
  "planHash": "same plan hash",
  "units": "mm",
  "resolvedPrimitives": [
    {
      "id": "primitive-1",
      "dimensionsMm": { "x": 80, "y": 40, "z": 20 },
      "positionMm": { "x": 0, "y": 0, "z": 0 },
      "rotationDeg": { "x": 0, "y": 0, "z": 0 }
    }
  ],
  "derived": {
    "boundsMinMm": { "x": -40, "y": -20, "z": -10 },
    "boundsMaxMm": { "x": 40, "y": 20, "z": 10 },
    "estimatedVolumeMm3": 64000
  },
  "calculations": ["primitive-1.x = 0.6666667 * 120 mm = 80 mm"]
}
```

Use Ollama structured outputs with the full JSON schema and temperature zero. The
worker parses and validates before transmission. Hostinger repeats validation and
recomputes all numbers independently.

## Model Prompt Specifications

### Gemini Observation Prompt

System role: product photogrammetry analyst, not CAD generator.

Required behavior:

- Describe only visible evidence.
- Use normalized coordinates; never invent millimeters.
- Label unknown/occluded regions explicitly.
- Identify likely symmetry and repeated features as observations, not facts.
- Bind every feature to at least one view and confidence.
- Reject identity or shape interpretation when references conflict.
- Return only the observation schema.

Temperature: 0.1. The image and scale-anchor label are input; the absolute anchor
value is withheld from the visual model to avoid fabricated dimensional claims.

### GPT Construction Prompt

System role: senior parametric CAD planner.

Required behavior:

- Consume validated observations, user prompt, physical envelope, anchor, and
  attachment interface.
- Output only allowlisted declarative operations.
- Keep normalized additive geometry within the unit envelope.
- Begin with an additive primitive.
- State manufacturing constraints when target use is print.
- Prefer fewer stable primitives over fine decorative geometry.
- Represent holes and recesses as subtractive primitives.
- Do not return code, URLs, imports, paths, commands, or prose outside the schema.
- Do not infer hidden organic geometry from a single view.

Use the OpenAI Responses API with strict JSON Schema. Reasoning effort may be high,
but reasoning text is not stored. Keep the exact model configurable through
`OPENAI_SPATIAL_MODEL`.

### Gemma Math Prompt

System role: dimensional solver.

Required behavior:

- Resolve normalized sizes by multiplying each axis by the target envelope.
- Resolve normalized positions by multiplying each axis by half the envelope.
- Preserve primitive IDs, order, rotation, and plan hash.
- Compute bounds and estimated volume using supplied formulas.
- Return millimeters only.
- Never redesign the plan or add/remove primitives.
- Return only the math-result schema.

Gemma is not trusted because it is local; it is trusted only after deterministic
recomputation passes.

### Gemini Adherence Prompt

System role: independent visual QA reviewer.

Inputs: original references, fixed draft views, validated observation, and attempt
hash. Do not provide GPT/Gemma explanations.

Required scores: silhouette, proportion, feature presence, and view consistency,
each 0-1. Critical issues include missing major feature, impossible view conflict,
gross proportion error, clipped geometry, attachment interface mismatch, or obvious
render failure.

Default automated thresholds:

| Metric | Minimum |
|---|---:|
| Silhouette | 0.88 |
| Proportion | 0.90 |
| Feature presence | 0.90 |
| View consistency | 0.92 |

Automated `pass` requires every threshold and zero critical issues. A pass still
does not replace human approval.

## Deterministic Geometry Compiler

The compiler accepts the validated plan and math result and emits Blender operations
from static templates. It does not interpolate unescaped prompt text into Python.

Allowlisted version 1 geometry:

- box
- cylinder
- UV sphere
- cone
- torus
- capsule
- additive/subtractive boolean in declared order
- mirror about one declared axis
- bevel with bounded width and segments
- curve sweep with bounded control points
- array with bounded count and spacing

Hard limits:

- 40 primitives
- 250,000 draft vertices
- 1,000,000 final vertices
- 64 boolean operations
- coordinates within 5 meters of origin
- dimensions 0.1-5,000 mm
- rotations finite and within +/-360 degrees
- minimum print wall initially 1.2 mm, or stricter product/material policy

The worker returns actual world bounds after modifier application. If actual bounds
deviate from expected bounds by more than 0.5 mm or 0.5 percent, whichever is
larger, the attempt fails before visual review.

## Draft And Final Artifact Rules

Draft build:

- Moderate topology and neutral materials.
- No marketplace/public publication.
- Five fixed camera views with consistent focal length, framing, background, and
  lighting.
- Private signed URLs with 15-minute default lifetime.

Final build after approval:

- Rebuild from the same validated plan/math/program hashes; never mutate the draft
  interactively and call it final.
- Apply final bevel/normal/material settings.
- Export GLB and reopen it for bounds/topology verification.
- For print, produce STL through the existing repair/validation contract and reopen
  the exact STL bytes.
- Record lineage from input assets through every plan/report/artifact version.

## Correction Loop

A correction request supplies only structured tags and the user's bounded comment.
The next GPT call receives:

- original validated observation
- previous construction plan
- automated visual report
- structured user correction
- immutable target envelope and attachment interface

It does not receive provider logs, Gemma thinking, raw Blender stdout, secrets, or
other users' examples. Gemma then recomputes the revised plan. Attempts are immutable;
attempt 2 never overwrites attempt 1.

## Feedback And Future Training

Start with evaluation, not model training.

Store an evaluation example only when it has:

- licensed/owned source references
- validated observation and plan hashes
- draft renders
- automated report
- explicit user decision
- correction tags/comment or final approval
- final measured dimensions and manufacturing result when applicable

Before any fine-tuning project:

1. Export only owner-consented examples.
2. Remove user identifiers, URLs, secrets, and unrelated scene content.
3. Have a human label whether observation, planning, math, rendering, or user taste
   caused each failure.
4. Split by asset identity so near-duplicate attempts cannot cross train/test sets.
5. Establish a frozen evaluation set before training.
6. Fine-tune only if prompt/schema improvements fail to meet the measured target.

The likely first optimization is GPT plan prompting or a small plan-ranking model,
not Gemma math training. Deterministic arithmetic should remain authoritative even
after any fine-tune.

## Billing And Refund Rules

Do not reuse Tripo pricing. Define a separate server-authoritative price after
measuring Gemini, GPT, Pixel energy/latency, Blender, storage, and correction costs.

Recommended accounting:

- Quote is free and performs no model calls.
- Reserve credits atomically when the job starts.
- Charge once when the first draft reaches `awaiting_human_review`.
- Include one correction attempt; price later attempts explicitly or cap at three.
- Refund fully if failure occurs before any reviewable draft.
- Do not refund an approved/finalized artifact automatically.
- Every debit/refund uses a unique correlation key and append-only ledger event.

Administrators may bypass credits for initial acceptance, but provider usage must
still be logged.

## Model Asset Licensing

The architecture supports license keys, but they are separate from Layer8 tenant
API keys. Layer8 credentials authorize AI requests; model licenses authorize use of
an immutable generated asset.

PawsMemories is initially authoritative because its canonical asset registry already
stores asset identity, immutable versions, SHA-256 hashes, lineage, source license,
and commercial-use eligibility, while marketplace records store orders and
entitlements. Add a dedicated licensing module rather than encoding asset rights in
the generic Layer8 inference API.

Each license grant binds a purchaser/account, rights policy, canonical asset UUID,
exact version or immutable manifest hash, issue/expiry dates, order or subscription
correlation, and revocation state. Personal digital, personal print, commercial
media, commercial manufacturing, derivative, redistribution, seat/device, and
quantity rights are explicit policy fields. A downstream license can never exceed
the rights allowed by source images, textures, fonts, model providers, or other
canonical lineage inputs.

Issue two artifacts when offline verification is needed:

- A high-entropy, one-time-visible activation key whose full value is never stored.
- An Ed25519-signed certificate containing the license UUID, policy/version, asset
  version and file/manifest hash, dates, limits, and signing-key ID.

The private licensing key remains in managed secret storage. Public verification
keys may be shipped to trusted verification clients. Rotation uses a new key ID and
retains old public keys for previously issued certificates. Do not place a reusable
secret in GLB/STL metadata because downloadable files are inspectable.

Layer8 may later provide a tenant-partitioned deterministic license
issue/verify/revoke service with dedicated scopes, but this service remains outside
`/v1/proxy/infer`. Official download access still requires a current Paws entitlement
and short-lived signed URL. Licensing controls lawful access and records grants; it
cannot make a downloaded 3D file impossible to copy.

Load SPAT-008 for licensing implementation and security tests.

## Observability

Required metrics:

- jobs by state and failure code
- Gemini observation and adherence latency
- GPT planning latency and refusal/schema-failure rate
- Hermes queue wait, Pixel online status, lease expiry, and Gemma latency
- deterministic math rejection count by reason
- Blender draft/final duration, bounds error, topology, and repair rate
- automated adherence scores by attempt
- human approval/rejection rate and corrections per job
- credit reservations, charges, and refunds

Required correlation fields: job UUID, attempt number, attempt hash, plan hash,
math hash, report hash, Layer8 audit ID, and artifact role. Never log prompts, image bytes, signed
URLs, authorization headers, or full provider responses.

## Pixel Always-On Operations

The coding agent must provide an Android/Termux runbook and scripts, but must not
claim server-grade availability.

Minimum operating procedure:

1. Keep the local Gemma runner bound to `127.0.0.1` only.
2. Use a foreground process and `termux-wake-lock` while the worker is enabled.
3. Disable battery optimization for Termux/the worker app.
4. Use Termux:Boot or the worker app's boot receiver to start after reboot.
5. Auto-restart both inference and worker processes with exponential backoff.
6. Prefer power and Wi-Fi; monitor thermal throttling and battery state.
7. Maintain the outbound WSS session over Wi-Fi/cellular changes.
8. Report worker `online`, model loaded, queue depth, last heartbeat, battery, and
   thermal state to Hermes health without exposing personal device data publicly.
9. Stop claiming new jobs below a configurable battery threshold or above a thermal
   threshold; finish or safely release the current lease.
10. Rotate the Pixel worker token independently of producer and Blender secrets.

If the installed mobile application cannot expose a loopback Ollama-compatible API,
the worker adapter must target its actual local API. Do not expose Android debug,
ADB, or an unauthenticated LAN inference port as a shortcut.

## Deployment Order

1. Deploy migration 31 and disabled Hostinger code.
2. Deploy disabled Layer8 spatial contracts, scopes, policies, and provider adapters.
3. Deploy the VPS Hermes `spatial_math` queue/lease protocol and connect it to the
   Layer8 Hermes adapter.
4. Configure and connect the Pixel worker; verify health and one schema fixture.
5. Deploy the Render Blender draft/final endpoints and validate authentication.
6. Run ten known-dimension fixtures with both feature and Layer8 service policies
   still false for users.
7. Enable administrator-only access.
8. Complete owner review of text, one-view, multiview, attachment, correction,
   Pixel-disconnect, Blender-failure, and print flows.
9. Set the feature flag for the intended user cohort only after evidence is stored.

Never enable the browser UI before server, Hermes/Pixel, and Blender readiness all
report healthy.

## Phased Implementation

### Phase 0: Contracts And Evidence

- Add strict schemas and deterministic formulas.
- Add ten known-dimension accessory fixtures.
- Add feature flag and health contract.
- Add SPAT-007 Layer8 operation, result-profile, entitlement, and idempotency
  contracts with all service policies disabled.
- Add adversarial tests for NaN, infinity, overflow, unknown fields, stale hashes,
  duplicate IDs, prompt injection, and wrong plan math.
- Exit: every deliberately wrong math fixture is rejected without a Blender call.

### Phase 1: Hermes And Pixel Math

- Add `spatial_math` to producer and worker contracts.
- Add durable queue, lease, heartbeat, retry, late-result rejection, and health.
- Add Pixel direct runner with strict Ollama schema.
- Add the Layer8 `spatial.math.v1` Hermes adapter and durable status contract.
- Exit: disconnect/reconnect and lease-expiry fixtures pass; no fallback model runs.

### Phase 2: Observation And Planning

- Add complete image validation and canonical private reference assets.
- Add Gemini observation and GPT Responses strict-plan adapters in Layer8.
- Call them only through `spatial.observe.v1` and `spatial.plan.v1` from
  PawsMemories.
- Add plan and provider event persistence.
- Exit: text and multiview fixtures produce bounded valid plans with no executable
  content.

### Phase 3: Draft Blender Build

- Add deterministic compiler and authenticated serialized worker endpoint.
- Store draft GLB and five review renders privately.
- Verify actual bounds against expected bounds.
- Exit: ten fixtures remain within dimensional tolerance and reopen correctly.

### Phase 4: Automated And Human Review

- Add the Layer8 `spatial.verify.v1` Gemini adherence report.
- Add review screen, hash-bound approval, correction tags, and three-attempt loop.
- Add immutable review/evaluation records.
- Exit: low-score/stale-attempt/fabricated-hash paths cannot finalize.

### Phase 5: Finalization And Manufacturing

- Rebuild final GLB from accepted hashes.
- Add final reopen checks and optional exact-STL repair/validation.
- Add billing/refunds, canonical lineage, and download delivery.
- Bind final immutable asset hashes to versioned license policies and entitlements;
  add activation/certificate issuance only if the product requires offline checks.
- Exit: approved digital and print fixtures pass; failed pre-review jobs refund once.

### Phase 6: Limited Release

- Administrator acceptance, then a small user cohort.
- Measure model cost, Pixel availability, correction rate, and manufacturing pass
  rate.
- Keep Tripo for organic reconstruction.
- Exit: owner signs the evidence record and explicitly approves wider availability.

## Coding Agent Instructions

The implementation agent must:

1. Read `AGENTS.md`, `SKILLS.md`, this specification, `HANDOFF.md`,
   `PHASED_IMPLEMENTATION.md`, `DEPLOYMENT_NOTES.md`, and the existing Hermes,
   canonical asset, model-build, Blender worker, image-security, credit-ledger, and
   migration code before editing. For gateway work, also read Layer8's AGENTS,
   architecture, pipeline, provider, schema, routing, and skill files.
2. Create a dedicated branch from current `main`; never overwrite user changes.
3. Implement one phase at a time and stop at each exit gate.
4. Reserve migration 31 and preserve every historical migration/checksum.
5. Use the existing complete image decoder, canonical asset registry, private
   object storage, auth/admin checks, credit ledger, and worker-secret conventions.
6. Keep provider adapters injectable behind Layer8. Tests must use fakes and assert
   zero unintended Gemini, GPT, Hermes, Blender, Tripo, storage, or billing calls.
7. Never execute raw model-generated code. Build a deterministic compiler from
   declarative primitives.
8. Keep Tripo unchanged for pet/human reconstruction and prove zero Tripo calls in
   the new accessory lane.
9. Keep the feature flag false through implementation and deployment evidence.
10. Update this document, `HANDOFF.md`, `PHASED_IMPLEMENTATION.md`, README, env docs,
    and phase evidence after each accepted phase.
11. Run focused tests while developing, then TypeScript, full tests, Python tests,
    worker tests, production build, release-manifest verification, and extracted-zip
    verification before requesting merge.
12. Report exact test totals, commit, branch, migration version, artifact hashes,
    remaining live gates, and any untested hardware behavior.

Recommended project skills:

- image-to-3d workflow and multiview capture
- Blender 5.1 background-safe Python
- physical-to-CAD measurement and uncertainty
- BIM/geospatial scale conventions where coordinate systems are involved
- Node/Express/Zod security boundaries
- MySQL migrations, locking, idempotency, leases, and credit ledgers
- Android foreground services/Termux operations
- adversarial model-output validation and visual QA
- SPAT-007 Layer8 multi-tenant gateway integration

## Coding Agent Completion Checklist

- [ ] No raw LLM code execution.
- [ ] No absolute scale without an authoritative anchor.
- [ ] Every schema is strict and bounded.
- [ ] Every Gemma number is independently recomputed.
- [ ] Pixel unavailable means fail closed, not fallback.
- [ ] Blender build is serialized and starts from a clean scene.
- [ ] Draft and final artifacts are separate and private by default.
- [ ] Automated adherence and explicit human approval both gate finalization.
- [ ] Approval is bound to current attempt and report hashes.
- [ ] Correction attempts are immutable and capped at three.
- [ ] Tripo receives zero calls in the accessory path.
- [ ] Organic reconstruction still has a truthful provider path.
- [ ] Credits debit/refund exactly once.
- [ ] Model licenses bind exact canonical versions/hashes and never reuse Layer8 API
  credentials.
- [ ] License rights do not exceed any source or lineage restriction.
- [ ] Worker and provider secrets never reach browser or Pixel payloads.
- [ ] Provider credentials are centralized in Layer8 after migration parity passes.
- [ ] Layer8 service roles are pinned and forbidden from model fallback.
- [ ] Private image operations are not cached and cache keys never cross tenants.
- [ ] GLB/STL/IFC and Blender execution remain outside generic Layer8 inference.
- [ ] Pixel worker health and lease recovery are observable.
- [ ] GLB and exact STL reopen/validation pass where applicable.
- [ ] Mobile review UI works at 320, 360, 390, and 430 px with safe gutters.
- [ ] Documentation and deployment variables are current.
- [ ] Feature remains default-off until owner approval.
