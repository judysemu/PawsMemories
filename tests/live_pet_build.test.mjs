import assert from "node:assert/strict";
import test from "node:test";
import {
  SerializedLiveRefresh,
  liveBuildAction,
  livePreviewIdentity,
} from "../src/components/pet-model/livePetBuild.ts";

const orderView = (overrides = {}) => ({
  order: {
    orderUuid: "order-a",
    state: "building",
    approvedVersionId: null,
    finalCustomerVersionId: null,
    ...overrides.order,
  },
  currentStage: overrides.currentStage === null ? null : {
    attemptUuid: "attempt-a",
    stage: "base",
    state: "processing",
    artifactSha256: null,
    assetVersionId: null,
    ...overrides.currentStage,
  },
});

test("live build chooses automatic provider polling only for active generated stages", () => {
  assert.equal(liveBuildAction(orderView()), "poll");
  assert.equal(liveBuildAction(orderView({ currentStage: { stage: "reference", state: "awaiting_customer_approval" } })), "refresh");
  assert.equal(liveBuildAction(orderView({ order: { state: "approved" }, currentStage: null })), "stop");
  assert.equal(liveBuildAction(orderView({ order: { state: "failed" }, currentStage: { state: "failed" } })), "stop");
});

test("preview identity changes with exact attempt, artifact, or approved asset version", () => {
  assert.equal(livePreviewIdentity(orderView()), "order-a:attempt-a:none:none:none");
  assert.equal(livePreviewIdentity(orderView({ currentStage: { artifactSha256: "hash-a", assetVersionId: 17 } })), "order-a:attempt-a:hash-a:17:none");
  assert.equal(livePreviewIdentity(orderView({ order: { approvedVersionId: 18 }, currentStage: null })), "order-a:none:none:none:18");
});

test("serialized refresh never overlaps and discards results after selection changes", async () => {
  const runner = new SerializedLiveRefresh();
  let release;
  let calls = 0;
  const pending = runner.run("order-a", async () => {
    calls += 1;
    return await new Promise((resolve) => { release = resolve; });
  });
  const ignored = await runner.run("order-a", async () => {
    calls += 1;
    return "overlap";
  });
  assert.equal(ignored, undefined);
  assert.equal(calls, 1);
  runner.select("order-b");
  release("stale");
  assert.equal(await pending, undefined);
});
