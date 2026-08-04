import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import type {
  BuildJobRecord,
  BuildAttemptRecord,
  ProviderEventRecord,
  BuildArtifactRecord,
  PostBuildReportRecord,
  BuildAcceptanceRecord,
  BuildJobState,
  BuildAttemptState,
  ArtifactRole,
  PostBuildReportStatus,
  ProviderEventType,
} from "./types";

// ─── Job CRUD ───────────────────────────────────────────────────────────────

export async function insertJob(
  conn: mysql.PoolConnection,
  data: {
    jobUuid: string;
    ownerId: string;
    referenceSessionId: number;
    referenceAttemptId: number;
    manifestAssetId: number;
    manifestAssetVersionId: number;
    manifestHash: string;
    requestedOutput: string;
    pricingKey: string;
    quotedCredits: number;
    state: BuildJobState;
  },
): Promise<BuildJobRecord> {
  const [result] = await conn.query(
    `INSERT INTO model_build_jobs
      (job_uuid, owner_id, reference_session_id, reference_attempt_id,
       manifest_asset_id, manifest_asset_version_id, manifest_hash,
       requested_output, pricing_key, quoted_credits, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.jobUuid, data.ownerId, data.referenceSessionId, data.referenceAttemptId,
      data.manifestAssetId, data.manifestAssetVersionId, data.manifestHash,
      data.requestedOutput, data.pricingKey, data.quotedCredits, data.state,
    ],
  ) as any;
  return findJobById(conn, result.insertId) as Promise<BuildJobRecord>;
}

export async function findJobById(
  conn: mysql.PoolConnection | mysql.Pool,
  id: number,
): Promise<BuildJobRecord | null> {
  const [rows] = await conn.query(
    "SELECT * FROM model_build_jobs WHERE id = ?", [id],
  ) as any;
  return rows[0] || null;
}

export async function findJobByUuid(
  conn: mysql.PoolConnection | mysql.Pool,
  jobUuid: string,
): Promise<BuildJobRecord | null> {
  const [rows] = await conn.query(
    "SELECT * FROM model_build_jobs WHERE job_uuid = ?", [jobUuid],
  ) as any;
  return rows[0] || null;
}

export async function findJobByUuidForUpdate(
  conn: mysql.PoolConnection,
  jobUuid: string,
): Promise<BuildJobRecord | null> {
  const [rows] = await conn.query(
    "SELECT * FROM model_build_jobs WHERE job_uuid = ? FOR UPDATE", [jobUuid],
  ) as any;
  return rows[0] || null;
}

export async function findJobsByOwner(
  conn: mysql.PoolConnection | mysql.Pool,
  ownerId: string,
): Promise<BuildJobRecord[]> {
  const [rows] = await conn.query(
    "SELECT * FROM model_build_jobs WHERE owner_id = ? ORDER BY id DESC LIMIT 50", [ownerId],
  ) as any;
  return rows;
}

export async function findJobBySessionAndOwner(
  conn: mysql.PoolConnection | mysql.Pool,
  sessionId: number,
  ownerId: string,
): Promise<BuildJobRecord | null> {
  const [rows] = await conn.query(
    `SELECT * FROM model_build_jobs
     WHERE reference_session_id = ? AND owner_id = ?
     ORDER BY id DESC LIMIT 1`,
    [sessionId, ownerId],
  ) as any;
  return rows[0] || null;
}

export async function updateJobState(
  conn: mysql.PoolConnection,
  jobId: number,
  state: BuildJobState,
  extra?: {
    currentAttemptId?: number;
    acceptedArtifactId?: number;
    acceptedReportId?: number;
    creditCorrelationId?: string | null;
    refundCorrelationId?: string | null;
    failureCode?: string | null;
  },
): Promise<void> {
  const sets: string[] = ["state = ?"];
  const params: any[] = [state];

  if (extra?.currentAttemptId !== undefined) {
    sets.push("current_attempt_id = ?");
    params.push(extra.currentAttemptId);
  }
  if (extra?.acceptedArtifactId !== undefined) {
    sets.push("accepted_artifact_id = ?");
    params.push(extra.acceptedArtifactId);
  }
  if (extra?.acceptedReportId !== undefined) {
    sets.push("accepted_report_id = ?");
    params.push(extra.acceptedReportId);
  }
  if (extra?.creditCorrelationId !== undefined) {
    sets.push("credit_correlation_id = ?");
    params.push(extra.creditCorrelationId);
  }
  if (extra?.refundCorrelationId !== undefined) {
    sets.push("refund_correlation_id = ?");
    params.push(extra.refundCorrelationId);
  }
  if (extra?.failureCode !== undefined) {
    sets.push("failure_code = ?");
    params.push(extra.failureCode);
  }

  params.push(jobId);
  await conn.query(
    `UPDATE model_build_jobs SET ${sets.join(", ")} WHERE id = ?`,
    params,
  );
}

// ─── Attempt CRUD ───────────────────────────────────────────────────────────

export async function insertAttempt(
  conn: mysql.PoolConnection,
  data: {
    jobId: number;
    attemptNumber: number;
    idempotencyKey: string;
    provider: string;
    model: string;
    inputConfigHash: string;
  },
): Promise<BuildAttemptRecord> {
  const [result] = await conn.query(
    `INSERT INTO model_build_attempts
      (job_id, attempt_number, idempotency_key, provider, model, input_config_hash, state)
     VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
    [data.jobId, data.attemptNumber, data.idempotencyKey, data.provider, data.model, data.inputConfigHash],
  ) as any;
  return findAttemptById(conn, result.insertId) as Promise<BuildAttemptRecord>;
}

export async function findAttemptById(
  conn: mysql.PoolConnection | mysql.Pool,
  id: number,
): Promise<BuildAttemptRecord | null> {
  const [rows] = await conn.query(
    "SELECT * FROM model_build_attempts WHERE id = ?", [id],
  ) as any;
  return rows[0] || null;
}

export async function findAttemptByIdForUpdate(
  conn: mysql.PoolConnection,
  id: number,
): Promise<BuildAttemptRecord | null> {
  const [rows] = await conn.query(
    "SELECT * FROM model_build_attempts WHERE id = ? FOR UPDATE", [id],
  ) as any;
  return rows[0] || null;
}

export async function findAttemptsByJobId(
  conn: mysql.PoolConnection | mysql.Pool,
  jobId: number,
): Promise<BuildAttemptRecord[]> {
  const [rows] = await conn.query(
    "SELECT * FROM model_build_attempts WHERE job_id = ? ORDER BY attempt_number ASC", [jobId],
  ) as any;
  return rows;
}

export async function findAttemptByIdempotencyKey(
  conn: mysql.PoolConnection | mysql.Pool,
  key: string,
): Promise<BuildAttemptRecord | null> {
  const [rows] = await conn.query(
    "SELECT * FROM model_build_attempts WHERE idempotency_key = ?", [key],
  ) as any;
  return rows[0] || null;
}

export async function updateAttemptState(
  conn: mysql.PoolConnection,
  attemptId: number,
  state: BuildAttemptState,
  extra?: {
    providerTaskHandle?: string | null;
    leaseOwner?: string | null;
    leaseExpiresAt?: Date | null;
    submissionClaimedAt?: Date;
    recoveryRequiredAt?: Date;
    handlePersistAttempts?: number;
    failureCode?: string;
    errorMessage?: string;
    completedAt?: Date;
  },
): Promise<void> {
  const sets: string[] = ["state = ?"];
  const params: any[] = [state];

  if (extra?.providerTaskHandle !== undefined) {
    sets.push("provider_task_handle = ?");
    params.push(extra.providerTaskHandle);
  }
  if (extra?.leaseOwner !== undefined) {
    sets.push("lease_owner = ?");
    params.push(extra.leaseOwner);
  }
  if (extra?.leaseExpiresAt !== undefined) {
    sets.push("lease_expires_at = ?");
    params.push(extra.leaseExpiresAt);
  }
  if (extra?.submissionClaimedAt !== undefined) {
    sets.push("submission_claimed_at = ?");
    params.push(extra.submissionClaimedAt);
  }
  if (extra?.recoveryRequiredAt !== undefined) {
    sets.push("recovery_required_at = ?");
    params.push(extra.recoveryRequiredAt);
  }
  if (extra?.handlePersistAttempts !== undefined) {
    sets.push("handle_persist_attempts = ?");
    params.push(extra.handlePersistAttempts);
  }
  if (extra?.failureCode !== undefined) {
    sets.push("failure_code = ?");
    params.push(extra.failureCode);
  }
  if (extra?.errorMessage !== undefined) {
    sets.push("error_message = ?");
    params.push(extra.errorMessage?.slice(0, 500));
  }
  if (extra?.completedAt !== undefined) {
    sets.push("completed_at = ?");
    params.push(extra.completedAt);
  }

  params.push(attemptId);
  await conn.query(
    `UPDATE model_build_attempts SET ${sets.join(", ")} WHERE id = ?`,
    params,
  );
}

export async function claimLease(
  conn: mysql.PoolConnection,
  attemptId: number,
  leaseOwner: string,
  leaseExpiresAt: Date,
): Promise<boolean> {
  const [result] = await conn.query(
    `UPDATE model_build_attempts
     SET lease_owner = ?, lease_expires_at = ?
     WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < NOW())`,
    [leaseOwner, leaseExpiresAt, attemptId],
  ) as any;
  return result.affectedRows === 1;
}

export async function releaseLease(
  conn: mysql.PoolConnection | mysql.Pool,
  attemptId: number,
  leaseOwner: string,
): Promise<void> {
  await conn.query(
    `UPDATE model_build_attempts
     SET lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ? AND lease_owner = ?`,
    [attemptId, leaseOwner],
  );
}

export async function renewLease(
  db: mysql.PoolConnection | mysql.Pool,
  attemptId: number,
  leaseOwner: string,
  leaseExpiresAt: Date,
): Promise<boolean> {
  const [result] = await db.query(
    `UPDATE model_build_attempts
     SET lease_expires_at = ?
     WHERE id = ? AND lease_owner = ? AND lease_expires_at >= NOW()`,
    [leaseExpiresAt, attemptId, leaseOwner],
  ) as any;
  return result.affectedRows === 1;
}

export async function findExpiredLeases(
  conn: mysql.PoolConnection | mysql.Pool,
): Promise<BuildAttemptRecord[]> {
  const [rows] = await conn.query(
    `SELECT * FROM model_build_attempts
     WHERE (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < NOW())
       AND state IN ('submitted', 'processing', 'downloading', 'validating')`,
  ) as any;
  return rows;
}

/**
 * MG-7: attempts stranded in `queued` with no lease.
 *
 * processAttempt is launched fire-and-forget. If it threw before claiming a
 * lease — pool exhaustion on getConnection()/beginTransaction() being the
 * realistic case — the rejection was swallowed at the call site and the row
 * stayed `queued` forever. findExpiredLeases deliberately does not cover
 * `queued`, so nothing re-entered processing.
 *
 * The age floor keeps this sweep away from jobs whose in-process worker is
 * simply still starting up; lease claiming is transactional, so a race with a
 * live worker is safe regardless — only one side wins the claim.
 */
export async function findStaleQueuedAttempts(
  conn: mysql.PoolConnection | mysql.Pool,
  minimumAgeSeconds = 120,
): Promise<BuildAttemptRecord[]> {
  const [rows] = await conn.query(
    `SELECT * FROM model_build_attempts
     WHERE state = 'queued'
       AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < NOW())
       AND started_at < (NOW() - INTERVAL ? SECOND)`,
    [minimumAgeSeconds],
  ) as any;
  return rows;
}

export async function findAmbiguousSubmissions(
  conn: mysql.PoolConnection | mysql.Pool,
): Promise<BuildAttemptRecord[]> {
  const [rows] = await conn.query(
    `SELECT * FROM model_build_attempts
     WHERE state IN ('submitted', 'recovery_required')
       AND provider_task_handle IS NULL
       AND (lease_owner IS NULL OR lease_expires_at < NOW())`,
  ) as any;
  return rows;
}

export async function findRefundPendingJobs(
  conn: mysql.PoolConnection | mysql.Pool,
): Promise<BuildJobRecord[]> {
  const [rows] = await conn.query(
    `SELECT * FROM model_build_jobs
     WHERE state IN ('failed_provider', 'failed_validation', 'cancelled')
       AND credit_correlation_id IS NOT NULL
       AND refund_correlation_id IS NULL
       AND current_attempt_id IS NOT NULL
     ORDER BY id ASC`,
  ) as any;
  return rows;
}

export async function markRefundPending(
  conn: mysql.PoolConnection,
  jobId: number,
  errorCode: string | null,
): Promise<void> {
  await conn.query(
    `UPDATE model_build_jobs
     SET refund_pending_at = COALESCE(refund_pending_at, NOW()),
         refund_attempts = refund_attempts + 1,
         last_refund_error_code = ?
     WHERE id = ?`,
    [errorCode, jobId],
  );
}

export async function markRefundComplete(
  conn: mysql.PoolConnection,
  jobId: number,
  refundCorrelationId: string,
): Promise<void> {
  await conn.query(
    `UPDATE model_build_jobs
     SET refund_correlation_id = ?, refund_pending_at = NULL,
         last_refund_error_code = NULL
     WHERE id = ?`,
    [refundCorrelationId, jobId],
  );
}

export async function markRefundFailure(
  conn: mysql.PoolConnection,
  jobId: number,
): Promise<void> {
  await conn.query(
    `UPDATE model_build_jobs
     SET refund_pending_at = COALESCE(refund_pending_at, NOW()),
         last_refund_error_code = 'REFUND_RETRY_REQUIRED'
     WHERE id = ? AND refund_correlation_id IS NULL`,
    [jobId],
  );
}

// ─── Provider Events ────────────────────────────────────────────────────────

export function computeEventHash(
  provider: string,
  attemptId: number,
  eventType: ProviderEventType,
  deduplicationKey: string,
): string {
  return crypto.createHash("sha256")
    .update(`${provider}:${attemptId}:${eventType}:${deduplicationKey}`)
    .digest("hex");
}

export async function insertProviderEvent(
  conn: mysql.PoolConnection,
  data: {
    provider: string;
    eventHash: string;
    attemptId: number;
    eventType: ProviderEventType;
    payloadMetadata?: Record<string, unknown>;
  },
): Promise<{ inserted: boolean; record: ProviderEventRecord | null }> {
  try {
    const [result] = await conn.query(
      `INSERT INTO model_provider_events
        (provider, event_hash, attempt_id, event_type, payload_metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [data.provider, data.eventHash, data.attemptId, data.eventType,
       data.payloadMetadata ? JSON.stringify(data.payloadMetadata) : null],
    ) as any;
    const [rows] = await conn.query(
      "SELECT * FROM model_provider_events WHERE id = ?", [result.insertId],
    ) as any;
    return { inserted: true, record: rows[0] || null };
  } catch (err: any) {
    if (err.code === "ER_DUP_ENTRY" || err.errno === 1062) {
      return { inserted: false, record: null };
    }
    throw err;
  }
}

// ─── Artifacts ──────────────────────────────────────────────────────────────

export async function insertArtifact(
  conn: mysql.PoolConnection,
  data: {
    attemptId: number;
    assetId: number;
    assetVersionId: number;
    role: ArtifactRole;
    computedHash: string;
    sizeBytes: number;
    mimeType: string;
  },
): Promise<BuildArtifactRecord> {
  const [result] = await conn.query(
    `INSERT INTO model_build_artifacts
      (attempt_id, asset_id, asset_version_id, role, computed_hash, size_bytes, mime_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.attemptId, data.assetId, data.assetVersionId, data.role, data.computedHash, data.sizeBytes, data.mimeType],
  ) as any;
  return findArtifactById(conn, result.insertId) as Promise<BuildArtifactRecord>;
}

export async function findArtifactById(
  conn: mysql.PoolConnection | mysql.Pool,
  id: number,
): Promise<BuildArtifactRecord | null> {
  const [rows] = await conn.query(
    "SELECT * FROM model_build_artifacts WHERE id = ?", [id],
  ) as any;
  return rows[0] || null;
}

export async function findArtifactsByAttemptId(
  conn: mysql.PoolConnection | mysql.Pool,
  attemptId: number,
): Promise<BuildArtifactRecord[]> {
  const [rows] = await conn.query(
    "SELECT * FROM model_build_artifacts WHERE attempt_id = ? ORDER BY id ASC", [attemptId],
  ) as any;
  return rows;
}

export async function findArtifactByAttemptAndRole(
  conn: mysql.PoolConnection | mysql.Pool,
  attemptId: number,
  role: ArtifactRole,
): Promise<BuildArtifactRecord | null> {
  const [rows] = await conn.query(
    "SELECT * FROM model_build_artifacts WHERE attempt_id = ? AND role = ?", [attemptId, role],
  ) as any;
  return rows[0] || null;
}

// ─── Reports ────────────────────────────────────────────────────────────────

export async function insertReport(
  conn: mysql.PoolConnection,
  data: {
    attemptId: number;
    reportAssetId: number;
    reportAssetVersionId: number;
    status: PostBuildReportStatus;
    validatorVersions: string;
    metricsHash: string;
    metricsJson?: Record<string, unknown>;
  },
): Promise<PostBuildReportRecord> {
  const [result] = await conn.query(
    `INSERT INTO model_post_build_reports
      (attempt_id, report_asset_id, report_asset_version_id, status, validator_versions, metrics_hash, metrics_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.attemptId, data.reportAssetId, data.reportAssetVersionId, data.status,
     data.validatorVersions, data.metricsHash,
     data.metricsJson ? JSON.stringify(data.metricsJson) : null],
  ) as any;
  return findReportById(conn, result.insertId) as Promise<PostBuildReportRecord>;
}

export async function findReportById(
  conn: mysql.PoolConnection | mysql.Pool,
  id: number,
): Promise<PostBuildReportRecord | null> {
  const [rows] = await conn.query(
    "SELECT * FROM model_post_build_reports WHERE id = ?", [id],
  ) as any;
  return rows[0] || null;
}

export async function findReportByAttemptId(
  conn: mysql.PoolConnection | mysql.Pool,
  attemptId: number,
): Promise<PostBuildReportRecord | null> {
  const [rows] = await conn.query(
    "SELECT * FROM model_post_build_reports WHERE attempt_id = ?", [attemptId],
  ) as any;
  return rows[0] || null;
}

// ─── Acceptance ─────────────────────────────────────────────────────────────

export async function insertAcceptance(
  conn: mysql.PoolConnection,
  data: {
    jobId: number;
    attemptId: number;
    artifactId: number;
    reportId: number;
    acceptedByUser: string;
  },
): Promise<BuildAcceptanceRecord> {
  const [result] = await conn.query(
    `INSERT INTO model_build_acceptances
      (job_id, attempt_id, artifact_id, report_id, accepted_by_user)
     VALUES (?, ?, ?, ?, ?)`,
    [data.jobId, data.attemptId, data.artifactId, data.reportId, data.acceptedByUser],
  ) as any;
  const [rows] = await conn.query(
    "SELECT * FROM model_build_acceptances WHERE id = ?", [result.insertId],
  ) as any;
  return rows[0];
}

export async function findAcceptanceByJobId(
  conn: mysql.PoolConnection | mysql.Pool,
  jobId: number,
): Promise<BuildAcceptanceRecord | null> {
  const [rows] = await conn.query(
    "SELECT * FROM model_build_acceptances WHERE job_id = ?", [jobId],
  ) as any;
  return rows[0] || null;
}
