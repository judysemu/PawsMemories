import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";

import {
  FAL_PBR_ENDPOINT,
  FalPbrError,
  generateFalPbrMaterial,
  normalizeFalPbrInput,
} from "../server/pbr/falPbr.ts";
import {
  FULL_WARDROBE_MATERIAL_IDS,
  WARDROBE_PBR_PROFILES,
  getWardrobePbrProfile,
} from "../shared/wardrobePbrCatalog.ts";
import { FULL_WARDROBE_CATALOG } from "../src/wardrobe/catalog.ts";
import { parseWardrobePbrManifest } from "../src/wardrobe/pbrManifest.ts";

const makePng = async (red) => sharp({
  create: {
    width: 8,
    height: 8,
    channels: 4,
    background: { r: red, g: 20, b: 30, alpha: 1 },
  },
}).png().toBuffer();

const makeQueue = (images) => {
  const calls = [];
  return {
    calls,
    async submit(endpoint, options) {
      calls.push(["submit", endpoint, options]);
      return { request_id: "fal-request-123" };
    },
    async status(endpoint, options) {
      calls.push(["status", endpoint, options]);
      return { status: "COMPLETED" };
    },
    async result(endpoint, options) {
      calls.push(["result", endpoint, options]);
      return { data: { images, seed: 271828, prompt: "expanded prompt" } };
    },
  };
};

test("wardrobe PBR profiles cover every catalog accessory with bounded prompts", () => {
  assert.ok(WARDROBE_PBR_PROFILES.length >= 6);
  assert.equal(FULL_WARDROBE_MATERIAL_IDS.size, WARDROBE_PBR_PROFILES.length);

  for (const item of FULL_WARDROBE_CATALOG) {
    assert.equal(typeof item.materialId, "string", `${item.id} is missing materialId`);
    const profile = getWardrobePbrProfile(item.materialId);
    assert.ok(profile, `${item.id} references missing material ${item.materialId}`);
    assert.ok(profile.prompt.length >= 24 && profile.prompt.length <= 600);
    assert.equal(profile.seed, Math.trunc(profile.seed));
    assert.ok(profile.seed >= 0);
  }
});

test("fal PBR input is deterministic, bounded, and always requests the web PBR maps", () => {
  const normalized = normalizeFalPbrInput({
    prompt: "  hand-tooled scarlet vegetable-tanned leather, subtle grain  ",
    seed: 42,
  });

  assert.deepEqual(normalized, {
    prompt: "hand-tooled scarlet vegetable-tanned leather, subtle grain",
    image_size: { width: 1024, height: 1024 },
    num_inference_steps: 8,
    num_images: 1,
    enable_prompt_expansion: false,
    enable_safety_checker: true,
    tiling_mode: "both",
    tile_size: 128,
    tile_stride: 64,
    maps: ["basecolor", "normal", "roughness", "metalness"],
    seed: 42,
    output_format: "png",
  });

  assert.throws(
    () => normalizeFalPbrInput({ prompt: "short", seed: 1 }),
    (error) => error instanceof FalPbrError && error.code === "FAL_PBR_INPUT_INVALID",
  );
});

test("fal PBR generation fails closed when the server key is absent", async () => {
  await assert.rejects(
    generateFalPbrMaterial(
      { prompt: "woven navy cotton with a subtle durable diagonal texture", seed: 7 },
      { apiKey: "", fetchImpl: async () => new Response() },
    ),
    (error) => error instanceof FalPbrError && error.code === "FAL_PBR_NOT_CONFIGURED",
  );
});

test("fal PBR generation validates, downloads, and hashes exactly four trusted maps", async () => {
  const kinds = ["basecolor", "normal", "roughness", "metalness"];
  const buffers = new Map();
  const images = [];
  for (let index = 0; index < kinds.length; index += 1) {
    const url = `https://v3b.fal.media/files/material/${kinds[index]}.png`;
    buffers.set(url, await makePng(40 + index));
    images.push({ url, map_type: kinds[index], content_type: "image/png" });
  }
  const queue = makeQueue(images);

  const result = await generateFalPbrMaterial(
    { prompt: "woven navy cotton with a subtle durable diagonal texture", seed: 271828 },
    {
      apiKey: "server-only-key",
      queue,
      pollIntervalMs: 0,
      expectedDimension: 8,
      fetchImpl: async (url, init) => {
        assert.equal(init.redirect, "error");
        const body = buffers.get(String(url));
        assert.ok(body, `unexpected download ${url}`);
        return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
      },
      resolveHost: async () => [{ address: "104.18.1.1", family: 4 }],
    },
  );

  assert.equal(queue.calls[0][0], "submit");
  assert.equal(queue.calls[0][1], FAL_PBR_ENDPOINT);
  assert.equal(queue.calls[0][2].input.enable_prompt_expansion, false);
  assert.equal(queue.calls[0][2].input.maps.length, 4);
  assert.equal(result.provider, "fal-ai");
  assert.equal(result.model, FAL_PBR_ENDPOINT);
  assert.equal(result.requestId, "fal-request-123");
  assert.equal(result.seed, 271828);
  assert.deepEqual(Object.keys(result.maps).sort(), [...kinds].sort());
  for (const kind of kinds) {
    assert.equal(
      result.maps[kind].sha256,
      crypto.createHash("sha256").update(buffers.get(images.find((entry) => entry.map_type === kind).url)).digest("hex"),
    );
    assert.equal(result.maps[kind].width, 8);
    assert.equal(result.maps[kind].height, 8);
  }
});

test("fal PBR generation rejects missing, duplicate, or untrusted output maps before download", async () => {
  const valid = ["basecolor", "normal", "roughness", "metalness"].map((kind) => ({
    url: `https://v3b.fal.media/files/material/${kind}.png`,
    map_type: kind,
    content_type: "image/png",
  }));

  for (const images of [
    valid.slice(0, 3),
    [...valid, valid[0]],
    valid.map((entry, index) => index === 0 ? { ...entry, url: "https://example.com/basecolor.png" } : entry),
  ]) {
    let downloads = 0;
    await assert.rejects(
      generateFalPbrMaterial(
        { prompt: "woven navy cotton with a subtle durable diagonal texture", seed: 7 },
        {
          apiKey: "server-only-key",
          queue: makeQueue(images),
          pollIntervalMs: 0,
          fetchImpl: async () => { downloads += 1; return new Response(await makePng(2)); },
        },
      ),
      (error) => error instanceof FalPbrError && error.code === "FAL_PBR_OUTPUT_INVALID",
    );
    assert.equal(downloads, 0);
  }
});

test("fal PBR generation rejects private DNS and non-images", async () => {
  const images = ["basecolor", "normal", "roughness", "metalness"].map((kind) => ({
    url: `https://v3b.fal.media/files/material/${kind}.png`,
    map_type: kind,
    content_type: "image/png",
  }));

  await assert.rejects(
    generateFalPbrMaterial(
      { prompt: "woven navy cotton with a subtle durable diagonal texture", seed: 7 },
      {
        apiKey: "server-only-key",
        queue: makeQueue(images),
        pollIntervalMs: 0,
        fetchImpl: async () => new Response(await makePng(2)),
        resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
      },
    ),
    (error) => error instanceof FalPbrError && error.code === "FAL_PBR_DOWNLOAD_BLOCKED",
  );

  await assert.rejects(
    generateFalPbrMaterial(
      { prompt: "woven navy cotton with a subtle durable diagonal texture", seed: 7 },
      {
        apiKey: "server-only-key",
        queue: makeQueue(images),
        pollIntervalMs: 0,
        expectedDimension: 8,
        fetchImpl: async () => new Response(Buffer.from("not a png"), { status: 200 }),
        resolveHost: async () => [{ address: "104.18.1.1", family: 4 }],
      },
    ),
    (error) => error instanceof FalPbrError && error.code === "FAL_PBR_OUTPUT_INVALID",
  );
});

test("browser manifest accepts only complete, local, hash-addressed PBR map sets", () => {
  assert.deepEqual(parseWardrobePbrManifest({ schemaVersion: 1, generatedAt: null, materials: {} }), {
    schemaVersion: 1,
    generatedAt: null,
    materials: {},
  });

  const maps = Object.fromEntries(["basecolor", "normal", "roughness", "metalness"].map((kind) => [kind, {
    path: `/wardrobe/materials/scarlet-leather/${kind}.png`,
    sha256: "a".repeat(64),
    width: 1024,
    height: 1024,
  }]));
  const valid = {
    schemaVersion: 1,
    generatedAt: "2026-07-31T00:00:00.000Z",
    materials: {
      "scarlet-leather": {
        materialId: "scarlet-leather",
        configHash: "b".repeat(64),
        provider: "fal-ai",
        model: "fal-ai/patina/material",
        seed: 1729,
        maps,
      },
    },
  };
  assert.ok(parseWardrobePbrManifest(valid));
  assert.equal(parseWardrobePbrManifest({
    ...valid,
    materials: {
      "scarlet-leather": {
        ...valid.materials["scarlet-leather"],
        maps: { ...maps, basecolor: { ...maps.basecolor, path: "https://v3b.fal.media/map.png" } },
      },
    },
  }), null);
});

test("fal key remains server-side and paid authoring is explicitly gated", async () => {
  const [renderer, authoring, envExample] = await Promise.all([
    fs.readFile(new URL("../src/wardrobe/WardrobeLayer.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/generate-wardrobe-pbr.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(renderer, /FAL_KEY|fal\.run|queue\.fal/);
  assert.match(authoring, /FAL_PBR_AUTHORING_ENABLED !== "1"/);
  assert.match(authoring, /already verified; skipped/);
  assert.match(envExample, /FAL_KEY=""/);
  assert.doesNotMatch(envExample, /VITE_FAL/);
});
