# Animation Agent Chain — idle + walk authoring for the paid pet GLB

Status: **DRAFT / Phase 1.** Owner-directed approach (2026-07-27): author the
idle/walk skeletal animation via a **Blender-driven agent chain** guided by real
animation-guidance documents and prompts. This is the piece that makes the
first paid pet GLB an *organic* sale rather than the `PET_GLB_VERIFY_MODE`
bypass shipped as scaffolding.

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
