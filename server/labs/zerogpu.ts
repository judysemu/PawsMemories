/**
 * Client for a Hugging Face ZeroGPU Space.
 *
 * ZeroGPU is a shared pool that allocates a GPU only for the duration of a
 * decorated function call, which makes it a good fit for burst workloads that
 * cannot justify a dedicated GPU. It comes with constraints that shape every
 * decision in this file:
 *
 *   - ZeroGPU Spaces are Gradio-SDK only. A custom FastAPI/CUDA container --
 *     which is what trellis-worker/ is -- cannot be deployed there. The GPU
 *     side must be a Gradio Space exposing named endpoints.
 *   - GPU time is a hard daily quota, not a rate limit: 40 minutes/day on PRO,
 *     5 on a free account, 2 unauthenticated. Overage bills at $1 per 10
 *     minutes against pre-paid credits.
 *   - A call is bounded by the Space's own @spaces.GPU(duration=...) ceiling.
 *
 * The quota is why this client never retries a call that actually reached the
 * GPU. A blind retry of a 90-second job burns three minutes of a forty-minute
 * day to obtain the same failure. Only failures that provably did not consume
 * GPU time -- transport errors before the job was accepted -- are retried.
 *
 * Gradio 4+ exposes a plain HTTP API, so no Python client is needed:
 *   POST /gradio_api/call/{endpoint}  -> { event_id }
 *   GET  /gradio_api/call/{endpoint}/{event_id} -> SSE stream of events
 */

export class ZeroGpuError extends Error {
  constructor(
    message: string,
    readonly code:
      | "ZEROGPU_NOT_CONFIGURED"
      | "ZEROGPU_QUOTA_EXHAUSTED"
      | "ZEROGPU_SPACE_SLEEPING"
      | "ZEROGPU_TIMEOUT"
      | "ZEROGPU_TRANSPORT"
      | "ZEROGPU_JOB_FAILED",
    readonly consumedGpu: boolean,
  ) {
    super(message);
    this.name = "ZeroGpuError";
  }
}

export interface ZeroGpuConfig {
  /** Space id, e.g. "robstelar/paws-trellis". */
  space: string;
  /** HF token. The quota consumed is the token owner's, not the caller's. */
  token: string;
  /** Ceiling for one call, must not exceed the Space's own duration cap. */
  timeoutMs: number;
  baseUrl: string;
}

/** Resolves config without throwing, so a disabled lab cannot break boot. */
export function resolveZeroGpuConfig(env: NodeJS.ProcessEnv = process.env): ZeroGpuConfig | null {
  const space = String(env.ZEROGPU_SPACE || "").trim();
  const token = String(env.HF_TOKEN || "").trim();
  if (!space || !token) return null;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(space)) return null;

  const timeout = Number(env.ZEROGPU_TIMEOUT_MS);
  return {
    space,
    token,
    // Default 180s: longer than the Space's typical duration ceiling so the
    // Space's own limit is what stops a run, not this client.
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.trunc(timeout) : 180_000,
    baseUrl: String(env.ZEROGPU_BASE_URL || "").trim()
      || `https://${space.replace("/", "-").toLowerCase()}.hf.space`,
  };
}

export function isZeroGpuConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveZeroGpuConfig(env) !== null;
}

/** Distinguishes a quota wall from an ordinary failure — they need different handling. */
function classify(status: number, body: string): { code: ZeroGpuError["code"]; consumed: boolean } {
  const text = body.toLowerCase();
  if (status === 429 || text.includes("quota") || text.includes("exceeded your")) {
    // Quota is a wall, not congestion. Retrying makes it worse.
    return { code: "ZEROGPU_QUOTA_EXHAUSTED", consumed: true };
  }
  if (status === 503 || text.includes("sleeping") || text.includes("starting")) {
    // A sleeping Space wakes on request; nothing was billed.
    return { code: "ZEROGPU_SPACE_SLEEPING", consumed: false };
  }
  if (status >= 500) return { code: "ZEROGPU_TRANSPORT", consumed: false };
  return { code: "ZEROGPU_JOB_FAILED", consumed: true };
}

/**
 * Calls one named Gradio endpoint and resolves its output.
 *
 * `data` is positional, matching the Gradio function signature.
 */
export async function callZeroGpu<T = unknown>(
  endpoint: string,
  data: unknown[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ result: T; elapsedMs: number }> {
  const config = resolveZeroGpuConfig(env);
  if (!config) {
    throw new ZeroGpuError(
      "ZEROGPU_SPACE and HF_TOKEN must both be set before a GPU job can be dispatched.",
      "ZEROGPU_NOT_CONFIGURED",
      false,
    );
  }

  const started = Date.now();
  const path = `/gradio_api/call/${encodeURIComponent(endpoint)}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.token}`,
  };

  // Stage 1 — submit. A failure here has not reached the GPU.
  let eventId: string;
  try {
    const res = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ data }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const { code, consumed } = classify(res.status, text);
      throw new ZeroGpuError(`Space rejected the job (${res.status}): ${text.slice(0, 200)}`, code, consumed);
    }
    const parsed = JSON.parse(text);
    eventId = parsed.event_id || parsed.eventId;
    if (!eventId) {
      throw new ZeroGpuError("Space accepted the job but returned no event id.", "ZEROGPU_TRANSPORT", false);
    }
  } catch (cause) {
    if (cause instanceof ZeroGpuError) throw cause;
    throw new ZeroGpuError(
      `Could not reach the Space: ${(cause as Error)?.message || cause}`,
      "ZEROGPU_TRANSPORT",
      false,
    );
  }

  // Stage 2 — await the result. From here the GPU may already be allocated, so
  // any failure is reported as having consumed quota. Over-reporting is the
  // safe direction: it stops a caller from retrying into an empty allowance.
  try {
    const res = await fetch(`${config.baseUrl}${path}/${eventId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const body = await res.text();
    if (!res.ok) {
      const { code, consumed } = classify(res.status, body);
      throw new ZeroGpuError(`Job stream failed (${res.status}): ${body.slice(0, 200)}`, code, consumed);
    }
    const result = parseGradioEventStream<T>(body);
    return { result, elapsedMs: Date.now() - started };
  } catch (cause) {
    if (cause instanceof ZeroGpuError) throw cause;
    const timedOut = (cause as Error)?.name === "TimeoutError";
    throw new ZeroGpuError(
      timedOut
        ? `Job exceeded ${config.timeoutMs}ms. GPU time was still consumed — check the Space's duration ceiling.`
        : `Job stream failed: ${(cause as Error)?.message || cause}`,
      timedOut ? "ZEROGPU_TIMEOUT" : "ZEROGPU_TRANSPORT",
      true,
    );
  }
}

/**
 * Reduces a Gradio SSE body to its completion payload.
 *
 * The stream interleaves heartbeats, progress and a terminal event; only
 * `complete` carries output. An `error` event is a real job failure and must
 * not be reported as an empty success.
 */
export function parseGradioEventStream<T>(body: string): T {
  let currentEvent = "";
  let failure: string | null = null;

  for (const raw of body.split("\n")) {
    const trimmed = raw.trimEnd();
    if (trimmed.startsWith("event:")) {
      currentEvent = trimmed.slice(6).trim();
      continue;
    }
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();

    if (currentEvent === "error") {
      failure = payload && payload !== "null" ? payload : "the Space reported an error with no detail";
      continue;
    }
    if (currentEvent !== "complete") continue;

    try {
      const parsed = JSON.parse(payload);
      // Gradio wraps outputs in an array, one entry per declared output.
      return (Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed) as T;
    } catch {
      return payload as unknown as T;
    }
  }

  throw new ZeroGpuError(
    failure
      ? `Space reported a job error: ${failure.slice(0, 200)}`
      : "Job stream ended without a completion event.",
    "ZEROGPU_JOB_FAILED",
    true,
  );
}
