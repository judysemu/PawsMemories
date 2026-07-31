import assert from "node:assert/strict";
import test from "node:test";

import {
  SpatialGeneratorService,
  SpatialGeneratorServiceError,
} from "../server/spatial-generator/service.ts";

const OWNER_PHONE = "+15550000001";

const VALID_JOB = {
  idempotencyKey: "spatial-readiness-service-0001",
  subjectKind: "accessory",
  targetUse: "attachment",
  prompt: "Build a measured collar",
  targetEnvelopeMm: { x: 150, y: 150, z: 25 },
  referenceAssetVersionIds: [],
  scaleAnchor: { axis: "x", millimeters: 400, label: "neck circumference" },
  attachment: { targetAssetVersionId: 1, clearanceMm: 10 },
};

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("startJob fails closed before opening a job transaction or debiting credits when readiness is lost", async (t) => {
  const previousFlag = process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED;
  t.after(() => restoreEnv("INHOUSE_SPATIAL_GENERATOR_ENABLED", previousFlag));
  process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED = "true";

  let readinessChecks = 0;
  let transactionStarts = 0;
  let jobCreates = 0;
  let debitAttempts = 0;
  let connectionReleases = 0;

  const connection = {
    beginTransaction: async () => {
      transactionStarts += 1;
    },
    commit: async () => {},
    rollback: async () => {},
    release: () => {
      connectionReleases += 1;
    },
    query: async (sql) => {
      if (String(sql).includes("UPDATE users SET credits = credits -")) debitAttempts += 1;
      return [[], []];
    },
  };
  const pool = {
    getConnection: async () => connection,
  };
  const service = new SpatialGeneratorService({ pool });

  service.preflight = async () => ({
    passed: true,
    errors: [],
    quotedCredits: 50,
    pricingKey: "spatial_accessory_attachment",
    currentBalance: 100,
  });
  service.getCreditBalance = async () => 100;
  service.getHealthStatus = async () => {
    readinessChecks += 1;
    return {
      ready: false,
      featureEnabled: true,
      layer8Configured: true,
      pixelWorkerOnline: false,
      blenderWorkerHealthy: false,
      orchestratorReady: false,
      blockers: ["pixel_worker", "blender_worker", "orchestrator"],
      activeJobs: 0,
      queuedAttempts: 0,
    };
  };
  service.repo.getJobByOwnerAndIdempotency = async () => null;
  service.repo.createJob = async () => {
    jobCreates += 1;
    return 1;
  };
  service.repo.createJobInputs = async () => {};
  service.repo.logEvent = async () => {};
  service.repo.createAttempt = async () => 1;
  service.repo.updateJobState = async () => {};
  service.getJobDetail = async () => ({
    jobUuid: "must-not-be-created",
  });

  await assert.rejects(
    service.startJob(OWNER_PHONE, VALID_JOB),
    (error) => {
      assert.ok(error instanceof SpatialGeneratorServiceError);
      assert.equal(error.code, "SPATIAL_PIPELINE_NOT_READY");
      assert.equal(error.message, "Spatial generation is temporarily unavailable.");
      return true;
    },
  );

  assert.equal(readinessChecks, 1);
  assert.equal(transactionStarts, 0);
  assert.equal(jobCreates, 0);
  assert.equal(debitAttempts, 0);
  assert.equal(connectionReleases, 1);
});

test("startJob rejects a spoofed ready aggregate when the blocker list is missing", async (t) => {
  const previousFlag = process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED;
  t.after(() => restoreEnv("INHOUSE_SPATIAL_GENERATOR_ENABLED", previousFlag));
  process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED = "true";

  let transactionStarts = 0;
  const connection = {
    beginTransaction: async () => {
      transactionStarts += 1;
    },
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    query: async () => [[], []],
  };
  const service = new SpatialGeneratorService({
    pool: { getConnection: async () => connection },
  });

  service.preflight = async () => ({
    passed: true,
    errors: [],
    quotedCredits: 50,
    pricingKey: "spatial_accessory_attachment",
    currentBalance: 100,
  });
  service.getCreditBalance = async () => 100;
  service.getHealthStatus = async () => ({
    ready: true,
    featureEnabled: true,
    layer8Configured: true,
    pixelWorkerOnline: true,
    blenderWorkerHealthy: true,
    orchestratorReady: true,
    activeJobs: 0,
    queuedAttempts: 0,
  });
  service.repo.getJobByOwnerAndIdempotency = async () => null;

  await assert.rejects(
    service.startJob(OWNER_PHONE, {
      ...VALID_JOB,
      idempotencyKey: "spatial-readiness-service-0002",
    }),
    (error) => {
      assert.ok(error instanceof SpatialGeneratorServiceError);
      assert.equal(error.code, "SPATIAL_PIPELINE_NOT_READY");
      return true;
    },
  );

  assert.equal(transactionStarts, 0);
});
