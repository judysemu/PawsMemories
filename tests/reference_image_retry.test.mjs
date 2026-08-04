import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { TripoReferenceImageProvider } from "../server/reference-sessions/provider.ts";

test("one Tripo task returns the uploaded front plus three generated views", async () => {
  const png = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "#8b6f47" },
  }).png().toBuffer();
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TRIPO_API_KEY;
  const events = [];
  process.env.TRIPO_API_KEY = "test-only-key";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/upload/sts")) {
      events.push("upload");
      return Response.json({ code: 0, data: { image_token: "file_test" } });
    }
    if (url.endsWith("/task") && init?.method === "POST") {
      events.push("submit");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        type: "generate_multiview_image",
        file: { type: "png", file_token: "file_test" },
      });
      return Response.json({ code: 0, data: { task_id: "task_test" } });
    }
    if (url.endsWith("/task/task_test")) {
      events.push("poll");
      // Tripo namespaces multiview outputs under a sub-object keyed by the
      // task type, per the official tripo3d Python SDK's TaskOutput.from_dict
      // (output.generate_multiview_image.{front,left,back,right}_view_url) —
      // NOT flattened onto `output` directly. This fixture previously used
      // the flat shape, which let pollTripoImageToMultiview's bug (reading
      // output.front_view_url instead of
      // output.generate_multiview_image.front_view_url) go undetected: every
      // real Tripo call returned "success" with an "incomplete reference
      // set" regardless of the source photo.
      return Response.json({
        code: 0,
        data: {
          status: "success",
          progress: 100,
          output: {
            generate_multiview_image: {
              front_view_url: "https://cdn.tripo3d.ai/front.png",
              left_view_url: "https://cdn.tripo3d.ai/left.png",
              back_view_url: "https://cdn.tripo3d.ai/back.png",
              right_view_url: "https://cdn.tripo3d.ai/right.png",
            },
          },
        },
      });
    }
    if (url.startsWith("https://cdn.tripo3d.ai/")) {
      events.push(`download:${url.split("/").pop()}`);
      return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const provider = new TripoReferenceImageProvider();
    const result = await provider.generateMultiview({
      photoBuffer: png,
      photoMimeType: "image/png",
      onProviderTaskCreated: async (handle) => {
        assert.equal(handle, "tripo-multiview:task_test");
        events.push("persisted");
      },
    }, "photo");
    assert.equal(result.provider, "tripo");
    assert.deepEqual(result.views.map((view) => view.viewKind), ["front", "left", "right", "rear"]);
    assert.equal(result.views[0].isSynthesized, false);
    assert.equal(result.views.slice(1).every((view) => view.isSynthesized), true);
    assert.ok(events.indexOf("persisted") < events.indexOf("poll"));
    assert.equal(events.filter((event) => event === "submit").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TRIPO_API_KEY;
    else process.env.TRIPO_API_KEY = originalKey;
  }
});
