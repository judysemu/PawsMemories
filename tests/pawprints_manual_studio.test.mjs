import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const entryStep = fs.readFileSync("src/components/pawprints/EntryStep.tsx", "utf8");
const digitalCategoryStep = fs.readFileSync("src/components/pawprints/DigitalCategoryStep.tsx", "utf8");
const printProductStep = fs.readFileSync("src/components/pawprints/PrintProductStep.tsx", "utf8");
const customPromptStep = fs.readFileSync("src/components/pawprints/CustomPromptStep.tsx", "utf8");
const finishStep = fs.readFileSync("src/components/pawprints/FinishStep.tsx", "utf8");
const shell = fs.readFileSync("src/components/PawprintsStudio.tsx", "utf8");
const renderPawprint = fs.readFileSync("src/pawprints/renderPawprint.tsx", "utf8");
const catalog = fs.readFileSync("shared/pawprintCatalog2.ts", "utf8");
const server = fs.readFileSync("server.ts", "utf8");

function sliceRoute(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `could not locate route between "${startMarker}" and "${endMarker}"`);
  return source.slice(start, end);
}

const generateSubjectRoute = sliceRoute(server, 'app.post("/api/pawprints/generate-subject"', 'app.post("/api/pawprints/generate"');
const generateRoute = sliceRoute(server, 'app.post("/api/pawprints/generate"', 'app.post("/api/pawprints/send"');
const sendRoute = sliceRoute(server, 'app.post("/api/pawprints/send"', 'app.get("/api/pawprints/print-products"');

test("Entry step offers Digital and Print at the flat v2 price, with no subject-tier pricing", () => {
  assert.match(entryStep, /onChoose\("digital"\)/);
  assert.match(entryStep, /onChoose\("print"\)/);
  assert.match(entryStep, /CREDIT_PRICES\.PAWPRINT_DIGITAL/);
  assert.match(entryStep, /CREDIT_PRICES\.PAWPRINT_PRINT/);
  assert.doesNotMatch(entryStep, /PAWPRINT_OWNER_PET|PAWPRINT_MULTI_PET/);
});

test("Digital category step offers the three themed categories, each with a dropdown and a customize choice", () => {
  assert.match(digitalCategoryStep, /Choose a theme for your pet's portrait/);
  assert.match(digitalCategoryStep, /Would you like to customize your print\?/);
  assert.match(digitalCategoryStep, /Customize · \+\{CREDIT_PRICES\.PAWPRINT_CUSTOMIZE_ADDON\}/);
  assert.match(digitalCategoryStep, /No Custom Instructions/);
});

test("Print product step requires picking a product before its own theme menu appears", () => {
  assert.match(printProductStep, /Choose your product/);
  assert.match(printProductStep, /selectedProduct\.categories/);
  assert.match(printProductStep, /CategoryOptionPicker/);
});

test("Custom prompt step surfaces the suggested Story format", () => {
  assert.match(customPromptStep, /STORY_PROMPT_TEMPLATE/);
  assert.match(customPromptStep, /Use this format/);
});

test("shared/pawprintCatalog2.ts defines the three digital categories with non-empty premade scripts", () => {
  assert.match(catalog, /event_themed/);
  assert.match(catalog, /seasonal_holiday/);
  assert.match(catalog, /professional_commercial/);
  assert.match(catalog, /STORY_PROMPT_TEMPLATE/);
});

test("Finish step renders all twelve variations and keeps Live Preview on the same pipeline as Save", () => {
  assert.match(renderPawprint, /"classic"[\s\S]*"overlay"[\s\S]*"split"[\s\S]*"frame"/);
  assert.match(renderPawprint, /"story"[\s\S]*"filmstrip"[\s\S]*"circles"[\s\S]*"mosaic"/);
  assert.match(renderPawprint, /"polaroid"[\s\S]*"triptych"[\s\S]*"magazine"[\s\S]*"panorama"/);
  assert.match(finishStep, /renderPawprint\(\{/);
  assert.match(finishStep, /compositePhotos/);
  // Save posts the exact same renderedImage the Live Preview produced.
  assert.match(finishStep, /const renderedImage = await renderPawprint\(\{/);
});

test("Stage 1 subject art is generated once per design and cached, not on every keystroke", () => {
  assert.match(finishStep, /generate-subject/);
  assert.match(finishStep, /subjectArtDataUrl/);
  // The debounced Stage 2 preview effect depends on compositePhotos (derived
  // from the cached subject art), not on category/option directly re-firing generation.
  assert.match(finishStep, /useEffect\(\(\) => \{\s*if \(compositePhotos\.length === 0\) return;/);
});

test("POST /api/pawprints/generate-subject caches one AI generation per (theme/prompt, photo-set)", () => {
  assert.match(generateSubjectRoute, /getCachedSubjectArt/);
  assert.match(generateSubjectRoute, /saveCachedSubjectArt/);
  assert.match(generateSubjectRoute, /generateImageWithFallback/);
  assert.match(generateSubjectRoute, /createHash\("sha256"\)/);
});

test("POST /api/pawprints/generate is a uniform Stage 2 finalize with no server-side AI branch", () => {
  assert.match(generateRoute, /renderedImage/);
  assert.match(generateRoute, /limitInputPixels: 16_000_000/);
  assert.match(generateRoute, /sharp\(sourceBuffer, sharpInputOptions\)/);
  assert.match(generateRoute, /\.webp\(\{ quality: 92/);
  assert.doesNotMatch(generateRoute, /generateImageWithFallback/);
  assert.doesNotMatch(generateRoute, /isAiPortraitCategory/);
});

test("Pricing: flat entryMode base plus an optional customize add-on, no subject-tier pricing", () => {
  assert.match(generateRoute, /entryMode === "print" \? CREDIT_PRICES\.PAWPRINT_PRINT : CREDIT_PRICES\.PAWPRINT_DIGITAL/);
  assert.match(generateRoute, /if \(customized\) pawprintPrice \+= CREDIT_PRICES\.PAWPRINT_CUSTOMIZE_ADDON;/);
  assert.doesNotMatch(generateRoute, /owner_pet|multi_pet/);
});

test("Pawprints export fits the exact title and message inside every template text rectangle", () => {
  assert.match(renderPawprint, /function drawFittedTextBlock/);
  assert.match(renderPawprint, /height: plan\.text\.height \* PRINT_HEIGHT/);
  assert.match(renderPawprint, /wrapTextLines\(ctx, input\.message, maxWidth\)/);
});

test("Pawprints remains separate from the Animator component tree", () => {
  for (const source of [shell, finishStep, entryStep, digitalCategoryStep, printProductStep, customPromptStep]) {
    assert.doesNotMatch(source, /AnimatorScreen|SceneSequence|AnimationController|onGoToAnimator/);
  }
});

test("Pawprints email and print actions are bound to the exact saved design revision", () => {
  assert.match(finishStep, /const designSignature = useMemo/);
  assert.match(finishStep, /liveDesignSignatureRef\.current !== submittedDesignSignature/);
  assert.match(finishStep, /Save the updated design before sending or printing it/);
});

test("POST /api/pawprints/send is gated to Digital-only creations and charges the email price", () => {
  assert.match(sendRoute, /entryMode !== "digital"/);
  assert.match(sendRoute, /Only Digital Pawprints can be emailed/);
  assert.match(sendRoute, /CREDIT_PRICES\.PAWPRINT_EMAIL/);
});
