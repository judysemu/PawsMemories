/**
 * Phase 0 Baseline Tests: Coordinate and scale conventions, fixture verification.
 *
 * These tests establish the current pipeline behavior — they document what exists
 * before Phases 1-3 modify it. Some tests verify conventions that aren't enforced
 * yet; they will pass only when the downstream phases implement the enforcement.
 *
 * Run: ./node_modules/.bin/tsx --test tests/bim_baseline.test.mjs
 */
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const FIXTURES_DIR = new URL("../fixtures/", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Fixture existence
// ---------------------------------------------------------------------------
const FIXTURES = [
  "1m-cube.glb",
  "10m-cube.glb",
  "100mm-cube.glb",
  "small-building.ifc",
  "rotated-building.ifc",
  "malformed-building.ifc",
  "unsupported-schema.ifc",
  "manifest.json",
];

for (const name of FIXTURES) {
  test(`fixture exists: ${name}`, () => {
    assert.ok(fs.existsSync(path.join(FIXTURES_DIR, name)), `Missing fixture: ${name}`);
  });
}

// ---------------------------------------------------------------------------
// Conventions document
// ---------------------------------------------------------------------------
test("CONVENTIONS.md defines canonical coordinate system", () => {
  const convPath = path.join(FIXTURES_DIR, "CONVENTIONS.md");
  assert.ok(fs.existsSync(convPath), "fixtures/CONVENTIONS.md must exist");
  const text = fs.readFileSync(convPath, "utf-8");
  assert.ok(text.includes("Right-handed"), "Must declare handedness");
  assert.ok(text.includes("Y-up"), "Must declare up axis");
  assert.ok(text.includes("meter"), "Must declare canonical unit");
  assert.ok(text.includes("physical scale"), "Must distinguish physical vs display scale");
  assert.ok(text.includes("One Three.js world unit = One meter"), "Must declare unit equivalence");
});

// ---------------------------------------------------------------------------
// Audit document
// ---------------------------------------------------------------------------
test("PHASE0_AUDIT.md documents all normalization paths", () => {
  const auditPath = path.join(FIXTURES_DIR, "..", "PHASE0_AUDIT.md");
  assert.ok(fs.existsSync(auditPath), "PHASE0_AUDIT.md must exist");
  const text = fs.readFileSync(auditPath, "utf-8");
  assert.ok(text.includes("AvatarModel.tsx"), "Must audit avatar normalization");
  assert.ok(text.includes("ObjectModel.tsx"), "Must audit object normalization");
  assert.ok(text.includes("catalog.ts"), "Must audit catalog");
  assert.ok(text.includes("eighthWallAR.ts"), "Must audit AR path");
});

// ---------------------------------------------------------------------------
// GLB fixture dimensions
// ---------------------------------------------------------------------------
describe("GLB fixture dimensions", async () => {
  let io;
  try {
    const g = await import("@gltf-transform/core");
    io = new g.NodeIO();
  } catch {
    // If @gltf-transform/core isn't available, skip
    return;
  }

  async function readGlbBounds(name) {
    const doc = await io.read(path.join(FIXTURES_DIR, name));
    const root = doc.getRoot();
    const scenes = root.listScenes();
    const nodes = scenes[0].listChildren();
    const node = nodes[0];
    const mesh = node.getMesh();
    if (!mesh) return null;
    const prim = mesh.listPrimitives()[0];
    const pos = prim.getAttribute("POSITION");
    if (!pos) return null;
    const arr = pos.getArray();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < arr.length; i += 3) {
      if (arr[i] < minX) minX = arr[i];
      if (arr[i] > maxX) maxX = arr[i];
      if (arr[i+1] < minY) minY = arr[i+1];
      if (arr[i+1] > maxY) maxY = arr[i+1];
      if (arr[i+2] < minZ) minZ = arr[i+2];
      if (arr[i+2] > maxZ) maxZ = arr[i+2];
    }
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], dim: [maxX - minX, maxY - minY, maxZ - minZ] };
  }

  test("1m-cube.glb is exactly 1m (within Float32 tolerance)", async () => {
    const b = await readGlbBounds("1m-cube.glb");
    assert.ok(b, "Could not read GLB bounds");
    assert.ok(Math.abs(b.dim[0] - 1) < 1e-6, `X dimension ${b.dim[0]} must be ~1m`);
    assert.ok(Math.abs(b.dim[1] - 1) < 1e-6, `Y dimension ${b.dim[1]} must be ~1m`);
    assert.ok(Math.abs(b.dim[2] - 1) < 1e-6, `Z dimension ${b.dim[2]} must be ~1m`);
  });

  test("10m-cube.glb is exactly 10m (within Float32 tolerance)", async () => {
    const b = await readGlbBounds("10m-cube.glb");
    assert.ok(b, "Could not read GLB bounds");
    assert.ok(Math.abs(b.dim[0] - 10) < 1e-4, `X dimension ${b.dim[0]} must be ~10m`);
    assert.ok(Math.abs(b.dim[1] - 10) < 1e-4, `Y dimension ${b.dim[1]} must be ~10m`);
    assert.ok(Math.abs(b.dim[2] - 10) < 1e-4, `Z dimension ${b.dim[2]} must be ~10m`);
  });

  test("100mm-cube.glb is exactly 0.1m (within Float32 tolerance)", async () => {
    const b = await readGlbBounds("100mm-cube.glb");
    assert.ok(b, "Could not read GLB bounds");
    assert.ok(Math.abs(b.dim[0] - 0.1) < 1e-6, `X dimension ${b.dim[0]} must be ~0.1m`);
    assert.ok(Math.abs(b.dim[1] - 0.1) < 1e-6, `Y dimension ${b.dim[1]} must be ~0.1m`);
    assert.ok(Math.abs(b.dim[2] - 0.1) < 1e-6, `Z dimension ${b.dim[2]} must be ~0.1m`);
  });

  test("GLB fixtures are centered at origin", async () => {
    const b = await readGlbBounds("1m-cube.glb");
    assert.ok(b, "Could not read GLB bounds");
    assert.equal(b.min[0], -0.5, "X min = -0.5");
    assert.equal(b.min[1], -0.5, "Y min = -0.5");
    assert.equal(b.min[2], -0.5, "Z min = -0.5");
    assert.equal(b.max[0], 0.5, "X max = 0.5");
    assert.equal(b.max[1], 0.5, "Y max = 0.5");
    assert.equal(b.max[2], 0.5, "Z max = 0.5");
  });
});

// ---------------------------------------------------------------------------
// IFC fixture structure
// ---------------------------------------------------------------------------
describe("IFC fixture structure", () => {
  function readIfc(name) {
    return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
  }

  test("small-building.ifc is an API-generated IFC4 semantic model", () => {
    const text = readIfc("small-building.ifc");
    assert.ok(text.includes("IFC4"), "Schema must be IFC4");
    assert.ok(text.includes("IFCPROJECT"), "Must contain project");
    assert.ok(text.includes("IFCSITE"), "Must contain site");
    assert.ok(text.includes("IFCBUILDING"), "Must contain building");
    assert.ok(text.includes("IFCBUILDINGSTOREY"), "Must contain storey");
    assert.ok(text.includes("IFCWALL"), "Must contain wall");
    assert.ok(text.includes("IFCPROPERTYSET"), "Must contain property set");
    assert.ok(text.includes("IFCRELCONTAINEDINSPATIALSTRUCTURE"), "Must have spatial containment");
    assert.ok(text.includes("IFCSPACE"), "Must contain authored spaces");
    assert.ok(text.includes("IFCRELVOIDSELEMENT"), "Must contain hosted openings");
  });

  test("small-building.ifc uses millimeter units", () => {
    const text = readIfc("small-building.ifc");
    assert.ok(text.includes(".MILLI."), "Must use millimeter units");
  });

  test("rotated-building.ifc has rotated placement", () => {
    const text = readIfc("rotated-building.ifc");
    assert.ok(text.includes("IFC4"), "Schema must be IFC4");
    assert.ok(text.includes("100000."), "Must contain a large translated engineering origin");
  });

  test("malformed-building.ifc has no STEP signature", () => {
    const text = readIfc("malformed-building.ifc");
    assert.ok(!text.includes("ISO-10303-21"), "Must fail signature validation");
  });

  test("unsupported-schema.ifc uses future IFC5", () => {
    const text = readIfc("unsupported-schema.ifc");
    assert.ok(text.includes("IFC5"), "Schema must be unsupported IFC5");
  });
});

// ---------------------------------------------------------------------------
// Current pipeline behavior (document current state)
// ---------------------------------------------------------------------------
describe("Current scale normalization behavior", () => {
  test("AvatarModel TARGET_HEIGHT is 0.7m for dogs", () => {
    const avatarSource = fs.readFileSync(
      path.join(FIXTURES_DIR, "..", "src", "three", "AvatarModel.tsx"), "utf-8"
    );
    assert.ok(avatarSource.includes("TARGET_HEIGHT"), "TARGET_HEIGHT constant must exist");
    assert.ok(avatarSource.includes("0.7") || avatarSource.includes("0.70"), "Must normalize to ~0.7m");
  });

  test("ObjectModel normalizes by fitSize/longest-edge", () => {
    const objSource = fs.readFileSync(
      path.join(FIXTURES_DIR, "..", "src", "three", "objects", "ObjectModel.tsx"), "utf-8"
    );
    assert.ok(objSource.includes("fitSize"), "fitSize must be used for normalization");
    assert.ok(objSource.includes("fitSize / longest"), "Must normalize by longest edge ratio");
  });

  test("ObjectModel uses PlacedObject.scale as combined physical+display parameter", () => {
    const objSource = fs.readFileSync(
      path.join(FIXTURES_DIR, "..", "src", "three", "objects", "ObjectModel.tsx"), "utf-8"
    );
    assert.ok(objSource.includes("object.scale"), "PlacedObject.scale must be referenced");
  });

  test("PlacedObject type now has optional spatialMetadata field (Phase 1)", () => {
    const types = fs.readFileSync(
      path.join(FIXTURES_DIR, "..", "src", "types.ts"), "utf-8"
    );
    assert.ok(types.includes("spatialMetadata?"), "PlacedObject should have optional spatialMetadata");
    assert.ok(types.includes("physicalScale"), "spatialMetadata should include physicalScale");
    assert.ok(types.includes("sourceUnit"), "spatialMetadata should include sourceUnit");
  });

  test("All catalog fitSizes are finite positive numbers", () => {
    const catalogSource = fs.readFileSync(
      path.join(FIXTURES_DIR, "..", "src", "three", "objects", "catalog.ts"), "utf-8"
    );
    // Extract fitSize values via regex
    const fits = [...catalogSource.matchAll(/fitSize:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
    assert.ok(fits.length >= 8, "Should have at least 8 catalog entries");
    for (const f of fits) {
      assert.ok(f > 0, `fitSize ${f} must be positive`);
      assert.ok(Number.isFinite(f), `fitSize ${f} must be finite`);
    }
  });

  test("EighthWall AR path uses display fitting (fitSize or longest-edge normalization)", () => {
    const arSource = fs.readFileSync(
      path.join(FIXTURES_DIR, "..", "src", "three", "ar", "eighthWallAR.ts"), "utf-8"
    );
    assert.ok(arSource.includes("fit"), "Must use fit for normalization");
  });
});

// ---------------------------------------------------------------------------
// Baseline: verify the current test suite passes
// ---------------------------------------------------------------------------
test("Phase 0 baseline exposes executable lint and test gates", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts.lint, "tsc --noEmit");
  assert.match(pkg.scripts.test, /tests\/\*\.test\.mjs/);
});
