# Pawsome3D Project Skills

Coding agents must load the applicable skill before planning or editing its scope.
For the in-house spatial generator, read
`INHOUSE_SPATIAL_GENERATOR_ARCHITECTURE.md` first, then load every skill marked
required for the active phase.

| ID | Skill | Use when | Path |
|---|---|---|---|
| SPAT-001 | Pixel Gemma Worker | Implementing or operating the direct Pixel-to-Hermes math worker | `.codex/skills/pixel-gemma-worker/SKILL.md` |
| SPAT-002 | Gemma Mobile Latency | Selecting, benchmarking, or tuning Gemma on the Pixel | `.codex/skills/gemma-mobile-latency/SKILL.md` |
| SPAT-003 | Tripo Model API | Editing Tripo generation, polling, rigging, storage, or provider fallback boundaries | `.codex/skills/tripo-model-api/SKILL.md` |
| SPAT-004 | Spatial Generator Orchestration | Implementing Gemini observation, GPT planning, Gemma math, durable state, or billing | `.codex/skills/spatial-generator-orchestration/SKILL.md` |
| SPAT-005 | Visual Adherence Gate | Implementing draft renders, Gemini comparison, human approval, corrections, or evaluation data | `.codex/skills/visual-adherence-gate/SKILL.md` |
| SPAT-006 | Deterministic Blender Geometry | Compiling declarative plans, executing Blender, or validating GLB/STL outputs | `.codex/skills/deterministic-blender-geometry/SKILL.md` |
| SPAT-007 | Layer8 Spatial Gateway | Extending Layer8 to securely route the Gemini, GPT, and Hermes/Pixel spatial roles | `.codex/skills/layer8-spatial-gateway/SKILL.md` |
| SPAT-008 | Model Asset Licensing | Issuing, activating, validating, revoking, or auditing licenses for immutable model versions | `.codex/skills/model-asset-licensing/SKILL.md` |

## Required Skill Sets

- **Architecture/contracts:** SPAT-004, SPAT-005, SPAT-006, SPAT-007.
- **Hermes/Pixel phase:** SPAT-001, SPAT-002, SPAT-004, SPAT-007.
- **Provider observation/planning:** SPAT-004, SPAT-005, SPAT-007.
- **Draft/final Blender phase:** SPAT-004, SPAT-005, SPAT-006.
- **Fur Bin/marketplace licensing:** SPAT-008 plus the canonical asset and commerce
  contracts.
- **Tripo maintenance or organic reconstruction:** SPAT-003 plus the existing
  image-to-3D workflow guidance.
- **Provider migration:** SPAT-001 through SPAT-007. Prove that the in-house accessory lane
  makes zero Tripo calls and that the organic pet/human lane remains truthful.

## Global Rules

1. Gemini observes images; GPT creates declarative construction plans; Gemma on the
   Pixel resolves spatial math; deterministic code verifies every number; Blender
   constructs geometry.
2. Gemma is a required role, not a fallback. If the Pixel is unavailable, the math
   stage fails closed.
3. Never execute raw model-generated Python, shell, SQL, URLs, or file paths.
4. Absolute dimensions require an authoritative scale anchor.
5. Automated visual adherence and hash-bound human approval both gate finalization.
6. Tripo remains the organic reconstruction provider until an in-house replacement
   passes equivalent acceptance.
7. Keep the in-house generator default-off until the architecture exit gates pass.
8. Layer8 is the AI control plane, not the mesh engine. Keep Blender and binary
   artifact transfer outside its generic inference route.
9. Never confuse an AI tenant API key with a model asset license. Licenses bind to
   immutable canonical asset versions and file hashes.

## Existing Animator Skills

- `skills/animator/RIGGING.md`
- `skills/animator/LIPSYNC.md`
- `skills/animator/MESHOPS.md`

Those documents use the legacy skill format. Apply them only to animator work; they
do not replace SPAT-001 through SPAT-008.
