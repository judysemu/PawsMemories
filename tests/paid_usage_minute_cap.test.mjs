import assert from "node:assert/strict";
import test from "node:test";

import { reservePaidUsage, setPool } from "../db.ts";

function makeUsagePool() {
  const state = {
    globalCount: 0,
    userCount: 0,
    minuteCount: 0,
    reservedCost: 0,
    commits: 0,
    rollbacks: 0,
  };

  const connection = {
    async beginTransaction() {},
    async commit() { state.commits += 1; },
    async rollback() { state.rollbacks += 1; },
    release() {},
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("INSERT INTO api_usage_global_daily")) return [{ affectedRows: 1 }];
      if (normalized.startsWith("INSERT INTO api_usage_daily")) return [{ affectedRows: 1 }];
      if (normalized.startsWith("INSERT INTO api_usage_global_minute")) return [{ affectedRows: 1 }];
      if (normalized.includes("FROM api_usage_global_daily") && normalized.includes("FOR UPDATE")) {
        return [[{
          count: state.globalCount,
          reserved_cost_micro_usd: state.reservedCost,
        }]];
      }
      if (normalized.includes("FROM api_usage_daily") && normalized.includes("FOR UPDATE")) {
        return [[{ count: state.userCount }]];
      }
      if (normalized.includes("FROM api_usage_global_minute") && normalized.includes("FOR UPDATE")) {
        return [[{ count: state.minuteCount, window_active: 1 }]];
      }
      if (normalized.startsWith("UPDATE api_usage_global_daily")) {
        state.globalCount += 1;
        state.reservedCost += Number(params[0]);
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("UPDATE api_usage_daily")) {
        state.userCount += 1;
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("UPDATE api_usage_global_minute")) {
        state.minuteCount += 1;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
  };

  return {
    state,
    pool: { getConnection: async () => connection },
  };
}

test("durable global minute capacity is reserved atomically with daily image usage", async () => {
  const harness = makeUsagePool();
  setPool(harness.pool);
  const limits = {
    userDailyCap: 5,
    globalDailyCap: 50,
    globalMinuteCallCap: 1,
    estimatedCostMicroUsd: 1_000_000,
    globalDailyCostMicroUsd: 50_000_000,
  };

  const first = await reservePaidUsage("+15550000001", "image_generation", limits);
  const second = await reservePaidUsage("+15550000001", "image_generation", limits);

  assert.equal(first.allowed, true);
  assert.equal(first.globalMinuteCount, 1);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "global_minute_cap");
  assert.equal(second.globalMinuteCount, 1);
  assert.equal(harness.state.globalCount, 1, "denial must not consume daily capacity");
  assert.equal(harness.state.userCount, 1, "denial must not consume user capacity");
  assert.equal(harness.state.commits, 1);
  assert.equal(harness.state.rollbacks, 1);
});
