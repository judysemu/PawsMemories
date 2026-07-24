import { z } from "zod";
import type { SpatialObserveOutput, SpatialPlanOutput, SpatialMathInput, SpatialMathOutput, SpatialVerifyOutput } from "./types";
import {
  SpatialObserveOutputSchema,
  SpatialPlanSchema,
  SpatialMathOutputSchema,
  SpatialVerifyOutputSchema,
} from "./schemas";

const LAYER8_BASE = process.env.LAYER8_BASE_URL || "";
const LAYER8_API_KEY = process.env.LAYER8_TENANT_API_KEY || "";
const LAYER8_TIMEOUT = Number(process.env.LAYER8_SPATIAL_TIMEOUT_MS || 30000);

export class Layer8Error extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "Layer8Error";
  }
}

async function layer8Request<T>(
  path: string,
  payload: unknown,
  responseSchema: z.ZodSchema<T>,
): Promise<T> {
  if (!LAYER8_BASE || !LAYER8_API_KEY) {
    throw new Layer8Error("NOT_CONFIGURED", "Layer8 not configured", false);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LAYER8_TIMEOUT);

  try {
    const response = await fetch(`${LAYER8_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LAYER8_API_KEY}`,
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "error",
    });

    clearTimeout(timeout);

    if (response.status === 429) {
      throw new Layer8Error("RATE_LIMITED", "Layer8 rate limit exceeded", true);
    }
    if (response.status >= 500) {
      throw new Layer8Error("UPSTREAM_ERROR", "Layer8 upstream error", true);
    }
    if (!response.ok) {
      throw new Layer8Error("UPSTREAM_ERROR", `Layer8 error: ${response.status}`, true);
    }

    const data = await response.json();
    const parsed = responseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Layer8Error("INVALID_RESPONSE", "Layer8 response schema validation failed", false);
    }
    return parsed.data;
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Layer8Error) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Layer8Error("TIMEOUT", "Layer8 request timed out", true);
    }
    throw new Layer8Error("NETWORK_ERROR", `Layer8 request failed: ${error}`, true);
  }
}

// ─── spatial.observe.v1 ──────────────────────────────────────────────────────

export async function observeReferences(
  referenceAssetVersionIds: number[],
  scaleAnchor: { axis: "x" | "y" | "z"; millimeters: number; label: string } | null,
): Promise<SpatialObserveOutput> {
  const result = await layer8Request(
    "/v1/spatial/observe",
    {
      referenceAssetVersionIds,
      scaleAnchor,
    },
    SpatialObserveOutputSchema,
  );
  return result;
}

// ─── spatial.plan.v1 ─────────────────────────────────────────────────────────

export async function generatePlan(
  observation: SpatialObserveOutput,
  userPrompt: string,
  targetEnvelopeMm: { x: number; y: number; z: number },
  scaleAnchor: { axis: "x" | "y" | "z"; millimeters: number; label: string } | null,
  attachmentInterface: { targetAssetVersionId: number; clearanceMm: number } | null,
): Promise<SpatialPlanOutput> {
  const result = await layer8Request(
    "/v1/spatial/plan",
    {
      observation,
      userPrompt,
      targetEnvelopeMm,
      scaleAnchor,
      attachmentInterface,
    },
    SpatialPlanSchema,
  );
  return result;
}

// ─── spatial.math.v1 ──────────────────────────────────────────────────────────

export async function executeMath(input: SpatialMathInput): Promise<SpatialMathOutput> {
  const result = await layer8Request(
    "/v1/spatial/math",
    input,
    SpatialMathOutputSchema,
  );
  return result;
}

// ─── spatial.verify.v1 ────────────────────────────────────────────────────────

export async function verifyDraft(
  observation: SpatialObserveOutput,
  draftRenderAssetVersions: number[],
  attemptHash: string,
): Promise<SpatialVerifyOutput> {
  const result = await layer8Request(
    "/v1/spatial/verify",
    {
      observation,
      draftRenderAssetVersions,
      attemptHash,
    },
    SpatialVerifyOutputSchema,
  );
  return result;
}

// ─── Health Check ─────────────────────────────────────────────────────────────

export async function checkLayer8Health(): Promise<{
  spatialObserve: boolean;
  spatialPlan: boolean;
  spatialMath: boolean;
  spatialVerify: boolean;
}> {
  if (!LAYER8_BASE || !LAYER8_API_KEY) {
    return { spatialObserve: false, spatialPlan: false, spatialMath: false, spatialVerify: false };
  }

  try {
    const response = await fetch(`${LAYER8_BASE}/health`, {
      headers: { Authorization: `Bearer ${LAYER8_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { spatialObserve: false, spatialPlan: false, spatialMath: false, spatialVerify: false };
    const data = await response.json();
    return {
      spatialObserve: data.spatial_observe === "healthy",
      spatialPlan: data.spatial_plan === "healthy",
      spatialMath: data.spatial_math === "healthy",
      spatialVerify: data.spatial_verify === "healthy",
    };
  } catch {
    return { spatialObserve: false, spatialPlan: false, spatialMath: false, spatialVerify: false };
  }
}