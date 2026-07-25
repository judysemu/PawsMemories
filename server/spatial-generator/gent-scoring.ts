import crypto from "node:crypto";

/**
 * GENT-style Sustained-Condition Scoring Controller
 * 
 * Deterministic scoring for eligible generative stages only.
 * Does NOT apply to: deterministic math, schema validation, Blender compilation,
 * geometry checks, billing, hashing, or state transitions.
 */

export const GENT_SCORING_VERSION = "pawsome.gent-scoring.v1";

export interface GentStageResult {
  stage: "observe" | "plan" | "verify";
  schemaValid: boolean;
  samplingTemperature: number;           // 0-1, from provider config
  uncertainty: number;                   // 0-1, from model output
  evidenceDivergence: number;            // 0-1, from cross-view consistency
  schemaRepairRatio: number;             // 0-1, ratio of schema repairs needed
  baseEvidenceQualityScore: number;      // 0-100, from validation metrics
  objectiveImprovement: number;          // delta from previous attempt, -1 to 1
}

export interface GentEpisodeState {
  episodeId: string;
  condition: "high_heat" | "cold_stress" | "favorable_growth" | "neutral";
  consecutiveCount: number;
  lastCrossingEvent: string | null;
  adjustmentAccumulator: number;  // Total cascade adjustment from episodes
}

export interface GentScoringResult {
  schemaVersion: string;
  stage: GentStageResult["stage"];
  effectiveTemperature: number;
  baseEvidenceQualityScore: number;
  cascadeAdjustment: number;
  finalQualityScore: number;
  routing: "human_review" | "structured_correction" | "reject_to_planning";
  episodeState: GentEpisodeState;
  thresholdEvents: Array<{
    eventType: "high_heat_threshold" | "cold_stress_threshold" | "favorable_growth_threshold";
    consecutiveCount: number;
    adjustment: number;
    timestamp: string;
  }>;
  reportHash: string;
}

const HIGH_HEAT_THRESHOLD = 28;
const COLD_STRESS_TEMP_THRESHOLD = 4;
const COLD_STRESS_IMPROVEMENT_THRESHOLD = 0.01;
const FAVORABLE_MIN_TEMP = 16;
const FAVORABLE_MAX_TEMP = 28;
const FAVORABLE_IMPROVEMENT_THRESHOLD = 0.01;

const HIGH_HEAT_CONSECUTIVE_FOR_PENALTY = 6;
const HIGH_HEAT_PENALTY = -20;
const COLD_STRESS_CONSECUTIVE_FOR_PENALTY = 2;
const COLD_STRESS_PENALTY = -10;
const FAVORABLE_CONSECUTIVE_FOR_BONUS = 6;
const FAVORABLE_BONUS = +20;

const ROUTING_HUMAN_REVIEW_MIN = 85;
const ROUTING_STRUCTURED_CORRECTION_MIN = 65;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function classifyCondition(
  effectiveTemperature: number,
  objectiveImprovement: number,
  schemaValid: boolean
): "high_heat" | "cold_stress" | "favorable_growth" | "neutral" {
  if (effectiveTemperature >= HIGH_HEAT_THRESHOLD) {
    return "high_heat";
  }
  if (effectiveTemperature <= COLD_STRESS_TEMP_THRESHOLD && objectiveImprovement < COLD_STRESS_IMPROVEMENT_THRESHOLD) {
    return "cold_stress";
  }
  if (
    effectiveTemperature >= FAVORABLE_MIN_TEMP &&
    effectiveTemperature < FAVORABLE_MAX_TEMP &&
    schemaValid &&
    objectiveImprovement >= FAVORABLE_IMPROVEMENT_THRESHOLD
  ) {
    return "favorable_growth";
  }
  return "neutral";
}

function updateEpisodeState(
  currentState: GentEpisodeState,
  newCondition: "high_heat" | "cold_stress" | "favorable_growth" | "neutral"
): { newState: GentEpisodeState; thresholdEvent: GentScoringResult["thresholdEvents"][0] | null } {
  // If condition changed, reset episode
  if (newCondition !== currentState.condition) {
    const newState: GentEpisodeState = {
      ...currentState,
      episodeId: crypto.randomUUID(),
      condition: newCondition,
      consecutiveCount: newCondition === "neutral" ? 0 : 1,
      lastCrossingEvent: null,
    };
    return { newState, thresholdEvent: null };
  }

  // Same condition - increment count
  const newConsecutiveCount = currentState.consecutiveCount + (newCondition === "neutral" ? 0 : 1);
  const newState: GentEpisodeState = {
    ...currentState,
    consecutiveCount: newConsecutiveCount,
  };

  // Check for threshold crossings (only once per episode via latch)
  let thresholdEvent: GentScoringResult["thresholdEvents"][0] | null = null;
  let adjustment = 0;

  if (newCondition === "high_heat" && newConsecutiveCount === HIGH_HEAT_CONSECUTIVE_FOR_PENALTY) {
    adjustment = HIGH_HEAT_PENALTY;
    thresholdEvent = {
      eventType: "high_heat_threshold",
      consecutiveCount: newConsecutiveCount,
      adjustment,
      timestamp: new Date().toISOString(),
    };
    newState.adjustmentAccumulator += adjustment;
    newState.lastCrossingEvent = "high_heat_threshold";
  } else if (newCondition === "cold_stress" && newConsecutiveCount === COLD_STRESS_CONSECUTIVE_FOR_PENALTY) {
    adjustment = COLD_STRESS_PENALTY;
    thresholdEvent = {
      eventType: "cold_stress_threshold",
      consecutiveCount: newConsecutiveCount,
      adjustment,
      timestamp: new Date().toISOString(),
    };
    newState.adjustmentAccumulator += adjustment;
    newState.lastCrossingEvent = "cold_stress_threshold";
  } else if (newCondition === "favorable_growth" && newConsecutiveCount === FAVORABLE_CONSECUTIVE_FOR_BONUS) {
    adjustment = FAVORABLE_BONUS;
    thresholdEvent = {
      eventType: "favorable_growth_threshold",
      consecutiveCount: newConsecutiveCount,
      adjustment,
      timestamp: new Date().toISOString(),
    };
    newState.adjustmentAccumulator += adjustment;
    newState.lastCrossingEvent = "favorable_growth_threshold";
  }

  return { newState, thresholdEvent };
}

function computeRouting(finalQualityScore: number): GentScoringResult["routing"] {
  if (finalQualityScore >= ROUTING_HUMAN_REVIEW_MIN) return "human_review";
  if (finalQualityScore >= ROUTING_STRUCTURED_CORRECTION_MIN) return "structured_correction";
  return "reject_to_planning";
}

function computeReportHash(
  schemaVersion: string,
  stage: GentStageResult["stage"],
  effectiveTemperature: number,
  baseEvidenceQualityScore: number,
  cascadeAdjustment: number,
  finalQualityScore: number,
  routing: GentScoringResult["routing"],
  episodeState: GentEpisodeState,
  thresholdEvents: GentScoringResult["thresholdEvents"]
): string {
  const payload = {
    schemaVersion,
    stage,
    effectiveTemperature,
    baseEvidenceQualityScore,
    cascadeAdjustment,
    finalQualityScore,
    routing,
    episodeState,
    thresholdEvents,
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Main entry point: score a single eligible generative stage output.
 * Must be called sequentially for each stage output in a job attempt.
 * State is persisted externally (in the attempt record) and passed in.
 */
export function scoreGenerativeStage(
  stageResult: GentStageResult,
  previousEpisodeState: GentEpisodeState | null
): GentScoringResult {
  // Compute effective temperature
  const weightedSum =
    0.45 * stageResult.samplingTemperature +
    0.20 * stageResult.uncertainty +
    0.20 * stageResult.evidenceDivergence +
    0.15 * stageResult.schemaRepairRatio;

  const effectiveTemperature = 30 * clamp(weightedSum, 0, 1);

  // Classify condition (schemaValidates schemaValid gate for favorable_growth)
  const condition = classifyCondition(
    effectiveTemperature,
    stageResult.objectiveImprovement,
    stageResult.schemaValid
  );

  // Initialize or update episode state
  let episodeState: GentEpisodeState = previousEpisodeState || {
    episodeId: crypto.randomUUID(),
    condition: "neutral",
    consecutiveCount: 0,
    lastCrossingEvent: null,
    adjustmentAccumulator: 0,
  };

  const { newState, thresholdEvent } = updateEpisodeState(episodeState, condition);
  episodeState = newState;

  // Compute cascade adjustment (accumulated from all episodes)
  const cascadeAdjustment = episodeState.adjustmentAccumulator;

  // Compute final quality score
  const finalQualityScore = clamp(
    stageResult.baseEvidenceQualityScore + cascadeAdjustment,
    0,
    100
  );

  // Determine routing
  const routing = computeRouting(finalQualityScore);

  // Build threshold events array
  const thresholdEvents: GentScoringResult["thresholdEvents"] = [];
  if (thresholdEvent) {
    thresholdEvents.push(thresholdEvent);
  }

  // Compute report hash
  const reportHash = computeReportHash(
    GENT_SCORING_VERSION,
    stageResult.stage,
    effectiveTemperature,
    stageResult.baseEvidenceQualityScore,
    cascadeAdjustment,
    finalQualityScore,
    routing,
    episodeState,
    thresholdEvents
  );

  return {
    schemaVersion: GENT_SCORING_VERSION,
    stage: stageResult.stage,
    effectiveTemperature,
    baseEvidenceQualityScore: stageResult.baseEvidenceQualityScore,
    cascadeAdjustment,
    finalQualityScore,
    routing,
    episodeState,
    thresholdEvents,
    reportHash,
  };
}

/**
 * Create initial episode state for a new attempt
 */
export function createInitialEpisodeState(): GentEpisodeState {
  return {
    episodeId: crypto.randomUUID(),
    condition: "neutral",
    consecutiveCount: 0,
    lastCrossingEvent: null,
    adjustmentAccumulator: 0,
  };
}

/**
 * Validate that a stored GENT scoring report can be reparsed
 * through strict schema before human approval.
 */
export function validateGentReport(report: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!report || typeof report !== "object") {
    return { valid: false, errors: ["Report is not an object"] };
  }

  const r = report as Record<string, unknown>;

  if (r.schemaVersion !== GENT_SCORING_VERSION) {
    errors.push(`Invalid schemaVersion: expected ${GENT_SCORING_VERSION}, got ${r.schemaVersion}`);
  }

  if (typeof r.effectiveTemperature !== "number" || !Number.isFinite(r.effectiveTemperature)) {
    errors.push("effectiveTemperature must be a finite number");
  }

  if (typeof r.baseEvidenceQualityScore !== "number" || !Number.isFinite(r.baseEvidenceQualityScore)) {
    errors.push("baseEvidenceQualityScore must be a finite number");
  }

  if (typeof r.cascadeAdjustment !== "number" || !Number.isFinite(r.cascadeAdjustment)) {
    errors.push("cascadeAdjustment must be a finite number");
  }

  if (typeof r.finalQualityScore !== "number" || !Number.isFinite(r.finalQualityScore)) {
    errors.push("finalQualityScore must be a finite number");
  } else {
    const fqs = r.finalQualityScore as number;
    if (fqs < 0 || fqs > 100) {
      errors.push("finalQualityScore must be clamped to [0, 100]");
    }
  }

  if (!["human_review", "structured_correction", "reject_to_planning"].includes(r.routing as string)) {
    errors.push("routing must be one of: human_review, structured_correction, reject_to_planning");
  }

  if (!r.episodeState || typeof r.episodeState !== "object") {
    errors.push("episodeState is required");
  }

  if (!Array.isArray(r.thresholdEvents)) {
    errors.push("thresholdEvents must be an array");
  }

  if (typeof r.reportHash !== "string" || !/^[a-f0-9]{64}$/i.test(r.reportHash)) {
    errors.push("reportHash must be a valid SHA-256 hex string");
  }

  return { valid: errors.length === 0, errors };
}