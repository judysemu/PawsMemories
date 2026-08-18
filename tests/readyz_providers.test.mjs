import test from "node:test";
import assert from "node:assert/strict";

import { summarizeProviderConfig, formatReadinessResponse } from "../server.ts";

test("summarizeProviderConfig reports presence without exposing values", () => {
  const secret = "fal-live-abcdef0123456789";
  const summary = summarizeProviderConfig({ FAL_KEY: secret, GEMINI_API_KEY: "g-key" });

  assert.equal(summary.fal, true);
  assert.equal(summary.gemini, true);
  assert.equal(summary.resend, false);

  // The whole point of this endpoint is that it can be read by anyone
  // debugging a deploy, so no serialized form may contain a secret.
  assert.ok(!JSON.stringify(summary).includes(secret));
  for (const value of Object.values(summary)) {
    assert.equal(typeof value, "boolean");
  }
});

test("summarizeProviderConfig treats blank and placeholder values as absent", () => {
  const summary = summarizeProviderConfig({
    FAL_KEY: "   ",
    STRIPE_SECRET_KEY: "MY_STRIPE_SECRET_KEY",
    GEMINI_API_KEY: "PASTE_KEY_HERE",
    RESEND_API_KEY: "",
  });

  assert.equal(summary.fal, false);
  assert.equal(summary.stripe, false);
  assert.equal(summary.gemini, false);
  assert.equal(summary.resend, false);
});

test("summarizeProviderConfig requires every variable of a multi-part credential", () => {
  const partial = summarizeProviderConfig({ MEDIA_BUCKET_KEY: "id-only" });
  assert.equal(partial.mediaBucket, false);

  const complete = summarizeProviderConfig({ MEDIA_BUCKET_KEY: "id", MEDIA_BUCKET_SECRET: "secret" });
  assert.equal(complete.mediaBucket, true);
});

test("readyz exposes providers when healthy and withholds them when not", () => {
  const healthy = formatReadinessResponse(
    { configured: true, healthy: true, latencyMs: 1 },
    { version: "1.0.0", commit: "abc", schemaVersion: 55 }
  );
  assert.equal(healthy.statusCode, 200);
  assert.equal(typeof healthy.body.providers, "object");
  assert.equal(typeof healthy.body.providers.fal, "boolean");

  const unhealthy = formatReadinessResponse(
    { configured: true, healthy: false, latencyMs: 0, error: "boom" },
    { version: "1.0.0", commit: "abc", schemaVersion: 55 }
  );
  assert.equal(unhealthy.statusCode, 503);
  assert.equal(unhealthy.body.providers, undefined);
});
