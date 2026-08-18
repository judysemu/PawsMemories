import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from "../server/migrations/runner.ts";
import { buildCartPermalink, numericVariantId, referenceFromOrderPayload, CartPermalinkError } from "../server/pawprint-purchase/cartPermalink.ts";

const routes = fs.readFileSync("server/pawprint-purchase/routes.ts", "utf8");
const server = fs.readFileSync("server.ts", "utf8");
const REF = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

test("migration 52 makes creation_id nullable and adds the order lifecycle columns", () => {
  assert.ok(CURRENT_SCHEMA_VERSION >= 52);
  const m = MIGRATIONS.find((e) => e.version === 52);
  assert.equal(m?.name, "pawprint_purchase_gate");
  const sql = m.statements.join("\n");
  assert.match(sql, /MODIFY COLUMN creation_id INT NULL/);
  for (const col of ["draft_spec_json", "review_status", "furbin_item_uuid", "generation_error"]) {
    assert.match(sql, new RegExp(col), `missing ${col}`);
  }
});

test("cart permalink targets the numeric variant and carries the reference", () => {
  const url = buildCartPermalink({ storeDomain: "shop.myshopify.com", variantGid: "gid://shopify/ProductVariant/1234567890", reference: REF });
  assert.match(url, /^https:\/\/shop\.myshopify\.com\/cart\/1234567890:1\?/);
  assert.match(url, /attributes%5Bpawprint_order%5D=3f2504e0/);
  // Mirrored into the note too, because some themes drop cart attributes.
  assert.match(url, /note=pawprint_order%3A3f2504e0/);
});

test("permalink refuses bad input rather than guessing", () => {
  assert.throws(() => buildCartPermalink({ storeDomain: "", variantGid: "gid://shopify/ProductVariant/1", reference: REF }), CartPermalinkError);
  assert.throws(() => buildCartPermalink({ storeDomain: "s.com", variantGid: "gid://shopify/ProductVariant/1234567890", reference: "not-a-uuid" }), CartPermalinkError);
  assert.throws(() => numericVariantId("gid://shopify/ProductVariant/abc"), CartPermalinkError);
});

test("quantity is clamped to a sane range", () => {
  assert.match(buildCartPermalink({ storeDomain: "s.com", variantGid: "gid://shopify/ProductVariant/1234567890", reference: REF, quantity: 999 }), /\/cart\/1234567890:10\?/);
  assert.match(buildCartPermalink({ storeDomain: "s.com", variantGid: "gid://shopify/ProductVariant/1234567890", reference: REF, quantity: 0 }), /\/cart\/1234567890:1\?/);
});

test("the reference is recovered from cart attributes or the note", () => {
  assert.equal(referenceFromOrderPayload({ note_attributes: [{ name: "pawprint_order", value: REF }] }), REF);
  assert.equal(referenceFromOrderPayload({ note: `pawprint_order:${REF}` }), REF);
  assert.equal(referenceFromOrderPayload({ note: "a normal merch order" }), null);
});

test("checkout stores a frozen spec and generates nothing", () => {
  const route = routes.slice(routes.indexOf('router.post("/checkout"'));
  const body = route.slice(0, route.indexOf('router.get("/orders"'));
  assert.match(body, /INSERT INTO pawprint_shopify_orders/);
  assert.match(body, /draft_spec_json/);
  assert.match(body, /'draft'/);
  // The whole point of the phase: no generation before payment.
  assert.doesNotMatch(body, /generateImage|generate\(/);
});

test("the customer chooses the product; the choice is re-validated, not trusted", () => {
  const route = routes.slice(routes.indexOf('router.post("/checkout"'));
  const body = route.slice(0, route.indexOf('router.get("/products"') > 0
    ? route.indexOf('router.get("/products"') : route.indexOf('router.get("/orders"'));
  assert.match(body, /req\.body\?\.productHandle/);
  // The handle is re-checked against the same personalizable filter, so a
  // stale or forged handle cannot route an order to an off-sale product.
  assert.match(body, /AND handle = \?/);
  assert.match(body, /pawprint_personalizable = 1/);
  // No silent cheapest-product fallback.
  assert.doesNotMatch(body, /ORDER BY min_price ASC LIMIT 1/);
  assert.match(body, /PRODUCT_NOT_CHOSEN/);
});

test("the product list offers exactly what checkout will accept", () => {
  const list = routes.slice(routes.indexOf('router.get("/products"'));
  const body = list.slice(0, list.indexOf("router.get(\"/orders\""));
  for (const clause of ["active = 1", "published = 1", "available_for_sale = 1", "pawprint_personalizable = 1"]) {
    assert.match(body, new RegExp(clause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), clause);
  }
});

test("checkout fails closed when no personalizable product exists", () => {
  assert.match(routes, /pawprint_personalizable = 1/);
  assert.match(routes, /NO_PERSONALIZABLE_PRODUCT/);
  // It must not fall back to an arbitrary product — that would charge for the wrong item.
  assert.doesNotMatch(routes, /ORDER BY RAND/);
});

test("the sweep claims each order before generating, so retries cannot duplicate work", () => {
  const sweep = routes.slice(routes.indexOf("export async function sweepPaidPawprintOrders"));
  assert.match(sweep, /SET status = 'generating'[\s\S]*WHERE id = \? AND status = 'paid'/);
  assert.match(sweep, /if \(!claim\.affectedRows\) continue/);
});

test("a paid order that fails generation is recorded, never dropped", () => {
  const sweep = routes.slice(routes.indexOf("export async function sweepPaidPawprintOrders"));
  assert.match(sweep, /status='failed', generation_error=\?/);
  // Failed orders surface in the admin queue.
  assert.match(routes, /status IN \('paid','generated','failed'\)/);
});

test("review is required by default and is a flag, not a rebuild", () => {
  assert.match(routes, /PAWPRINT_AUTO_APPROVE !== "true"/);
  assert.match(routes, /isPawprintReviewRequired\(\)/);
});

test("a review decision never alters payment state", () => {
  const decide = routes.slice(routes.indexOf('router.post("/admin/reviews/:reference/decide"'));
  const body = decide.slice(0, decide.indexOf("  return router;"));
  assert.doesNotMatch(body, /paid_at|shopify_order_id/);
  // Regenerate returns the order to 'paid' so the sweep retries it.
  assert.match(body, /'paid'/);
});

test("the gate is dark by default and the sweep respects it", () => {
  assert.match(routes, /PAWPRINT_PURCHASE_GATE_ENABLED === "true"/);
  assert.match(routes, /if \(!isPawprintPurchaseGateEnabled\(\)\) return \{ processed: 0, failed: 0 \}/);
  assert.match(server, /if \(isPawprintPurchaseGateEnabled\(\)\)/);
});

test("the webhook reads cart attributes as well as the legacy note", () => {
  assert.match(server, /referenceFromOrderPayload\(order\) \|\| extractPawprintOrderReference/);
});
