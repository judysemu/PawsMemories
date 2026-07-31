import assert from "node:assert/strict";
import test from "node:test";
import { PrintfulStationeryProvider, Slant3dStationeryProvider } from "../server/stationery-v2/providers.ts";

const recipient = {
  name: "Test Customer",
  email: "customer@example.com",
  address1: "1 Test Street",
  city: "Denver",
  stateCode: "CO",
  countryCode: "US",
  postalCode: "80202",
};

const input = {
  idempotencyKey: "fulfillment-v1-test",
  printManifestHash: "a".repeat(64),
  frozenFileUrl: "https://assets.example.test/frozen.pdf",
  providerSku: "CARD-5X7",
  placement: "front",
  quantity: 2,
  recipient,
};

test("Printful Stationery adapter creates and confirms an idempotent order", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(calls.length === 1 ? { result: { id: 42 } } : { result: { id: 42, status: "pending" } }), { status: 200 });
  };
  try {
    const provider = new PrintfulStationeryProvider({ PRINTFUL_API_KEY: "pf-secret", PRINTFUL_STATIONERY_VARIANT_MAP: JSON.stringify({ "CARD-5X7": 123 }) });
    const result = await provider.submitFrozenManifest(input);
    assert.deepEqual(result, { providerOrderId: "42", state: "processing" });
    assert.equal(calls.length, 2);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.external_id, input.idempotencyKey);
    assert.equal(body.items[0].variant_id, 123);
    assert.equal(body.recipient.country_code, "US");
    assert.match(calls[1].url, /\/orders\/42\/confirm$/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Printful Stationery adapter accepts Hostinger-literal brace and quote escaping", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ result: { id: 42 } }), { status: 200 });
  };
  try {
    const provider = new PrintfulStationeryProvider({
      PRINTFUL_API_KEY: "pf-secret",
      PRINTFUL_STATIONERY_VARIANT_MAP: '\\{\\"CARD-5X7\\":123\\}',
    });
    await provider.submitFrozenManifest(input);
    assert.equal(JSON.parse(calls[0].init.body).items[0].variant_id, 123);
  } finally { globalThis.fetch = originalFetch; }
});

test("Slant3D Stationery adapter uploads the frozen file and creates an order", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(calls.length === 1 ? { data: { publicFileServiceId: "file-1" } } : { data: { publicId: "order-1", status: "DRAFT" } }), { status: 200 });
  };
  try {
    const provider = new Slant3dStationeryProvider({ SLANT3D_API_KEY: "slant-secret", SLANT3D_PLATFORM_ID: "platform-1", SLANT3D_DEFAULT_FILAMENT_ID: "filament-1" });
    const result = await provider.submitFrozenManifest(input);
    assert.deepEqual(result, { providerOrderId: "order-1", state: "processing" });
    assert.equal(calls.length, 3);
    assert.equal(JSON.parse(calls[0].init.body).URL, input.frozenFileUrl);
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.items[0].publicFileServiceId, "file-1");
    assert.equal(body.customer.details.address.country, "US");
  } finally { globalThis.fetch = originalFetch; }
});
