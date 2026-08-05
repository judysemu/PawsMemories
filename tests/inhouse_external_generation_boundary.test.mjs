import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  downloadTripoReferenceImage,
  pollImageTo3D,
  pollTripoImageToMultiview,
  startImageTo3D,
  startPreRigCheck,
  startRetarget,
  startRig,
  startTextureModel,
  startTripoImageToMultiview,
} from "../tripo.ts";
import { generateFalPbrMaterial } from "../server/pbr/falPbr.ts";
import { TripoModelBuildAdapter } from "../server/model-builds/provider.ts";
import { isInHouseOnly, rejectLegacyExternal3dRoute } from "../server/externalGenerativePolicy.ts";

const BLOCKED_CODE = "INHOUSE_EXTERNAL_PROVIDER_BLOCKED";
const ROOT = path.resolve(import.meta.dirname, "..");

async function rejectsAtBoundary(operation) {
  await assert.rejects(operation, (error) => error?.code === BLOCKED_CODE);
}

test("in-house-only mode blocks every Tripo network entry point before fetch", async (t) => {
  const previousMode = process.env.PAWS_3D_INHOUSE_ONLY;
  const previousKey = process.env.TRIPO_API_KEY;
  const previousFetch = global.fetch;
  process.env.PAWS_3D_INHOUSE_ONLY = " TRUE ";
  delete process.env.TRIPO_API_KEY;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("external fetch must not run");
  };
  t.after(() => {
    global.fetch = previousFetch;
    if (previousMode === undefined) delete process.env.PAWS_3D_INHOUSE_ONLY;
    else process.env.PAWS_3D_INHOUSE_ONLY = previousMode;
    if (previousKey === undefined) delete process.env.TRIPO_API_KEY;
    else process.env.TRIPO_API_KEY = previousKey;
  });

  await rejectsAtBoundary(() => startTripoImageToMultiview(Buffer.from("not-an-image")));
  await rejectsAtBoundary(() => pollTripoImageToMultiview("tripo-multiview:legacy"));
  await rejectsAtBoundary(() => downloadTripoReferenceImage("not-a-url"));
  await rejectsAtBoundary(() => startImageTo3D({ imageUrl: "https://outside.test/pet.png" }));
  await rejectsAtBoundary(() => startRig("tripo:legacy"));
  await rejectsAtBoundary(() => startPreRigCheck("tripo:legacy"));
  await rejectsAtBoundary(() => startTextureModel("tripo:legacy"));
  await rejectsAtBoundary(() => startRetarget("tripo:legacy", "preset:walk"));
  await rejectsAtBoundary(() => pollImageTo3D("tripo:legacy"));
  await rejectsAtBoundary(() => new TripoModelBuildAdapter().download("https://cdn.tripo3d.ai/model.glb"));
  assert.equal(fetchCalls, 0);
});

test("in-house-only mode blocks fal authoring before key or queue access", async (t) => {
  const previousMode = process.env.PAWS_3D_INHOUSE_ONLY;
  process.env.PAWS_3D_INHOUSE_ONLY = "true";
  t.after(() => {
    if (previousMode === undefined) delete process.env.PAWS_3D_INHOUSE_ONLY;
    else process.env.PAWS_3D_INHOUSE_ONLY = previousMode;
  });

  let queueCalls = 0;
  await rejectsAtBoundary(() => generateFalPbrMaterial(
    { prompt: "deliberately invalid", seed: -1 },
    {
      apiKey: "test-only-key",
      queue: {
        submit: async () => { queueCalls += 1; return {}; },
        status: async () => { queueCalls += 1; return {}; },
        result: async () => { queueCalls += 1; return {}; },
      },
    },
  ));
  assert.equal(queueCalls, 0);
});

test("example production configuration points at in-house generation and keeps cutover closed", () => {
  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  assert.match(example, /^PAWS_3D_PROVIDER="trellis2"$/m);
  assert.match(example, /^PAWS_3D_INHOUSE_ONLY="true"$/m);
  assert.match(example, /^PAWS_3D_EXTERNAL_PROVIDER_IDS="tripo,fal"$/m);
  assert.match(example, /^PET_GLB_ENABLED="false"$/m);
  assert.match(example, /^TRELLIS_WORKER_URL=""$/m);
  assert.match(example, /^TRELLIS_WORKER_SHARED_SECRET=""$/m);
  assert.match(example, /^TRELLIS_SOURCE_REVISION="75fbf0183001ed9876c8dbb35de6b68552ee08bd"$/m);
  assert.match(example, /^BLENDER_VERSION="5\.1\.2"$/m);
  assert.match(example, /^BLENDER_WORKER_REVISION=""$/m);
  assert.match(example, /^BLENDER_WORKER_URL=""$/m);
  assert.match(example, /^WORKER_SHARED_SECRET=""$/m);
  assert.doesNotMatch(example, /pawsmemories\.onrender\.com\/render/);
  assert.match(example, /^TRIPO_API_KEY=""$/m);
});

test("legacy route middleware rejects before the route handler in strict mode", (t) => {
  const previousMode = process.env.PAWS_3D_INHOUSE_ONLY;
  process.env.PAWS_3D_INHOUSE_ONLY = " True ";
  t.after(() => {
    if (previousMode === undefined) delete process.env.PAWS_3D_INHOUSE_ONLY;
    else process.env.PAWS_3D_INHOUSE_ONLY = previousMode;
  });

  let nextCalls = 0;
  let responseStatus = 0;
  let responseBody;
  rejectLegacyExternal3dRoute(
    {},
    {
      status(code) {
        responseStatus = code;
        return { json(value) { responseBody = value; } };
      },
    },
    () => { nextCalls += 1; },
  );
  assert.equal(nextCalls, 0);
  assert.equal(responseStatus, 503);
  assert.equal(responseBody.code, BLOCKED_CODE);
  assert.equal(isInHouseOnly({ PAWS_3D_INHOUSE_ONLY: " TRUE " }), true);
  assert.equal(isInHouseOnly({ PAWS_3D_INHOUSE_ONLY: "false" }), false);
});

test("legacy customer 3D routes stay guarded while safe reference preparation remains available", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.ts"), "utf8");
  const snapgen = fs.readFileSync(path.join(ROOT, "server/snapgen.ts"), "utf8");
  const references = fs.readFileSync(path.join(ROOT, "server/reference-sessions/routes.ts"), "utf8");
  const petSim = fs.readFileSync(path.join(ROOT, "server/petSimRouter.ts"), "utf8");

  for (const route of [
    "/api/avatars/:id/status",
    "/api/avatars/:id/retry",
    "/api/create-pipeline/approve",
    "/api/create-3d-model",
    "/api/image-to-3d",
    "/api/image-to-3d/:jobId/status",
  ]) {
    assert.match(server, new RegExp(`app\\.(?:get|post)\\(\"${route.replaceAll("/", "\\/")}\", requireAuth, rejectLegacyExternal3dRoute`));
  }
  assert.match(server, /!isModelBuildV3Enabled\(\) && !isInHouseOnly\(\)/);
  assert.match(snapgen, /app\.post\("\/api\/snapgen\/orders", requireAuth, rejectLegacyExternal3dRoute/);
  assert.match(snapgen, /app\.get\("\/api\/snapgen\/orders\/:id\/status", requireAuth, rejectLegacyExternal3dRoute/);
  assert.match(snapgen, /app\.post\("\/api\/snapgen\/orders\/:id\/remake", requireAuth, rejectLegacyExternal3dRoute/);
  assert.doesNotMatch(references, /router\.post\("\/(?:start|retry)", rejectLegacyExternal3dRoute/);
  assert.match(references, /createConfiguredReferenceImageProvider/);
  assert.match(petSim, /router\.post\("\/api\/pets\/:id\/rig", requireAuth, rejectLegacyExternal3dRoute, paidLimiter/);
});
