import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

const { parseNativeProviderWebhook } = await import("../server/stationery-v2/nativeWebhooks.ts");
const { HmacSha256Authenticator } = await import("../server/stationery-v2/production.ts");

test("Printful native order event maps by external idempotency key", () => {
  const parsed = parseNativeProviderWebhook("printful", {
    type: "order_updated",
    created: 1710000000,
    data: { order: { id: 987, external_id: "fulfillment-v1-abc", status: "fulfilled" } },
  });
  assert.equal(parsed.providerIdempotencyKey, "fulfillment-v1-abc");
  assert.equal(parsed.providerOrderId, "987");
  assert.equal(parsed.event.type, "provider_fulfilled");
});

test("Printful v2 signature verifies with returned hexadecimal secret key", async () => {
  const secret = "0123456789abcdef".repeat(4);
  const body = Buffer.from('{"type":"order_updated"}');
  const signature = crypto.createHmac("sha256", Buffer.from(secret, "hex")).update(body).digest("hex");
  const authenticator = new HmacSha256Authenticator({ printful: secret });
  assert.equal(await authenticator.authenticateNative({ provider: "printful", headers: { "x-pf-webhook-signature": signature }, rawBody: body }), true);
  assert.equal(await authenticator.authenticateNative({ provider: "printful", headers: { "x-pf-webhook-signature": `${signature}0` }, rawBody: body }), false);
});
