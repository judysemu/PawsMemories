import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from "../server/migrations/runner.ts";
import { encryptApiKey, decryptApiKey, looksLikeGoogleApiKey, KeyVaultError } from "../server/byok/keyVault.ts";

const routes = fs.readFileSync("server/byok/routes.ts", "utf8");
const repo = fs.readFileSync("server/byok/repository.ts", "utf8");
const server = fs.readFileSync("server.ts", "utf8");
const SECRET = "a-test-secret-that-is-long-enough-to-pass-0123456789";
const KEY = "AIzaSyDUMMYKEYFORTESTINGONLY1234567890ab";

test("migration 54 stores keys sealed, never in plaintext", () => {
  assert.ok(CURRENT_SCHEMA_VERSION >= 54);
  const m = MIGRATIONS.find((e) => e.version === 54);
  assert.equal(m?.name, "byok_user_api_keys");
  const sql = m.statements.join("\n");
  for (const col of ["ciphertext", "iv", "auth_tag", "key_last4"]) {
    assert.match(sql, new RegExp(col), `missing ${col}`);
  }
  // There must be no column a raw key could live in.
  assert.doesNotMatch(sql, /api_key |plaintext|secret_value/);
  // One key per user per provider, so reconnecting replaces rather than stacks.
  assert.match(sql, /UNIQUE KEY uniq_user_provider \(user_phone, provider\)/);
});

test("encrypt/decrypt round-trips and exposes only the last 4", () => {
  process.env.KEY_ENCRYPTION_SECRET = SECRET;
  const sealed = encryptApiKey(KEY);
  assert.equal(sealed.last4, KEY.slice(-4));
  assert.notEqual(sealed.ciphertext, KEY);
  assert.doesNotMatch(sealed.ciphertext, new RegExp(KEY.slice(0, 12)));
  assert.equal(decryptApiKey(sealed), KEY);
});

test("every encryption uses a fresh IV", () => {
  process.env.KEY_ENCRYPTION_SECRET = SECRET;
  const a = encryptApiKey(KEY);
  const b = encryptApiKey(KEY);
  // Reusing an IV in GCM is catastrophic, so identical input must still yield
  // different ciphertext.
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(decryptApiKey(a), decryptApiKey(b));
});

test("tampered ciphertext fails closed rather than returning garbage", () => {
  process.env.KEY_ENCRYPTION_SECRET = SECRET;
  const sealed = encryptApiKey(KEY);
  const flipped = Buffer.from(sealed.ciphertext, "base64");
  flipped[0] ^= 0xff;
  assert.throws(
    () => decryptApiKey({ ...sealed, ciphertext: flipped.toString("base64") }),
    KeyVaultError,
  );
});

test("a wrong secret cannot decrypt", () => {
  process.env.KEY_ENCRYPTION_SECRET = SECRET;
  const sealed = encryptApiKey(KEY);
  process.env.KEY_ENCRYPTION_SECRET = "a-different-secret-also-long-enough-0123456789";
  assert.throws(() => decryptApiKey(sealed), KeyVaultError);
  process.env.KEY_ENCRYPTION_SECRET = SECRET;
});

test("a missing or too-short secret is refused, not silently accepted", () => {
  const saved = process.env.KEY_ENCRYPTION_SECRET;
  delete process.env.KEY_ENCRYPTION_SECRET;
  assert.throws(() => encryptApiKey(KEY), /not configured/);
  process.env.KEY_ENCRYPTION_SECRET = "too-short";
  assert.throws(() => encryptApiKey(KEY), /at least 32/);
  process.env.KEY_ENCRYPTION_SECRET = saved;
});

test("key shape is checked before any provider call", () => {
  assert.ok(looksLikeGoogleApiKey(KEY));
  assert.ok(!looksLikeGoogleApiKey("short"));
  assert.ok(!looksLikeGoogleApiKey("has spaces in it and is quite long indeed"));
});

test("the API never returns the key itself", () => {
  // Status responses carry last4 only.
  assert.match(repo, /connected: true,\s*last4/);
  assert.doesNotMatch(routes, /res\.json\([^)]*apiKey/);
  assert.doesNotMatch(routes, /ciphertext/);
});

test("a key is validated against the provider before being stored", () => {
  const route = routes.slice(routes.indexOf('router.post("/key"'));
  const body = route.slice(0, route.indexOf('router.delete("/key"'));
  assert.ok(body.indexOf("deps.validateKey") < body.indexOf("saveUserApiKey"), "validate must precede save");
  assert.match(body, /KEY_REJECTED/);
});

test("generation refuses without a connected key and never falls back to the house key", () => {
  const route = routes.slice(routes.indexOf('router.post("/generate"'));
  assert.match(route, /NO_KEY_CONNECTED/);
  assert.match(route, /status\(403\)/);
  // No reference to the shared client or the house env key anywhere.
  assert.doesNotMatch(routes, /GEMINI_API_KEY/);
  assert.doesNotMatch(routes, /generateImageWithFallback/);
});

test("disconnect removes the row rather than hiding it", () => {
  assert.match(repo, /DELETE FROM user_api_keys WHERE user_phone = \? AND provider = \?/);
});

test("provider errors are not echoed verbatim to the client", () => {
  const route = routes.slice(routes.indexOf('router.post("/generate"'));
  assert.match(route, /PROVIDER_ERROR/);
  // The raw error goes to the log, not the response — SDK messages can contain
  // the key.
  assert.doesNotMatch(route, /res\.status\(502\)\.json\(\{ error: err/);
});

test("the playground is dark by default and mounted with its own client", () => {
  assert.match(routes, /BYOK_PLAYGROUND_ENABLED === "true"/);
  assert.match(server, /createByokRouter\(getPool/);
  // The mount builds a client from the customer key, not the shared instance.
  const mount = server.slice(server.indexOf("createByokRouter(getPool"));
  const block = mount.slice(0, mount.indexOf('app.use("/api/pawprints/purchase"'));
  assert.match(block, /new GoogleGenAI\(\{ apiKey/);
  assert.match(block, /probe\.models\.list\(\)/);
});
