import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const digitalCategoryStep = fs.readFileSync("src/components/pawprints/DigitalCategoryStep.tsx", "utf8");
const customPromptStep = fs.readFileSync("src/components/pawprints/CustomPromptStep.tsx", "utf8");
const photoStep = fs.readFileSync("src/components/pawprints/PhotoStep.tsx", "utf8");
const finishStep = fs.readFileSync("src/components/pawprints/FinishStep.tsx", "utf8");
const shell = fs.readFileSync("src/components/PawprintsStudio.tsx", "utf8");
const renderer = fs.readFileSync("src/pawprints/renderPawprint.tsx", "utf8");
const worker = fs.readFileSync("src/pawprints/photoWorker.ts", "utf8");
const catalog = fs.readFileSync("shared/pawprintCatalog2.ts", "utf8");
const server = fs.readFileSync("server.ts", "utf8");

function sliceRoute(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `could not locate route between "${startMarker}" and "${endMarker}"`);
  return source.slice(start, end);
}

const generateSubjectRoute = sliceRoute(server, 'app.post("/api/pawprints/generate-subject"', 'app.post("/api/pawprints/generate"');
const generateRoute = sliceRoute(server, 'app.post("/api/pawprints/generate"', 'app.get("/api/pawprints/:id');
const ownerRoutes = sliceRoute(server, 'app.get("/api/pawprints/:id', 'app.post("/api/pawprints/send"');

test("studio starts at Theme and presents the three-step digital flow", () => {
  assert.match(shell, /useState<WizardStage>\("category"\)/);
  assert.match(shell, /label: "Theme"[\s\S]*label: "Photo"[\s\S]*label: "Finish"/);
  assert.doesNotMatch(shell, /EntryStep|PrintProductStep|entryMode|shopifyProduct/);
  assert.equal(fs.existsSync("src/components/pawprints/EntryStep.tsx"), false);
  assert.equal(fs.existsSync("src/components/pawprints/PrintProductStep.tsx"), false);
});

test("theme and custom prompt screens remain digital-only", () => {
  assert.match(digitalCategoryStep, /Choose a theme for your pet's portrait/);
  assert.match(digitalCategoryStep, /No Custom Instructions/);
  assert.match(customPromptStep, /STORY_PROMPT_TEMPLATE/);
  assert.match(catalog, /Digital-only PawPrint theme catalog/);
  assert.doesNotMatch(catalog, /PRINT_PRODUCTS|shopifyProductId|shopifyVariantId/);
});

test("low-resolution photos require the explicit Yes or No confirmation", () => {
  assert.match(photoStep, /Low-resolution image — print not allowed \/ digital OK\. Continue\?/);
  assert.match(photoStep, /role="alertdialog"/);
  assert.match(photoStep, /Yes, continue/);
  assert.match(photoStep, /No, remove image/);
  assert.match(shell, /error=\{photoError\}[\s\S]*onError=\{setPhotoError\}/);
  assert.doesNotMatch(worker, /minimum|must be at least/i);
  assert.doesNotMatch(renderer, /must be at least 600|below 600/i);
});

test("prepared photos retain original dimensions and a low-resolution flag", () => {
  for (const source of [renderer, worker]) {
    assert.match(source, /originalWidth/);
    assert.match(source, /originalHeight/);
  }
  assert.match(renderer, /lowResolution/);
});

test("Finish uses all variations and the same render pipeline for preview and save", () => {
  assert.match(renderer, /"classic"[\s\S]*"overlay"[\s\S]*"split"[\s\S]*"frame"/);
  assert.match(renderer, /"story"[\s\S]*"filmstrip"[\s\S]*"circles"[\s\S]*"mosaic"/);
  assert.match(renderer, /"polaroid"[\s\S]*"triptych"[\s\S]*"magazine"[\s\S]*"panorama"/);
  assert.match(finishStep, /const renderedImage = await renderPawprint\(\{/);
  assert.match(finishStep, /subjectArtId/);
  assert.match(finishStep, /onPawprintComplete\(pawprintId\)/);
  assert.doesNotMatch(finishStep, /shopify-checkout|printProduct|shopifyVariant/);
});

test("subject generation is cached and returns an owned subject-art identifier", () => {
  assert.match(generateSubjectRoute, /getCachedSubjectArt/);
  assert.match(generateSubjectRoute, /saveCachedSubjectArt/);
  assert.match(generateSubjectRoute, /subjectArtId/);
  assert.match(generateSubjectRoute, /generateImageWithFallback/);
  assert.match(generateSubjectRoute, /entryMode: "digital"/);
});

test("finalization requires owned subject art and persists clean and composed assets", () => {
  assert.match(generateRoute, /getOwnedSubjectArt\(req\.user!\.phone, subjectArtId\)/);
  assert.match(generateRoute, /CREDIT_PRICES\.PAWPRINT_DIGITAL/);
  assert.match(generateRoute, /subject_art_id, image_url, clean_image_url/);
  assert.match(generateRoute, /cleanImageUrl: subjectArt\.imageUrl/);
  assert.match(generateRoute, /composedImageUrl: finalUrl/);
  assert.doesNotMatch(generateRoute, /CREDIT_PRICES\.PAWPRINT_PRINT|generateImageWithFallback/);
});

test("clean and composed downloads are owner-scoped and forced as attachments", () => {
  assert.match(ownerRoutes, /getOwnedPawprintAsset\(req\.user!\.phone, pawprintId\)/);
  assert.match(ownerRoutes, /kind !== "clean" && kind !== "composed"/);
  assert.match(ownerRoutes, /Content-Disposition/);
  assert.match(ownerRoutes, /fetchBoundedRemoteBuffer/);
});

test("PawPrint studio remains separate from the Animator tree", () => {
  for (const source of [shell, finishStep, photoStep, digitalCategoryStep, customPromptStep]) {
    assert.doesNotMatch(source, /AnimatorScreen|SceneSequence|AnimationController|onGoToAnimator/);
  }
});
