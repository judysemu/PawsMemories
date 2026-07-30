import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getPawprintPrintProducts } from "../server/pawprintProducts.ts";

const originalCatalog = process.env.PAWPRINT_PRINT_PRODUCTS_JSON;
const originalLegacyVariant = process.env.PRINTFUL_PAWPRINT_VARIANT_ID;

afterEach(() => {
  if (originalCatalog === undefined) delete process.env.PAWPRINT_PRINT_PRODUCTS_JSON;
  else process.env.PAWPRINT_PRINT_PRODUCTS_JSON = originalCatalog;
  if (originalLegacyVariant === undefined) delete process.env.PRINTFUL_PAWPRINT_VARIANT_ID;
  else process.env.PRINTFUL_PAWPRINT_VARIANT_ID = originalLegacyVariant;
});

test("Pawprint products parse strict JSON", () => {
  process.env.PAWPRINT_PRINT_PRODUCTS_JSON =
    '[{"code":"poster-8x10","label":"8 x 10 Art Print","variantId":4463,"widthIn":8,"heightIn":10}]';
  assert.equal(getPawprintPrintProducts()[0]?.variantId, 4463);
});

test("Pawprint products tolerate Hostinger literal brace and quote escaping", () => {
  process.env.PAWPRINT_PRINT_PRODUCTS_JSON =
    '[\\{\\\"code\\\":\\\"poster-8x10\\\",\\\"label\\\":\\\"8 x 10 Art Print\\\",\\\"variantId\\\":4463,\\\"widthIn\\\":8,\\\"heightIn\\\":10\\}]';
  const products = getPawprintPrintProducts();
  assert.equal(products.length, 1);
  assert.equal(products[0].code, "poster-8x10");
  assert.equal(products[0].variantId, 4463);
});

test("Pawprint products still reject malformed catalogs", () => {
  delete process.env.PRINTFUL_PAWPRINT_VARIANT_ID;
  process.env.PAWPRINT_PRINT_PRODUCTS_JSON = '[\\{"code":"missing-required-fields"\\}]';
  assert.deepEqual(getPawprintPrintProducts(), []);
});
