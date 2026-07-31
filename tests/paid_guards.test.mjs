import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseBoolFlag,
  dailyCapFor,
  isEndpointEnabled,
  withinDailyCap,
  globalDailyCapFor,
  estimatedCostMicroUsdFor,
  globalDailyCostMicroUsdFor,
  paidUsageLimitsFor,
  PAID_ENDPOINTS,
} from "../server/paidApiGuards.ts";

test("parseBoolFlag: truthy / falsy / default", () => {
  for (const v of ["1", "true", "TRUE", "yes", "on", " On "]) {
    assert.equal(parseBoolFlag(v, false), true, `${v} should be true`);
  }
  for (const v of ["0", "false", "no", "off", "OFF"]) {
    assert.equal(parseBoolFlag(v, true), false, `${v} should be false`);
  }
  // empty / undefined / unrecognised → default
  assert.equal(parseBoolFlag(undefined, true), true);
  assert.equal(parseBoolFlag("", false), false);
  assert.equal(parseBoolFlag("banana", true), true);
  assert.equal(parseBoolFlag("banana", false), false);
});

test("aggregate budgets: conservative defaults keep rig closed", () => {
  assert.equal(globalDailyCapFor("classify", {}), 250);
  assert.equal(globalDailyCapFor("semantic_scan", {}), 500);
  assert.equal(globalDailyCapFor("rig", {}), 0);
  assert.equal(globalDailyCostMicroUsdFor("rig", {}), 0);
  assert.equal(estimatedCostMicroUsdFor("rig", {}), 1_000_000);
  assert.deepEqual(paidUsageLimitsFor("image_generation", {}), {
    userDailyCap: 5,
    globalDailyCap: 50,
    globalMinuteCallCap: 10,
    estimatedCostMicroUsd: 1_000_000,
    globalDailyCostMicroUsd: 50_000_000,
  });
});

test("image generation has an env-backed provider-call minute cap without changing AR endpoint limits", () => {
  assert.equal(
    paidUsageLimitsFor("image_generation", {
      PETSIM_IMAGE_GENERATION_GLOBAL_MINUTE_CALL_CAP: "7",
    }).globalMinuteCallCap,
    7,
  );
  assert.equal(
    paidUsageLimitsFor("image_generation", {
      PETSIM_IMAGE_GENERATION_GLOBAL_MINUTE_CALL_CAP: "invalid",
    }).globalMinuteCallCap,
    10,
  );
  assert.equal(paidUsageLimitsFor("classify", {}).globalMinuteCallCap, undefined);
});

test("aggregate budgets: zero caps are preserved and zero cost estimates fall back", () => {
  const env = {
    PETSIM_CLASSIFY_DAILY_CAP: "4",
    PETSIM_CLASSIFY_GLOBAL_DAILY_CAP: "0",
    PETSIM_CLASSIFY_ESTIMATED_COST_MICRO_USD: "0",
    PETSIM_CLASSIFY_GLOBAL_DAILY_COST_MICRO_USD: "0",
  };
  assert.deepEqual(paidUsageLimitsFor("classify", env), {
    userDailyCap: 4,
    globalDailyCap: 0,
    estimatedCostMicroUsd: 10_000,
    globalDailyCostMicroUsd: 0,
  });
});

test("aggregate budgets: invalid, negative, fractional, and unsafe values fall back", () => {
  assert.equal(globalDailyCapFor("classify", { PETSIM_CLASSIFY_GLOBAL_DAILY_CAP: "nope" }), 250);
  assert.equal(globalDailyCapFor("classify", { PETSIM_CLASSIFY_GLOBAL_DAILY_CAP: "-1" }), 250);
  assert.equal(globalDailyCapFor("classify", { PETSIM_CLASSIFY_GLOBAL_DAILY_CAP: "1.5" }), 250);
  assert.equal(
    globalDailyCostMicroUsdFor("classify", {
      PETSIM_CLASSIFY_GLOBAL_DAILY_COST_MICRO_USD: String(Number.MAX_SAFE_INTEGER + 1),
    }),
    2_500_000,
  );
});

test("dailyCapFor: defaults", () => {
  assert.equal(dailyCapFor("classify", {}), 25);
  assert.equal(dailyCapFor("rig", {}), 5);
  assert.equal(dailyCapFor("semantic_scan", {}), 50);
  assert.equal(dailyCapFor("image_generation", {}), 5);
});

test("dailyCapFor: env override + invalid fallback", () => {
  assert.equal(dailyCapFor("classify", { PETSIM_CLASSIFY_DAILY_CAP: "3" }), 3);
  assert.equal(dailyCapFor("rig", { PETSIM_RIG_DAILY_CAP: "0" }), 0);
  // non-numeric / negative / blank → default
  assert.equal(dailyCapFor("classify", { PETSIM_CLASSIFY_DAILY_CAP: "lots" }), 25);
  assert.equal(dailyCapFor("classify", { PETSIM_CLASSIFY_DAILY_CAP: "-4" }), 25);
  assert.equal(dailyCapFor("classify", { PETSIM_CLASSIFY_DAILY_CAP: "" }), 25);
  // fractional floored
  assert.equal(dailyCapFor("semantic_scan", { PETSIM_SEMANTIC_SCAN_DAILY_CAP: "7.9" }), 7);
});

test("isEndpointEnabled: per-endpoint defaults (rig off, others on)", () => {
  assert.equal(isEndpointEnabled("classify", {}), true);
  assert.equal(isEndpointEnabled("semantic_scan", {}), true);
  assert.equal(isEndpointEnabled("rig", {}), false); // historical default
  assert.equal(isEndpointEnabled("rig", { PETSIM_RIG_ENABLED: "true" }), true);
  assert.equal(isEndpointEnabled("image_generation", {}), true);
  assert.equal(isEndpointEnabled("image_generation", { PETSIM_IMAGE_GENERATION_ENABLED: "false" }), false);
});

test("isEndpointEnabled: master kill-switch overrides everything", () => {
  const env = { PETSIM_PAID_APIS_ENABLED: "false", PETSIM_RIG_ENABLED: "true", PETSIM_CLASSIFY_ENABLED: "true" };
  for (const ep of PAID_ENDPOINTS) {
    assert.equal(isEndpointEnabled(ep, env), false, `${ep} should be killed by master switch`);
  }
});

test("isEndpointEnabled: per-endpoint switch off", () => {
  assert.equal(isEndpointEnabled("classify", { PETSIM_CLASSIFY_ENABLED: "off" }), false);
  assert.equal(isEndpointEnabled("semantic_scan", { PETSIM_SEMANTIC_SCAN_ENABLED: "0" }), false);
});

test("withinDailyCap: boundary is inclusive of the cap", () => {
  const env = { PETSIM_CLASSIFY_DAILY_CAP: "2" };
  assert.equal(withinDailyCap("classify", 1, env), true);
  assert.equal(withinDailyCap("classify", 2, env), true); // 2nd call allowed
  assert.equal(withinDailyCap("classify", 3, env), false); // 3rd rejected
  // cap of 0 rejects the very first call
  assert.equal(withinDailyCap("rig", 1, { PETSIM_RIG_DAILY_CAP: "0" }), false);
});
