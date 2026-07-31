import test from "node:test";
import assert from "node:assert/strict";

import { getStudioProxyConfiguration } from "../server/animator/studio_proxy.ts";

test("Studio proxy is disabled unless explicitly and securely configured", () => {
  assert.deepEqual(getStudioProxyConfiguration({}), {
    enabled: false,
    serviceUrl: null,
    internalSecret: null,
  });
  assert.equal(getStudioProxyConfiguration({
    STUDIO_PROXY_ENABLED: "true",
    STUDIO_SERVICE_URL: "http://localhost:8001",
    STUDIO_INTERNAL_SECRET: "too-short",
  }).enabled, false);
  assert.equal(getStudioProxyConfiguration({
    STUDIO_PROXY_ENABLED: "true",
    STUDIO_SERVICE_URL: "file:///tmp/studio.sock",
    STUDIO_INTERNAL_SECRET: "x".repeat(32),
  }).enabled, false);
});

test("Studio proxy accepts only an explicit URL plus a 32-byte internal secret", () => {
  assert.deepEqual(getStudioProxyConfiguration({
    STUDIO_PROXY_ENABLED: "true",
    STUDIO_SERVICE_URL: "http://127.0.0.1:8001",
    STUDIO_INTERNAL_SECRET: "s".repeat(32),
  }), {
    enabled: true,
    serviceUrl: "http://127.0.0.1:8001",
    internalSecret: "s".repeat(32),
  });
});
