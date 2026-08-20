#!/usr/bin/env -S npx tsx
/**
 * Authors a Barkley animation clip on the Azure Blender worker.
 *
 * No local Blender required: the worker already runs headless Blender 5.1.2
 * behind a TCP bridge and exposes /import-glb, /execute and /export-glb. This
 * uploads the rigged model, keyframes bones with generated Python, and pulls
 * the finished GLB back.
 *
 *   npx tsx scripts/manual/author-barkley-clip.ts point_right --out /tmp/clips
 *
 * Rig note: Tripo's auto-rig gives Barkley 41 joints with L_Hand/R_Hand and
 * NO finger bones. Clips needing finger articulation — gesture_count, and a
 * true gesture_thumbs_up — cannot be authored against this rig at all. They
 * need a rig with hands, not a different keyframe.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";

const WORKER = process.env.BLENDER_WORKER_URL
  || "https://pawsome3d-blender-worker.ambitiousforest-08789dd3.eastus.azurecontainerapps.io";
const SECRET = (process.env.WORKER_SHARED_SECRET || "").trim();

const clipName = process.argv[2];
const outFlag = process.argv.indexOf("--out");
const OUT = outFlag > 0 ? process.argv[outFlag + 1] : "/tmp/clips";
const srcFlag = process.argv.indexOf("--src");
const SRC = srcFlag > 0 ? process.argv[srcFlag + 1] : "/Users/robert/barkley-clips/barkley-idle.glb";

const FPS = 30;

/** Keyframes as [frame, bone, [rx,ry,rz] degrees]. Authored against the Tripo
 *  bone names, which bonemap.human.json maps to canonical biped names. */
interface Pose { frame: number; bone: string; rot: [number, number, number] }
interface ClipSpec { name: string; frames: number; loop: boolean; poses: Pose[] }

/**
 * Barkley's bind pose is a T-pose: arms straight out to the sides. Any bone a
 * clip does not keyframe stays there, so the first authored clip came back with
 * the pointing arm raised and the other arm still splayed horizontally. Every
 * clip therefore starts from an explicit neutral — arms down at the sides —
 * and moves from that, rather than from the rig's rest position.
 */
const NEUTRAL: Pose[] = [
  { frame: 0, bone: "L_Clavicle", rot: [0, 0, -4] },
  { frame: 0, bone: "R_Clavicle", rot: [0, 0, 4] },
  { frame: 0, bone: "L_Upperarm", rot: [0, 0, -72] },
  { frame: 0, bone: "R_Upperarm", rot: [0, 0, 72] },
  { frame: 0, bone: "L_Forearm",  rot: [0, 12, -10] },
  { frame: 0, bone: "R_Forearm",  rot: [0, -12, 10] },
];

/** Holds the neutral for bones a clip never animates, so they stay down. */
function withNeutral(poses: Pose[], frames: number): Pose[] {
  const touched = new Set(poses.map((p) => p.bone));
  const held: Pose[] = [];
  for (const n of NEUTRAL) {
    if (touched.has(n.bone)) continue;
    held.push({ ...n, frame: 0 }, { ...n, frame: frames });
  }
  return [...held, ...poses];
}

const CLIPS: Record<string, ClipSpec> = {
  // 60 frames = 2.0s at 30fps, matching shows.ts frameRange [0,60].
  point_right: {
    name: "point_right", frames: 60, loop: false,
    poses: [
      // Start at neutral, arm hanging down at the side.
      { frame: 0,  bone: "R_Clavicle", rot: [0, 0, 4] },
      { frame: 0,  bone: "R_Upperarm", rot: [0, 0, 72] },
      { frame: 0,  bone: "R_Forearm",  rot: [0, -12, 10] },
      { frame: 0,  bone: "Spine02",    rot: [0, 0, 0] },
      // Swing up and forward. Z=0 is the T-pose (hand at shoulder height), so
      // pointing is a partial return toward zero, not a further rotation:
      // Z=+22 lands the hand just below the shoulder, X swings it forward off
      // the body so the arm reads as indicating something, not just lowered.
      { frame: 24, bone: "R_Clavicle", rot: [0, 0, -6] },
      { frame: 24, bone: "R_Upperarm", rot: [26, 0, 22] },
      { frame: 24, bone: "R_Forearm",  rot: [0, -8, 4] },
      { frame: 24, bone: "Spine02",    rot: [0, 10, 0] },
      // Slight overshoot, then settle — a hard stop reads as robotic.
      { frame: 34, bone: "R_Upperarm", rot: [30, 0, 15] },
      { frame: 46, bone: "R_Clavicle", rot: [0, 0, -5] },
      { frame: 46, bone: "R_Upperarm", rot: [26, 0, 20] },
      { frame: 46, bone: "R_Forearm",  rot: [0, -8, 5] },
      { frame: 46, bone: "Spine02",    rot: [0, 9, 0] },
      { frame: 60, bone: "R_Clavicle", rot: [0, 0, -5] },
      { frame: 60, bone: "R_Upperarm", rot: [26, 0, 20] },
      { frame: 60, bone: "R_Forearm",  rot: [0, -8, 5] },
      { frame: 60, bone: "Spine02",    rot: [0, 9, 0] },
    ],
  },

  // Mirror of point_right. The arms are NOT mirrored in rotation sign: X+ swings
  // both arms forward, but Z lowers the right arm and raises the left, so only
  // the Z term flips.
  point_left: {
    name: "point_left", frames: 60, loop: false,
    poses: [
      { frame: 0,  bone: "L_Clavicle", rot: [0, 0, -4] },
      { frame: 0,  bone: "L_Upperarm", rot: [0, 0, -72] },
      { frame: 0,  bone: "L_Forearm",  rot: [0, 12, -10] },
      { frame: 0,  bone: "Spine02",    rot: [0, 0, 0] },
      { frame: 24, bone: "L_Clavicle", rot: [0, 0, 6] },
      { frame: 24, bone: "L_Upperarm", rot: [26, 0, -22] },
      { frame: 24, bone: "L_Forearm",  rot: [0, 8, -4] },
      { frame: 24, bone: "Spine02",    rot: [0, -10, 0] },
      { frame: 34, bone: "L_Upperarm", rot: [30, 0, -15] },
      { frame: 46, bone: "L_Clavicle", rot: [0, 0, 5] },
      { frame: 46, bone: "L_Upperarm", rot: [26, 0, -20] },
      { frame: 46, bone: "L_Forearm",  rot: [0, 8, -5] },
      { frame: 46, bone: "Spine02",    rot: [0, -9, 0] },
      { frame: 60, bone: "L_Clavicle", rot: [0, 0, 5] },
      { frame: 60, bone: "L_Upperarm", rot: [26, 0, -20] },
      { frame: 60, bone: "L_Forearm",  rot: [0, 8, -5] },
      { frame: 60, bone: "Spine02",    rot: [0, -9, 0] },
    ],
  },

  // Right arm swings overhead. Z=0 is shoulder height, so anything negative on
  // the right arm carries the hand above the shoulder. Head tips back to follow
  // the hand (Head X+ tilts the muzzle up).
  gesture_up: {
    name: "gesture_up", frames: 60, loop: false,
    poses: [
      { frame: 0,  bone: "R_Clavicle", rot: [0, 0, 4] },
      { frame: 0,  bone: "R_Upperarm", rot: [0, 0, 72] },
      { frame: 0,  bone: "R_Forearm",  rot: [0, -12, 10] },
      { frame: 0,  bone: "Head",       rot: [0, 0, 0] },
      { frame: 26, bone: "R_Clavicle", rot: [0, 0, -10] },
      { frame: 26, bone: "R_Upperarm", rot: [10, 0, -52] },
      { frame: 26, bone: "R_Forearm",  rot: [0, -6, -8] },
      { frame: 26, bone: "Head",       rot: [9, 0, 0] },
      { frame: 36, bone: "R_Upperarm", rot: [10, 0, -60] },
      { frame: 48, bone: "R_Clavicle", rot: [0, 0, -9] },
      { frame: 48, bone: "R_Upperarm", rot: [10, 0, -55] },
      { frame: 48, bone: "Head",       rot: [8, 0, 0] },
      { frame: 60, bone: "R_Clavicle", rot: [0, 0, -9] },
      { frame: 60, bone: "R_Upperarm", rot: [10, 0, -55] },
      { frame: 60, bone: "R_Forearm",  rot: [0, -6, -8] },
      { frame: 60, bone: "Head",       rot: [8, 0, 0] },
    ],
  },

  // Head yaw only. Y is the Head bone's own axis — rotating it moved the bone
  // tail by 0.0000 on every component, which is the signature of the twist
  // axis. X nods and Z tilts sideways; neither reads as "no".
  shake_head: {
    name: "shake_head", frames: 60, loop: false,
    poses: [
      { frame: 0,  bone: "Head",        rot: [0, 0, 0] },
      { frame: 10, bone: "Head",        rot: [0, 20, 0] },
      { frame: 24, bone: "Head",        rot: [0, -20, 0] },
      { frame: 38, bone: "Head",        rot: [0, 16, 0] },
      { frame: 50, bone: "Head",        rot: [0, -9, 0] },
      { frame: 60, bone: "Head",        rot: [0, 0, 0] },
      // The neck carries a fraction of the motion, delayed, so the head does
      // not swivel on a rigid post.
      { frame: 0,  bone: "NeckTwist01", rot: [0, 0, 0] },
      { frame: 16, bone: "NeckTwist01", rot: [0, 7, 0] },
      { frame: 30, bone: "NeckTwist01", rot: [0, -7, 0] },
      { frame: 44, bone: "NeckTwist01", rot: [0, 5, 0] },
      { frame: 60, bone: "NeckTwist01", rot: [0, 0, 0] },
    ],
  },

  // A short perk-up: head snaps to attention and the right hand jabs forward,
  // then relaxes back toward neutral. Shorter than the others on purpose.
  react_click: {
    name: "react_click", frames: 45, loop: false,
    poses: [
      { frame: 0,  bone: "R_Clavicle", rot: [0, 0, 4] },
      { frame: 0,  bone: "R_Upperarm", rot: [0, 0, 72] },
      { frame: 0,  bone: "R_Forearm",  rot: [0, -12, 10] },
      { frame: 0,  bone: "Head",       rot: [0, 0, 0] },
      { frame: 8,  bone: "R_Clavicle", rot: [0, 0, -4] },
      { frame: 8,  bone: "R_Upperarm", rot: [48, 0, 34] },
      { frame: 8,  bone: "R_Forearm",  rot: [0, -10, 26] },
      { frame: 8,  bone: "Head",       rot: [5, 0, 0] },
      { frame: 16, bone: "R_Upperarm", rot: [56, 0, 30] },
      { frame: 16, bone: "R_Forearm",  rot: [0, -8, 6] },
      { frame: 30, bone: "R_Clavicle", rot: [0, 0, 2] },
      { frame: 30, bone: "R_Upperarm", rot: [16, 0, 60] },
      { frame: 30, bone: "R_Forearm",  rot: [0, -12, 12] },
      { frame: 30, bone: "Head",       rot: [1, 0, 0] },
      { frame: 45, bone: "R_Clavicle", rot: [0, 0, 4] },
      { frame: 45, bone: "R_Upperarm", rot: [0, 0, 72] },
      { frame: 45, bone: "R_Forearm",  rot: [0, -12, 10] },
      { frame: 45, bone: "Head",       rot: [0, 0, 0] },
    ],
  },
};
function buildPython(spec: ClipSpec): string {
  const poses = JSON.stringify(withNeutral(spec.poses, spec.frames));
  return `
import bpy, math, json

FPS = ${FPS}
bpy.context.scene.render.fps = FPS

arm = next((o for o in bpy.context.scene.objects if o.type == 'ARMATURE'), None)
if not arm:
    raise RuntimeError("no armature in scene")

# The worker keeps one long-running Blender process, so bpy.data survives between
# calls. Clearing the armature's animation_data is not enough: the actions
# themselves stay in the file and every one of them is written to the export.
# A first attempt shipped four animations in a single clip — the two NlaTracks
# that arrived with the import plus a leftover from an earlier failed run.
if arm.animation_data:
    arm.animation_data_clear()
for stale in list(bpy.data.actions):
    bpy.data.actions.remove(stale, do_unlink=True)
arm.animation_data_create()

action = bpy.data.actions.new(name="${spec.name}")
arm.animation_data.action = action

bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='POSE')

for pb in arm.pose.bones:
    pb.rotation_mode = 'XYZ'
    pb.rotation_euler = (0.0, 0.0, 0.0)

missing = []
for p in json.loads('''${poses}'''):
    pb = arm.pose.bones.get(p["bone"])
    if pb is None:
        missing.append(p["bone"]); continue
    pb.rotation_euler = tuple(math.radians(v) for v in p["rot"])
    pb.keyframe_insert(data_path="rotation_euler", frame=p["frame"])

bpy.ops.object.mode_set(mode='OBJECT')
bpy.context.scene.frame_start = 0
bpy.context.scene.frame_end = ${spec.frames}

def all_fcurves(act):
    # Blender 4.4+ replaced action.fcurves with slotted actions: curves now live
    # under layers -> strips -> channelbags. The worker runs 5.1, but keep the
    # legacy path so this script is not pinned to one Blender release.
    if getattr(act, "is_action_layered", False) or hasattr(act, "layers"):
        out = []
        for layer in act.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    out.extend(bag.fcurves)
        if out:
            return out
    return list(getattr(act, "fcurves", []))

# Ease the curves. Linear interpolation between poses is the single biggest
# reason hand-keyed motion reads as mechanical.
curves = all_fcurves(action)
for fc in curves:
    for kp in fc.keyframe_points:
        kp.interpolation = 'BEZIER'
        kp.easing = 'EASE_IN_OUT'

print("AUTHORED", json.dumps({
  "action": action.name,
  "actions_in_file": len(bpy.data.actions),
  "fcurves": len(curves),
  "keyframes": sum(len(fc.keyframe_points) for fc in curves),
  "frames": ${spec.frames},
  "missing_bones": missing,
}))
`;
}

async function call(endpoint: string, body: any): Promise<any> {
  const res = await fetch(`${WORKER}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-secret": SECRET },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${endpoint} -> ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

(async () => {
  const spec = CLIPS[clipName];
  if (!spec) {
    console.error(`Unknown clip "${clipName}". Available: ${Object.keys(CLIPS).join(", ")}`);
    process.exit(2);
  }
  if (!SECRET) { console.error("WORKER_SHARED_SECRET is not set in .env"); process.exit(2); }

  const health = await (await fetch(`${WORKER}/health`)).json();
  console.log(`worker: ${health.status} · Blender ${health.blenderVersion} · bridge ${health.bridge}`);

  console.log(`uploading ${path.basename(SRC)} (${(fs.statSync(SRC).size / 1048576).toFixed(1)} MB)…`);
  await call("/import-glb", { glb_base64: fs.readFileSync(SRC).toString("base64") });

  console.log(`authoring ${spec.name} (${spec.frames} frames @ ${FPS}fps)…`);
  const exec = await call("/execute", { code: buildPython(spec) });
  if (!exec.success) throw new Error(`execute failed: ${exec.error || exec.stderr}`);
  const line = String(exec.stdout || "").split("\n").find((l: string) => l.startsWith("AUTHORED"));
  const info = line ? JSON.parse(line.replace("AUTHORED ", "")) : {};
  console.log(`  action=${info.action} fcurves=${info.fcurves} keyframes=${info.keyframes}`);
  if (info.actions_in_file !== 1) {
    throw new Error(`expected exactly 1 action in the file, found ${info.actions_in_file} — stale state would ship multiple clips in one GLB`);
  }
  if (info.missing_bones?.length) {
    // A silently-skipped bone produces a clip that plays but does nothing —
    // worth failing loudly rather than shipping an empty animation.
    console.error(`  MISSING BONES: ${info.missing_bones.join(", ")}`);
  }

  console.log("exporting…");
  const out = await call("/export-glb", {});
  const b64 = out.glb_base64 || out.base64 || out.glb;
  if (!b64) throw new Error(`no GLB in export response: ${JSON.stringify(out).slice(0, 200)}`);

  fs.mkdirSync(OUT, { recursive: true });
  const dest = path.join(OUT, `barkley-${spec.name}.glb`);
  fs.writeFileSync(dest, Buffer.from(b64, "base64"));
  console.log(`wrote ${dest} (${(fs.statSync(dest).size / 1048576).toFixed(2)} MB)`);
})().catch((err) => { console.error(err?.message || err); process.exit(1); });
