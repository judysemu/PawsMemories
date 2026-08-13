import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const render = fs.readFileSync("src/pawprints/renderPawprint.tsx", "utf8");
const photoStep = fs.readFileSync("src/components/pawprints/PhotoStep.tsx", "utf8");
const finishStep = fs.readFileSync("src/components/pawprints/FinishStep.tsx", "utf8");
const worker = fs.readFileSync("src/pawprints/photoWorker.ts", "utf8");
const gpu = fs.readFileSync("src/pawprints/gpuCompositor.ts", "utf8");

test("photo scaling is bounded and offloaded with a safe fallback", () => {
  assert.match(render, /maxPixels: mobile \? 3_200_000 : 7_000_000/);
  assert.match(photoStep, /for \(const file of accepted\) prepared\.push\(await preparePhoto\(file\)\)/);
  assert.match(worker, /OffscreenCanvas/);
  assert.match(worker, /createImageBitmap/);
  assert.match(worker, /bitmap\?\.close\(\)/);
  assert.match(render, /return normalizePhoto\(file\)/);
});

test("selected exports prefer WebP and release large canvases", () => {
  assert.match(render, /canvasDataUrl\(canvas, input\.mimeType \?\? "image\/webp", input\.quality \?\? 0\.92\)/);
  assert.match(render, /canvas\.width = 1; canvas\.height = 1/);
});

test("the live preview renders below print resolution and never replaces the paid render (PP-1)", () => {
  assert.match(render, /export const PREVIEW_WIDTH = \d+;/);
  assert.match(render, /export const PREVIEW_HEIGHT = \d+;/);
  const previewWidth = Number(render.match(/export const PREVIEW_WIDTH = (\d+);/)[1]);
  const fullWidth = Number(render.match(/export const FULL_PRINT_WIDTH = (\d+);/)[1]);
  assert.ok(previewWidth < fullWidth, "preview must be smaller than the print canvas");
  // Save still renders at the full print size, from the same renderPawprint().
  assert.match(finishStep, /width: FULL_PRINT_WIDTH, height: FULL_PRINT_HEIGHT/);
});

test("WebGL2 compositor is progressive and never removes the 2D fallback", () => {
  assert.match(gpu, /getContext\("webgl2"/);
  assert.match(gpu, /powerPreference: "high-performance"/);
  assert.match(render, /if \(gpuLayer\)/);
  assert.match(render, /else \{[\s\S]*cover\(ctx, image/);
});
