import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  HmacSha256Authenticator,
  HttpsStationeryRenderDispatcher,
  SqlStationeryPaymentEvidenceReader,
  createStationeryV2Production,
} from "../server/stationery-v2/production.ts";

const SECRET = "stationery-production-secret-123456";

test("Phase 6 HMAC authenticators bind signatures to exact raw bytes and channel", async () => {
  const body = Buffer.from('{"event":"fulfilled"}');
  const signature = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  const authenticator = new HmacSha256Authenticator({ printful: SECRET, render: `${SECRET}-render` });

  assert.equal(await authenticator.authenticate({
    provider: "printful",
    headers: { "x-stationery-provider-signature": signature },
    rawBody: body,
  }), true);
  assert.equal(await authenticator.authenticate({
    provider: "printful",
    headers: { "x-stationery-provider-signature": signature },
    rawBody: Buffer.from('{"event":"changed"}'),
  }), false);
  assert.equal(await authenticator.authenticate({
    headers: { "x-stationery-render-signature": signature },
    rawBody: body,
  }), false);
});

test("Phase 6 render dispatcher uses HTTPS, HMAC, bounded timeout, and no redirects", async () => {
  let captured;
  const dispatcher = new HttpsStationeryRenderDispatcher(
    "https://renderer.example/v1/jobs",
    SECRET,
    async (url, init) => {
      captured = { url: String(url), init };
      return new Response("{}", { status: 202 });
    },
  );
  const dispatch = {
    contractVersion: 1,
    jobUuid: "11111111-1111-4111-8111-111111111111",
    template: {
      schemaVersion: "stationery.template.v1",
      templateUuid: "22222222-2222-4222-8222-222222222222",
      versionNumber: 1,
      topic: "Memorial",
      event: null,
      locale: "en-US",
      orientation: "portrait",
      trimIn: { width: 8, height: 10 },
      bleedIn: { top: 0.125, right: 0.125, bottom: 0.125, left: 0.125 },
      safeAreaIn: { top: 0.25, right: 0.25, bottom: 0.25, left: 0.25 },
      backgroundAsset: { assetUuid: "33333333-3333-4333-8333-333333333333", versionNumber: 1, sha256: "a".repeat(64) },
      backgroundCoverageIn: { x: -0.125, y: -0.125, width: 8.25, height: 10.25 },
      fontLicenses: [],
      slots: [],
      presets: [{ presetId: "print", purpose: "print", format: "png", widthPx: 2475, heightPx: 3075, targetDpi: 300, includeBleed: true, minimumBleedIn: 0.125, colorProfile: "sRGB" }],
      accessibilityLabel: "Memorial print template",
    },
    templateSpecHash: "b".repeat(64),
    presetId: "print",
    requestHash: "c".repeat(64),
    slotInputs: [],
  };
  await dispatcher.dispatch(dispatch);
  assert.equal(captured.url, "https://renderer.example/v1/jobs");
  assert.equal(captured.init.redirect, "error");
  assert.equal(
    captured.init.headers["x-stationery-render-signature"],
    crypto.createHmac("sha256", SECRET).update(captured.init.body).digest("hex"),
  );
});

test("Phase 6 payment reader requires owner-bound durable evidence", async () => {
  const pool = {
    async query(_sql, params) {
      if (params[1] !== "owner-a") return [[]];
      return [[{
        payment_uuid: "44444444-4444-4444-8444-444444444444",
        owner_id: "owner-a",
        state: "paid",
        fulfillment_provider: "printful",
        provider_sku: "CARD-5X7",
        unit_amount_minor: 100,
        quantity: 25,
        amount_minor: 2500,
        currency: "USD",
        confirmed_at: "2026-07-22 12:00:00.000",
        evidence_hash: "d".repeat(64),
      }]];
    },
  };
  const reader = new SqlStationeryPaymentEvidenceReader(pool);
  assert.equal((await reader.getPaymentEvidence("owner-a", "44444444-4444-4444-8444-444444444444")).state, "paid");
  assert.equal(await reader.getPaymentEvidence("owner-b", "44444444-4444-4444-8444-444444444444"), null);
});

test("Phase 6 production factory fails closed without rollout secrets", () => {
  assert.throws(
    () => createStationeryV2Production({ env: {}, pool: {} }),
    /STATIONERY_RENDER_WORKER_SECRET/,
  );
});
