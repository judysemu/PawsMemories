import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BUILD_STAGES, removeReleaseMetadata, runBuild } from "../scripts/build.mjs";

test("the production build orchestrator stops at the failed stage", () => {
  const called = [];
  assert.throws(
    () => runBuild({
      clean: false,
      sanitizer() {},
      runner(stage) {
        called.push(stage.name);
        if (stage.name === "server") throw new Error("intentional server build failure");
      },
    }),
    /intentional server build failure/,
  );
  assert.deepEqual(called, ["client", "server"]);
  assert.deepEqual(BUILD_STAGES.map((stage) => stage.name), ["client", "server", "manifest"]);
});

test("the production build strips nested macOS metadata before manifesting", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paws-release-metadata-"));
  try {
    fs.mkdirSync(path.join(directory, "nested"));
    fs.writeFileSync(path.join(directory, ".DS_Store"), "metadata");
    fs.writeFileSync(path.join(directory, "nested", ".DS_Store"), "metadata");
    fs.writeFileSync(path.join(directory, "nested", "keep.txt"), "keep");

    assert.equal(removeReleaseMetadata(directory), 2);
    assert.equal(fs.existsSync(path.join(directory, ".DS_Store")), false);
    assert.equal(fs.existsSync(path.join(directory, "nested", ".DS_Store")), false);
    assert.equal(fs.readFileSync(path.join(directory, "nested", "keep.txt"), "utf8"), "keep");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
