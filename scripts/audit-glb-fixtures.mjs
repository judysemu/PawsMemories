#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

export function inspectGlb(buffer) {
  const empty = {
    parse: false,
    mesh: false,
    texture: false,
    rig: false,
    animation: false,
    externalUris: 0,
    counts: { meshes: 0, materials: 0, textures: 0, images: 0, skins: 0, animations: 0 },
  };
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 20) fail("GLB_TOO_SMALL");
    if (buffer.toString("ascii", 0, 4) !== "glTF") fail("GLB_MAGIC_INVALID");
    if (buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) fail("GLB_HEADER_INVALID");
    const jsonLength = buffer.readUInt32LE(12);
    if (buffer.readUInt32LE(16) !== 0x4e4f534a || jsonLength <= 0 || 20 + jsonLength > buffer.length) fail("GLB_JSON_CHUNK_INVALID");
    const document = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8").trim());
    const count = (key) => Array.isArray(document[key]) ? document[key].length : 0;
    const counts = {
      meshes: count("meshes"),
      materials: count("materials"),
      textures: count("textures"),
      images: count("images"),
      skins: count("skins"),
      animations: count("animations"),
    };
    const externalUris = [...(document.buffers || []), ...(document.images || [])]
      .filter((item) => typeof item?.uri === "string" && !item.uri.startsWith("data:"))
      .length;
    const mesh = counts.meshes > 0
      && (document.meshes || []).some((entry) => Array.isArray(entry?.primitives) && entry.primitives.length > 0);
    const texture = counts.materials > 0 && counts.textures > 0 && counts.images > 0;
    const rig = counts.skins > 0
      && (document.skins || []).some((skin) => Array.isArray(skin?.joints) && skin.joints.length > 0);
    const animation = counts.animations > 0
      && (document.animations || []).some((clip) => Array.isArray(clip?.channels) && clip.channels.length > 0
        && Array.isArray(clip?.samplers) && clip.samplers.length > 0);
    return { parse: true, mesh, texture, rig, animation, externalUris, counts };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : "GLB_INVALID" };
  }
}

function makeSyntheticGlb(document) {
  const json = Buffer.from(JSON.stringify(document), "utf8");
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(20 + paddedLength, 0x20);
  bytes.write("glTF", 0, "ascii");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(paddedLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  json.copy(bytes, 20);
  return bytes;
}

export function resolveFixture(entry, roots) {
  if (entry.root === "synthetic") {
    if (entry.path === "malformed") return Buffer.from("not-a-glb", "utf8");
    if (entry.path === "valid-empty") return makeSyntheticGlb({ asset: { version: "2.0" }, scene: 0, scenes: [{}] });
    fail(`Unknown synthetic fixture: ${entry.path}`);
  }
  const root = roots[entry.root];
  if (!root) fail(`Unknown fixture root: ${entry.root}`);
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, entry.path);
  if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    fail(`Fixture escapes its root: ${entry.id}`);
  }
  return fs.readFileSync(absolutePath);
}

export function auditManifest(manifest, roots) {
  const results = [];
  for (const entry of manifest.fixtures || []) {
    let bytes;
    try {
      bytes = resolveFixture(entry, roots);
    } catch (error) {
      if (entry.optional && error?.code === "ENOENT") {
        results.push({ id: entry.id, status: "SKIP", reason: "OPTIONAL_FIXTURE_MISSING" });
        continue;
      }
      results.push({ id: entry.id, status: "FAIL", reason: error instanceof Error ? error.message : "FIXTURE_READ_FAILED" });
      continue;
    }
    const inspection = inspectGlb(bytes);
    const mismatches = Object.entries(entry.expected || {})
      .filter(([gate, expected]) => inspection[gate] !== expected)
      .map(([gate, expected]) => `${gate}:expected=${expected},actual=${inspection[gate]}`);
    if (inspection.externalUris > 0) mismatches.push(`externalUris=${inspection.externalUris}`);
    results.push({
      id: entry.id,
      status: mismatches.length === 0 ? "PASS" : "FAIL",
      reason: mismatches.join("; ") || undefined,
      inspection,
    });
  }
  return results;
}

export function discoverGlbs(root) {
  const absoluteRoot = path.resolve(root);
  if (!fs.existsSync(absoluteRoot)) return [];
  const discovered = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".glb")) discovered.push(absolutePath);
    }
  };
  visit(absoluteRoot);
  return discovered.sort((left, right) => left.localeCompare(right));
}

function printDropFolder(folder) {
  const absoluteRoot = path.resolve(folder);
  const files = discoverGlbs(absoluteRoot);
  if (files.length === 0) {
    console.log(`INFO\tno GLB files found\t${absoluteRoot}`);
    return;
  }
  for (const absolutePath of files) {
    const inspection = inspectGlb(fs.readFileSync(absolutePath));
    const relativePath = path.relative(absoluteRoot, absolutePath);
    const status = inspection.parse && inspection.externalUris === 0 ? "INSPECTED" : "FLAGGED";
    console.log(
      `${status}\t${relativePath}\tparse=${inspection.parse} mesh=${inspection.mesh} texture=${inspection.texture} rig=${inspection.rig} animation=${inspection.animation} externalUris=${inspection.externalUris}`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folderFlag = process.argv.indexOf("--folder");
  if (folderFlag >= 0) {
    const folder = process.argv[folderFlag + 1];
    if (!folder) fail("--folder requires a path");
    printDropFolder(folder);
    process.exit(0);
  }
  const manifestPath = path.resolve(process.env.PAWS_3D_FIXTURE_MANIFEST || path.join(repoRoot, "fixtures/inhouse3d/manifest.json"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const results = auditManifest(manifest, {
    paws: repoRoot,
    gibi: path.resolve(process.env.GIBIWORLD_ROOT || path.join(repoRoot, "../gibiworld")),
  });
  for (const result of results) {
    const summary = result.inspection
      ? `mesh=${result.inspection.mesh} texture=${result.inspection.texture} rig=${result.inspection.rig} animation=${result.inspection.animation}`
      : result.reason;
    console.log(`${result.status}\t${result.id}\t${summary || ""}`);
  }
  if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
}
