import test from "node:test";
import assert from "node:assert/strict";
import { WARDROBE_CATALOG } from "../src/wardrobe/catalog.ts";
import { DIGITAL_CATEGORIES } from "../shared/pawprintCatalog2.ts";

test("wardrobe exposes exactly 15 uniquely selectable meter-scale CC0 items", () => {
  assert.equal(WARDROBE_CATALOG.length, 15);
  assert.equal(new Set(WARDROBE_CATALOG.map((item) => item.id)).size, 15);
  for (const item of WARDROBE_CATALOG) {
    assert.equal(item.sourceUnits, "meter");
    assert.equal(item.conversionToMeters, 1);
    assert.equal(item.axes, "right-handed-y-up");
    assert.equal(item.license, "CC0-1.0");
    assert.ok(item.dimensionsMeters.every((dimension) => Number.isFinite(dimension) && dimension > 0));
    assert.ok(item.anchorMeters.every(Number.isFinite));
  }
});

test("Pawprints digital categories each have several uniquely identified themes", () => {
  for (const category of DIGITAL_CATEGORIES) {
    assert.ok(category.options.length >= 4, `${category.id} should have at least four options`);
    assert.equal(new Set(category.options.map((option) => option.id)).size, category.options.length);
    assert.ok(category.options.every((option) => option.premadeScript.trim().length > 20));
  }
});
