import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditManifest, discoverGlbs, inspectGlb } from "../scripts/audit-glb-fixtures.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("in-house GLB fixture matrix distinguishes independent quality gates", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "fixtures/inhouse3d/manifest.json"), "utf8"));
  const localOnly = { ...manifest, fixtures: manifest.fixtures.filter((entry) => entry.root !== "gibi") };
  const results = auditManifest(localOnly, { paws: repoRoot });
  assert.equal(results.length, 3);
  assert.equal(results.every((result) => result.status === "PASS"), true, JSON.stringify(results, null, 2));
  assert.deepEqual(results.map((result) => result.inspection && {
    parse: result.inspection.parse,
    mesh: result.inspection.mesh,
    texture: result.inspection.texture,
    rig: result.inspection.rig,
    animation: result.inspection.animation,
  }), [
    { parse: true, mesh: true, texture: false, rig: false, animation: false },
    { parse: true, mesh: false, texture: false, rig: false, animation: false },
    { parse: false, mesh: false, texture: false, rig: false, animation: false },
  ]);
});

test("fixture inspection rejects external asset URIs", () => {
  const json = Buffer.from(JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ uri: "https://outside.example/model.bin", byteLength: 1 }],
  }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const glb = Buffer.alloc(20 + padded.length);
  glb.write("glTF", 0, "ascii");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(glb, 20);
  assert.equal(inspectGlb(glb).externalUris, 1);
});

test("model drop discovery is recursive and GLB-only", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paws-glb-discovery-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temporaryRoot, "nested"));
  fs.writeFileSync(path.join(temporaryRoot, "ignore.txt"), "not a model");
  fs.writeFileSync(path.join(temporaryRoot, "nested", "sample.GLB"), "fixture");
  assert.deepEqual(discoverGlbs(temporaryRoot), [path.join(temporaryRoot, "nested", "sample.GLB")]);
});
