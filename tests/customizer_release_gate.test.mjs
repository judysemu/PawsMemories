import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isCustomizerCheckoutEnabled } from "../server/customizerCheckout.ts";

test("customizer checkout is fail-closed unless explicitly enabled", () => {
  assert.equal(isCustomizerCheckoutEnabled({}), false);
  assert.equal(
    isCustomizerCheckoutEnabled({ CUSTOMIZER_CHECKOUT_ENABLED: "false" }),
    false,
  );
  assert.equal(
    isCustomizerCheckoutEnabled({ CUSTOMIZER_CHECKOUT_ENABLED: "TRUE" }),
    true,
  );
});

test("disabled customizer is hidden from buyers before any heavy or provider work", () => {
  const source = fs.readFileSync(
    new URL("../server/customizerCheckout.ts", import.meta.url),
    "utf8",
  );
  const listRoute = source.indexOf('app.get("/api/customize/products"');
  const listGate = source.indexOf(
    "if (!isCustomizerCheckoutEnabled())",
    listRoute,
  );
  const listQuery = source.indexOf("FROM customizable_products cp", listRoute);
  assert.ok(listRoute > -1 && listGate > listRoute && listGate < listQuery);

  const checkoutRoute = source.indexOf('"/api/customize/checkout"');
  const checkoutGate = source.indexOf(
    "if (!isCustomizerCheckoutEnabled())",
    checkoutRoute,
  );
  const composite = source.indexOf("buildPrintComposite(", checkoutRoute);
  const provider = source.indexOf("createPrintfulOrder({", checkoutRoute);
  assert.ok(checkoutRoute > -1 && checkoutGate > checkoutRoute);
  assert.ok(checkoutGate < composite && checkoutGate < provider);
});
