import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { TrellisModelBuildAdapter } from "../server/model-builds/trellisProvider.ts";
import { selectedPaws3dProvider } from "../server/model-builds/configuredProvider.ts";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const BLENDER_REVISION = "a".repeat(40);
process.env.BLENDER_WORKER_REVISION = BLENDER_REVISION;

function readyPayload() {
  return {
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
  };
}

function minimalGlb() {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  return bytes;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("TRELLIS provider submits approved bytes only to the private worker", async () => {
  const calls = [];
  const fetchImpl = async (request, init = {}) => {
    const url = new URL(String(request));
    calls.push({ url, init });
    if (url.hostname === "assets.internal.test") {
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }
    assert.equal(url.hostname, "10.42.2.10");
    if (url.pathname === "/readyz") {
      return jsonResponse(readyPayload());
    }
    assert.equal(url.pathname, "/v1/jobs");
    assert.equal(init.headers["x-worker-secret"], "test-worker-secret");
    assert.ok(init.body instanceof FormData);
    assert.equal(await init.body.get("image").arrayBuffer().then((value) => Buffer.from(value).equals(PNG)), true);
    return jsonResponse({ id: JOB_ID, status: "queued" }, 202);
  };
  const provider = new TrellisModelBuildAdapter({
    baseUrl: "http://10.42.2.10:8000",
    sharedSecret: "test-worker-secret",
    fetchImpl,
    referenceHosts: ["assets.internal.test"],
  });
  const result = await provider.start({
    frontUrl: "https://assets.internal.test/signed/front.png",
    leftUrl: "https://assets.internal.test/signed/left.png",
    rightUrl: "https://assets.internal.test/signed/right.png",
    rearUrl: "https://assets.internal.test/signed/rear.png",
  }, "12345678abcdef");
  assert.deepEqual(result, {
    providerTaskHandle: `trellis2:${JOB_ID}`,
    provider: "trellis2",
    model: "microsoft/TRELLIS.2-4B@af44b45f2e35a493886929c6d786e563ec68364d",
  });
  assert.equal(calls.length, 3, "one reference read, one final readiness proof, and one worker submission");
  assert.equal(calls.some(({ url }) => /tripo|fal\.ai|huggingface/i.test(url.hostname)), false);
});

test("TRELLIS provider proves authenticated locked-model readiness before charge", async () => {
  const calls = [];
  const provider = new TrellisModelBuildAdapter({
    baseUrl: "http://10.42.2.10:8000",
    sharedSecret: "test-worker-secret",
    referenceHosts: [],
    fetchImpl: async (request, init = {}) => {
      const url = new URL(String(request));
      calls.push(url.pathname);
      assert.equal(init.headers["x-worker-secret"], "test-worker-secret");
      return jsonResponse(readyPayload());
    },
  });
  await provider.preflightForCharge();
  assert.deepEqual(calls, ["/readyz"]);
});

test("TRELLIS provider requires Blender bridge and pinned revision before charge", async () => {
  const response = (blender, status = 503) => jsonResponse({
    status: status === 200 ? "ready" : "not_ready",
    cuda: true,
    modelPresent: true,
    modelLoaded: true,
    modelBundleVerified: true,
    modelRevision: "af44b45f2e35a493886929c6d786e563ec68364d",
    sourceRevision: "75fbf0183001ed9876c8dbb35de6b68552ee08bd",
    runtimeRepositoryRevision: BLENDER_REVISION,
    runtimeRevisionVerified: true,
    blender,
  }, status);
  const disconnected = new TrellisModelBuildAdapter({
    baseUrl: "http://10.42.2.10:8000",
    sharedSecret: "test-worker-secret",
    referenceHosts: [],
    fetchImpl: async () => response({
      status: "not_ready",
      bridgeConnected: false,
      version: null,
      revision: null,
    }),
  });
  await assert.rejects(
    () => disconnected.preflightForCharge(),
    (error) => error.code === "BLENDER_WORKER_NOT_READY",
  );

  const stale = new TrellisModelBuildAdapter({
    baseUrl: "http://10.42.2.10:8000",
    sharedSecret: "test-worker-secret",
    referenceHosts: [],
    fetchImpl: async () => response({
      status: "ready",
      bridgeConnected: true,
      version: "5.1.2",
      revision: "wrong-revision",
    }),
  });
  await assert.rejects(
    () => stale.preflightForCharge(),
    (error) => error.code === "BLENDER_REVISION_MISMATCH",
  );

  const omittedPins = new TrellisModelBuildAdapter({
    baseUrl: "http://10.42.2.10:8000",
    sharedSecret: "test-worker-secret",
    referenceHosts: [],
    fetchImpl: async () => response({
      status: "ready",
      bridgeConnected: true,
    }, 200),
  });
  await assert.rejects(
    () => omittedPins.preflightForCharge(),
    (error) => error.code === "BLENDER_REVISION_MISMATCH",
  );

  const unverifiedRuntime = new TrellisModelBuildAdapter({
    baseUrl: "http://10.42.2.10:8000",
    sharedSecret: "test-worker-secret",
    referenceHosts: [],
    fetchImpl: async () => jsonResponse({
      ...readyPayload(),
      runtimeRevisionVerified: false,
    }),
  });
  await assert.rejects(
    () => unverifiedRuntime.preflightForCharge(),
    (error) => error.code === "TRELLIS_RUNTIME_REVISION_MISMATCH",
  );
});

test("TRELLIS provider fails readiness on stale or unloaded workers", async () => {
  const provider = new TrellisModelBuildAdapter({
    baseUrl: "http://10.42.2.10:8000",
    sharedSecret: "test-worker-secret",
    referenceHosts: [],
    fetchImpl: async () => jsonResponse({
      status: "not_ready",
      cuda: true,
      modelPresent: true,
      modelLoaded: false,
      modelRevision: "stale",
      sourceRevision: "stale",
    }, 503),
  });
  await assert.rejects(
    () => provider.preflightForCharge(),
    (error) => error.code === "TRELLIS_WORKER_NOT_READY",
  );
});

test("TRELLIS provider polls and verifies the worker artifact", async () => {
  const glb = minimalGlb();
  const digest = crypto.createHash("sha256").update(glb).digest("hex");
  const provider = new TrellisModelBuildAdapter({
    baseUrl: "http://10.42.2.10:8000",
    sharedSecret: "test-worker-secret",
    referenceHosts: [],
    fetchImpl: async (request, init = {}) => {
      const url = new URL(String(request));
      assert.equal(url.hostname, "10.42.2.10");
      assert.equal(init.headers["x-worker-secret"], "test-worker-secret");
      if (url.pathname.endsWith("/artifact")) {
        return new Response(glb, {
          status: 200,
          headers: { "content-type": "model/gltf-binary", "x-artifact-sha256": digest },
        });
      }
      return jsonResponse({
        id: JOB_ID,
        status: "succeeded",
        progress: 100,
        artifact: { url: `/v1/jobs/${JOB_ID}/artifact`, sha256: digest, bytes: glb.length },
      });
    },
  });
  assert.deepEqual(await provider.poll(`trellis2:${JOB_ID}`), {
    done: true,
    glbUrl: `trellis2-artifact:${JOB_ID}`,
    progress: 100,
  });
  assert.deepEqual(await provider.download(`trellis2-artifact:${JOB_ID}`), glb);
});

test("TRELLIS provider starts, polls, and downloads internal finalization", async () => {
  const glb = minimalGlb();
  const digest = crypto.createHash("sha256").update(glb).digest("hex");
  const calls = [];
  const provider = new TrellisModelBuildAdapter({
    baseUrl: "http://10.42.2.10:8000",
    sharedSecret: "test-worker-secret",
    referenceHosts: [],
    fetchImpl: async (request, init = {}) => {
      const url = new URL(String(request));
      calls.push({ path: url.pathname, method: init.method || "GET" });
      assert.equal(url.hostname, "10.42.2.10");
      assert.equal(init.headers["x-worker-secret"], "test-worker-secret");
      if (url.pathname === "/readyz") {
        return jsonResponse(readyPayload());
      }
      if (url.pathname.endsWith("/finalize")) {
        return jsonResponse({ id: JOB_ID, status: "queued" }, 202);
      }
      if (url.pathname.endsWith("/final-artifact")) {
        return new Response(glb, {
          status: 200,
          headers: { "content-type": "model/gltf-binary", "x-artifact-sha256": digest },
        });
      }
      return jsonResponse({
        id: JOB_ID,
        status: "succeeded",
        progress: 100,
        finalization: {
          status: "succeeded",
          progress: 100,
          error: null,
          clips: ["idle", "walk", "tail_wag"],
          artifact: { url: `/v1/jobs/${JOB_ID}/final-artifact`, sha256: digest, bytes: glb.length },
        },
      });
    },
  });
  const handle = `trellis2:${JOB_ID}`;
  await provider.startFinalization(handle);
  assert.deepEqual(await provider.pollFinalization(handle), { done: true, progress: 100 });
  assert.deepEqual(await provider.downloadFinal(handle), glb);
  assert.deepEqual(calls, [
    { path: "/readyz", method: "GET" },
    { path: `/v1/jobs/${JOB_ID}/finalize`, method: "POST" },
    { path: `/v1/jobs/${JOB_ID}`, method: "GET" },
    { path: `/v1/jobs/${JOB_ID}/final-artifact`, method: "GET" },
  ]);
});

test("TRELLIS provider rejects public workers and unallowlisted references", async () => {
  assert.throws(
    () => new TrellisModelBuildAdapter({ baseUrl: "https://api.example.com", sharedSecret: "secret" }),
    (error) => error.code === "TRELLIS_CONFIG_PUBLIC_ENDPOINT",
  );
  const provider = new TrellisModelBuildAdapter({
    baseUrl: "http://10.42.2.10:8000",
    sharedSecret: "test-worker-secret",
    referenceHosts: ["assets.internal.test"],
    fetchImpl: async () => assert.fail("blocked URL must not be fetched"),
  });
  await assert.rejects(
    () => provider.start({
      frontUrl: "https://example.com/front.png",
      leftUrl: "https://example.com/left.png",
      rightUrl: "https://example.com/right.png",
      rearUrl: "https://example.com/rear.png",
    }, "12345678"),
    (error) => error.code === "TRELLIS_REFERENCE_HOST_BLOCKED",
  );
});

test("in-house-only provider selection fails closed without TRELLIS", () => {
  assert.equal(selectedPaws3dProvider({ PAWS_3D_PROVIDER: "trellis2", PAWS_3D_INHOUSE_ONLY: "true" }), "trellis2");
  assert.throws(
    () => selectedPaws3dProvider({
      PAWS_3D_PROVIDER: "tripo",
      PAWS_3D_INHOUSE_ONLY: " TRUE ",
      PAWS_3D_EXTERNAL_PROVIDER_IDS: "fal",
    }),
    (error) => error.code === "INHOUSE_PROVIDER_REQUIRED",
  );
  assert.throws(
    () => selectedPaws3dProvider({ PAWS_3D_PROVIDER: "INVALID PROVIDER" }),
    (error) => error.code === "PROVIDER_CONFIG_INVALID",
  );
});
