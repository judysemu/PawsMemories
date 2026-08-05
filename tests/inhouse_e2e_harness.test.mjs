import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";

import {
  createPrivateWorkerBoundary,
  InHouseE2EError,
  runInHouseE2E,
} from "../scripts/run-inhouse-e2e.mjs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "local-e2e-test-secret-never-report";
const BLENDER_REVISION = "b".repeat(40);

function glb(json) {
  const jsonBytes = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, ...json }));
  const padded = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const bytes = Buffer.alloc(20 + padded.length);
  bytes.write("glTF", 0, "ascii");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(padded.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(bytes, 20);
  return bytes;
}

function baseGlb() {
  return glb({
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    accessors: [
      { count: 6, type: "VEC3", componentType: 5126, min: [-1, -1, -1], max: [1, 1, 1] },
      { count: 6, type: "SCALAR", componentType: 5125 },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri: "data:image/png;base64,AA==" }],
  });
}

function finalGlb() {
  return glb({
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, skin: 0 }, { name: "root" }, { name: "spine" }],
    meshes: [{ primitives: [{
      attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 },
      indices: 3,
      material: 0,
    }] }],
    accessors: [
      { count: 6, type: "VEC3", componentType: 5126, min: [-1, -1, -1], max: [1, 1, 1] },
      { count: 6, type: "VEC4", componentType: 5123 },
      { count: 6, type: "VEC4", componentType: 5126 },
      { count: 6, type: "SCALAR", componentType: 5125 },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri: "data:image/png;base64,AA==" }],
    skins: [{ joints: [1, 2] }],
    animations: [
      { name: "idle", samplers: [{}], channels: [{ sampler: 0, target: { node: 1, path: "rotation" } }] },
      { name: "walk", samplers: [{}], channels: [{ sampler: 0, target: { node: 2, path: "rotation" } }] },
    ],
  });
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
  });
  res.end(body);
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server.address().port;
}

test("one real local image completes the private TRELLIS -> Blender -> animated GLB acceptance", async (t) => {
  const base = baseGlb();
  const final = finalGlb();
  const baseHash = crypto.createHash("sha256").update(base).digest("hex");
  const finalHash = crypto.createHash("sha256").update(final).digest("hex");
  const requests = [];
  let finalized = false;
  let uploadedImageObserved = false;

  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    assert.equal(req.headers["x-worker-secret"], SECRET);
    if (req.method === "GET" && req.url === "/readyz") {
      return json(res, 200, {
        status: "ready",
        cuda: true,
        modelPresent: true,
        modelLoaded: true,
        modelBundleVerified: true,
        modelRevision: "af44b45f2e35a493886929c6d786e563ec68364d",
        sourceRevision: "75fbf0183001ed9876c8dbb35de6b68552ee08bd",
        runtimeRepositoryRevision: BLENDER_REVISION,
        runtimeRevisionVerified: true,
        blender: {
          status: "ready",
          bridgeConnected: true,
          version: "5.1.2",
          revision: BLENDER_REVISION,
        },
      });
    }
    if (req.method === "POST" && req.url === "/v1/jobs") {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      uploadedImageObserved = String(req.headers["content-type"] || "").startsWith("multipart/form-data;")
        && body.includes(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return json(res, 202, { id: JOB_ID, status: "queued" });
    }
    if (req.method === "POST" && req.url === `/v1/jobs/${JOB_ID}/finalize`) {
      finalized = true;
      return json(res, 202, { id: JOB_ID, status: "queued" });
    }
    if (req.method === "GET" && req.url === `/v1/jobs/${JOB_ID}/artifact`) {
      res.writeHead(200, {
        "content-type": "model/gltf-binary",
        "content-length": base.length,
        "x-artifact-sha256": baseHash,
      });
      return res.end(base);
    }
    if (req.method === "GET" && req.url === `/v1/jobs/${JOB_ID}/final-artifact`) {
      res.writeHead(200, {
        "content-type": "model/gltf-binary",
        "content-length": final.length,
        "x-artifact-sha256": finalHash,
      });
      return res.end(final);
    }
    if (req.method === "GET" && req.url === `/v1/jobs/${JOB_ID}`) {
      return json(res, 200, {
        id: JOB_ID,
        status: "succeeded",
        progress: 100,
        artifact: { url: `/v1/jobs/${JOB_ID}/artifact`, sha256: baseHash, bytes: base.length },
        ...(finalized ? {
          finalization: {
            status: "succeeded",
            progress: 100,
            clips: ["idle", "walk"],
            artifact: { url: `/v1/jobs/${JOB_ID}/final-artifact`, sha256: finalHash, bytes: final.length },
          },
        } : {}),
      });
    }
    return json(res, 404, { error: "not_found" });
  });
  const port = await listen(server);
  t.after(() => server.close());

  const folder = await mkdtemp(path.join(tmpdir(), "paws-inhouse-e2e-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const inputPath = path.join(folder, "real-pet.png");
  const outputPath = path.join(folder, "final.glb");
  const reportPath = path.join(folder, "report.json");
  await writeFile(inputPath, await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#8b6f47" },
  }).png().toBuffer());

  const previous = {
    modelRevision: process.env.TRELLIS_MODEL_REVISION,
    sourceRevision: process.env.TRELLIS_SOURCE_REVISION,
    blenderRevision: process.env.BLENDER_WORKER_REVISION,
  };
  process.env.TRELLIS_MODEL_REVISION = "af44b45f2e35a493886929c6d786e563ec68364d";
  process.env.TRELLIS_SOURCE_REVISION = "75fbf0183001ed9876c8dbb35de6b68552ee08bd";
  process.env.BLENDER_WORKER_REVISION = BLENDER_REVISION;
  t.after(() => {
    if (previous.modelRevision === undefined) delete process.env.TRELLIS_MODEL_REVISION;
    else process.env.TRELLIS_MODEL_REVISION = previous.modelRevision;
    if (previous.sourceRevision === undefined) delete process.env.TRELLIS_SOURCE_REVISION;
    else process.env.TRELLIS_SOURCE_REVISION = previous.sourceRevision;
    if (previous.blenderRevision === undefined) delete process.env.BLENDER_WORKER_REVISION;
    else process.env.BLENDER_WORKER_REVISION = previous.blenderRevision;
  });

  const workerUrl = `http://127.0.0.1:${port}`;
  const report = await runInHouseE2E({
    inputPath,
    outputPath,
    reportPath,
    workerUrl,
    sharedSecret: SECRET,
    pollIntervalMs: 0,
    timeoutMs: 5_000,
  });

  assert.equal(report.status, "PASS", JSON.stringify(report.failure));
  assert.equal(report.steps.every(({ status }) => status === "PASS"), true);
  assert.equal(report.network.externalCalls, 0);
  assert.equal(report.network.blockedAttempts, 0);
  assert.equal(report.network.totalCalls, 11);
  assert.equal(uploadedImageObserved, true);
  assert.equal(finalized, true);
  assert.deepEqual(await readFile(outputPath), final);
  assert.equal(report.output.sha256, finalHash);
  assert.equal(report.input.mimeType, "image/png");

  const persisted = await readFile(reportPath, "utf8");
  assert.equal(JSON.parse(persisted).status, "PASS");
  assert.equal(persisted.includes(SECRET), false);
  assert.equal(persisted.includes(workerUrl), false);
  assert.equal(requests.some(({ path: requestPath }) => /tripo|fal|huggingface/i.test(requestPath)), false);
});

test("network boundary blocks a public origin before downstream fetch", async () => {
  let downstreamCalls = 0;
  const boundary = createPrivateWorkerBoundary("http://127.0.0.1:8765", async () => {
    downstreamCalls += 1;
    throw new Error("must not run");
  });
  await assert.rejects(
    () => boundary.fetch("https://api.external.test/v1/jobs"),
    (error) => error instanceof InHouseE2EError && error.code === "EXTERNAL_NETWORK_BOUNDARY",
  );
  assert.equal(downstreamCalls, 0);
  assert.equal(boundary.evidence.blockedAttempts, 1);
  assert.equal(boundary.evidence.externalCalls, 0);
});

test("failure reports redact worker configuration and never contact a public worker", async () => {
  const secret = "do-not-print-this-secret";
  let fetchCalls = 0;
  const report = await runInHouseE2E({
    inputPath: "/not/read/before/configuration.png",
    outputPath: `/tmp/not-written-by-failed-inhouse-e2e-${crypto.randomUUID()}.glb`,
    workerUrl: "https://public-worker.example.test",
    sharedSecret: secret,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not run");
    },
  });
  const serialized = JSON.stringify(report);
  assert.equal(report.status, "FAIL");
  assert.equal(report.failure.code, "PRIVATE_WORKER_REQUIRED");
  assert.equal(fetchCalls, 0);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("public-worker.example.test"), false);
});

test("report target cannot overwrite the source image", async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "paws-inhouse-e2e-conflict-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const inputPath = path.join(folder, "source.png");
  const source = await sharp({
    create: { width: 16, height: 16, channels: 3, background: "#654321" },
  }).png().toBuffer();
  await writeFile(inputPath, source);
  let fetchCalls = 0;

  const report = await runInHouseE2E({
    inputPath,
    outputPath: path.join(folder, "final.glb"),
    reportPath: inputPath,
    workerUrl: "http://127.0.0.1:8765",
    sharedSecret: SECRET,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not run");
    },
  });

  assert.equal(report.status, "FAIL");
  assert.equal(report.failure.code, "OUTPUT_PATH_CONFLICT");
  assert.equal(fetchCalls, 0);
  assert.deepEqual(await readFile(inputPath), source);
});

test("a report created during the run is never overwritten without explicit authority", async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "paws-inhouse-e2e-report-race-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const inputPath = path.join(folder, "source.png");
  const reportPath = path.join(folder, "report.json");
  const sentinel = Buffer.from("created-by-another-process\n");
  await writeFile(inputPath, await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#456789" },
  }).png().toBuffer());

  const previous = process.env.BLENDER_WORKER_REVISION;
  process.env.BLENDER_WORKER_REVISION = BLENDER_REVISION;
  t.after(() => {
    if (previous === undefined) delete process.env.BLENDER_WORKER_REVISION;
    else process.env.BLENDER_WORKER_REVISION = previous;
  });

  let fetchCalls = 0;
  const report = await runInHouseE2E({
    inputPath,
    outputPath: path.join(folder, "final.glb"),
    reportPath,
    workerUrl: "http://127.0.0.1:8765",
    sharedSecret: SECRET,
    fetchImpl: async () => {
      fetchCalls += 1;
      await writeFile(reportPath, sentinel, { flag: "wx" });
      throw new Error("simulated worker failure after report-path check");
    },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(report.status, "FAIL");
  assert.equal(report.failure.code, "REPORT_WRITE_FAILED");
  assert.deepEqual(await readFile(reportPath), sentinel);
});

test("acceptance refuses a configured revision outside the committed TRELLIS lock", async (t) => {
  const previous = process.env.TRELLIS_SOURCE_REVISION;
  process.env.TRELLIS_SOURCE_REVISION = "0".repeat(40);
  t.after(() => {
    if (previous === undefined) delete process.env.TRELLIS_SOURCE_REVISION;
    else process.env.TRELLIS_SOURCE_REVISION = previous;
  });
  let fetchCalls = 0;
  const report = await runInHouseE2E({
    inputPath: "/not/read/before-lock-check.png",
    outputPath: `/tmp/not-written-by-lock-failure-${crypto.randomUUID()}.glb`,
    workerUrl: "http://127.0.0.1:8765",
    sharedSecret: SECRET,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not run");
    },
  });
  assert.equal(report.status, "FAIL");
  assert.equal(report.failure.code, "TRELLIS_LOCK_MISMATCH");
  assert.equal(fetchCalls, 0);
  assert.equal(JSON.stringify(report).includes(SECRET), false);
});
