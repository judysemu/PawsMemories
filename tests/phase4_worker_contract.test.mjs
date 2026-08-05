import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  RigWorkerResultSchema,
  createRigWorkerRequest,
  verifyWorkerOutput,
} from "../server/rig-pipeline/worker.ts";

const JOB_UUID = "123e4567-e89b-42d3-a456-426614174000";
const ATTEMPT_UUID = "223e4567-e89b-42d3-a456-426614174000";
const SOURCE_HASH = "a".repeat(64);

function minimalGlb() {
  const bytes = Buffer.alloc(20);
  bytes.write("glTF", 0, "ascii");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(0, 12);
  bytes.write("JSON", 16, "ascii");
  return bytes;
}

function request() {
  return createRigWorkerRequest({
    jobUuid: JOB_UUID,
    attemptUuid: ATTEMPT_UUID,
    idempotencyKey: "rig-attempt-0001",
    profileId: "quadruped.dog.medium",
    classification: "quadruped",
    requestFacial: true,
    source: {
      locator: "https://assets.example.test/source.glb?signature=test",
      sha256: SOURCE_HASH,
      sizeBytes: 1024,
    },
    accessories: [],
  });
}

function completeResult(overrides = {}) {
  const glb = minimalGlb();
  const targets = ["A", "B", "C", "D", "E", "F", "G", "H", "X", "jawOpen", "eyeBlinkLeft", "eyeBlinkRight"]
    .map((canonicalName) => ({
      name: canonicalName,
      canonicalName,
      displacedVertexCount: 40,
      maxDisplacement: 0.02,
      localityPass: true,
      deformationPass: true,
    }));
  return {
    contractVersion: 1,
    jobUuid: JOB_UUID,
    attemptUuid: ATTEMPT_UUID,
    sourceSha256: SOURCE_HASH,
    output: {
      glbBase64: glb.toString("base64"),
      sha256: crypto.createHash("sha256").update(glb).digest("hex"),
      sizeBytes: glb.length,
    },
    rig: {
      validatorVersion: "blender-rig-v1",
      metrics: {
        boneCount: 32,
        skinnedVertexCount: 1200,
        maxInfluences: 4,
        unweightedIslands: 0,
        bindMatrixValid: true,
        animationSweepPass: true,
        silhouetteDeviation: 0.002,
        triangleCount: 5000,
        textureMaxDimension: 1024,
        jointCount: 32,
        boneNames: ["root", "spine", "head", "jaw"],
      },
      rules: [{ rule: "worker_deformation_sweep", pass: true, detail: "Measured sweep passed" }],
      overallPass: true,
    },
    facial: {
      capability: "full",
      targets,
      canonicalMap: Object.fromEntries(targets.map((target) => [target.name, target.canonicalName])),
      hasBlink: true,
      hasJaw: true,
      hasEyeControls: true,
      rules: [{ rule: "facial_locality", pass: true, detail: "Measured localized deformation passed" }],
    },
    renders: [],
    accessories: [],
    warnings: [],
    ...overrides,
  };
}

test("Phase 4 rig worker contract", async (t) => {
  await t.test("creates a bounded request with canonical facial targets", () => {
    const parsed = request();
    assert.equal(parsed.budgets.maxInfluences, 4);
    assert.deepEqual(parsed.requestedFacialTargets.slice(0, 9), ["A", "B", "C", "D", "E", "F", "G", "H", "X"]);
    assert.throws(() => ({ ...parsed, unexpected: true }) && createRigWorkerRequest({ ...parsed, unexpected: true }));
  });

  await t.test("accepts a complete facial result and verifies GLB identity and hash", () => {
    const result = RigWorkerResultSchema.parse(completeResult());
    const output = verifyWorkerOutput(request(), result);
    assert.equal(output.subarray(0, 4).toString("ascii"), "glTF");
  });

  await t.test("rejects a claimed full facial rig without all canonical visemes", () => {
    const value = completeResult();
    value.facial.targets = value.facial.targets.filter((target) => target.canonicalName !== "X");
    assert.throws(() => RigWorkerResultSchema.parse(value));
  });

  await t.test("rejects tampered worker output bytes", () => {
    const result = RigWorkerResultSchema.parse(completeResult());
    result.output.glbBase64 = Buffer.from("tampered").toString("base64");
    assert.throws(() => verifyWorkerOutput(request(), result), /byte count|GLB|hash mismatch/);
  });
});
