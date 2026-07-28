# Model Generator Review — 2026-07-28

Status: authoritative review for the gated GLB product rebuild
Reviewed branch baseline: `main` at `4ee12d648344034707c71bacbcd5fdfab66cc0b2`
Review scope: commits `8e48d5d` through `4ee12d6`, the customer studio, paid-order
service, Tripo boundary, canonical asset persistence, validation, and delivery

## Product outcome

The current implementation cannot be signed off as a real, customer-controlled
GLB sale. It can create an order, deduct wallet credits, submit Tripo work, persist
one final candidate, accept operator approval, and issue a signed download. It does
not implement the customer gates or stage-level commerce described by its UI.

This rebuild changes the product to one truthful flow:

1. The customer supplies and approves the exact reference set.
2. Pawsome3D charges the base-model price and generates an untextured GLB.
3. The customer previews and approves that exact base-model asset version.
4. If texture was selected, Pawsome3D charges the texture add-on and generates a
   separate textured GLB version.
5. The customer previews and approves that exact textured asset version.
6. If rigging was selected, Pawsome3D runs an actual pre-rig capability check,
   charges the rigging add-on only when the rig stage starts, and generates a
   separately validated rigged GLB.
7. The customer previews and approves the exact rigged version.
8. An operator performs the final quality decision without replacing customer
   approval.
9. The approved immutable version is delivered through a short-lived signed URL
   and remains available through the user's asset/FurBin ownership path.

No downstream provider call may begin before the preceding customer gate.

## Review findings

### R1 — Step-by-step mode is not implemented

`src/components/PetModelStudio.tsx` explicitly says the backend pause hook is a
future slice. Its toggle changes copy only. Both modes call the same endpoint and
the adapter advances base → rig → idle → walk without customer input.

Severity: blocker.

### R2 — The displayed stages do not match generated artifacts

The UI promises “Grey base mesh → textured → rigged,” but the existing base call
requests `texture=true`, `pbr=true`, and detailed texture. There is no separately
persisted blank base model and no texture task. The timeline advances according to
coarse order states, not actual immutable stage artifacts.

Severity: blocker.

### R3 — Credits are charged before the product stages exist

Order creation checks and immediately deducts a single quote. The quote is derived
from view count rather than the platform's authoritative base/texture/rigging
prices. Texture and rigging are not separate idempotent ledger entries.

Severity: blocker and commerce-integrity defect.

### R4 — The customer cannot approve any generated model

Only an operator approval endpoint exists. The customer cannot approve or reject a
reference set, base mesh, texture, or rig. The operator approval is not a
substitute for customer acceptance.

Severity: blocker.

### R5 — The current rig pipeline uses a deprecated model version by default

`tripo.ts` defaults to `v2.0-20250506`. Tripo's current official changelog and
animation documentation deprecate that version and direct integrators to
`v2.5-20260210`.

Severity: high.

### R6 — Rig type is sent in the wrong field

The current implementation maps a human selection to `spec: "humanoid"`. Official
Tripo schema defines `spec` as `tripo | mixamo` and defines humanoid/animal shape
through `rig_type` (`biped`, `quadruped`, `avian`, and others).

Severity: high; it can produce a 400 response or the wrong skeleton.

### R7 — Facial rigging cannot meet the requested guarantee

The paid flow has no provider operation that creates facial blendshapes, no
customer-stage facial artifact, no cohort success metrics, and no evidence that at
least 75% of supported inputs receive a valid facial rig. A separate legacy
viseme/jaw fallback is not evidence of facial blendshapes.

Decision: facial rigging is removed from this product surface. The API reports it
as unavailable. It may return only after:

- at least 20 production-equivalent fixtures have been evaluated;
- at least 75% pass every facial capability check;
- the provider or deterministic process actually creates named morph targets;
- failed attempts are not charged;
- the result remains bound to an immutable GLB version and validation report.

### R8 — “Humanoid intelligence” is not a model-file capability

A GLB can contain humanoid geometry, a biped skeleton, morph targets, metadata, and
animations. It cannot itself provide reasoning or conversational intelligence.
The implemented option is therefore named and scoped truthfully:

- **Humanoid character** selects a biped generation/rig profile.
- It records `subjectProfile=humanoid` in immutable lineage.
- It requests Tripo `rig_type=biped`.
- It does not claim that the downloaded GLB contains an AI agent.

Behavioral intelligence remains an application/runtime concern and is not sold as
part of the GLB.

### R9 — Style direction is currently ignored

The customer studio has no style input. Tripo image/multiview geometry generation
does not accept an arbitrary style prompt. Tripo's separate `texture_model` task
does support a bounded `texture_prompt.text` and style image.

Decision: optional style direction is accepted only for the texture stage, is
limited to 400 plain-text characters, is included in the stage input hash, and is
sent as `texture_prompt.text`. Geometry is still derived from the approved
references. The UI states this limitation.

### R10 — HD is the only effective mesh profile

The existing call uses a 40,000-face target and does not set `smart_low_poly`.
There is no customer profile selection and no stage validator enforcing the
chosen budget.

Decision:

- **HD**: Tripo v3.1 (configurable), standard geometry quality, untextured base,
  target 100,000 triangles, hard maximum 150,000 triangles.
- **SmartMesh**: Tripo P1 low-poly model (configurable), untextured base, target
  8,000 faces, hard maximum 10,000 triangles.

The downloaded GLB is parsed and its actual triangle count is shown. A SmartMesh
candidate over its hard maximum cannot be approved or delivered.

### R11 — The existing validator validates the wrong product

`validatePetGlb()` always treats skin, weights, idle, and walk clips as critical.
That makes a correct blank base model fail. Stage validation must be capability
specific:

- reference: exact manifest hash and required views;
- base: GLB parse, scene, non-empty mesh, triangle budget, self-contained buffers;
- texture: all base checks plus material/texture evidence;
- rig: all texture/base checks plus skin, joints, and weights;
- facial: morph-target coverage, only if the product is enabled later.

### R12 — Provider outputs are not persisted per stage

Only the final merged result is mirrored to private storage and registered as an
asset version. A gate cannot securely approve an expiring provider URL.

Decision: every completed model stage is immediately downloaded, validated,
stored under a content-addressed private key, and registered as an immutable asset
version before it is exposed for customer approval.

### R13 — Provider execution and approval state are conflated

The provider job record contains an automatic animation stage machine. The
commercial state machine contains only one generation job ID. A restart or retry
cannot reliably describe independent base, texture, and rig attempts to the user.

Decision: add durable stage attempts with their own local job ID, input hash,
artifact hash/version, validation report, price, credit disposition, timestamps,
and customer decision.

## Official provider facts checked

Review date: 2026-07-28.

- Generation supports `texture=false` for a blank base, `face_limit`, and current
  model versions. P1 is explicitly optimized for low-poly generation.
  <https://platform.tripo3d.ai/docs/generation>
- `texture_model` supports text/style direction and separate texture quality.
  <https://platform.tripo3d.ai/docs/texture>
- Smart LowPoly exists as `highpoly_to_lowpoly`, and P1 can generate a low-poly
  base directly. <https://platform.tripo3d.ai/docs/editing>
- Rigging supports `rig_type` and `spec`, and current rig version
  `v2.5-20260210`. <https://platform.tripo3d.ai/docs/animation>
- Provider URLs expire and must not be canonical.
  <https://platform.tripo3d.ai/docs/task>
- Current provider credit behavior and texture surcharges were reviewed only to
  estimate internal cost; Pawsome3D prices remain server-authoritative.
  <https://platform.tripo3d.ai/docs/billing>

## Sign-off criteria

The rebuild is not complete until automated tests prove:

- zero provider calls before reference approval;
- zero texture calls before base approval;
- zero rig calls before texture/base approval;
- base, texture, and rig charges are separate, idempotent, and server-priced;
- a duplicate approval does not charge or submit twice;
- cross-account stage reads and approvals are forbidden;
- every approval binds the current stage, attempt UUID, artifact SHA-256,
  asset-version ID, and validation-report hash;
- stale attempts and over-budget SmartMesh assets cannot be approved;
- facial rigging is unavailable in both product JSON and UI;
- humanoid uses `rig_type=biped`, while pet uses `rig_type=quadruped`;
- texture style direction is bounded, hashed, and sent only to texture work;
- provider URLs never become application delivery URLs;
- the delivered download is the exact final approved immutable version;
- Node 24 type-check, all test suites, and the full production build pass.
