import test from "node:test";
import assert from "node:assert/strict";
import { WARDROBE_CATALOG } from "../src/wardrobe/catalog.ts";
import { getPawprintCategories, getPawprintTemplatesSync } from "../db.ts";

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

test("Pawprints templates have either a free source or owned generated art", () => {
  const categories = getPawprintCategories();
  const templates = getPawprintTemplatesSync();
  for (const category of categories) {
    const matching = templates.filter((template) => template.category === category);
    assert.ok(matching.length >= 4, `${category} should have at least four templates`);
    assert.equal(new Set(matching.map((template) => template.layoutId)).size, matching.length);
    assert.ok(matching.every((template) => ["CC0-1.0", "owned-generated"].includes(template.sourceLicense)));
    assert.ok(matching.every((template) => template.sourceLicense === "owned-generated"
      ? template.sourceUrl?.startsWith("/collections/")
      : template.sourceUrl?.startsWith("https://")));
  }
});
