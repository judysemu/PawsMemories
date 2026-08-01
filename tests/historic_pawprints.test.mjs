import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  HISTORIC_DIGITAL_TEMPLATES,
  HISTORIC_PHYSICAL_TEMPLATE_IDS,
  historicTemplatesForIntent,
} from "../shared/historicPawprintTemplates.ts";

test("Historic Pawprints exposes fifteen digital roles and five physical roles", () => {
  assert.equal(HISTORIC_DIGITAL_TEMPLATES.length, 15);
  assert.deepEqual(HISTORIC_PHYSICAL_TEMPLATE_IDS, [
    "the-composer",
    "joan-of-arc",
    "cleopatra",
    "santa",
    "the-chef",
  ]);
  assert.equal(historicTemplatesForIntent("digital").length, 15);
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
