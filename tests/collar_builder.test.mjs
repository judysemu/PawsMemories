import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLAR_SIZE_PRESETS,
  CollarBuildSchema,
  collarSpatialJob,
} from "../server/spatial-generator/collar.ts";

const input = {
  idempotencyKey: "collar-build-test-0001",
  targetAssetVersionId: 42,
  sizeClass: "medium_dog",
  neckCircumferenceMm: 400,
  strapWidthMm: 22,
  clearanceMm: 10,
  strapThicknessMm: 3,
  color: "#2563eb",
  includeBuckle: true,
  includeDRing: true,
  targetUse: "attachment",
};

test("collar presets preserve the supplied pet sizing ranges", () => {
  assert.deepEqual(COLLAR_SIZE_PRESETS.kitten_toy, {
    label: "Kitten / Toy breed", neckMinMm: 150, neckMaxMm: 250, strapMinMm: 8, strapMaxMm: 10,
  });
  assert.equal(COLLAR_SIZE_PRESETS.large_dog.neckMaxMm, 600);
  assert.equal(COLLAR_SIZE_PRESETS.large_dog.strapMaxMm, 38);
});

test("collar contract enforces size-specific measurements and the 5-15mm clearance rule", () => {
  assert.equal(CollarBuildSchema.safeParse(input).success, true);
  assert.equal(CollarBuildSchema.safeParse({ ...input, clearanceMm: 0 }).success, false);
  assert.equal(CollarBuildSchema.safeParse({ ...input, neckCircumferenceMm: 200 }).success, false);
  assert.equal(CollarBuildSchema.safeParse({ ...input, strapWidthMm: 38 }).success, false);
});

test("collar job is deterministic, scaled, attached, and contains rigid hardware instructions", () => {
  const parsed = CollarBuildSchema.parse(input);
  const first = collarSpatialJob(parsed);
  const second = collarSpatialJob(parsed);
  assert.deepEqual(first, second);
  assert.equal(first.subjectKind, "accessory");
  assert.equal(first.attachment.targetAssetVersionId, 42);
  assert.equal(first.attachment.clearanceMm, 10);
  assert.equal(first.scaleAnchor.millimeters, 400);
  assert.match(first.prompt, /hard-weighted 1\.0/);
  assert.match(first.prompt, /60 percent/);
  assert.match(first.prompt, /Do not use Tripo/);
});
