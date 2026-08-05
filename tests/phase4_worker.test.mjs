import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RigPipelineError,
  acquireVerifiedAsset,
  createSharedArtifactResolver,
  createRigPipelineProcessor,
  createWorkerAuthMiddleware,
  inspectGlb,
  isPrivateAddress,
  readVerifiedSharedArtifact,
  validateRigPipelineRequest,
  validateSourceUrl,
} from "../blender-worker/rig_pipeline/index.js";
import { RigWorkerRequestSchema, RigWorkerResultSchema } from "../server/rig-pipeline/worker.ts";

const JOB_UUID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_UUID = "22222222-2222-4222-8222-222222222222";
const PNG_BASE64 = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

function makeTriangleGlb(targetNames = [], boneNames = []) {
  const meshNode = { mesh: 0, ...(boneNames.length ? { skin: 0 } : {}) };
  const nodes = [meshNode, ...boneNames.map((name) => ({ name }))];
  const document = {
    asset: { version: "2.0", generator: "phase4-worker-test" },
    accessors: [
      { componentType: 5126, count: 3, type: "VEC3" },
      ...targetNames.map(() => ({ componentType: 5126, count: 3, type: "VEC3" })),
    ],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0 },
        mode: 4,
        ...(targetNames.length ? { targets: targetNames.map((_, index) => ({ POSITION: index + 1 })) } : {}),
      }],
      ...(targetNames.length ? { extras: { targetNames } } : {}),
    }],
    nodes,
    ...(boneNames.length ? { skins: [{ joints: boneNames.map((_, index) => index + 1) }] } : {}),
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const json = Buffer.from(JSON.stringify(document));
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const output = Buffer.alloc(20 + padded.length);
  output.write("glTF", 0, "ascii");
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(padded.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(output, 20);
  return output;
}

function makeRequest(source, overrides = {}) {
  return {
    contractVersion: 1,
    jobUuid: JOB_UUID,
    attemptUuid: ATTEMPT_UUID,
    idempotencyKey: "phase4-worker-attempt-0001",
    profileId: "quadruped.dog.medium",
    classification: "quadruped",
    requestFacial: true,
    requestedFacialTargets: ["A", "B", "C", "D", "E", "F", "G", "H", "X", "jawOpen", "eyeBlinkLeft", "eyeBlinkRight"],
    source: {
      locator: "https://signed-assets.example/source.glb?token=secret",
      sha256: crypto.createHash("sha256").update(source).digest("hex"),
      sizeBytes: source.length,
    },
    budgets: { maxJoints: 128, maxInfluences: 4, maxTriangles: 100_000, maxTextureDimension: 4096 },
    accessories: [],
    ...overrides,
  };
}

function passingRule(rule) {
  return { rule, pass: true, detail: `${rule} passed`, measured: 1 };
}

function makeBodyOnlyRaw() {
  return {
    sourceTargetNames: [],
    outputTargetNames: [],
    rig: {
      metrics: {
        boneCount: 4,
        skinnedVertexCount: 3,
        maxInfluences: 2,
        unweightedIslands: 0,
        bindMatrixValid: true,
        animationSweepPass: true,
        silhouetteDeviation: 0.02,
        triangleCount: 1,
        textureMaxDimension: 1024,
        jointCount: 4,
        boneNames: ["hip", "spine", "head", "jaw"],
      },
      rules: [passingRule("body_rig_measured")],
      overallPass: true,
    },
    facial: {
      capability: "body_only",
      targets: [],
      hasEyeControls: false,
      rules: [passingRule("safe_body_only_fallback")],
    },
    renders: [],
    accessories: [],
    warnings: ["No semantic face regions; facial targets were not fabricated."],
  };
}

function makeProcessor(source, options = {}) {
  let calls = 0;
  const raw = options.raw || makeBodyOnlyRaw();
  const runner = options.runner || (async () => {
    calls += 1;
    if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
    return { raw, outputBuffer: options.outputBuffer || makeTriangleGlb(raw.outputTargetNames || [], raw.rig.metrics.boneNames) };
  });
  const processor = createRigPipelineProcessor({
    acquireAsset: async () => source,
    runner,
  });
  return { processor, calls: () => calls };
}

function mockResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test("worker request validator matches the lead RigWorkerRequestSchema", () => {
  const source = makeTriangleGlb();
  const request = makeRequest(source);
  assert.deepEqual(validateRigPipelineRequest(request), RigWorkerRequestSchema.parse(request));
  assert.throws(
    () => validateRigPipelineRequest({ ...request, unexpected: true }),
    (error) => error instanceof RigPipelineError && error.code === "INVALID_REQUEST",
  );
});

test("honest body-only output matches the lead RigWorkerResultSchema exactly", async () => {
  const source = makeTriangleGlb();
  const { processor } = makeProcessor(source);
  const result = await processor.process(makeRequest(source));
  assert.equal(result.facial.capability, "body_only");
  assert.deepEqual(result.renders, []);
  assert.equal(result.facial.rules.every((rule) => rule.pass), true);
  assert.deepEqual(RigWorkerResultSchema.parse(result), result);
  assert.deepEqual(Object.keys(result).sort(), ["accessories", "attemptUuid", "contractVersion", "facial", "jobUuid", "output", "renders", "rig", "sourceSha256", "warnings"].sort());
});

test("concurrent identical idempotency requests execute Blender once", async () => {
  const source = makeTriangleGlb();
  const { processor, calls } = makeProcessor(source, { delay: 25 });
  const request = makeRequest(source);
  const [first, second] = await Promise.all([processor.process(request), processor.process(request)]);
  assert.equal(calls(), 1);
  assert.deepEqual(first, second);
});

test("idempotency key cannot be reused with another request", async () => {
  const source = makeTriangleGlb();
  const { processor } = makeProcessor(source);
  const request = makeRequest(source);
  await processor.process(request);
  await assert.rejects(
    processor.process({ ...request, requestFacial: false }),
    (error) => error instanceof RigPipelineError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("source hash mismatch is rejected before Blender", async () => {
  const source = makeTriangleGlb();
  let runnerCalled = false;
  const processor = createRigPipelineProcessor({
    acquireAsset: async () => source,
    runner: async () => { runnerCalled = true; throw new Error("must not run"); },
  });
  const request = makeRequest(source);
  request.source.sha256 = "0".repeat(64);
  await assert.rejects(
    processor.process(request),
    (error) => error instanceof RigPipelineError && error.code === "SOURCE_HASH_MISMATCH",
  );
  assert.equal(runnerCalled, false);
});

test("malformed GLB is rejected before Blender", async () => {
  const malformed = Buffer.from("not a glb payload");
  const processor = createRigPipelineProcessor({
    acquireAsset: async () => malformed,
    runner: async () => { throw new Error("must not run"); },
  });
  await assert.rejects(
    processor.process(makeRequest(malformed)),
    (error) => error instanceof RigPipelineError && error.code === "MALFORMED_GLB",
  );
  assert.throws(() => inspectGlb(malformed), /GLB/);
});

test("unknown or classification-mismatched profile is rejected", async () => {
  const source = makeTriangleGlb();
  const { processor } = makeProcessor(source);
  await assert.rejects(
    processor.process(makeRequest(source, { profileId: "quadruped.missing" })),
    (error) => error instanceof RigPipelineError && error.code === "INVALID_PROFILE",
  );
  await assert.rejects(
    processor.process(makeRequest(source, { classification: "biped", idempotencyKey: "phase4-worker-attempt-0002" })),
    (error) => error instanceof RigPipelineError && error.code === "INVALID_PROFILE",
  );
});

test("worker auth fails closed for missing config, missing auth, and bad auth", () => {
  const req = (secret) => ({ get: () => secret });
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };

  const noConfigResponse = mockResponse();
  createWorkerAuthMiddleware({ secret: "" })(req(""), noConfigResponse, next);
  assert.equal(noConfigResponse.statusCode, 503);
  assert.equal(noConfigResponse.payload.code, "WORKER_AUTH_NOT_CONFIGURED");

  const middleware = createWorkerAuthMiddleware({ secret: "a-secure-worker-secret-value" });
  const missingResponse = mockResponse();
  middleware(req(undefined), missingResponse, next);
  assert.equal(missingResponse.statusCode, 401);

  const badResponse = mockResponse();
  middleware(req("wrong-secret"), badResponse, next);
  assert.equal(badResponse.statusCode, 401);

  middleware(req("a-secure-worker-secret-value"), mockResponse(), next);
  assert.equal(nextCalls, 1);
});

test("source URL checks reject non-HTTPS, unlisted, and private DNS targets", async () => {
  const publicLookup = async () => [{ address: "203.0.113.10", family: 4 }];
  await assert.rejects(validateSourceUrl("http://signed-assets.example/model.glb", {
    allowedHosts: new Set(["signed-assets.example"]), dnsLookup: publicLookup,
  }), (error) => error.code === "SOURCE_URL_REJECTED");
  await assert.rejects(validateSourceUrl("https://other.example/model.glb", {
    allowedHosts: new Set(["signed-assets.example"]), dnsLookup: publicLookup,
  }), (error) => error.code === "SOURCE_HOST_REJECTED");
  await assert.rejects(validateSourceUrl("https://signed-assets.example/model.glb", {
    allowedHosts: new Set(["signed-assets.example"]), dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
  }), (error) => error.code === "SOURCE_HOST_REJECTED");
  assert.equal(isPrivateAddress("10.0.0.1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});

test("shared artifact resolver reads only a verified job artifact from its configured volume", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paws-shared-artifacts-"));
  const source = makeTriangleGlb();
  const jobDirectory = path.join(root, JOB_UUID);
  fs.mkdirSync(jobDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(jobDirectory, "master.glb"), source, { mode: 0o600 });
  const asset = {
    locator: `artifact+local://model-builds/${JOB_UUID}/master.glb`,
    sha256: crypto.createHash("sha256").update(source).digest("hex"),
    sizeBytes: source.length,
  };
  try {
    assert.deepEqual(readVerifiedSharedArtifact(asset, { sharedArtifactsDirectory: root }), source);
    assert.throws(
      () => readVerifiedSharedArtifact({ ...asset, locator: `artifact+local://model-builds/${JOB_UUID}/../master.glb` }, { sharedArtifactsDirectory: root }),
      (error) => error instanceof RigPipelineError && error.code === "SOURCE_URL_REJECTED",
    );
    assert.throws(
      () => readVerifiedSharedArtifact({ ...asset, sha256: "0".repeat(64) }, { sharedArtifactsDirectory: root }),
      (error) => error instanceof RigPipelineError && error.code === "SOURCE_HASH_MISMATCH",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shared artifact resolver fails closed when its volume is not configured", () => {
  const source = makeTriangleGlb();
  const asset = {
    locator: `artifact+local://model-builds/${JOB_UUID}/master.glb`,
    sha256: crypto.createHash("sha256").update(source).digest("hex"),
    sizeBytes: source.length,
  };
  assert.throws(
    () => readVerifiedSharedArtifact(asset, { sharedArtifactsDirectory: "" }),
    (error) => error instanceof RigPipelineError && error.code === "SHARED_SOURCE_NOT_CONFIGURED",
  );
});

test("artifact resolver registry is replaceable and rejects ambiguous or unsupported locators", async () => {
  const source = makeTriangleGlb();
  const asset = {
    locator: "memory://fixture/source.glb",
    sha256: crypto.createHash("sha256").update(source).digest("hex"),
    sizeBytes: source.length,
  };
  const memoryResolver = {
    name: "memory-fixture",
    supports: (candidate) => candidate.locator.startsWith("memory://"),
    acquire: async () => source,
  };
  assert.deepEqual(await acquireVerifiedAsset(asset, { resolvers: [memoryResolver] }), source);
  await assert.rejects(
    acquireVerifiedAsset(asset, { resolvers: [] }),
    (error) => error instanceof RigPipelineError && error.code === "SOURCE_SCHEME_REJECTED",
  );
  await assert.rejects(
    acquireVerifiedAsset(asset, { resolvers: [memoryResolver, { ...memoryResolver, name: "duplicate" }] }),
    (error) => error instanceof RigPipelineError && error.code === "SOURCE_RESOLVER_AMBIGUOUS",
  );
});

test("shared artifact resolver can be injected into the processor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paws-resolver-injection-"));
  const source = makeTriangleGlb();
  const jobDirectory = path.join(root, JOB_UUID);
  fs.mkdirSync(jobDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(jobDirectory, "master.glb"), source, { mode: 0o600 });
  let runnerCalls = 0;
  const processor = createRigPipelineProcessor({
    assetResolvers: [createSharedArtifactResolver({ sharedArtifactsDirectory: root })],
    runner: async () => {
      runnerCalls += 1;
      const raw = makeBodyOnlyRaw();
      return { raw, outputBuffer: makeTriangleGlb([], raw.rig.metrics.boneNames) };
    },
  });
  try {
    const result = await processor.process(makeRequest(source, {
      source: {
        locator: `artifact+local://model-builds/${JOB_UUID}/master.glb`,
        sha256: crypto.createHash("sha256").update(source).digest("hex"),
        sizeBytes: source.length,
      },
    }));
    assert.equal(result.rig.overallPass, true);
    assert.equal(runnerCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("full facial output requires A-H/X, jaw, blink, and exactly two renders", async () => {
  const source = makeTriangleGlb();
  const targetNames = ["A", "B", "C", "D", "E", "F", "G", "H", "X", "jawOpen", "eyeBlinkLeft", "eyeBlinkRight"];
  const raw = makeBodyOnlyRaw();
  raw.facial = {
    capability: "full",
    hasEyeControls: true,
    targets: targetNames.map((name) => ({
      name,
      canonicalName: name,
      displacedVertexCount: 12,
      maxDisplacement: 0.01,
      localityPass: true,
      deformationPass: true,
    })),
    rules: [passingRule("localized_deformation")],
  };
  raw.outputTargetNames = targetNames;
  raw.renders = [
    { role: "facial_render_front", pngBase64: PNG_BASE64 },
    { role: "facial_render_three_quarter", pngBase64: PNG_BASE64 },
  ];
  const { processor } = makeProcessor(source, { raw, outputBuffer: makeTriangleGlb(targetNames, raw.rig.metrics.boneNames) });
  const result = await processor.process(makeRequest(source));
  assert.equal(result.facial.capability, "full");
  assert.equal(result.facial.hasBlink, true);
  assert.equal(result.facial.hasJaw, true);
  assert.equal(result.renders.length, 2);
  assert.deepEqual(RigWorkerResultSchema.parse(result), result);
});

test("source and authored target names must survive in the exported GLB", async () => {
  const source = makeTriangleGlb(["Smile"]);
  const raw = makeBodyOnlyRaw();
  raw.sourceTargetNames = ["Smile"];
  raw.outputTargetNames = ["Smile"];
  const { processor } = makeProcessor(source, { raw });
  assert.deepEqual(RigWorkerResultSchema.parse(await processor.process(makeRequest(source))), await processor.process(makeRequest(source)));

  const missingOutput = makeTriangleGlb([], raw.rig.metrics.boneNames);
  const failed = makeProcessor(source, { raw, outputBuffer: missingOutput }).processor;
  await assert.rejects(
    failed.process(makeRequest(source, { idempotencyKey: "phase4-worker-attempt-target-loss" })),
    (error) => error instanceof RigPipelineError && error.code === "SOURCE_TARGETS_LOST",
  );
});

test("rig route is mounted with auth and bridge gates before the global error handler", () => {
  const source = fs.readFileSync(new URL("../blender-worker/server.js", import.meta.url), "utf8");
  const routeIndex = source.indexOf('app.post(\n  "/rig-pipeline/process"');
  const globalParserIndex = source.indexOf('app.use(express.json({ limit: "100mb" }))');
  const errorHandlerIndex = source.indexOf("// Global error handler");
  assert.ok(routeIndex > 0, "rig pipeline route must be mounted");
  assert.ok(globalParserIndex > routeIndex, "worker auth and bounded route parser must run before the legacy parser");
  assert.ok(errorHandlerIndex > routeIndex, "route must be mounted before the global error handler");
  const routeBlock = source.slice(routeIndex, routeIndex + 360);
  assert.match(routeBlock, /createWorkerAuthMiddleware\(\)/);
  assert.match(routeBlock, /requireBridge/);
  assert.match(routeBlock, /express\.json\(\{ limit: RIG_PIPELINE_MAX_REQUEST_BYTES \}\)/);
  assert.match(routeBlock, /createRigPipelineHandler\(rigPipelineProcessor\)/);
  assert.match(source, /app\.use\(express\.json\(\{ limit: "100mb" \}\)\)/);
});
