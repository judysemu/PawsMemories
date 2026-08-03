import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = path.resolve(process.env.ARCHIVE_PATH || path.join(root, "pawsome3d-deploy-dirty.zip"));
const expectedCommit = process.env.ARCHIVE_EXPECTED_COMMIT || git(["rev-parse", "HEAD"]);
const requireClean = process.env.REQUIRE_CLEAN !== "false";
const soundManifestPath = "dist/animator-files/sounds/manifest.json";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paws-archive-smoke-"));
const extractRoot = path.join(tempRoot, "app");
let child;

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}
function assert(condition, message) { if (!condition) throw new Error(`Archive smoke assertion failed: ${message}`); }
function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
}
async function freePort() {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
async function request(base, route) { const response = await fetch(`${base}${route}`); return { response, body: await response.text() }; }
async function waitFor(base, route, status, timeout = 120_000, childOutput = []) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child?.exitCode !== null) throw new Error(`Packaged server exited before ${route}: ${childOutput.join("")}`);
    try { const result = await request(base, route); if (result.response.status === status) return result; } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${route}=${status}. Server output: ${childOutput.join("")}`);
}
async function terminate(handle) {
  if (!handle || handle.exitCode !== null) return;
  handle.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => handle.once("exit", resolve)), delay(5_000).then(() => handle.kill("SIGKILL"))]);
}
async function expectBootFailure(env, phrase) {
  const port = await freePort(); const output = [];
  const invalid = spawn("node", ["server.cjs"], { cwd: extractRoot, env: { ...process.env, ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  invalid.stdout.on("data", (chunk) => output.push(chunk.toString())); invalid.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const result = await Promise.race([new Promise((resolve) => invalid.once("exit", (code, signal) => resolve({ code, signal }))), delay(8_000).then(() => ({ timeout: true }))]);
  await terminate(invalid); assert(!result.timeout, `invalid ${phrase} boot remained alive past timeout`); assert(result.code !== 0, `invalid ${phrase} boot exited successfully`); assert(output.join("").toLowerCase().includes(phrase.toLowerCase()), `failure did not name ${phrase}`);
}

function createDatabaseIfNeeded(env) {
  const safeName = env.DB_NAME.replace(/[^a-zA-Z0-9_]/g, "_");
  assert(
    /^paws_archive_smoke(?:_[a-zA-Z0-9_]+)?$/.test(safeName),
    `refusing to reset non-smoke database ${safeName}`,
  );
  const result = spawnSync("mysql", ["-h", env.DB_HOST, "-P", env.DB_PORT, "-u", env.DB_USER, ...(env.DB_PASSWORD ? [`-p${env.DB_PASSWORD}`] : []), "-e", `DROP DATABASE IF EXISTS ${safeName}; CREATE DATABASE ${safeName}`], { encoding: "utf8" });
  return result.status === 0;
}

try {
  assert(fs.existsSync(archivePath), `deployment ZIP does not exist: ${archivePath}`);
  run("unzip", ["-t", archivePath], root); fs.mkdirSync(extractRoot, { recursive: true }); run("unzip", ["-q", "-o", archivePath, "-d", extractRoot], root);
  const manifest = JSON.parse(fs.readFileSync(path.join(extractRoot, "dist", "release-manifest.json"), "utf8"));
  const packagedSoundManifest = JSON.parse(fs.readFileSync(path.join(extractRoot, soundManifestPath), "utf8"));
  assert(manifest.commit === expectedCommit, `manifest commit ${manifest.commit} != ${expectedCommit}`); assert(manifest.dirty === !requireClean, `manifest dirty=${manifest.dirty} does not match smoke mode`);
  assert(fs.existsSync(path.join(extractRoot, "server.cjs")), "packaged Hostinger server.cjs is missing");
  for (const asset of packagedSoundManifest.assets) assert(fs.existsSync(path.join(extractRoot, "dist", asset.publicUrl.replace(/^\//, ""))), `missing Animator sound ${asset.id}`);
  const envDir = path.join(extractRoot, "dist", "server", "animator", "environments"); assert(fs.readdirSync(envDir).filter((name) => name.endsWith(".json")).length >= 8, "Animator environments incomplete");
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], extractRoot);
  const port = await freePort(); const env = { NODE_ENV: manifest.dirty ? "development" : "production", PORT: String(port), DB_HOST: process.env.DB_HOST || "127.0.0.1", DB_PORT: process.env.DB_PORT || "3306", DB_NAME: process.env.DB_NAME || "paws_archive_smoke", DB_USER: process.env.DB_USER || "root", DB_PASSWORD: process.env.DB_PASSWORD || "", JWT_SECRET: "archive-smoke-only-deterministic-secret", GEMINI_API_KEY: "archive-smoke-only-invalid-never-called", ADMIN_KEY: "archive-smoke-admin-key", ADMIN_EMAIL: "archive-smoke@example.invalid", ADMIN_PASSWORD: "archive-smoke-admin-password", MEDIA_BUCKET_NAME: "archive-smoke-public", MEDIA_PRIVATE_BUCKET_NAME: "archive-smoke-private", MEDIA_BUCKET_URL: "https://example.invalid", MEDIA_BUCKET_KEY: "archive-smoke-key", MEDIA_BUCKET_SECRET: "archive-smoke-secret", APP_COMMIT_SHA: expectedCommit };
  assert(createDatabaseIfNeeded(env), "isolated test database could not be created; provide a reachable MySQL service");
  const childOutput = [];
  child = spawn("node", ["server.cjs"], { cwd: extractRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => childOutput.push(chunk.toString())); child.stderr.on("data", (chunk) => childOutput.push(chunk.toString()));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(base, "/healthz", 200, 120_000, childOutput);
  assert(JSON.parse((await waitFor(base, "/readyz", 200, 120_000, childOutput)).body).status === "ready", "readyz was not ready");
  assert(JSON.parse((await request(base, "/version")).body).commit === expectedCommit, "/version commit mismatch");
  for (const route of ["/", "/create"]) {
    const result = await request(base, route);
    assert(
      result.response.status === 200,
      `${route} failed with ${result.response.status}: ${result.body.slice(0, 300)}; server=${childOutput.join("").slice(-1000)}`,
    );
  }
  await terminate(child); child = null;
  await expectBootFailure({ ...env, NODE_ENV: "production", JWT_SECRET: "" }, "JWT_SECRET");
  const missingAsset = path.join(extractRoot, "dist", packagedSoundManifest.assets[0].publicUrl.replace(/^\//, "")); fs.rmSync(missingAsset); await expectBootFailure({ ...env, NODE_ENV: "production" }, "sound");
  const archiveSha = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex"); console.log(`Archive smoke PASS: archive=${archivePath} commit=${expectedCommit} dirty=${manifest.dirty} bytes=${fs.statSync(archivePath).size} sha256=${archiveSha}`);
} finally { await terminate(child); fs.rmSync(tempRoot, { recursive: true, force: true }); }
