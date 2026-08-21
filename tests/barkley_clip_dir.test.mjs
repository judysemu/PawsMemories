import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveClipDir, getMissingClips, REQUIRED_CLIPS } = await import("../server/barkley/featureFlag.ts");

const REQUIRED = REQUIRED_CLIPS;

/** Builds a fake deployment root and runs a body with cwd pointed at it. */
function withCwd(layout, body) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "barkley-clipdir-")));
  const previous = process.cwd();
  try {
    for (const dir of layout) {
      const full = join(root, ...dir);
      mkdirSync(full, { recursive: true });
      for (const clip of REQUIRED) writeFileSync(join(full, `${clip}.glb`), "glb");
    }
    process.chdir(root);
    return body(root);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
}

// The production archive contains only build output: server.ts serves static
// assets from <cwd>/dist, so the clips the browser fetches at /barkley/*.glb
// live in dist/barkley and there is no public/ directory at all. Resolving
// public/ only reported all 30 clips missing on a deploy where the browser was
// loading them fine, and GET /api/barkley/show 503'd on a working feature.
test("the production layout resolves to dist/barkley", () => {
  withCwd([["dist", "barkley"]], (root) => {
    assert.equal(resolveClipDir(), join(root, "dist", "barkley"));
    assert.deepEqual(getMissingClips(), [], "every clip present must report none missing");
  });
});

test("the development layout resolves to public/barkley", () => {
  withCwd([["public", "barkley"]], (root) => {
    assert.equal(resolveClipDir(), join(root, "public", "barkley"));
    assert.deepEqual(getMissingClips(), []);
  });
});

test("dist wins over public so a stale checkout cannot mask what is served", () => {
  withCwd([["dist", "barkley"], ["public", "barkley"]], (root) => {
    assert.equal(resolveClipDir(), join(root, "dist", "barkley"));
  });
});

test("a missing clip is still reported as missing", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "barkley-clipdir-")));
  const previous = process.cwd();
  try {
    const full = join(root, "dist", "barkley");
    mkdirSync(full, { recursive: true });
    for (const clip of REQUIRED.slice(1)) writeFileSync(join(full, `${clip}.glb`), "glb");
    process.chdir(root);
    assert.deepEqual(getMissingClips(), [REQUIRED[0]], "a genuinely absent clip must still surface");
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test("no clip directory at all names a real path rather than an empty string", () => {
  withCwd([], (root) => {
    // The diagnostic has to point somewhere actionable even before a build.
    assert.equal(resolveClipDir(), join(root, "public", "barkley"));
    assert.equal(getMissingClips().length, REQUIRED.length);
  });
});
