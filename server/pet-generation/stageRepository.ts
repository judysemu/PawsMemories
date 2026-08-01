import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import { refundWalletDebitInTransaction } from "../wallet";
import { PetGenerationError } from "./provider";
import type { PetGlbModelStageKind, PetGlbStageKind, RigCapability } from "./types";
import type { ValidationReport } from "./validation";

export type StageAttemptState =
  | "awaiting_customer_approval"
  | "queued"
  | "processing"
  | "persisting"
  | "approved"
  | "rejected"
  | "failed"
  | "recovery_required";

export interface PetGlbStageAttempt {
  id: number;
  attemptUuid: string;
  orderId: number;
  stage: PetGlbStageKind;
  attemptNumber: number;
  state: StageAttemptState;
  inputHash: string;
  sourceAttemptId: number | null;
  providerJobId: string | null;
  assetId: number | null;
  assetVersionId: number | null;
  artifactSha256: string | null;
  validationReport: ValidationReport | null;
  validationReportSha256: string | null;
  capabilityReport: RigCapability | null;
  priceCredits: number;
  creditsDisposition: "none" | "charged" | "refunded";
  approvedAt: Date | null;
  rejectionReason: string | null;
  failureCode: string | null;
  recoveryLeaseOwner: string | null;
  recoveryLeaseExpiresAt: Date | null;
  recoveryAttempts: number;
  lastRecoveryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExactStageApproval {
  idempotencyKey: string;
  attemptUuid: string;
  artifactSha256: string;
  assetVersionId: number | null;
  reportSha256: string | null;
  approvalHash: string;
}

function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function mapAttempt(row: any): PetGlbStageAttempt {
  return {
    id: Number(row.id),
    attemptUuid: String(row.attempt_uuid),
    orderId: Number(row.order_id),
    stage: row.stage,
    attemptNumber: Number(row.attempt_number),
    state: row.state,
    inputHash: String(row.input_hash),
    sourceAttemptId: row.source_attempt_id ? Number(row.source_attempt_id) : null,
    providerJobId: row.provider_job_id ?? null,
    assetId: row.asset_id ? Number(row.asset_id) : null,
    assetVersionId: row.asset_version_id ? Number(row.asset_version_id) : null,
    artifactSha256: row.artifact_sha256 ?? null,
    validationReport: parseJson<ValidationReport>(row.validation_report_json),
    validationReportSha256: row.validation_report_sha256 ?? null,
    capabilityReport: parseJson<RigCapability>(row.capability_report_json),
    priceCredits: Number(row.price_credits || 0),
    creditsDisposition: row.credits_disposition,
    approvedAt: row.approved_at ? new Date(row.approved_at) : null,
    rejectionReason: row.rejection_reason ?? null,
    failureCode: row.failure_code ?? null,
    recoveryLeaseOwner: row.recovery_lease_owner ?? null,
    recoveryLeaseExpiresAt: row.recovery_lease_expires_at ? new Date(row.recovery_lease_expires_at) : null,
    recoveryAttempts: Number(row.recovery_attempts || 0),
    lastRecoveryAt: row.last_recovery_at ? new Date(row.last_recovery_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

const ORDER_STATE_FOR_QUEUE: Record<Exclude<PetGlbStageKind, "reference">, string> = {
  base: "base_queued",
  texture: "texture_queued",
  rig_check: "rig_checking",
  rig: "rig_queued",
};

const ORDER_STATE_FOR_PROCESSING: Record<Exclude<PetGlbStageKind, "reference">, string> = {
  base: "base_generating",
  texture: "texture_generating",
  rig_check: "rig_checking",
  rig: "rig_generating",
};

const ORDER_STATE_FOR_REVIEW: Record<Exclude<PetGlbStageKind, "reference">, string> = {
  base: "awaiting_base_approval",
  texture: "awaiting_texture_approval",
  rig_check: "awaiting_rig_purchase",
  rig: "awaiting_rig_approval",
};

export class PetGlbStageRepository {
  constructor(private readonly getPool: () => mysql.Pool) {}

  async findCurrent(orderId: number): Promise<PetGlbStageAttempt | null> {
    const [rows] = await this.getPool().query(
      `SELECT s.*
         FROM pet_glb_orders o
         JOIN pet_glb_stage_attempts s ON s.id = o.current_stage_attempt_id
        WHERE o.id = ?
        LIMIT 1`,
      [orderId],
    );
    const row = (rows as any[])[0];
    return row ? mapAttempt(row) : null;
  }

  async findById(id: number): Promise<PetGlbStageAttempt | null> {
    const [rows] = await this.getPool().query(
      "SELECT * FROM pet_glb_stage_attempts WHERE id = ? LIMIT 1",
      [id],
    );
    const row = (rows as any[])[0];
    return row ? mapAttempt(row) : null;
  }

  async listForOrder(orderId: number): Promise<PetGlbStageAttempt[]> {
    const [rows] = await this.getPool().query(
      "SELECT * FROM pet_glb_stage_attempts WHERE order_id = ? ORDER BY id ASC",
      [orderId],
    );
    return (rows as any[]).map(mapAttempt);
  }

  async listStaleCurrentAttempts(leaseMinutes = 10, limit = 25): Promise<PetGlbStageAttempt[]> {
    const minutes = Math.max(1, Math.floor(leaseMinutes));
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const [rows] = await this.getPool().query(
      `SELECT s.* FROM pet_glb_stage_attempts s JOIN pet_glb_orders o ON o.current_stage_attempt_id = s.id
       WHERE s.state IN ('queued','processing','persisting','recovery_required')
         AND s.updated_at < DATE_SUB(NOW(3), INTERVAL ${minutes} MINUTE)
         AND (s.recovery_lease_expires_at IS NULL OR s.recovery_lease_expires_at <= NOW(3))
       ORDER BY s.updated_at ASC LIMIT ${boundedLimit}`,
    );
    return (rows as any[]).map(mapAttempt);
  }

  async claimRecoveryLease(input: {
    orderId: number;
    attemptId: number;
    leaseOwner: string;
    staleMinutes?: number;
    leaseSeconds?: number;
  }): Promise<PetGlbStageAttempt | null> {
    const staleMinutes = Math.max(1, Math.min(24 * 60, Math.floor(input.staleMinutes ?? 10)));
    const leaseSeconds = Math.max(15, Math.min(5 * 60, Math.floor(input.leaseSeconds ?? 90)));
    const [result] = await this.getPool().query(
      `UPDATE pet_glb_stage_attempts s
         JOIN pet_glb_orders o ON o.id = s.order_id AND o.current_stage_attempt_id = s.id
          SET s.recovery_lease_owner = ?,
              s.recovery_lease_expires_at = DATE_ADD(NOW(3), INTERVAL ${leaseSeconds} SECOND),
              s.recovery_attempts = s.recovery_attempts + 1,
              s.last_recovery_at = NOW(3)
        WHERE s.id = ? AND s.order_id = ?
          AND s.state IN ('queued','processing','persisting','recovery_required')
          AND s.updated_at < DATE_SUB(NOW(3), INTERVAL ${staleMinutes} MINUTE)
          AND (s.recovery_lease_expires_at IS NULL OR s.recovery_lease_expires_at <= NOW(3))`,
      [input.leaseOwner, input.attemptId, input.orderId],
    );
    if ((result as any).affectedRows !== 1) return null;
    return this.findById(input.attemptId);
  }

  async resumeClaimedProviderRecovery(
    orderId: number,
    attemptId: number,
    leaseOwner: string,
  ): Promise<PetGlbStageAttempt> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(
        "SELECT * FROM pet_glb_stage_attempts WHERE id = ? AND order_id = ? FOR UPDATE",
        [attemptId, orderId],
      );
      const attempt = (rows as any[])[0] ? mapAttempt((rows as any[])[0]) : null;
      if (!attempt || !attempt.providerJobId) {
        throw new PetGenerationError("RECOVERY_NOT_RESUMABLE", "Recovery has no durable provider job");
      }
      if (attempt.recoveryLeaseOwner !== leaseOwner || !attempt.recoveryLeaseExpiresAt || attempt.recoveryLeaseExpiresAt.getTime() <= Date.now()) {
        throw new PetGenerationError("RECOVERY_LEASE_LOST", "Recovery lease is no longer current");
      }
      if (attempt.stage === "reference") {
        throw new PetGenerationError("RECOVERY_NOT_RESUMABLE", "Reference approval has no provider job");
      }
      const [result] = await conn.query(
        `UPDATE pet_glb_stage_attempts
            SET state = 'processing', failure_code = NULL, updated_at = NOW(3),
                recovery_lease_owner = NULL, recovery_lease_expires_at = NULL
          WHERE id = ? AND order_id = ? AND recovery_lease_owner = ?
            AND recovery_lease_expires_at > NOW(3)`,
        [attemptId, orderId, leaseOwner],
      );
      if ((result as any).affectedRows !== 1) {
        throw new PetGenerationError("RECOVERY_LEASE_LOST", "Recovery resume lost its lease");
      }
      await conn.query(
        "UPDATE pet_glb_orders SET state = ?, updated_at = NOW(3) WHERE id = ? AND current_stage_attempt_id = ?",
        [ORDER_STATE_FOR_PROCESSING[attempt.stage], orderId, attemptId],
      );
      await conn.commit();
      return {
        ...attempt,
        state: "processing",
        failureCode: null,
        recoveryLeaseOwner: null,
        recoveryLeaseExpiresAt: null,
        updatedAt: new Date(),
      };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async releaseRecoveryLease(
    orderId: number,
    attemptId: number,
    leaseOwner: string,
    touch = false,
  ): Promise<boolean> {
    const [result] = await this.getPool().query(
      `UPDATE pet_glb_stage_attempts
          SET recovery_lease_owner = NULL, recovery_lease_expires_at = NULL,
              updated_at = IF(?, NOW(3), updated_at)
        WHERE id = ? AND order_id = ? AND recovery_lease_owner = ?`,
      [touch ? 1 : 0, attemptId, orderId, leaseOwner],
    );
    return (result as any).affectedRows === 1;
  }

  async recordRecoveryEvidence(input: { orderId: number; attemptId: number; decision: string; reasonCode: string; providerHandlePresent: boolean; refundCorrelationId?: string | null; evidence: Record<string, unknown> }): Promise<void> {
    await this.getPool().query(
      `INSERT INTO pet_glb_recovery_evidence (stage_attempt_id, order_id, decision, reason_code, provider_handle_present, refund_correlation_id, redacted_evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE redacted_evidence_json = VALUES(redacted_evidence_json)`,
      [input.attemptId, input.orderId, input.decision, input.reasonCode, input.providerHandlePresent ? 1 : 0, input.refundCorrelationId || null, JSON.stringify(input.evidence)],
    );
  }

  async listRecoveryEvidence(orderId: number): Promise<Array<Record<string, unknown>>> {
    const [rows] = await this.getPool().query("SELECT * FROM pet_glb_recovery_evidence WHERE order_id = ? ORDER BY id ASC", [orderId]);
    return (rows as any[]).map((row) => ({ id: Number(row.id), stageAttemptId: Number(row.stage_attempt_id), orderId: Number(row.order_id), decision: row.decision, reasonCode: row.reason_code, providerHandlePresent: Boolean(row.provider_handle_present), refundCorrelationId: row.refund_correlation_id || null, evidence: parseJson(row.redacted_evidence_json) || {}, createdAt: new Date(row.created_at) }));
  }

  async saveReferenceManifest(
    orderId: number,
    ownerPhone: string,
    manifest: Record<string, string>,
    manifestHash: string,
  ): Promise<PetGlbStageAttempt> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();
      const order = await this.lockOrder(conn, orderId, ownerPhone);
      if (!["awaiting_references", "stage_rejected"].includes(order.state)) {
        throw new PetGenerationError(
          "ILLEGAL_TRANSITION",
          `References cannot be changed from state ${order.state}`,
        );
      }
      const attempt = await this.insertAttempt(conn, {
        orderId,
        stage: "reference",
        state: "awaiting_customer_approval",
        inputHash: manifestHash,
        sourceAttemptId: null,
        priceCredits: 0,
        creditsDisposition: "none",
        artifactSha256: manifestHash,
      });
      await conn.query(
        `UPDATE pet_glb_orders
            SET reference_manifest_json = ?, reference_manifest_hash = ?,
                current_stage = 'reference', current_stage_attempt_id = ?,
                state = 'awaiting_reference_approval', updated_at = NOW()
          WHERE id = ?`,
        [JSON.stringify(manifest), manifestHash, attempt.id, orderId],
      );
      await this.writeEvent(conn, orderId, order.state, "awaiting_reference_approval", ownerPhone, "references_saved");
      await conn.commit();
      return attempt;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * Approves the exact current attempt and atomically creates/charges the next
   * stage. No provider call occurs inside this transaction.
   */
  async approveAndQueueNext(input: {
    orderId: number;
    ownerPhone: string;
    approval: ExactStageApproval;
    nextStage: Exclude<PetGlbStageKind, "reference"> | null;
    nextInputHash: string | null;
    nextPriceCredits: number;
  }): Promise<{ current: PetGlbStageAttempt; next: PetGlbStageAttempt | null }> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();
      const order = await this.lockOrder(conn, input.orderId, input.ownerPhone);

      const [duplicateRows] = await conn.query(
        "SELECT * FROM pet_glb_stage_attempts WHERE approval_idempotency_key = ? LIMIT 1 FOR UPDATE",
        [input.approval.idempotencyKey],
      );
      const duplicate = (duplicateRows as any[])[0];
      if (duplicate) {
        const approved = mapAttempt(duplicate);
        if (approved.attemptUuid !== input.approval.attemptUuid) {
          throw new PetGenerationError("IDEMPOTENCY_CONFLICT", "Approval key was used for another attempt");
        }
        const current = await this.currentWithConnection(conn, input.orderId);
        await conn.commit();
        return { current: approved, next: current?.id === approved.id ? null : current };
      }

      const current = await this.currentWithConnection(conn, input.orderId, true);
      if (!current || current.state !== "awaiting_customer_approval") {
        throw new PetGenerationError("STAGE_NOT_APPROVABLE", "Current stage is not awaiting approval");
      }
      this.assertExactApproval(current, input.approval);

      const [approveResult] = await conn.query(
        `UPDATE pet_glb_stage_attempts
            SET state = 'approved', approval_idempotency_key = ?, approval_hash = ?,
                approved_by = ?, approved_at = NOW(), updated_at = NOW()
          WHERE id = ? AND state = 'awaiting_customer_approval'`,
        [
          input.approval.idempotencyKey,
          input.approval.approvalHash,
          input.ownerPhone,
          current.id,
        ],
      );
      if ((approveResult as any).affectedRows !== 1) {
        throw new PetGenerationError("CONCURRENT_TRANSITION", "Stage approval lost a concurrent race");
      }

      if (!input.nextStage) {
        if (!current.assetVersionId) {
          throw new PetGenerationError("NO_FINAL_ASSET", "A reference/capability stage cannot be delivered");
        }
        await conn.query(
          `UPDATE pet_glb_orders
              SET state = 'awaiting_human_review', final_customer_version_id = ?,
                  updated_at = NOW()
            WHERE id = ?`,
          [current.assetVersionId, input.orderId],
        );
        await this.writeEvent(
          conn,
          input.orderId,
          order.state,
          "awaiting_human_review",
          input.ownerPhone,
          `${current.stage}_customer_approved`,
        );
        await conn.commit();
        return { current: { ...current, state: "approved" }, next: null };
      }

      if (!input.nextInputHash) {
        throw new PetGenerationError("NEXT_INPUT_HASH_REQUIRED", "Next stage input hash is missing");
      }
      if (input.nextPriceCredits > 0) {
        await this.chargeWallet(
          conn,
          input.ownerPhone,
          input.nextPriceCredits,
          `pet_glb:${order.order_uuid}:${input.nextStage}:${input.approval.idempotencyKey}`,
          `pet_glb_${input.nextStage}`,
        );
      }

      const next = await this.insertAttempt(conn, {
        orderId: input.orderId,
        stage: input.nextStage,
        state: "queued",
        inputHash: input.nextInputHash,
        sourceAttemptId: current.id,
        priceCredits: input.nextPriceCredits,
        creditsDisposition: input.nextPriceCredits > 0 ? "charged" : "none",
        chargeIdempotencyKey: input.nextPriceCredits > 0
          ? `pet_glb:${order.order_uuid}:${input.nextStage}:${input.approval.idempotencyKey}`
          : null,
      });
      const toState = ORDER_STATE_FOR_QUEUE[input.nextStage];
      await conn.query(
        `UPDATE pet_glb_orders
            SET current_stage = ?, current_stage_attempt_id = ?, state = ?,
                credits_reserved = credits_reserved + ?, updated_at = NOW()
          WHERE id = ?`,
        [input.nextStage, next.id, toState, input.nextPriceCredits, input.orderId],
      );
      await this.writeEvent(
        conn,
        input.orderId,
        order.state,
        toState,
        input.ownerPhone,
        `${current.stage}_approved_start_${input.nextStage}`,
      );
      await conn.commit();
      return { current: { ...current, state: "approved" }, next };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async attachProviderJob(
    orderId: number,
    attemptId: number,
    providerJobId: string,
  ): Promise<PetGlbStageAttempt> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(
        "SELECT * FROM pet_glb_stage_attempts WHERE id = ? AND order_id = ? FOR UPDATE",
        [attemptId, orderId],
      );
      const attempt = (rows as any[])[0] ? mapAttempt((rows as any[])[0]) : null;
      if (!attempt) throw new PetGenerationError("STAGE_NOT_FOUND", "Stage attempt not found");
      if (attempt.providerJobId) {
        if (attempt.providerJobId !== providerJobId) {
          throw new PetGenerationError("PROVIDER_JOB_CONFLICT", "Stage already has another provider job");
        }
        await conn.commit();
        return attempt;
      }
      if (attempt.state !== "queued" || attempt.stage === "reference") {
        throw new PetGenerationError("ILLEGAL_TRANSITION", "Stage is not queued for provider work");
      }
      await conn.query(
        "UPDATE pet_glb_stage_attempts SET provider_job_id = ?, state = 'processing', updated_at = NOW() WHERE id = ?",
        [providerJobId, attempt.id],
      );
      const toState = ORDER_STATE_FOR_PROCESSING[attempt.stage];
      await conn.query(
        "UPDATE pet_glb_orders SET generation_job_id = ?, state = ?, updated_at = NOW() WHERE id = ?",
        [providerJobId, toState, orderId],
      );
      await conn.commit();
      return { ...attempt, providerJobId, state: "processing" };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * Claims the completed provider result for validation/persistence. The state
   * predicate makes concurrent poll requests single-winner. A claim abandoned
   * by a crashed process can be reclaimed after ten minutes; content-addressed
   * object keys keep the storage upload itself retry-safe.
   */
  async claimCompletion(orderId: number, attemptId: number): Promise<boolean> {
    const [result] = await this.getPool().query(
      `UPDATE pet_glb_stage_attempts
          SET state = 'persisting', updated_at = NOW()
        WHERE id = ? AND order_id = ?
          AND (
            state = 'processing'
            OR (state = 'persisting' AND updated_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE))
          )`,
      [attemptId, orderId],
    );
    return (result as any).affectedRows === 1;
  }

  /**
   * A provider job was accepted, but attaching/finalizing it became uncertain.
   * Preserve the local provider job id and charge instead of submitting a
   * second paid provider task or issuing an unsafe refund.
   */
  async markRecoveryRequired(input: {
    orderId: number;
    attemptId: number;
    providerJobId: string;
    failureCode: string;
  }): Promise<void> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `UPDATE pet_glb_stage_attempts
            SET provider_job_id = COALESCE(provider_job_id, ?),
                state = 'recovery_required', failure_code = ?, updated_at = NOW()
          WHERE id = ? AND order_id = ?
            AND state IN ('queued','processing','persisting','recovery_required')`,
        [input.providerJobId, input.failureCode, input.attemptId, input.orderId],
      );
      if ((result as any).affectedRows !== 1) {
        throw new PetGenerationError("RECOVERY_RECORD_FAILED", "Could not preserve the accepted provider job");
      }
      await conn.query(
        `UPDATE pet_glb_orders
            SET generation_job_id = ?, state = 'recovery_required', updated_at = NOW()
          WHERE id = ? AND current_stage_attempt_id = ?`,
        [input.providerJobId, input.orderId, input.attemptId],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async resumeProviderRecovery(
    orderId: number,
    attemptId: number,
  ): Promise<PetGlbStageAttempt> {
    const attempt = await this.findById(attemptId);
    if (!attempt || attempt.orderId !== orderId || !attempt.providerJobId) {
      throw new PetGenerationError("RECOVERY_NOT_RESUMABLE", "Recovery has no durable provider job");
    }
    if (attempt.stage === "reference") {
      throw new PetGenerationError("RECOVERY_NOT_RESUMABLE", "Reference approval has no provider job");
    }
    const [result] = await this.getPool().query(
      `UPDATE pet_glb_stage_attempts
          SET state = 'processing', failure_code = NULL, updated_at = NOW()
        WHERE id = ? AND order_id = ? AND state = 'recovery_required'`,
      [attemptId, orderId],
    );
    if ((result as any).affectedRows !== 1) {
      const current = await this.findById(attemptId);
      if (current?.state === "processing") return current;
      throw new PetGenerationError("CONCURRENT_TRANSITION", "Recovery resume lost a race");
    }
    await this.getPool().query(
      "UPDATE pet_glb_orders SET state = ?, updated_at = NOW() WHERE id = ? AND current_stage_attempt_id = ?",
      [ORDER_STATE_FOR_PROCESSING[attempt.stage], orderId, attemptId],
    );
    return { ...attempt, state: "processing", failureCode: null };
  }

  async completeModelStage(input: {
    orderId: number;
    attemptId: number;
    stage: PetGlbModelStageKind;
    assetId: number;
    assetVersionId: number;
    artifactSha256: string;
    report: ValidationReport;
    reportSha256: string;
  }): Promise<PetGlbStageAttempt> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `UPDATE pet_glb_stage_attempts
            SET state = 'awaiting_customer_approval', asset_id = ?, asset_version_id = ?,
                artifact_sha256 = ?, validation_report_json = ?,
                validation_report_sha256 = ?, updated_at = NOW()
          WHERE id = ? AND order_id = ? AND stage = ? AND state = 'persisting'`,
        [
          input.assetId,
          input.assetVersionId,
          input.artifactSha256,
          JSON.stringify(input.report),
          input.reportSha256,
          input.attemptId,
          input.orderId,
          input.stage,
        ],
      );
      if ((result as any).affectedRows !== 1) {
        const [rows] = await conn.query(
          "SELECT artifact_sha256 FROM pet_glb_stage_attempts WHERE id = ? LIMIT 1 FOR UPDATE",
          [input.attemptId],
        );
        if ((rows as any[])[0]?.artifact_sha256 !== input.artifactSha256) {
          throw new PetGenerationError("CONCURRENT_TRANSITION", "Stage completion lost a race");
        }
      } else {
        const [orderResult] = await conn.query(
          `UPDATE pet_glb_orders SET asset_id = ?, state = ?, updated_at = NOW()
            WHERE id = ? AND current_stage_attempt_id = ?`,
          [input.assetId, ORDER_STATE_FOR_REVIEW[input.stage], input.orderId, input.attemptId],
        );
        if ((orderResult as any).affectedRows !== 1) {
          throw new PetGenerationError("STALE_STAGE", "Completed stage is no longer current");
        }
      }
      await this.upsertFurBinItem(conn, {
        orderId: input.orderId,
        assetId: input.assetId,
        assetVersionId: input.assetVersionId,
        stage: input.stage,
        artifactSha256: input.artifactSha256,
      });
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
    return (await this.findById(input.attemptId))!;
  }

  async markPersistedRecovery(input: {
    orderId: number;
    attemptId: number;
    providerJobId: string;
    assetId: number;
    assetVersionId: number;
    artifactSha256: string;
    report: ValidationReport;
    reportSha256: string;
  }): Promise<void> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();
      const [stageResult] = await conn.query(
        `UPDATE pet_glb_stage_attempts
            SET state = 'recovery_required', provider_job_id = COALESCE(provider_job_id, ?),
                asset_id = ?, asset_version_id = ?, artifact_sha256 = ?,
                validation_report_json = ?, validation_report_sha256 = ?,
                failure_code = 'PERSISTED_STAGE_FINALIZE_FAILED', updated_at = NOW()
          WHERE id = ? AND order_id = ? AND state IN ('persisting','recovery_required')`,
        [
          input.providerJobId,
          input.assetId,
          input.assetVersionId,
          input.artifactSha256,
          JSON.stringify(input.report),
          input.reportSha256,
          input.attemptId,
          input.orderId,
        ],
      );
      if ((stageResult as any).affectedRows !== 1) {
        throw new PetGenerationError("RECOVERY_RECORD_FAILED", "Could not preserve persisted stage evidence");
      }
      const [orderResult] = await conn.query(
        `UPDATE pet_glb_orders
            SET asset_id = ?, generation_job_id = ?, state = 'recovery_required', updated_at = NOW()
          WHERE id = ? AND current_stage_attempt_id = ?`,
        [input.assetId, input.providerJobId, input.orderId, input.attemptId],
      );
      if ((orderResult as any).affectedRows !== 1) {
        throw new PetGenerationError("STALE_STAGE", "Persisted stage is no longer current");
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async recoverPersistedModelStage(
    orderId: number,
    attemptId: number,
    expectedLeaseOwner?: string,
  ): Promise<PetGlbStageAttempt> {
    const attempt = await this.findById(attemptId);
    if (
      !attempt
      || attempt.orderId !== orderId
      || attempt.state !== "recovery_required"
      || attempt.stage === "reference"
      || attempt.stage === "rig_check"
      || !attempt.assetId
      || !attempt.assetVersionId
      || !attempt.artifactSha256
      || !attempt.validationReport
      || !attempt.validationReportSha256
    ) {
      throw new PetGenerationError("RECOVERY_NOT_RESUMABLE", "Persisted stage evidence is incomplete");
    }
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `UPDATE pet_glb_stage_attempts
            SET state = 'awaiting_customer_approval', failure_code = NULL, updated_at = NOW(3),
                recovery_lease_owner = NULL, recovery_lease_expires_at = NULL
          WHERE id = ? AND order_id = ? AND state = 'recovery_required'
            AND (? IS NULL OR (recovery_lease_owner = ? AND recovery_lease_expires_at > NOW(3)))`,
        [attemptId, orderId, expectedLeaseOwner ?? null, expectedLeaseOwner ?? null],
      );
      if ((result as any).affectedRows !== 1) {
        throw new PetGenerationError("CONCURRENT_TRANSITION", "Persisted recovery lost a race");
      }
      const [orderResult] = await conn.query(
        "UPDATE pet_glb_orders SET asset_id = ?, state = ?, updated_at = NOW() WHERE id = ? AND current_stage_attempt_id = ?",
        [attempt.assetId, ORDER_STATE_FOR_REVIEW[attempt.stage], orderId, attemptId],
      );
      if ((orderResult as any).affectedRows !== 1) {
        throw new PetGenerationError("STALE_STAGE", "Recovered stage is no longer current");
      }
      await this.upsertFurBinItem(conn, {
        orderId,
        assetId: attempt.assetId,
        assetVersionId: attempt.assetVersionId,
        stage: attempt.stage,
        artifactSha256: attempt.artifactSha256,
      });
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
    return { ...attempt, state: "awaiting_customer_approval", failureCode: null };
  }

  async completeRigCheck(
    orderId: number,
    attemptId: number,
    capability: RigCapability,
    capabilityHash: string,
  ): Promise<PetGlbStageAttempt> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `UPDATE pet_glb_stage_attempts
            SET state = 'awaiting_customer_approval', capability_report_json = ?,
                artifact_sha256 = ?, updated_at = NOW()
          WHERE id = ? AND order_id = ? AND stage = 'rig_check' AND state = 'persisting'`,
        [JSON.stringify(capability), capabilityHash, attemptId, orderId],
      );
      if ((result as any).affectedRows !== 1) {
        const [rows] = await conn.query(
          "SELECT artifact_sha256 FROM pet_glb_stage_attempts WHERE id = ? LIMIT 1 FOR UPDATE",
          [attemptId],
        );
        if ((rows as any[])[0]?.artifact_sha256 !== capabilityHash) {
          throw new PetGenerationError("CONCURRENT_TRANSITION", "Rig check completion lost a race");
        }
      } else {
        const [orderResult] = await conn.query(
          "UPDATE pet_glb_orders SET state = 'awaiting_rig_purchase', updated_at = NOW() WHERE id = ? AND current_stage_attempt_id = ?",
          [orderId, attemptId],
        );
        if ((orderResult as any).affectedRows !== 1) {
          throw new PetGenerationError("STALE_STAGE", "Rig check is no longer current");
        }
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
    return (await this.findById(attemptId))!;
  }

  /**
   * Advance a validated GLB stage after the customer has approved the reference
   * set. Generated model stages no longer pause for private customer review.
   * Each selected paid stage still uses a deterministic wallet ledger key.
   */
  async autoAdvanceCompletedStage(input: {
    orderId: number;
    ownerPhone: string;
    attemptId: number;
    nextStage: Exclude<PetGlbStageKind, "reference"> | null;
    nextInputHash: string | null;
    nextPriceCredits: number;
  }): Promise<{ current: PetGlbStageAttempt; next: PetGlbStageAttempt | null }> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();
      const order = await this.lockOrder(conn, input.orderId, input.ownerPhone);
      const current = await this.currentWithConnection(conn, input.orderId, true);
      if (!current || current.id !== input.attemptId) {
        throw new PetGenerationError("STALE_STAGE", "Completed stage is no longer current");
      }
      if (current.state !== "awaiting_customer_approval" || current.stage === "reference") {
        throw new PetGenerationError("STAGE_NOT_ADVANCEABLE", "Completed GLB stage is not ready to advance");
      }
      if (!current.artifactSha256) {
        throw new PetGenerationError("NO_FINAL_ASSET", "Completed GLB evidence is incomplete");
      }
      if (current.stage !== "rig_check" && (!current.assetId || !current.assetVersionId)) {
        throw new PetGenerationError("NO_FINAL_ASSET", "Completed GLB asset evidence is incomplete");
      }
      if (current.stage === "rig_check" && !current.capabilityReport?.riggable) {
        throw new PetGenerationError("RIG_NOT_SUPPORTED", "Provider pre-rig check did not confirm this model is riggable");
      }
      if (current.stage !== "rig_check" && current.validationReport && !current.validationReport.operatorReady) {
        throw new PetGenerationError("VALIDATION_BLOCKED", "Stage validation did not pass");
      }

      const approvalKey = `auto:${current.attemptUuid}`;
      const [approvedResult] = await conn.query(
        `UPDATE pet_glb_stage_attempts
            SET state = 'approved', approval_idempotency_key = ?, approval_hash = ?,
                approved_by = 'system:auto-delivery', approved_at = NOW(3), updated_at = NOW(3)
          WHERE id = ? AND state = 'awaiting_customer_approval'`,
        [approvalKey, current.artifactSha256, current.id],
      );
      if ((approvedResult as any).affectedRows !== 1) {
        throw new PetGenerationError("CONCURRENT_TRANSITION", "Automatic stage advance lost a race");
      }

      if (!input.nextStage) {
        if (!current.assetVersionId) {
          throw new PetGenerationError("NO_FINAL_ASSET", "A capability stage cannot be delivered");
        }
        const [deliveryResult] = await conn.query(
          `UPDATE pet_glb_orders
              SET state = 'delivered', approved_version_id = ?, final_customer_version_id = ?,
                  delivered_at = COALESCE(delivered_at, NOW(3)), updated_at = NOW(3)
            WHERE id = ? AND current_stage_attempt_id = ?`,
          [current.assetVersionId, current.assetVersionId, input.orderId, current.id],
        );
        if ((deliveryResult as any).affectedRows !== 1) {
          throw new PetGenerationError("STALE_STAGE", "Final GLB is no longer current");
        }
        await conn.query(
          `INSERT INTO pet_glb_order_events
             (order_id, from_state, to_state, actor_type, actor_id, reason)
           VALUES (?, ?, 'delivered', 'system', 'auto-delivery', ?)`,
          [input.orderId, order.state, `${current.stage}_validated_to_fur_bin`],
        );
        await conn.commit();
        return { current: { ...current, state: "approved", approvedAt: new Date() }, next: null };
      }

      if (!input.nextInputHash) {
        throw new PetGenerationError("NEXT_INPUT_HASH_REQUIRED", "Next stage input hash is missing");
      }
      const chargeKey = input.nextPriceCredits > 0
        ? `pet_glb:${order.order_uuid}:${input.nextStage}:auto:${current.attemptUuid}`
        : null;
      if (input.nextPriceCredits > 0) {
        await this.chargeWallet(
          conn,
          input.ownerPhone,
          input.nextPriceCredits,
          chargeKey!,
          `pet_glb_${input.nextStage}`,
        );
      }
      const next = await this.insertAttempt(conn, {
        orderId: input.orderId,
        stage: input.nextStage,
        state: "queued",
        inputHash: input.nextInputHash,
        sourceAttemptId: current.id,
        priceCredits: input.nextPriceCredits,
        creditsDisposition: input.nextPriceCredits > 0 ? "charged" : "none",
        chargeIdempotencyKey: chargeKey,
      });
      const toState = ORDER_STATE_FOR_QUEUE[input.nextStage];
      await conn.query(
        `UPDATE pet_glb_orders
            SET current_stage = ?, current_stage_attempt_id = ?, state = ?,
                credits_reserved = credits_reserved + ?, updated_at = NOW(3)
          WHERE id = ?`,
        [input.nextStage, next.id, toState, input.nextPriceCredits, input.orderId],
      );
      await conn.query(
        `INSERT INTO pet_glb_order_events
           (order_id, from_state, to_state, actor_type, actor_id, reason)
         VALUES (?, ?, ?, 'system', 'auto-pipeline', ?)`,
        [input.orderId, order.state, toState, `${current.stage}_validated_start_${input.nextStage}`],
      );
      await conn.commit();
      return { current: { ...current, state: "approved", approvedAt: new Date() }, next };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async rejectCurrent(
    orderId: number,
    ownerPhone: string,
    attemptUuid: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<PetGlbStageAttempt> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();
      const order = await this.lockOrder(conn, orderId, ownerPhone);
      const current = await this.currentWithConnection(conn, orderId, true);
      if (!current || current.attemptUuid !== attemptUuid) {
        throw new PetGenerationError("STALE_STAGE", "Only the current stage can be rejected");
      }
      if (current.state === "rejected") {
        await conn.commit();
        return current;
      }
      if (current.state !== "awaiting_customer_approval") {
        throw new PetGenerationError("STAGE_NOT_REJECTABLE", "Stage is not awaiting a decision");
      }
      await conn.query(
        `UPDATE pet_glb_stage_attempts
            SET state = 'rejected', rejection_reason = ?,
                approval_idempotency_key = ?, updated_at = NOW()
          WHERE id = ? AND state = 'awaiting_customer_approval'`,
        [reason, idempotencyKey, current.id],
      );
      await conn.query(
        "UPDATE pet_glb_orders SET state = 'stage_rejected', updated_at = NOW() WHERE id = ?",
        [orderId],
      );
      await this.writeEvent(conn, orderId, order.state, "stage_rejected", ownerPhone, reason);
      await conn.commit();
      return { ...current, state: "rejected", rejectionReason: reason };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async queueRetry(input: {
    orderId: number;
    ownerPhone: string;
    attemptUuid: string;
    idempotencyKey: string;
    inputHash: string;
    priceCredits: number;
  }): Promise<PetGlbStageAttempt> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();
      const retryKey = `pet_glb:retry:${input.attemptUuid}:${input.idempotencyKey}`;
      const [duplicateRows] = await conn.query(
        "SELECT * FROM pet_glb_stage_attempts WHERE charge_idempotency_key = ? LIMIT 1 FOR UPDATE",
        [retryKey],
      );
      if ((duplicateRows as any[]).length) {
        await conn.commit();
        return mapAttempt((duplicateRows as any[])[0]);
      }
      const order = await this.lockOrder(conn, input.orderId, input.ownerPhone);
      const current = await this.currentWithConnection(conn, input.orderId, true);
      if (!current || current.attemptUuid !== input.attemptUuid || current.state !== "rejected") {
        throw new PetGenerationError("STAGE_NOT_RETRYABLE", "Only the current rejected stage can be retried");
      }
      if (current.stage === "reference") {
        throw new PetGenerationError("REFERENCES_REQUIRED", "Update and resubmit the reference images");
      }

      if (input.priceCredits > 0) {
        await this.chargeWallet(
          conn,
          input.ownerPhone,
          input.priceCredits,
          retryKey,
          `pet_glb_${current.stage}_retry`,
        );
      }
      const retry = await this.insertAttempt(conn, {
        orderId: input.orderId,
        stage: current.stage,
        state: "queued",
        inputHash: input.inputHash,
        sourceAttemptId: current.sourceAttemptId,
        priceCredits: input.priceCredits,
        creditsDisposition: input.priceCredits > 0 ? "charged" : "none",
        chargeIdempotencyKey: retryKey,
      });
      const nextState = ORDER_STATE_FOR_QUEUE[current.stage];
      await conn.query(
        `UPDATE pet_glb_orders
            SET current_stage_attempt_id = ?, state = ?,
                credits_reserved = credits_reserved + ?, updated_at = NOW()
          WHERE id = ?`,
        [retry.id, nextState, input.priceCredits, input.orderId],
      );
      await this.writeEvent(
        conn,
        input.orderId,
        order.state,
        nextState,
        input.ownerPhone,
        `${current.stage}_retry_${retry.attemptNumber}`,
      );
      await conn.commit();
      return retry;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async failAndRefund(
    orderId: number,
    attemptId: number,
    ownerPhone: string,
    failureCode: string,
    options: {
      expectedLeaseOwner?: string;
      recoveryReasonCode?: string;
      recoveryEvidence?: Record<string, unknown>;
    } = {},
  ): Promise<{ refundApplied: boolean; refundCorrelationId: string | null }> {
    const conn = await this.getPool().getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(
        "SELECT * FROM pet_glb_stage_attempts WHERE id = ? AND order_id = ? FOR UPDATE",
        [attemptId, orderId],
      );
      const row = (rows as any[])[0];
      if (!row) throw new PetGenerationError("STAGE_NOT_FOUND", "Stage attempt not found");
      const attempt = mapAttempt(row);
      const [orderRows] = await conn.query(
        "SELECT owner_phone, current_stage_attempt_id FROM pet_glb_orders WHERE id = ? LIMIT 1 FOR UPDATE",
        [orderId],
      );
      const order = (orderRows as any[])[0];
      if (!order || String(order.owner_phone) !== ownerPhone) {
        throw new PetGenerationError("FORBIDDEN", "Refund owner does not match the order");
      }
      if (Number(order.current_stage_attempt_id) !== attemptId) {
        throw new PetGenerationError(
          "CONCURRENT_TRANSITION",
          "Stage is no longer the order's current attempt",
        );
      }
      // A repeated terminal call is an idempotent no-op. Check this before the
      // recovery lease because the first successful terminal transition clears
      // that lease atomically with the refund.
      if (attempt.state === "failed") {
        await conn.commit();
        return { refundApplied: false, refundCorrelationId: null };
      }
      if (
        options.expectedLeaseOwner
        && (
          attempt.recoveryLeaseOwner !== options.expectedLeaseOwner
          || !attempt.recoveryLeaseExpiresAt
          || attempt.recoveryLeaseExpiresAt.getTime() <= Date.now()
        )
      ) {
        throw new PetGenerationError("RECOVERY_LEASE_LOST", "Recovery refund lost its lease");
      }
      let refundApplied = false;
      let refundCorrelationId: string | null = null;
      if (attempt.creditsDisposition === "charged" && attempt.priceCredits > 0) {
        const chargeCorrelation = row.charge_idempotency_key ? String(row.charge_idempotency_key) : "";
        if (!chargeCorrelation) {
          throw new PetGenerationError("REFUND_EVIDENCE_MISSING", "Charged stage has no immutable debit correlation");
        }
        const refund = await refundWalletDebitInTransaction(conn, chargeCorrelation, {
          ownerId: ownerPhone,
          amount: attempt.priceCredits,
        });
        refundApplied = refund.applied;
        refundCorrelationId = `wallet-debit-refund:${crypto.createHash("sha256").update(chargeCorrelation).digest("hex")}`;
        await conn.query(
          "UPDATE pet_glb_stage_attempts SET credits_disposition = 'refunded' WHERE id = ?",
          [attempt.id],
        );
      }
      await conn.query(
        `UPDATE pet_glb_stage_attempts
            SET state = 'failed', failure_code = ?, updated_at = NOW(3),
                recovery_lease_owner = NULL, recovery_lease_expires_at = NULL
          WHERE id = ?`,
        [failureCode, attempt.id],
      );
      await conn.query(
        "UPDATE pet_glb_orders SET state = 'stage_failed', updated_at = NOW(3) WHERE id = ? AND current_stage_attempt_id = ?",
        [orderId, attemptId],
      );
      if (options.recoveryReasonCode) {
        await conn.query(
          `INSERT INTO pet_glb_recovery_evidence
             (stage_attempt_id, order_id, decision, reason_code, provider_handle_present, refund_correlation_id, redacted_evidence_json)
           VALUES (?, ?, 'terminal_refund', ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE refund_correlation_id = VALUES(refund_correlation_id), redacted_evidence_json = VALUES(redacted_evidence_json)`,
          [
            attemptId,
            orderId,
            options.recoveryReasonCode,
            attempt.providerJobId ? 1 : 0,
            refundCorrelationId,
            JSON.stringify(options.recoveryEvidence || { stage: attempt.stage, priorState: attempt.state }),
          ],
        );
      }
      await conn.commit();
      return { refundApplied, refundCorrelationId };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  private assertExactApproval(current: PetGlbStageAttempt, approval: ExactStageApproval): void {
    if (
      current.attemptUuid !== approval.attemptUuid
      || current.artifactSha256 !== approval.artifactSha256
      || current.assetVersionId !== approval.assetVersionId
      || current.validationReportSha256 !== approval.reportSha256
    ) {
      throw new PetGenerationError("STALE_STAGE", "Approval does not match the current immutable stage evidence");
    }
    if (current.validationReport && !current.validationReport.operatorReady) {
      throw new PetGenerationError("VALIDATION_BLOCKED", "Stage validation did not pass");
    }
    if (current.stage === "rig_check" && !current.capabilityReport?.riggable) {
      throw new PetGenerationError("RIG_NOT_SUPPORTED", "Provider pre-rig check did not confirm this model is riggable");
    }
  }

  private async chargeWallet(
    conn: mysql.PoolConnection,
    ownerPhone: string,
    amount: number,
    ledgerKey: string,
    reason: string,
  ): Promise<void> {
    const [existing] = await conn.query(
      "SELECT user_phone, delta FROM credit_transactions WHERE idempotency_key = ? LIMIT 1 FOR UPDATE",
      [ledgerKey],
    );
    if ((existing as any[]).length) {
      const row = (existing as any[])[0];
      if (row.user_phone !== ownerPhone || Number(row.delta) !== -amount) {
        throw new PetGenerationError("IDEMPOTENCY_CONFLICT", "Ledger key has different charge data");
      }
      return;
    }
    const [userRows] = await conn.query(
      "SELECT credits FROM users WHERE phone = ? LIMIT 1 FOR UPDATE",
      [ownerPhone],
    );
    const user = (userRows as any[])[0];
    if (!user) throw new PetGenerationError("USER_NOT_FOUND", "User wallet not found");
    const balance = Number(user.credits || 0);
    if (balance < amount) {
      throw new PetGenerationError("INSUFFICIENT_CREDITS", `Requires ${amount} PupCoins; balance ${balance}`);
    }
    const next = balance - amount;
    await conn.query("UPDATE users SET credits = ? WHERE phone = ?", [next, ownerPhone]);
    await conn.query(
      `INSERT INTO credit_transactions
         (user_phone, delta, reason, balance_after, idempotency_key)
       VALUES (?, ?, ?, ?, ?)`,
      [ownerPhone, -amount, reason, next, ledgerKey],
    );
  }

  private async insertAttempt(
    conn: mysql.PoolConnection,
    input: {
      orderId: number;
      stage: PetGlbStageKind;
      state: StageAttemptState;
      inputHash: string;
      sourceAttemptId: number | null;
      priceCredits: number;
      creditsDisposition: "none" | "charged" | "refunded";
      artifactSha256?: string | null;
      chargeIdempotencyKey?: string | null;
    },
  ): Promise<PetGlbStageAttempt> {
    const [numberRows] = await conn.query(
      "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM pet_glb_stage_attempts WHERE order_id = ? AND stage = ?",
      [input.orderId, input.stage],
    );
    const attemptNumber = Number((numberRows as any[])[0].next);
    const attemptUuid = crypto.randomUUID();
    const [insert] = await conn.query(
      `INSERT INTO pet_glb_stage_attempts
         (attempt_uuid, order_id, stage, attempt_number, state, input_hash,
          source_attempt_id, artifact_sha256, price_credits, credits_disposition,
          charge_idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        attemptUuid,
        input.orderId,
        input.stage,
        attemptNumber,
        input.state,
        input.inputHash,
        input.sourceAttemptId,
        input.artifactSha256 ?? null,
        input.priceCredits,
        input.creditsDisposition,
        input.chargeIdempotencyKey ?? null,
      ],
    );
    return {
      id: Number((insert as any).insertId),
      attemptUuid,
      orderId: input.orderId,
      stage: input.stage,
      attemptNumber,
      state: input.state,
      inputHash: input.inputHash,
      sourceAttemptId: input.sourceAttemptId,
      providerJobId: null,
      assetId: null,
      assetVersionId: null,
      artifactSha256: input.artifactSha256 ?? null,
      validationReport: null,
      validationReportSha256: null,
      capabilityReport: null,
      priceCredits: input.priceCredits,
      creditsDisposition: input.creditsDisposition,
      approvedAt: null,
      rejectionReason: null,
      failureCode: null,
      recoveryLeaseOwner: null,
      recoveryLeaseExpiresAt: null,
      recoveryAttempts: 0,
      lastRecoveryAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Register or advance the owner's private Fur Bin item inside the same
   * transaction that finalizes a persisted GLB stage. A later request, email,
   * or release-review action is not required for assignment.
   */
  private async upsertFurBinItem(
    conn: mysql.PoolConnection,
    input: {
      orderId: number;
      assetId: number;
      assetVersionId: number;
      stage: PetGlbModelStageKind;
      artifactSha256: string;
    },
  ): Promise<void> {
    const [orderRows] = await conn.query(
      "SELECT order_uuid, owner_phone FROM pet_glb_orders WHERE id = ? LIMIT 1 FOR UPDATE",
      [input.orderId],
    );
    const order = (orderRows as any[])[0];
    if (!order) {
      throw new PetGenerationError("ORDER_NOT_FOUND", "Order not found while assigning Fur Bin item");
    }
    const [existingRows] = await conn.query(
      "SELECT id, current_version_id, status FROM fur_bin_items WHERE owner_id = ? AND asset_id = ? LIMIT 1 FOR UPDATE",
      [order.owner_phone, input.assetId],
    );
    const existing = (existingRows as any[])[0];
    const title = `3D pet model ${String(order.order_uuid).slice(0, 8)}`;
    await conn.query(
      `INSERT INTO fur_bin_items
         (item_uuid, owner_id, asset_id, current_version_id, title, description,
          tags_json, has_rig, has_animations, storage_bytes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(SUM(size_bytes), 0) FROM asset_versions WHERE asset_id = ?), 'active')
       ON DUPLICATE KEY UPDATE
         current_version_id = VALUES(current_version_id),
         title = VALUES(title), description = VALUES(description), tags_json = VALUES(tags_json),
         has_rig = GREATEST(has_rig, VALUES(has_rig)),
         has_animations = GREATEST(has_animations, VALUES(has_animations)),
         storage_bytes = VALUES(storage_bytes), status = 'active', updated_at = NOW(3)`,
      [
        crypto.randomUUID(),
        order.owner_phone,
        input.assetId,
        input.assetVersionId,
        title,
        "Your generated model, textures, rig, and saved versions are tracked automatically in Fur Bin.",
        JSON.stringify(["pet-glb", input.stage, "generated"]),
        input.stage === "rig" ? 1 : 0,
        input.stage === "rig" ? 1 : 0,
        input.assetId,
      ],
    );
    if (!existing || Number(existing.current_version_id) !== input.assetVersionId || existing.status !== "active") {
      const [itemRows] = await conn.query(
        "SELECT id FROM fur_bin_items WHERE owner_id = ? AND asset_id = ? LIMIT 1",
        [order.owner_phone, input.assetId],
      );
      const itemId = Number((itemRows as any[])[0]?.id || 0);
      if (!itemId) {
        throw new PetGenerationError("FUR_BIN_ASSIGNMENT_FAILED", "Fur Bin item was not persisted");
      }
      const eventType = existing ? "current_changed" : "registered";
      const evidenceHash = crypto.createHash("sha256")
        .update(`${order.order_uuid}:${input.stage}:${input.assetVersionId}:${input.artifactSha256}`)
        .digest("hex");
      await conn.query(
        `INSERT INTO fur_bin_version_events
           (event_uuid, item_id, actor_id, event_type, from_version_id, to_version_id, evidence_hash)
         VALUES (?, ?, 'system:auto-delivery', ?, ?, ?, ?)`,
        [crypto.randomUUID(), itemId, eventType, existing?.current_version_id || null, input.assetVersionId, evidenceHash],
      );
    }
  }

  private async currentWithConnection(
    conn: mysql.PoolConnection,
    orderId: number,
    forUpdate = false,
  ): Promise<PetGlbStageAttempt | null> {
    const [rows] = await conn.query(
      `SELECT s.*
         FROM pet_glb_orders o
         JOIN pet_glb_stage_attempts s ON s.id = o.current_stage_attempt_id
        WHERE o.id = ?
        LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [orderId],
    );
    const row = (rows as any[])[0];
    return row ? mapAttempt(row) : null;
  }

  private async lockOrder(
    conn: mysql.PoolConnection,
    orderId: number,
    ownerPhone: string,
  ): Promise<any> {
    const [rows] = await conn.query(
      "SELECT * FROM pet_glb_orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    const order = (rows as any[])[0];
    if (!order) throw new PetGenerationError("ORDER_NOT_FOUND", "Order not found");
    if (order.owner_phone !== ownerPhone) throw new PetGenerationError("FORBIDDEN", "Not your order");
    return order;
  }

  private async writeEvent(
    conn: mysql.PoolConnection,
    orderId: number,
    from: string,
    to: string,
    actorId: string,
    reason: string,
  ): Promise<void> {
    await conn.query(
      `INSERT INTO pet_glb_order_events
         (order_id, from_state, to_state, actor_type, actor_id, reason)
       VALUES (?, ?, ?, 'customer', ?, ?)`,
      [orderId, from, to, actorId, reason.slice(0, 190)],
    );
  }
}
