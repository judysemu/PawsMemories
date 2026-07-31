import assert from "node:assert/strict";
import test from "node:test";

import {
  ImageGenerationBudgetError,
  createImageGenerationCallBudget,
} from "../server/imageGenerationBudget.ts";

test("image-call budget reserves the configured user, global, and cost limits", async () => {
  const calls = [];
  const budget = createImageGenerationCallBudget({
    env: {
      PETSIM_PAID_APIS_ENABLED: "true",
      PETSIM_IMAGE_GENERATION_ENABLED: "true",
      PETSIM_IMAGE_GENERATION_DAILY_CAP: "4",
      PETSIM_IMAGE_GENERATION_GLOBAL_DAILY_CAP: "30",
      PETSIM_IMAGE_GENERATION_GLOBAL_MINUTE_CALL_CAP: "7",
      PETSIM_IMAGE_GENERATION_ESTIMATED_COST_MICRO_USD: "250000",
      PETSIM_IMAGE_GENERATION_GLOBAL_DAILY_COST_MICRO_USD: "5000000",
    },
    reserveUsage: async (...args) => {
      calls.push(args);
      return { allowed: true, userCount: 1, globalCount: 1, globalReservedCostMicroUsd: 250000 };
    },
  });

  await budget("+15550000001");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "+15550000001");
  assert.equal(calls[0][1], "image_generation");
  assert.deepEqual(calls[0][2], {
    userDailyCap: 4,
    globalDailyCap: 30,
    globalMinuteCallCap: 7,
    estimatedCostMicroUsd: 250000,
    globalDailyCostMicroUsd: 5000000,
  });
});

test("disabled image generation makes zero database reservations", async () => {
  let calls = 0;
  const budget = createImageGenerationCallBudget({
    env: { PETSIM_IMAGE_GENERATION_ENABLED: "false" },
    reserveUsage: async () => {
      calls += 1;
      return { allowed: true, userCount: 1, globalCount: 1, globalReservedCostMicroUsd: 1 };
    },
  });

  await assert.rejects(
    budget("+15550000001"),
    (error) => error instanceof ImageGenerationBudgetError && error.code === "IMAGE_GENERATION_DISABLED",
  );
  assert.equal(calls, 0);
});

test("denied image-call reservation fails before the provider", async () => {
  const budget = createImageGenerationCallBudget({
    env: { PETSIM_IMAGE_GENERATION_ENABLED: "true" },
    reserveUsage: async () => ({
      allowed: false,
      reason: "global_cap",
      userCount: 2,
      globalCount: 50,
      globalReservedCostMicroUsd: 50_000_000,
    }),
  });

  await assert.rejects(
    budget("+15550000001"),
    (error) => error instanceof ImageGenerationBudgetError
      && error.code === "IMAGE_GENERATION_GLOBAL_CAP",
  );
});

test("global minute denial is surfaced as a typed provider-boundary error", async () => {
  const budget = createImageGenerationCallBudget({
    env: { PETSIM_IMAGE_GENERATION_ENABLED: "true" },
    reserveUsage: async () => ({
      allowed: false,
      reason: "global_minute_cap",
      userCount: 2,
      globalCount: 2,
      globalMinuteCount: 10,
      globalReservedCostMicroUsd: 2_000_000,
    }),
  });

  await assert.rejects(
    budget("+15550000001"),
    (error) => error instanceof ImageGenerationBudgetError
      && error.code === "IMAGE_GENERATION_GLOBAL_MINUTE_CAP",
  );
});

test("typed budget errors cannot be downgraded to optional image failures", async () => {
  const budgetModule = await import("../server/imageGenerationBudget.ts");
  assert.equal(typeof budgetModule.rethrowImageGenerationBudgetError, "function");
  const denial = new ImageGenerationBudgetError(
    "IMAGE_GENERATION_GLOBAL_CAP",
    "daily stop",
  );
  assert.throws(
    () => budgetModule.rethrowImageGenerationBudgetError(denial),
    (error) => error === denial,
  );
  assert.doesNotThrow(
    () => budgetModule.rethrowImageGenerationBudgetError(new Error("optional provider failure")),
  );
});

test("shared Nano Banana paths reserve at the provider boundary without an HTTP request limiter", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../server.ts", import.meta.url),
    "utf8",
  ));
  assert.match(source, /retryOptions:\s*\{\s*attempts:\s*1\s*\}/);
  assert.match(source, /await reserveImageGenerationCall\(userPhone\)/);
  assert.doesNotMatch(source, /imageGenerationRequestLimiter/);
  assert.match(source, /app\.post\("\/api\/avatars", requireAuth, paidLimiter/);
  assert.match(source, /if \(isPetGlbEnabled\(\) \|\| isModelBuildV3Enabled\(\)\)[\s\S]{0,300}LEGACY_AVATAR_DISABLED/);
  assert.match(source, /app\.post\("\/api\/create-creation", requireAuth, async/);
  assert.match(source, /app\.post\("\/api\/text-to-reference", requireAuth, async/);
  const textureSource = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../server/textureJob.ts", import.meta.url),
    "utf8",
  ));
  assert.match(textureSource, /await reserveImageGenerationCall\(phone\)/);
});
