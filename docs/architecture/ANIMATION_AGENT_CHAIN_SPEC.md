# Interactive 3D modeler + idle/walk animation for the paid pet GLB

Status: **DRAFT.** Direction locked with owner 2026-07-27.

**v1 animation path — Tripo-native (NOT the Blender chain).** Tripo already does
quadruped auto-rig + preset animation, and the client code exists: `startRig`
(`animate_rig`, UniRig quadruped) and `startRetarget` (`animate_retarget`,
`preset:idle` / `preset:walk` / `preset:run`) in `tripo.ts`. Wiring these into
the build pipeline yields real idle+walk skeletal clips, satisfies
`validatePetGlb`'s `idle_present`/`walk_present` gates for real, and lets
`PET_GLB_VERIFY_MODE` be deleted. This matches the owner decision "trust the
Tripo rig." The Blender agent chain (below) is DEFERRED to a later custom-motion
quality upgrade, not v1.

**Product shape — one unified 3D modeler.** The UI presents a single 3D modeler
(Tripo/Meshy-style studio). The customer buys the GLB either:
- **Step by step** — Tripo's pipeline is exposed as user-gated stages; the build
  pauses after each and the customer selects the next move.
- **"Do it for me"** — the full pipeline runs automatically to a rigged +
  idle/walk-animated GLB.

### Tripo pipeline stages (each a gated step in step-by-step mode)
1. **Base model** (grey) — `multiview_to_model` with `texture:false` → bare grey
   structure.
2. **Texture** — `texture:true`, PBR, `texture_quality:"detailed"`.
3. **Triangular topo** — Tripo's native triangulated output (do NOT set
   `quad:true` — it forces FBX). Exposed as the "topo" step.
4. **Retopo / segmentation** — follow-on tasks.
5. **Rig** — `animate_rig` (UniRig quadruped; `spec:"tripo"`).
6. **Animate** — `animate_retarget` `preset:idle` and `preset:walk`.

### Known complexity — clip merge
`animate_retarget` returns ONE animation per call, so `idle` and `walk` arrive as
TWO separate GLBs. `validatePetGlb` requires BOTH clips in ONE delivered GLB, so
a merge step is needed (mesh/skin from the rig output + both AnimationClips).
Options: `gltf-transform` merge, the existing Three.js `retargetUtils` path, or a
Blender worker merge. This merge is the one genuinely new piece for v1 animation.

### Retry rule (owner, 2026-07-27)
Paid retry = **20 credits, inputs LOCKED** (same prompt + images; cosmetic
re-roll). Distinct from the free internal/system retry. Contradicts arch
invariant #4 — implement as a separate customer-paid-reroll path, not by relaxing
the no-double-charge guard.

---

## DEFERRED — Blender agent chain (later custom-motion upgrade)

Kept for when Tripo presets are not enough. Original approach: author idle/walk
via a Blender-driven agent chain guided by animation-guidance documents/prompts.

## Why this exists

`validatePetGlb` (`server/pet-generation/validation.ts`) makes `idle_present`
and `walk_present` **hard gates** — a delivered model must carry animation clips
whose names contain `idle` and `walk`. Raw Tripo output does not: validating two
real production GLBs showed one with Veo-derived themed content and one with zero
skeletal animations. The clips the customer was shown historically (drinking,
eating, playing, running, sleeping) were **Veo video**, not skeletal clips — so
there is nothing to reuse. The retarget seam that would apply real clips
(`POST /api/animator/retarget`, `server/animator/routes.ts:545`) is a `501`
stub. This spec closes that gap.

## What already exists (build on, do not reinvent)

- `src/animator/utils/retargetUtils.ts` — `retargetClip(tgtRig, srcRig, srcClip, skeletonType)`.
  Three.js clip retargeter: bone-name mapping via `SKELETON_CONTRACTS`, frame
  padding to clip duration. Covered by `tests/clip_retarget.test.mjs` (passing).
  Client-side today; its logic is the reference for the server/Blender port.
- `skeletonContract.ts` — `SKELETON_CONTRACTS[skeletonType].allBones`: canonical
  bone vocabulary per skeleton (`quadruped`, `biped`).
- `blender-worker/rig_pipeline/pipeline.py` (rigging), `bonemap.json` (quadruped
  bone map), `validation.py`. The Blender worker this chain extends.
- `server/animator/clips.ts` — `CC0_CLIPS` contract:
  `/animator-files/animations/{skeleton}_{clip}_cc0.glb`. **Source clip GLBs are
  not in the repo** — acquiring/normalizing canonical `quadruped_idle` and
  `quadruped_walk` is a Phase 1 deliverable.
- Guidance corpus: `NEED_REVIEW/3D_Animation_LipSync_Rigging_Sources.md` —
  curated mocap (CMU, Bandai-Namco, MocapOnline quadruped), auto-rig (Rigify,
  Auto-Rig Pro, Tripo auto-rig, UniRig, RigNet), and retarget (Cascadeur,
  DeepMotion, Rokoko) sources that seed the agents' knowledge and fallbacks.

## The chain

Runs per generated pet, inside the Blender worker, invoked from the pet pipeline
between Tripo `fetchArtifacts` and `validatePetGlb`.

### Agent A — Skeleton map (cold / deterministic, low temperature)
- Input: Tripo GLB (observed 22–25 joints).
- Detect armature; map bones → canonical `quadruped` contract
  (`skeletonContract.ts` + `bonemap.json`). Substring + synonym matching first
  (mirrors `retargetUtils` logic), auto-rig fallback (Rigify/UniRig) only when
  Tripo's rig is missing/degenerate.
- Output: `boneMap` + per-bone confidence + `unmatchedRequiredBones[]`.
- Fail-closed: if a required locomotion bone (spine, 4× leg chains) is unmatched,
  route to human review — never guess a load-bearing bone.

### Agent B — Gait authoring (hot / prompt-driven)
- Input: mapped skeleton + canonical `quadruped_idle` / `quadruped_walk` source
  clips.
- Retarget clips onto the target rig in Blender (server port of `retargetClip`),
  then apply the gait-plausibility prompts (below): foot-contact grounding, no
  floor-skate, symmetric stride, root-motion in place for idle.
- Output: GLB with animations named `idle` and `walk`, self-contained buffers.

### Agent C — Validation gate (cold)
- Runs `validatePetGlb` on B's output. `idle_present`, `walk_present`,
  `animation_targets_resolve`, and all structural gates must pass **for real**.
- Divergence guard: if B reports success but C fails, or confidence is low →
  order to `awaiting_human_review` with the honest report (operator decides),
  never auto-approve. Trace persisted per the `agent-chain-orchestration` skill.

## Prompt library (Phase 1 deliverable)

Lives in `docs/architecture/animation-prompts/`. Each prompt cites the guidance
corpus. Initial set:
- `skeleton-map.md` — map an arbitrary quadruped rig to the canonical contract;
  synonym table; when to fall back to auto-rig.
- `gait-plausibility.md` — foot contact, stride symmetry, no floor-skate, idle =
  breathing/weight-shift in place, walk = 4-beat gait; acceptance heuristics.
- `divergence-review.md` — what an operator must check when agents disagree.

## Wiring (Phase 4)

`server/pet-generation/service.ts::pollAndValidate`: after `fetchArtifacts`,
before `validatePetGlb`, call the animation chain; validate its output. On
success `operatorReady` is true on merit and `PET_GLB_VERIFY_MODE` is **removed**
(the flag and its routing branch are deleted, not left dormant).

## Validation / done criteria

- `validatePetGlb` passes `idle_present` + `walk_present` on real chain output.
- `PET_GLB_VERIFY_MODE` deleted; strict routing is the only path.
- A real order traverses order → pay (credits) → uploaded photos → generate →
  **chain authors idle+walk** → validators pass → operator approve → download,
  with no scaffold flags set.

## Open questions for the owner

1. Source clips: acquire canonical `quadruped_idle`/`quadruped_walk` from the
   mocap sources in the guidance doc, or do you already have licensed clips to
   drop at `/animator-files/animations/`?
2. Auto-rig fallback: is Tripo's own auto-rigging reliable enough to skip a
   Rigify/UniRig fallback for v1?
