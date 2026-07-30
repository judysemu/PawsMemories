import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  FakeReferenceImageProvider,
  GeminiReferenceImageProvider,
  inspectReferenceImage,
} from "../server/reference-sessions/provider.ts";

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
  await assert.rejects(
    () => provider.generateMultiview({ prompt: "a dog" }, "text"),
    /GEMINI_API_KEY is required/,
  );
});
