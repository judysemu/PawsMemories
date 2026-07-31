import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("release helpers never print issued secrets or copy raw environment files", async () => {
  const [slantSetup, evidenceScript, exampleEnv] = await Promise.all([
    fs.readFile(new URL("../scripts/slant3d-setup.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/p0-evidence-collect.sh", import.meta.url), "utf8"),
    fs.readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(slantSetup, /\$\{p\.webhookSecret\}/);
  assert.doesNotMatch(evidenceScript, /\bcp\s+\.?\/?\.env\b/);
  assert.match(evidenceScript, /set -euo pipefail/);
  assert.match(evidenceScript, /P0_EVIDENCE_BASE_URL/);
  assert.match(evidenceScript, /curl[\s\S]*--max-time/);
  assert.match(evidenceScript, /status.*!=.*501/);
  assert.equal((exampleEnv.match(/^JWT_SECRET=/gm) || []).length, 1);
  assert.doesNotMatch(exampleEnv, /super_secret_jwt_key_for_testing/);
});
