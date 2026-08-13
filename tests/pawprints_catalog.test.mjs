import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DIGITAL_CATEGORIES,
  PRINT_PRODUCTS,
  STORY_PROMPT_TEMPLATE,
  findDigitalOption,
  findPrintProduct,
  findPrintOption,
} from "../shared/pawprintCatalog2.ts";

test("exactly three digital categories: Event Themed, Seasonal/Holiday Themed, Professional/Commercial", () => {
  assert.equal(DIGITAL_CATEGORIES.length, 3);
  const ids = DIGITAL_CATEGORIES.map((category) => category.id).sort();
  assert.deepEqual(ids, ["event_themed", "professional_commercial", "seasonal_holiday"]);
});

test("every digital category option has a non-empty label and premade script", () => {
  for (const category of DIGITAL_CATEGORIES) {
    assert.ok(category.options.length > 0, `${category.id} has no options`);
    for (const option of category.options) {
      assert.ok(option.label.trim().length > 0, `${category.id}:${option.id} missing label`);
      assert.ok(option.premadeScript.trim().length > 20, `${category.id}:${option.id} premade script too short`);
    }
  }
});

test("findDigitalOption resolves a real (category, option) pair and rejects an unknown one", () => {
  const firstCategory = DIGITAL_CATEGORIES[0];
  const firstOption = firstCategory.options[0];
  const found = findDigitalOption(firstCategory.id, firstOption.id);
  assert.equal(found?.id, firstOption.id);
  assert.equal(findDigitalOption(firstCategory.id, "not-a-real-option"), undefined);
  assert.equal(findDigitalOption("not-a-real-category", firstOption.id), undefined);
});

test("STORY_PROMPT_TEMPLATE is a non-empty narrative hero+supporting-photo format", () => {
  assert.ok(STORY_PROMPT_TEMPLATE.trim().length > 20);
  assert.match(STORY_PROMPT_TEMPLATE, /hero/i);
  assert.match(STORY_PROMPT_TEMPLATE, /[Ss]upporting/);
});

test("PRINT_PRODUCTS is an array; if populated, every product carries its own category set", () => {
  assert.ok(Array.isArray(PRINT_PRODUCTS));
  for (const product of PRINT_PRODUCTS) {
    assert.ok(product.shopifyProductId, "product missing shopifyProductId");
    assert.ok(Array.isArray(product.categories) && product.categories.length > 0, `${product.title} has no categories`);
  }
});

test("findPrintProduct / findPrintOption return undefined for an unconfigured product rather than throwing", () => {
  assert.equal(findPrintProduct("does-not-exist"), undefined);
  assert.equal(findPrintOption("does-not-exist", "event_themed", "birthday"), undefined);
});
