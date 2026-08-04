import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  HISTORIC_DIGITAL_TEMPLATES,
  HISTORIC_PHYSICAL_TEMPLATE_IDS,
  historicTemplatesForIntent,
} from "../shared/historicPawprintTemplates.ts";

test("Historic Pawprints exposes twenty generated portrait roles and five physical roles", () => {
  assert.equal(HISTORIC_DIGITAL_TEMPLATES.length, 20);
  assert.deepEqual(HISTORIC_PHYSICAL_TEMPLATE_IDS, [
    "the-composer",
    "joan-of-arc",
    "cleopatra",
    "santa",
    "the-chef",
  ]);
  assert.equal(historicTemplatesForIntent("digital").length, 20);
  assert.equal(historicTemplatesForIntent("digital-printed").length, 5);
});

test("historic templates use bounded fields and catalog-owned role prompts", () => {
  for (const template of HISTORIC_DIGITAL_TEMPLATES) {
    assert.equal(template.category, "historic_portraits");
    assert.ok(template.imagePromptTemplate.length >= 40);
    assert.ok(template.fieldSchema.some((field) => field.type === "image"));
    assert.ok(template.fieldSchema.every((field) => !field.maxLength || field.maxLength <= 220));
  }
});

test("Pawprints begins with the two approved historic products", () => {
  const studio = fs.readFileSync("src/components/PawprintsStudio.tsx", "utf8");
  assert.match(studio, /Historic Pawprint Pet Digital/);
  assert.match(studio, /Pawprint Pet Physical/);
  assert.doesNotMatch(studio, />Digital Only</);
  assert.doesNotMatch(studio, />Digital \+ Printed</);
});

/**
 * PP-2 replaced the flat twenty-item <select> (plus a decorative,
 * non-interactive contact sheet) with a searchable, thumbnail-backed grid.
 * The contract worth protecting is that a role is chosen from the SHIPPED
 * owned artwork and that the chooser is filterable — not that it is a <select>.
 */
test("historic chooser is a searchable thumbnail grid over the owned contact sheet", () => {
  const studio = fs.readFileSync("src/components/PawprintsStudio.tsx", "utf8");
  assert.match(studio, /historic-role-search/);
  assert.match(studio, /Choose a portrait title/);
  assert.match(studio, /historic-pawprints-20-v1\.webp/);
  // Every card is a slice of the one owned sheet, keyed by allowlisted role id.
  assert.match(studio, /HISTORIC_ROLE_IDS/);
  assert.match(studio, /roleSheetStyle\(item\.layoutId\)/);
  // Selecting a card still goes through the same allowlisted template chooser.
  assert.match(studio, /onClick=\{\(\) => chooseTemplate\(item\)\}/);
});

test("historic generation sends the chosen role and user photo to the server", () => {
  const studio = fs.readFileSync("src/components/PawprintsStudio.tsx", "utf8");
  const server = fs.readFileSync("server.ts", "utf8");
  assert.match(studio, /photoBase64:\s*category === "historic_portraits" \? photos\[0\]\?\.dataUrl/);
  assert.match(server, /historic-pawprint-reference/);
  assert.match(server, /template\.imagePromptTemplate/);
  assert.match(server, /generateImageWithFallback/);
  assert.match(server, /The uploaded image is the identity reference/);
});

test("historic collection master is shipped as owned site media", () => {
  for (const path of [
    "public/collections/historic-pawprints/historic-pawprints-20-v1.png",
    "public/collections/historic-pawprints/historic-pawprints-20-v1.webp",
  ]) {
    assert.ok(fs.existsSync(path), path);
    assert.ok(fs.statSync(path).size > 20_000, `${path} must contain real image data`);
  }
});
