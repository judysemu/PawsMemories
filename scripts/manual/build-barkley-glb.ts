#!/usr/bin/env -S npx tsx
/**
 * Merge the per-clip GLBs into the single barkley.glb the runtime loads.
 *
 * BarkleyScreen.tsx loads one file — /barkley/barkley.glb — and builds its
 * clip map from `gltf.animations`, keyed by animation name. The per-clip
 * files in public/barkley are build inputs, not runtime assets: with no
 * merged file present the loader's onError branch fires and the stage sits in
 * placeholder mode, which is why Barkley never appeared.
 *
 *   npx tsx scripts/manual/build-barkley-glb.ts
 *
 * Every clip was exported from the same Tripo rig, so merging is a node
 * remap rather than a retarget: each animation channel names a target node,
 * and the same bone carries the same name in every file. Channels are
 * rebound to the base model's node indices by name, and the sampler
 * accessors are copied across with their buffer data appended.
 *
 * Doing this at the glTF level rather than in Blender is deliberate. The
 * stripped clips have had their skins removed, so Blender's importer would
 * rebuild them as Empties rather than bones and the actions would no longer
 * bind to the armature.
 */
import fs from "fs";
import path from "path";

const CLIP_DIR = process.argv[2] || "public/barkley";
const BASE = process.env.BARKLEY_BASE || "/Users/robert/barkley-clips/barkley-idle.glb";
const OUT = path.join(CLIP_DIR, "barkley.glb");

interface Gltf { [key: string]: any }

function readGlb(file: string): { gltf: Gltf; bin: Buffer } {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a GLB`);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.slice(20, 20 + jsonLen).toString("utf8"));
  let bin = Buffer.alloc(0);
  let off = 20 + jsonLen;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x004e4942) { bin = buf.slice(off + 8, off + 8 + len); break; }
    off += 8 + len;
  }
  return { gltf, bin };
}

function writeGlb(gltf: Gltf, bin: Buffer, outPath: string): void {
  const json = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPad = (4 - (json.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  const total = 12 + 8 + jsonChunk.length + (binChunk.length ? 8 + binChunk.length : 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonChunk.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const parts = [head, jh, jsonChunk];
  if (binChunk.length) {
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(binChunk.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    parts.push(bh, binChunk);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat(parts));
}

const base = readGlb(BASE);
const gltf: Gltf = base.gltf;

// The base model ships its own NlaTrack animation. The stripped idle.glb is
// added back under the name the runtime asks for, so drop the original rather
// than ship the same motion twice under two names.
gltf.animations = [];

gltf.accessors = gltf.accessors || [];
gltf.bufferViews = gltf.bufferViews || [];

const nodeIndexByName = new Map<string, number>();
(gltf.nodes || []).forEach((n: any, i: number) => {
  if (n.name) nodeIndexByName.set(n.name, i);
});

const chunks: Buffer[] = [base.bin];
let binLength = base.bin.length;

/** Appends a clip's buffer slice, 4-byte aligned, and returns its offset. */
function appendBin(buf: Buffer): number {
  const pad = (4 - (binLength % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad, 0)); binLength += pad; }
  const at = binLength;
  chunks.push(buf);
  binLength += buf.length;
  return at;
}

const files = fs.readdirSync(CLIP_DIR)
  .filter((f) => f.endsWith(".glb") && f !== "barkley.glb")
  .sort();

let merged = 0;
const unbound = new Set<string>();

for (const file of files) {
  const clip = readGlb(path.join(CLIP_DIR, file));
  const name = path.basename(file, ".glb");
  const anims = clip.gltf.animations || [];
  if (!anims.length) { console.log(`  ${name.padEnd(20)} SKIPPED — no animation`); continue; }

  const srcAccessors = clip.gltf.accessors || [];
  const srcViews = clip.gltf.bufferViews || [];
  const srcNodes = clip.gltf.nodes || [];
  const accessorMap = new Map<number, number>();

  /** Copies one accessor (and the buffer view beneath it) into the base. */
  const copyAccessor = (srcIndex: number): number => {
    if (accessorMap.has(srcIndex)) return accessorMap.get(srcIndex)!;
    const acc = srcAccessors[srcIndex];
    const view = srcViews[acc.bufferView];
    const start = view.byteOffset || 0;
    const slice = clip.bin.slice(start, start + view.byteLength);
    const at = appendBin(slice);
    gltf.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: view.byteLength });
    const newAcc: any = {
      bufferView: gltf.bufferViews.length - 1,
      componentType: acc.componentType,
      count: acc.count,
      type: acc.type,
    };
    if (acc.byteOffset) newAcc.byteOffset = acc.byteOffset;
    if (acc.min) newAcc.min = acc.min;
    if (acc.max) newAcc.max = acc.max;
    if (acc.normalized) newAcc.normalized = acc.normalized;
    gltf.accessors.push(newAcc);
    const idx = gltf.accessors.length - 1;
    accessorMap.set(srcIndex, idx);
    return idx;
  };

  const anim = anims[0];
  const samplerMap = new Map<number, number>();
  const samplers: any[] = [];
  const channels: any[] = [];

  for (const ch of anim.channels || []) {
    const targetNode = srcNodes[ch.target?.node];
    const boneName = targetNode?.name;
    // A channel whose bone is absent from the base rig cannot be rebound.
    // Dropping it silently would produce a clip that plays but does nothing,
    // so collect the names and report them.
    if (!boneName || !nodeIndexByName.has(boneName)) {
      if (boneName) unbound.add(`${name}:${boneName}`);
      continue;
    }
    if (!samplerMap.has(ch.sampler)) {
      const s = anim.samplers[ch.sampler];
      samplers.push({
        input: copyAccessor(s.input),
        output: copyAccessor(s.output),
        interpolation: s.interpolation || "LINEAR",
      });
      samplerMap.set(ch.sampler, samplers.length - 1);
    }
    channels.push({
      sampler: samplerMap.get(ch.sampler),
      target: { node: nodeIndexByName.get(boneName), path: ch.target.path },
    });
  }

  if (!channels.length) { console.log(`  ${name.padEnd(20)} SKIPPED — no channel bound`); continue; }

  gltf.animations.push({ name, channels, samplers });
  merged++;
  console.log(`  ${name.padEnd(20)} ${String(channels.length).padStart(3)} channels`);
}

const bin = Buffer.concat(chunks);
gltf.buffers = [{ byteLength: bin.length }];
writeGlb(gltf, bin, OUT);

if (unbound.size) {
  console.log(`\nUnbound channels (bone absent from base rig): ${[...unbound].join(", ")}`);
}
console.log(`\n${merged} animation(s) merged into ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB).`);
