import crypto from "crypto";
import dns from "dns/promises";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const RIG_PIPELINE_CONTRACT_VERSION = 1;
export const RIG_PIPELINE_VALIDATOR_VERSION = "rig-pipeline-blender-v1";
export const RIG_PIPELINE_MAX_ASSET_BYTES = 100 * 1024 * 1024;
export const RIG_PIPELINE_MAX_PRINT_BYTES = 8 * 1024 * 1024;
export const RIG_PIPELINE_MAX_REQUEST_BYTES = 128 * 1024;
export const CANONICAL_FACIAL_TARGETS = Object.freeze([
  "A", "B", "C", "D", "E", "F", "G", "H", "X",
  "jawOpen", "eyeBlinkLeft", "eyeBlinkRight",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CAPABILITIES = new Set(["full", "partial", "body_only", "unsupported"]);
const TOP_LEVEL_KEYS = new Set([
  "contractVersion", "jobUuid", "attemptUuid", "idempotencyKey", "profileId",
  "classification", "requestFacial", "requestedFacialTargets", "source", "budgets", "accessories",
]);

export class RigPipelineError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = "RigPipelineError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 422) {
  throw new RigPipelineError(code, message, status);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value, label) {
  if (!isPlainObject(value)) fail("INVALID_REQUEST", `${label} must be an object`, 400);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("INVALID_REQUEST", `${label}.${key} is not supported`, 400);
  }
}

function stringValue(value, label, min, max) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail("INVALID_REQUEST", `${label} is invalid`, 400);
  }
  return value;
}

function numberValue(value, label, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail("INVALID_REQUEST", `${label} is invalid`, 400);
  }
  return value;
}

function parseAsset(value, label) {
  const asset = objectValue(value, label);
  exactKeys(asset, new Set(["signedUrl", "sha256", "sizeBytes"]), label);
  const signedUrl = stringValue(asset.signedUrl, `${label}.signedUrl`, 1, 4096);
  try {
    new URL(signedUrl);
  } catch {
    fail("INVALID_REQUEST", `${label}.signedUrl must be a URL`, 400);
  }
  if (!SHA256_PATTERN.test(asset.sha256 || "")) fail("INVALID_REQUEST", `${label}.sha256 must be lowercase SHA-256`, 400);
  return {
    signedUrl,
    sha256: asset.sha256,
    sizeBytes: numberValue(asset.sizeBytes, `${label}.sizeBytes`, 1, RIG_PIPELINE_MAX_ASSET_BYTES),
  };
}

export function validateRigPipelineRequest(input) {
  const value = objectValue(input, "request");
  exactKeys(value, TOP_LEVEL_KEYS, "request");
  if (value.contractVersion !== 1) fail("UNSUPPORTED_CONTRACT", "contractVersion must be 1", 400);
  if (!UUID_PATTERN.test(value.jobUuid || "")) fail("INVALID_REQUEST", "jobUuid must be a UUID", 400);
  if (!UUID_PATTERN.test(value.attemptUuid || "")) fail("INVALID_REQUEST", "attemptUuid must be a UUID", 400);
  const idempotencyKey = stringValue(value.idempotencyKey, "idempotencyKey", 8, 180);
  const profileId = stringValue(value.profileId, "profileId", 1, 120);
  if (!new Set(["biped", "quadruped"]).has(value.classification)) fail("INVALID_REQUEST", "classification is invalid", 400);
  if (typeof value.requestFacial !== "boolean") fail("INVALID_REQUEST", "requestFacial must be boolean", 400);
  if (!Array.isArray(value.requestedFacialTargets) || value.requestedFacialTargets.length > 20) {
    fail("INVALID_REQUEST", "requestedFacialTargets is invalid", 400);
  }
  const requestedFacialTargets = value.requestedFacialTargets.map((target, index) =>
    stringValue(target, `requestedFacialTargets[${index}]`, 1, 120));

  const budgets = objectValue(value.budgets, "budgets");
  exactKeys(budgets, new Set(["maxJoints", "maxInfluences", "maxTriangles", "maxTextureDimension"]), "budgets");
  const parsedBudgets = {
    maxJoints: numberValue(budgets.maxJoints, "budgets.maxJoints", 1, 512),
    maxInfluences: numberValue(budgets.maxInfluences, "budgets.maxInfluences", 1, 8),
    maxTriangles: numberValue(budgets.maxTriangles, "budgets.maxTriangles", 1, 1_000_000),
    maxTextureDimension: numberValue(budgets.maxTextureDimension, "budgets.maxTextureDimension", 1, 16_384),
  };

  if (!Array.isArray(value.accessories) || value.accessories.length > 20) {
    fail("INVALID_REQUEST", "accessories is invalid", 400);
  }
  const accessories = value.accessories.map((entry, index) => {
    const accessory = objectValue(entry, `accessories[${index}]`);
    exactKeys(accessory, new Set(["accessoryUuid", "attachmentBone", "signedUrl", "sha256", "sizeBytes"]), `accessories[${index}]`);
    if (!UUID_PATTERN.test(accessory.accessoryUuid || "")) fail("INVALID_REQUEST", `accessories[${index}].accessoryUuid must be a UUID`, 400);
    return {
      accessoryUuid: accessory.accessoryUuid,
      attachmentBone: stringValue(accessory.attachmentBone, `accessories[${index}].attachmentBone`, 1, 120),
      ...parseAsset({ signedUrl: accessory.signedUrl, sha256: accessory.sha256, sizeBytes: accessory.sizeBytes }, `accessories[${index}]`),
    };
  });

  return {
    contractVersion: 1,
    jobUuid: value.jobUuid,
    attemptUuid: value.attemptUuid,
    idempotencyKey,
    profileId,
    classification: value.classification,
    requestFacial: value.requestFacial,
    requestedFacialTargets,
    source: parseAsset(value.source, "source"),
    budgets: parsedBudgets,
    accessories,
  };
}

function configuredHosts(value = process.env.RIG_PIPELINE_SOURCE_HOSTS || "") {
  return new Set(value.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
}

function privateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] >= 224;
}

export function isPrivateAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) return privateIpv4(address);
  if (kind !== 6) return true;
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:")) return privateIpv4(normalized.slice(7));
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
    || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized);
}

export async function validateSourceUrl(rawUrl, options = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail("SOURCE_URL_REJECTED", "signed URL is invalid", 400);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    fail("SOURCE_URL_REJECTED", "signed URL must use HTTPS without credentials or a custom port", 400);
  }
  const allowedHosts = options.allowedHosts || configuredHosts();
  if (allowedHosts.size === 0 || !allowedHosts.has(parsed.hostname.toLowerCase())) {
    fail("SOURCE_HOST_REJECTED", "signed URL host is not allowlisted", 403);
  }
  const addresses = await (options.dnsLookup || dns.lookup)(parsed.hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    fail("SOURCE_HOST_REJECTED", "signed URL resolved to a private or invalid address", 403);
  }
  return parsed;
}

export async function downloadVerifiedAsset(asset, options = {}) {
  const parsed = await validateSourceUrl(asset.signedUrl, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30_000);
  try {
    const response = await (options.fetchImpl || fetch)(parsed, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "model/gltf-binary,application/octet-stream" },
    });
    if (response.status >= 300 && response.status < 400) fail("SOURCE_REDIRECT_REJECTED", "signed URL redirects are not allowed");
    if (!response.ok) fail("SOURCE_DOWNLOAD_FAILED", `asset download returned HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared !== asset.sizeBytes) fail("SOURCE_SIZE_MISMATCH", "asset Content-Length does not match request");
    const reader = response.body?.getReader();
    if (!reader) fail("SOURCE_DOWNLOAD_FAILED", "asset response has no readable body");
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > asset.sizeBytes) {
        await reader.cancel();
        fail("SOURCE_TOO_LARGE", "asset exceeded its signed byte count", 413);
      }
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks, total);
    if (buffer.length !== asset.sizeBytes) fail("SOURCE_SIZE_MISMATCH", "asset byte count does not match request");
    const digest = crypto.createHash("sha256").update(buffer).digest("hex");
    if (digest !== asset.sha256) fail("SOURCE_HASH_MISMATCH", "asset SHA-256 does not match request");
    inspectGlb(buffer);
    return buffer;
  } catch (error) {
    if (error instanceof RigPipelineError) throw error;
    if (error?.name === "AbortError") fail("SOURCE_DOWNLOAD_TIMEOUT", "asset download timed out", 504);
    fail("SOURCE_DOWNLOAD_FAILED", "asset download failed");
  } finally {
    clearTimeout(timer);
  }
}

export function readVerifiedTrellisAsset(asset, options = {}) {
  let parsed;
  try {
    parsed = new URL(asset.signedUrl);
  } catch {
    fail("SOURCE_URL_REJECTED", "shared TRELLIS source is invalid", 400);
  }
  if (parsed.protocol !== "trellis2:" || parsed.hostname !== "jobs" || parsed.username
    || parsed.password || parsed.port || parsed.search || parsed.hash) {
    fail("SOURCE_URL_REJECTED", "shared TRELLIS source must use the internal jobs namespace", 400);
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    fail("SOURCE_URL_REJECTED", "shared TRELLIS source path is invalid", 400);
  }
  const pathParts = decodedPath.split("/");
  const jobId = pathParts[1];
  if (pathParts.length !== 3 || !UUID_PATTERN.test(jobId || "") || pathParts[2] !== "master.glb") {
    fail("SOURCE_URL_REJECTED", "shared TRELLIS source path is not an allowed job artifact", 400);
  }

  const configuredRoot = options.sharedJobsDirectory || process.env.TRELLIS_SHARED_JOBS_DIR || "";
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
    fail("SHARED_SOURCE_NOT_CONFIGURED", "shared TRELLIS source storage is not configured", 503);
  }

  let root;
  let jobDirectory;
  let candidate;
  let descriptor;
  try {
    root = fs.realpathSync(configuredRoot);
    jobDirectory = path.join(root, jobId);
    candidate = path.join(jobDirectory, "master.glb");
    if (fs.lstatSync(jobDirectory).isSymbolicLink() || fs.lstatSync(candidate).isSymbolicLink()) {
      fail("SOURCE_PATH_REJECTED", "shared TRELLIS source cannot use symbolic links", 403);
    }
    if (fs.realpathSync(candidate) !== candidate || path.dirname(candidate) !== jobDirectory) {
      fail("SOURCE_PATH_REJECTED", "shared TRELLIS source escaped the configured job directory", 403);
    }
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail("SOURCE_PATH_REJECTED", "shared TRELLIS source is not a regular file", 403);
    if (stat.size > RIG_PIPELINE_MAX_ASSET_BYTES || stat.size > asset.sizeBytes) {
      fail("SOURCE_TOO_LARGE", "shared TRELLIS source exceeded its declared byte count", 413);
    }
    if (stat.size !== asset.sizeBytes) fail("SOURCE_SIZE_MISMATCH", "shared TRELLIS source byte count does not match request");
    const buffer = fs.readFileSync(descriptor);
    const digest = crypto.createHash("sha256").update(buffer).digest("hex");
    if (digest !== asset.sha256) fail("SOURCE_HASH_MISMATCH", "shared TRELLIS source SHA-256 does not match request");
    inspectGlb(buffer);
    return buffer;
  } catch (error) {
    if (error instanceof RigPipelineError) throw error;
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      fail("SOURCE_NOT_FOUND", "shared TRELLIS source is unavailable", 404);
    }
    fail("SOURCE_READ_FAILED", "shared TRELLIS source could not be read", 500);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function acquireVerifiedAsset(asset, options = {}) {
  let protocol;
  try {
    protocol = new URL(asset.signedUrl).protocol;
  } catch {
    fail("SOURCE_URL_REJECTED", "asset URL is invalid", 400);
  }
  if (protocol === "trellis2:") return Promise.resolve(readVerifiedTrellisAsset(asset, options));
  return downloadVerifiedAsset(asset, options.downloadOptions || options);
}

export function inspectGlb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) fail("MALFORMED_GLB", "GLB is too small");
  if (buffer.toString("ascii", 0, 4) !== "glTF") fail("MALFORMED_GLB", "GLB magic is invalid");
  if (buffer.readUInt32LE(4) !== 2) fail("MALFORMED_GLB", "only GLB version 2 is supported");
  if (buffer.readUInt32LE(8) !== buffer.length) fail("MALFORMED_GLB", "GLB declared length does not match body length");
  let offset = 12;
  let document = null;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) fail("MALFORMED_GLB", "GLB chunk header is truncated");
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 !== 0 || offset + length > buffer.length) fail("MALFORMED_GLB", "GLB chunk is invalid");
    if (type === 0x4e4f534a && document === null) {
      try {
        document = JSON.parse(buffer.toString("utf8", offset, offset + length).trim());
      } catch {
        fail("MALFORMED_GLB", "GLB JSON chunk is invalid");
      }
    }
    offset += length;
  }
  if (offset !== buffer.length || !isPlainObject(document) || document.asset?.version !== "2.0") {
    fail("MALFORMED_GLB", "GLB must contain a valid glTF 2.0 JSON chunk");
  }
  const morphTargetNames = [];
  let triangleCount = 0;
  for (const mesh of Array.isArray(document.meshes) ? document.meshes : []) {
    for (const primitive of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const accessorIndex = Number.isInteger(primitive.indices) ? primitive.indices : primitive.attributes?.POSITION;
      const count = Number.isInteger(accessorIndex) ? document.accessors?.[accessorIndex]?.count : 0;
      if (!Number.isInteger(count) || count < 0) fail("MALFORMED_GLB", "GLB triangle accessor is invalid");
      triangleCount += Math.floor(count / 3);
    }
    const names = mesh?.extras?.targetNames;
    if (names === undefined) continue;
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !name || name.length > 120)) {
      fail("MALFORMED_GLB", "GLB morph target names are invalid");
    }
    const targetCount = Math.max(0, ...(Array.isArray(mesh.primitives) ? mesh.primitives : []).map((primitive) => Array.isArray(primitive?.targets) ? primitive.targets.length : 0));
    if (names.length !== targetCount) fail("MALFORMED_GLB", "GLB morph target names do not match target data");
    for (const name of names) {
      if (!morphTargetNames.includes(name)) morphTargetNames.push(name);
    }
  }
  const jointIndices = new Set();
  for (const skin of Array.isArray(document.skins) ? document.skins : []) {
    if (!Array.isArray(skin?.joints) || skin.joints.some((index) => !Number.isInteger(index) || !document.nodes?.[index])) {
      fail("MALFORMED_GLB", "GLB skin joints are invalid");
    }
    skin.joints.forEach((index) => jointIndices.add(index));
  }
  const boneNames = [...jointIndices].map((index) => document.nodes[index]?.name).filter((name) => typeof name === "string" && name.length > 0);
  const hasSkinnedMesh = (Array.isArray(document.nodes) ? document.nodes : []).some((node) => Number.isInteger(node?.mesh) && Number.isInteger(node?.skin));
  return { document, morphTargetNames, triangleCount, boneNames, jointCount: jointIndices.size, hasSkinnedMesh };
}

function loadProfile(profileId, classification, profileDirectory) {
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(profileId)) fail("INVALID_PROFILE", "profileId is not an installed profile", 422);
  const resolved = path.resolve(profileDirectory, `${profileId}.json`);
  if (path.dirname(resolved) !== path.resolve(profileDirectory) || !fs.existsSync(resolved)) {
    fail("INVALID_PROFILE", "profileId is not installed", 422);
  }
  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    fail("INVALID_PROFILE", "profile is unreadable", 500);
  }
  if (profile.id !== profileId || profile.skeleton !== classification || !isPlainObject(profile.joints)) {
    fail("INVALID_PROFILE", "profile does not match the requested classification", 422);
  }
  return profile;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function requestFingerprint(request) {
  return sha256(Buffer.from(JSON.stringify(request)));
}

function boundedText(value, fallback = "measurement unavailable", max = 2000) {
  const result = typeof value === "string" && value.length ? value : fallback;
  return result.slice(0, max);
}

function finiteMetric(value, label, { integer = false, min = 0 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    fail("INVALID_WORKER_RESULT", `${label} is invalid`, 502);
  }
  return value;
}

function normalizeRules(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length > 100 || (!allowEmpty && value.length === 0)) {
    fail("INVALID_WORKER_RESULT", `${label} rules are invalid`, 502);
  }
  const seen = new Set();
  return value.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.rule !== "string" || !entry.rule || entry.rule.length > 120
      || typeof entry.pass !== "boolean" || seen.has(entry.rule)) {
      fail("INVALID_WORKER_RESULT", `${label} contains an invalid rule`, 502);
    }
    seen.add(entry.rule);
    const rule = { rule: entry.rule, pass: entry.pass, detail: boundedText(entry.detail) };
    if (typeof entry.measured === "number" && Number.isFinite(entry.measured)) rule.measured = entry.measured;
    else if (typeof entry.measured === "string") rule.measured = entry.measured.slice(0, 500);
    else if (isPlainObject(entry.metrics)) rule.measured = JSON.stringify(entry.metrics).slice(0, 500);
    return rule;
  });
}

function normalizeTargets(value) {
  if (!Array.isArray(value) || value.length > 256) fail("INVALID_WORKER_RESULT", "facial targets are invalid", 502);
  return value.map((target) => {
    if (!isPlainObject(target)) fail("INVALID_WORKER_RESULT", "facial target is invalid", 502);
    const canonicalName = target.canonicalName === null ? null : stringValue(target.canonicalName, "target.canonicalName", 1, 120);
    return {
      name: stringValue(target.name, "target.name", 1, 120),
      canonicalName,
      displacedVertexCount: finiteMetric(target.displacedVertexCount ?? target.displacedVertices, "target.displacedVertexCount", { integer: true }),
      maxDisplacement: finiteMetric(target.maxDisplacement, "target.maxDisplacement"),
      localityPass: target.localityPass === true,
      deformationPass: target.deformationPass === true || target.pass === true,
    };
  });
}

function normalizeRenders(value, capability, maxRenderBytes = 20 * 1024 * 1024) {
  if (!Array.isArray(value) || value.length > 2) fail("INVALID_WORKER_RESULT", "render evidence is invalid", 502);
  const renders = value.map((render) => {
    if (!isPlainObject(render)) fail("INVALID_WORKER_RESULT", "render evidence is invalid", 502);
    const role = render.role || (render.view === "front" ? "facial_render_front" : "facial_render_three_quarter");
    if (!new Set(["facial_render_front", "facial_render_three_quarter"]).has(role) || typeof render.pngBase64 !== "string") {
      fail("INVALID_WORKER_RESULT", "render role or bytes are invalid", 502);
    }
    const bytes = Buffer.from(render.pngBase64, "base64");
    if (bytes.length === 0 || bytes.length > maxRenderBytes || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      fail("INVALID_WORKER_RESULT", "render is not a bounded PNG", 502);
    }
    return { role, pngBase64: render.pngBase64, sha256: sha256(bytes), sizeBytes: bytes.length };
  });
  if (capability === "full" || capability === "partial") {
    const roles = new Set(renders.map((render) => render.role));
    if (renders.length !== 2 || !roles.has("facial_render_front") || !roles.has("facial_render_three_quarter")) {
      fail("FACIAL_EVIDENCE_MISSING", "full or partial facial capability requires two measured renders", 502);
    }
  }
  return renders;
}

function normalizeAccessories(value, request) {
  if (!Array.isArray(value) || value.length !== request.accessories.length) {
    fail("INVALID_WORKER_RESULT", "accessory result count does not match request", 502);
  }
  const requested = new Map(request.accessories.map((entry) => [entry.accessoryUuid, entry]));
  return value.map((entry) => {
    if (!isPlainObject(entry) || !requested.has(entry.accessoryUuid) || requested.get(entry.accessoryUuid).attachmentBone !== entry.attachmentBone) {
      fail("INVALID_WORKER_RESULT", "accessory result identity does not match request", 502);
    }
    const transform = objectValue(entry.transform, "accessory.transform");
    const tuple = (tupleValue, length, label) => {
      if (!Array.isArray(tupleValue) || tupleValue.length !== length || tupleValue.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
        fail("INVALID_WORKER_RESULT", `${label} is invalid`, 502);
      }
      return tupleValue;
    };
    return {
      accessoryUuid: entry.accessoryUuid,
      attachmentBone: entry.attachmentBone,
      transform: {
        position: tuple(transform.position, 3, "accessory.transform.position"),
        rotation: tuple(transform.rotation, 4, "accessory.transform.rotation"),
        scale: tuple(transform.scale, 3, "accessory.transform.scale"),
      },
      floatingDistance: finiteMetric(entry.floatingDistance, "accessory.floatingDistance"),
      penetrationDepth: finiteMetric(entry.penetrationDepth, "accessory.penetrationDepth"),
      animationSweepPass: entry.animationSweepPass === true,
      polygonBudgetPass: entry.polygonBudgetPass === true,
      printClearanceMm: finiteMetric(entry.printClearanceMm, "accessory.printClearanceMm"),
    };
  });
}

function normalizeFusedPrint(value, failure, request, outputBuffer, fusedPrintBuffer, fusedInspection) {
  if (request.accessories.length === 0) {
    if (value !== undefined || failure !== undefined || (fusedPrintBuffer && fusedPrintBuffer.length)) {
      fail("INVALID_WORKER_RESULT", "fused print output was returned without requested accessories", 502);
    }
    return {};
  }
  if (value === undefined) {
    if (!isPlainObject(failure) || !/^PRINT_[A-Z0-9_]+$/.test(failure.code || "")) {
      fail("INVALID_WORKER_RESULT", "accessory requests require a fused print output or typed print failure", 502);
    }
    return {
      fusedPrintFailure: {
        code: boundedText(failure.code, "PRINT_FUSION_FAILED", 120),
        message: boundedText(failure.message, "Print fusion could not be proven", 500),
      },
    };
  }
  if (failure !== undefined || !isPlainObject(value) || !Buffer.isBuffer(fusedPrintBuffer) || fusedPrintBuffer.length === 0) {
    fail("INVALID_WORKER_RESULT", "fused print output is incomplete", 502);
  }
  if (fusedPrintBuffer.length > RIG_PIPELINE_MAX_PRINT_BYTES) fail("OUTPUT_BUDGET_EXCEEDED", "fused print GLB exceeds 8 MB", 502);
  if (fusedPrintBuffer.equals(outputBuffer)) fail("INVALID_WORKER_RESULT", "fused print output reuses the display GLB", 502);
  const metrics = objectValue(value.metrics, "workerResult.fusedPrint.metrics");
  const rules = normalizeRules(value.rules, "fusedPrint");
  if (rules.some((rule) => !rule.pass) || value.overallPass !== true) {
    fail("PRINT_VALIDATION_FAILED", "fused print output has nonpassing measured rules", 502);
  }
  const triangleCount = finiteMetric(metrics.triangleCount, "fusedPrint.metrics.triangleCount", { integer: true, min: 1 });
  if (!fusedInspection || fusedInspection.triangleCount !== triangleCount || fusedInspection.hasSkinnedMesh
    || (fusedInspection.document?.meshes?.length || 0) !== 1) {
    fail("PRINT_OUTPUT_MISMATCH", "reported print measurements do not match the exported GLB", 502);
  }
  const normalizedMetrics = {
    objectCount: finiteMetric(metrics.objectCount, "fusedPrint.metrics.objectCount", { integer: true, min: 1 }),
    connectedComponents: finiteMetric(metrics.connectedComponents, "fusedPrint.metrics.connectedComponents", { integer: true, min: 1 }),
    triangleCount,
    nonManifoldEdges: finiteMetric(metrics.nonManifoldEdges, "fusedPrint.metrics.nonManifoldEdges", { integer: true }),
    finiteGeometry: metrics.finiteGeometry === true,
    volumeCubicMeters: finiteMetric(metrics.volumeCubicMeters, "fusedPrint.metrics.volumeCubicMeters", { min: Number.EPSILON }),
  };
  if (normalizedMetrics.objectCount !== 1 || normalizedMetrics.connectedComponents !== 1
    || normalizedMetrics.nonManifoldEdges !== 0 || !normalizedMetrics.finiteGeometry
    || normalizedMetrics.volumeCubicMeters <= 1e-12) {
    fail("PRINT_VALIDATION_FAILED", "fused print output is not a finite, connected, watertight mesh", 502);
  }
  return {
    fusedPrint: {
      glbBase64: fusedPrintBuffer.toString("base64"),
      sha256: sha256(fusedPrintBuffer),
      sizeBytes: fusedPrintBuffer.length,
      validatorVersion: boundedText(value.validatorVersion, "rig-pipeline-print-v1", 120),
      metrics: normalizedMetrics,
      rules,
      overallPass: true,
    },
  };
}

function normalizePipelineResult(raw, request, outputBuffer, sourceInspection, outputInspection, fusedPrintBuffer, fusedInspection) {
  const value = objectValue(raw, "workerResult");
  if (isPlainObject(value.failure)) fail(boundedText(value.failure.code, "BLENDER_PIPELINE_FAILED", 120), boundedText(value.failure.message, "Blender pipeline failed", 500), 422);
  const rigValue = objectValue(value.rig, "workerResult.rig");
  const facialValue = objectValue(value.facial, "workerResult.facial");
  const rules = normalizeRules(rigValue.rules, "rig");
  const overallPass = rules.every((rule) => rule.pass);
  if (rigValue.overallPass !== overallPass) fail("INVALID_WORKER_RESULT", "rig overallPass disagrees with its rule aggregate", 502);
  if (!CAPABILITIES.has(facialValue.capability)) fail("INVALID_WORKER_RESULT", "facial capability is invalid", 502);
  const facialRules = normalizeRules(facialValue.rules, "facial", { allowEmpty: true });
  const targets = normalizeTargets(facialValue.targets);
  const canonicalMap = {};
  for (const target of targets) {
    if (target.canonicalName) canonicalMap[target.name] = target.canonicalName;
  }
  const sourceNames = Array.isArray(value.sourceTargetNames) ? value.sourceTargetNames : [];
  const outputNames = new Set(Array.isArray(value.outputTargetNames) ? value.outputTargetNames : []);
  if (sourceNames.some((name) => typeof name !== "string" || !outputNames.has(name))) {
    fail("SOURCE_TARGETS_LOST", "export did not preserve every source morph target", 502);
  }
  const sourceGlbNames = new Set(sourceInspection?.morphTargetNames || []);
  const outputGlbNames = new Set(outputInspection?.morphTargetNames || []);
  if (sourceNames.some((name) => !sourceGlbNames.has(name)) || sourceGlbNames.size !== new Set(sourceNames).size) {
    fail("INVALID_WORKER_RESULT", "Blender source target inventory disagrees with the source GLB", 502);
  }
  if ([...outputNames].some((name) => !outputGlbNames.has(name)) || [...sourceGlbNames].some((name) => !outputGlbNames.has(name))) {
    fail("SOURCE_TARGETS_LOST", "exported GLB target names do not preserve the measured inventory", 502);
  }
  const passing = new Set(targets.filter((target) => target.localityPass && target.deformationPass).map((target) => target.canonicalName));
  if (targets.filter((target) => target.deformationPass && target.localityPass).some((target) => !outputGlbNames.has(target.name))) {
    fail("OUTPUT_TARGETS_MISSING", "measured facial target names are missing from the exported GLB", 502);
  }
  const hasBlink = passing.has("eyeBlinkLeft") && passing.has("eyeBlinkRight");
  const hasJaw = passing.has("jawOpen");
  const hasEyeControls = value.facial.hasEyeControls === true;
  if (facialValue.capability === "full" && (!CANONICAL_FACIAL_TARGETS.slice(0, 9).every((name) => passing.has(name)) || !hasBlink || !hasJaw)) {
    fail("INVALID_WORKER_RESULT", "full facial capability lacks measured A-H/X, jaw, or bilateral blink", 502);
  }
  if ((facialValue.capability === "full" || facialValue.capability === "partial") && passing.size === 0) {
    fail("INVALID_WORKER_RESULT", "facial capability lacks measured localized deformation", 502);
  }
  const metrics = objectValue(rigValue.metrics, "workerResult.rig.metrics");
  const boneNames = Array.isArray(metrics.boneNames) ? metrics.boneNames : [];
  if (boneNames.length > 512 || boneNames.some((name) => typeof name !== "string" || !name || name.length > 120)) {
    fail("INVALID_WORKER_RESULT", "rig bone names are invalid", 502);
  }
  const reportedBoneCount = finiteMetric(metrics.boneCount, "rig.metrics.boneCount", { integer: true });
  const reportedJointCount = finiteMetric(metrics.jointCount, "rig.metrics.jointCount", { integer: true });
  const reportedTriangles = finiteMetric(metrics.triangleCount, "rig.metrics.triangleCount", { integer: true });
  const outputBoneNames = new Set(outputInspection?.boneNames || []);
  if (!outputInspection?.hasSkinnedMesh || outputInspection.jointCount !== reportedJointCount
    || reportedBoneCount !== boneNames.length || reportedJointCount !== boneNames.length
    || boneNames.some((name) => !outputBoneNames.has(name)) || outputBoneNames.size !== boneNames.length
    || outputInspection.triangleCount !== reportedTriangles) {
    fail("RIG_OUTPUT_MISMATCH", "reported rig metrics do not match the exported GLB skin, joints, or triangles", 502);
  }
  const result = {
    contractVersion: 1,
    jobUuid: request.jobUuid,
    attemptUuid: request.attemptUuid,
    sourceSha256: request.source.sha256,
    output: { glbBase64: outputBuffer.toString("base64"), sha256: sha256(outputBuffer), sizeBytes: outputBuffer.length },
    rig: {
      validatorVersion: RIG_PIPELINE_VALIDATOR_VERSION,
      metrics: {
        boneCount: reportedBoneCount,
        skinnedVertexCount: finiteMetric(metrics.skinnedVertexCount, "rig.metrics.skinnedVertexCount", { integer: true }),
        maxInfluences: finiteMetric(metrics.maxInfluences, "rig.metrics.maxInfluences", { integer: true }),
        unweightedIslands: finiteMetric(metrics.unweightedIslands, "rig.metrics.unweightedIslands", { integer: true }),
        bindMatrixValid: metrics.bindMatrixValid === true,
        animationSweepPass: metrics.animationSweepPass === true,
        silhouetteDeviation: finiteMetric(metrics.silhouetteDeviation, "rig.metrics.silhouetteDeviation"),
        triangleCount: reportedTriangles,
        textureMaxDimension: finiteMetric(metrics.textureMaxDimension, "rig.metrics.textureMaxDimension", { integer: true }),
        jointCount: reportedJointCount,
        boneNames,
      },
      rules,
      overallPass,
    },
    facial: { capability: facialValue.capability, targets, canonicalMap, hasBlink, hasJaw, hasEyeControls, rules: facialRules },
    renders: normalizeRenders(value.renders, facialValue.capability),
    accessories: normalizeAccessories(value.accessories || [], request),
    ...normalizeFusedPrint(value.fusedPrint, value.fusedPrintFailure, request, outputBuffer, fusedPrintBuffer, fusedInspection),
    warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 100).map((warning) => boundedText(warning, "worker warning", 1000)) : [],
  };
  return result;
}

export function createBlenderPipelineRunner({ bridge, pipelineDirectory = __dirname } = {}) {
  if (!bridge || typeof bridge.executeCode !== "function") throw new TypeError("bridge.executeCode is required");
  return async ({ request, sourceBuffer, accessoryBuffers, profile }) => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "paws-rig-pipeline-"));
    const inputPath = path.join(tempDirectory, "source.glb");
    const outputPath = path.join(tempDirectory, "output.glb");
    const fusedPrintPath = path.join(tempDirectory, "fused-print.glb");
    const configPath = path.join(tempDirectory, "config.json");
    const resultPath = path.join(tempDirectory, "result.json");
    try {
      fs.writeFileSync(inputPath, sourceBuffer, { mode: 0o600 });
      const accessoryPaths = accessoryBuffers.map((entry, index) => {
        const accessoryPath = path.join(tempDirectory, `accessory-${index}.glb`);
        fs.writeFileSync(accessoryPath, entry.buffer, { mode: 0o600 });
        return { accessoryUuid: entry.request.accessoryUuid, attachmentBone: entry.request.attachmentBone, path: accessoryPath };
      });
      fs.writeFileSync(configPath, JSON.stringify({ request, profile, accessoryPaths }), { mode: 0o600 });
      const script = [
        "import sys",
        `sys.path.insert(0, ${JSON.stringify(pipelineDirectory)})`,
        "from pipeline import run_pipeline",
        `run_pipeline(${JSON.stringify(inputPath)}, ${JSON.stringify(outputPath)}, ${JSON.stringify(fusedPrintPath)}, ${JSON.stringify(configPath)}, ${JSON.stringify(resultPath)})`,
        "print('RIG_PIPELINE_COMPLETE')",
      ].join("\n");
      const response = await bridge.executeCode(script);
      if (!response?.success) fail("BLENDER_PIPELINE_FAILED", boundedText(response?.error, "Blender pipeline failed", 500), 502);
      if (!fs.existsSync(resultPath) || fs.statSync(resultPath).size > 45 * 1024 * 1024) {
        fail("INVALID_WORKER_RESULT", "Blender pipeline wrote no bounded result", 502);
      }
      const raw = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      if (raw.failure) return { raw, outputBuffer: Buffer.alloc(0), fusedPrintBuffer: null };
      if (!fs.existsSync(outputPath)) fail("INVALID_WORKER_RESULT", "Blender pipeline wrote no GLB", 502);
      return {
        raw,
        outputBuffer: fs.readFileSync(outputPath),
        fusedPrintBuffer: fs.existsSync(fusedPrintPath) ? fs.readFileSync(fusedPrintPath) : null,
      };
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  };
}

export function createRigPipelineProcessor(options = {}) {
  const profileDirectory = options.profileDirectory || path.resolve(__dirname, "..", "profiles");
  const acquireAsset = options.acquireAsset || ((asset) => acquireVerifiedAsset(asset, {
    downloadOptions: options.downloadOptions,
    sharedJobsDirectory: options.sharedJobsDirectory,
  }));
  if (typeof options.runner !== "function") throw new TypeError("runner is required");
  const cache = new Map();
  const maxCacheEntries = options.maxCacheEntries || 128;

  async function execute(request) {
    const profile = loadProfile(request.profileId, request.classification, profileDirectory);
    const sourceBuffer = await acquireAsset(request.source);
    if (!Buffer.isBuffer(sourceBuffer) || sourceBuffer.length !== request.source.sizeBytes || sha256(sourceBuffer) !== request.source.sha256) {
      fail("SOURCE_HASH_MISMATCH", "source bytes do not match the signed request");
    }
    const sourceInspection = inspectGlb(sourceBuffer);
    const accessoryBuffers = [];
    let aggregateBytes = sourceBuffer.length;
    for (const accessory of request.accessories) {
      const buffer = await acquireAsset(accessory);
      if (!Buffer.isBuffer(buffer) || buffer.length !== accessory.sizeBytes || sha256(buffer) !== accessory.sha256) {
        fail("SOURCE_HASH_MISMATCH", `accessory ${accessory.accessoryUuid} does not match its signed request`);
      }
      inspectGlb(buffer);
      aggregateBytes += buffer.length;
      if (aggregateBytes > 200 * 1024 * 1024) fail("AGGREGATE_INPUT_TOO_LARGE", "combined rig inputs exceed the worker memory budget", 413);
      accessoryBuffers.push({ request: accessory, buffer });
    }
    const { raw, outputBuffer, fusedPrintBuffer = null } = await options.runner({ request, sourceBuffer, accessoryBuffers, profile });
    if (raw?.failure) return normalizePipelineResult(raw, request, outputBuffer, sourceInspection, null, null, null);
    if (!Buffer.isBuffer(outputBuffer) || outputBuffer.length <= 0 || outputBuffer.length > RIG_PIPELINE_MAX_ASSET_BYTES) {
      fail("OUTPUT_BUDGET_EXCEEDED", "output GLB is missing or exceeds 100 MB", 502);
    }
    const outputInspection = inspectGlb(outputBuffer);
    const fusedInspection = fusedPrintBuffer ? inspectGlb(fusedPrintBuffer) : null;
    return normalizePipelineResult(raw, request, outputBuffer, sourceInspection, outputInspection, fusedPrintBuffer, fusedInspection);
  }

  return {
    async process(input) {
      if (Buffer.byteLength(JSON.stringify(input ?? null)) > RIG_PIPELINE_MAX_REQUEST_BYTES) {
        fail("REQUEST_TOO_LARGE", "rig pipeline request is too large", 413);
      }
      const request = validateRigPipelineRequest(input);
      const fingerprint = requestFingerprint(request);
      const cached = cache.get(request.idempotencyKey);
      if (cached) {
        if (cached.fingerprint !== fingerprint) fail("IDEMPOTENCY_CONFLICT", "idempotency key was reused with another request", 409);
        return cached.promise;
      }
      const promise = execute(request);
      cache.set(request.idempotencyKey, { fingerprint, promise });
      while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
      try {
        return await promise;
      } catch (error) {
        if (cache.get(request.idempotencyKey)?.promise === promise) cache.delete(request.idempotencyKey);
        throw error;
      }
    },
    clearCache() {
      cache.clear();
    },
  };
}

export function createWorkerAuthMiddleware(options = {}) {
  return function workerAuth(req, res, next) {
    const expected = options.secret ?? process.env.WORKER_SHARED_SECRET ?? "";
    if (typeof expected !== "string" || expected.length < 16) {
      return res.status(503).json({ error: "Worker authentication is not configured", code: "WORKER_AUTH_NOT_CONFIGURED" });
    }
    const provided = req.get("x-worker-secret") || "";
    const expectedBytes = Buffer.from(expected);
    const providedBytes = Buffer.from(provided);
    if (expectedBytes.length !== providedBytes.length || !crypto.timingSafeEqual(expectedBytes, providedBytes)) {
      return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
    }
    return next();
  };
}

export function createRigPipelineHandler(processor) {
  return async function rigPipelineHandler(req, res) {
    try {
      res.status(200).json(await processor.process(req.body));
    } catch (error) {
      if (error instanceof RigPipelineError) return res.status(error.status).json({ error: error.message, code: error.code });
      console.error("[rig-pipeline] unhandled worker error", error?.message || error);
      return res.status(500).json({ error: "Internal rig pipeline error", code: "INTERNAL_ERROR" });
    }
  };
}
