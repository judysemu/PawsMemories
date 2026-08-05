import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const AZURE_ROOT = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(AZURE_ROOT, relativePath), "utf8");

test("runtime lock names both accepted worker images and their immutable cache paths", () => {
  const lock = JSON.parse(read("runtime/gpu-runtime.lock.json"));
  assert.equal(lock.schemaVersion, 1);
  assert.deepEqual(lock.images.map((image) => image.component), ["trellis2", "blender-worker"]);

  const trellis = lock.images[0];
  assert.equal(trellis.imageRef, "paws-trellis2:75fbf018-b74ca0c");
  assert.equal(trellis.cacheState, "verified-private-readback");

  const blender = lock.images[1];
  assert.equal(blender.imageRef, "paws-blender-worker:e2cb178");
  assert.equal(blender.blobPrefix, "runtime-images/blender-worker/e2cb178");
  assert.equal(blender.cacheState, "pending-private-readback");
});

test("generic runtime cache is managed-identity only and requires fresh private readback", () => {
  const script = read("scripts/cache-runtime-image.sh");
  assert.match(script, /AZCOPY_AUTO_LOGIN_TYPE=MSI/);
  assert.match(script, /runtime-images\/\$\{component\}\/\$\{build_revision\}/);
  assert.match(script, /--from-to=LocalBlob --overwrite=false/);
  assert.match(script, /--from-to=BlobLocal --overwrite=true/);
  assert.match(script, /sha256sum "\$archive_part"/);
  assert.match(script, /stat -c '%s' "\$archive_part"/);
  assert.match(script, /cmp --silent "\$manifest_path" "\$manifest_part"/);
  assert.match(script, /Existing cache manifest does not match the current Docker image/);
  assert.match(script, /\.imageId == \$imageId/);
  assert.match(script, /\.repositoryRevision == \$buildRevision/);
  assert.match(script, /manifest_sha256="\$\(sha256sum "\$manifest_path"/);
  assert.match(script, /Cache bundle path was claimed concurrently/);
  assert.match(script, /privateReadback: true/);
  assert.doesNotMatch(script, /[?&](?:sig|se|sp|sv)=/i);
});

test("GPU restore refuses unlocked content and verifies bytes, hash, and Docker image id", () => {
  const script = read("scripts/restore-runtime-image.sh");
  assert.match(script, /Runtime component is not present in the lock/);
  assert.match(script, /Runtime component is not verified by private readback/);
  assert.match(script, /verified-private-readback/);
  assert.match(script, /Runtime lock lacks complete local trust anchors/);
  assert.match(script, /locked_manifest_sha256/);
  assert.match(script, /sha256sum "\$manifest_part"/);
  assert.match(script, /\.repositoryRevision == \$repositoryRevision/);
  assert.match(script, /AZCOPY_AUTO_LOGIN_TYPE=MSI/);
  // The manifest's archive hash is checked by EXACT EQUALITY against the locked
  // value, not by regex shape. An earlier revision asserted a jq
  // `.sha256 | test("^[a-f0-9]{64}$")` format test here; equality is strictly
  // stronger (a well-formed but wrong hash passes a format test and fails this),
  // so do not "restore" the weaker assertion.
  assert.match(script, /\(\.sha256 == \$sha256\)/);
  // Shape of every locked trust anchor is still enforced, in bash, before use.
  assert.match(script, /locked_archive_sha256" =~ \^\[a-f0-9\]\{64\}\$/);
  assert.match(script, /locked_image_id" =~ \^sha256:\[a-f0-9\]\{64\}\$/);
  assert.match(script, /stat -c '%s' "\$archive_part"/);
  assert.match(script, /sha256sum "\$archive_part"/);
  assert.match(script, /zstd -dc "\$archive_path" \| docker load/);
  assert.match(script, /test "\$actual_image_id" = "\$expected_image_id"/);
  assert.doesNotMatch(script, /docker pull|docker build|[?&](?:sig|se|sp|sv)=/i);
});

test("Compose pins the accepted Blender worker instead of an unavailable mutable tag", () => {
  const compose = read("compose/gpu.compose.yml");
  assert.match(compose, /BLENDER_WORKER_IMAGE:-paws-blender-worker:e2cb178/);
  assert.doesNotMatch(compose, /paws-blender-worker:5\.1\.2/);
  assert.equal((compose.match(/BLENDER_WORKER_REVISION: \$\{BLENDER_WORKER_REVISION:\?/g) || []).length, 2);
  assert.match(compose, /BLENDER_VERSION: "5\.1\.2"/);
});

test("Blender rebuild pins its base and verifies the official release archive", () => {
  const dockerfile = fs.readFileSync(path.resolve(AZURE_ROOT, "..", "..", "blender-worker", "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:20-slim@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /ARG BLENDER_ARCHIVE_SHA256=[a-f0-9]{64}/);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.doesNotMatch(dockerfile, /^FROM node:20-slim$/m);
});

test("runtime rebuild binds both images to one repository commit and smoke-tests the new readiness contract", () => {
  const script = read("scripts/build-runtime-images.sh");
  assert.match(script, /"\$repo_revision" =~ \^\[a-f0-9\]\{40\}\$/);
  assert.match(script, /paws-trellis2:\$\{trellis_source_revision:0:8\}-\$\{short_revision\}/);
  assert.match(script, /paws-blender-worker:\$\{short_revision\}/);
  assert.equal((script.match(/--pull=false/g) || []).length, 2);
  assert.equal((script.match(/--build-arg "PAWS_RUNTIME_REPOSITORY_REVISION=\$\{repo_revision\}"/g) || []).length, 2);
  assert.match(script, /org\.opencontainers\.image\.revision=\$\{repo_revision\}/);
  assert.match(script, /git -C "\$repo_root" rev-parse HEAD/);
  assert.match(script, /git -C "\$repo_root" status --porcelain --untracked-files=all/);
  assert.match(script, /smoke_nonce="\$\(openssl rand -hex 4\)"/);
  assert.match(script, /docker network create "\$smoke_network"/);
  assert.match(script, /blender_container_id="\$\(docker run/);
  assert.match(script, /trellis_container_id="\$\(docker run/);
  assert.match(script, /\.bridge == "connected"/);
  assert.match(script, /\.blenderVersion == "5\.1\.2"/);
  assert.match(script, /\.workerRevision == \$revision/);
  assert.match(script, /\.revisionVerified == true/);
  assert.match(script, /X-Worker-Secret: \$\{worker_secret\}/);
  assert.match(script, /\.blender\.status == "ready"/);
  assert.match(script, /\.blender\.bridgeConnected == true/);
  assert.match(script, /\.runtimeRevisionVerified == true/);
  assert.match(script, /liveCudaAcceptance: false/);
  assert.doesNotMatch(script, /docker push|secretPrinted: true|rm -rf/);
});
