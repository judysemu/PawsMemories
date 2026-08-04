import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { normalizeVideoAspectRatio, VIDEO_ASPECT_RATIOS } from "../server/videoAspectRatio.ts";

const serverSource = await readFile(new URL("../server.ts", import.meta.url), "utf8");

test("Veo video creation accepts only Gemini-supported landscape and portrait ratios", () => {
  assert.deepEqual(VIDEO_ASPECT_RATIOS, ["16:9", "9:16"]);
  assert.equal(normalizeVideoAspectRatio("16:9"), "16:9");
  assert.equal(normalizeVideoAspectRatio("9:16"), "9:16");
  assert.equal(normalizeVideoAspectRatio("1:1"), "16:9");
  assert.equal(normalizeVideoAspectRatio(undefined), "16:9");
});

test("the create-video route forwards the normalized selection instead of a square Veo ratio", () => {
  const start = serverSource.indexOf('app.post("/api/create-video"');
  const end = serverSource.indexOf('app.post("/api/create-talking-video"', start);
  const route = serverSource.slice(start, end);
  assert.match(route, /normalizeVideoAspectRatio\(req\.body\?\.aspectRatio\)/);
  // VG-1 widened this config with motion-quality levers (enhancePrompt,
  // negativePrompt, personGeneration). The contract being protected here is
  // that the NORMALIZED ratio is forwarded and the duration/count stay fixed —
  // not the exact shape of the object literal, which was over-specified.
  assert.match(route, /config:\s*\{[\s\S]*?\baspectRatio\b,[\s\S]*?\}/);
  assert.match(route, /durationSeconds:\s*8/);
  assert.match(route, /numberOfVideos:\s*1/);
  assert.doesNotMatch(route, /aspectRatio:\s*["']1:1["']/);
});

test("the create-video route steers Veo away from frozen output (VG-1)", () => {
  const start = serverSource.indexOf('app.post("/api/create-video"');
  const end = serverSource.indexOf('app.post("/api/create-talking-video"', start);
  const route = serverSource.slice(start, end);
  // Veo has no camera-motion parameter; the negative prompt is the only lever
  // that constrains stiff, static, slideshow-like renders.
  assert.match(route, /negativePrompt:\s*VEO_MOTION_NEGATIVE_PROMPT/);
  assert.match(route, /enhancePrompt:\s*true/);
});

test("the create-video route validates a remote image and preserves its actual MIME type", () => {
  const start = serverSource.indexOf('app.post("/api/create-video"');
  const end = serverSource.indexOf('app.post("/api/create-talking-video"', start);
  const route = serverSource.slice(start, end);
  assert.match(route, /if \(!imgRes\.ok\)/);
  assert.match(route, /fetchedMimeType\?\.startsWith\("image\/"\)/);
  assert.match(route, /mimeType = fetchedMimeType/);
});
