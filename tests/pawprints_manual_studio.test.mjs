import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const studio = fs.readFileSync("src/components/PawprintsStudio.tsx", "utf8");
const server = fs.readFileSync("server.ts", "utf8");
const routeStart = server.indexOf('app.post("/api/pawprints/generate"');
const routeEnd = server.indexOf('app.post("/api/streak/claim"', routeStart);
const pawprintsRoute = server.slice(routeStart, routeEnd);

test("Pawprints Studio is a click-through manual editor with twelve variations", () => {
  assert.match(studio, /How will you celebrate your pet\?/);
  assert.match(studio, /Choose a portrait title/);
  assert.match(studio, /Choose a variation/);
  assert.match(studio, /"classic"[\s\S]*"overlay"[\s\S]*"split"[\s\S]*"frame"/);
  assert.match(studio, /"story"[\s\S]*"filmstrip"[\s\S]*"circles"[\s\S]*"mosaic"/);
  assert.match(studio, /"polaroid"[\s\S]*"triptych"[\s\S]*"magazine"[\s\S]*"panorama"/);
  assert.match(studio, /Minimum 600 × 600/);
  assert.match(studio, /renderPawprint/);
});

test("Pawprints keeps user copy manual while Historic mode may generate portrait art", () => {
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.match(pawprintsRoute, /renderedImage/);
  assert.match(pawprintsRoute, /limitInputPixels: 16_000_000/);
  assert.match(pawprintsRoute, /sharp\(sourceBuffer, sharpInputOptions\)/);
  assert.match(pawprintsRoute, /\.webp\(\{ quality: 92/);
  assert.match(pawprintsRoute, /category === "historic_portraits"/);
  assert.match(pawprintsRoute, /generateImageWithFallback/);
  assert.doesNotMatch(pawprintsRoute, /generatedText/);
});

test("Pawprints preserves the selected category and canonically resolves cached Halloween requests", () => {
  assert.match(studio, /const chooseTemplate = \(item: PawprintTemplate\) => \{[\s\S]*setCategory\(item\.category\);[\s\S]*setTemplate\(item\);/);
  assert.match(pawprintsRoute, /const requestedCategory = String\(req\.body\?\.category \|\| ""\)\.trim\(\);/);
  assert.match(pawprintsRoute, /getPawprintTemplatesSync\(requestedCategory \|\| undefined\)[\s\S]*\.filter\(\(item\) => item\.layoutId === layoutId\)/);
  assert.match(pawprintsRoute, /const category = template\.category;/);
  assert.match(pawprintsRoute, /"arts-adventure", "halloween", "landmarks"/);
});

test("Pawprints export fits the exact title and message inside every template text rectangle", () => {
  assert.match(studio, /function drawFittedTextBlock/);
  assert.match(studio, /height: plan\.text\.height \* PRINT_HEIGHT/);
  assert.match(studio, /wrapTextLines\(ctx, input\.message, maxWidth\)/);
  assert.doesNotMatch(studio, /textY \+ \(compact \? 285 : 235\)/);
});

test("Pawprints remains separate from the Animator component tree", () => {
  assert.doesNotMatch(studio, /AnimatorScreen|SceneSequence|AnimationController|onGoToAnimator/);
});

test("Pawprints email and print actions are bound to the exact saved design revision", () => {
  assert.match(studio, /const designSignature = useMemo/);
  assert.match(studio, /previousDesignSignatureRef\.current !== designSignature/);
  assert.match(studio, /setSavedCreationId\(null\)/);
  assert.match(studio, /liveDesignSignatureRef\.current !== submittedDesignSignature/);
  assert.match(studio, /Save the updated design before sending or printing it/);
});
