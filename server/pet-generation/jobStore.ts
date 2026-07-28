import type mysql from "mysql2/promise";
import type { ProviderJobStore } from "./provider";
import { PetGenerationError } from "./provider";
import type { ProviderJobRecord } from "./types";

/**
 * Durable ProviderJobStore backed by `provider_generation_jobs`.
 *
 * G3 ENTRY GATE (docs/audits/G2_GAPS.md #1). InMemoryJobStore loses every
 * in-flight job on process restart and cannot work across instances — for a
 * paid order that means "customer paid, job unrecoverable". This replaces it
 * with no change to TripoPetGenerationAdapter, which is why ProviderJobStore
 * was an interface from the start.
 *
 * BOUNDARY RULE: `glb_url` is persisted here and read only by
 * fetchArtifacts(). It must never be selected into anything that is
 * serialised toward a caller. See server/pet-generation/types.ts.
 */
export class MySqlProviderJobStore implements ProviderJobStore {
  constructor(private readonly getPool: () => mysql.Pool) {}

  async put(record: ProviderJobRecord): Promise<void> {
    const pool = this.getPool();
    // Insert-or-noop: createJob is retry-safe, and a duplicate jobId must not
    // clobber an existing record's cancelled flag or resolved glb_url.
    await pool.query(
      `INSERT INTO provider_generation_jobs
         (job_id, order_id, provider_id, provider_version, provider_task_handle,
          model, config_hash, cancelled, glb_url, stage, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE job_id = job_id`,
      [
        record.jobId,
        record.orderId ?? null,
        record.providerId,
        record.providerVersion,
        record.providerTaskHandle,
        record.model,
        record.configHash,
        record.cancelled ? 1 : 0,
        record.glbUrl ?? null,
        record.stage ?? null,
      ],
    );
  }

  async get(jobId: string): Promise<ProviderJobRecord | undefined> {
    const pool = this.getPool();
    const [rows] = await pool.query(
      `SELECT job_id, order_id, provider_id, provider_version, provider_task_handle,
              model, config_hash, cancelled, glb_url,
              stage, rig_task_handle, idle_task_handle, walk_task_handle, idle_glb_url, walk_glb_url,
              UNIX_TIMESTAMP(created_at) * 1000 AS created_ms
         FROM provider_generation_jobs
        WHERE job_id = ?
        LIMIT 1`,
      [jobId],
    );
    const arr = rows as any[];
    if (!arr.length) return undefined;
    const r = arr[0];
    return {
      jobId: r.job_id,
      orderId: r.order_id ?? undefined,
      providerId: r.provider_id,
      providerVersion: r.provider_version,
      providerTaskHandle: r.provider_task_handle,
      model: r.model,
      configHash: r.config_hash,
      cancelled: r.cancelled === 1,
      glbUrl: r.glb_url ?? undefined,
      stage: r.stage ?? undefined,
      rigTaskHandle: r.rig_task_handle ?? undefined,
      idleTaskHandle: r.idle_task_handle ?? undefined,
      walkTaskHandle: r.walk_task_handle ?? undefined,
      idleGlbUrl: r.idle_glb_url ?? undefined,
      walkGlbUrl: r.walk_glb_url ?? undefined,
      createdAt: Number(r.created_ms),
    };
  }

  async update(jobId: string, patch: Partial<ProviderJobRecord>): Promise<void> {
    const pool = this.getPool();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.cancelled !== undefined) {
      // Cancellation is a tombstone: monotonic, never un-set. A late writer
      // must not resurrect a cancelled job.
      sets.push("cancelled = GREATEST(cancelled, ?)");
      params.push(patch.cancelled ? 1 : 0);
    }
    if (patch.glbUrl !== undefined) {
      sets.push("glb_url = ?");
      params.push(patch.glbUrl);
    }
    if (patch.orderId !== undefined) {
      sets.push("order_id = ?");
      params.push(patch.orderId);
    }
    // Animated-pipeline staging fields (internal; never selected toward a caller).
    if (patch.stage !== undefined) { sets.push("stage = ?"); params.push(patch.stage); }
    if (patch.rigTaskHandle !== undefined) { sets.push("rig_task_handle = ?"); params.push(patch.rigTaskHandle); }
    if (patch.idleTaskHandle !== undefined) { sets.push("idle_task_handle = ?"); params.push(patch.idleTaskHandle); }
    if (patch.walkTaskHandle !== undefined) { sets.push("walk_task_handle = ?"); params.push(patch.walkTaskHandle); }
    if (patch.idleGlbUrl !== undefined) { sets.push("idle_glb_url = ?"); params.push(patch.idleGlbUrl); }
    if (patch.walkGlbUrl !== undefined) { sets.push("walk_glb_url = ?"); params.push(patch.walkGlbUrl); }
    if (!sets.length) return;

    sets.push("updated_at = NOW()");
    params.push(jobId);

    const [result] = await pool.query(
      `UPDATE provider_generation_jobs SET ${sets.join(", ")} WHERE job_id = ?`,
      params,
    );
    if ((result as any).affectedRows === 0) {
      throw new PetGenerationError("JOB_NOT_FOUND", `Job not found: ${jobId}`);
    }
  }
}

/** DDL for migration 37. Kept beside the store so the two cannot drift. */
export const PROVIDER_GENERATION_JOBS_DDL = `
CREATE TABLE IF NOT EXISTS provider_generation_jobs (
  job_id CHAR(36) NOT NULL PRIMARY KEY,
  order_id BIGINT NULL,
  provider_id VARCHAR(40) NOT NULL,
  provider_version VARCHAR(80) NOT NULL,
  provider_task_handle VARCHAR(190) NOT NULL,
  model VARCHAR(120) NOT NULL DEFAULT '',
  config_hash CHAR(64) NOT NULL DEFAULT '',
  cancelled TINYINT(1) NOT NULL DEFAULT 0,
  glb_url TEXT NULL,
  stage VARCHAR(16) NULL,
  rig_task_handle VARCHAR(190) NULL,
  idle_task_handle VARCHAR(190) NULL,
  walk_task_handle VARCHAR(190) NULL,
  idle_glb_url TEXT NULL,
  walk_glb_url TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pgj_order (order_id),
  KEY idx_pgj_handle (provider_task_handle)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`.trim();
