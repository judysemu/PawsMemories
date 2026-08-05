import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  UploadedFrontReferenceImageProvider,
  TripoReferenceImageProvider,
  createConfiguredReferenceImageProvider,
  inspectReferenceImage,
  selectedReferenceImageProvider,
} from "../server/reference-sessions/provider.ts";
import { evaluateReferenceConsistency } from "../server/reference-sessions/consistency.ts";
import {
  ReferenceSessionService,
  computeOrderedManifestHash,
  resolveReferenceManifestViewKinds,
} from "../server/reference-sessions/service.ts";
import { createLazyConfiguredModelBuildProvider } from "../server/model-builds/configuredProvider.ts";

test("strict in-house mode selects uploaded-front preparation and rejects Tripo", () => {
  const strictEnv = {
    PAWS_3D_INHOUSE_ONLY: "true",
    PAWS_3D_PROVIDER: "trellis2",
  };
  assert.equal(selectedReferenceImageProvider(strictEnv), "uploaded_front");
  assert.ok(createConfiguredReferenceImageProvider(strictEnv) instanceof UploadedFrontReferenceImageProvider);

  assert.throws(
    () => selectedReferenceImageProvider({
      ...strictEnv,
      PAWS_REFERENCE_PROVIDER: "tripo",
      PAWS_REFERENCE_EXTERNAL_PROVIDER_IDS: "fal",
    }),
    (error) => error?.code === "INHOUSE_REFERENCE_PROVIDER_REQUIRED",
  );

  assert.ok(createConfiguredReferenceImageProvider({}) instanceof TripoReferenceImageProvider);
});

test("uploaded-front preparation canonicalizes one real image and makes no external call", async (t) => {
  const provider = new UploadedFrontReferenceImageProvider();
  const source = await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#806040" },
  }).jpeg().toBuffer();
  const previousFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => {
    externalCalls += 1;
    throw new Error("external calls are forbidden");
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const result = await provider.generateMultiview({
    photoBuffer: source,
    photoMimeType: "image/jpeg",
  }, "photo");

  assert.equal(result.provider, "uploaded_front");
  assert.equal(result.views.length, 1);
  assert.equal(result.views[0].viewKind, "front");
  assert.equal(result.views[0].isSynthesized, false);
  assert.equal(provider.maxSourceImages, 1);
  assert.deepEqual(
    await inspectReferenceImage(result.views[0].imageBuffer, result.views[0].mimeType),
    { mimeType: "image/png", widthPx: 1024, heightPx: 1024 },
  );
  assert.equal(externalCalls, 0);
  await assert.rejects(
    () => provider.generateMultiview({ prompt: "invent a dog" }, "text"),
    /requires one uploaded front photo/,
  );

  const service = new ReferenceSessionService(provider, () => ({}));
  await assert.rejects(
    () => service.createSession("test-owner", {
      inputMode: "photo",
      sourceImagesBase64: [source.toString("base64"), source.toString("base64")],
      sourceMimeTypes: ["image/jpeg", "image/jpeg"],
    }),
    (error) => error?.code === "TOO_MANY_SOURCE_IMAGES",
  );
});

test("front-only manifests are truthful while Tripo retains four-view validation", () => {
  const front = {
    viewKind: "front",
    assetUuid: "11111111-1111-4111-8111-111111111111",
    sha256: "b".repeat(64),
  };
  const reportHash = "a".repeat(64);

  assert.deepEqual(resolveReferenceManifestViewKinds(["front"], "uploaded_front"), ["front"]);
  assert.throws(
    () => resolveReferenceManifestViewKinds(["front"], "tripo"),
    (error) => error?.code === "INCOMPLETE_VIEWS",
  );
  assert.throws(
    () => resolveReferenceManifestViewKinds(["front"], "unknown_external"),
    (error) => error?.code === "INCOMPLETE_VIEWS",
  );
  assert.throws(
    () => resolveReferenceManifestViewKinds(["front"], "Uploaded_Front"),
    (error) => error?.code === "INCOMPLETE_VIEWS",
  );
  assert.throws(
    () => resolveReferenceManifestViewKinds(["front", "left"], "uploaded_front"),
    (error) => error?.code === "INCOMPLETE_VIEWS",
  );
  assert.match(computeOrderedManifestHash([front], reportHash, ["front"]), /^[a-f0-9]{64}$/);
  assert.throws(
    () => computeOrderedManifestHash([front], reportHash),
    (error) => error?.code === "INCOMPLETE_MANIFEST",
  );
});

test("front-only consistency report says no additional views were synthesized", async () => {
  const imageBuffer = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "#806040" },
  }).png().toBuffer();
  const { payload } = evaluateReferenceConsistency([{
    viewKind: "front",
    imageBuffer,
    mimeType: "image/png",
    widthPx: 1024,
    heightPx: 1024,
    isSynthesized: false,
  }], "photo", null, ["front"]);

  assert.equal(payload.status, "warn");
  assert.match(payload.summaryNote, /without synthesizing additional views/i);
  assert.doesNotMatch(payload.summaryNote, /four-view/i);
  assert.equal(payload.metrics[0].status, "pass");
});

test("configured TRELLIS provider remains unconstructed until an enabled operation", async () => {
  let constructions = 0;
  const env = {
    PAWS_3D_PROVIDER: "trellis2",
    PAWS_3D_INHOUSE_ONLY: "true",
    TRELLIS_WORKER_URL: "",
    TRELLIS_WORKER_SHARED_SECRET: "",
  };
  const lazy = createLazyConfiguredModelBuildProvider(env, new Map([
    ["trellis2", () => {
      constructions += 1;
      throw new Error("provider constructed");
    }],
  ]));

  assert.equal(lazy.providerId, "trellis2");
  assert.deepEqual(lazy.requiredReferenceViewKinds, ["front"]);
  assert.equal(constructions, 0);
  assert.throws(
    () => lazy.start({ frontUrl: "data:image/png;base64,AA==" }, "a".repeat(64)),
    /provider constructed/,
  );
  assert.equal(constructions, 1);
});

test("model-build routes import with feature off and blank TRELLIS connection settings", async (t) => {
  const keys = [
    "MODEL_BUILD_V3_ENABLED",
    "PAWS_3D_PROVIDER",
    "PAWS_3D_INHOUSE_ONLY",
    "TRELLIS_WORKER_URL",
    "TRELLIS_WORKER_SHARED_SECRET",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    MODEL_BUILD_V3_ENABLED: "false",
    PAWS_3D_PROVIDER: "trellis2",
    PAWS_3D_INHOUSE_ONLY: "true",
    TRELLIS_WORKER_URL: "",
    TRELLIS_WORKER_SHARED_SECRET: "",
  });
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const routes = await import(`../server/model-builds/routes.ts?feature-off=${Date.now()}`);
  assert.ok(routes.modelBuildsRouter);
  assert.ok(routes.modelBuildService);
});
