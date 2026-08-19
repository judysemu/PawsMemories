import test from "node:test";
import assert from "node:assert/strict";

import { removeBackground } from "../src/photo-edit/api.ts";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

function withFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => "test-token", setItem() {}, removeItem() {} };
  globalThis.fetch = handler;
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  });
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test("a disabled feature is reported as disabled, not as an error", async () => {
  await withFetch(
    async () => jsonResponse({ error: "Photo editing is not available yet.", code: "FEATURE_DISABLED" }, 503),
    async () => {
      const outcome = await removeBackground(PNG_DATA_URL);
      assert.equal(outcome.removed, false);
      assert.equal(outcome.featureDisabled, true);
      // Nothing to say to a customer who never asked for the feature.
      assert.ok(!outcome.reason);
    },
  );
});

test("a provider failure keeps the original and explains itself", async () => {
  // The server fails OPEN: HTTP 200 carrying removed:false. Treating that as
  // success would silently replace the photo with nothing.
  await withFetch(
    async () => jsonResponse({ removed: false, code: "PROVIDER_FAILED", reason: "We couldn't separate the background." }),
    async () => {
      const outcome = await removeBackground(PNG_DATA_URL);
      assert.equal(outcome.removed, false);
      assert.equal(outcome.featureDisabled, undefined);
      assert.match(outcome.reason, /separate the background/i);
    },
  );
});

test("a network error is an outcome, never a throw", async () => {
  await withFetch(
    async () => { throw new Error("offline"); },
    async () => {
      const outcome = await removeBackground(PNG_DATA_URL);
      assert.equal(outcome.removed, false);
      assert.ok(outcome.reason);
    },
  );
});

test("a successful matte is inlined rather than left as an expiring URL", async () => {
  // The signed URL points at the private bucket and expires. Handing it
  // downstream would produce an order whose photo dies partway through.
  const cutoutBytes = Buffer.from("cutout-bytes");
  await withFetch(
    async (url) => {
      if (String(url).includes("/api/photo-edit/")) {
        return jsonResponse({ removed: true, cached: true, url: "https://private.example/signed", mimeType: "image/webp" });
      }
      return { ok: true, status: 200, blob: async () => ({ __bytes: cutoutBytes }) };
    },
    async () => {
      globalThis.FileReader = class {
        readAsDataURL(blob) {
          this.result = `data:image/webp;base64,${blob.__bytes.toString("base64")}`;
          this.onload?.();
        }
      };
      const outcome = await removeBackground(PNG_DATA_URL);
      assert.equal(outcome.removed, true);
      assert.equal(outcome.cached, true);
      assert.match(outcome.dataUrl, /^data:image\/webp;base64,/);
      assert.ok(!outcome.dataUrl.startsWith("https://"));
    },
  );
});

test("an unreachable cutout degrades to keeping the original", async () => {
  await withFetch(
    async (url) => {
      if (String(url).includes("/api/photo-edit/")) {
        return jsonResponse({ removed: true, url: "https://private.example/expired" });
      }
      return { ok: false, status: 403, blob: async () => null };
    },
    async () => {
      const outcome = await removeBackground(PNG_DATA_URL);
      assert.equal(outcome.removed, false);
      assert.ok(outcome.reason);
    },
  );
});

test("unsupported input is rejected without spending a request", async () => {
  let called = false;
  await withFetch(
    async () => { called = true; return jsonResponse({}); },
    async () => {
      const outcome = await removeBackground("data:image/gif;base64,R0lGOD");
      assert.equal(outcome.removed, false);
      assert.equal(called, false, "a format the provider cannot take must not reach the server");
    },
  );
});
