import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const providerSource = await readFile(
  new URL("../server/spatial-generator/provider.ts", import.meta.url),
  "utf8",
);

test("Layer8 spatial provider uses the production API-key contract", () => {
  assert.match(providerSource, /"X-API-Key": LAYER8_API_KEY/);
  assert.doesNotMatch(providerSource, /Authorization:\s*`Bearer \$\{LAYER8_API_KEY\}`/);
  assert.match(providerSource, /\/v1\/spatial\/health/);
});
