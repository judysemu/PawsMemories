import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveLayer8Config } from "../server/spatial-generator/provider.ts";

const providerSource = await readFile(
  new URL("../server/spatial-generator/provider.ts", import.meta.url),
  "utf8",
);

test("Layer8 spatial provider uses the production API-key contract", () => {
  assert.match(providerSource, /"X-API-Key": apiKey/);
  assert.doesNotMatch(providerSource, /Authorization:\s*`Bearer \$\{LAYER8_API_KEY\}`/);
  assert.match(providerSource, /\/v1\/spatial\/health/);
});

test("Layer8 configuration is read at request time and normalizes dashboard whitespace", () => {
  assert.deepEqual(resolveLayer8Config({
    LAYER8_BASE_URL: "  https://api.salti8.com/  ",
    LAYER8_TENANT_API_KEY: "  tenant-key  ",
    LAYER8_SPATIAL_TIMEOUT_MS: "45000",
  }), {
    baseUrl: "https://api.salti8.com",
    apiKey: "tenant-key",
    timeoutMs: 45000,
  });
});
