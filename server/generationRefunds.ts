import type mysql from "mysql2/promise";

import {
  applyWalletClaimInTransaction,
  refundWalletDebitInTransaction,
} from "./wallet";

const TERMINAL_STATUSES = new Set(["done", "done_static_fallback", "failed"]);
const ACTIVE_STATUSES = ["queued", "running", "rigging", "validating"] as const;
const REFUND_REASON = "generation_job_refund";

interface LockedGenerationJob {
  id: number;
  user_phone: string;
  status: string;
  credits_reserved: number;
  credit_debit_correlation_id: string | null;
  generation_refunded_at: Date | null;
  generation_refund_pending_at: Date | null;
  recovery_lease_owner: string | null;
}

export interface GenerationFailureResult {
  status: string;
  refundApplied: boolean;
  refundPending: boolean;
}

function cleanReason(reason: string): string {
  return String(reason || "Generation failed.").replace(/[\r\n\t]+/g, " ").slice(0, 480);
}

function correlation(jobId: number): string {
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error("A valid generation job ID is required.");
  return `generation-job:${jobId}:generation:refund`;
}

async function lockJob(
  connection: mysql.PoolConnection,
  jobId: number,
): Promise<LockedGenerationJob | null> {
  const [rows] = await connection.query(
    `SELECT id, user_phone, status, credits_reserved, credit_debit_correlation_id, generation_refunded_at,
            generation_refund_pending_at, recovery_lease_owner
       FROM generation_jobs WHERE id = ? LIMIT 1 FOR UPDATE`,
    [jobId],
  ) as any;
  return Array.isArray(rows) && rows.length > 0 ? rows[0] as LockedGenerationJob : null;
}

async function persistPendingEvidence(
  pool: mysql.Pool,
  jobId: number,
  reason: string,
  error: unknown,
): Promise<void> {
  const connection = await pool.getConnection();
  let started = false;
  try {
    await connection.beginTransaction();
    started = true;
    const job = await lockJob(connection, jobId);
    if (!job || ["done", "done_static_fallback"].includes(job.status) || job.generation_refunded_at) {
      await connection.rollback();
      started = false;
      return;
    }
    await connection.query(
      `UPDATE generation_jobs
          SET status = 'failed', error = ?,
              generation_refund_pending_at = COALESCE(generation_refund_pending_at, NOW(3)),
              generation_refund_error = ?,
              recovery_lease_owner = NULL,
              recovery_lease_expires_at = NULL
        WHERE id = ? AND status NOT IN ('done','done_static_fallback')`,
      [cleanReason(reason), cleanReason(error instanceof Error ? error.message : String(error)), jobId],
    );
    await connection.commit();
    started = false;
  } catch {
    if (started) await connection.rollback().catch(() => undefined);
  } finally {
    connection.release();
  }
}

/**
 * Atomically claim a generation job's terminal failure and refund only the
 * immutable owner/amount read from that locked row. Concurrent HTTP/background
 * pollers converge on the same ledger correlation.
 */
export async function failGenerationJobAndRefundOnce(
  pool: mysql.Pool,
  jobId: number,
  reason: string,
  options: { expectedLeaseOwner?: string } = {},
): Promise<GenerationFailureResult> {
  correlation(jobId);
  const connection = await pool.getConnection();
  let started = false;
  try {
    await connection.beginTransaction();
    started = true;
    const job = await lockJob(connection, jobId);
    if (!job) throw new Error("Generation job was not found.");

    if (options.expectedLeaseOwner && job.recovery_lease_owner !== options.expectedLeaseOwner) {
      await connection.rollback();
      started = false;
      return { status: job.status, refundApplied: false, refundPending: false };
    }

    if (["done", "done_static_fallback"].includes(job.status)) {
      await connection.commit();
      started = false;
      return { status: job.status, refundApplied: false, refundPending: false };
    }

    const amount = Number(job.credits_reserved);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error("Generation job has an invalid reserved-credit amount.");
    }

    let refundApplied = false;
    if (amount > 0 && !job.generation_refunded_at) {
      const claim = job.credit_debit_correlation_id
        ? await refundWalletDebitInTransaction(connection, job.credit_debit_correlation_id, {
            ownerId: String(job.user_phone),
            amount,
          })
        : await applyWalletClaimInTransaction(connection, {
            ownerId: String(job.user_phone),
            correlationId: correlation(jobId),
            expected: { delta: amount, reason: REFUND_REASON },
            resolve: async () => ({ delta: amount, reason: REFUND_REASON }),
          });
      refundApplied = claim.applied;
    }

    await connection.query(
      `UPDATE generation_jobs
          SET status = 'failed', error = ?,
              generation_refunded_at = CASE WHEN credits_reserved > 0 THEN COALESCE(generation_refunded_at, NOW(3)) ELSE generation_refunded_at END,
              generation_refund_pending_at = NULL,
              generation_refund_error = NULL,
              generation_refund_attempts = generation_refund_attempts + CASE WHEN credits_reserved > 0 THEN 1 ELSE 0 END,
              recovery_lease_owner = NULL,
              recovery_lease_expires_at = NULL
        WHERE id = ? AND status NOT IN ('done','done_static_fallback')`,
      [cleanReason(reason), jobId],
    );
    await connection.commit();
    started = false;
    return { status: "failed", refundApplied, refundPending: false };
  } catch (error) {
    if (started) await connection.rollback().catch(() => undefined);
    await persistPendingEvidence(pool, jobId, reason, error);
    throw error;
  } finally {
    connection.release();
  }
}

/** A durable success transition cannot overwrite an already failed job. */
export async function markGenerationJobDoneOnce(
  pool: mysql.Pool,
  jobId: number,
  status: "done" | "done_static_fallback" = "done",
): Promise<boolean> {
  correlation(jobId);
  const [result] = await pool.query(
    `UPDATE generation_jobs
        SET status = ?, error = NULL,
            recovery_lease_owner = NULL, recovery_lease_expires_at = NULL
      WHERE id = ? AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`,
    [status, jobId, ...ACTIVE_STATUSES],
  ) as any;
  return result.affectedRows === 1;
}

/** Retry a bounded set of durable refund-pending jobs. */
export async function sweepPendingGenerationRefunds(
  pool: mysql.Pool,
  limit = 25,
): Promise<{ attempted: number; applied: number; failed: number }> {
  const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
  const [rows] = await pool.query(
    `SELECT id FROM generation_jobs
      WHERE status = 'failed' AND credits_reserved > 0
        AND generation_refunded_at IS NULL
        AND generation_refund_pending_at IS NOT NULL
      ORDER BY generation_refund_pending_at ASC, id ASC
      LIMIT ?`,
    [boundedLimit],
  ) as any;
  let applied = 0;
  let failed = 0;
  for (const row of rows as Array<{ id: number }>) {
    try {
      const result = await failGenerationJobAndRefundOnce(pool, Number(row.id), "Retrying pending generation refund.");
      if (result.refundApplied) applied += 1;
    } catch {
      failed += 1;
    }
  }
  return { attempted: rows.length, applied, failed };
}

export function isGenerationJobTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
