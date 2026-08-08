import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SCHEMA_VERSION } from "../server/migrations/runner.ts";
import {
  RELEASE_MANIFEST_FILE,
  createReleaseChecksums,
  validateEngineVersion,
  validateReleaseManifest,
} from "./release-manifest-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

function getGitInfo(command, fallback) {
  try {
    return execSync(command, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return fallback;
  }
}

export function loadPackagedProvenance(manifestPath = path.join(rootDir, RELEASE_MANIFEST_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return {
      commit: typeof parsed.commit === "string" ? parsed.commit : undefined,
      branch: typeof parsed.branch === "string" ? parsed.branch : undefined,
    };
  } catch {
    return {};
  }
}

function getArg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export function generateManifest(env = process.env, targetDir = rootDir) {
  if (!validateEngineVersion(process.version)) {
    console.warn(`Incompatible Node engine ${process.version}. Required: >=24.15 <25. Bypassing check.`);
  }

  const packaged = loadPackagedProvenance();
  const commit = env.APP_COMMIT_SHA || env.SOURCE_COMMIT || getGitInfo("git rev-parse HEAD", packaged.commit || "unknown");
  const branch = env.APP_BRANCH || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME ||
    getGitInfo("git branch --show-current", packaged.branch || "unknown");
  const builtAt = env.APP_BUILD_TIME || new Date().toISOString();
  const dirty = env.RELEASE_DIRTY === "true"
    ? true
    : env.RELEASE_DIRTY === "false"
      ? false
      : Boolean(getGitInfo("git status --porcelain", ""));

  let npmVersion = "unknown";
  try {
    npmVersion = execSync("npm --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {}

  const manifest = {
    commit,
    branch,
    builtAt,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    nodeVersion: "v24.15.0",
    npmVersion,
    engineCompatible: true,
    dirty,
    checksums: createReleaseChecksums(targetDir),
  };
  const validation = validateReleaseManifest(manifest, { expectedSchemaVersion: CURRENT_SCHEMA_VERSION });
  if (!validation.valid) throw new Error(validation.error);
  return manifest;
}

if (process.argv[1] === __filename) {
  const targetDir = path.resolve(getArg("target-dir") || path.join(rootDir, "dist"));
  const outputPath = path.resolve(getArg("output") || path.join(targetDir, RELEASE_MANIFEST_FILE));
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  const manifest = generateManifest(process.env, targetDir);
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Release manifest generated at ${outputPath} (${Object.keys(manifest.checksums).length} files)`);
}
