import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from "../server/migrations/runner.ts";
import { createFalBirefnetProvider, FAL_BIREFNET_ENDPOINT } from "../server/photo-edit/falBirefnet.ts";
import { BackgroundRemovalError } from "../server/photo-edit/provider.ts";

const routes = fs.readFileSync("server/photo-edit/routes.ts", "utf8");
const provider = fs.readFileSync("server/photo-edit/provider.ts", "utf8");
const falImpl = fs.readFileSync("server/photo-edit/falBirefnet.ts", "utf8");
const worker = fs.readFileSync("src/pawprints/photoWorker.ts", "utf8");

test("migration 55 caches cutouts keyed by source AND provider", () => {
  assert.ok(CURRENT_SCHEMA_VERSION >= 55);
  const m = MIGRATIONS.find((e) => e.version === 55);
  assert.equal(m?.name, "photo_edit_cache");
  const sql = m.statements.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS photo_edit_cache/);
  // Provider in the key means swapping models re-mattes rather than serving a
  // cutout from a model we no longer run.
  assert.match(sql, /UNIQUE KEY uniq_source_provider \(source_sha256, provider\)/);
});

test("the alpha chain is repaired at the FIRST stage, the worker", () => {
  // This was {alpha:false}: transparency died here, before any other code saw
  // it. Fixing only the compositor would have changed nothing.
  assert.match(worker, /getContext\("2d", \{ alpha: true \}\)/);
  assert.doesNotMatch(worker, /alpha: false/);
});

test("the worker emits WebP-with-alpha, and never JPEG", () => {
  assert.match(worker, /convertToBlob\(\{ type: "image\/webp", quality \}\)/);
  // JPEG cannot carry alpha at all, so it must not be the fallback.
  assert.doesNotMatch(worker, /image\/jpeg/);
  assert.match(worker, /convertToBlob\(\{ type: "image\/png" \}\)/);
});

test("the performance contract's worker tokens survive the change", () => {
  // tests/pawprints_performance_contract.test.mjs string-matches these.
  for (const token of ["OffscreenCanvas", "createImageBitmap", "bitmap?.close()"]) {
    assert.ok(worker.includes(token), `worker must still contain ${token}`);
  }
});

test("the provider records the licensing constraint for future implementers", () => {
  assert.match(provider, /BiRefNet is MIT on both/);
  assert.match(provider, /wrapper library's licence is not sufficient/);
});

test("only fal.media may serve a downloadable result", async () => {
  const p = createFalBirefnetProvider({
    client: { subscribe: async () => ({ data: { image: { url: "https://evil.example.com/x.png" } } }) },
  });
  await assert.rejects(
    () => p.removeBackground({ base64: "AAAA", mimeType: "image/png" }),
    (err) => err instanceof BackgroundRemovalError && err.code === "OUTPUT_INVALID",
  );
});

test("a malformed provider URL is refused rather than fetched", async () => {
  for (const url of ["http://fal.media/x.png", "https://fal.media:8080/x.png", "not-a-url"]) {
    const p = createFalBirefnetProvider({
      client: { subscribe: async () => ({ data: { image: { url } } }) },
    });
    await assert.rejects(
      () => p.removeBackground({ base64: "AAAA", mimeType: "image/png" }),
      (err) => err instanceof BackgroundRemovalError && err.code === "OUTPUT_INVALID",
      `should reject ${url}`,
    );
  }
});

test("a provider with no image returns OUTPUT_INVALID, not a crash", async () => {
  const p = createFalBirefnetProvider({ client: { subscribe: async () => ({ data: {} }) } });
  await assert.rejects(
    () => p.removeBackground({ base64: "AAAA", mimeType: "image/png" }),
    (err) => err instanceof BackgroundRemovalError && err.code === "OUTPUT_INVALID",
  );
});

test("the provider targets BiRefNet and asks for soft alpha", () => {
  assert.equal(FAL_BIREFNET_ENDPOINT, "fal-ai/birefnet/v2");
  // A binary mask on a printed canvas looks like a paper stencil.
  assert.match(falImpl, /refine_foreground: true/);
  // Output is re-encoded to WebP-with-alpha to stay inside the 1 MB limit.
  assert.match(falImpl, /\.webp\(\{ quality: 90, alphaQuality: 100 \}\)/);
});

test("the route FAILS OPEN — an outage degrades the photo, never blocks an order", () => {
  const handler = routes.slice(routes.indexOf('router.post("/remove-background"'));
  assert.match(handler, /removed: false/);
  // The failure path returns 200 with the original kept, not an error status.
  const failBlock = handler.slice(handler.indexOf("} catch (err: any) {"));
  assert.doesNotMatch(failBlock, /res\.status\(5\d\d\)/);
  assert.match(failBlock, /return res\.json\(\{\s*removed: false/);
});

test("a cache read failure falls through to matting rather than erroring", () => {
  assert.match(routes, /cache read failed/);
  assert.match(routes, /A cache miss must never be fatal/);
});

test("cutouts go to the private bucket, not the public storefront one", () => {
  assert.match(routes, /putPrivateObject/);
  assert.match(routes, /getPrivateSignedUrl/);
  assert.doesNotMatch(routes, /uploadBase64Image/);
});

test("the feature is dark by default", () => {
  assert.match(routes, /PHOTO_EDIT_ENABLED === "true"/);
  assert.match(routes, /FEATURE_DISABLED/);
});
