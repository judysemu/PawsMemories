import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import {
  FakeReferenceImageProvider,
  TripoReferenceImageProvider,
  inspectReferenceImage,
} from "../server/reference-sessions/provider.ts";

const providerSource = await readFile(new URL("../server/reference-sessions/provider.ts", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../server/reference-sessions/routes.ts", import.meta.url), "utf8");
const serviceSource = await readFile(new URL("../server/reference-sessions/service.ts", import.meta.url), "utf8");
const tripoSource = await readFile(new URL("../tripo.ts", import.meta.url), "utf8");

test("reference image inspection trusts decoded bytes, not claimed dimensions", async () => {
  const onePixel = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(() => inspectReferenceImage(onePixel, "image/png"), /at least 256x256/);
  assert.deepEqual(
    await inspectReferenceImage(onePixel, "image/png", 1),
    { mimeType: "image/png", widthPx: 1, heightPx: 1 },
  );
  await assert.rejects(() => inspectReferenceImage(onePixel, "image/jpeg"), /do not match/);
});

test("fake provider emits four genuinely high-resolution decodable images", async () => {
  const provider = new FakeReferenceImageProvider();
  const result = await provider.generateMultiview({ prompt: "test" }, "text");
  assert.equal(result.views.length, 4);
  for (const view of result.views) {
    const inspected = await inspectReferenceImage(view.imageBuffer, view.mimeType);
    assert.equal(inspected.widthPx, 1024);
    assert.equal(inspected.heightPx, 1024);
  }
});

test("production provider accepts photo input only", async () => {
  const provider = new TripoReferenceImageProvider();
  assert.equal(provider.model, "generate-multiview-image-v2");
  await assert.rejects(
    () => provider.generateMultiview({ prompt: "a dog" }, "text"),
    /requires one uploaded pet photo/,
  );
});

test("reference generation uses Tripo's current task API without app-level provider blocks", () => {
  assert.match(providerSource, /startTripoImageToMultiview\(input\.photoBuffer\)/);
  assert.match(providerSource, /onProviderTaskCreated/);
  assert.match(providerSource, /REFERENCE_PROVIDER_TIMEOUT_MS/);
  assert.doesNotMatch(providerSource, /GoogleGenAI|GEMINI_REFERENCE_IMAGE_MODEL/);
  assert.match(tripoSource, /type:\s*"generate_multiview_image"/);
  assert.match(tripoSource, /TRIPO_BASE\}\/upload\/sts/);
  assert.match(tripoSource, /TRIPO_BASE\}\/task\/\$\{encodeURIComponent\(taskId\)\}/);
  assert.doesNotMatch(tripoSource, /openapi\.tripo3d\.ai\/v3|image-to-multiview/);
  assert.doesNotMatch(providerSource, /this\.inFlight/);
  assert.doesNotMatch(routeSource, /rateLimit|MULTIVIEW_APPROVAL_ENABLED/);
  assert.doesNotMatch(serviceSource, /REFERENCE_GENERATION_GLOBAL|REFERENCE_GENERATION_MAX_ATTEMPTS|GET_LOCK/);
});
