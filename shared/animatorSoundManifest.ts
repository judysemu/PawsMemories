import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import rawManifest from "../public/animator-files/sounds/manifest.json";

export const SOUND_CATEGORY_SCHEMA = z.enum(["music", "ambience", "foley", "voice"]);

export const ANIMATOR_SOUND_ASSET_SCHEMA = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  publicUrl: z.string().regex(/^\/animator-files\/sounds\/[a-z0-9-]+-v\d+\.wav$/),
  mimeType: z.literal("audio/wav"),
  durationSeconds: z.number().positive().max(10),
  sampleRate: z.number().int().min(8_000).max(48_000),
  channels: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  generationMethod: z.string().min(20),
  rightsStatus: z.literal("owned-generated"),
  loopSafe: z.boolean(),
  category: SOUND_CATEGORY_SCHEMA,
  version: z.literal("1"),
});

export const ANIMATOR_SOUND_MANIFEST_SCHEMA = z.object({
  version: z.literal("1"),
  assets: z.array(ANIMATOR_SOUND_ASSET_SCHEMA).min(1).max(8),
});

export const ANIMATOR_SOUND_MANIFEST = ANIMATOR_SOUND_MANIFEST_SCHEMA.parse(rawManifest);
export type AnimatorSoundAsset = z.infer<typeof ANIMATOR_SOUND_ASSET_SCHEMA>;
export const ANIMATOR_SOUND_BY_ID = new Map(ANIMATOR_SOUND_MANIFEST.assets.map((asset) => [asset.id, asset]));

export function readWavMetadata(buffer: Buffer): { channels: number; sampleRate: number; durationSeconds: number } {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Invalid WAV header");
  }
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (offset + 8 + size > buffer.length) throw new Error("Invalid WAV chunk size");
    if (id === "fmt ") {
      if (size < 16 || buffer.readUInt16LE(offset + 8) !== 1) throw new Error("Only PCM WAV is supported");
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (id === "data") {
      dataBytes = size;
    }
    offset += 8 + size + (size % 2);
  }
  if (!channels || !sampleRate || bitsPerSample !== 16 || !dataBytes) throw new Error("Incomplete PCM WAV");
  return { channels, sampleRate, durationSeconds: dataBytes / (sampleRate * channels * (bitsPerSample / 8)) };
}

export function verifySoundManifestAssets(repositoryRoot = process.cwd()): string[] {
  const errors: string[] = [];
  for (const asset of ANIMATOR_SOUND_MANIFEST.assets) {
    const absolute = path.resolve(repositoryRoot, "public", asset.publicUrl.replace(/^\//, ""));
    const publicRoot = path.resolve(repositoryRoot, "public");
    if (!absolute.startsWith(`${publicRoot}${path.sep}`)) {
      errors.push(`sound ${asset.id} escapes public root`);
      continue;
    }
    if (!fs.existsSync(absolute)) {
      errors.push(`sound ${asset.id} is missing`);
      continue;
    }
    try {
      const bytes = fs.readFileSync(absolute);
      const digest = crypto.createHash("sha256").update(bytes).digest("hex");
      const metadata = readWavMetadata(bytes);
      if (digest !== asset.sha256) errors.push(`sound ${asset.id} hash mismatch`);
      if (metadata.channels !== asset.channels) errors.push(`sound ${asset.id} channel mismatch`);
      if (metadata.sampleRate !== asset.sampleRate) errors.push(`sound ${asset.id} sample rate mismatch`);
      if (Math.abs(metadata.durationSeconds - asset.durationSeconds) > 0.001) errors.push(`sound ${asset.id} duration mismatch`);
    } catch (error) {
      errors.push(`sound ${asset.id} is invalid: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  return errors;
}
