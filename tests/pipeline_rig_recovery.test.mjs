import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assessPipelineProviderRecovery,
  assessPipelineRigContinuation,
  assessPipelineRigRecovery,
  formatPipelineRecoveryDiagnostic,
  pipelineModelFingerprint,
} from "../server/pipeline-rig-recovery.ts";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "../server/migrations/runner.ts";

const NOW = new Date("2026-07-23T00:03:00.000Z");
const MODEL_URL = "https://storage.example/models/current.glb";

function context(overrides = {}) {
  return {
    jobId: 33,
    userPhone: "+15555550123",
    creationId: 901,
    creationOwnerPhone: "+15555550123",
    kind: "model",
    jobStatus: "rigging",
    jobCreatedAt: new Date("2026-07-22T23:50:00.000Z"),
    jobUpdatedAt: new Date("2026-07-23T00:02:00.000Z"),
    creditsReserved: 100,
    rigAttemptCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    recoveryStartedAt: new Date("2026-07-23T00:01:00.000Z"),
    recoveryReason: "rig_prepared",
    sourceModelHash: pipelineModelFingerprint(MODEL_URL),
    rigRefundedAt: null,
    generationRefundedAt: null,
    currentModelUrl: MODEL_URL,
    riggedModelUrl: null,
    sessionId: "session-33",
    sessionMatchCount: 1,
    sessionUserPhone: "+15555550123",
    sessionStatus: "building",
    sessionUpdatedAt: new Date("2026-07-23T00:01:00.000Z"),
    customizationState: { rigging: { enabled: true, facial: true } },
    ...overrides,
  };
}

test("only a recent, current, explicitly prepared rig job can claim an attempt", () => {
  assert.deepEqual(assessPipelineRigRecovery(context(), NOW), { eligible: true, reason: "active_rig_job" });
});

test("terminal, completed, accepted, and failed jobs never recover", () => {
  for (const jobStatus of ["done", "done_static_fallback", "failed"]) {
    const decision = assessPipelineRigRecovery(context({ jobStatus }), NOW);
    assert.equal(decision.eligible, false, jobStatus);
    assert.equal(decision.reason, `job_${jobStatus}`);
  }
  for (const sessionStatus of ["complete", "failed", "approved"]) {
    const decision = assessPipelineRigRecovery(context({ sessionStatus }), NOW);
    assert.equal(decision.eligible, false, sessionStatus);
    assert.equal(decision.reason, `session_${sessionStatus}`);
  }
});

test("stale, replaced, already-rigged, unbound, and exhausted jobs never recover", () => {
  const cases = [
    [context({ recoveryStartedAt: new Date("2026-07-22T20:00:00.000Z") }), "rig_job_stale"],
    [context({ currentModelUrl: "https://storage.example/models/replacement.glb" }), "model_replaced"],
    [context({ riggedModelUrl: "https://storage.example/models/rigged.glb" }), "already_rigged"],
    [context({ sourceModelHash: null }), "unbound_legacy_source"],
    [context({ rigAttemptCount: 2 }), "attempt_budget_exhausted"],
    [context({ customizationState: { rigging: { enabled: false } } }), "rigging_not_requested"],
  ];
  for (const [candidate, expected] of cases) {
    const decision = assessPipelineRigRecovery(candidate, NOW);
    assert.equal(decision.eligible, false, expected);
    assert.equal(decision.reason, expected);
  }
});

test("a live lease prevents another claim while its current attempt may continue", () => {
  const leased = context({
    rigAttemptCount: 2,
    leaseOwner: "rig-worker-a",
    leaseExpiresAt: new Date("2026-07-23T00:08:00.000Z"),
  });
  assert.deepEqual(assessPipelineRigRecovery(leased, NOW), { eligible: false, reason: "attempt_budget_exhausted" });
  assert.deepEqual(assessPipelineRigContinuation(leased, NOW), { eligible: true, reason: "active_rig_attempt" });
});

test("provider recovery refuses old or already-materialized create-pipeline models", () => {
  const provider = context({
    jobStatus: "running",
    currentModelUrl: null,
    sourceModelHash: null,
    recoveryStartedAt: null,
  });
  assert.deepEqual(assessPipelineProviderRecovery(provider, NOW), { eligible: true, reason: "active_provider_job" });
  assert.deepEqual(
    assessPipelineProviderRecovery({ ...provider, currentModelUrl: MODEL_URL }, NOW),
    { eligible: false, reason: "static_model_already_stored" },
  );
  assert.deepEqual(
    assessPipelineProviderRecovery({ ...provider, jobCreatedAt: new Date("2026-07-22T20:00:00.000Z") }, NOW),
    { eligible: false, reason: "provider_job_stale" },
  );
  assert.deepEqual(
    assessPipelineProviderRecovery({ ...provider, sessionStatus: "complete" }, NOW),
    { eligible: false, reason: "session_complete" },
  );
});

test("provider lease wins during the static-model-to-rig handoff", () => {
  const decision = assessPipelineProviderRecovery(context({
    jobStatus: "running",
    leaseOwner: "provider-worker-a",
    leaseExpiresAt: new Date("2026-07-23T00:08:00.000Z"),
  }), NOW);
  assert.deepEqual(decision, { eligible: false, reason: "active_lease" });
});

test("recovery diagnostics expose age, attempt budget, lease, and source binding", () => {
  const candidate = context({ rigAttemptCount: 1 });
  const message = formatPipelineRecoveryDiagnostic(candidate, assessPipelineRigRecovery(candidate, NOW), NOW);
  assert.match(message, /job=33/);
  assert.match(message, /ageMs=780000/);
  assert.match(message, /attempts=1\/2/);
  assert.match(message, /leaseOwner=none/);
  assert.match(message, /sourceBound=true/);
});

test("migration 30 persists recovery timestamps, lease, source identity, attempts, and refund idempotency", () => {
  assert.ok(CURRENT_SCHEMA_VERSION >= 30);
  const migration = MIGRATIONS.find((entry) => entry.version === 30);
  assert.ok(migration);
  const sql = migration.statements.join("\n");
  for (const column of [
    "rig_attempt_count",
    "recovery_lease_owner",
    "recovery_lease_expires_at",
    "recovery_started_at",
    "recovery_last_heartbeat_at",
    "recovery_reason",
    "rig_source_model_hash",
    "rig_refunded_at",
    "generation_refunded_at",
  ]) {
    assert.match(sql, new RegExp(column));
  }
});

test("server checks durable eligibility before build, quality, physics, and commit calls", () => {
  const server = fs.readFileSync("server.ts", "utf8");
  const rigStart = server.indexOf("async function runCreatePipelineRigStage");
  const rigEnd = server.indexOf("\nimport {\n  signToken", rigStart);
  const block = server.slice(rigStart, rigEnd);
  assert.ok(block.indexOf("verifyRigLease(jobId, leaseOwner)") < block.indexOf("runBuildPipeline("));
  assert.ok(block.indexOf("beforeValidation") < block.indexOf('executeBlenderTool("import_glb"'));
  assert.ok(block.indexOf("beforePhysics") < block.indexOf('executeBlenderTool("physics_validate"'));
  assert.ok(block.indexOf("beforeUpload") < block.indexOf("uploadBase64Binary("));
  assert.ok(block.indexOf("completeRig(jobId, leaseOwner") > block.indexOf("uploadBase64Binary("));
  assert.doesNotMatch(server, /runCreatePipelineRigStage\(\{\s*id:/);
});

test("physics validation is implemented end-to-end rather than falling through the tool switch", () => {
  const tools = fs.readFileSync("agent/tools/blender_mcp.ts", "utf8");
  const client = fs.readFileSync("agent/tools/blender_client.ts", "utf8");
  assert.match(tools, /case "physics_validate"/);
  assert.match(tools, /client\.physicsValidate\(profile, Boolean\(args\.facial\)\)/);
  assert.match(client, /"\/physics-validate", "POST", \{ profile, facial \}/);
});
