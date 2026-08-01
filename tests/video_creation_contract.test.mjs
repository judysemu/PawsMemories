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
  assert.match(route, /config: \{ aspectRatio, durationSeconds: 8, numberOfVideos: 1 \}/);
  assert.doesNotMatch(route, /aspectRatio:\s*["']1:1["']/);
});

test("the create-video route validates a remote image and preserves its actual MIME type", () => {
  const start = serverSource.indexOf('app.post("/api/create-video"');
  const end = serverSource.indexOf('app.post("/api/create-talking-video"', start);
  const route = serverSource.slice(start, end);
  assert.match(route, /if \(!imgRes\.ok\)/);
  assert.match(route, /fetchedMimeType\?\.startsWith\("image\/"\)/);
  assert.match(route, /mimeType = fetchedMimeType/);
});
