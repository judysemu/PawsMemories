import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";

import {
  RigWorkerResultSchema,
  inspectFusedPrintGlb,
  verifyFusedPrintOutput,
  verifyWorkerOutput,
} from "../server/rig-pipeline/worker.ts";
import { persistRigWorkerResult } from "../server/rig-pipeline/resultPersistence.ts";

const JOB_UUID = "123e4567-e89b-42d3-a456-426614174000";
const ATTEMPT_UUID = "223e4567-e89b-42d3-a456-426614174000";
const ACCESSORY_UUID = "323e4567-e89b-42d3-a456-426614174000";
const SOURCE_HASH = "a".repeat(64);

async function tetrahedronGlb(name) {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document.createAccessor(`${name}-positions`)
    .setType("VEC3")
    .setArray(new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]))
    .setBuffer(buffer);
  const indices = document.createAccessor(`${name}-indices`)
    .setType("SCALAR")
    .setArray(new Uint16Array([
      0, 2, 1,
      0, 1, 3,
      1, 2, 3,
      2, 0, 3,
    ]))
    .setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", positions).setIndices(indices);
  const mesh = document.createMesh(name).addPrimitive(primitive);
  document.createScene("print-scene").addChild(document.createNode(name).setMesh(mesh));
  return Buffer.from(await new NodeIO().writeBinary(document));
}

function request(accessories = []) {
  return {
    contractVersion: 1,
    jobUuid: JOB_UUID,
    attemptUuid: ATTEMPT_UUID,
    idempotencyKey: "phase4-print-attempt-0001",
    profileId: "quadruped.dog.medium",
    classification: "quadruped",
    requestFacial: false,
    requestedFacialTargets: [],
    source: { locator: "https://assets.example.test/source.glb", sha256: SOURCE_HASH, sizeBytes: 1024 },
    budgets: { maxJoints: 128, maxInfluences: 4, maxTriangles: 100_000, maxTextureDimension: 2048 },
    accessories,
  };
}

function printRules() {
  return [
    { rule: "print_single_object", pass: true, detail: "one object" },
    { rule: "print_single_component", pass: true, detail: "one component" },
    { rule: "print_watertight", pass: true, detail: "zero non-manifold edges" },
    { rule: "print_finite_geometry", pass: true, detail: "finite vertices" },
  ];
}

function result(display, fusedPrint, overrides = {}) {
  return {
    contractVersion: 1,
    jobUuid: JOB_UUID,
    attemptUuid: ATTEMPT_UUID,
    sourceSha256: SOURCE_HASH,
    output: {
      glbBase64: display.toString("base64"),
      sha256: crypto.createHash("sha256").update(display).digest("hex"),
      sizeBytes: display.length,
    },
    rig: {
      validatorVersion: "test-rig-v1",
      metrics: {
        boneCount: 4,
        skinnedVertexCount: 4,
        maxInfluences: 2,
        unweightedIslands: 0,
        bindMatrixValid: true,
        animationSweepPass: true,
        silhouetteDeviation: 0.01,
        triangleCount: 4,
        textureMaxDimension: 0,
        jointCount: 4,
        boneNames: ["hip", "spine", "neck", "head"],
      },
      rules: [{ rule: "rig", pass: true, detail: "passed" }],
      overallPass: true,
    },
    facial: {
      capability: "body_only",
      targets: [],
      canonicalMap: {},
      hasBlink: false,
      hasJaw: false,
      hasEyeControls: false,
      rules: [{ rule: "facial_not_requested", pass: true, detail: "not requested" }],
    },
    renders: [],
    accessories: [],
    ...(fusedPrint ? {
      fusedPrint: {
        glbBase64: fusedPrint.toString("base64"),
        sha256: crypto.createHash("sha256").update(fusedPrint).digest("hex"),
        sizeBytes: fusedPrint.length,
        validatorVersion: "test-print-v1",
        metrics: {
          objectCount: 1,
          connectedComponents: 1,
          triangleCount: 4,
          nonManifoldEdges: 0,
          finiteGeometry: true,
          volumeCubicMeters: 1 / 6,
        },
        rules: printRules(),
        overallPass: true,
      },
    } : {}),
    warnings: [],
    ...overrides,
  };
}

const accessoryRequest = {
  accessoryUuid: ACCESSORY_UUID,
  attachmentBone: "head",
  locator: "https://assets.example.test/accessory.glb",
  sha256: "b".repeat(64),
  sizeBytes: 512,
};

test("verified fused print output is distinct, closed, finite, and measured", async () => {
  const display = await tetrahedronGlb("display-rigged");
  const print = await tetrahedronGlb("neutral-fused-print");
  const parsed = RigWorkerResultSchema.parse(result(display, print));
  const displayBytes = verifyWorkerOutput(request([accessoryRequest]), parsed);
  const verified = await verifyFusedPrintOutput(request([accessoryRequest]), parsed, displayBytes);
  assert.equal(verified.inspection.nonManifoldEdges, 0);
  assert.equal(verified.inspection.connectedComponents, 1);
  assert.equal((await inspectFusedPrintGlb(print)).triangleCount, 4);
});

test("forged fused print hash is rejected", async () => {
  const display = await tetrahedronGlb("display-rigged");
  const print = await tetrahedronGlb("neutral-fused-print");
  const value = result(display, print);
  value.fusedPrint.sha256 = "0".repeat(64);
  const parsed = RigWorkerResultSchema.parse(value);
  await assert.rejects(
    verifyFusedPrintOutput(request([accessoryRequest]), parsed, display),
    /hash mismatch/,
  );
});

test("display bytes cannot be reused as fused print output", async () => {
  const display = await tetrahedronGlb("same-output");
  const parsed = RigWorkerResultSchema.parse(result(display, display));
  await assert.rejects(
    verifyFusedPrintOutput(request([accessoryRequest]), parsed, display),
    /reuses the rigged display GLB/,
  );
});

test("nonpassing print rules cannot enter the bounded result contract", async () => {
  const display = await tetrahedronGlb("display-rigged");
  const print = await tetrahedronGlb("neutral-fused-print");
  const value = result(display, print);
  value.fusedPrint.rules[0].pass = false;
  assert.throws(() => RigWorkerResultSchema.parse(value), /fused print artifact|Invalid input/i);
});

test("no accessories means no print derivative, while accessories require output or typed failure", async () => {
  const display = await tetrahedronGlb("display-only");
  const bodyOnly = RigWorkerResultSchema.parse(result(display, null));
  assert.equal(verifyWorkerOutput(request(), bodyOnly).equals(display), true);
  assert.equal(await verifyFusedPrintOutput(request(), bodyOnly, display), null);

  assert.throws(
    () => verifyWorkerOutput(request([accessoryRequest]), bodyOnly),
    /required fused print result or typed failure/,
  );
  const failedPrint = RigWorkerResultSchema.parse(result(display, null, {
    fusedPrintFailure: { code: "PRINT_BOOLEAN_FAILED", message: "exact union did not produce one closed component" },
  }));
  assert.equal(verifyWorkerOutput(request([accessoryRequest]), failedPrint).equals(display), true);
});

test("persistence registers a private fused derivative with display and accessory lineage", async () => {
  const display = await tetrahedronGlb("display-rigged");
  const print = await tetrahedronGlb("neutral-fused-print");
  const parsed = RigWorkerResultSchema.parse(result(display, print));
  const registered = [];
  const lineages = [];
  let id = 10;
  const persisted = await persistRigWorkerResult({
    pool: {},
    ownerId: "owner-1",
    jobUuid: JOB_UUID,
    attemptUuid: ATTEMPT_UUID,
    sourceAsset: { id: 1, asset_uuid: "423e4567-e89b-42d3-a456-426614174000", owner_id: "owner-1", status: "active" },
    sourceVersion: { id: 1, version_number: 1, license: "proprietary", commercial_use_eligible: false },
    accessorySources: [{
      asset: { id: 2, asset_uuid: "523e4567-e89b-42d3-a456-426614174000", owner_id: "owner-1", status: "active" },
      version: { id: 2, version_number: 3 },
    }],
    outputBuffer: display,
    fusedPrintBuffer: print,
    result: parsed,
    manifest: { measured: true },
  }, {
    storeObject: async (_job, _attempt, role, _extension, _mime, bytes) => ({
      objectKey: `models/test/${role}`,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    }),
    register: async (input) => {
      id += 1;
      registered.push(input);
      return {
        asset: { id, asset_uuid: `${String(id).padStart(8, "0")}-1111-4111-8111-111111111111`, owner_id: input.ownerId, status: "active" },
        version: { id, asset_id: id, version_number: 1, sha256: input.sha256, size_bytes: input.sizeBytes, mime_type: input.mimeType },
      };
    },
    addArtifactLineage: async (input) => { lineages.push(input); },
  });

  assert.equal(persisted.fusedPrint.role, "fused_print_glb");
  const displayRegistration = registered.find((entry) => entry.metadata?.role === "rigged_glb");
  const printRegistration = registered.find((entry) => entry.metadata?.role === "fused_print_glb");
  assert.equal(displayRegistration.metadata.printReady, undefined);
  assert.equal(printRegistration.visibility, "private");
  assert.equal(printRegistration.metadata.printReady, true);
  assert.ok(lineages.some((entry) => entry.parentAssetUuid === persisted.output.asset.asset_uuid
    && entry.childAssetUuid === persisted.fusedPrint.asset.asset_uuid));
  assert.ok(lineages.some((entry) => entry.parentAssetUuid === "523e4567-e89b-42d3-a456-426614174000"
    && entry.childAssetUuid === persisted.fusedPrint.asset.asset_uuid));
});
