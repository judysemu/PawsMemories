// ─── Build Job States ───────────────────────────────────────────────────────
export type BuildJobState =
  | "draft"
  | "preflight"
  | "reserving"
  | "queued"
  | "submitted"
  | "recovery_required"
  | "processing"
  | "downloading"
  | "validating"
  | "ready"
  | "accepted"
  | "failed_preflight"
  | "failed_provider"
  | "failed_validation"
  | "cancelled";

export const TERMINAL_JOB_STATES: readonly BuildJobState[] = [
  "accepted",
  "failed_preflight",
  "failed_provider",
  "failed_validation",
  "cancelled",
] as const;

export const REFUNDABLE_FAILURE_STATES: readonly BuildJobState[] = [
  "failed_provider",
  "failed_validation",
] as const;

// ─── Build Attempt States ───────────────────────────────────────────────────
export type BuildAttemptState =
  | "queued"
  | "submitted"
  | "recovery_required"
  | "processing"
  | "downloading"
  | "validating"
  | "ready"
  | "failed"
  | "cancelled";

// ─── Artifact Roles ─────────────────────────────────────────────────────────
export type ArtifactRole =
  | "provider_glb"
  | "validated_glb"
  | "render_front"
  | "render_left"
  | "render_right"
  | "render_rear"
  | "render_three_quarter";

// ─── Report Status ──────────────────────────────────────────────────────────
export type PostBuildReportStatus = "pass" | "warn" | "fail";

// ─── Provider Event Types ───────────────────────────────────────────────────
export type ProviderEventType =
  | "task_created"
  | "task_progress"
  | "task_success"
  | "task_failed"
  | "task_cancelled"
  | "callback_received";

// ─── Configuration ──────────────────────────────────────────────────────────
export const MAX_BUILD_CORRECTION_ATTEMPTS = 3;
export const MAX_GLB_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
export const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_POLL_ATTEMPTS = 120;
export const POLL_INTERVAL_MS = 5000;
export const POLL_JITTER_MS = 1000;
export const MAX_PROVIDER_RETRY_DELAY_MS = 30_000;
export const MAX_PROVIDER_START_ATTEMPTS = 3;
export const PROVIDER_START_RETRY_BASE_MS = 1000;
export const MAX_HANDLE_PERSIST_ATTEMPTS = 3;
export const HANDLE_PERSIST_RETRY_BASE_MS = 250;
export const PROVIDER_CONNECT_TIMEOUT_MS = 30_000;
export const PROVIDER_READ_TIMEOUT_MS = 120_000;
export const GLB_MAGIC = 0x46546C67; // "glTF" little-endian

// ─── Database Records ───────────────────────────────────────────────────────
export interface BuildJobRecord {
  id: number;
  job_uuid: string;
  owner_id: string;
  reference_session_id: number;
  reference_attempt_id: number;
  manifest_asset_id: number;
  manifest_asset_version_id: number;
  manifest_hash: string;
  requested_output: string;
  pricing_key: string;
  quoted_credits: number;
  state: BuildJobState;
  current_attempt_id: number | null;
  accepted_artifact_id: number | null;
  accepted_report_id: number | null;
  credit_correlation_id: string | null;
  refund_correlation_id: string | null;
  refund_pending_at: Date | null;
  refund_attempts: number;
  last_refund_error_code: string | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface BuildAttemptRecord {
  id: number;
  job_id: number;
  attempt_number: number;
  idempotency_key: string;
  provider: string;
  model: string;
  provider_task_handle: string | null;
  submission_claimed_at: Date | null;
  recovery_required_at: Date | null;
  handle_persist_attempts: number;
  input_config_hash: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  state: BuildAttemptState;
  failure_code: string | null;
  error_message: string | null;
  started_at: Date;
  completed_at: Date | null;
}

export interface ProviderEventRecord {
  id: number;
  provider: string;
  event_hash: string;
  attempt_id: number;
  event_type: ProviderEventType;
  received_at: Date;
  processed_at: Date | null;
  payload_metadata: Record<string, unknown> | null;
}

export interface BuildArtifactRecord {
  id: number;
  attempt_id: number;
  asset_id: number;
  asset_version_id: number;
  role: ArtifactRole;
  computed_hash: string;
  size_bytes: number;
  mime_type: string;
  created_at: Date;
}

export interface PostBuildReportRecord {
  id: number;
  attempt_id: number;
  report_asset_id: number;
  report_asset_version_id: number;
  status: PostBuildReportStatus;
  validator_versions: string;
  metrics_hash: string;
  metrics_json: Record<string, unknown> | null;
  created_at: Date;
}

export interface BuildAcceptanceRecord {
  id: number;
  job_id: number;
  attempt_id: number;
  artifact_id: number;
  report_id: number;
  accepted_by_user: string;
  created_at: Date;
}

// ─── Public DTOs ────────────────────────────────────────────────────────────
// These NEVER include object_key, raw provider URLs, or internal IDs.

export interface BuildJobPublic {
  jobUuid: string;
  ownerId: string;
  referenceSessionUuid: string;
  manifestHashPrefix: string; // first 12 hex chars
  requestedOutput: string;
  pricingKey: string;
  quotedCredits: number;
  state: BuildJobState;
  currentAttemptNumber: number | null;
  failureCode: string | null;
  diagnostic: "provider_submission_recovery_required" | "refund_pending" | null;
  billingDisposition: "charged" | "refunded" | "not_charged" | "refund_pending";
  createdAt: string;
  updatedAt: string;
}

export interface BuildAttemptPublic {
  attemptNumber: number;
  provider: string;
  model: string;
  state: BuildAttemptState;
  failureCode: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface BuildArtifactPublic {
  role: ArtifactRole;
  assetUuid: string;
  versionNumber: number;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  signedUrl?: string;
}

export interface PostBuildReportPublic {
  status: PostBuildReportStatus;
  validatorVersions: string;
  metricsHash: string;
  metrics: Record<string, unknown> | null;
}

export interface BuildQuotePublic {
  referenceSessionUuid: string;
  manifestHashPrefix: string;
  pricingKey: string;
  quotedCredits: number;
  currentBalance: number;
  sufficientBalance: boolean;
  preflightPassed: boolean;
  preflightErrors: string[];
}

export interface PreflightResult {
  passed: boolean;
  errors: string[];
  sessionId: number;
  attemptId: number;
  manifestAssetId: number;
  manifestAssetVersionId: number;
  manifestHash: string;
  quotedCredits: number;
  pricingKey: string;
  currentBalance: number;
}
