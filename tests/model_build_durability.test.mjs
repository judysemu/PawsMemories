import assert from "node:assert/strict";
import test from "node:test";
import {
  canCancelBeforeSubmission,
  persistProviderHandleDurably,
  pollProviderWithLease,
  startProviderWithLease,
} from "../server/model-builds/durability.ts";
import {
  MAX_POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
} from "../server/model-builds/types.ts";
import { ModelBuildProviderError } from "../server/model-builds/provider.ts";

/**
 * MG-2 / MG-13 changed this contract deliberately:
 *  - MG-2 raised MAX_POLL_ATTEMPTS from 120 (~10 min) to 240 (~20 min), because
 *    multiview_to_model / texture_model / animate_rig routinely exceed ten
 *    minutes and were being failed AND refunded while still running.
 *  - MG-2 also adds one final poll after the loop, so a task that completed in
 *    the last interval is not refunded as a timeout.
 *  - MG-13 skips the sleep before the FIRST poll, so an already-successful task
 *    no longer waits ~5s for nothing.
 */
test("polling uses the full twenty-minute contract without real waits", async () => {
  const sleeps = [];
  let polls = 0;

  await assert.rejects(
    pollProviderWithLease(
      {
        async poll() {
          polls += 1;
          return { done: false, progress: 10 };
        },
      },
      "tripo:task-safe-id",
      async () => true,
      {
        sleep: async (milliseconds) => sleeps.push(milliseconds),
        random: () => 0,
      },
    ),
    (error) => error.code === "PROVIDER_TIMEOUT",
  );

  // MG-2: every in-loop attempt, plus the one final confirming poll.
  assert.equal(polls, MAX_POLL_ATTEMPTS + 1);
  // MG-13: no sleep before the first poll.
  assert.equal(sleeps.length, MAX_POLL_ATTEMPTS - 1);
  assert.equal(
    sleeps.reduce((sum, value) => sum + value, 0),
    (MAX_POLL_ATTEMPTS - 1) * POLL_INTERVAL_MS,
  );
  assert.equal(POLL_INTERVAL_MS, 5000);
  // MG-2: the ceiling must comfortably exceed the ten minutes that was
  // prematurely failing legitimate Tripo tasks.
  assert.ok(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS >= 19 * 60 * 1000);
});

test("a task that finishes in the final interval is returned, not timed out (MG-2)", async () => {
  let polls = 0;

  const result = await pollProviderWithLease(
    {
      async poll() {
        polls += 1;
        // Never done inside the loop; completes exactly at the ceiling.
        if (polls <= MAX_POLL_ATTEMPTS) return { done: false, progress: 99 };
        return { done: true, glbUrl: "https://provider.invalid/late-but-valid" };
      },
    },
    "tripo:task-safe-id",
    async () => true,
    { sleep: async () => {}, random: () => 0 },
  );

  assert.equal(result.done, true);
  assert.equal(result.glbUrl, "https://provider.invalid/late-but-valid");
});

test("polling stops before a provider call when the lease is no longer valid", async () => {
  let polls = 0;
  let leaseChecks = 0;

  await assert.rejects(
    pollProviderWithLease(
      {
        async poll() {
          polls += 1;
          return { done: false };
        },
      },
      "tripo:task-safe-id",
      async () => {
        leaseChecks += 1;
        return leaseChecks < 3;
      },
      { sleep: async () => {}, random: () => 0 },
    ),
    (error) => error.code === "LEASE_LOST",
  );

  assert.equal(polls, 2);
});

test("documented provider throttling is retried with bounded backoff and jitter", async () => {
  const sleeps = [];
  let polls = 0;

  const result = await pollProviderWithLease(
    {
      async poll() {
        polls += 1;
        if (polls < 3) {
          throw new ModelBuildProviderError(
            "Provider polling was rate limited",
            "PROVIDER_RATE_LIMITED",
            true,
          );
        }
        return { done: true, glbUrl: "https://provider.invalid/signed-output" };
      },
    },
    "tripo:task-safe-id",
    async () => true,
    { sleep: async (milliseconds) => sleeps.push(milliseconds), random: () => 0.5 },
  );

  assert.equal(result.done, true);
  assert.equal(polls, 3);
  // MG-13: the leading 5500ms sleep is gone — the first poll now fires
  // immediately. Backoff after each throttled response is unchanged.
  assert.deepEqual(sleeps, [10500, 20500]);
  assert.ok(sleeps.every((value) => value <= 31_000));
});

test("authentication failures are terminal and never leak arbitrary provider text", async () => {
  const secretUrl = "https://provider.invalid/private.glb?signature=do-not-log";
  let polls = 0;

  await assert.rejects(
    pollProviderWithLease(
      {
        async poll() {
          polls += 1;
          throw new ModelBuildProviderError(
            `raw provider body ${secretUrl}`,
            "PROVIDER_AUTH_FAILED",
            false,
          );
        },
      },
      "tripo:task-safe-id",
      async () => true,
      { sleep: async () => {}, random: () => 0 },
    ),
    (error) => {
      assert.equal(error.code, "PROVIDER_AUTH_FAILED");
      assert.equal(error.message.includes(secretUrl), false);
      return true;
    },
  );

  assert.equal(polls, 1);
});

test("cancellation is allowed only before the submission claim", () => {
  assert.equal(canCancelBeforeSubmission("queued", {
    state: "queued",
    providerTaskHandle: null,
    submissionClaimedAt: null,
  }), true);
  assert.equal(canCancelBeforeSubmission("submitted", {
    state: "submitted",
    providerTaskHandle: null,
    submissionClaimedAt: new Date(),
  }), false);
  assert.equal(canCancelBeforeSubmission("queued", {
    state: "submitted",
    providerTaskHandle: null,
    submissionClaimedAt: new Date(),
  }), false);
  assert.equal(canCancelBeforeSubmission("queued", {
    state: "queued",
    providerTaskHandle: "tripo:already-submitted",
    submissionClaimedAt: null,
  }), false);
});

test("a returned provider handle uses bounded persistence retries then durable recovery", async () => {
  let persistenceAttempts = 0;
  let recoveryAttempts = 0;
  const sleeps = [];

  const result = await persistProviderHandleDurably(
    async () => {
      persistenceAttempts += 1;
      throw new Error("database unavailable");
    },
    async () => {
      recoveryAttempts += 1;
      if (recoveryAttempts < 2) throw new Error("database still unavailable");
    },
    { sleep: async (milliseconds) => sleeps.push(milliseconds), random: () => 0 },
  );

  assert.equal(result, "recovery_required");
  assert.equal(persistenceAttempts, 3);
  assert.equal(recoveryAttempts, 2);
  assert.deepEqual(sleeps, [250, 500, 250]);
});

test("provider submission retries only proven non-accepted throttles with bounded lease checks", async () => {
  let starts = 0;
  let leaseChecks = 0;
  const sleeps = [];
  const provider = {
    async start() {
      starts += 1;
      if (starts < 3) {
        throw new ModelBuildProviderError(
          "Provider submission was rate limited",
          "PROVIDER_RATE_LIMITED",
          true,
          "safe_retry",
        );
      }
      return { providerTaskHandle: "tripo:safe-handle", provider: "tripo", model: "configured" };
    },
  };

  const result = await startProviderWithLease(
    provider,
    { frontUrl: "front", leftUrl: "left", rightUrl: "right", rearUrl: "rear", threeQuarterUrl: "three-quarter" },
    "config-hash",
    async () => { leaseChecks += 1; return true; },
    { sleep: async (milliseconds) => sleeps.push(milliseconds), random: () => 0 },
  );

  assert.equal(result.providerTaskHandle, "tripo:safe-handle");
  assert.equal(starts, 3);
  assert.equal(leaseChecks, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("ambiguous provider submission is never retried automatically", async () => {
  let starts = 0;
  const sleeps = [];

  await assert.rejects(
    startProviderWithLease(
      {
        async start() {
          starts += 1;
          throw new ModelBuildProviderError(
            "Provider submission outcome is unknown",
            "PROVIDER_SUBMISSION_AMBIGUOUS",
            false,
            "ambiguous_acceptance",
          );
        },
      },
      { frontUrl: "front", leftUrl: "left", rightUrl: "right", rearUrl: "rear", threeQuarterUrl: "three-quarter" },
      "config-hash",
      async () => true,
      { sleep: async (milliseconds) => sleeps.push(milliseconds), random: () => 0 },
    ),
    (error) => error.code === "PROVIDER_SUBMISSION_AMBIGUOUS",
  );

  assert.equal(starts, 1);
  assert.deepEqual(sleeps, []);
});

test("provider submission retry stops before another create call when the lease is lost", async () => {
  let starts = 0;
  let leaseChecks = 0;

  await assert.rejects(
    startProviderWithLease(
      {
        async start() {
          starts += 1;
          throw new ModelBuildProviderError(
            "Provider submission was rate limited",
            "PROVIDER_RATE_LIMITED",
            true,
            "safe_retry",
          );
        },
      },
      { frontUrl: "front", leftUrl: "left", rightUrl: "right", rearUrl: "rear", threeQuarterUrl: "three-quarter" },
      "config-hash",
      async () => { leaseChecks += 1; return leaseChecks === 1; },
      { sleep: async () => {}, random: () => 0 },
    ),
    (error) => error.code === "LEASE_LOST",
  );

  assert.equal(starts, 1);
  assert.equal(leaseChecks, 2);
});
