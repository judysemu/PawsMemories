import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Storage isolation tests.
 *
 * These guard the single property the whole paid-asset design rests on:
 * Backblaze has no per-object ACLs, so a paid asset is protected only by living
 * in a different bucket. If that boundary is ever blurred — by a stray ACL, a
 * reference to the public bucket, or a misconfiguration pointing both names at
 * the same bucket — every entitlement check downstream becomes decorative.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const privateStorageSource = readFileSync(path.join(repoRoot, "storage.private.ts"), "utf8");
const serverSource = readFileSync(path.join(repoRoot, "server.ts"), "utf8");

const baseEnv = {
  MEDIA_BUCKET_NAME: "pawsmemories-media",
  MEDIA_PRIVATE_BUCKET_NAME: "pawsmemories-private",
  MEDIA_BUCKET_URL: "https://s3.us-east-005.backblazeb2.com",
  MEDIA_BUCKET_KEY: "test-key-id",
  MEDIA_BUCKET_SECRET: "test-secret",
};

async function loadModule() {
  return import("../storage.private.ts");
}

test("private storage never sends an ACL", () => {
  // On a private bucket an ACL is redundant; on a public one B2 returns 403.
  // Omitting it keeps the bucket as the single source of truth.
  assert.equal(
    /ACL\s*:/.test(privateStorageSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")),
    false,
    "storage.private.ts must not set an ACL on any command",
  );
});

test("private storage never references the public bucket name for writes", () => {
  const code = privateStorageSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const bucketArgs = [...code.matchAll(/Bucket\s*:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.ok(bucketArgs.length > 0, "expected at least one Bucket argument");
  for (const arg of bucketArgs) {
    assert.equal(
      arg,
      "privateBucketName",
      `every S3 command must target privateBucketName, found ${arg}`,
    );
  }
});

test("boot assertion rejects identical bucket names", async () => {
  const { assertPrivateStorageConfig, PrivateStorageError } = await loadModule();
  assert.throws(
    () =>
      assertPrivateStorageConfig({
        ...baseEnv,
        MEDIA_PRIVATE_BUCKET_NAME: "pawsmemories-media",
      }),
    (err) => err instanceof PrivateStorageError && /same bucket/i.test(err.message),
    "identical bucket names must fail loudly at boot",
  );
});

test("boot assertion rejects a missing private bucket", async () => {
  const { assertPrivateStorageConfig } = await loadModule();
  const env = { ...baseEnv };
  delete env.MEDIA_PRIVATE_BUCKET_NAME;
  assert.throws(() => assertPrivateStorageConfig(env), /MEDIA_PRIVATE_BUCKET_NAME/);
});

test("boot assertion rejects missing credentials", async () => {
  const { assertPrivateStorageConfig } = await loadModule();
  const env = { ...baseEnv };
  delete env.MEDIA_BUCKET_KEY;
  assert.throws(() => assertPrivateStorageConfig(env), /credentials/i);
});

test("boot assertion accepts a valid split-bucket config", async () => {
  const { assertPrivateStorageConfig } = await loadModule();
  assert.doesNotThrow(() => assertPrivateStorageConfig({ ...baseEnv }));
});

test("boot assertion rejects half-configured private credentials", async () => {
  const { assertPrivateStorageConfig } = await loadModule();
  assert.throws(
    () => assertPrivateStorageConfig({ ...baseEnv, MEDIA_PRIVATE_BUCKET_KEY: "private-key" }),
    /must be configured together/i,
  );
});

test("boot assertion rejects placeholder credentials", async () => {
  const { assertPrivateStorageConfig } = await loadModule();
  assert.throws(
    () => assertPrivateStorageConfig({ ...baseEnv, MEDIA_BUCKET_KEY: "YOUR_ACCESS_KEY" }),
    /placeholder/i,
  );
});

test("boot assertion rejects insecure non-local storage endpoints", async () => {
  const { assertPrivateStorageConfig } = await loadModule();
  assert.throws(
    () => assertPrivateStorageConfig({ ...baseEnv, MEDIA_BUCKET_URL: "http://s3.example.test" }),
    /HTTPS/i,
  );
  assert.doesNotThrow(() => assertPrivateStorageConfig({ ...baseEnv, MEDIA_BUCKET_URL: "http://127.0.0.1:9000" }));
});

test("production validates private storage before opening the server listener", () => {
  const guardAt = serverSource.indexOf("assertPrivateStorageConfig();");
  const listenerAt = serverSource.indexOf('app.listen(PORT, "0.0.0.0"');
  assert.ok(guardAt > 0, "server startup must call assertPrivateStorageConfig");
  assert.ok(listenerAt > guardAt, "private storage must be validated before the server listener opens");
});

test("object keys are server-minted and reject traversal", async () => {
  const { mintObjectKey, PrivateStorageError } = await loadModule();
  const listingUuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  const key = mintObjectKey(listingUuid, "model/gltf-binary");
  assert.match(key, /^marketplace\/3f2504e0-4f89-11d3-9a0c-0305e82c3301\/[0-9a-f-]{36}\.glb$/i);

  // A filename never reaches the key path, but the listing UUID does — so it
  // must be rejected if it is anything other than a UUID.
  for (const bad of ["../../etc/passwd", "..", "/absolute", "a".repeat(40), ""]) {
    assert.throws(
      () => mintObjectKey(bad, "model/gltf-binary"),
      PrivateStorageError,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test("two mints for the same listing never collide", async () => {
  const { mintObjectKey } = await loadModule();
  const listingUuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const keys = new Set(
    Array.from({ length: 200 }, () => mintObjectKey(listingUuid, "model/gltf-binary")),
  );
  assert.equal(keys.size, 200, "minted keys must be unique");
});

test("private cleanup refuses to delete outside the marketplace prefix", async () => {
  const { deletePrivateObject, PrivateStorageError } = await loadModule();
  await assert.rejects(
    () => deletePrivateObject("unrelated/user-upload.glb"),
    PrivateStorageError,
  );
});

test("upload claims are validated before a presign is issued", async () => {
  const { validateUploadClaim, MAX_GLB_BYTES, MAX_PREVIEW_IMAGE_BYTES } = await loadModule();

  assert.equal(validateUploadClaim("source_glb", "model/gltf-binary", 1024).ok, true);
  assert.equal(validateUploadClaim("preview_image", "image/webp", 1024).ok, true);

  // Wrong type for the slot.
  assert.equal(validateUploadClaim("source_glb", "image/png", 1024).ok, false);
  assert.equal(validateUploadClaim("preview_image", "model/gltf-binary", 1024).ok, false);

  // Oversize.
  assert.equal(validateUploadClaim("source_glb", "model/gltf-binary", MAX_GLB_BYTES + 1).ok, false);
  assert.equal(
    validateUploadClaim("preview_image", "image/png", MAX_PREVIEW_IMAGE_BYTES + 1).ok,
    false,
  );

  // Nonsense sizes.
  for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(validateUploadClaim("source_glb", "model/gltf-binary", size).ok, false);
  }

  // Executable/script MIME types must never be accepted as previews.
  for (const mime of ["text/html", "application/javascript", "image/svg+xml"]) {
    assert.equal(
      validateUploadClaim("preview_image", mime, 1024).ok,
      false,
      `${mime} must not be an allowed preview type`,
    );
  }
});

test("signed URL TTL is clamped to a sane window", async () => {
  const { __privateStorageInternals } = await loadModule();
  const { resolveTtl } = __privateStorageInternals;

  assert.equal(resolveTtl(900), 900);
  assert.equal(resolveTtl(1), 30, "absurdly short TTLs are raised to the floor");
  assert.equal(resolveTtl(60 * 60 * 24 * 30), 60 * 60 * 24 * 7, "TTL is capped at 7 days");
  assert.equal(typeof resolveTtl(undefined), "number");
});

test("the download helper documents that it does not check ownership", () => {
  // getPrivateSignedUrl mints a capability for whoever calls it. The entitlement
  // check lives in the route. If this contract note is ever removed, someone
  // will eventually call it without checking first.
  assert.match(
    privateStorageSource,
    /CALLER CONTRACT[\s\S]{0,400}entitlement/i,
    "getPrivateSignedUrl must carry an explicit caller contract",
  );
});
