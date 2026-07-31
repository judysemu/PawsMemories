import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studio = await readFile(new URL("../src/components/PetModelStudio.tsx", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const printShop = await readFile(new URL("../src/components/PrintShopScreen.tsx", import.meta.url), "utf8");

test("model generation owns a visible busy state before reference generation starts", () => {
  const start = studio.indexOf("const start = async () =>");
  const busy = studio.indexOf("setBusy(true)", start);
  const generation = studio.indexOf("startReferenceAttempt(", start);
  assert.ok(start >= 0 && busy > start && generation > busy);
  assert.match(studio, /Generating the complete 360° view set/);
  assert.match(studio, /aria-live="polite"/);
});

test("every uploaded model reference can be removed", () => {
  assert.match(studio, /const removeReference = \(key: string\)/);
  assert.match(studio, /aria-label=\{`Remove \$\{label\} image`\}/);
  assert.match(studio, /delete next\[key\]/);
});

test("sidebar Pawprints uses the pawprint icon instead of the question-mark fallback", () => {
  assert.match(app, /pawprints:\s*PawPrint/);
});

test("printed examples live in the print shop while the builder introduces collars", () => {
  assert.doesNotMatch(studio, /PrintGallery|PRINT_EXAMPLES/);
  assert.match(studio, /Custom-fit collars/);
  assert.match(printShop, /const PRINT_EXAMPLES/);
  assert.match(printShop, /Printed examples/);
});
