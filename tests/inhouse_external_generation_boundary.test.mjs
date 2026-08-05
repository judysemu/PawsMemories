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

const BLOCKED_CODE = "INHOUSE_EXTERNAL_PROVIDER_BLOCKED";
const ROOT = path.resolve(import.meta.dirname, "..");

async function rejectsAtBoundary(operation) {
  await assert.rejects(operation, (error) => error?.code === BLOCKED_CODE);
}

test("in-house-only mode blocks every Tripo network entry point before fetch", async (t) => {
  const previousMode = process.env.PAWS_3D_INHOUSE_ONLY;
  const previousKey = process.env.TRIPO_API_KEY;
  const previousFetch = global.fetch;
  process.env.PAWS_3D_INHOUSE_ONLY = "true";
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
  assert.match(example, /^TRIPO_API_KEY=""$/m);
});
