import assert from "node:assert/strict";
import test from "node:test";

import { compileBlenderProgram } from "../server/spatial-generator/compiler.ts";

const planHash = "a".repeat(64);
const primitive = (id, role = "additive") => ({
  id,
  type: "box",
  role,
  normalizedSize: { x: 0.5, y: 0.5, z: 0.5 },
  normalizedPosition: { x: 0, y: 0, z: 0 },
  rotationDeg: { x: 0, y: 0, z: 0 },
  constraints: { minimumWallMm: 2 },
});
const resolved = (id, dimensionsMm, positionMm = { x: 0, y: 0, z: 0 }) => ({
  id,
  dimensionsMm,
  positionMm,
  rotationDeg: { x: 0, y: 0, z: 0 },
});

function fixtures(primitives, resolvedPrimitives) {
  return {
    plan: {
      planHash,
      targetEnvelopeMm: { x: 500, y: 500, z: 500 },
      primitives,
      manufacturingIntent: "attachment",
    },
    math: {
      schemaVersion: "pawsome.spatial-math.v1",
      planHash,
      units: "mm",
      resolvedPrimitives,
      derived: {
        boundsMinMm: { x: -100, y: -100, z: -100 },
        boundsMaxMm: { x: 100, y: 100, z: 100 },
        estimatedVolumeMm3: 1000,
      },
      calculations: ["deterministic fixture"],
    },
  };
}

test("compiler applies authoritative millimeter dimensions and is deterministic", () => {
  const input = fixtures(
    [primitive("strap")],
    [resolved("strap", { x: 400, y: 22, z: 3 })],
  );
  const first = compileBlenderProgram(input.plan, input.math, "attachment");
  const second = compileBlenderProgram(input.plan, input.math, "attachment");

  assert.deepEqual(first, second);
  assert.match(first.program, /obj\.dimensions = \(mm\(400\.000\), mm\(22\.000\), mm\(3\.000\)\)/);
  assert.match(first.program, /transform_apply\(location=False, rotation=False, scale=True\)/);
  assert.doesNotMatch(first.program, /Generated: \d{4}-/);
});

test("compiler always produces a result for multi-part additive collars", () => {
  const input = fixtures(
    [primitive("strap"), primitive("buckle"), primitive("opening", "subtractive")],
    [
      resolved("strap", { x: 400, y: 22, z: 3 }),
      resolved("buckle", { x: 30, y: 28, z: 6 }, { x: 180, y: 0, z: 0 }),
      resolved("opening", { x: 12, y: 8, z: 8 }, { x: 180, y: 0, z: 0 }),
    ],
  );
  const output = compileBlenderProgram(input.plan, input.math, "attachment");

  assert.match(output.program, /Bool_Union_buckle/);
  assert.match(output.program, /Bool_Diff_opening/);
  assert.match(output.program, /mod\.solver = 'EXACT'/);
  assert.match(output.program, /result = base/);
  assert.match(output.program, /world_corners =/);
});

test("compiler rejects subtractive-only plans before Blender execution", () => {
  const input = fixtures(
    [primitive("opening", "subtractive")],
    [resolved("opening", { x: 12, y: 8, z: 8 })],
  );
  assert.throws(
    () => compileBlenderProgram(input.plan, input.math, "attachment"),
    /at least one additive primitive/,
  );
});
