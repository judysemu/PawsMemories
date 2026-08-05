#!/usr/bin/env node
/**
 * Bounded, customer-billing-free acceptance harness for the private in-house 3D lane.
 *
 * It canonicalizes one local pet image without a network call, drives only the
 * authenticated private TRELLIS worker API, validates the PBR base, runs the
 * local rig-capability gate, starts in-house Blender finalization, and validates
 * the final rigged idle/walk GLB. No customer order, database, credit, Tripo,
 * fal, Hugging Face, or public artifact endpoint is touched.
 *
 * Usage:
 *   TRELLIS_WORKER_URL=http://10.x.x.x:8000 \
 *   TRELLIS_WORKER_SHARED_SECRET=... \
 *   npm run accept:inhouse-e2e -- --input pet.jpg --output accepted.glb \
 *     [--report acceptance.json] [--mesh-profile smart_mesh]
 */
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { selectedPaws3dProvider } from "../server/model-builds/configuredProvider.ts";
import { TrellisModelBuildAdapter } from "../server/model-builds/trellisProvider.ts";
import { isInHouseOnly } from "../server/externalGenerativePolicy.ts";
import { InHousePetGenerationAdapter } from "../server/pet-generation/inHouseAdapter.ts";
import { InMemoryJobStore } from "../server/pet-generation/provider.ts";
import { validatePetGlbStage } from "../server/pet-generation/validation.ts";
import {
  selectedReferenceImageProvider,
  UploadedFrontReferenceImageProvider,
} from "../server/reference-sessions/provider.ts";

const DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const JOB_PATH = "/v1/jobs/:jobId";

export class InHouseE2EError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InHouseE2EError";
    this.code = code;
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new InHouseE2EError("INPUT_IMAGE_INVALID", "Input must be a real PNG, JPEG, or WebP image");
}

function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost") return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10
      || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  return isIP(host) === 6 && (host === "::1" || host.startsWith("fc") || host.startsWith("fd"));
}

function normalizedWorkerPath(pathname) {
  return pathname.replace(
    /^\/v1\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    JOB_PATH,
  );
}

function allowedWorkerOperation(method, pathname) {
  const normalized = normalizedWorkerPath(pathname);
  return (method === "GET" && normalized === "/readyz")
    || (method === "POST" && normalized === "/v1/jobs")
    || (method === "GET" && normalized === JOB_PATH)
    || (method === "GET" && normalized === `${JOB_PATH}/artifact`)
    || (method === "POST" && normalized === `${JOB_PATH}/finalize`)
    || (method === "GET" && normalized === `${JOB_PATH}/final-artifact`);
}

/**
 * Network choke point used by every worker call. It permits one private origin
 * and the six audited worker operations above; redirects and query strings are
 * rejected. Evidence contains method/path only—never hostnames or credentials.
 */
export function createPrivateWorkerBoundary(workerUrl, downstreamFetch = globalThis.fetch) {
  let worker;
  try {
    worker = new URL(workerUrl);
  } catch {
    throw new InHouseE2EError("PRIVATE_WORKER_URL_INVALID", "Private worker URL is invalid");
  }
  if (!isPrivateHost(worker.hostname)
    || !["http:", "https:"].includes(worker.protocol)
    || worker.username
    || worker.password
    || (worker.pathname !== "/" && worker.pathname !== "")
    || worker.search
    || worker.hash) {
    throw new InHouseE2EError(
      "PRIVATE_WORKER_REQUIRED",
      "Acceptance requires a direct private or loopback worker origin with no URL credentials",
    );
  }
  if (typeof downstreamFetch !== "function") {
    throw new InHouseE2EError("FETCH_UNAVAILABLE", "A worker HTTP client is unavailable");
  }

  const evidence = { totalCalls: 0, externalCalls: 0, blockedAttempts: 0, operations: [] };
  const guardedFetch = async (input, init = {}) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = String(init.method || (typeof input === "object" && "method" in input ? input.method : "GET") || "GET").toUpperCase();
    if (target.origin !== worker.origin || target.search || target.hash) {
      evidence.blockedAttempts += 1;
      throw new InHouseE2EError("EXTERNAL_NETWORK_BOUNDARY", "A call attempted to leave the approved private worker origin");
    }
    if (!allowedWorkerOperation(method, target.pathname)) {
      evidence.blockedAttempts += 1;
      throw new InHouseE2EError("WORKER_ROUTE_BOUNDARY", "A call attempted an unapproved private worker operation");
    }
    evidence.totalCalls += 1;
    evidence.operations.push({ method, path: normalizedWorkerPath(target.pathname) });
    return downstreamFetch(target, { ...init, redirect: "error" });
  };
  return { fetch: guardedFetch, evidence };
}

function safeFailure(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error || "Acceptance failed");
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join("[redacted]");
  message = message
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/(token|secret|authorization)=?[^\s,]*/gi, "$1=[redacted]")
    .slice(0, 300);
  return {
    code: typeof error?.code === "string" ? error.code : "INHOUSE_E2E_FAILED",
    message,
  };
}

async function waitForJob(adapter, jobId, label, options) {
  const deadline = Date.now() + options.timeoutMs;
  let polls = 0;
  while (Date.now() <= deadline) {
    const job = await adapter.getJob(jobId);
    polls += 1;
    if (job.status === "completed") return { job, polls };
    if (job.status === "failed" || job.status === "cancelled") {
      throw new InHouseE2EError(job.reason || `${label.toUpperCase()}_FAILED`, `${label} failed inside the private worker`);
    }
    if (Date.now() >= deadline) break;
    await options.sleep(options.pollIntervalMs);
  }
  throw new InHouseE2EError(`${label.toUpperCase()}_TIMEOUT`, `${label} did not finish inside the bounded acceptance window`);
}

function reportStep(report, name, status, detail, startedAt) {
  report.steps.push({
    name,
    status,
    detail,
    durationMs: Math.max(0, Date.now() - startedAt),
  });
}

async function runStep(report, name, operation, secrets) {
  const startedAt = Date.now();
  try {
    const result = await operation();
    reportStep(report, name, "PASS", result.detail, startedAt);
    return result.value;
  } catch (error) {
    reportStep(report, name, "FAIL", safeFailure(error, secrets).message, startedAt);
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runInHouseE2E(options) {
  const startedAt = new Date();
  const report = {
    schemaVersion: "pawsome.inhouse-e2e.v1",
    status: "FAIL",
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: 0,
    input: null,
    output: null,
    network: { totalCalls: 0, externalCalls: 0, blockedAttempts: 0, operations: [] },
    steps: [],
    failure: null,
  };
  const inputPath = String(options?.inputPath || "").trim();
  const outputPath = String(options?.outputPath || "").trim();
  const reportPath = String(options?.reportPath || "").trim();
  const workerUrl = String(options?.workerUrl || process.env.TRELLIS_WORKER_URL || "").trim();
  const sharedSecret = String(options?.sharedSecret || process.env.TRELLIS_WORKER_SHARED_SECRET || "").trim();
  const meshProfile = options?.meshProfile === "hd" ? "hd" : "smart_mesh";
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = Number.isFinite(options?.pollIntervalMs) ? Number(options.pollIntervalMs) : DEFAULT_POLL_INTERVAL_MS;
  const sleep = options?.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const secrets = [sharedSecret, workerUrl];
  let boundary = null;
  let reportTargetApproved = false;

  try {
    await runStep(report, "configuration", async () => {
      if (!inputPath || !outputPath) throw new InHouseE2EError("PATH_REQUIRED", "Both input and output paths are required");
      if (!workerUrl || !sharedSecret) throw new InHouseE2EError("PRIVATE_WORKER_CONFIG_REQUIRED", "Private worker URL and secret are required");
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3 * 60 * 60 * 1000) {
        throw new InHouseE2EError("TIMEOUT_INVALID", "Timeout must be greater than zero and no more than three hours");
      }
      if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 30_000) {
        throw new InHouseE2EError("POLL_INTERVAL_INVALID", "Poll interval must be between zero and 30000 milliseconds");
      }
      if (path.resolve(inputPath) === path.resolve(outputPath)
        || (reportPath && (
          path.resolve(reportPath) === path.resolve(inputPath)
          || path.resolve(reportPath) === path.resolve(outputPath)
        ))) {
        throw new InHouseE2EError("OUTPUT_PATH_CONFLICT", "Input, output, and report targets must be distinct");
      }
      if (!options?.overwrite && await pathExists(outputPath)) {
        throw new InHouseE2EError("OUTPUT_EXISTS", "Output already exists; choose another path or explicitly allow overwrite");
      }
      if (!options?.overwrite && reportPath && await pathExists(reportPath)) {
        throw new InHouseE2EError("REPORT_EXISTS", "Report already exists; choose another path or explicitly allow overwrite");
      }
      reportTargetApproved = Boolean(reportPath);
      const strictEnv = {
        ...process.env,
        PAWS_3D_INHOUSE_ONLY: "true",
        PAWS_3D_PROVIDER: "trellis2",
        PAWS_REFERENCE_PROVIDER: "uploaded_front",
        PAWS_3D_EXTERNAL_PROVIDER_IDS: "tripo,fal",
      };
      if (!isInHouseOnly(strictEnv)
        || selectedPaws3dProvider(strictEnv) !== "trellis2"
        || selectedReferenceImageProvider(strictEnv) !== "uploaded_front") {
        throw new InHouseE2EError("INHOUSE_SELECTION_FAILED", "Strict in-house provider selection did not close correctly");
      }
      const lock = JSON.parse(await readFile(
        new URL("../infra/azure/models/trellis2.lock.json", import.meta.url),
        "utf8",
      ));
      const approvedSourceRevision = String(lock?.source?.revision || "");
      const approvedModelRevision = String(
        lock?.models?.find((entry) => entry?.repoId === "microsoft/TRELLIS.2-4B")?.revision || "",
      );
      if (!/^[0-9a-f]{40}$/.test(approvedSourceRevision)
        || !/^[0-9a-f]{40}$/.test(approvedModelRevision)
        || String(process.env.TRELLIS_SOURCE_REVISION || approvedSourceRevision) !== approvedSourceRevision
        || String(process.env.TRELLIS_MODEL_REVISION || approvedModelRevision) !== approvedModelRevision) {
        throw new InHouseE2EError("TRELLIS_LOCK_MISMATCH", "Configured TRELLIS revisions do not match the committed model lock");
      }
      boundary = createPrivateWorkerBoundary(workerUrl, options?.fetchImpl || globalThis.fetch);
      return { value: null, detail: "strict TRELLIS + uploaded-front lane selected from committed lock; no customer billing or database path" };
    }, secrets);

    const input = await runStep(report, "local_reference", async () => {
      const source = await readFile(inputPath);
      if (!source.length || source.length > MAX_INPUT_BYTES) {
        throw new InHouseE2EError("INPUT_SIZE_INVALID", `Input must be between 1 byte and ${MAX_INPUT_BYTES} bytes`);
      }
      const mimeType = imageMime(source);
      const prepared = await new UploadedFrontReferenceImageProvider().generateMultiview({
        photoBuffer: source,
        photoMimeType: mimeType,
      }, "photo");
      if (prepared.provider !== "uploaded_front"
        || prepared.views.length !== 1
        || prepared.views[0].viewKind !== "front"
        || prepared.views[0].isSynthesized) {
        throw new InHouseE2EError("REFERENCE_BOUNDARY_FAILED", "Reference preparation did not preserve a truthful local front-only view");
      }
      report.input = { bytes: source.length, mimeType, sha256: sha256(source) };
      return { value: prepared.views[0], detail: "one real image canonicalized locally; zero synthesized views" };
    }, secrets);

    const provider = new TrellisModelBuildAdapter({
      baseUrl: workerUrl,
      sharedSecret,
      fetchImpl: boundary.fetch,
      referenceHosts: [],
    });
    await runStep(report, "private_worker_readiness", async () => {
      await provider.preflightForCharge();
      return { value: null, detail: "CUDA, locked model, and locked source revision ready" };
    }, secrets);

    const adapter = new InHousePetGenerationAdapter(
      provider,
      new InMemoryJobStore(),
      process.env.TRELLIS_MODEL_REVISION,
      provider,
    );
    const baseJob = await runStep(report, "trellis_generation", async () => {
      const created = await adapter.createBaseJob({
        frontUrl: `data:${input.mimeType};base64,${input.imageBuffer.toString("base64")}`,
        meshProfile,
        subjectProfile: "pet",
      });
      const completed = await waitForJob(adapter, created.id, "trellis_generation", {
        timeoutMs, pollIntervalMs, sleep,
      });
      return { value: created, detail: `private TRELLIS job completed after ${completed.polls} poll(s)` };
    }, secrets);

    const baseArtifacts = await runStep(report, "pbr_base_validation", async () => {
      const artifacts = await adapter.fetchArtifacts(baseJob.id);
      if (artifacts.metadata.providerId !== "trellis2") {
        throw new InHouseE2EError("EXTERNAL_PROVIDER_RESULT", "Base artifact did not identify the in-house TRELLIS provider");
      }
      const validation = validatePetGlbStage(artifacts.glb.data, {
        stage: "base",
        meshProfile,
        requireTexture: true,
      });
      if (!validation.operatorReady) {
        throw new InHouseE2EError("PBR_BASE_VALIDATION_FAILED", `PBR base failed: ${validation.reasonCodes.join(", ") || "critical gate"}`);
      }
      return {
        value: artifacts,
        detail: `PBR GLB verified (${validation.triangleCount || 0} triangles, ${artifacts.glb.size} bytes)`,
      };
    }, secrets);

    await runStep(report, "local_rig_capability", async () => {
      const check = await adapter.createRigCheckJob(baseJob.id);
      const checked = await adapter.getJob(check.id);
      if (checked.status !== "completed" || !checked.capability?.riggable || checked.capability.rigType !== "quadruped") {
        throw new InHouseE2EError("RIG_CAPABILITY_FAILED", "Local base inspection did not approve quadruped rigging");
      }
      return { value: null, detail: "base GLB passed local quadruped capability gates without Blender work" };
    }, secrets);

    const finalArtifacts = await runStep(report, "inhouse_rig_animation", async () => {
      const created = await adapter.createRigJob(baseJob.id, "pet");
      const completed = await waitForJob(adapter, created.id, "inhouse_finalization", {
        timeoutMs, pollIntervalMs, sleep,
      });
      const artifacts = await adapter.fetchArtifacts(created.id);
      if (artifacts.metadata.providerId !== "trellis2"
        || artifacts.metadata.animated !== true
        || !Array.isArray(artifacts.metadata.animations)
        || !artifacts.metadata.animations.includes("idle")
        || !artifacts.metadata.animations.includes("walk")) {
        throw new InHouseE2EError("FINALIZATION_METADATA_INVALID", "Final artifact metadata does not prove in-house idle and walk animation");
      }
      return { value: artifacts, detail: `in-house Blender rig + idle/walk completed after ${completed.polls} poll(s)` };
    }, secrets);

    await runStep(report, "final_glb_validation", async () => {
      const validation = validatePetGlbStage(finalArtifacts.glb.data, {
        stage: "rig",
        meshProfile,
        requireTexture: true,
      });
      if (!validation.operatorReady) {
        throw new InHouseE2EError("FINAL_GLB_VALIDATION_FAILED", `Final GLB failed: ${validation.reasonCodes.join(", ") || "critical gate"}`);
      }
      if (finalArtifacts.glb.sha256 === baseArtifacts.glb.sha256) {
        throw new InHouseE2EError("FINAL_ARTIFACT_UNCHANGED", "Final rigged artifact is byte-identical to the unrigged base");
      }
      return { value: null, detail: `PBR, skin, weights, idle, walk, animation targets, and embedded buffers verified` };
    }, secrets);

    await runStep(report, "network_boundary", async () => {
      if (!boundary || boundary.evidence.externalCalls !== 0 || boundary.evidence.blockedAttempts !== 0) {
        throw new InHouseE2EError("NETWORK_BOUNDARY_FAILED", "Acceptance observed a call outside the approved private API contract");
      }
      return { value: null, detail: `${boundary.evidence.totalCalls} authenticated private worker call(s); zero external calls` };
    }, secrets);

    await runStep(report, "final_output", async () => {
      await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
      await writeFile(outputPath, finalArtifacts.glb.data, {
        flag: options?.overwrite ? "w" : "wx",
        mode: 0o600,
      });
      report.output = {
        bytes: finalArtifacts.glb.size,
        sha256: finalArtifacts.glb.sha256,
        fileName: path.basename(outputPath),
      };
      return { value: null, detail: "verified final GLB written with owner-only permissions" };
    }, secrets);

    report.status = "PASS";
  } catch (error) {
    report.failure = safeFailure(error, secrets);
  } finally {
    if (boundary) report.network = {
      totalCalls: boundary.evidence.totalCalls,
      externalCalls: boundary.evidence.externalCalls,
      blockedAttempts: boundary.evidence.blockedAttempts,
      operations: [...boundary.evidence.operations],
    };
    const finishedAt = new Date();
    report.finishedAt = finishedAt.toISOString();
    report.durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    if (reportTargetApproved) {
      try {
        await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
          flag: options?.overwrite ? "w" : "wx",
          mode: 0o600,
        });
      } catch (error) {
        report.status = "FAIL";
        report.failure = safeFailure(new InHouseE2EError("REPORT_WRITE_FAILED", "Acceptance report could not be written"), secrets);
      }
    }
  }
  return report;
}

export function printInHouseE2EReport(report, stream = process.stdout) {
  stream.write(`IN-HOUSE E2E ${report.status}\n`);
  for (const step of report.steps) stream.write(`${step.status}  ${step.name} - ${step.detail}\n`);
  stream.write(`NETWORK  private=${report.network.totalCalls} external=${report.network.externalCalls} blocked=${report.network.blockedAttempts}\n`);
  if (report.output) stream.write(`OUTPUT  ${report.output.fileName} ${report.output.bytes} bytes sha256=${report.output.sha256}\n`);
  if (report.failure) stream.write(`FAILURE  ${report.failure.code} - ${report.failure.message}\n`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      output: { type: "string" },
      report: { type: "string" },
      "mesh-profile": { type: "string", default: "smart_mesh" },
      "poll-ms": { type: "string", default: String(DEFAULT_POLL_INTERVAL_MS) },
      "timeout-minutes": { type: "string", default: "90" },
      overwrite: { type: "boolean", default: false },
    },
    strict: true,
  });
  const meshProfile = values["mesh-profile"];
  if (!values.input || !values.output || !["hd", "smart_mesh"].includes(meshProfile)) {
    console.error("Usage: npm run accept:inhouse-e2e -- --input <pet.png> --output <final.glb> [--report <report.json>] [--mesh-profile smart_mesh|hd]");
    process.exitCode = 2;
    return;
  }
  const report = await runInHouseE2E({
    inputPath: values.input,
    outputPath: values.output,
    reportPath: values.report,
    meshProfile,
    pollIntervalMs: Number(values["poll-ms"]),
    timeoutMs: Number(values["timeout-minutes"]) * 60_000,
    overwrite: values.overwrite,
  });
  printInHouseE2EReport(report);
  process.exitCode = report.status === "PASS" ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
