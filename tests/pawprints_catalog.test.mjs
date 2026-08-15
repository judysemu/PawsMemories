import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DIGITAL_CATEGORIES,
  STORY_PROMPT_TEMPLATE,
  findDigitalOption,
} from "../shared/pawprintCatalog2.ts";

test("PawPrint creation exposes exactly three digital categories", () => {
  assert.equal(DIGITAL_CATEGORIES.length, 3);
  const ids = DIGITAL_CATEGORIES.map((category) => category.id).sort();
  assert.deepEqual(ids, ["event_themed", "professional_commercial", "seasonal_holiday"]);
});

test("every digital category option has a label and premade script", () => {
  for (const category of DIGITAL_CATEGORIES) {
    assert.ok(category.options.length > 0, `${category.id} has no options`);
    for (const option of category.options) {
      assert.ok(option.label.trim().length > 0, `${category.id}:${option.id} missing label`);
      assert.ok(option.premadeScript.trim().length > 20, `${category.id}:${option.id} premade script too short`);
    }
  }
});

test("findDigitalOption resolves real choices and rejects unknown ones", () => {
  const firstCategory = DIGITAL_CATEGORIES[0];
  const firstOption = firstCategory.options[0];
  assert.equal(findDigitalOption(firstCategory.id, firstOption.id)?.id, firstOption.id);
  assert.equal(findDigitalOption(firstCategory.id, "not-a-real-option"), undefined);
  assert.equal(findDigitalOption("not-a-real-category", firstOption.id), undefined);
});

test("the custom prompt helper remains a narrative hero format", () => {
  assert.ok(STORY_PROMPT_TEMPLATE.trim().length > 20);
  assert.match(STORY_PROMPT_TEMPLATE, /hero/i);
  assert.match(STORY_PROMPT_TEMPLATE, /supporting/i);
});
