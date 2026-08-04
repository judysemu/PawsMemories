import type { BuildJobState } from "./types";
import {
  DEFAULT_LEASE_DURATION_MS,
  HANDLE_PERSIST_RETRY_BASE_MS,
  MAX_HANDLE_PERSIST_ATTEMPTS,
  MAX_POLL_ATTEMPTS,
  MAX_PROVIDER_RETRY_DELAY_MS,
  MAX_PROVIDER_START_ATTEMPTS,
  POLL_INTERVAL_MS,
  POLL_JITTER_MS,
  PROVIDER_START_RETRY_BASE_MS,
} from "./types";
import {
  ModelBuildProviderError,
  type ModelBuildPollResult,
  type ModelBuildProvider,
  type ModelBuildProviderInput,
  type ModelBuildProviderResult,
} from "./provider";

export interface DurabilityRuntime {
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
  afterAmbiguousSubmissionScan?: () => Promise<void>;
}

const defaultRuntime: DurabilityRuntime = {
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random: Math.random,
};

export class DurableModelBuildError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "DurableModelBuildError";
  }
}

export class RecoveryPersistenceUnavailableError extends DurableModelBuildError {
  constructor() {
    super("Provider submission requires recovery after database persistence failed", "RECOVERY_PERSISTENCE_UNAVAILABLE");
    this.name = "RecoveryPersistenceUnavailableError";
  }
}

export function canCancelBeforeSubmission(
  jobState: BuildJobState,
  attempt: {
    state: string;
    providerTaskHandle: string | null;
    submissionClaimedAt: Date | null;
  } | null,
): boolean {
  if (!["draft", "preflight", "reserving", "queued"].includes(jobState)) return false;
  if (!attempt) return jobState !== "queued";
  return attempt.state === "queued" &&
    attempt.providerTaskHandle === null &&
    attempt.submissionClaimedAt === null;
}

function safeProviderMessage(code: string): string {
  switch (code) {
    case "PROVIDER_AUTH_FAILED": return "Provider authentication failed";
    case "PROVIDER_CONTENT_POLICY": return "Provider rejected the task under its content policy";
    case "PROVIDER_TASK_NOT_FOUND": return "Provider task was not found";
    case "PROVIDER_TASK_EXPIRED": return "Provider task expired";
    case "PROVIDER_TASK_UNKNOWN": return "Provider returned an unknown terminal task state";
    case "PROVIDER_RATE_LIMITED": return "Provider polling was rate limited";
    default: return "Provider polling failed";
  }
}

function normalizedProviderError(error: unknown): ModelBuildProviderError {
  if (error instanceof ModelBuildProviderError) return error;
  return new ModelBuildProviderError("Provider polling failed", "PROVIDER_POLL_FAILED", false);
}

function pollDelayMs(retryableFailures: number, random: () => number): number {
  const exponentialBase = Math.min(
    POLL_INTERVAL_MS * (2 ** retryableFailures),
    MAX_PROVIDER_RETRY_DELAY_MS,
  );
  const boundedRandom = Math.min(1, Math.max(0, random()));
  return exponentialBase + Math.floor(boundedRandom * POLL_JITTER_MS);
}

function providerStartRetryDelayMs(failures: number, random: () => number): number {
  const base = Math.min(
    PROVIDER_START_RETRY_BASE_MS * (2 ** Math.max(0, failures - 1)),
    MAX_PROVIDER_RETRY_DELAY_MS,
  );
  const boundedRandom = Math.min(1, Math.max(0, random()));
  return base + Math.floor(boundedRandom * PROVIDER_START_RETRY_BASE_MS);
}

/**
 * MG-3: renew the worker lease on a timer for the duration of `operation`.
 *
 * A failed renewal stops the heartbeat but never rejects — the caller's normal
 * post-submission path (handle persistence / lockCurrentAttempt) already routes
 * a lost lease to `recovery_required`, and throwing here would discard a
 * provider task handle that the provider may well have accepted.
 */
export async function withLeaseHeartbeat<T>(
  renewLease: () => Promise<boolean>,
  operation: () => Promise<T>,
  intervalMs: number = Math.max(1000, Math.floor(DEFAULT_LEASE_DURATION_MS / 3)),
): Promise<T> {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    void renewLease().then(
      (held) => { if (!held) stopped = true; },
      () => { /* transient renewal error: keep trying until the operation ends */ },
    );
  }, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();

  try {
    return await operation();
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}

export async function startProviderWithLease(
  provider: Pick<ModelBuildProvider, "start">,
  input: ModelBuildProviderInput,
  configHash: string,
  assertLease: () => Promise<boolean>,
  runtime: Partial<DurabilityRuntime> = {},
): Promise<ModelBuildProviderResult> {
  const sleep = runtime.sleep || defaultRuntime.sleep;
  const random = runtime.random || defaultRuntime.random;

  for (let attempt = 1; attempt <= MAX_PROVIDER_START_ATTEMPTS; attempt += 1) {
    if (!await assertLease()) {
      throw new DurableModelBuildError("Build worker lease was lost", "LEASE_LOST");
    }

    try {
      // MG-3: the lease was previously only asserted at the top of each retry
      // iteration, never while provider.start() was in flight. Multiview
      // submissions upload four reference images sequentially, which on a slow
      // network can outlast the 10 minute lease — the lease then expired
      // mid-submission and the job was marked recovery_required even though
      // Tripo had accepted the task. Renew on a heartbeat until start resolves.
      return await withLeaseHeartbeat(assertLease, () => provider.start(input, configHash));
    } catch (error) {
      if (!(error instanceof ModelBuildProviderError)) throw error;
      const safeThrottle = error.retryable &&
        error.code === "PROVIDER_RATE_LIMITED" &&
        error.submissionDisposition === "safe_retry";
      if (!safeThrottle || attempt === MAX_PROVIDER_START_ATTEMPTS) throw error;
      await sleep(providerStartRetryDelayMs(attempt, random));
    }
  }

  throw new ModelBuildProviderError(
    "Provider submission retry limit reached",
    "PROVIDER_RATE_LIMITED",
    false,
    "definitive_rejection",
  );
}

export async function pollProviderWithLease(
  provider: Pick<ModelBuildProvider, "poll">,
  taskHandle: string,
  assertLease: () => Promise<boolean>,
  runtime: Partial<DurabilityRuntime> = {},
): Promise<ModelBuildPollResult> {
  const sleep = runtime.sleep || defaultRuntime.sleep;
  const random = runtime.random || defaultRuntime.random;
  let retryableFailures = 0;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    // MG-13: don't burn a full poll interval before the first poll — a task
    // that is already `success` used to wait ~5s for nothing.
    if (attempt > 0) await sleep(pollDelayMs(retryableFailures, random));
    if (!await assertLease()) {
      throw new DurableModelBuildError("Build worker lease was lost", "LEASE_LOST");
    }

    try {
      const result = await provider.poll(taskHandle);
      retryableFailures = 0;
      if (result.done) return result;
    } catch (error) {
      const providerError = normalizedProviderError(error);
      if (providerError.retryable) {
        retryableFailures += 1;
        continue;
      }
      throw new DurableModelBuildError(
        safeProviderMessage(providerError.code),
        providerError.code,
      );
    }
  }

  // MG-2: one last poll before declaring PROVIDER_TIMEOUT. The task very often
  // completes in the window between the final in-loop poll and the ceiling
  // being hit; refunding it there orphans a provider task that actually
  // succeeded and produced a valid asset.
  try {
    const finalResult = await provider.poll(taskHandle);
    if (finalResult.done) return finalResult;
  } catch {
    // Fall through to the timeout below — the poll error tells us nothing new.
  }

  throw new DurableModelBuildError("Provider polling timed out", "PROVIDER_TIMEOUT");
}

export async function persistProviderHandleDurably(
  persist: (attemptNumber: number) => Promise<void>,
  markRecoveryRequired: (attemptNumber: number) => Promise<void>,
  runtime: Partial<DurabilityRuntime> = {},
): Promise<"persisted" | "recovery_required"> {
  const sleep = runtime.sleep || defaultRuntime.sleep;
  const random = runtime.random || defaultRuntime.random;

  for (let attempt = 1; attempt <= MAX_HANDLE_PERSIST_ATTEMPTS; attempt += 1) {
    try {
      await persist(attempt);
      return "persisted";
    } catch {
      if (attempt < MAX_HANDLE_PERSIST_ATTEMPTS) {
        const jitter = Math.floor(Math.min(1, Math.max(0, random())) * HANDLE_PERSIST_RETRY_BASE_MS);
        await sleep((HANDLE_PERSIST_RETRY_BASE_MS * (2 ** (attempt - 1))) + jitter);
      }
    }
  }

  for (let attempt = 1; attempt <= MAX_HANDLE_PERSIST_ATTEMPTS; attempt += 1) {
    try {
      await markRecoveryRequired(attempt);
      return "recovery_required";
    } catch {
      if (attempt < MAX_HANDLE_PERSIST_ATTEMPTS) {
        const jitter = Math.floor(Math.min(1, Math.max(0, random())) * HANDLE_PERSIST_RETRY_BASE_MS);
        await sleep((HANDLE_PERSIST_RETRY_BASE_MS * (2 ** (attempt - 1))) + jitter);
      }
    }
  }

  throw new RecoveryPersistenceUnavailableError();
}

export async function persistRecoveryRequiredDurably(
  markRecoveryRequired: (attemptNumber: number) => Promise<void>,
  runtime: Partial<DurabilityRuntime> = {},
): Promise<void> {
  const sleep = runtime.sleep || defaultRuntime.sleep;
  const random = runtime.random || defaultRuntime.random;

  for (let attempt = 1; attempt <= MAX_HANDLE_PERSIST_ATTEMPTS; attempt += 1) {
    try {
      await markRecoveryRequired(attempt);
      return;
    } catch {
      if (attempt < MAX_HANDLE_PERSIST_ATTEMPTS) {
        const jitter = Math.floor(Math.min(1, Math.max(0, random())) * HANDLE_PERSIST_RETRY_BASE_MS);
        await sleep((HANDLE_PERSIST_RETRY_BASE_MS * (2 ** (attempt - 1))) + jitter);
      }
    }
  }

  throw new RecoveryPersistenceUnavailableError();
}
