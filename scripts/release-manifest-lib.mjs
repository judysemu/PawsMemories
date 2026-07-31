import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RELEASE_MANIFEST_FILE = "release-manifest.json";

export function validateEngineVersion(versionStr = process.version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(versionStr));
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major === 24 && minor >= 15;
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

export function listReleaseFiles(rootDir) {
  const files = [];

  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = toPosixPath(path.relative(rootDir, fullPath));
      if (relativePath === RELEASE_MANIFEST_FILE) continue;
      if (entry.name === ".DS_Store") {
        throw new Error(`Release archives may not contain filesystem metadata: ${relativePath}`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Release archives may not contain symbolic links: ${relativePath}`);
      }
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(relativePath);
      else throw new Error(`Unsupported release file type: ${relativePath}`);
    }
  }

  visit(rootDir);
  return files.sort();
}

export function createReleaseChecksums(rootDir) {
  return Object.fromEntries(
    listReleaseFiles(rootDir).map((relativePath) => [
      relativePath,
      sha256File(path.join(rootDir, relativePath)),
    ]),
  );
}

export function validateReleaseManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, error: "Release manifest must be an object." };
  }
  if (!/^[0-9a-f]{40}$/i.test(manifest.commit || "")) {
    return { valid: false, error: "Release manifest commit must be a full Git SHA." };
  }
  if (options.expectedCommit && manifest.commit !== options.expectedCommit) {
    return { valid: false, error: `Manifest commit ${manifest.commit} does not match ${options.expectedCommit}.` };
  }
  if (typeof manifest.branch !== "string" || !manifest.branch.trim()) {
    return { valid: false, error: "Release manifest branch is required." };
  }
  if (options.expectedBranch && manifest.branch !== options.expectedBranch) {
    return { valid: false, error: `Manifest branch ${manifest.branch} does not match ${options.expectedBranch}.` };
  }
  if (typeof manifest.builtAt !== "string" || !Number.isFinite(Date.parse(manifest.builtAt))) {
    return { valid: false, error: "Release manifest builtAt must be an ISO timestamp." };
  }
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) {
    return { valid: false, error: "Release manifest schemaVersion must be a positive integer." };
  }
  if (options.expectedSchemaVersion && manifest.schemaVersion !== options.expectedSchemaVersion) {
    return { valid: false, error: `Manifest schemaVersion ${manifest.schemaVersion} does not match ${options.expectedSchemaVersion}.` };
  }
  if (typeof manifest.nodeVersion !== "string" || typeof manifest.npmVersion !== "string") {
    return { valid: false, error: "Release manifest runtime versions are required." };
  }
  if (manifest.engineCompatible !== true || !validateEngineVersion(manifest.nodeVersion)) {
    return { valid: false, error: "Release manifest Node engine is incompatible." };
  }
  if (typeof manifest.dirty !== "boolean") {
    return { valid: false, error: "Release manifest dirty flag is required." };
  }
  if (options.requireClean && manifest.dirty) {
    return { valid: false, error: "Production release manifest is dirty." };
  }
  if (!manifest.checksums || typeof manifest.checksums !== "object" || Array.isArray(manifest.checksums)) {
    return { valid: false, error: "Release manifest checksums are required." };
  }
  for (const [relativePath, hash] of Object.entries(manifest.checksums)) {
    if (
      !relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\") ||
      relativePath.split("/").includes("..") || relativePath === RELEASE_MANIFEST_FILE
    ) {
      return { valid: false, error: `Unsafe manifest checksum path: ${relativePath}` };
    }
    if (!/^[0-9a-f]{64}$/i.test(String(hash))) {
      return { valid: false, error: `Invalid SHA-256 for ${relativePath}.` };
    }
  }
  return { valid: true };
}

export function verifyReleaseDirectory(rootDir, manifest, options = {}) {
  const shape = validateReleaseManifest(manifest, options);
  if (!shape.valid) return shape;

  const actualFiles = listReleaseFiles(rootDir);
  const manifestFiles = Object.keys(manifest.checksums).sort();
  const actualSet = new Set(actualFiles);
  const manifestSet = new Set(manifestFiles);

  const unlisted = actualFiles.filter((file) => !manifestSet.has(file));
  if (unlisted.length) {
    return { valid: false, error: `Archive contains unlisted file: ${unlisted[0]}` };
  }
  const missing = manifestFiles.filter((file) => !actualSet.has(file));
  if (missing.length) {
    return { valid: false, error: `Manifest file missing from archive: ${missing[0]}` };
  }

  for (const relativePath of manifestFiles) {
    const actualHash = sha256File(path.join(rootDir, relativePath));
    if (actualHash !== manifest.checksums[relativePath]) {
      return { valid: false, error: `Checksum mismatch for ${relativePath}.` };
    }
  }

  return { valid: true, fileCount: manifestFiles.length };
}
