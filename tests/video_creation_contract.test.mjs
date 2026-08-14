import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { normalizeVideoAspectRatio, VIDEO_ASPECT_RATIOS } from "../server/videoAspectRatio.ts";

const serverSource = await readFile(new URL("../server.ts", import.meta.url), "utf8");

function createVideoRoute() {
  const start = serverSource.indexOf('app.post("/api/create-video"');
  const end = serverSource.indexOf('app.post("/api/create-talking-video"', start);
  assert.ok(start >= 0 && end > start, "could not locate the /api/create-video route in server.ts");
  return serverSource.slice(start, end);
}

test("fal.ai video creation accepts only Gemini/Veo-supported landscape and portrait ratios", () => {
  assert.deepEqual(VIDEO_ASPECT_RATIOS, ["16:9", "9:16"]);
  assert.equal(normalizeVideoAspectRatio("16:9"), "16:9");
  assert.equal(normalizeVideoAspectRatio("9:16"), "9:16");
  assert.equal(normalizeVideoAspectRatio("1:1"), "16:9");
  assert.equal(normalizeVideoAspectRatio(undefined), "16:9");
});

test("the create-video route only accepts the two supported durations, 8 or 15 seconds", () => {
  const route = createVideoRoute();
  assert.match(route, /durationSeconds:\s*FurReelDuration\s*=\s*req\.body\?\.durationSeconds === 15 \? 15 : 8/);
});

test("the create-video route dispatches through fal.ai, not MuAPI", () => {
  const route = createVideoRoute();
  assert.match(route, /submitFalVideo\(/);
  assert.match(route, /'fal-ai'/);
  assert.doesNotMatch(serverSource, /muApiUploadImage|muApiSubmitVideo|muApiPollVideo|MUAPI_API_KEY|MUAPI_VIDEO_MODEL/);
});

test("the create-video route prices each duration tier independently instead of one flat cost", () => {
  const route = createVideoRoute();
  assert.match(route, /animatedVideoCost\(durationSeconds\)/);
  assert.doesNotMatch(route, /CREDIT_PRICES\.ANIMATED_VIDEO\b/);
});

test("the ai_video_requests insert records the fal.ai endpoint actually used", () => {
  const route = createVideoRoute();
  assert.match(route, /INSERT INTO ai_video_requests/);
  assert.match(route, /providerModel/);
});
