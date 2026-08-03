import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import sharp from "sharp";

process.env.TRIPO_API_KEY = "test-key";
const { normalizeTripoUploadImage, startImageTo3D, startTextureModel } = await import("../tripo.ts");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("Tripo bridge converts WebP and ambiguous object-storage responses to real PNG uploads", async () => {
  const webp = await sharp({
    create: { width: 32, height: 24, channels: 3, background: "#8b5e3c" },
  }).webp().toBuffer();
  const uploaded = [];
  let tokenNumber = 0;
  let taskBody = null;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("https://private.example/")) {
      return new Response(webp, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (url.endsWith("/upload/sts")) {
      const file = init.body.get("file");
      const bytes = Buffer.from(await file.arrayBuffer());
      uploaded.push({ name: file.name, type: file.type, bytes });
      tokenNumber += 1;
      return Response.json({ data: { image_token: `token-${tokenNumber}` } });
    }
    if (url.endsWith("/task")) {
      taskBody = JSON.parse(String(init.body));
      return Response.json({ data: { task_id: "task-1" } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const handle = await startImageTo3D({
    imageUrl: "https://private.example/front",
    views: {
      left: "https://private.example/left",
      back: "https://private.example/back",
      right: "https://private.example/right",
    },
    geometry: { texture: false, pbr: false },
  });

  assert.equal(handle, "tripo:task-1");
  assert.equal(uploaded.length, 4);
  for (const upload of uploaded) {
    assert.equal(upload.name, "upload.png");
    assert.equal(upload.type, "image/png");
    assert.equal(upload.bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  }
  assert.equal(taskBody.type, "multiview_to_model");
  assert.deepEqual(taskBody.files.map((file) => file.type), ["png", "png", "png", "png"]);
  assert.equal("face_limit" in taskBody, false);
  assert.equal("geometry_quality" in taskBody, false);
  assert.equal("texture_alignment" in taskBody, false);
});

test("Tripo texture task receives only supported customer choices and provider defaults", async () => {
  let taskBody = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/task")) {
      taskBody = JSON.parse(String(init.body));
      return Response.json({ code: 0, data: { task_id: "texture-task" } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const handle = await startTextureModel("tripo:base-task", {
    prompt: "Preserve the pet's markings",
    quality: "standard",
  });

  assert.equal(handle, "tripo:texture-task");
  assert.deepEqual(taskBody, {
    type: "texture_model",
    original_model_task_id: "base-task",
    texture_quality: "standard",
    texture_prompt: { text: "Preserve the pet's markings" },
  });
});

test("Tripo bridge rejects non-images before any provider upload", async () => {
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("provider must not be called");
  };
  await assert.rejects(
    () => normalizeTripoUploadImage(Buffer.from("not an image")),
    /unsupported image format|decode|JPEG, PNG, or WebP/i,
  );
  assert.equal(providerCalls, 0);
});

test("multiview upload stops at the first invalid view instead of orphaning later uploads", async () => {
  const png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: "#ffffff" },
  }).png().toBuffer();
  const sourceOrder = [];
  let uploadCalls = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://private.example/front") {
      sourceOrder.push("front");
      return new Response(png, { status: 200 });
    }
    if (url === "https://private.example/left") {
      sourceOrder.push("left");
      return new Response(Buffer.from("invalid"), { status: 200 });
    }
    if (url.startsWith("https://private.example/")) {
      sourceOrder.push("later");
      return new Response(png, { status: 200 });
    }
    if (url.endsWith("/upload/sts")) {
      uploadCalls += 1;
      return Response.json({ data: { image_token: `token-${uploadCalls}` } });
    }
    if (url.endsWith("/task")) throw new Error("task must not be submitted");
    throw new Error(`Unexpected fetch: ${url}`);
  };

  await assert.rejects(() => startImageTo3D({
    imageUrl: "https://private.example/front",
    views: {
      left: "https://private.example/left",
      back: "https://private.example/back",
      right: "https://private.example/right",
    },
  }));
  assert.deepEqual(sourceOrder, ["front", "left"]);
  assert.equal(uploadCalls, 1);
});
