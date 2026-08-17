import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from "../server/migrations/runner.ts";

const server = fs.readFileSync("server.ts", "utf8");
const db = fs.readFileSync("db.ts", "utf8");

test("migration 51 creates the verification token table with hash-only storage", () => {
  assert.ok(CURRENT_SCHEMA_VERSION >= 51);
  const migration = MIGRATIONS.find((entry) => entry.version === 51);
  assert.equal(migration?.name, "email_verification_tokens");
  const sql = migration.statements.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS email_verifications/);
  for (const column of ["user_phone", "email", "token_hash", "expires_at", "used_at"]) {
    assert.match(sql, new RegExp(column), `missing column ${column}`);
  }
  // The raw token must never have a column to live in.
  assert.doesNotMatch(sql, /token\s+VARCHAR|raw_token/);
});

test("the free-image entitlement column exists and defaults to unclaimed", () => {
  assert.match(db, /free_image_claimed TINYINT\(1\) NOT NULL DEFAULT 0/);
});

test("issuing a verification invalidates prior unused tokens", () => {
  const fn = db.slice(db.indexOf("export async function createEmailVerification"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /UPDATE email_verifications SET used_at = NOW\(\)[\s\S]*used_at IS NULL/);
  assert.match(body, /INSERT INTO email_verifications/);
  // Only the hash is ever persisted.
  assert.match(body, /tokenHash/);
});

test("consuming a token checks expiry and single-use in SQL, not in JS", () => {
  const fn = db.slice(db.indexOf("export async function consumeEmailVerification"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /used_at IS NULL/);
  assert.match(body, /expires_at > NOW\(\)/);
  assert.match(body, /FOR UPDATE/);
});

test("a token cannot verify an address the account no longer uses", () => {
  const fn = db.slice(db.indexOf("export async function consumeEmailVerification"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  // The stored address is compared against the current account email, and a
  // mismatch burns the token without setting email_verified.
  assert.match(body, /current_email/);
  assert.match(body, /row\.email[\s\S]*!==[\s\S]*current_email/);
});

test("token consumption and the verified flag are one transaction", () => {
  const fn = db.slice(db.indexOf("export async function consumeEmailVerification"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /beginTransaction/);
  assert.match(body, /UPDATE users SET email_verified = 1/);
  assert.match(body, /commit\(\)/);
  assert.match(body, /rollback\(\)/);
  assert.match(body, /conn\.release\(\)/);
});

test("the free image is claimed by a conditional update, not a read-then-write", () => {
  const fn = db.slice(db.indexOf("export async function claimFreeImage"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /UPDATE users SET free_image_claimed = 1/);
  assert.match(body, /email_verified = 1/);
  assert.match(body, /free_image_claimed = 0/);
  assert.match(body, /affectedRows === 1/);
});

test("a failed generation returns the free image", () => {
  const fn = db.slice(db.indexOf("export async function releaseFreeImage"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /free_image_claimed = 0/);
  assert.match(body, /WHERE phone = \? AND free_image_claimed = 1/);
});

test("verification routes are rate limited like the password-reset pair", () => {
  assert.match(server, /app\.use\("\/api\/auth\/send-verification", authLimiter\)/);
  assert.match(server, /app\.use\("\/api\/auth\/verify-email", authLimiter\)/);
});

test("send-verification enforces a per-account resend floor", () => {
  assert.match(server, /VERIFICATION_RESEND_FLOOR_SECONDS/);
  assert.match(server, /secondsSinceLastEmailVerification/);
});

test("send-verification never reveals whether a send occurred", () => {
  const route = server.slice(server.indexOf('app.post("/api/auth/send-verification"'));
  const body = route.slice(0, route.indexOf('app.post("/api/auth/verify-email"'));
  // Every path returns the same generic payload, including the catch.
  assert.match(body, /const generic = \{ success: true/);
  const returns = body.match(/return res\.json\(generic\)/g) || [];
  assert.ok(returns.length >= 4, `expected every branch to return the generic payload, saw ${returns.length}`);
  assert.doesNotMatch(body, /res\.status\(4\d\d\)/);
});

test("verify-email gives one message for every failure mode", () => {
  const route = server.slice(server.indexOf('app.post("/api/auth/verify-email"'));
  const body = route.slice(0, route.indexOf('app.post("/api/auth/accept-terms"'));
  assert.match(body, /invalid or has expired/);
  // Exactly one client-facing rejection message, so expired/used/unknown/
  // address-changed are indistinguishable.
  const rejections = body.match(/is invalid or has expired/g) || [];
  assert.equal(rejections.length, 1);
});

test("the public user exposes the free-image entitlement without leaking the raw flag", () => {
  assert.match(db, /freeImageAvailable: !!userRow\.email_verified && !userRow\.free_image_claimed/);
});
