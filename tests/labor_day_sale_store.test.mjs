import assert from "node:assert/strict";
import { test } from "node:test";

const {
  LABOR_DAY_SALE,
  isLaborDaySaleActive,
  laborDayDiscountUrl,
} = await import("../src/components/Store.tsx");

test("Labor Day sale window and checkout limits match the live Shopify rule", () => {
  assert.equal(LABOR_DAY_SALE.code, "LABORDAY30");
  assert.equal(LABOR_DAY_SALE.discountPercent, 30);
  assert.equal(LABOR_DAY_SALE.usageLimit, 100);
  assert.equal(LABOR_DAY_SALE.eligibleHandles.size, 5);
  assert.equal(isLaborDaySaleActive(Date.parse("2026-09-04T18:25:04Z")), true);
  assert.equal(isLaborDaySaleActive(Date.parse("2026-09-14T05:59:59Z")), true);
  assert.equal(isLaborDaySaleActive(Date.parse("2026-09-14T06:00:00Z")), false);
});

test("eligible Shopify links pre-apply the live discount code", () => {
  assert.equal(
    laborDayDiscountUrl("https://pawprints-by-pawsome3d.myshopify.com/products/example?variant=123"),
    "https://pawprints-by-pawsome3d.myshopify.com/discount/LABORDAY30?redirect=%2Fproducts%2Fexample%3Fvariant%3D123",
  );
  assert.equal(laborDayDiscountUrl("https://example.com/products/example"), "https://example.com/products/example");
  assert.equal(laborDayDiscountUrl("not a url"), "not a url");
});
