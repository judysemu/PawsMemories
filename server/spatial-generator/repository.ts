import type mysql from "mysql2/promise";
import crypto from "node:crypto";
import {
  SpatialJobRecord,
  SpatialInputRecord,
  SpatialAttemptRecord,
  SpatialArtifactRecord,
  SpatialReviewRecord,
  SpatialEventRecord,
  SpatialJobState,
  SpatialAttemptState,
  SpatialArtifactRole,
} from "./types";

export class SpatialGeneratorRepository {
  constructor(private readonly pool: mysql.Pool) {}

  // ─── Job Operations ────────────────────────────────────────────────────────

  async createJob(
    conn: mysql.PoolConnection,
    params: {
      jobUuid: string;
      ownerPhone: string;
      subjectKind: "accessory" | "hard_surface";
      targetUse: "digital" | "attachment" | "print";
      idempotencyKey: string;
      creditsReserved: number;
    },
  ): Promise<number> {
    const [result] = await conn.query(
      `INSERT INTO spatial_generation_jobs
        (job_uuid, owner_phone, subject_kind, target_use, state, credits_reserved, credits_disposition, idempotency_key)
       VALUES (?, ?, ?, ?, 'draft', ?, 'reserved', ?)`,
      [
        params.jobUuid,
        params.ownerPhone,
        params.subjectKind,
        params.targetUse,
        params.creditsReserved,
        params.idempotencyKey,
      ],
    );
    return (result as any).insertId;
  }

  async createJobInputs(
    conn: mysql.PoolConnection,
    params: {
      jobId: number;
      prompt: string;
      targetEnvelopeMm: Record<string, unknown>;
      scaleAnchor: Record<string, unknown> | null;
      attachmentInterface: Record<string, unknown> | null;
      referenceAssetVersionIds: number[];
      inputHash: string;
    },
  ): Promise<void> {
    await conn.query(
      `INSERT INTO spatial_generation_inputs
        (job_id, prompt, target_envelope_mm, scale_anchor, attachment_interface, reference_asset_version_ids, input_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        params.jobId,
        params.prompt,
        JSON.stringify(params.targetEnvelopeMm),
        params.scaleAnchor ? JSON.stringify(params.scaleAnchor) : null,
        params.attachmentInterface ? JSON.stringify(params.attachmentInterface) : null,
        JSON.stringify(params.referenceAssetVersionIds),
        params.inputHash,
      ],
    );
  }

  async getJobByUuid(conn: mysql.PoolConnection, jobUuid: string): Promise<SpatialJobRecord | null> {
    const [rows] = await conn.query(
      "SELECT * FROM spatial_generation_jobs WHERE job_uuid = ?",
      [jobUuid],
    );
    return (rows as any[])[0] || null;
  }

  async getJobById(conn: mysql.PoolConnection, jobId: number): Promise<SpatialJobRecord | null> {
    const [rows] = await conn.query(
      "SELECT * FROM spatial_generation_jobs WHERE id = ?",
      [jobId],
    );
    return (rows as any[])[0] || null;
  }

  async getJobByOwnerAndIdempotency(
    conn: mysql.PoolConnection,
    ownerPhone: string,
    idempotencyKey: string,
  ): Promise<SpatialJobRecord | null> {
    const [rows] = await conn.query(
      "SELECT * FROM spatial_generation_jobs WHERE owner_phone = ? AND idempotency_key = ?",
      [ownerPhone, idempotencyKey],
    );
    return (rows as any[])[0] || null;
  }

  async listJobsByOwner(
    conn: mysql.PoolConnection,
    ownerPhone: string,
    limit = 50,
    offset = 0,
  ): Promise<SpatialJobRecord[]> {
    const [rows] = await conn.query(
      "SELECT * FROM spatial_generation_jobs WHERE owner_phone = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
      [ownerPhone, limit, offset],
    );
    return rows as any[];
  }

  async updateJobState(
    conn: mysql.PoolConnection,
    jobId: number,
    state: SpatialJobState,
    extra?: { currentAttemptId?: number; failureCode?: string; failureDetail?: string; creditsDisposition?: string },
  ): Promise<void> {
    const sets = ["state = ?", "updated_at = NOW()"];
    const params: any[] = [state];

    if (extra?.currentAttemptId !== undefined) {
      sets.push("current_attempt_id = ?");
      params.push(extra.currentAttemptId);
    }
    if (extra?.failureCode) {
      sets.push("failure_code = ?");
      params.push(extra.failureCode);
    }
    if (extra?.failureDetail) {
      sets.push("failure_detail = ?");
      params.push(extra.failureDetail);
    }
    if (extra?.creditsDisposition) {
      sets.push("credits_disposition = ?");
      params.push(extra.creditsDisposition);
    }

    params.push(jobId);
    await conn.query(`UPDATE spatial_generation_jobs SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  async chargeCredits(conn: mysql.PoolConnection, jobId: number): Promise<void> {
    await conn.query(
      "UPDATE spatial_generation_jobs SET credits_disposition = 'charged' WHERE id = ? AND credits_disposition = 'reserved'",
      [jobId],
    );
  }

  async refundCredits(conn: mysql.PoolConnection, jobId: number): Promise<void> {
    await conn.query(
      "UPDATE spatial_generation_jobs SET credits_disposition = 'refunded' WHERE id = ? AND credits_disposition IN ('reserved', 'charged')",
      [jobId],
    );
  }

  // ─── Attempt Operations ────────────────────────────────────────────────────

  async createAttempt(
    conn: mysql.PoolConnection,
    params: {
      jobId: number;
      attemptNumber: number;
      idempotencyKey: string;
    },
  ): Promise<number> {
    const [result] = await conn.query(
      `INSERT INTO spatial_generation_attempts
        (job_id, attempt_number, idempotency_key, state)
       VALUES (?, ?, ?, 'queued')`,
      [params.jobId, params.attemptNumber, params.idempotencyKey],
    );
    return (result as any).insertId;
  }

  async getAttempt(conn: mysql.PoolConnection, attemptId: number): Promise<SpatialAttemptRecord | null> {
    const [rows] = await conn.query(
      "SELECT * FROM spatial_generation_attempts WHERE id = ?",
      [attemptId],
    );
    return (rows as any[])[0] || null;
  }

  async getAttemptByJobAndNumber(
    conn: mysql.PoolConnection,
    jobId: number,
    attemptNumber: number,
  ): Promise<SpatialAttemptRecord | null> {
    const [rows] = await conn.query(
      "SELECT * FROM spatial_generation_attempts WHERE job_id = ? AND attempt_number = ?",
      [jobId, attemptNumber],
    );
    return (rows as any[])[0] || null;
  }

  async getCurrentAttempt(conn: mysql.PoolConnection, jobId: number): Promise<SpatialAttemptRecord | null> {
    const [rows] = await conn.query(
      "SELECT a.* FROM spatial_generation_attempts a JOIN spatial_generation_jobs j ON j.current_attempt_id = a.id WHERE j.id = ?",
      [jobId],
    );
    return (rows as any[])[0] || null;
  }

  async listAttemptsByJob(conn: mysql.PoolConnection, jobId: number): Promise<SpatialAttemptRecord[]> {
    const [rows] = await conn.query(
      "SELECT * FROM spatial_generation_attempts WHERE job_id = ? ORDER BY attempt_number ASC",
      [jobId],
    );
    return rows as any[];
  }

  async updateAttemptState(
    conn: mysql.PoolConnection,
    attemptId: number,
    state: SpatialAttemptState,
    extra?: {
      observationJson?: Record<string, unknown>;
      observationHash?: string;
      planJson?: Record<string, unknown>;
      planHash?: string;
      mathJson?: Record<string, unknown>;
      mathHash?: string;
      compiledProgramHash?: string;
      automatedReportJson?: Record<string, unknown>;
      automatedReportHash?: string;
      leaseOwner?: string;
      leaseExpiresAt?: Date;
      startedAt?: Date;
      completedAt?: Date;
      failureCode?: string;
      errorMessage?: string;
    },
  ): Promise<void> {
    const sets = ["state = ?"];
    const params: any[] = [state];

    if (extra?.observationJson) {
      sets.push("observation_json = ?");
      params.push(JSON.stringify(extra.observationJson));
    }
    if (extra?.observationHash) {
      sets.push("observation_hash = ?");
      params.push(extra.observationHash);
    }
    if (extra?.planJson) {
      sets.push("plan_json = ?");
      params.push(JSON.stringify(extra.planJson));
    }
    if (extra?.planHash) {
      sets.push("plan_hash = ?");
      params.push(extra.planHash);
    }
    if (extra?.mathJson) {
      sets.push("math_json = ?");
      params.push(JSON.stringify(extra.mathJson));
    }
    if (extra?.mathHash) {
      sets.push("math_hash = ?");
      params.push(extra.mathHash);
    }
    if (extra?.compiledProgramHash) {
      sets.push("compiled_program_hash = ?");
      params.push(extra.compiledProgramHash);
    }
    if (extra?.automatedReportJson) {
      sets.push("automated_report_json = ?");
      params.push(JSON.stringify(extra.automatedReportJson));
    }
    if (extra?.automatedReportHash) {
      sets.push("automated_report_hash = ?");
      params.push(extra.automatedReportHash);
    }
    if (extra?.leaseOwner) {
      sets.push("lease_owner = ?");
      params.push(extra.leaseOwner);
    }
    if (extra?.leaseExpiresAt) {
      sets.push("lease_expires_at = ?");
      params.push(extra.leaseExpiresAt);
    }
    if (extra?.startedAt) {
      sets.push("started_at = ?");
      params.push(extra.startedAt);
    }
    if (extra?.completedAt) {
      sets.push("completed_at = ?");
      params.push(extra.completedAt);
    }
    if (extra?.failureCode) {
      sets.push("failure_code = ?");
      params.push(extra.failureCode);
    }
    if (extra?.errorMessage) {
      sets.push("error_message = ?");
      params.push(extra.errorMessage);
    }

    params.push(attemptId);
    await conn.query(`UPDATE spatial_generation_attempts SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  async updateAttemptHeartbeat(
    conn: mysql.PoolConnection,
    attemptId: number,
    leaseOwner: string,
    leaseExpiresAt: Date,
  ): Promise<void> {
    await conn.query(
      `UPDATE spatial_generation_attempts
       SET last_heartbeat_at = NOW(), lease_owner = ?, lease_expires_at = ?
       WHERE id = ? AND lease_owner = ?`,
      [leaseOwner, leaseExpiresAt, attemptId, leaseOwner],
    );
  }

  async releaseLease(conn: mysql.PoolConnection, attemptId: number, leaseOwner: string): Promise<void> {
    await conn.query(
      `UPDATE spatial_generation_attempts
       SET lease_owner = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL
       WHERE id = ? AND lease_owner = ?`,
      [attemptId, leaseOwner],
    );
  }

  // ─── Artifact Operations ───────────────────────────────────────────────────

  async createArtifact(
    conn: mysql.PoolConnection,
    params: {
      attemptId: number;
      assetId: number;
      assetVersionId: number;
      role: SpatialArtifactRole;
      computedHash: string;
      sizeBytes: number;
      mimeType: string;
    },
  ): Promise<number> {
    const [result] = await conn.query(
      `INSERT INTO spatial_generation_artifacts
        (attempt_id, asset_id, asset_version_id, role, computed_hash, size_bytes, mime_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        params.attemptId,
        params.assetId,
        params.assetVersionId,
        params.role,
        params.computedHash,
        params.sizeBytes,
        params.mimeType,
      ],
    );
    return (result as any).insertId;
  }

  async getArtifactsByAttempt(conn: mysql.PoolConnection, attemptId: number): Promise<SpatialArtifactRecord[]> {
    const [rows] = await conn.query(
      "SELECT * FROM spatial_generation_artifacts WHERE attempt_id = ?",
      [attemptId],
    );
    return rows as any[];
  }

  async getArtifactByRole(
    conn: mysql.PoolConnection,
    attemptId: number,
    role: SpatialArtifactRole,
  ): Promise<SpatialArtifactRecord | null> {
    const [rows] = await conn.query(
      "SELECT * FROM spatial_generation_artifacts WHERE attempt_id = ? AND role = ?",
      [attemptId, role],
    );
    return (rows as any[])[0] || null;
  }

  // ─── Review Operations ─────────────────────────────────────────────────────

  async createReview(
    conn: mysql.PoolConnection,
    params: {
      jobId: number;
      attemptId: number;
      attemptHash: string;
      reportHash: string;
      ownerPhone: string;
      decision: "approve" | "request_correction";
      correctionTags: string[];
      comment: string | null;
      actorAuditHash: string;
    },
  ): Promise<number> {
    const [result] = await conn.query(
      `INSERT INTO spatial_generation_reviews
        (job_id, attempt_id, attempt_hash, report_hash, owner_phone, decision, correction_tags, comment, actor_audit_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.jobId,
        params.attemptId,
        params.attemptHash,
        params.reportHash,
        params.ownerPhone,
        params.decision,
        JSON.stringify(params.correctionTags),
        params.comment,
        params.actorAuditHash,
      ],
    );
    return (result as any).insertId;
  }

  async getReviewsByJob(conn: mysql.PoolConnection, jobId: number): Promise<SpatialReviewRecord[]> {
    const [rows] = await conn.query(
      "SELECT * FROM spatial_generation_reviews WHERE job_id = ? ORDER BY created_at ASC",
      [jobId],
    );
    return rows as any[];
  }

  async getLatestReview(conn: mysql.PoolConnection, jobId: number): Promise<SpatialReviewRecord | null> {
    const [rows] = await conn.query(
      "SELECT * FROM spatial_generation_reviews WHERE job_id = ? ORDER BY created_at DESC LIMIT 1",
      [jobId],
    );
    return (rows as any[])[0] || null;
  }

  // ─── Event / Audit Operations ──────────────────────────────────────────────

  async logEvent(
    conn: mysql.PoolConnection,
    params: {
      jobId: number;
      attemptId: number | null;
      eventType: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    const eventUuid = crypto.randomUUID();
    const payloadJson = JSON.stringify(params.payload);
    const payloadHash = crypto.createHash("sha256").update(payloadJson).digest("hex");

    await conn.query(
      `INSERT INTO spatial_generation_events
        (event_uuid, job_id, attempt_id, event_type, payload_json, payload_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [eventUuid, params.jobId, params.attemptId, params.eventType, payloadJson, payloadHash],
    );
  }

  async getEventsByJob(
    conn: mysql.PoolConnection,
    jobId: number,
    limit = 100,
  ): Promise<SpatialEventRecord[]> {
    const [rows] = await conn.query(
      "SELECT * FROM spatial_generation_events WHERE job_id = ? ORDER BY created_at DESC LIMIT ?",
      [jobId, limit],
    );
    return rows as any[];
  }

  async getJobInputs(
    conn: mysql.PoolConnection,
    jobId: number,
  ): Promise<{
    prompt: string;
    target_envelope_mm: { x: number; y: number; z: number };
    scale_anchor: { axis: "x" | "y" | "z"; millimeters: number; label: string } | null;
    attachment_interface: { targetAssetVersionId: number; clearanceMm: number } | null;
    reference_asset_version_ids: number[];
  } | null> {
    const [rows] = await conn.query(
      "SELECT prompt, target_envelope_mm, scale_anchor, attachment_interface, reference_asset_version_ids FROM spatial_generation_inputs WHERE job_id = ?",
      [jobId],
    );
    const row = (rows as any[])[0];
    if (!row) return null;
    return {
      prompt: row.prompt,
      target_envelope_mm: JSON.parse(row.target_envelope_mm),
      scale_anchor: row.scale_anchor ? JSON.parse(row.scale_anchor) : null,
      attachment_interface: row.attachment_interface ? JSON.parse(row.attachment_interface) : null,
      reference_asset_version_ids: JSON.parse(row.reference_asset_version_ids || "[]"),
    };
  }

  // ─── Recovery / Reconciliation ─────────────────────────────────────────────

  async findStaleLeases(
    conn: mysql.PoolConnection,
    maxAgeMs = 60_000,
  ): Promise<SpatialAttemptRecord[]> {
    const [rows] = await conn.query(
      `SELECT a.* FROM spatial_generation_attempts a
       JOIN spatial_generation_jobs j ON j.id = a.job_id
       WHERE a.lease_owner IS NOT NULL
         AND a.lease_expires_at < NOW()
         AND a.state IN ('observing', 'planning', 'awaiting_math', 'validating_math', 'compiling', 'building_draft', 'verifying_draft')
         AND j.state NOT IN ('completed', 'failed', 'cancelled')`,
    );
    return rows as any[];
  }

  async findJobsStuckInState(
    conn: mysql.PoolConnection,
    state: SpatialJobState,
    maxAgeMs: number,
  ): Promise<SpatialJobRecord[]> {
    const [rows] = await conn.query(
      `SELECT * FROM spatial_generation_jobs
       WHERE state = ? AND updated_at < DATE_SUB(NOW(), INTERVAL ? MILLISECOND)`,
      [state, maxAgeMs],
    );
    return rows as any[];
  }

  /**
   * Return the oldest current attempt that can be advanced by the direct
   * Layer8 → deterministic math → Blender scheduler.  Selecting only the
   * job's current attempt prevents a late retry or cancelled attempt from
   * being executed after ownership has moved on.
   */
  async findRunnableAttempts(
    conn: mysql.PoolConnection,
    limit = 1,
  ): Promise<Array<{ id: number; job_id: number; state: SpatialAttemptState }>> {
    const [rows] = await conn.query(
      `SELECT a.id, a.job_id, a.state
       FROM spatial_generation_attempts a
       JOIN spatial_generation_jobs j ON j.current_attempt_id = a.id
       WHERE j.state NOT IN ('completed', 'failed', 'cancelled')
         AND a.state IN ('queued', 'awaiting_math', 'compiling', 'building_draft', 'verifying_draft', 'finalizing')
         AND (a.lease_owner IS NULL OR a.lease_expires_at < NOW())
       ORDER BY a.created_at ASC
       LIMIT ?`,
      [Math.max(1, Math.min(10, Math.floor(limit)))],
    );
    return rows as any;
  }
}
