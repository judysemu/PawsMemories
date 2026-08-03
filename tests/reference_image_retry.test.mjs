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
      return Response.json({
        code: 0,
        data: {
          status: "success",
          progress: 100,
          output: {
            front_view_url: "https://cdn.tripo3d.ai/front.png",
            left_view_url: "https://cdn.tripo3d.ai/left.png",
            back_view_url: "https://cdn.tripo3d.ai/back.png",
            right_view_url: "https://cdn.tripo3d.ai/right.png",
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
