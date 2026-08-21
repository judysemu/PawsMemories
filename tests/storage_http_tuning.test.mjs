import test from "node:test";
import assert from "node:assert/strict";

const { storageHttpTuning, storageHttpClientOptions } = await import("../storage.http.ts");

test("defaults bound a stalled B2 call so the retry policy can act on it", () => {
  const t = storageHttpTuning({});
  assert.equal(t.connectionTimeout, 6_000);
  assert.equal(t.requestTimeout, 60_000);
  assert.ok(t.maxAttempts > 1, "a single attempt leaves no room to recover from a transient fault");
});

test("an operator can retune without a code change", () => {
  const t = storageHttpTuning({
    MEDIA_BUCKET_CONNECT_TIMEOUT_MS: "1500",
    MEDIA_BUCKET_REQUEST_TIMEOUT_MS: "20000",
    MEDIA_BUCKET_MAX_ATTEMPTS: "6",
  });
  assert.deepEqual(t, { connectionTimeout: 1500, requestTimeout: 20000, maxAttempts: 6 });
});

test("a nonsense override falls back rather than disabling the timeout", () => {
  // Zero or negative would mean "no timeout" to the SDK, reinstating the exact
  // hang this exists to prevent, so those must not be honoured.
  for (const bad of ["0", "-1", "abc", ""]) {
    const t = storageHttpTuning({ MEDIA_BUCKET_REQUEST_TIMEOUT_MS: bad });
    assert.equal(t.requestTimeout, 60_000, `"${bad}" must not disable the timeout`);
  }
});

test("client options carry the timeouts into the SDK request handler", () => {
  const o = storageHttpClientOptions({});
  assert.equal(o.maxAttempts, 4);
  assert.equal(o.requestHandler.connectionTimeout, 6_000);
  assert.equal(o.requestHandler.requestTimeout, 60_000);
});
