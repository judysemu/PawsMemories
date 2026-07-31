#!/usr/bin/env node
/**
 * set-b2-cors.mjs
 * ===============
 * Fixes the "No 'Access-Control-Allow-Origin' header" error that breaks the
 * 3D model viewer (and useGLTF / AR loaders) after the domain switch to
 * pawsome3d.com.
 *
 * Root cause: <model-viewer> and three.js fetch the GLB from the Backblaze B2
 * bucket cross-origin. The browser requires the bucket to return CORS headers
 * that allow the requesting origin. The bucket's CORS rules still list the OLD
 * origin (mypets.cc / pawsmemories), so pawsome3d.com is blocked. This script
 * updates the bucket's CORS rules to allow the new origin(s).
 *
 * It uses the B2 NATIVE API (CORS is a B2-native concept; the S3-compatible
 * endpoint cannot set CORS). It authenticates with the SAME key id / app key
 * you already use for S3 uploads:
 *   MEDIA_BUCKET_KEY    -> B2 keyId
 *   MEDIA_BUCKET_SECRET -> B2 applicationKey
 *   MEDIA_BUCKET_NAME   -> bucket to update
 *
 * The key must have the `writeBuckets` capability (a master application key has
 * it; a key scoped to one bucket with only file read/write may NOT). If this
 * fails with an unauthorized error, use the B2 web UI fallback described in the
 * chat, or generate a master key.
 *
 * Origins can be overridden:
 *   ALLOWED_ORIGINS="https://pawsome3d.com,https://www.pawsome3d.com" node scripts/set-b2-cors.mjs
 *
 * Run:  node scripts/set-b2-cors.mjs
 * (load your env first, e.g. `set -a; source .env; set +a` or use the host env)
 */

const keyId = process.env.MEDIA_BUCKET_KEY;
const appKey = process.env.MEDIA_BUCKET_SECRET;
const bucketName = process.env.MEDIA_BUCKET_NAME;

const origins = (process.env.ALLOWED_ORIGINS ||
  "https://pawsome3d.com,https://www.pawsome3d.com")
  .split(",").map((o) => o.trim()).filter(Boolean);

if (!keyId || !appKey || !bucketName) {
  console.error("❌ Missing env. Need MEDIA_BUCKET_KEY, MEDIA_BUCKET_SECRET, MEDIA_BUCKET_NAME.");
  process.exit(1);
}

const desiredDownloadRule = {
    corsRuleName: "allowAppOriginsDownload",
    allowedOrigins: origins,
    // Download (GET/HEAD) over both the S3 endpoint and the native download URL.
    allowedOperations: [
      "s3_get",
      "s3_head",
      "b2_download_file_by_id",
      "b2_download_file_by_name",
    ],
    allowedHeaders: ["*"],
    exposeHeaders: ["Content-Length", "Content-Type", "ETag"],
    maxAgeSeconds: 3600,
};

async function j(res) {
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${data.message || data.code || text}`);
  }
  return data;
}

(async () => {
  console.log(`→ Authorizing with B2 (keyId ${keyId.slice(0, 6)}…)`);
  const auth = await j(await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { Authorization: "Basic " + Buffer.from(`${keyId}:${appKey}`).toString("base64") },
  }));

  const apiUrl = auth.apiInfo?.storageApi?.apiUrl || auth.apiUrl;
  const accountId = auth.accountId;
  const token = auth.authorizationToken;
  if (!apiUrl || !accountId || !token) {
    throw new Error("Unexpected auth response shape from B2.");
  }

  console.log(`→ Looking up bucket "${bucketName}"`);
  const list = await j(await fetch(`${apiUrl}/b2api/v3/b2_list_buckets`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, bucketName }),
  }));
  const bucket = (list.buckets || [])[0];
  if (!bucket) throw new Error(`Bucket "${bucketName}" not found for this account/key.`);
  console.log(`  bucketId ${bucket.bucketId}, existing CORS rules: ${(bucket.corsRules || []).length}`);

  if (!Array.isArray(bucket.corsRules) || !Number.isInteger(bucket.revision)) {
    throw new Error("Bucket response omitted CORS rules or revision; refusing a destructive update.");
  }
  const corsRules = [
    ...bucket.corsRules.filter((rule) => rule?.corsRuleName !== desiredDownloadRule.corsRuleName),
    desiredDownloadRule,
  ];

  console.log(`→ Merging download CORS rule for origins: ${origins.join(", ")}`);
  const updated = await j(await fetch(`${apiUrl}/b2api/v3/b2_update_bucket`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId,
      bucketId: bucket.bucketId,
      corsRules,
      ifRevisionIs: bucket.revision,
    }),
  }));

  console.log("✅ Done. CORS rules now:");
  console.log(JSON.stringify(updated.corsRules, null, 2));
  console.log("\nHard-refresh pawsome3d.com (Cmd+Shift+R) — the model viewer should load. CORS changes take effect immediately, but browser/CDN caches may need a refresh.");
})().catch((err) => {
  console.error("❌ Failed:", err.message);
  console.error("\nIf this is an authorization/capability error, the key lacks 'writeBuckets'.");
  console.error("Fix via the B2 web UI instead: Buckets → your bucket → CORS Rules →");
  console.error("either 'Share everything in this bucket with all HTTPS origins', or a custom");
  console.error("rule allowing GET/HEAD from https://pawsome3d.com and https://www.pawsome3d.com.");
  process.exit(1);
});
