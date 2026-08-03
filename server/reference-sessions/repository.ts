import type mysql from "mysql2/promise";
import type {
  ReferenceSessionRecord,
  ReferenceAttemptRecord,
  ReferenceViewRecord,
  ReferenceReportRecord,
  ReferenceApprovalRecord,
  SessionState,
  AttemptState,
  ViewKind,
  InputMode,
  ReportStatus,
  ScaleConfidence,
} from "./types";

export async function insertSession(
  connection: mysql.PoolConnection | mysql.Pool,
  data: {
    sessionUuid: string;
    ownerId: string;
    inputMode: InputMode;
    subjectClass?: string;
    prompt?: string | null;
    sourceAssetId?: number | null;
    sourceAssetVersionId?: number | null;
  },
): Promise<ReferenceSessionRecord> {
  const subjectClass = data.subjectClass || "pet";
  const [result]: any = await connection.query(
    `INSERT INTO reference_sessions
       (session_uuid, owner_id, input_mode, subject_class, prompt, source_asset_id, source_asset_version_id, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
    [
      data.sessionUuid,
      data.ownerId,
      data.inputMode,
      subjectClass,
      data.prompt || null,
      data.sourceAssetId || null,
      data.sourceAssetVersionId || null,
    ],
  );

  const found = await findSessionById(connection, Number(result.insertId));
  if (!found) throw new Error("Failed to insert reference session.");
  return found;
}

export async function findSessionById(
  connection: mysql.PoolConnection | mysql.Pool,
  id: number,
): Promise<ReferenceSessionRecord | null> {
  const [rows]: any = await connection.query(
    `SELECT id, session_uuid, owner_id, input_mode, subject_class, prompt, source_asset_id, source_asset_version_id, state, current_attempt_id, approved_attempt_id, source_attempt_count, retry_count, created_at, updated_at
     FROM reference_sessions WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    session_uuid: String(r.session_uuid),
    owner_id: String(r.owner_id),
    input_mode: r.input_mode as InputMode,
    subject_class: String(r.subject_class),
    prompt: r.prompt ? String(r.prompt) : null,
    source_asset_id: r.source_asset_id ? Number(r.source_asset_id) : null,
    source_asset_version_id: r.source_asset_version_id ? Number(r.source_asset_version_id) : null,
    state: r.state as SessionState,
    current_attempt_id: r.current_attempt_id ? Number(r.current_attempt_id) : null,
    approved_attempt_id: r.approved_attempt_id ? Number(r.approved_attempt_id) : null,
    source_attempt_count: Number(r.source_attempt_count),
    retry_count: Number(r.retry_count),
    created_at: new Date(r.created_at),
    updated_at: new Date(r.updated_at),
  };
}

export async function findSessionByUuid(
  connection: mysql.PoolConnection | mysql.Pool,
  sessionUuid: string,
): Promise<ReferenceSessionRecord | null> {
  const [rows]: any = await connection.query(
    `SELECT id, session_uuid, owner_id, input_mode, subject_class, prompt, source_asset_id, source_asset_version_id, state, current_attempt_id, approved_attempt_id, source_attempt_count, retry_count, created_at, updated_at
     FROM reference_sessions WHERE session_uuid = ? LIMIT 1`,
    [sessionUuid],
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    session_uuid: String(r.session_uuid),
    owner_id: String(r.owner_id),
    input_mode: r.input_mode as InputMode,
    subject_class: String(r.subject_class),
    prompt: r.prompt ? String(r.prompt) : null,
    source_asset_id: r.source_asset_id ? Number(r.source_asset_id) : null,
    source_asset_version_id: r.source_asset_version_id ? Number(r.source_asset_version_id) : null,
    state: r.state as SessionState,
    current_attempt_id: r.current_attempt_id ? Number(r.current_attempt_id) : null,
    approved_attempt_id: r.approved_attempt_id ? Number(r.approved_attempt_id) : null,
    source_attempt_count: Number(r.source_attempt_count),
    retry_count: Number(r.retry_count),
    created_at: new Date(r.created_at),
    updated_at: new Date(r.updated_at),
  };
}

export async function findSessionByUuidForUpdate(
  connection: mysql.PoolConnection,
  sessionUuid: string,
): Promise<ReferenceSessionRecord | null> {
  const [rows]: any = await connection.query(
    `SELECT id, session_uuid, owner_id, input_mode, subject_class, prompt, source_asset_id, source_asset_version_id, state, current_attempt_id, approved_attempt_id, source_attempt_count, retry_count, created_at, updated_at
     FROM reference_sessions WHERE session_uuid = ? LIMIT 1 FOR UPDATE`,
    [sessionUuid],
  );
  if (!rows?.length) return null;
  const r = rows[0];
  return {
    id: Number(r.id), session_uuid: String(r.session_uuid), owner_id: String(r.owner_id), input_mode: r.input_mode as InputMode,
    subject_class: String(r.subject_class), prompt: r.prompt ? String(r.prompt) : null,
    source_asset_id: r.source_asset_id ? Number(r.source_asset_id) : null,
    source_asset_version_id: r.source_asset_version_id ? Number(r.source_asset_version_id) : null,
    state: r.state as SessionState, current_attempt_id: r.current_attempt_id ? Number(r.current_attempt_id) : null,
    approved_attempt_id: r.approved_attempt_id ? Number(r.approved_attempt_id) : null,
    source_attempt_count: Number(r.source_attempt_count), retry_count: Number(r.retry_count), created_at: new Date(r.created_at), updated_at: new Date(r.updated_at),
  };
}

export async function updateSessionSource(
  connection: mysql.PoolConnection | mysql.Pool,
  sessionId: number,
  assetId: number,
  assetVersionId: number,
): Promise<void> {
  await connection.query(
    `UPDATE reference_sessions
     SET source_asset_id = ?, source_asset_version_id = ?, state = 'draft',
         current_attempt_id = NULL, approved_attempt_id = NULL, source_attempt_count = 0
     WHERE id = ?`,
    [assetId, assetVersionId, sessionId],
  );
}

export async function findSessionsByOwner(
  connection: mysql.PoolConnection | mysql.Pool,
  ownerId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ReferenceSessionRecord[]> {
  const limit = options.limit || 20;
  const offset = options.offset || 0;
  const [rows]: any = await connection.query(
    `SELECT id, session_uuid, owner_id, input_mode, subject_class, prompt, source_asset_id, source_asset_version_id, state, current_attempt_id, approved_attempt_id, source_attempt_count, retry_count, created_at, updated_at
     FROM reference_sessions WHERE owner_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    [ownerId, limit, offset],
  );

  return (rows as any[]).map((r) => ({
    id: Number(r.id),
    session_uuid: String(r.session_uuid),
    owner_id: String(r.owner_id),
    input_mode: r.input_mode as InputMode,
    subject_class: String(r.subject_class),
    prompt: r.prompt ? String(r.prompt) : null,
    source_asset_id: r.source_asset_id ? Number(r.source_asset_id) : null,
    source_asset_version_id: r.source_asset_version_id ? Number(r.source_asset_version_id) : null,
    state: r.state as SessionState,
    current_attempt_id: r.current_attempt_id ? Number(r.current_attempt_id) : null,
    approved_attempt_id: r.approved_attempt_id ? Number(r.approved_attempt_id) : null,
    source_attempt_count: Number(r.source_attempt_count),
    retry_count: Number(r.retry_count),
    created_at: new Date(r.created_at),
    updated_at: new Date(r.updated_at),
  }));
}

export async function updateSessionState(
  connection: mysql.PoolConnection | mysql.Pool,
  sessionId: number,
  state: SessionState,
  extra: {
    currentAttemptId?: number | null;
    approvedAttemptId?: number | null;
    incrementRetry?: boolean;
    incrementSourceAttempt?: boolean;
  } = {},
): Promise<void> {
  const updates = ["state = ?"];
  const params: any[] = [state];

  if (extra.currentAttemptId !== undefined) {
    updates.push("current_attempt_id = ?");
    params.push(extra.currentAttemptId);
  }
  if (extra.approvedAttemptId !== undefined) {
    updates.push("approved_attempt_id = ?");
    params.push(extra.approvedAttemptId);
  }
  if (extra.incrementRetry) {
    updates.push("retry_count = retry_count + 1");
  }
  if (extra.incrementSourceAttempt) {
    updates.push("source_attempt_count = source_attempt_count + 1");
  }

  params.push(sessionId);
  await connection.query(`UPDATE reference_sessions SET ${updates.join(", ")} WHERE id = ?`, params);
}

export async function insertAttempt(
  connection: mysql.PoolConnection | mysql.Pool,
  data: {
    sessionId: number;
    attemptNumber: number;
    idempotencyKey: string;
    provider?: string;
    model: string;
    promptConfigHash: string;
    retryNotes?: string | null;
  },
): Promise<ReferenceAttemptRecord> {
  const provider = data.provider || "tripo";
  const [result]: any = await connection.query(
    `INSERT INTO reference_attempts
       (session_id, attempt_number, idempotency_key, provider, model, prompt_config_hash, retry_notes, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`,
    [
      data.sessionId,
      data.attemptNumber,
      data.idempotencyKey,
      provider,
      data.model,
      data.promptConfigHash,
      data.retryNotes || null,
    ],
  );

  const found = await findAttemptById(connection, Number(result.insertId));
  if (!found) throw new Error("Failed to insert reference attempt.");
  return found;
}

export async function findAttemptById(
  connection: mysql.PoolConnection | mysql.Pool,
  id: number,
): Promise<ReferenceAttemptRecord | null> {
  const [rows]: any = await connection.query(
    `SELECT id, session_id, attempt_number, idempotency_key, provider, model, prompt_config_hash, retry_notes, state, failure_code, error_message, started_at, completed_at
     FROM reference_attempts WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    session_id: Number(r.session_id),
    attempt_number: Number(r.attempt_number),
    idempotency_key: String(r.idempotency_key),
    provider: String(r.provider),
    model: String(r.model),
    prompt_config_hash: String(r.prompt_config_hash),
    retry_notes: r.retry_notes ? String(r.retry_notes) : null,
    state: r.state as AttemptState,
    failure_code: r.failure_code ? String(r.failure_code) : null,
    error_message: r.error_message ? String(r.error_message) : null,
    started_at: new Date(r.started_at),
    completed_at: r.completed_at ? new Date(r.completed_at) : null,
  };
}

export async function findAttemptsBySessionId(
  connection: mysql.PoolConnection | mysql.Pool,
  sessionId: number,
): Promise<ReferenceAttemptRecord[]> {
  const [rows]: any = await connection.query(
    `SELECT id, session_id, attempt_number, idempotency_key, provider, model, prompt_config_hash, retry_notes, state, failure_code, error_message, started_at, completed_at
     FROM reference_attempts WHERE session_id = ? ORDER BY attempt_number ASC`,
    [sessionId],
  );

  return (rows as any[]).map((r) => ({
    id: Number(r.id),
    session_id: Number(r.session_id),
    attempt_number: Number(r.attempt_number),
    idempotency_key: String(r.idempotency_key),
    provider: String(r.provider),
    model: String(r.model),
    prompt_config_hash: String(r.prompt_config_hash),
    retry_notes: r.retry_notes ? String(r.retry_notes) : null,
    state: r.state as AttemptState,
    failure_code: r.failure_code ? String(r.failure_code) : null,
    error_message: r.error_message ? String(r.error_message) : null,
    started_at: new Date(r.started_at),
    completed_at: r.completed_at ? new Date(r.completed_at) : null,
  }));
}

export async function findAttemptByIdempotencyKey(
  connection: mysql.PoolConnection | mysql.Pool,
  sessionId: number,
  idempotencyKey: string,
  lockForUpdate = false,
): Promise<ReferenceAttemptRecord | null> {
  const [rows]: any = await connection.query(
    `SELECT id, session_id, attempt_number, idempotency_key, provider, model, prompt_config_hash, retry_notes, state, failure_code, error_message, started_at, completed_at
     FROM reference_attempts WHERE session_id = ? AND idempotency_key = ? LIMIT 1${lockForUpdate ? " FOR UPDATE" : ""}`,
    [sessionId, idempotencyKey],
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    session_id: Number(r.session_id),
    attempt_number: Number(r.attempt_number),
    idempotency_key: String(r.idempotency_key),
    provider: String(r.provider),
    model: String(r.model),
    prompt_config_hash: String(r.prompt_config_hash),
    retry_notes: r.retry_notes ? String(r.retry_notes) : null,
    state: r.state as AttemptState,
    failure_code: r.failure_code ? String(r.failure_code) : null,
    error_message: r.error_message ? String(r.error_message) : null,
    started_at: new Date(r.started_at),
    completed_at: r.completed_at ? new Date(r.completed_at) : null,
  };
}

export async function updateAttemptState(
  connection: mysql.PoolConnection | mysql.Pool,
  attemptId: number,
  state: AttemptState,
  failureCode?: string | null,
  errorMessage?: string | null,
): Promise<void> {
  const completedAt = state === "ready" || state === "failed" || state === "cancelled" ? new Date() : null;
  await connection.query(
    `UPDATE reference_attempts
     SET state = ?, failure_code = ?, error_message = ?, completed_at = ?
     WHERE id = ?`,
    [state, failureCode || null, errorMessage || null, completedAt, attemptId],
  );
}

export async function updateAttemptProvider(
  connection: mysql.PoolConnection | mysql.Pool,
  attemptId: number,
  provider: string,
  model: string,
): Promise<void> {
  await connection.query("UPDATE reference_attempts SET provider = ?, model = ? WHERE id = ?", [provider, model, attemptId]);
}

export async function updateAttemptProviderTaskHandle(
  connection: mysql.PoolConnection | mysql.Pool,
  attemptId: number,
  taskHandle: string,
): Promise<void> {
  if (!taskHandle || taskHandle.length > 255) throw new Error("Invalid reference provider task handle.");
  await connection.query(
    "UPDATE reference_attempts SET provider_task_handle = ? WHERE id = ? AND provider_task_handle IS NULL",
    [taskHandle, attemptId],
  );
}

export async function insertView(
  connection: mysql.PoolConnection | mysql.Pool,
  data: {
    attemptId: number;
    viewKind: ViewKind;
    assetId: number;
    assetVersionId: number;
    widthPx: number;
    heightPx: number;
    isSynthesized?: boolean;
  },
): Promise<ReferenceViewRecord> {
  const isSynthesized = (data.isSynthesized ?? true) ? 1 : 0;
  const [result]: any = await connection.query(
    `INSERT INTO reference_views
       (attempt_id, view_kind, asset_id, asset_version_id, width_px, height_px, is_synthesized)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.attemptId,
      data.viewKind,
      data.assetId,
      data.assetVersionId,
      data.widthPx,
      data.heightPx,
      isSynthesized,
    ],
  );

  const [rows]: any = await connection.query(
    `SELECT id, attempt_id, view_kind, asset_id, asset_version_id, width_px, height_px, is_synthesized, created_at
     FROM reference_views WHERE id = ? LIMIT 1`,
    [result.insertId],
  );
  const r = rows[0];
  return {
    id: Number(r.id),
    attempt_id: Number(r.attempt_id),
    view_kind: r.view_kind as ViewKind,
    asset_id: Number(r.asset_id),
    asset_version_id: Number(r.asset_version_id),
    width_px: Number(r.width_px),
    height_px: Number(r.height_px),
    is_synthesized: Boolean(r.is_synthesized),
    created_at: new Date(r.created_at),
  };
}

export async function findViewsByAttemptId(
  connection: mysql.PoolConnection | mysql.Pool,
  attemptId: number,
): Promise<ReferenceViewRecord[]> {
  const [rows]: any = await connection.query(
    `SELECT id, attempt_id, view_kind, asset_id, asset_version_id, width_px, height_px, is_synthesized, created_at
     FROM reference_views WHERE attempt_id = ?
     ORDER BY FIELD(view_kind, 'front', 'left', 'right', 'rear', 'front_three_quarter')`,
    [attemptId],
  );

  return (rows as any[]).map((r) => ({
    id: Number(r.id),
    attempt_id: Number(r.attempt_id),
    view_kind: r.view_kind as ViewKind,
    asset_id: Number(r.asset_id),
    asset_version_id: Number(r.asset_version_id),
    width_px: Number(r.width_px),
    height_px: Number(r.height_px),
    is_synthesized: Boolean(r.is_synthesized),
    created_at: new Date(r.created_at),
  }));
}

export async function insertReport(
  connection: mysql.PoolConnection | mysql.Pool,
  data: {
    attemptId: number;
    reportAssetId?: number | null;
    reportAssetVersionId?: number | null;
    status: ReportStatus;
    scaleConfidence: ScaleConfidence;
    reportHash: string;
    metricsJson?: Record<string, any> | null;
  },
): Promise<ReferenceReportRecord> {
  const jsonStr = data.metricsJson ? JSON.stringify(data.metricsJson) : null;
  const [result]: any = await connection.query(
    `INSERT INTO reference_reports
       (attempt_id, report_asset_id, report_asset_version_id, status, scale_confidence, report_hash, metrics_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.attemptId,
      data.reportAssetId || null,
      data.reportAssetVersionId || null,
      data.status,
      data.scaleConfidence,
      data.reportHash,
      jsonStr,
    ],
  );

  const [rows]: any = await connection.query(
    `SELECT id, attempt_id, report_asset_id, report_asset_version_id, status, scale_confidence, report_hash, metrics_json, created_at
     FROM reference_reports WHERE id = ? LIMIT 1`,
    [result.insertId],
  );
  const r = rows[0];
  return {
    id: Number(r.id),
    attempt_id: Number(r.attempt_id),
    report_asset_id: r.report_asset_id ? Number(r.report_asset_id) : null,
    report_asset_version_id: r.report_asset_version_id ? Number(r.report_asset_version_id) : null,
    status: r.status as ReportStatus,
    scale_confidence: r.scale_confidence as ScaleConfidence,
    report_hash: String(r.report_hash),
    metrics_json: typeof r.metrics_json === "string" ? JSON.parse(r.metrics_json) : r.metrics_json,
    created_at: new Date(r.created_at),
  };
}

export async function findReportByAttemptId(
  connection: mysql.PoolConnection | mysql.Pool,
  attemptId: number,
): Promise<ReferenceReportRecord | null> {
  const [rows]: any = await connection.query(
    `SELECT id, attempt_id, report_asset_id, report_asset_version_id, status, scale_confidence, report_hash, metrics_json, created_at
     FROM reference_reports WHERE attempt_id = ? LIMIT 1`,
    [attemptId],
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    attempt_id: Number(r.attempt_id),
    report_asset_id: r.report_asset_id ? Number(r.report_asset_id) : null,
    report_asset_version_id: r.report_asset_version_id ? Number(r.report_asset_version_id) : null,
    status: r.status as ReportStatus,
    scale_confidence: r.scale_confidence as ScaleConfidence,
    report_hash: String(r.report_hash),
    metrics_json: typeof r.metrics_json === "string" ? JSON.parse(r.metrics_json) : r.metrics_json,
    created_at: new Date(r.created_at),
  };
}

export async function insertApproval(
  connection: mysql.PoolConnection | mysql.Pool,
  data: {
    sessionId: number;
    attemptId: number;
    manifestAssetId: number;
    manifestAssetVersionId: number;
    manifestHash: string;
    approvedByUser: string;
  },
): Promise<ReferenceApprovalRecord> {
  const [result]: any = await connection.query(
    `INSERT INTO reference_approvals
       (session_id, attempt_id, manifest_asset_id, manifest_asset_version_id, manifest_hash, approved_by_user)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [data.sessionId, data.attemptId, data.manifestAssetId, data.manifestAssetVersionId, data.manifestHash, data.approvedByUser],
  );

  const [rows]: any = await connection.query(
    `SELECT id, session_id, attempt_id, manifest_asset_id, manifest_asset_version_id, manifest_hash, approved_by_user, created_at
     FROM reference_approvals WHERE id = ? LIMIT 1`,
    [result.insertId],
  );
  const r = rows[0];
  return {
    id: Number(r.id),
    session_id: Number(r.session_id),
    attempt_id: Number(r.attempt_id),
    manifest_asset_id: r.manifest_asset_id ? Number(r.manifest_asset_id) : null,
    manifest_asset_version_id: r.manifest_asset_version_id ? Number(r.manifest_asset_version_id) : null,
    manifest_hash: String(r.manifest_hash),
    approved_by_user: String(r.approved_by_user),
    created_at: new Date(r.created_at),
  };
}

export async function findApprovalBySessionId(
  connection: mysql.PoolConnection | mysql.Pool,
  sessionId: number,
): Promise<ReferenceApprovalRecord | null> {
  const [rows]: any = await connection.query(
    `SELECT id, session_id, attempt_id, manifest_asset_id, manifest_asset_version_id, manifest_hash, approved_by_user, created_at
     FROM reference_approvals WHERE session_id = ? LIMIT 1`,
    [sessionId],
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    session_id: Number(r.session_id),
    attempt_id: Number(r.attempt_id),
    manifest_asset_id: r.manifest_asset_id ? Number(r.manifest_asset_id) : null,
    manifest_asset_version_id: r.manifest_asset_version_id ? Number(r.manifest_asset_version_id) : null,
    manifest_hash: String(r.manifest_hash),
    approved_by_user: String(r.approved_by_user),
    created_at: new Date(r.created_at),
  };
}
