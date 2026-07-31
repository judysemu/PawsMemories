import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import { createSpatialGeneratorRouter } from "../server/spatial-generator/routes.ts";
import { SpatialGeneratorServiceError } from "../server/spatial-generator/service.ts";

const ADMIN_PHONE = "+15550000001";

const VALID_COLLAR_REQUEST = {
  idempotencyKey: "collar_job_000001",
  targetAssetVersionId: 1,
  sizeClass: "medium_dog",
  neckCircumferenceMm: 400,
  strapWidthMm: 25,
  clearanceMm: 10,
  strapThicknessMm: 3,
  color: "#2563eb",
  includeBuckle: true,
  includeDRing: true,
  targetUse: "attachment",
};

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function makeApp({ service, isAdmin = async (phone) => phone === ADMIN_PHONE }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const phone = req.get("x-user-phone");
    if (phone) req.user = { phone };
    next();
  });
  app.use("/api/spatial-generator", createSpatialGeneratorRouter({ service, isAdmin }));
  return app;
}

test("admin health remains available while the spatial feature is disabled and is not cached", async (t) => {
  const previousFlag = process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED;
  t.after(() => restoreEnv("INHOUSE_SPATIAL_GENERATOR_ENABLED", previousFlag));
  process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED = "false";

  const health = {
    ready: false,
    featureEnabled: false,
    layer8Configured: true,
    pixelWorkerOnline: false,
    blenderWorkerHealthy: false,
    activeJobs: 0,
    queuedAttempts: 0,
  };
  let healthCalls = 0;
  const app = makeApp({
    service: {
      getHealthStatus: async () => {
        healthCalls += 1;
        return health;
      },
    },
  });

  const response = await request(app)
    .get("/api/spatial-generator/health")
    .set("x-user-phone", ADMIN_PHONE);

  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.body, health);
  assert.equal(healthCalls, 1);
});

test("spatial health remains restricted to administrators", async (t) => {
  const previousFlag = process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED;
  t.after(() => restoreEnv("INHOUSE_SPATIAL_GENERATOR_ENABLED", previousFlag));
  process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED = "false";

  let healthCalls = 0;
  const app = makeApp({
    service: {
      getHealthStatus: async () => {
        healthCalls += 1;
        return { ready: false };
      },
    },
  });

  const unauthenticated = await request(app).get("/api/spatial-generator/health");
  const nonAdmin = await request(app)
    .get("/api/spatial-generator/health")
    .set("x-user-phone", "+15550000002");

  assert.equal(unauthenticated.status, 401);
  assert.equal(nonAdmin.status, 403);
  assert.equal(healthCalls, 0);
});

test("collar job routes remain feature-gated", async (t) => {
  const previousFlag = process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED;
  t.after(() => restoreEnv("INHOUSE_SPATIAL_GENERATOR_ENABLED", previousFlag));
  process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED = "false";

  let healthCalls = 0;
  let startCalls = 0;
  const app = makeApp({
    service: {
      getHealthStatus: async () => {
        healthCalls += 1;
        return { ready: true };
      },
      startJob: async () => {
        startCalls += 1;
        return { jobUuid: "not-created" };
      },
    },
  });

  const response = await request(app)
    .post("/api/spatial-generator/collar/jobs")
    .set("x-user-phone", ADMIN_PHONE)
    .send(VALID_COLLAR_REQUEST);

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: "In-house spatial generator is disabled" });
  assert.equal(healthCalls, 0);
  assert.equal(startCalls, 0);
});

test("unready collar submission fails closed without starting or exposing health details", async (t) => {
  const previousFlag = process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED;
  t.after(() => restoreEnv("INHOUSE_SPATIAL_GENERATOR_ENABLED", previousFlag));
  process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED = "true";

  let healthCalls = 0;
  let startCalls = 0;
  const app = makeApp({
    service: {
      getHealthStatus: async () => {
        healthCalls += 1;
        return {
          ready: false,
          featureEnabled: true,
          layer8Configured: true,
          pixelWorkerOnline: false,
          blenderWorkerHealthy: false,
          orchestratorReady: false,
          activeJobs: 4,
          queuedAttempts: 3,
          privateWorkerUrl: "https://secret-worker.invalid",
        };
      },
      startJob: async () => {
        startCalls += 1;
        return { jobUuid: "must-not-be-created" };
      },
    },
  });

  const response = await request(app)
    .post("/api/spatial-generator/collar/jobs")
    .set("x-user-phone", ADMIN_PHONE)
    .send(VALID_COLLAR_REQUEST);

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    error: "SPATIAL_PIPELINE_NOT_READY",
    blockers: ["pixel_worker", "blender_worker", "orchestrator"],
  });
  assert.doesNotMatch(JSON.stringify(response.body), /secret-worker|invalid|activeJobs|queuedAttempts/);
  assert.equal(healthCalls, 1);
  assert.equal(startCalls, 0);
});

test("generic spatial creation also fails closed before startJob", async (t) => {
  const previousFlag = process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED;
  t.after(() => restoreEnv("INHOUSE_SPATIAL_GENERATOR_ENABLED", previousFlag));
  process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED = "true";

  let startCalls = 0;
  const app = makeApp({
    service: {
      getHealthStatus: async () => ({
        ready: false,
        featureEnabled: true,
        layer8Configured: true,
        pixelWorkerOnline: false,
        blenderWorkerHealthy: false,
        orchestratorReady: false,
      }),
      startJob: async () => {
        startCalls += 1;
        return { jobUuid: "must-not-be-created" };
      },
    },
  });

  const response = await request(app)
    .post("/api/spatial-generator/jobs")
    .set("x-user-phone", ADMIN_PHONE)
    .send({
      idempotencyKey: "spatial_job_000001",
      subjectKind: "accessory",
      targetUse: "attachment",
      prompt: "Build a measured collar",
      targetEnvelopeMm: { x: 150, y: 150, z: 25 },
      referenceAssetVersionIds: [],
      scaleAnchor: { axis: "x", millimeters: 400, label: "neck circumference" },
      attachment: { targetAssetVersionId: 1, clearanceMm: 10 },
    });

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    error: "SPATIAL_PIPELINE_NOT_READY",
    blockers: ["pixel_worker", "blender_worker", "orchestrator"],
  });
  assert.equal(startCalls, 0);
});

test("a spoofed ready aggregate cannot bypass a missing readiness component", async (t) => {
  const previousFlag = process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED;
  t.after(() => restoreEnv("INHOUSE_SPATIAL_GENERATOR_ENABLED", previousFlag));
  process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED = "true";

  let startCalls = 0;
  const app = makeApp({
    service: {
      getHealthStatus: async () => ({
        ready: true,
        featureEnabled: true,
        layer8Configured: true,
        pixelWorkerOnline: true,
        blenderWorkerHealthy: true,
        blockers: [],
        activeJobs: 0,
        queuedAttempts: 0,
      }),
      startJob: async () => {
        startCalls += 1;
        return { jobUuid: "must-not-be-created" };
      },
    },
  });

  const response = await request(app)
    .post("/api/spatial-generator/collar/jobs")
    .set("x-user-phone", ADMIN_PHONE)
    .send(VALID_COLLAR_REQUEST);

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    error: "SPATIAL_PIPELINE_NOT_READY",
    blockers: ["orchestrator"],
  });
  assert.equal(startCalls, 0);
});

test("readiness lost after the route check remains a sanitized 503", async (t) => {
  const previousFlag = process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED;
  t.after(() => restoreEnv("INHOUSE_SPATIAL_GENERATOR_ENABLED", previousFlag));
  process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED = "true";

  const app = makeApp({
    service: {
      getHealthStatus: async () => ({
        ready: true,
        featureEnabled: true,
        layer8Configured: true,
        pixelWorkerOnline: true,
        blenderWorkerHealthy: true,
        orchestratorReady: true,
        blockers: [],
        activeJobs: 0,
        queuedAttempts: 0,
      }),
      startJob: async () => {
        throw new SpatialGeneratorServiceError(
          "SPATIAL_PIPELINE_NOT_READY",
          "private worker detail must not escape",
        );
      },
    },
  });

  const response = await request(app)
    .post("/api/spatial-generator/collar/jobs")
    .set("x-user-phone", ADMIN_PHONE)
    .send(VALID_COLLAR_REQUEST);

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    error: "SPATIAL_PIPELINE_NOT_READY",
    blockers: ["readiness_stale"],
  });
  assert.doesNotMatch(JSON.stringify(response.body), /private worker detail/);
});
