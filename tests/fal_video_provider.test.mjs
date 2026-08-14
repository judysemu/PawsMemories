import assert from "node:assert/strict";
import test from "node:test";

import {
  FAL_KLING_ENDPOINT,
  FAL_VEO_ENDPOINT,
  FalVideoError,
  assertResolvesToPublicHost,
  pollFalVideo,
  submitFalVideo,
} from "../server/ai-video/falVideo.ts";

const makeQueue = (overrides = {}) => {
  const calls = [];
  return {
    calls,
    async submit(endpoint, options) {
      calls.push(["submit", endpoint, options]);
      return overrides.submit ? overrides.submit() : { request_id: "fal-req-abc12345" };
    },
    async status(endpoint, options) {
      calls.push(["status", endpoint, options]);
      return overrides.status ? overrides.status() : { status: "COMPLETED" };
    },
    async result(endpoint, options) {
      calls.push(["result", endpoint, options]);
      return overrides.result ? overrides.result() : {
        data: { video: { url: "https://v3b.fal.media/files/video/output.mp4" } },
      };
    },
  };
};

test("submitFalVideo picks Veo for 8s with image_url/duration:\"8s\", Kling for 15s with start_image_url/duration:\"15\"", async () => {
  const veoQueue = makeQueue();
  const veoResult = await submitFalVideo(
    { imageUrl: "https://media.example.com/pet.png", prompt: "a pet portrait", durationSeconds: 8, aspectRatio: "9:16" },
    { queue: veoQueue },
  );
  assert.equal(veoResult.endpoint, FAL_VEO_ENDPOINT);
  assert.equal(veoResult.requestId, "fal-req-abc12345");
  const [, veoEndpoint, veoOptions] = veoQueue.calls[0];
  assert.equal(veoEndpoint, FAL_VEO_ENDPOINT);
  assert.deepEqual(veoOptions.input, {
    prompt: "a pet portrait",
    image_url: "https://media.example.com/pet.png",
    duration: "8s",
    aspect_ratio: "9:16",
    resolution: "720p",
    generate_audio: true,
  });

  const klingQueue = makeQueue();
  const klingResult = await submitFalVideo(
    { imageUrl: "https://media.example.com/pet.png", prompt: "a pet portrait", durationSeconds: 15, aspectRatio: "16:9" },
    { queue: klingQueue },
  );
  assert.equal(klingResult.endpoint, FAL_KLING_ENDPOINT);
  const [, klingEndpoint, klingOptions] = klingQueue.calls[0];
  assert.equal(klingEndpoint, FAL_KLING_ENDPOINT);
  assert.deepEqual(klingOptions.input, {
    start_image_url: "https://media.example.com/pet.png",
    prompt: "a pet portrait",
    duration: "15",
    generate_audio: true,
  });
});

test("submitFalVideo fails closed when in-house-only mode blocks external providers", async () => {
  const original = process.env.PAWS_3D_INHOUSE_ONLY;
  process.env.PAWS_3D_INHOUSE_ONLY = "true";
  try {
    await assert.rejects(
      submitFalVideo(
        { imageUrl: "https://media.example.com/pet.png", prompt: "p", durationSeconds: 8, aspectRatio: "9:16" },
        { queue: makeQueue() },
      ),
      (error) => error.code === "INHOUSE_EXTERNAL_PROVIDER_BLOCKED",
    );
  } finally {
    if (original === undefined) delete process.env.PAWS_3D_INHOUSE_ONLY;
    else process.env.PAWS_3D_INHOUSE_ONLY = original;
  }
});

test("submitFalVideo rejects a malformed request id from the provider", async () => {
  await assert.rejects(
    submitFalVideo(
      { imageUrl: "https://media.example.com/pet.png", prompt: "p", durationSeconds: 8, aspectRatio: "9:16" },
      { queue: makeQueue({ submit: () => ({ request_id: "!!" }) }) },
    ),
    (error) => error instanceof FalVideoError && error.code === "FAL_VIDEO_SUBMISSION_FAILED",
  );
});

test("pollFalVideo reports not-done while queued/running and done with a validated URL on completion", async () => {
  const runningQueue = makeQueue({ status: () => ({ status: "IN_PROGRESS" }) });
  const running = await pollFalVideo(FAL_VEO_ENDPOINT, "fal-req-abc12345", { queue: runningQueue });
  assert.equal(running.done, false);

  const doneQueue = makeQueue();
  const done = await pollFalVideo(FAL_VEO_ENDPOINT, "fal-req-abc12345", { queue: doneQueue });
  assert.equal(done.done, true);
  assert.equal(done.videoUrl.toString(), "https://v3b.fal.media/files/video/output.mp4");
});

test("pollFalVideo surfaces a provider failure without throwing", async () => {
  const failedQueue = makeQueue({ status: () => ({ status: "FAILED", error: "content policy" }) });
  const result = await pollFalVideo(FAL_KLING_ENDPOINT, "fal-req-abc12345", { queue: failedQueue });
  assert.equal(result.done, true);
  assert.equal(result.error, "content policy");
});

test("pollFalVideo rejects a completed result pointing at an untrusted host", async () => {
  const untrustedQueue = makeQueue({
    result: () => ({ data: { video: { url: "https://attacker.example.com/video.mp4" } } }),
  });
  await assert.rejects(
    pollFalVideo(FAL_VEO_ENDPOINT, "fal-req-abc12345", { queue: untrustedQueue }),
    (error) => error instanceof FalVideoError && error.code === "FAL_VIDEO_OUTPUT_INVALID",
  );
});

test("assertResolvesToPublicHost blocks private/loopback addresses and allows public ones", async () => {
  await assert.rejects(
    assertResolvesToPublicHost(
      new URL("https://v3b.fal.media/files/video/output.mp4"),
      async () => [{ address: "127.0.0.1", family: 4 }],
    ),
    (error) => error instanceof FalVideoError && error.code === "FAL_VIDEO_DOWNLOAD_BLOCKED",
  );

  await assert.doesNotReject(
    assertResolvesToPublicHost(
      new URL("https://v3b.fal.media/files/video/output.mp4"),
      async () => [{ address: "104.18.1.1", family: 4 }],
    ),
  );
});
