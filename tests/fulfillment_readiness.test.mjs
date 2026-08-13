import assert from "node:assert/strict";
import test from "node:test";
import { buildFulfillmentReadiness } from "../server/fulfillmentReadiness.ts";

const ready = {
  stripeConfigured: true,
  slantConfigured: true,
  shopifyConfigured: true,
  pawprintProductCount: 2,
  storageConfigured: true,
  workerConfigured: true,
};

test("fulfillment is available only when every provider dependency is ready", () => {
  const result = buildFulfillmentReadiness(ready);
  assert.equal(result.modelPrinting.available, true);
  assert.equal(result.pawprintPrinting.available, true);
  assert.equal(result.pawprintPrinting.productCount, 2);
});

test("model printing fails closed for each missing dependency", () => {
  for (const key of ["stripeConfigured", "slantConfigured", "storageConfigured", "workerConfigured"]) {
    const result = buildFulfillmentReadiness({ ...ready, [key]: false });
    assert.equal(result.modelPrinting.available, false, key);
  }
});

test("Pawprint printing fails closed without Shopify, storage, or products", () => {
  for (const key of ["shopifyConfigured", "storageConfigured"]) {
    const result = buildFulfillmentReadiness({ ...ready, [key]: false });
    assert.equal(result.pawprintPrinting.available, false, key);
  }
  assert.equal(buildFulfillmentReadiness({ ...ready, pawprintProductCount: 0 }).pawprintPrinting.available, false);
});
