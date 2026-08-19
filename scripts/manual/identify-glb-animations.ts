#!/usr/bin/env -S npx tsx
/**
 * Identify unnamed animations inside a GLB by their motion signature.
 *
 * Tripo's rig export loses preset names: every clip arrives as "NlaTrack.NNN"
 * because Blender's NLA strips are what survive the export, not the labels.
 * shows.ts binds clips by name, so nothing can be wired up until each track is
 * identified — and scrubbing 22 clips by hand is slow and error-prone.
 *
 * The motion itself is diagnostic. A walk translates the root; a wave rotates
 * one arm and nothing else; a nod pitches the head; a clap moves both arms
 * symmetrically. This reads the animation buffers and reports those signatures
 * so each track can be matched against the spec.
 *
 *   npx tsx scripts/manual/identify-glb-animations.ts barkley-22.glb
 */
import fs from "fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npx tsx scripts/manual/identify-glb-animations.ts <file.glb>");
  process.exit(2);
}

// ── GLB container ────────────────────────────────────────────────
const buf = fs.readFileSync(file);
if (buf.readUInt32LE(0) !== 0x46546c67) {
  console.error(`${file} is not a GLB (bad magic).`);
  process.exit(2);
}
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.slice(20, 20 + jsonLen).toString("utf8"));
// The BIN chunk follows the JSON chunk, each with an 8-byte chunk header.
const binStart = 20 + jsonLen + 8;
const bin = buf.slice(binStart);

function readAccessor(index: number): number[][] {
  const acc = gltf.accessors[index];
  const view = gltf.bufferViews[acc.bufferView];
  const comps: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const n = comps[acc.type];
  if (acc.componentType !== 5126) return []; // only float data is meaningful here
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const out: number[][] = [];
  for (let i = 0; i < acc.count; i++) {
    const row: number[] = [];
    for (let c = 0; c < n; c++) row.push(bin.readFloatLE(base + (i * n + c) * 4));
    out.push(row);
  }
  return out;
}

/** Angle in degrees between two unit quaternions. */
function quatAngle(a: number[], b: number[]): number {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  d = Math.min(1, Math.abs(d));
  return (2 * Math.acos(d) * 180) / Math.PI;
}

const nodeName = (i: number) => (gltf.nodes[i] || {}).name || `node${i}`;

interface Track { name: string; seconds: number; rootTravel: number; hipRise: number;
  loopGap: number; movers: [string, number][]; leftArm: number; rightArm: number;
  head: number; headPitch: number; headYaw: number; }

const tracks: Track[] = [];

for (const anim of gltf.animations || []) {
  let seconds = 0;
  let rootTravel = 0;
  let hipRise = 0;
  let loopGap = 0;
  const rot: Record<string, number> = {};

  let headPitch = 0;
  let headYaw = 0;

  for (const ch of anim.channels || []) {
    const sampler = anim.samplers[ch.sampler];
    const times = readAccessor(sampler.input);
    if (times.length) seconds = Math.max(seconds, times[times.length - 1][0]);
    const values = readAccessor(sampler.output);
    if (values.length < 2) continue;
    const name = nodeName(ch.target.node);

    if (ch.target.path === "translation") {
      let dist = 0;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 1; i < values.length; i++) {
        const [x1, y1, z1] = values[i - 1];
        const [x2, y2, z2] = values[i];
        dist += Math.hypot(x2 - x1, y2 - y1, z2 - z1);
        minY = Math.min(minY, y1, y2);
        maxY = Math.max(maxY, y1, y2);
      }
      if (/root|hip|pelvis/i.test(name)) {
        rootTravel = Math.max(rootTravel, dist);
        hipRise = Math.max(hipRise, maxY - minY);
      }
    }

    if (ch.target.path === "rotation") {
      let total = 0;
      for (let i = 1; i < values.length; i++) total += quatAngle(values[i - 1], values[i]);
      rot[name] = (rot[name] || 0) + total;
      // Distance between the first and last pose: a loop returns to its start.
      loopGap = Math.max(loopGap, quatAngle(values[0], values[values.length - 1]));
      if (/head|neck/i.test(name)) {
        // Compare which euler-ish axis carries the motion: nodding pitches
        // about X, shaking yaws about Y.
        let px = 0;
        let py = 0;
        for (let i = 1; i < values.length; i++) {
          px += Math.abs(values[i][0] - values[i - 1][0]);
          py += Math.abs(values[i][1] - values[i - 1][1]);
        }
        headPitch += px;
        headYaw += py;
      }
    }
  }

  const sum = (re: RegExp) =>
    Object.entries(rot).filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v, 0);

  tracks.push({
    name: anim.name || "(unnamed)",
    seconds,
    rootTravel,
    hipRise,
    loopGap,
    movers: Object.entries(rot).sort((a, b) => b[1] - a[1]).slice(0, 3) as [string, number][],
    leftArm: sum(/^L_(Clavicle|Upperarm|Forearm|Hand)$/i),
    rightArm: sum(/^R_(Clavicle|Upperarm|Forearm|Hand)$/i),
    head: sum(/head|neck/i),
    headPitch,
    headYaw,
  });
}

/** Best-guess label from the signature. Deliberately conservative: it suggests
 *  a family, and says so, rather than inventing a specific clip name. */
function classify(t: Track): string {
  const armTotal = t.leftArm + t.rightArm;
  const asym = armTotal > 0 ? Math.abs(t.leftArm - t.rightArm) / armTotal : 0;
  const loops = t.loopGap < 15;

  if (t.rootTravel > 0.5) return loops ? "LOCOMOTION loop (walk/run)" : "LOCOMOTION one-shot";
  if (t.hipRise > 0.15) return "JUMP / crouch (vertical hip travel)";
  if (t.head > armTotal * 1.5) {
    if (t.headPitch > t.headYaw * 1.4) return "HEAD pitch — nod_yes";
    if (t.headYaw > t.headPitch * 1.4) return "HEAD yaw — shake_head";
    return "HEAD motion (think / curious_lean)";
  }
  if (armTotal > 0) {
    if (asym > 0.35) return `ONE-ARM (${t.leftArm > t.rightArm ? "left" : "right"}) — wave/point`;
    if (loops) return "TWO-ARM loop — talk/idle gesture";
    return "TWO-ARM one-shot — clap/open_arms/present";
  }
  return loops ? "SUBTLE loop — idle" : "SUBTLE one-shot";
}

tracks.sort((a, b) => a.seconds - b.seconds);

console.log(`${file} — ${tracks.length} animations\n`);
console.log("track            secs  travel  rise  loop?  L-arm  R-arm  head   best guess");
console.log("-".repeat(104));
for (const t of tracks) {
  console.log(
    t.name.padEnd(16) +
      t.seconds.toFixed(1).padStart(5) +
      t.rootTravel.toFixed(2).padStart(8) +
      t.hipRise.toFixed(2).padStart(6) +
      (t.loopGap < 15 ? "  yes" : "   no").padStart(7) +
      Math.round(t.leftArm).toString().padStart(7) +
      Math.round(t.rightArm).toString().padStart(7) +
      Math.round(t.head).toString().padStart(7) +
      "   " + classify(t)
  );
}
console.log(`\nTop moving bones per track:`);
for (const t of tracks) {
  console.log(`  ${t.name.padEnd(16)} ${t.movers.map(([n, v]) => `${n}(${Math.round(v)})`).join(", ")}`);
}
console.log(`
Columns: travel = root distance moved · rise = vertical hip range ·
loop? = final pose returns to the first · L/R-arm and head = total degrees rotated.
These are signatures, not identifications — confirm in a viewer before binding a
name into shows.ts.`);
