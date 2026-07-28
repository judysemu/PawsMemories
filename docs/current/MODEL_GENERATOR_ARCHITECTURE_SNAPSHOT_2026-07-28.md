# Gated Model Generator — Architecture Snapshot

Status: implementation contract
Date: 2026-07-28
Product boundary: one customer-owned, paid, immutable GLB

## System boundary

```text
PetModelStudio
  │ authenticated JSON
  ▼
/api/pet-glb
  │ owner checks + bounded schemas + idempotency
  ▼
PetGlbService
  ├── PetGlbOrderRepository
  ├── PetGlbStageRepository
  ├── credit_transactions + users wallet
  ├── Staged Tripo provider adapter
  ├── stage-aware GLB validator
  └── canonical asset service
         ├── private Backblaze object
         ├── assets
         └── immutable asset_versions
```

Tripo is the organic pet/humanoid reconstruction provider. Provider URLs and task
handles remain internal. The in-house hard-surface generator is a different lane
and is not called by this product.

## Customer state machine

```text
awaiting_references
  → awaiting_reference_approval
  → base_queued
  → base_generating
  → awaiting_base_approval
  → texture_queued                 (when texture selected)
  → texture_generating
  → awaiting_texture_approval
  → rig_checking                   (when rig selected)
  → awaiting_rig_purchase
  → rig_queued
  → rig_generating
  → awaiting_rig_approval
  → awaiting_human_review
  → approved
  → delivering
  → delivered
```

Failure and correction states are explicit:

```text
*_generating → stage_failed
awaiting_*_approval → stage_rejected → retry of the same stage
provider accepted / persistence uncertain → recovery_required
operator decision → repair_required
```

There is no automatic path across a customer approval state.

## Stages and commercial events

| Stage | Provider operation | Customer gate | Pawsome3D price | Canonical result |
|---|---|---|---:|---|
| Reference | none | Approve exact reference manifest | 0 | manifest SHA-256 |
| Base | image/multiview to model, texture/PBR off | Approve blank mesh | 45 PupCoins | immutable untextured GLB |
| Texture | texture model | Approve texture/materials | 8 PupCoins | immutable textured GLB |
| Rig readiness | pre-rig check | Shows actual supported rig type | 0 | capability report |
| Rig | animate rig | Approve skeleton/weights | 35 PupCoins | immutable rigged GLB |
| Facial | disabled | none | not for sale | none |

Prices come from `src/pricing.ts`/the server pricing module. The browser never
submits a price.

## Generation profiles

### HD

- Provider generation model: `TRIPO_HD_MODEL_VERSION`, default
  `v3.1-20260211`.
- Base request: texture false, PBR false, standard geometry quality.
- Target face limit: 100,000.
- Delivery hard maximum: 150,000 measured triangles.
- Intended use: high-detail visual model and high-resolution texturing.

### SmartMesh

- Provider generation model: `TRIPO_SMARTMESH_MODEL_VERSION`, default
  `P1-20260311`.
- Base request: texture false, PBR false.
- Target face limit: 8,000.
- Delivery hard maximum: 10,000 measured triangles.
- Intended use: lighter web/mobile/game-style model.

The validator reads the GLB accessor data and reports actual triangles. A profile
label is not evidence.

## Subject profiles

| UI option | Stored value | Rig request | Claim |
|---|---|---|---|
| Pet / animal | `pet` | `spec=tripo`, `rig_type=quadruped` | animal skeleton when pre-rig and rig validation pass |
| Humanoid character | `humanoid` | `spec=tripo`, `rig_type=biped` | biped skeleton when pre-rig and rig validation pass |

“Humanoid intelligence” is expressed as a humanoid character/rig profile, not as
an embedded AI claim. Agent behavior is not inside the GLB.

## Style contract

`styleDirection`:

- optional;
- plain text only;
- 400 Unicode code points maximum;
- stored with the order configuration;
- included in the reference/configuration hash;
- sent only as `texture_prompt.text` during `texture_model`;
- never executed and never inserted into paths, SQL, shell, or Blender code.

Supported UI presets are honest prompt helpers:

- Reference-faithful
- Soft stylized
- Toy collectible
- Studio realistic

Custom text can describe color, surface, fur/material treatment, and artistic
finish. It does not alter approved body geometry.

## Facial capability policy

The product API returns:

```json
{
  "facialRig": {
    "available": false,
    "minimumSuccessRate": 0.75,
    "reason": "No validated production cohort meets the release threshold."
  }
}
```

Availability later requires a versioned capability report containing at least:

- fixture cohort and sample count;
- morph-target names and coverage;
- neutral-pose deformation result;
- lip/jaw anatomical checks;
- exact GLB hash;
- successes / attempts;
- observed success rate at or above 0.75.

Until then no checkbox, charge, provider call, or misleading fallback appears.

## Persistence

### Existing retained tables

- `pet_glb_orders`: commercial order and current high-level state.
- `pet_glb_order_events`: append-only order transitions.
- `provider_generation_jobs`: local job to private provider handle mapping.
- `assets` / `asset_versions`: canonical ownership and immutable files.
- `credit_transactions`: wallet ledger with idempotency keys.

### New stage table

`pet_glb_stage_attempts` contains:

- attempt UUID, order ID, stage, attempt number;
- state and input hash;
- local provider job ID;
- source stage attempt ID;
- asset ID/version ID and artifact SHA-256;
- validation report JSON and report SHA-256;
- capability report JSON;
- price and credit disposition;
- idempotency key;
- customer approval actor/time/hash;
- failure code and timestamps.

Unique constraints prevent duplicate attempts and duplicate charge/approval keys.

### Order configuration

New order columns hold:

- mesh profile;
- subject profile;
- texture and rig selections;
- bounded style direction;
- current stage;
- final customer-approved version.

Facial selection is not stored because the feature is unavailable.

## API mapping

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/pet-glb/product` | server prices, profiles, limits, facial availability |
| POST | `/api/pet-glb/orders` | create uncharged configured order |
| GET | `/api/pet-glb/orders/:uuid` | owner-scoped order + current stage summary |
| POST | `/api/pet-glb/orders/:uuid/references` | save bounded reference manifest |
| POST | `/api/pet-glb/orders/:uuid/stages/reference/approve` | hash-bound approval; charge and start base |
| POST | `/api/pet-glb/orders/:uuid/stages/:stage/poll` | poll only current attempt; persist completed artifact |
| GET | `/api/pet-glb/orders/:uuid/stages/current/preview` | signed URL for owned stage candidate |
| POST | `/api/pet-glb/orders/:uuid/stages/:stage/approve` | hash-bound customer gate; start next selected stage |
| POST | `/api/pet-glb/orders/:uuid/stages/:stage/reject` | record correction request and allow bounded retry |
| GET | `/api/pet-glb/operator/queue` | operator-only final candidates |
| GET | `/api/pet-glb/operator/orders/:uuid/preview` | operator-only signed preview of the exact customer-approved version |
| POST | `/api/pet-glb/operator/orders/:uuid/approve` | bind final approved immutable version |
| POST | `/api/pet-glb/orders/:uuid/download` | signed URL for exact delivered version |

Every mutating stage request carries an idempotency key. Every model approval
carries attempt UUID, artifact SHA-256, asset-version ID, and report SHA-256.

## Validation profiles

### Base

- valid GLB 2 container;
- scene and non-empty mesh;
- finite, self-contained data;
- actual triangle count within chosen profile;
- no requirement for materials, skin, or animation.

### Texture

- every base requirement;
- at least one material;
- texture/image reference or PBR material evidence;
- texture stage lineage points to approved base attempt.

### Rig

- every texture/base requirement;
- one or more skins;
- joint nodes exist;
- JOINTS_0 and WEIGHTS_0 match on skinned primitives;
- requested `rig_type` matches capability/metadata;
- no idle/walk requirement for the rig add-on.

### Operator gate

The operator release panel shows the five references, exact final candidate,
selected profile, price, and final validation checks. Operator approval cannot
select an arbitrary version.

## Security and reliability invariants

- Authentication and ownership precede all provider/storage calls.
- Reference URLs are bounded HTTPS/data inputs and are uploaded to Tripo; provider
  receives no reusable storage credentials.
- The same API key creates and polls a Tripo task.
- Task handles and expiring output URLs never leave server persistence.
- Every completed stage is mirrored before approval.
- Stage charges use wallet row locks and idempotent ledger keys.
- Provider submission occurs outside long MySQL transactions.
- A failed provider start refunds only that stage, once.
- A successful provider task with uncertain persistence enters
  `recovery_required`; it is not blindly resubmitted.
- Customer and operator approvals are distinct and both owner/role checked.
- Signed links are short-lived and generated only for authorized versions.

## Deployment configuration

Existing:

- `PET_GLB_ENABLED=true`
- `TRIPO_API_KEY`
- private Backblaze variables required by `storage.private.ts`
- database variables

New optional overrides:

- `TRIPO_HD_MODEL_VERSION=v3.1-20260211`
- `TRIPO_SMARTMESH_MODEL_VERSION=P1-20260311`
- `TRIPO_RIG_MODEL_VERSION=v2.5-20260210`
- `PET_GLB_HD_FACE_LIMIT=100000`
- `PET_GLB_HD_MAX_TRIANGLES=150000`
- `PET_GLB_SMARTMESH_FACE_LIMIT=8000`
- `PET_GLB_SMARTMESH_MAX_TRIANGLES=10000`

Defaults are code-owned and validated; missing optional overrides do not produce an
undefined provider request.
