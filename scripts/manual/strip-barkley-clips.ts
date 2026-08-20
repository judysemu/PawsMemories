#!/usr/bin/env -S npx tsx
/**
 * Reduce Tripo clip exports to animation-only GLBs.
 *
 * Tripo exports one *whole model* per animation: mesh, material and a 2K
 * texture ride along with a few kilobytes of bone curves, so fourteen clips
 * weigh ~28 MB. The runtime does not need any of that — three.js plays an
 * AnimationClip against a skeleton it already has, matching tracks by node
 * name. Shipping the mesh fourteen more times is pure waste on a page that
 * already loads the textured model once.
 *
 * This keeps the node hierarchy (names are the binding contract) and the
 * animation data, and drops meshes, skins, materials, images and every
 * accessor that only served geometry.
 *
 *   npx tsx scripts/manual/strip-barkley-clips.ts <input-dir> [--out public/barkley]
 *
 * Input files are named barkley-<preset>.glb; outputs are named for the clip
 * in src/barkley/shows.ts, because server/barkley/featureFlag.ts scans
 * public/barkley for <clipName>.glb and reports anything missing.
 */
import fs from "fs";
import path from "path";

const inputDir = process.argv[2];
const outFlag = process.argv.indexOf("--out");
const outputDir = outFlag > 0 ? process.argv[outFlag + 1] : "public/barkley";

if (!inputDir) {
  console.error("Usage: npx tsx scripts/manual/strip-barkley-clips.ts <input-dir> [--out <dir>]");
  process.exit(2);
}

/**
 * Tripo preset -> clip name(s) in src/barkley/shows.ts.
 *
 * One preset can serve several clips: `turn` covers both directions (mirror
 * one at runtime rather than paying for a second export), and `look_around`
 * reads equally as curiosity and as following a drag.
 */
const PRESET_TO_CLIPS: Record<string, string[]> = {
  idle: ["idle"],
  walk: ["walk_forward"],
  turn: ["turn_left", "turn_right"],
  agree: ["nod_yes"],
  wave_goodbye_01: ["wave_bye"],
  greet_02: ["wave_hello"],
  cheer: ["react_quiz_yes"],
  look_around: ["curious_lean", "react_drag"],
  clap: ["clap"],
  laugh_01: ["laugh"],
  jump: ["excited_jump"],
  frightened: ["surprised"],
  fold_arms: ["think"],
  cast_a_spell: ["gesture_present"],
  complain_01: ["gesture_shrug"],

  // Tripo presets retargeted onto the spec's dialogue and emotional beats.
  // The sing presets are long, articulated upper-body loops, which is exactly
  // what a talking presenter needs; nothing about them reads as singing once
  // the audio is Barkley's dialogue.
  sing_01: ["talk_normal"],
  sing_02: ["talk_emphasize"],
  sing_03: ["talk_explain"],
  hug: ["open_arms"],
  heart_pose: ["hands_together"],
  depressed: ["react_quiz_no"],

  // Hand-authored on the Blender worker — see author-barkley-clip.ts.
  point_right: ["point_right"],
  point_left: ["point_left"],
  gesture_up: ["gesture_up"],
  shake_head: ["shake_head"],
  react_click: ["react_click"],

  // Substitutions for the two clips the rig cannot express. Barkley's Tripo
  // auto-rig ends at L_Hand/R_Hand with no finger bones, so counting on
  // fingers and a thumbs-up are not authorable at any keyframe. Rather than
  // ship the beats empty, they borrow presets that were already in the
  // library and previously unused:
  //   stretch -> a broad two-arm gesture that reads as laying out points
  //   bow     -> a genuine deep bow, which suits both success and goodbye
  // The descriptions in shows.ts are updated to match what actually plays.
  stretch: ["gesture_count"],
  bow: ["gesture_thumbs_up"],
  // `sing_04` stays unmapped: a fourth talk loop the spec has no slot for.
};

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

interface Gltf { [key: string]: any }

function readGlb(file: string): { gltf: Gltf; bin: Buffer } {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a GLB`);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.slice(20, 20 + jsonLen).toString("utf8"));
  const bin = buf.slice(20 + jsonLen + 8);
  return { gltf, bin };
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

function writeGlb(gltf: Gltf, bin: Buffer, outFile: string): void {
  const jsonText = JSON.stringify(gltf);
  const jsonBuf = Buffer.from(jsonText, "utf8");
  const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20)]);
  const binPadded = Buffer.concat([bin, Buffer.alloc(pad4(bin.length) - bin.length, 0)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binPadded.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);

  fs.writeFileSync(outFile, Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded]));
}

/** Rebuild a glTF containing only the node hierarchy and its animations. */
function stripToAnimation(gltf: Gltf, bin: Buffer): { gltf: Gltf; bin: Buffer } {
  const keptAccessors: number[] = [];
  const accessorMap = new Map<number, number>();

  const keep = (index: number): number => {
    if (accessorMap.has(index)) return accessorMap.get(index)!;
    const next = keptAccessors.length;
    keptAccessors.push(index);
    accessorMap.set(index, next);
    return next;
  };

  const animations = (gltf.animations || []).map((anim: any) => ({
    ...anim,
    samplers: (anim.samplers || []).map((s: any) => ({
      ...s,
      input: keep(s.input),
      output: keep(s.output),
    })),
  }));

  const chunks: Buffer[] = [];
  const bufferViews: any[] = [];
  const accessors: any[] = [];
  let offset = 0;

  for (const original of keptAccessors) {
    const acc = gltf.accessors[original];
    const view = gltf.bufferViews[acc.bufferView];
    const elementBytes = COMPONENT_BYTES[acc.componentType] * TYPE_COUNTS[acc.type];
    const start = (view.byteOffset || 0) + (acc.byteOffset || 0);

    // Animation accessors are tightly packed in every exporter seen so far. A
    // strided view would need de-interleaving, so fail loudly rather than
    // silently writing garbage that only shows up as a broken pose at runtime.
    if (view.byteStride && view.byteStride !== elementBytes) {
      throw new Error(`Interleaved animation accessor ${original} (stride ${view.byteStride}) is not supported`);
    }

    const slice = bin.slice(start, start + acc.count * elementBytes);
    const padded = Buffer.concat([slice, Buffer.alloc(pad4(slice.length) - slice.length, 0)]);
    chunks.push(padded);

    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: slice.length });
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: acc.componentType,
      count: acc.count,
      type: acc.type,
      ...(acc.min ? { min: acc.min } : {}),
      ...(acc.max ? { max: acc.max } : {}),
    });
    offset += padded.length;
  }

  const newBin = Buffer.concat(chunks);

  // Nodes are kept for their names — that is what an AnimationClip binds to —
  // but stripped of anything that would drag geometry back in.
  const nodes = (gltf.nodes || []).map((node: any) => {
    const { mesh, skin, camera, ...rest } = node;
    return rest;
  });

  return {
    gltf: {
      asset: { version: "2.0", generator: "pawsome3d strip-barkley-clips" },
      scene: gltf.scene ?? 0,
      scenes: gltf.scenes || [{ nodes: [0] }],
      nodes,
      animations,
      accessors,
      bufferViews,
      buffers: [{ byteLength: newBin.length }],
    },
    bin: newBin,
  };
}

const files = fs.readdirSync(inputDir).filter((f) => f.endsWith(".glb")).sort();
if (!files.length) {
  console.error(`No .glb files in ${inputDir}`);
  process.exit(2);
}
fs.mkdirSync(outputDir, { recursive: true });

let written = 0;
let skipped = 0;
let bytesBefore = 0;
let bytesAfter = 0;

for (const file of files) {
  // Exports are named barkley-<preset>.glb, but a few arrived as
  // barkley_<preset>.glb; accept either separator.
  const preset = path.basename(file, ".glb").replace(/^barkley[-_]/, "");
  const clips = PRESET_TO_CLIPS[preset];
  if (!clips) {
    console.log(`  ${preset.padEnd(20)} SKIPPED — no clip in shows.ts maps to this preset`);
    skipped++;
    continue;
  }

  const inPath = path.join(inputDir, file);
  const { gltf, bin } = readGlb(inPath);
  if (!(gltf.animations || []).length) {
    console.log(`  ${preset.padEnd(20)} SKIPPED — contains no animation`);
    skipped++;
    continue;
  }

  const stripped = stripToAnimation(gltf, bin);
  const before = fs.statSync(inPath).size;

  for (const clip of clips) {
    const outPath = path.join(outputDir, `${clip}.glb`);
    // Name the clip after the file so the runtime can identify it even when
    // several are loaded together; Tripo leaves them all called "NlaTrack".
    stripped.gltf.animations[0].name = clip;
    writeGlb(stripped.gltf, stripped.bin, outPath);
    const after = fs.statSync(outPath).size;
    bytesAfter += after;
    console.log(
      `  ${preset.padEnd(20)} -> ${clip.padEnd(18)} ${(before / 1048576).toFixed(2)}MB -> ${(after / 1024).toFixed(0)}KB`
    );
    written++;
  }
  bytesBefore += before;
}

console.log(`\n${written} clip(s) written to ${outputDir}${skipped ? `, ${skipped} skipped` : ""}.`);
console.log(`Total ${(bytesBefore / 1048576).toFixed(1)}MB -> ${(bytesAfter / 1048576).toFixed(2)}MB.`);
console.log(`\nRemaining clips must be authored — see docs/current/BARKLEY_CLIP_PIPELINE.md`);
