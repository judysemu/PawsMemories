import assert from "node:assert/strict";
import test from "node:test";
import { resolveReferenceProviderBudget } from "../server/reference-sessions/service.ts";

test("production reference generation daily guard defaults to 100 attempts in a rolling 24-hour window", () => {
  const budget = resolveReferenceProviderBudget({ NODE_ENV: "production" });

  assert.equal(budget.globalDailyCap, 100);
  assert.equal(
    budget.dailyCapMessage,
    "Reference generation has reached its rolling 24-hour global safety limit.",
  );
});
