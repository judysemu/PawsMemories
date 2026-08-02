import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { requestGeminiReferenceImage } from "../server/reference-sessions/provider.ts";

test("a text-only Gemini response gets one bounded image-only retry", async () => {
  const png = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "#8b6f47" },
  }).png().toBuffer();
  const calls = [];
  const client = {
    models: {
      async generateContent(request) {
        calls.push(request);
        if (calls.length === 1) {
          return { candidates: [{ content: { parts: [{ text: "I could not create that image." }] } }] };
        }
        return { candidates: [{ content: { parts: [{ inlineData: { data: png.toString("base64"), mimeType: "image/png" } }] } }] };
      },
    },
  };

  const generated = await requestGeminiReferenceImage(client, "gemini-3.1-flash-image", [{ text: "front view" }], "front reference view");
  assert.equal(generated.widthPx, 1024);
  assert.equal(generated.heightPx, 1024);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].config.responseModalities, ["IMAGE", "TEXT"]);
  assert.deepEqual(calls[1].config.responseModalities, ["IMAGE"]);
});
