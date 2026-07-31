import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ANIMATOR_DATA_DIR, resolveWithinWorkspace } from "./paths.ts";

const MAX_RECORDING_BYTES = 100 * 1024 * 1024;
export const RecordingIdSchema = z.string().uuid();

export const RecordingMetadataSchema = z.object({
  recordingId: z.string().uuid(),
  ownerId: z.string().min(1),
  fileName: z.string().regex(/^[0-9a-f-]{36}\.(?:webm|mp4)$/),
  mimeType: z.enum(["video/webm", "video/mp4"]),
  url: z.string().startsWith("/animator-files/recordings/"),
  sizeBytes: z.number().int().positive().max(MAX_RECORDING_BYTES),
  createdAt: z.string().datetime(),
});
export type RecordingMetadata = z.infer<typeof RecordingMetadataSchema>;

export function detectRecordingMime(buffer: Buffer): "video/webm" | "video/mp4" | null {
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  return null;
}

export function validateRecordingUpload(buffer: Buffer, claimedMime: string): "video/webm" | "video/mp4" {
  if (!buffer.length || buffer.length > MAX_RECORDING_BYTES) throw new Error("Recording size is outside the allowed range");
  const detected = detectRecordingMime(buffer);
  if (!detected) throw new Error("Recording has invalid video magic bytes");
  const normalizedClaim = claimedMime.split(";", 1)[0].toLowerCase();
  if (normalizedClaim !== detected) throw new Error("Recording MIME does not match its contents");
  return detected;
}

export function saveRecording(input: { ownerId: string; buffer: Buffer; claimedMime: string; workspaceRoot?: string }): RecordingMetadata {
  const workspaceRoot = path.resolve(input.workspaceRoot || ANIMATOR_DATA_DIR);
  const mimeType = validateRecordingUpload(input.buffer, input.claimedMime);
  const recordingId = randomUUID();
  const extension = mimeType === "video/webm" ? "webm" : "mp4";
  const fileName = `${recordingId}.${extension}`;
  const dataPath = resolveWithinWorkspace(`recordings/${fileName}`, workspaceRoot);
  const metadataPath = resolveWithinWorkspace(`recordings/${recordingId}.json`, workspaceRoot);
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  const metadata = RecordingMetadataSchema.parse({ recordingId, ownerId: input.ownerId, fileName, mimeType, url: `/animator-files/recordings/${fileName}`, sizeBytes: input.buffer.length, createdAt: new Date().toISOString() });
  fs.writeFileSync(dataPath, input.buffer, { flag: "wx" });
  try { fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), { flag: "wx" }); }
  catch (error) { fs.rmSync(dataPath, { force: true }); throw error; }
  return metadata;
}

export function getOwnedRecording(recordingId: string, ownerId: string, workspaceRoot = ANIMATOR_DATA_DIR): RecordingMetadata | null {
  const parsedId = RecordingIdSchema.safeParse(recordingId);
  if (!parsedId.success) return null;
  const metadataPath = resolveWithinWorkspace(`recordings/${parsedId.data}.json`, workspaceRoot);
  if (!fs.existsSync(metadataPath) || fs.lstatSync(metadataPath).isSymbolicLink()) return null;
  const metadata = RecordingMetadataSchema.parse(JSON.parse(fs.readFileSync(metadataPath, "utf8")));
  if (metadata.ownerId !== ownerId) return null;
  const dataPath = resolveWithinWorkspace(`recordings/${metadata.fileName}`, workspaceRoot);
  if (!fs.existsSync(dataPath) || fs.lstatSync(dataPath).isSymbolicLink()) return null;
  return metadata;
}
