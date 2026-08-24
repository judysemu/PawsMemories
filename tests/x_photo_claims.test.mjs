import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createHash } from "node:crypto";

const {
  hashClaimToken,
  matchesClaimServiceSecret,
  isClaimMintEnabled,
  claimMediaOrigins,
  MintClaimSchema,
  ConsumeClaimSchema,
} = await import("../server/x-claims/routes.ts");
const { directPhotoUrl } = await import("../x-dm-service/src/photoClaim.ts");
const { readTokenFromPath } = await import("../src/components/ClaimPhoto.tsx");

/**
 * Strip comments before asserting on what the code does. These files explain at
 * length what they deliberately do NOT touch, so a naive search finds the very
 * words the assertion is trying to forbid.
 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("claim tokens are stored hashed, never raw", () => {
  const token = "a".repeat(43);
  const hash = hashClaimToken(token);
  assert.equal(hash, createHash("sha256").update(token).digest("hex"));
  assert.notEqual(hash, token);
  assert.equal(hash.length, 64);
});

test("the mint endpoint fails closed without a strong shared secret", () => {
  assert.equal(isClaimMintEnabled({}), false);
  assert.equal(isClaimMintEnabled({ X_CLAIM_SERVICE_SECRET: "" }), false);
  // A short secret is worse than none: it looks configured while being guessable.
  assert.equal(isClaimMintEnabled({ X_CLAIM_SERVICE_SECRET: "short" }), false);
  assert.equal(isClaimMintEnabled({ X_CLAIM_SERVICE_SECRET: "z".repeat(32) }), true);
});

test("the service secret comparison rejects empty, wrong, and unconfigured", () => {
  const previous = process.env.X_CLAIM_SERVICE_SECRET;
  try {
    delete process.env.X_CLAIM_SERVICE_SECRET;
    assert.equal(matchesClaimServiceSecret("anything"), false);

    process.env.X_CLAIM_SERVICE_SECRET = "s".repeat(40);
    assert.equal(matchesClaimServiceSecret(""), false);
    assert.equal(matchesClaimServiceSecret("wrong"), false);
    assert.equal(matchesClaimServiceSecret("s".repeat(40)), true);
  } finally {
    if (previous === undefined) delete process.env.X_CLAIM_SERVICE_SECRET;
    else process.env.X_CLAIM_SERVICE_SECRET = previous;
  }
});

test("an unconfigured bucket yields no allowed fetch origins, so re-fetch refuses", () => {
  assert.deepEqual(claimMediaOrigins({}), []);
  assert.deepEqual(claimMediaOrigins({ MEDIA_BUCKET_URL: "https://s3.example.com" }), []);
  assert.deepEqual(
    claimMediaOrigins({ MEDIA_BUCKET_URL: "https://s3.example.com", MEDIA_BUCKET_NAME: "paws" }),
    ["https://s3.example.com", "https://paws.s3.example.com"],
  );
});

test("mint input accepts only image types and refuses unknown fields", () => {
  const ok = MintClaimSchema.safeParse({ imageBase64: "AAAA", mimeType: "image/jpeg" });
  assert.equal(ok.success, true);
  assert.equal(ok.data.source, "x_dm");

  assert.equal(
    MintClaimSchema.safeParse({ imageBase64: "AAAA", mimeType: "image/svg+xml" }).success,
    false,
    "SVG can carry script and must not be accepted",
  );
  assert.equal(
    MintClaimSchema.safeParse({ imageBase64: "AAAA", mimeType: "image/jpeg", userPhone: "+15551234567" }).success,
    false,
    "strict() must reject an attempt to name an owner from outside",
  );
});

test("consume input requires a token of credible length", () => {
  assert.equal(ConsumeClaimSchema.safeParse({ token: "short" }).success, false);
  assert.equal(ConsumeClaimSchema.safeParse({ token: "b".repeat(43) }).success, true);
});

test("only X's own media hosts are followed from a webhook payload", () => {
  assert.equal(directPhotoUrl(["https://pbs.twimg.com/media/abc.jpg"]), "https://pbs.twimg.com/media/abc.jpg");
  // The media reference arrives inside attacker-influenced input; following it
  // unrestricted would be an SSRF the service performs against itself.
  assert.equal(directPhotoUrl(["https://evil.example.com/x.jpg"]), null);
  assert.equal(directPhotoUrl(["http://pbs.twimg.com/media/abc.jpg"]), null);
  assert.equal(directPhotoUrl(["http://169.254.169.254/latest/meta-data/"]), null);
  // An opaque v2 media key needs a DM lookup this tier cannot make, so it must
  // fall through rather than be guessed at.
  assert.equal(directPhotoUrl(["3_1234567890"]), null);
  assert.equal(directPhotoUrl(null), null);
});

test("the claim path parser accepts only a well-formed token path", () => {
  assert.equal(readTokenFromPath(`/claim/${"c".repeat(43)}`), "c".repeat(43));
  assert.equal(readTokenFromPath(`/claim/${"c".repeat(43)}/`), "c".repeat(43));
  assert.equal(readTokenFromPath("/claim/"), "");
  assert.equal(readTokenFromPath("/claim/../../etc/passwd"), "");
  assert.equal(readTokenFromPath("/claims/abc"), "");
  assert.equal(readTokenFromPath("/pet-glb"), "");
});

test("claiming stays behind the auth gate while minting stays narrow", async () => {
  const server = await readFile(new URL("../server.ts", import.meta.url), "utf8");
  // The mint mount is intentionally outside requireAuth (x-dm-service holds no
  // user session). The consume mount must never be, or a link alone would be
  // enough to own a photo.
  assert.match(server, /app\.use\("\/api\/x-claims", createClaimMintRouter\(\)\);/);
  assert.match(server, /app\.use\("\/api\/x-claims", requireAuth, createClaimConsumeRouter\(\)\);/);
});

test("the claim carries a photo and never an entitlement", async () => {
  const routes = codeOnly(await readFile(new URL("../server/x-claims/routes.ts", import.meta.url), "utf8"));
  // A claim must not touch credits, orders, or generation. If any of these ever
  // appear here, the funnel has become a way around the paid gates.
  for (const forbidden of [/credit/i, /pupcoin/i, /reserve/i, /\/orders/, /generate/i]) {
    assert.doesNotMatch(routes, forbidden);
  }
});

test("the DM path cannot start a generation", async () => {
  const claim = codeOnly(await readFile(new URL("../x-dm-service/src/photoClaim.ts", import.meta.url), "utf8"));
  for (const forbidden of [/pet-glb/i, /\/orders/, /credit/i]) {
    assert.doesNotMatch(claim, forbidden);
  }
});

test("the photo claim reply is off unless fully configured", async () => {
  const config = await readFile(new URL("../x-dm-service/src/config.ts", import.meta.url), "utf8");
  // The flag alone must not be enough: a missing secret or base URL would mean
  // DMing links that 401 on arrival.
  assert.match(config, /X_PHOTO_CLAIM_ENABLED =\s*\n?\s*parseBoolean\(env\.X_PHOTO_CLAIM_ENABLED, false\) &&/);
  assert.match(config, /Boolean\(PAWSOME_API_BASE\) &&/);
  assert.match(config, /X_CLAIM_SERVICE_SECRET\.length >= 32/);
});

test("migration 58 lands on top of the analytics work without reopening it", async () => {
  const { MIGRATIONS, CURRENT_SCHEMA_VERSION } = await import("../server/migrations/runner.ts");
  const claims = MIGRATIONS.find((entry) => entry.version === 58);
  assert.ok(claims, "migration 58 must exist");
  assert.equal(claims.name, "x_photo_claims");
  const sql = claims.statements.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS x_photo_claims/);
  assert.match(sql, /token_hash\s+CHAR\(64\) NOT NULL/);
  assert.match(sql, /UNIQUE KEY uniq_token_hash/);
  assert.match(sql, /expires_at\s+TIMESTAMP NOT NULL/);
  // No X user id, handle, or message text: the table must not become a record
  // of who messaged the account.
  assert.doesNotMatch(sql, /sender|handle|username|message_text/i);
  // The reported version must keep pace with what the array actually reaches.
  const maxVersion = Math.max(...MIGRATIONS.map((entry) => entry.version));
  assert.equal(CURRENT_SCHEMA_VERSION, maxVersion);
});
