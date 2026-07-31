import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateManifest } from "../scripts/generate-manifest.mjs";
import { verifyReleaseDirectory } from "../scripts/release-manifest-lib.mjs";
import { CURRENT_SCHEMA_VERSION } from "../server/migrations/runner.ts";

const COMMIT = "1".repeat(40);
const OPTIONS = { expectedCommit: COMMIT, expectedBranch: "main", expectedSchemaVersion: CURRENT_SCHEMA_VERSION, requireClean: true };

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paws-archive-verifier-"));
  fs.mkdirSync(path.join(directory, "nested"));
  fs.writeFileSync(path.join(directory, "package.json"), "{}\n");
  fs.writeFileSync(path.join(directory, "nested", "noncritical.txt"), "original\n");
  const manifest = generateManifest({
    APP_COMMIT_SHA: COMMIT,
    APP_BRANCH: "main",
    APP_BUILD_TIME: "2026-07-22T12:00:00.000Z",
    RELEASE_DIRTY: "false",
  }, directory);
  fs.writeFileSync(path.join(directory, "release-manifest.json"), JSON.stringify(manifest));
  return { directory, manifest };
}

test("shared verifier accepts an exact complete release directory", () => {
  const { directory, manifest } = fixture();
  try {
    const result = verifyReleaseDirectory(directory, manifest, OPTIONS);
    assert.deepEqual(result, { valid: true, fileCount: 2 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("shared verifier rejects tampering in a noncritical nested file", () => {
  const { directory, manifest } = fixture();
  try {
    fs.writeFileSync(path.join(directory, "nested", "noncritical.txt"), "tampered\n");
    assert.match(verifyReleaseDirectory(directory, manifest, OPTIONS).error, /Checksum mismatch/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("shared verifier rejects added, missing, and wrong-commit content", () => {
  const added = fixture();
  try {
    fs.writeFileSync(path.join(added.directory, "unlisted.txt"), "surprise\n");
    assert.match(verifyReleaseDirectory(added.directory, added.manifest, OPTIONS).error, /unlisted file/);
  } finally {
    fs.rmSync(added.directory, { recursive: true, force: true });
  }

  const missing = fixture();
  try {
    fs.unlinkSync(path.join(missing.directory, "package.json"));
    assert.match(verifyReleaseDirectory(missing.directory, missing.manifest, OPTIONS).error, /missing from archive/);
    assert.match(
      verifyReleaseDirectory(missing.directory, missing.manifest, { ...OPTIONS, expectedCommit: "0".repeat(40) }).error,
      /does not match/i,
    );
  } finally {
    fs.rmSync(missing.directory, { recursive: true, force: true });
  }
});

test("shared verifier rejects filesystem metadata even if it was manifested", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paws-archive-metadata-"));
  try {
    fs.writeFileSync(path.join(directory, ".DS_Store"), "metadata");
    assert.throws(
      () => generateManifest({
        APP_COMMIT_SHA: COMMIT,
        APP_BRANCH: "main",
        APP_BUILD_TIME: "2026-07-22T12:00:00.000Z",
        RELEASE_DIRTY: "false",
      }, directory),
      /filesystem metadata/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
