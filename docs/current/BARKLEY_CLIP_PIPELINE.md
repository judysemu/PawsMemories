# Barkley clip pipeline

How the presenter's animation clips get from Tripo into `public/barkley/`.

Barkley needs the 30 clips specified in `src/barkley/shows.ts`. Roughly half can
come from Tripo's preset library; the rest are presenter-specific and have to be
authored. This is the route for the half that can be sourced.

## What is done

17 presets exported and stripped into 17 clip files (one preset can serve two
clips). `stretch` and `bow` were exported but map to nothing in the spec and are
not shipped.

| Clip in shows.ts | Tripo preset | Seconds |
| --- | --- | --- |
| `idle` | `idle` | 15.38 |
| `walk_forward` | `walk` | 2.38 |
| `turn_left`, `turn_right` | `turn` | 3.88 |
| `nod_yes` | `agree` | 4.04 |
| `wave_bye` | `wave_goodbye_01` | 6.63 |
| `wave_hello` | `greet_02` | 5.63 |
| `react_quiz_yes` | `cheer` | 12.13 |
| `curious_lean`, `react_drag` | `look_around` | 15.63 |
| `clap` | `clap` | 13.71 |
| `laugh` | `laugh_01` | 5.63 |
| `excited_jump` | `jump` | 2.25 |
| `surprised` | `frightened` | 3.42 |
| `think` | `fold_arms` | 17.13 |
| `gesture_present` | `cast_a_spell` | 5.42 |
| `gesture_shrug` | `complain_01` | 6.33 |

`turn_left` and `turn_right` are the same clip written twice; **mirror one about
the Y axis at runtime** rather than paying for a second export.

## Generated in Tripo but NOT yet exported

These presets are already retargeted onto Barkley (they show a checkmark in the
Animate panel) and only need the export-and-strip steps below. **Do these before
authoring anything** — they are free and cover 6 more clips:

| Clip in shows.ts | Tripo preset | Note |
| --- | --- | --- |
| `talk_normal` | `sing_01` | Singing is the closest thing to gesturing while speaking |
| `talk_emphasize` | `sing_02` | |
| `talk_explain` | `sing_03` | `sing_04` is a spare fourth variant |
| `open_arms` | `hug` | Arms sweep wide |
| `hands_together` | `heart_pose` | Hands meet in front of the chest |
| `react_quiz_no` | `depressed` | Gentle "not quite" |

`bow` is also generated and exported but maps to nothing in the spec.

## Still to author (7)

Only these have no library equivalent at all:

`point_left`, `point_right`, `gesture_count`, `gesture_thumbs_up`,
`shake_head`, `react_click`, and `gesture_up`.

The earlier estimate of sixteen was wrong: it only considered the **Basic**
category. Tripo's Interactive, Scene Specific and Emotional categories hold
~100 more presets, and several map cleanly onto presenter behaviour. Search the
Animate panel before concluding a clip must be hand-built — and note the
category filter row **scrolls horizontally**, so "All" can be off-screen and
searches will silently return nothing while a narrow category is selected.

Author them as bone keyframes following the pattern in
`blender-worker/skeletal-clips-human.js`, which already generates 15 humanoid
clips procedurally. Note that module runs at **24 fps** while `shows.ts`
specifies frame ranges at **30** — set 30 explicitly in any new Barkley module
or every duration is off by 25%.

## The route

### 1. Rig in Tripo

Model type **Humanoid**. Tripo's auto-rigger emits 41 joints in PascalCase
side-prefixed names (`L_Upperarm`, `R_Calf`, `Spine01`), which
`blender-worker/bonemap.human.json` maps to the canonical biped names. All 19
canonical bones resolve against Barkley's rig.

### 2. Generate any presets that are missing

The export dialog only offers presets already applied to the model. Search for
one in the left panel and click it; it retargets in ~15s. This was **free** on a
Pro membership — the credit balance did not move for either generation or
export.

### 3. Export one preset per file

Do **not** export several at once. Tripo's GLB export drops the preset name —
every animation arrives called `NlaTrack.NNN` — so a multi-animation file cannot
be mapped back without guessing. One preset per file makes the *filename* the
identity.

In the Export dialog: Format **GLB**, Texture **2k**, Export Skeleton **on**,
Number of Animations **1**, and set File Name to `barkley-<preset>`.

**"Animation stay in Place"** is root motion, and it is per-clip. Leave it **on**
for a standing presenter; turn it **off** for `walk`, which the spec describes as
walking toward camera. Verify afterwards — a real walk shows non-zero root
travel.

The toggle and the file name persist between exports, so re-check both each
time. Two clips were mis-named this way before the check was added.

### 4. Strip to animation-only

```bash
npx tsx scripts/manual/strip-barkley-clips.ts /Users/robert/barkley-clips --out public/barkley
```

Tripo exports a whole model per animation — mesh, material and a 2K texture
alongside a few KB of bone curves. The runtime does not need them: three.js
binds an AnimationClip to a skeleton it already has, by node name. Stripping
takes the set from **26.4 MB to 1.31 MB**.

The script also renames each animation to its `shows.ts` clip name, since Tripo
leaves them all called `NlaTrack`.

### 5. Check what is still missing

`server/barkley/featureFlag.ts` scans `public/barkley` for `<clipName>.glb` and
reports `missing` and `allReady`. Keep the rig source **out** of that directory —
a stray `barkley.glb` there registers as a phantom clip.

## Verifying an unknown GLB

`scripts/manual/identify-glb-animations.ts` reports a motion signature per
animation (root travel, hip rise, loop closure, per-limb rotation, head pitch vs
yaw). It narrows candidates but does not identify: it labelled the 2.25s
2.05-travel track "locomotion — walk/run" when it was actually `jump`. Treat its
output as a shortlist, never as a mapping.

Duration is the reliable fingerprint. An individually-exported preset tells you
which `NlaTrack.NNN` it is in any bundle you already have.

## Gotchas

- **The rig source belongs outside `public/barkley/`.** It is a whole model, not
  a clip.
- **Untracked GLBs at the repo root block `scripts/build-deploy-zip.sh`**, which
  requires a clean worktree.
- **`biped.standard.json` is wrong.** It lists `hip` and `leg_front.L/R` and has
  no arm joints — apparently derived from the dog profile and never adapted.
  Validate against `bonemap.human.json`, which is coherent.
- **glTF has no quad primitive.** Barkley's source mesh is quad topology
  (10,445 faces / 5,297 vertices), and the benefit is clean edge flow through
  the joints; the exported GLB is triangulated regardless.
