# Production 3D Builder Sweep — 2026-07-30

Production target: `https://pawsome3d.com/create`

Last production build verified before this release: `d77fb4f348b31fcfba528b32ca5dda2b8101afbc`

This document distinguishes code verification from live production verification.
The fixes below require a new Hostinger deployment before they can be called live.

## Confirmed successes

| Area | Status | Evidence |
| --- | --- | --- |
| One-photo entry | PASS | One genuine PNG, JPEG, or WebP is enough. Extra angles are optional, and the source does not need to be square or 1024 × 1024. |
| Upload removal | PASS | Every uploaded model reference exposes a Remove action. |
| File integrity | PASS | The server inspects the decoded bytes and rejects a mislabeled PNG/JPEG/WebP before any paid model stage. |
| Five-view approval | PASS | One source produces Front, Left, Right, Rear, and Three-quarter views. The five-view manifest must be approved, or deliberately auto-approved, before the 45-PupCoin base stage starts. |
| Body/skeletal rig product | CODE PASS; LIVE NOT RUN | The 35-PupCoin body rig is now selectable with or without Texture. An untextured rig is validated for mesh, skin, joints, and weights without being falsely rejected for a missing texture. Base plus body rig quotes 80 PupCoins. |
| Facial blendshapes | CORRECTLY SEPARATE | The 75% measured-reliability policy applies only to facial blendshapes. It does not disable the animation-ready body/skeletal rig. |
| Collar billing boundary | FAIL-CLOSED | The UI, route, and authoritative `startJob` service boundary each require every worker component and the orchestrator to be ready. A stale or malformed result returns 503 before the job/credit transaction. |
| Reference request safety | CODE PASS | The reference path makes exactly five image calls per attempt, disables hidden SDK retries, uses a database advisory lock, allows one active attempt, and applies durable rolling limits. |
| Shared image-provider safety | CODE PASS | Every actual shared Gemini/Imagen image-output attempt now atomically reserves per-user daily, global daily, global cost, and global minute capacity in MySQL. Admin traffic is included; uploads, rejects, validation failures, and the disabled legacy avatar route consume nothing. |
| Legacy avatar fan-out | CLOSED WHEN PET GLB IS ON | With `PET_GLB_ENABLED=1`, stale `POST /api/avatars` clients are rejected before Gemini. That retired route was the largest remaining fan-out risk at 4–6 Pro calls per request. |
| Image model line | PASS | Gemini 2.x image model names are filtered out. Reference views use dedicated `gemini-3.1-flash-image`; the shared chain uses the configured Gemini 3.x models. |

## Items that are not green

| Area | Status | Reason |
| --- | --- | --- |
| Previously charged base order `08a609e4…` | UNCONFIRMED | It was last observed running. A charge or running state is not proof that the provider completed, the GLB was mirrored and validated, or the customer received a review artifact. |
| Live body rig | NOT RUN | No additional PupCoins were spent in this code sweep. A production body-rig test still requires an approved base, an explicit 35-PupCoin authorization, Tripo pre-rig success, persisted GLB evidence, and customer review. |
| Live collar generation | BLOCKED SAFELY | `INHOUSE_SPATIAL_GENERATOR_ENABLED=true` only exposes the route. The current repository has no authenticated Pixel/Hermes worker evidence, no confirmed Blender-ready probe, and no scheduler that advances a newly created collar job through observe → plan → math → Blender → verify. The collar request also needs a completed source contract for an attachment job with no reference images. |
| Wags Plus image assets | BLOCKED SAFELY | A Plus box requires seven generated image assets. `WAGS_V2_ENABLED` must remain false until all seven calls can be reserved atomically; current Plus materialization exits before the first provider call instead of delivering a partial paid box. |
| Layer8 protection of Gemini image calls | NOT APPLICABLE | The five-view reference generator calls Gemini directly. Layer8 spatial throttling cannot limit that path. Pawsome3D must enforce its own caps. |

## Reference-image safety limits

One multiview attempt generates five images. Production defaults are:

| Variable | Default | Effective limit |
| --- | ---: | --- |
| `REFERENCE_GENERATION_GLOBAL_CONCURRENT_ATTEMPT_CAP` | `1` | One active five-view set across server processes |
| `REFERENCE_GENERATION_GLOBAL_MINUTE_ATTEMPT_CAP` | `2` | At most 10 reference-image calls admitted per rolling minute |
| `REFERENCE_GENERATION_USER_DAILY_ATTEMPT_CAP` | `3` | At most 15 reference-image calls per user per rolling 24 hours |
| `REFERENCE_GENERATION_GLOBAL_DAILY_ATTEMPT_CAP` | `20` | At most 100 reference-image calls globally per rolling 24 hours |
| `REFERENCE_GENERATION_MAX_ATTEMPTS` | `2` | At most two attempts for one reference session |
| `GEMINI_REFERENCE_IMAGE_MODEL` | `gemini-3.1-flash-image` | Dedicated reference-view model; it does not inherit the general Nano Banana Pro-first chain |

The Gemini SDK is configured for one HTTP attempt per angle. These limits cover
the five-view reference-session path; they must not be described as a global cap
for unrelated image features.

## Shared Gemini/Imagen image-call budget

The older avatar, memory editor, legacy reference, text preview, scene background,
Wags materializer, and disabled texture-stylization paths use a separate shared
provider-call boundary:

| Variable | Production value | Meaning |
| --- | ---: | --- |
| `PETSIM_IMAGE_GENERATION_ENABLED` | `true` | Master switch for shared image-output calls |
| `PETSIM_IMAGE_GENERATION_DAILY_CAP` | `5` | Actual provider calls per user/database UTC day |
| `PETSIM_IMAGE_GENERATION_GLOBAL_DAILY_CAP` | `50` | Actual provider calls across all users/database UTC day |
| `PETSIM_IMAGE_GENERATION_GLOBAL_MINUTE_CALL_CAP` | `10` | Actual shared provider calls per database-backed 60-second window |
| `PETSIM_IMAGE_GENERATION_ESTIMATED_COST_MICRO_USD` | `1000000` | Reserved upper-bound cost per call |
| `PETSIM_IMAGE_GENERATION_GLOBAL_DAILY_COST_MICRO_USD` | `50000000` | Global reserved-cost stop |

Fallback calls count separately because each fallback is another real provider
request. PupCoin-free/admin traffic does not bypass this provider budget. All
shared call counters are database-backed and survive restarts and multiple app
processes. The dedicated `gemini-3.1-flash-image` reference generator separately
allows two five-view attempts/minute (10 calls). Its counter is independent of
the shared Nano Banana Pro-first boundary and is not an atomic combined limit.

The observed **123 Nano Banana Pro requests** are consistent with the historical
five-view Pro-first implementation admitting roughly 24 complete attempts plus
part of another, or with legacy avatar fan-out. Exact attribution is unavailable
because historical successes were not tagged with route-level provider request
IDs. Layer8 could not have stopped either direct Gemini path.

## Bugs fixed in this release

1. Body rig selection was incorrectly cleared and disabled when Texture was off.
2. Rig validation incorrectly required texture evidence for every rigged GLB.
3. Body rig and facial blendshape language made the 75% facial policy look like
   a body-rig restriction.
4. Collar creation could reach a 50-PupCoin reservation before the unfinished
   worker chain was proven ready.
5. Spatial health was hidden behind the feature flag, making pre-enable checks
   impossible.
6. Reference generation had only process-local and per-route limits; it now has
   database-backed concurrency, minute, per-user, and global rolling limits.
7. The first cap implementation used a nonexistent attempt timestamp and a
   timezone-sensitive boundary. Regression tests now exercise the real MySQL
   schema and overlapping attempts.
8. Existing `PETSIM_IMAGE_GENERATION_*` variables were not wired to any code.
   They now reserve each actual shared image-provider call atomically.
9. Shared image routes used request-count limiters that did not bound provider
   fan-out and charged upload/reject/legacy-410 requests. Minute admission now
   occurs only at the durable provider-call boundary.
10. Gemini 2.x image fallbacks remained in the shared chain. The image boundary
    now accepts only the configured Gemini 3.x model names.

## Deliberate blockers

- Do not mark Collar green from the feature flag, a Layer8 tenant key, or a
  public health response alone.
- Do not charge a collar until authenticated Pixel/Hermes capability evidence,
  authenticated Blender readiness, the attachment source contract, and a real
  orchestrator/scheduler are connected.
- Do not mark body rig green from the selectable checkbox or quote alone.
- Keep `WAGS_V2_ENABLED=false` until a Plus box can reserve all seven image calls
  atomically; partial materialization is deliberately blocked.
- Do not spend PupCoins merely to test a path whose readiness gate is red.

## Credit boundary for this sweep

- New PupCoins spent by this code and verification pass: **0**.
- Earlier base order observed charged: **45 PupCoins** (`08a609e4…`), terminal
  outcome still unconfirmed here.
- Earlier failed order observed refunded: **45 PupCoins** (`c0f77662…`).
- Body rig, Texture, facial blendshapes, and Collar: **0 new PupCoins**.

## Deployment acceptance

After uploading the new deployment archive:

1. Confirm the live build manifest reports the new commit and Node `v24.18.x`.
2. Confirm `/api/spatial-generator/health` is admin-only, not cached, and reports
   `ready: false` until all explicit blockers are resolved.
3. Confirm an unready collar POST returns
   `503 SPATIAL_PIPELINE_NOT_READY` and leaves the PupCoin balance unchanged.
4. Confirm an untextured body rig can be selected and the quote is 80 PupCoins.
5. Do not execute the paid body-rig stage without a fresh explicit credit
   authorization.
6. Confirm a sixth shared image call for the same user/day is rejected before
   Gemini, and that the global database counters match provider-call logs.
7. Confirm an eleventh shared provider call inside one 60-second window is
   rejected, while an upload-only scene and a legacy-avatar 410 leave the minute
   counter unchanged.
