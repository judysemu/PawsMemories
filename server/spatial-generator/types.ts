// ─── Job States ───────────────────────────────────────────────────────────────
export type SpatialJobState =
  | "draft"
  | "observing"
  | "planning"
  | "awaiting_math_worker"
  | "validating_math"
  | "building_draft"
  | "verifying_draft"
  | "awaiting_human_review"
  | "correction_requested"
  | "approved"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_JOB_STATES: readonly SpatialJobState[] = [
  "completed",
  "failed",
  "cancelled",
] as const;

export const REFUNDABLE_FAILURE_STATES: readonly SpatialJobState[] = [
  "failed",
] as const;

// ─── Attempt States ───────────────────────────────────────────────────────────
export type SpatialAttemptState =
  | "queued"
  | "observing"
  | "planning"
  | "awaiting_math"
  | "validating_math"
  | "compiling"
  | "building_draft"
  | "verifying_draft"
  | "awaiting_review"
  | "correction_requested"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

// ─── Artifact Roles ───────────────────────────────────────────────────────────
export type SpatialArtifactRole =
  | "reference_front"
  | "reference_right"
  | "reference_back"
  | "reference_left"
  | "draft_glb"
  | "draft_render_front"
  | "draft_render_right"
  | "draft_render_back"
  | "draft_render_left"
  | "draft_render_three_quarter"
  | "final_glb"
  | "final_stl"
  | "manufacturing_report";

// ─── Configuration ────────────────────────────────────────────────────────────
export const MAX_CORRECTION_ATTEMPTS = 3;
export const MAX_GLB_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
export const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_POLL_ATTEMPTS = 120;
export const POLL_INTERVAL_MS = 5000;
export const POLL_JITTER_MS = 1000;
export const PROVIDER_CONNECT_TIMEOUT_MS = 30_000;
export const PROVIDER_READ_TIMEOUT_MS = 120_000;
export const GLB_MAGIC = 0x46546C67; // "glTF" little-endian

// ─── Deterministic Math Limits (matching INHOUSE_SPATIAL_GENERATOR_ARCHITECTURE.md) ─────
export const MATH_LIMITS = {
  MAX_PRIMITIVES: 40,
  MAX_DRAFT_VERTICES: 250_000,
  MAX_FINAL_VERTICES: 1_000_000,
  MAX_BOOLEAN_OPS: 64,
  MAX_COORDINATE_MM: 5000,
  MIN_DIMENSION_MM: 0.1,
  MAX_DIMENSION_MM: 5000,
  MIN_WALL_THICKNESS_MM: 1.2,
  MATH_TOLERANCE_MM: 0.05,
} as const;

// ─── Database Records ─────────────────────────────────────────────────────────
export interface SpatialJobRecord {
  id: number;
  job_uuid: string;
  owner_phone: string;
  subject_kind: "accessory" | "hard_surface";
  target_use: "digital" | "attachment" | "print";
  state: SpatialJobState;
  current_attempt_id: number | null;
  credits_reserved: number;
  credits_disposition: "reserved" | "charged" | "refunded" | "none";
  idempotency_key: string;
  failure_code: string | null;
  failure_detail: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SpatialInputRecord {
  id: number;
  job_id: number;
  prompt: string;
  target_envelope_mm: Record<string, unknown>;
  scale_anchor: Record<string, unknown> | null;
  attachment_interface: Record<string, unknown> | null;
  reference_asset_version_ids: number[];
  input_hash: string;
  created_at: Date;
}

export interface SpatialAttemptRecord {
  id: number;
  job_id: number;
  attempt_number: number;
  state: SpatialAttemptState;
  observation_json: Record<string, unknown> | null;
  observation_hash: string | null;
  plan_json: Record<string, unknown> | null;
  plan_hash: string | null;
  math_json: Record<string, unknown> | null;
  math_hash: string | null;
  compiled_program_hash: string | null;
  automated_report_json: Record<string, unknown> | null;
  automated_report_hash: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_heartbeat_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  failure_code: string | null;
  error_message: string | null;
  created_at: Date;
}

export interface SpatialArtifactRecord {
  id: number;
  attempt_id: number;
  asset_id: number;
  asset_version_id: number;
  role: SpatialArtifactRole;
  computed_hash: string;
  size_bytes: number;
  mime_type: string;
  created_at: Date;
}

export interface SpatialReviewRecord {
  id: number;
  job_id: number;
  attempt_id: number;
  attempt_hash: string;
  report_hash: string;
  owner_phone: string;
  decision: "approve" | "request_correction";
  correction_tags: string[];
  comment: string | null;
  actor_audit_hash: string;
  created_at: Date;
}

export interface SpatialEventRecord {
  id: number;
  event_uuid: string;
  job_id: number;
  attempt_id: number | null;
  event_type: string;
  payload_json: Record<string, unknown>;
  payload_hash: string;
  created_at: Date;
}

// ─── Public DTOs (never include object_key, raw provider URLs, or internal IDs) ────────
export interface SpatialJobPublic {
  jobUuid: string;
  ownerPhone: string;
  subjectKind: "accessory" | "hard_surface";
  targetUse: "digital" | "attachment" | "print";
  state: SpatialJobState;
  currentAttemptNumber: number | null;
  creditsReserved: number;
  creditsDisposition: "reserved" | "charged" | "refunded" | "none";
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpatialAttemptPublic {
  attemptNumber: number;
  state: SpatialAttemptState;
  observationHash: string | null;
  planHash: string | null;
  mathHash: string | null;
  compiledProgramHash: string | null;
  automatedReportHash: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failureCode: string | null;
}

export interface SpatialArtifactPublic {
  role: SpatialArtifactRole;
  assetUuid: string;
  versionNumber: number;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  signedUrl?: string;
}

export interface SpatialReviewPublic {
  reviewId: number;
  attemptNumber: number;
  decision: "approve" | "request_correction";
  correctionTags: string[];
  comment: string | null;
  createdAt: string;
}

export interface SpatialEventPublic {
  eventUuid: string;
  attemptNumber: number | null;
  eventType: string;
  createdAt: string;
}

export interface SpatialQuotePublic {
  subjectKind: "accessory" | "hard_surface";
  targetUse: "digital" | "attachment" | "print";
  estimatedCredits: number;
  currentBalance: number;
  sufficientBalance: boolean;
  preflightPassed: boolean;
  preflightErrors: string[];
}

export interface SpatialPreflightResult {
  passed: boolean;
  errors: string[];
  quotedCredits: number;
  pricingKey: string;
  currentBalance: number;
}

// ─── Layer8 Operation Contracts (for internal use) ────────────────────────────
export interface SpatialObserveInput {
  referenceAssetVersionIds: number[];
  scaleAnchor: { axis: "x" | "y" | "z"; millimeters: number; label: string } | null;
}

export interface SpatialObserveOutput {
  subjectClass: string;
  summary: string;
  viewCount: number;
  viewLabels: string[];
  features: Array<{
    name: string;
    confidence: number;
    normalizedBounds: { min: number[]; max: number[] };
    viewIndices: number[];
  }>;
  scaleEvidence: { hasAnchor: boolean; uncertainty: number };
  occlusions: Array<{ region: string; description: string }>;
  observationHash: string;
}

export interface SpatialPlanInput {
  observation: SpatialObserveOutput;
  userPrompt: string;
  targetEnvelopeMm: { x: number; y: number; z: number };
  scaleAnchor: { axis: "x" | "y" | "z"; millimeters: number; label: string } | null;
  attachmentInterface: { targetAssetVersionId: number; clearanceMm: number } | null;
}

export interface SpatialPlanOutput {
  planHash: string;
  targetEnvelopeMm: { x: number; y: number; z: number };
  primitives: Array<{
    id: string;
    type: "box" | "cylinder" | "uv_sphere" | "cone" | "torus" | "capsule";
    role: "additive" | "subtractive";
    normalizedSize: { x: number; y: number; z: number };
    normalizedPosition: { x: number; y: number; z: number };
    rotationDeg: { x: number; y: number; z: number };
    symmetryAxis?: "x" | "y" | "z";
    bevel?: { width: number; segments: number };
    curveSweep?: { controlPoints: number[][]; segments: number };
    array?: { count: number; spacing: number; axis: "x" | "y" | "z" };
    constraints: {
      minimumWallMm: number;
      clearanceMm?: number;
    };
    materialIntent?: { color?: string; roughness?: number; metalness?: number };
  }>;
  manufacturingIntent?: "digital" | "attachment" | "print";
}

export interface SpatialMathInput {
  planHash: string;
  envelopeMm: { x: number; y: number; z: number };
  minimumWallMm: number;
  primitives: SpatialPlanOutput["primitives"];
  constraints: SpatialPlanOutput["primitives"][0]["constraints"][];
}

export interface SpatialMathOutput {
  schemaVersion: "pawsome.spatial-math.v1";
  planHash: string;
  units: "mm";
  resolvedPrimitives: Array<{
    id: string;
    dimensionsMm: { x: number; y: number; z: number };
    positionMm: { x: number; y: number; z: number };
    rotationDeg: { x: number; y: number; z: number };
  }>;
  derived: {
    boundsMinMm: { x: number; y: number; z: number };
    boundsMaxMm: { x: number; y: number; z: number };
    estimatedVolumeMm3: number;
  };
  calculations: string[];
}

export interface SpatialVerifyInput {
  observation: SpatialObserveOutput;
  draftRenderAssetVersions: number[]; // 5 views
  attemptHash: string;
}

export interface SpatialVerifyOutput {
  scores: {
    silhouette: number;
    proportion: number;
    featurePresence: number;
    viewConsistency: number;
  };
  criticalIssues: Array<{
    code: string;
    view: string;
    confidence: number;
    detail: string;
  }>;
  automatedPass: boolean;
  reportHash: string;
}