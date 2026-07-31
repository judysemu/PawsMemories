import { createHash, randomUUID } from "node:crypto";
import type mysql from "mysql2/promise";
import { applyWalletClaimInTransaction } from "./wallet";

export const PIPELINE_PROVIDER_RECOVERY_MAX_AGE_MS = 45 * 60 * 1000;
export const PIPELINE_RIG_RECOVERY_MAX_AGE_MS = 90 * 60 * 1000;
export const PIPELINE_RIG_MAX_ATTEMPTS = 2;
export const PIPELINE_RECOVERY_LEASE_MS = 5 * 60 * 1000;

type Queryable = Pick<mysql.Pool | mysql.PoolConnection, "query">;

export interface PipelineRigRecoveryContext {
  jobId: number;
  userPhone: string;
  creationId: number | null;
  creationOwnerPhone: string | null;
  kind: string;
  jobStatus: string;
  jobCreatedAt: Date;
  jobUpdatedAt: Date;
  creditsReserved: number;
  rigAttemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  recoveryStartedAt: Date | null;
  recoveryReason: string | null;
  sourceModelHash: string | null;
  rigRefundedAt: Date | null;
  generationRefundedAt: Date | null;
  currentModelUrl: string | null;
  riggedModelUrl: string | null;
  sessionId: string | null;
  sessionMatchCount: number;
  sessionUserPhone: string | null;
  sessionStatus: string | null;
  sessionUpdatedAt: Date | null;
  customizationState: Record<string, unknown> | null;
}

export interface RecoveryDecision {
  eligible: boolean;
  reason: string;
}

export interface RecoveryClaim extends RecoveryDecision {
  context: PipelineRigRecoveryContext | null;
  leaseOwner?: string;
  attemptNumber?: number;
}

function asDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object" && !Buffer.isBuffer(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function mapContext(row: any): PipelineRigRecoveryContext {
  return {
    jobId: Number(row.job_id),
    userPhone: String(row.user_phone),
    creationId: row.creation_id == null ? null : Number(row.creation_id),
    creationOwnerPhone: row.creation_owner_phone ? String(row.creation_owner_phone) : null,
    kind: String(row.kind),
    jobStatus: String(row.job_status),
    jobCreatedAt: asDate(row.job_created_at) ?? new Date(0),
    jobUpdatedAt: asDate(row.job_updated_at) ?? new Date(0),
    creditsReserved: Number(row.credits_reserved || 0),
    rigAttemptCount: Number(row.rig_attempt_count || 0),
    leaseOwner: row.recovery_lease_owner ? String(row.recovery_lease_owner) : null,
    leaseExpiresAt: asDate(row.recovery_lease_expires_at),
    recoveryStartedAt: asDate(row.recovery_started_at),
    recoveryReason: row.recovery_reason ? String(row.recovery_reason) : null,
    sourceModelHash: row.rig_source_model_hash ? String(row.rig_source_model_hash) : null,
    rigRefundedAt: asDate(row.rig_refunded_at),
    generationRefundedAt: asDate(row.generation_refunded_at),
    currentModelUrl: row.current_model_url ? String(row.current_model_url) : null,
    riggedModelUrl: row.rigged_model_url ? String(row.rigged_model_url) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    sessionMatchCount: Number(row.session_match_count || 0),
    sessionUserPhone: row.session_user_phone ? String(row.session_user_phone) : null,
    sessionStatus: row.session_status ? String(row.session_status) : null,
    sessionUpdatedAt: asDate(row.session_updated_at),
    customizationState: parseJsonObject(row.customization_state),
  };
}

function riggingSelection(context: PipelineRigRecoveryContext): { enabled: boolean; facial: boolean } {
  const rigging = context.customizationState?.rigging;
  if (!rigging || typeof rigging !== "object") return { enabled: false, facial: false };
  const selection = rigging as Record<string, unknown>;
  // Facial generation is fail-closed until the 75% release cohort exists.
  // Normalize cached pre-policy selections so they cannot trigger a charge or
  // a facial pass after the option has been removed from the customer UI.
  return { enabled: selection.enabled === true, facial: false };
}

export function pipelineModelFingerprint(modelUrl: string): string {
  return createHash("sha256").update(modelUrl).digest("hex");
}

function hasLiveLease(context: PipelineRigRecoveryContext, now: Date): boolean {
  return Boolean(context.leaseOwner && context.leaseExpiresAt && context.leaseExpiresAt.getTime() > now.getTime());
}

function ownsLiveLease(context: PipelineRigRecoveryContext, leaseOwner: string, now = new Date()): boolean {
  return context.leaseOwner === leaseOwner && hasLiveLease(context, now);
}

export function assessPipelineProviderRecovery(
  context: PipelineRigRecoveryContext,
  now = new Date(),
  maxAgeMs = PIPELINE_PROVIDER_RECOVERY_MAX_AGE_MS,
): RecoveryDecision {
  if (!context.sessionId) return { eligible: false, reason: "not_create_pipeline" };
  if (context.sessionMatchCount !== 1) return { eligible: false, reason: "ambiguous_session_owner" };
  if (context.kind !== "model") return { eligible: false, reason: "not_model_job" };
  if (!context.creationId) return { eligible: false, reason: "missing_creation" };
  if (!context.creationOwnerPhone) return { eligible: false, reason: "creation_missing" };
  if (context.creationOwnerPhone !== context.userPhone) return { eligible: false, reason: "ownership_mismatch" };
  if (context.sessionUserPhone !== context.userPhone) return { eligible: false, reason: "ownership_mismatch" };
  if (context.sessionStatus !== "building") return { eligible: false, reason: `session_${context.sessionStatus || "missing"}` };
  if (!['queued', 'running'].includes(context.jobStatus)) return { eligible: false, reason: `job_${context.jobStatus}` };
  if (hasLiveLease(context, now)) return { eligible: false, reason: "active_lease" };
  if (context.riggedModelUrl) return { eligible: false, reason: "already_rigged" };
  if (context.currentModelUrl) return { eligible: false, reason: "static_model_already_stored" };
  if (now.getTime() - context.jobCreatedAt.getTime() > maxAgeMs) return { eligible: false, reason: "provider_job_stale" };
  return { eligible: true, reason: "active_provider_job" };
}

export function assessPipelineRigRecovery(
  context: PipelineRigRecoveryContext,
  now = new Date(),
  maxAgeMs = PIPELINE_RIG_RECOVERY_MAX_AGE_MS,
): RecoveryDecision {
  const core = assessPipelineRigCore(context, now, maxAgeMs);
  if (!core.eligible) return core;
  if (context.rigAttemptCount >= PIPELINE_RIG_MAX_ATTEMPTS) return { eligible: false, reason: "attempt_budget_exhausted" };
  if (hasLiveLease(context, now)) return { eligible: false, reason: "active_lease" };
  return { eligible: true, reason: "active_rig_job" };
}

function assessPipelineRigCore(
  context: PipelineRigRecoveryContext,
  now = new Date(),
  maxAgeMs = PIPELINE_RIG_RECOVERY_MAX_AGE_MS,
): RecoveryDecision {
  if (!context.sessionId) return { eligible: false, reason: "missing_session" };
  if (context.sessionMatchCount !== 1) return { eligible: false, reason: "ambiguous_session_owner" };
  if (context.kind !== "model") return { eligible: false, reason: "not_model_job" };
  if (!context.creationId) return { eligible: false, reason: "missing_creation" };
  if (!context.creationOwnerPhone) return { eligible: false, reason: "creation_missing" };
  if (context.creationOwnerPhone !== context.userPhone) return { eligible: false, reason: "ownership_mismatch" };
  if (context.sessionUserPhone !== context.userPhone) return { eligible: false, reason: "ownership_mismatch" };
  if (context.sessionStatus !== "building") return { eligible: false, reason: `session_${context.sessionStatus || "missing"}` };
  if (!['rigging', 'validating'].includes(context.jobStatus)) return { eligible: false, reason: `job_${context.jobStatus}` };
  if (!riggingSelection(context).enabled) return { eligible: false, reason: "rigging_not_requested" };
  if (!context.currentModelUrl) return { eligible: false, reason: "missing_static_model" };
  if (context.riggedModelUrl) return { eligible: false, reason: "already_rigged" };
  if (!context.sourceModelHash) return { eligible: false, reason: "unbound_legacy_source" };
  if (pipelineModelFingerprint(context.currentModelUrl) !== context.sourceModelHash) {
    return { eligible: false, reason: "model_replaced" };
  }
  if (!context.recoveryStartedAt) return { eligible: false, reason: "missing_recovery_timestamp" };
  if (now.getTime() - context.recoveryStartedAt.getTime() > maxAgeMs) return { eligible: false, reason: "rig_job_stale" };
  return { eligible: true, reason: "active_rig_job" };
}

export function assessPipelineRigContinuation(
  context: PipelineRigRecoveryContext,
  now = new Date(),
  maxAgeMs = PIPELINE_RIG_RECOVERY_MAX_AGE_MS,
): RecoveryDecision {
  const core = assessPipelineRigCore(context, now, maxAgeMs);
  if (!core.eligible) return core;
  if (context.rigAttemptCount < 1 || context.rigAttemptCount > PIPELINE_RIG_MAX_ATTEMPTS) {
    return { eligible: false, reason: "invalid_attempt_number" };
  }
  return { eligible: true, reason: "active_rig_attempt" };
}

export function formatPipelineRecoveryDiagnostic(context: PipelineRigRecoveryContext, decision: RecoveryDecision, now = new Date()): string {
  const ageMs = Math.max(0, now.getTime() - context.jobCreatedAt.getTime());
  return [
    `job=${context.jobId}`,
    `decision=${decision.eligible ? "resume" : "skip"}`,
    `reason=${decision.reason}`,
    `jobStatus=${context.jobStatus}`,
    `sessionStatus=${context.sessionStatus || "missing"}`,
    `sessionMatches=${context.sessionMatchCount}`,
    `ageMs=${ageMs}`,
    `attempts=${context.rigAttemptCount}/${PIPELINE_RIG_MAX_ATTEMPTS}`,
    `leaseOwner=${context.leaseOwner || "none"}`,
    `leaseExpiresAt=${context.leaseExpiresAt?.toISOString() || "none"}`,
    `sourceBound=${Boolean(context.sourceModelHash)}`,
    `currentModel=${Boolean(context.currentModelUrl)}`,
    `riggedModel=${Boolean(context.riggedModelUrl)}`,
  ].join(" ");
}

export class PipelineRigRecoveryStore {
  private readonly poolProvider: () => mysql.Pool;

  constructor(pool: mysql.Pool | (() => mysql.Pool)) {
    this.poolProvider = typeof pool === "function" ? pool : () => pool;
  }

  private get pool(): mysql.Pool {
    return this.poolProvider();
  }

  private async loadContext(queryable: Queryable, jobId: number, lock = false): Promise<PipelineRigRecoveryContext | null> {
    const [rows] = await queryable.query(
      `SELECT gj.id AS job_id, gj.user_phone, gj.creation_id, gj.kind, gj.status AS job_status,
              gj.created_at AS job_created_at, gj.updated_at AS job_updated_at, gj.credits_reserved,
              gj.rig_attempt_count, gj.recovery_lease_owner, gj.recovery_lease_expires_at,
              gj.recovery_started_at, gj.recovery_reason, gj.rig_source_model_hash, gj.rig_refunded_at,
              gj.generation_refunded_at,
              c.user_phone AS creation_owner_phone, c.model_url AS current_model_url, c.rigged_model_url,
              cps.id AS session_id, cps.user_phone AS session_user_phone, cps.status AS session_status,
              cps.updated_at AS session_updated_at, cps.customization_state,
              (SELECT COUNT(*) FROM create_pipeline_sessions matches WHERE matches.build_job_id = gj.id) AS session_match_count
         FROM generation_jobs gj
         LEFT JOIN creations c ON c.id = gj.creation_id
         LEFT JOIN create_pipeline_sessions cps ON cps.build_job_id = gj.id
        WHERE gj.id = ?
        LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [jobId],
    ) as any;
    return rows?.[0] ? mapContext(rows[0]) : null;
  }

  getContext(jobId: number): Promise<PipelineRigRecoveryContext | null> {
    return this.loadContext(this.pool, jobId);
  }

  async listRigRecoveryCandidates(limit = 20): Promise<number[]> {
    const [rows] = await this.pool.query(
      `SELECT id FROM generation_jobs
        WHERE status IN ('rigging','validating')
          AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at <= NOW(3))
        ORDER BY updated_at ASC LIMIT ?`,
      [Math.max(1, Math.min(limit, 100))],
    ) as any;
    return (rows as any[]).map((row) => Number(row.id));
  }

  async claimProviderPoll(jobId: number, maxAgeMs = PIPELINE_PROVIDER_RECOVERY_MAX_AGE_MS): Promise<RecoveryClaim> {
    const conn = await this.pool.getConnection();
    const leaseOwner = `provider-${process.pid}-${randomUUID()}`;
    try {
      await conn.query("START TRANSACTION");
      const context = await this.loadContext(conn, jobId, true);
      if (!context) {
        await conn.query("ROLLBACK");
        return { eligible: false, reason: "job_missing", context: null };
      }
      const decision = assessPipelineProviderRecovery(context, new Date(), maxAgeMs);
      if (!decision.eligible) {
        await conn.query(
          "UPDATE generation_jobs SET recovery_reason = ? WHERE id = ?",
          [decision.reason, jobId],
        );
        await conn.query("COMMIT");
        return { ...decision, context };
      }
      await conn.query(
        `UPDATE generation_jobs
            SET recovery_lease_owner = ?, recovery_lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? MICROSECOND),
                recovery_started_at = COALESCE(recovery_started_at, NOW(3)), recovery_reason = 'provider_poll_claimed',
                recovery_last_heartbeat_at = NOW(3)
          WHERE id = ?`,
        [leaseOwner, PIPELINE_RECOVERY_LEASE_MS * 1000, jobId],
      );
      await conn.query("COMMIT");
      return { eligible: true, reason: "provider_poll_claimed", context, leaseOwner };
    } catch (error) {
      await conn.query("ROLLBACK");
      throw error;
    } finally {
      conn.release();
    }
  }

  async releaseProviderPoll(jobId: number, leaseOwner: string, reason: string, status: 'queued' | 'running' = 'running'): Promise<boolean> {
    const [result] = await this.pool.query(
      `UPDATE generation_jobs
          SET status = ?, recovery_lease_owner = NULL, recovery_lease_expires_at = NULL,
              recovery_reason = ?, recovery_last_heartbeat_at = NOW(3)
        WHERE id = ? AND recovery_lease_owner = ? AND recovery_lease_expires_at > NOW(3)`,
      [status, reason.slice(0, 255), jobId, leaseOwner],
    ) as any;
    return result.affectedRows === 1;
  }

  async prepareRig(jobId: number, providerLeaseOwner: string, modelUrl: string): Promise<RecoveryClaim> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query("START TRANSACTION");
      const context = await this.loadContext(conn, jobId, true);
      if (!context) {
        await conn.query("ROLLBACK");
        return { eligible: false, reason: "job_missing", context: null };
      }
      if (!ownsLiveLease(context, providerLeaseOwner)) {
        await conn.query("ROLLBACK");
        return { eligible: false, reason: "provider_lease_lost", context };
      }
      if (context.sessionStatus !== "building" || context.sessionUserPhone !== context.userPhone) {
        await conn.query("ROLLBACK");
        return { eligible: false, reason: "session_no_longer_active", context };
      }
      if (!riggingSelection(context).enabled) {
        await conn.query("ROLLBACK");
        return { eligible: false, reason: "rigging_not_requested", context };
      }
      if (context.currentModelUrl !== modelUrl) {
        await conn.query("ROLLBACK");
        return { eligible: false, reason: "model_replaced", context };
      }
      if (context.riggedModelUrl) {
        await conn.query("ROLLBACK");
        return { eligible: false, reason: "already_rigged", context };
      }
      await conn.query(
        `UPDATE generation_jobs
            SET status = 'rigging', rig_source_model_hash = ?, recovery_started_at = NOW(3),
                recovery_reason = 'rig_prepared', recovery_lease_owner = NULL,
                recovery_lease_expires_at = NULL, recovery_last_heartbeat_at = NOW(3)
          WHERE id = ? AND recovery_lease_owner = ?`,
        [pipelineModelFingerprint(modelUrl), jobId, providerLeaseOwner],
      );
      await conn.query("COMMIT");
      return { eligible: true, reason: "rig_prepared", context: { ...context, jobStatus: "rigging", sourceModelHash: pipelineModelFingerprint(modelUrl), recoveryStartedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } };
    } catch (error) {
      await conn.query("ROLLBACK");
      throw error;
    } finally {
      conn.release();
    }
  }

  async claimRigAttempt(jobId: number, maxAgeMs = PIPELINE_RIG_RECOVERY_MAX_AGE_MS): Promise<RecoveryClaim> {
    const conn = await this.pool.getConnection();
    const leaseOwner = `rig-${process.pid}-${randomUUID()}`;
    try {
      await conn.query("START TRANSACTION");
      const context = await this.loadContext(conn, jobId, true);
      if (!context) {
        await conn.query("ROLLBACK");
        return { eligible: false, reason: "job_missing", context: null };
      }
      const decision = assessPipelineRigRecovery(context, new Date(), maxAgeMs);
      if (!decision.eligible) {
        await conn.query("UPDATE generation_jobs SET recovery_reason = ? WHERE id = ?", [decision.reason, jobId]);
        await conn.query("COMMIT");
        return { ...decision, context };
      }
      const attemptNumber = context.rigAttemptCount + 1;
      await conn.query(
        `UPDATE generation_jobs
            SET rig_attempt_count = ?, recovery_lease_owner = ?,
                recovery_lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? MICROSECOND),
                recovery_reason = ?, recovery_last_heartbeat_at = NOW(3)
          WHERE id = ?`,
        [attemptNumber, leaseOwner, PIPELINE_RECOVERY_LEASE_MS * 1000, `rig_attempt_${attemptNumber}_claimed`, jobId],
      );
      await conn.query("COMMIT");
      return { eligible: true, reason: "rig_attempt_claimed", context, leaseOwner, attemptNumber };
    } catch (error) {
      await conn.query("ROLLBACK");
      throw error;
    } finally {
      conn.release();
    }
  }

  async heartbeat(jobId: number, leaseOwner: string): Promise<boolean> {
    const [result] = await this.pool.query(
      `UPDATE generation_jobs
          SET recovery_lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? MICROSECOND),
              recovery_last_heartbeat_at = NOW(3)
        WHERE id = ? AND recovery_lease_owner = ? AND recovery_lease_expires_at > NOW(3)
          AND status IN ('rigging','validating')`,
      [PIPELINE_RECOVERY_LEASE_MS * 1000, jobId, leaseOwner],
    ) as any;
    return result.affectedRows === 1;
  }

  async setRigPhase(jobId: number, leaseOwner: string, status: 'rigging' | 'validating', reason: string): Promise<boolean> {
    const [result] = await this.pool.query(
      `UPDATE generation_jobs SET status = ?, recovery_reason = ?
        WHERE id = ? AND recovery_lease_owner = ? AND recovery_lease_expires_at > NOW(3)`,
      [status, reason.slice(0, 255), jobId, leaseOwner],
    ) as any;
    return result.affectedRows === 1;
  }

  async verifyRigLease(jobId: number, leaseOwner: string): Promise<RecoveryDecision> {
    const context = await this.loadContext(this.pool, jobId);
    if (!context) return { eligible: false, reason: "job_missing" };
    if (context.leaseOwner !== leaseOwner) return { eligible: false, reason: "lease_lost" };
    if (!ownsLiveLease(context, leaseOwner)) return { eligible: false, reason: "lease_expired" };
    const decision = assessPipelineRigContinuation(context);
    return decision.eligible ? { eligible: true, reason: "lease_and_model_current" } : decision;
  }

  async recordAttemptFailure(jobId: number, leaseOwner: string, detail: string): Promise<boolean> {
    const [result] = await this.pool.query(
      `UPDATE generation_jobs
          SET status = 'rigging', error = ?, recovery_reason = ?, recovery_lease_owner = NULL,
              recovery_lease_expires_at = NULL, recovery_last_heartbeat_at = NOW(3)
        WHERE id = ? AND recovery_lease_owner = ? AND recovery_lease_expires_at > NOW(3)`,
      [detail.slice(0, 512), "rig_attempt_failed", jobId, leaseOwner],
    ) as any;
    return result.affectedRows === 1;
  }

  async completeWithoutRig(jobId: number, providerLeaseOwner: string | null, reason = "static_model_complete"): Promise<boolean> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query("START TRANSACTION");
      const context = await this.loadContext(conn, jobId, true);
      if (!context || (providerLeaseOwner && !ownsLiveLease(context, providerLeaseOwner))) {
        await conn.query("ROLLBACK");
        return false;
      }
      await conn.query(
        `UPDATE generation_jobs SET status = 'done', error = NULL, recovery_reason = ?,
                recovery_lease_owner = NULL, recovery_lease_expires_at = NULL
          WHERE id = ?`,
        [reason.slice(0, 255), jobId],
      );
      if (context.sessionId) {
        await conn.query(
          "UPDATE create_pipeline_sessions SET status = 'complete' WHERE id = ? AND build_job_id = ? AND status = 'building'",
          [context.sessionId, jobId],
        );
      }
      await conn.query("COMMIT");
      return true;
    } catch (error) {
      await conn.query("ROLLBACK");
      throw error;
    } finally {
      conn.release();
    }
  }

  async completeRig(jobId: number, leaseOwner: string, riggedModelUrl: string, report: unknown, message: string | null): Promise<RecoveryDecision> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query("START TRANSACTION");
      const context = await this.loadContext(conn, jobId, true);
      if (!context) {
        await conn.query("ROLLBACK");
        return { eligible: false, reason: "job_missing" };
      }
      const leaseDecision = ownsLiveLease(context, leaseOwner)
        ? assessPipelineRigContinuation(context)
        : { eligible: false, reason: context.leaseOwner === leaseOwner ? "lease_expired" : "lease_lost" };
      if (!leaseDecision.eligible || !context.creationId) {
        await conn.query("ROLLBACK");
        return leaseDecision;
      }
      const [creationResult] = await conn.query(
        `UPDATE creations SET rigged_model_url = ?, rig_report = ?
          WHERE id = ? AND user_phone = ? AND model_url = ? AND (rigged_model_url IS NULL OR rigged_model_url = '')`,
        [riggedModelUrl, JSON.stringify(report ?? null), context.creationId, context.userPhone, context.currentModelUrl],
      ) as any;
      if (creationResult.affectedRows !== 1) {
        await conn.query("ROLLBACK");
        return { eligible: false, reason: "model_replaced_before_commit" };
      }
      await conn.query(
        `UPDATE generation_jobs SET status = 'done', error = ?, recovery_reason = 'rig_complete',
                recovery_lease_owner = NULL, recovery_lease_expires_at = NULL
          WHERE id = ? AND recovery_lease_owner = ?`,
        [message, jobId, leaseOwner],
      );
      await conn.query(
        "UPDATE create_pipeline_sessions SET status = 'complete' WHERE id = ? AND build_job_id = ? AND status = 'building'",
        [context.sessionId, jobId],
      );
      await conn.query("COMMIT");
      return { eligible: true, reason: "rig_complete" };
    } catch (error) {
      await conn.query("ROLLBACK");
      throw error;
    } finally {
      conn.release();
    }
  }

  async finalizeRejected(jobId: number, reason: string, rigAddonCredits: number, expectedLeaseOwner?: string): Promise<{ status: string; refunded: boolean }> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query("START TRANSACTION");
      const context = await this.loadContext(conn, jobId, true);
      if (!context) {
        await conn.query("ROLLBACK");
        return { status: "missing", refunded: false };
      }
      if (['done', 'done_static_fallback', 'failed'].includes(context.jobStatus)) {
        await conn.query("ROLLBACK");
        return { status: context.jobStatus, refunded: false };
      }
      if (hasLiveLease(context, new Date()) && context.leaseOwner !== expectedLeaseOwner) {
        await conn.query("ROLLBACK");
        return { status: "active", refunded: false };
      }
      const hasStatic = Boolean(context.currentModelUrl);
      const hasRig = Boolean(context.riggedModelUrl);
      const status = hasRig ? "done" : hasStatic ? "done_static_fallback" : "failed";
      let refunded = false;
      const refundAmount = status === "failed"
        ? context.generationRefundedAt ? 0 : context.creditsReserved
        : status === "done_static_fallback" && !context.rigRefundedAt
          ? rigAddonCredits
          : 0;
      if (refundAmount > 0) {
        const boundedRefund = Math.min(Math.max(0, Math.trunc(refundAmount)), context.creditsReserved);
        if (boundedRefund > 0) {
          const refundKind = status === "failed" ? "generation" : "rig";
          const reasonCode = status === "failed" ? "generation_job_refund" : "rig_addon_refund";
          await applyWalletClaimInTransaction(conn, {
            ownerId: context.userPhone,
            correlationId: `generation-job:${context.jobId}:${refundKind}:refund`,
            expected: { delta: boundedRefund, reason: reasonCode },
            resolve: async () => ({ delta: boundedRefund, reason: reasonCode }),
          });
          refunded = true;
        }
      }
      await conn.query(
        `UPDATE generation_jobs
            SET status = ?, error = ?, recovery_reason = ?, recovery_lease_owner = NULL,
                recovery_lease_expires_at = NULL,
                rig_refunded_at = CASE WHEN ? AND ? = 'done_static_fallback' THEN COALESCE(rig_refunded_at, NOW(3)) ELSE rig_refunded_at END,
                generation_refunded_at = CASE WHEN ? AND ? = 'failed' THEN COALESCE(generation_refunded_at, NOW(3)) ELSE generation_refunded_at END
          WHERE id = ?`,
        [status, reason.slice(0, 512), reason.slice(0, 255), refunded, status, refunded, status, jobId],
      );
      if (context.sessionId && hasStatic) {
        await conn.query(
          "UPDATE create_pipeline_sessions SET status = 'complete' WHERE id = ? AND build_job_id = ? AND status IN ('building','recovery_required')",
          [context.sessionId, jobId],
        );
      } else if (context.sessionId && !hasStatic) {
        await conn.query(
          "UPDATE create_pipeline_sessions SET status = 'failed' WHERE id = ? AND build_job_id = ? AND status IN ('building','recovery_required')",
          [context.sessionId, jobId],
        );
      }
      await conn.query("COMMIT");
      return { status, refunded };
    } catch (error) {
      await conn.query("ROLLBACK");
      throw error;
    } finally {
      conn.release();
    }
  }
}

export function pipelineRiggingSelection(context: PipelineRigRecoveryContext): { enabled: boolean; facial: boolean } {
  return riggingSelection(context);
}
