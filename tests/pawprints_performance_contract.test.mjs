import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const studio = fs.readFileSync("src/components/PawprintsStudio.tsx", "utf8");
const worker = fs.readFileSync("src/pawprints/photoWorker.ts", "utf8");
const gpu = fs.readFileSync("src/pawprints/gpuCompositor.ts", "utf8");

test("photo scaling is bounded and offloaded with a safe fallback", () => {
  assert.match(studio, /maxPixels: mobile \? 3_200_000 : 7_000_000/);
  assert.match(studio, /for \(const file of accepted\) prepared\.push\(await preparePhoto\(file\)\)/);
  assert.match(worker, /OffscreenCanvas/);
  assert.match(worker, /createImageBitmap/);
  assert.match(worker, /bitmap\?\.close\(\)/);
  assert.match(studio, /return normalizePhoto\(file\)/);
});

test("selected exports prefer WebP and release large canvases", () => {
  // PP-1 parameterised renderPawprint so the live preview can render the same
  // pipeline at a lower resolution/quality. The paid full-size render keeps the
  // original WebP-at-0.92 default.
  assert.match(studio, /canvasDataUrl\(canvas, input\.mimeType \?\? "image\/webp", input\.quality \?\? 0\.92\)/);
  assert.match(studio, /canvas\.width = 1; canvas\.height = 1/);
});

test("the live preview renders below print resolution and never replaces the paid render (PP-1)", () => {
  // A preview cheap enough to re-run on every edit is the entire point; if it
  // ever rendered at print size it would be as expensive as the paid Save.
  assert.match(studio, /const PREVIEW_WIDTH = \d+;/);
  assert.match(studio, /const PREVIEW_HEIGHT = \d+;/);
  const previewWidth = Number(studio.match(/const PREVIEW_WIDTH = (\d+);/)[1]);
  const fullWidth = Number(studio.match(/const FULL_PRINT_WIDTH = (\d+);/)[1]);
  assert.ok(previewWidth < fullWidth, "preview must be smaller than the print canvas");
  // The paid path still renders at full print size.
  assert.match(studio, /renderPawprint\(\{ variation, photos, title: title\.trim\(\)/);
});

test("WebGL2 compositor is progressive and never removes the 2D fallback", () => {
  assert.match(gpu, /getContext\("webgl2"/);
  assert.match(gpu, /powerPreference: "high-performance"/);
  assert.match(studio, /if \(gpuLayer\)/);
  assert.match(studio, /else \{[\s\S]*cover\(ctx, image/);
});
