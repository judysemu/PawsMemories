/**
 * server/paidApiGuards.ts — H2/H7 hardening for the paid AR endpoints
 * (`/api/pets/classify`, `/api/pets/:id/rig`, `/api/ar/semantic-scan`) plus
 * the shared Gemini/Imagen image-output call boundary.
 *
 * Pure config logic only: kill-switches + per-user, aggregate daily, cost, and
 * shared-image minute budgets derived from env.
 * No DB or express imports, so it is unit-testable in isolation. The daily
 * and minute atomic reservation lives in `db.ts` (`reservePaidUsage`); HTTP
 * 503/429 mapping lives at each consuming route boundary.
 *
 * Env contract:
 *   PETSIM_PAID_APIS_ENABLED   master kill-switch for all four (default: on)
 *   PETSIM_CLASSIFY_ENABLED    per-endpoint switch (default: on)
 *   PETSIM_SEMANTIC_SCAN_ENABLED per-endpoint switch (default: on)
 *   PETSIM_IMAGE_GENERATION_ENABLED image-output switch (default: on)
 *   PETSIM_RIG_ENABLED         per-endpoint switch (default: OFF, historical)
 *   PETSIM_CLASSIFY_DAILY_CAP  per-user/day cap (default: 25)
 *   PETSIM_RIG_DAILY_CAP       per-user/day cap (default: 5)
 *   PETSIM_SEMANTIC_SCAN_DAILY_CAP per-user/day cap (default: 50)
 *   PETSIM_IMAGE_GENERATION_DAILY_CAP per-user/day provider-call cap (default: 5)
 *   PETSIM_IMAGE_GENERATION_GLOBAL_MINUTE_CALL_CAP shared provider calls/minute (default: 10)
 *   PETSIM_<ENDPOINT>_GLOBAL_DAILY_CAP aggregate request cap
 *   PETSIM_<ENDPOINT>_ESTIMATED_COST_MICRO_USD reserved cost per provider call
 *   PETSIM_<ENDPOINT>_GLOBAL_DAILY_COST_MICRO_USD aggregate reserved-cost cap
 */

export type PaidEndpoint = "classify" | "rig" | "semantic_scan" | "image_generation";

export const PAID_ENDPOINTS: PaidEndpoint[] = ["classify", "rig", "semantic_scan", "image_generation"];

type Env = Record<string, string | undefined>;

/** Uppercase env token for each endpoint (used to build flag/cap keys). */
const ENV_TOKEN: Record<PaidEndpoint, string> = {
  classify: "CLASSIFY",
  rig: "RIG",
  semantic_scan: "SEMANTIC_SCAN",
  image_generation: "IMAGE_GENERATION",
};

/** Default per-user, per-day request caps. */
const DEFAULT_DAILY_CAPS: Record<PaidEndpoint, number> = {
  classify: 25,
  rig: 5,
  semantic_scan: 50,
  image_generation: 5,
};

/** Conservative aggregate request ceilings. Rig remains closed by default. */
const DEFAULT_GLOBAL_DAILY_CAPS: Record<PaidEndpoint, number> = {
  classify: 250,
  rig: 0,
  semantic_scan: 500,
  image_generation: 50,
};

/** Upper-bound cost reservations in millionths of one US dollar. */
const DEFAULT_ESTIMATED_COST_MICRO_USD: Record<PaidEndpoint, number> = {
  classify: 10_000,
  rig: 1_000_000,
  semantic_scan: 10_000,
  image_generation: 1_000_000,
};

/** Aggregate daily reserved-cost ceilings in millionths of one US dollar. */
const DEFAULT_GLOBAL_DAILY_COST_MICRO_USD: Record<PaidEndpoint, number> = {
  classify: 2_500_000,
  rig: 0,
  semantic_scan: 5_000_000,
  image_generation: 50_000_000,
};

/**
 * Shared image generation gets ten actual provider attempts per minute, leaving
 * headroom below the observed 20 RPM Nano Banana Pro quota. The dedicated
 * Tripo reference-view generator uses its own provider task and independent cap;
 * the two counters must not be represented as one atomic combined ceiling.
 */
const DEFAULT_IMAGE_GENERATION_GLOBAL_MINUTE_CALL_CAP = 10;

/** Per-endpoint default for the enable flag. Rig stays off by default (historical). */
const DEFAULT_ENABLED: Record<PaidEndpoint, boolean> = {
  classify: true,
  rig: false,
  semantic_scan: true,
  image_generation: true,
};

/**
 * Parse a boolean-ish env flag. Truthy: 1/true/yes/on. Falsy: 0/false/no/off.
 * Empty / undefined / unrecognised returns the supplied default.
 */
export function parseBoolFlag(raw: string | undefined, dflt: boolean): boolean {
  if (raw == null) return dflt;
  const v = String(raw).trim().toLowerCase();
  if (v === "") return dflt;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return dflt;
}

/**
 * Per-user daily cap for an endpoint. A non-negative integer; 0 effectively
 * disables the endpoint via the cap. Invalid/negative overrides fall back to
 * the built-in default.
 */
export function dailyCapFor(ep: PaidEndpoint, env: Env = process.env): number {
  const raw = env[`PETSIM_${ENV_TOKEN[ep]}_DAILY_CAP`];
  const n = raw == null || String(raw).trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY_CAPS[ep];
}

function nonNegativeInteger(raw: string | undefined, fallback: number): number {
  const n = raw == null || String(raw).trim() === "" ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const n = raw == null || String(raw).trim() === "" ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Aggregate request cap across all users for this endpoint and UTC database day. */
export function globalDailyCapFor(ep: PaidEndpoint, env: Env = process.env): number {
  return nonNegativeInteger(
    env[`PETSIM_${ENV_TOKEN[ep]}_GLOBAL_DAILY_CAP`],
    DEFAULT_GLOBAL_DAILY_CAPS[ep],
  );
}

/** Cost reserved before one provider call, expressed as integer micro-USD. */
export function estimatedCostMicroUsdFor(ep: PaidEndpoint, env: Env = process.env): number {
  return positiveInteger(
    env[`PETSIM_${ENV_TOKEN[ep]}_ESTIMATED_COST_MICRO_USD`],
    DEFAULT_ESTIMATED_COST_MICRO_USD[ep],
  );
}

/** Aggregate daily cost ceiling, expressed as integer micro-USD. */
export function globalDailyCostMicroUsdFor(ep: PaidEndpoint, env: Env = process.env): number {
  return nonNegativeInteger(
    env[`PETSIM_${ENV_TOKEN[ep]}_GLOBAL_DAILY_COST_MICRO_USD`],
    DEFAULT_GLOBAL_DAILY_COST_MICRO_USD[ep],
  );
}

/** Durable shared-image provider-call ceiling. Other paid endpoints have none. */
export function globalMinuteCallCapFor(
  ep: PaidEndpoint,
  env: Env = process.env,
): number | undefined {
  if (ep !== "image_generation") return undefined;
  return nonNegativeInteger(
    env.PETSIM_IMAGE_GENERATION_GLOBAL_MINUTE_CALL_CAP,
    DEFAULT_IMAGE_GENERATION_GLOBAL_MINUTE_CALL_CAP,
  );
}

export interface PaidUsageLimits {
  userDailyCap: number;
  globalDailyCap: number;
  globalMinuteCallCap?: number;
  estimatedCostMicroUsd: number;
  globalDailyCostMicroUsd: number;
}

export type PaidUsageDenialReason =
  | "user_cap"
  | "global_cap"
  | "global_minute_cap"
  | "global_cost_cap";

export interface PaidUsageReservation {
  allowed: boolean;
  reason?: PaidUsageDenialReason;
  userCount: number;
  globalCount: number;
  globalMinuteCount?: number;
  globalReservedCostMicroUsd: number;
}

export function paidUsageLimitsFor(ep: PaidEndpoint, env: Env = process.env): PaidUsageLimits {
  const globalMinuteCallCap = globalMinuteCallCapFor(ep, env);
  return {
    userDailyCap: dailyCapFor(ep, env),
    globalDailyCap: globalDailyCapFor(ep, env),
    ...(globalMinuteCallCap == null ? {} : { globalMinuteCallCap }),
    estimatedCostMicroUsd: estimatedCostMicroUsdFor(ep, env),
    globalDailyCostMicroUsd: globalDailyCostMicroUsdFor(ep, env),
  };
}

/**
 * Kill-switch: an endpoint is enabled when the master switch is on AND the
 * per-endpoint switch is on. Master defaults on; per-endpoint defaults per
 * DEFAULT_ENABLED (rig off, others on).
 */
export function isEndpointEnabled(ep: PaidEndpoint, env: Env = process.env): boolean {
  if (!parseBoolFlag(env.PETSIM_PAID_APIS_ENABLED, true)) return false;
  return parseBoolFlag(env[`PETSIM_${ENV_TOKEN[ep]}_ENABLED`], DEFAULT_ENABLED[ep]);
}

/**
 * Whether a request is within the daily cap. `countAfterBump` is the 1-based
 * usage count returned after incrementing (so the Nth request has count N and
 * is allowed while N <= cap).
 */
export function withinDailyCap(
  ep: PaidEndpoint,
  countAfterBump: number,
  env: Env = process.env,
): boolean {
  return countAfterBump <= dailyCapFor(ep, env);
}
