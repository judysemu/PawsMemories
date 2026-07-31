export type SessionState =
  | "draft"
  | "queued"
  | "generating"
  | "ready"
  | "approved"
  | "failed"
  | "cancelled";

export type AttemptState =
  | "queued"
  | "generating"
  | "ready"
  | "failed"
  | "cancelled";

export type ViewKind =
  | "front"
  | "left"
  | "right"
  | "rear"
  | "front_three_quarter";

export const ORDERED_VIEW_KINDS: readonly ViewKind[] = [
  "front",
  "left",
  "right",
  "rear",
  "front_three_quarter",
] as const;

export type InputMode = "text" | "photo";
export type ReportStatus = "pass" | "warn" | "fail";
export type ScaleConfidence = "unknown" | "declared" | "calibrated";

export interface ReferenceSessionRecord {
  id: number;
  session_uuid: string;
  owner_id: string;
  input_mode: InputMode;
  subject_class: string;
  prompt: string | null;
  source_asset_id: number | null;
  source_asset_version_id: number | null;
  state: SessionState;
  current_attempt_id: number | null;
  approved_attempt_id: number | null;
  /** Attempts consumed for the currently uploaded source; replacement resets it. */
  source_attempt_count: number;
  /** Monotonic lifetime attempt count; also supplies the next attempt number. */
  retry_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface ReferenceAttemptRecord {
  id: number;
  session_id: number;
  attempt_number: number;
  idempotency_key: string;
  provider: string;
  model: string;
  prompt_config_hash: string;
  retry_notes: string | null;
  state: AttemptState;
  failure_code: string | null;
  error_message: string | null;
  started_at: Date;
  completed_at: Date | null;
}

export interface ReferenceViewRecord {
  id: number;
  attempt_id: number;
  view_kind: ViewKind;
  asset_id: number;
  asset_version_id: number;
  width_px: number;
  height_px: number;
  is_synthesized: boolean;
  created_at: Date;
}

export interface ReferenceReportRecord {
  id: number;
  attempt_id: number;
  report_asset_id: number | null;
  report_asset_version_id: number | null;
  status: ReportStatus;
  scale_confidence: ScaleConfidence;
  report_hash: string;
  metrics_json: Record<string, any> | null;
  created_at: Date;
}

export interface ReferenceApprovalRecord {
  id: number;
  session_id: number;
  attempt_id: number;
  manifest_asset_id: number | null;
  manifest_asset_version_id: number | null;
  manifest_hash: string;
  approved_by_user: string;
  created_at: Date;
}

export interface ViewItemPublic {
  viewKind: ViewKind;
  assetUuid: string;
  versionNumber: number;
  widthPx: number;
  heightPx: number;
  isSynthesized: boolean;
  signedUrl: string;
}

export interface ReportPublic {
  status: ReportStatus;
  scaleConfidence: ScaleConfidence;
  reportHash: string;
  metrics: Record<string, any> | null;
}

export interface SessionPublic {
  sessionUuid: string;
  ownerId: string;
  inputMode: InputMode;
  subjectClass: string;
  prompt: string | null;
  state: SessionState;
  currentAttemptNumber: number | null;
  approvedAttemptNumber: number | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  views: ViewItemPublic[];
  report: ReportPublic | null;
  manifestHash: string | null;
  approvedAt: string | null;
}

export interface GeneratedViewPayload {
  viewKind: ViewKind;
  imageBuffer: Buffer;
  mimeType: string;
  widthPx: number;
  heightPx: number;
  isSynthesized: boolean;
}

export interface ProviderGenerationResult {
  provider: string;
  model: string;
  views: GeneratedViewPayload[];
}
