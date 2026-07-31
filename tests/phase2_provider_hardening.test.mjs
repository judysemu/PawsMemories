import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import {
  FakeReferenceImageProvider,
  GeminiReferenceImageProvider,
  inspectReferenceImage,
} from "../server/reference-sessions/provider.ts";

const providerSource = await readFile(new URL("../server/reference-sessions/provider.ts", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../server/reference-sessions/routes.ts", import.meta.url), "utf8");
const serviceSource = await readFile(new URL("../server/reference-sessions/service.ts", import.meta.url), "utf8");

test("reference image inspection trusts decoded bytes, not claimed dimensions", async () => {
  const onePixel = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(() => inspectReferenceImage(onePixel, "image/png"), /at least 1024x1024/);
  assert.deepEqual(
    await inspectReferenceImage(onePixel, "image/png", 1),
    { mimeType: "image/png", widthPx: 1, heightPx: 1 },
  );
  await assert.rejects(() => inspectReferenceImage(onePixel, "image/jpeg"), /do not match/);
});

test("fake provider emits five genuinely high-resolution decodable images", async () => {
  const provider = new FakeReferenceImageProvider();
  const result = await provider.generateMultiview({ prompt: "test" }, "text");
  assert.equal(result.views.length, 5);
  for (const view of result.views) {
    const inspected = await inspectReferenceImage(view.imageBuffer, view.mimeType);
    assert.equal(inspected.widthPx, 1024);
    assert.equal(inspected.heightPx, 1024);
  }
});

test("production provider fails closed without GEMINI_API_KEY", async () => {
  const provider = new GeminiReferenceImageProvider("");
  assert.equal(provider.model, "gemini-3.1-flash-image");
  assert.equal(
    new GeminiReferenceImageProvider("", "gemini-2.5-flash-image").model,
    "gemini-3.1-flash-image",
  );
  await assert.rejects(
    () => provider.generateMultiview({ prompt: "a dog" }, "text"),
    /GEMINI_API_KEY is required/,
  );
});

test("reference generation cannot multiply calls through SDK retries or model fallback chains", () => {
  assert.match(providerSource, /retryOptions:\s*\{\s*attempts:\s*1\s*\}/);
  assert.match(providerSource, /GEMINI_REFERENCE_IMAGE_MODEL/);
  assert.doesNotMatch(providerSource, /for \(const model of this\.models\)/);
  assert.match(providerSource, /if \(this\.inFlight\)/);
  assert.match(providerSource, /finally \{\s*this\.inFlight = false/);
  assert.match(routeSource, /windowMs:\s*60_000,\s*\n\s*max:\s*1/);
  assert.match(routeSource, /keyGenerator:\s*\(req\)\s*=>\s*getRequestUserPhone/);
  assert.match(serviceSource, /REFERENCE_GENERATION_MAX_ATTEMPTS/);
  assert.match(serviceSource, /ATTEMPT_LIMIT_REACHED/);
  assert.match(serviceSource, /REFERENCE_GENERATION_GLOBAL_CONCURRENT_ATTEMPT_CAP/);
  assert.match(serviceSource, /REFERENCE_GENERATION_GLOBAL_MINUTE_ATTEMPT_CAP/);
  assert.match(serviceSource, /REFERENCE_GENERATION_GLOBAL_DAILY_ATTEMPT_CAP/);
  assert.match(serviceSource, /GET_LOCK/);
});
