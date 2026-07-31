import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPool } from "../../db.ts";
import { failGenerationJobAndRefundOnce } from "../generationRefunds.ts";
import { ANIMATOR_DATA_DIR, resolveWithinWorkspace } from "./paths.ts";

export const VoicedResultSchema = z.object({
  version: z.literal(1),
  jobId: z.number().int().positive(),
  ownerId: z.string().min(1),
  recordingId: z.string().uuid(),
  resultUrl: z.string().url(),
  mimeType: z.enum(["video/webm", "video/mp4"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive(),
  publishedAt: z.string().datetime(),
});
export type VoicedResult = z.infer<typeof VoicedResultSchema>;

function resultPath(jobId: number, workspaceRoot = ANIMATOR_DATA_DIR): string {
  return resolveWithinWorkspace(`results/voiceover-${jobId}.json`, workspaceRoot);
}

export function persistVoicedResult(input: Omit<VoicedResult, "version" | "sha256" | "sizeBytes" | "publishedAt"> & { bytes: Buffer }, workspaceRoot = ANIMATOR_DATA_DIR): VoicedResult {
  const result = VoicedResultSchema.parse({ version: 1, jobId: input.jobId, ownerId: input.ownerId, recordingId: input.recordingId, resultUrl: input.resultUrl, mimeType: input.mimeType, sha256: crypto.createHash("sha256").update(input.bytes).digest("hex"), sizeBytes: input.bytes.length, publishedAt: new Date().toISOString() });
  const destination = resultPath(input.jobId, workspaceRoot);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(result, null, 2), { flag: "wx" }); fs.renameSync(temporary, destination); }
  finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); }
  return result;
}

export function getOwnedVoicedResult(jobId: number, ownerId: string, workspaceRoot = ANIMATOR_DATA_DIR): VoicedResult | null {
  const destination = resultPath(jobId, workspaceRoot);
  if (!fs.existsSync(destination) || fs.lstatSync(destination).isSymbolicLink()) return null;
  const result = VoicedResultSchema.parse(JSON.parse(fs.readFileSync(destination, "utf8")));
  return result.ownerId === ownerId ? result : null;
}

export async function claimVoiceoverFinalizer(jobId: number, ownerId: string, leaseSeconds = 180): Promise<string | null> {
  const leaseOwner = `animator-voiceover:${randomUUID()}`;
  const [result] = await getPool().query(
    `UPDATE generation_jobs SET status = 'running', recovery_lease_owner = ?, recovery_lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND), recovery_started_at = COALESCE(recovery_started_at, NOW(3)), recovery_last_heartbeat_at = NOW(3)
     WHERE id = ? AND user_phone = ? AND status IN ('queued','running') AND (recovery_lease_owner IS NULL OR recovery_lease_expires_at < NOW(3))`,
    [leaseOwner, leaseSeconds, jobId, ownerId],
  ) as any;
  return result.affectedRows === 1 ? leaseOwner : null;
}

export async function releaseVoiceoverFinalizer(jobId: number, leaseOwner: string): Promise<void> {
  await getPool().query(`UPDATE generation_jobs SET recovery_lease_owner = NULL, recovery_lease_expires_at = NULL WHERE id = ? AND recovery_lease_owner = ? AND status IN ('queued','running')`, [jobId, leaseOwner]);
}

export async function markVoiceoverDone(jobId: number, leaseOwner: string): Promise<boolean> {
  const [result] = await getPool().query(`UPDATE generation_jobs SET status = 'done', error = NULL, recovery_lease_owner = NULL, recovery_lease_expires_at = NULL WHERE id = ? AND recovery_lease_owner = ? AND status IN ('queued','running')`, [jobId, leaseOwner]) as any;
  return result.affectedRows === 1;
}

export async function failVoiceoverAndRefundOnce(jobId: number, leaseOwner: string, reason: string): Promise<boolean> {
  const result = await failGenerationJobAndRefundOnce(getPool(), jobId, reason, {
    expectedLeaseOwner: leaseOwner,
  });
  return result.status === "failed";
}
