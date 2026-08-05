import crypto from "node:crypto";
import net from "node:net";
import {
  ModelBuildProviderError,
  type ModelBuildPollResult,
  type ModelBuildProvider,
  type ModelBuildProviderInput,
  type ModelBuildProviderResult,
} from "./provider";
import {
  MAX_GLB_DOWNLOAD_BYTES,
  PROVIDER_CONNECT_TIMEOUT_MS,
  PROVIDER_READ_TIMEOUT_MS,
} from "./types";
import type { ModelArtifactFinalizer, ModelFinalizationPollResult } from "./finalizer";

const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_PREFIX = "trellis2:";
const ARTIFACT_PREFIX = "trellis2-artifact:";
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type FetchImplementation = typeof fetch;

export interface TrellisModelBuildAdapterOptions {
  baseUrl?: string;
  sharedSecret?: string;
  fetchImpl?: FetchImplementation;
  referenceHosts?: Iterable<string>;
  selectReference?: (input: ModelBuildProviderInput) => string;
}

interface WorkerJobResponse {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress?: number;
  error?: string | null;
  artifact?: { url: string; sha256: string; bytes: number } | null;
  finalization?: {
    status: "not_requested" | "queued" | "running" | "succeeded" | "failed";
    progress?: number;
    error?: string | null;
    clips?: string[];
    artifact?: { url: string; sha256: string; bytes: number } | null;
  };
}

function privateIpv4(hostname: string): boolean {
  if (net.isIP(hostname) !== 4) return false;
  const [a, b] = hostname.split(".").map(Number);
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function privateIpv6(hostname: string): boolean {
  if (net.isIP(hostname) !== 6) return false;
  const normalized = hostname.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd");
}

function normalizedHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function configuredReferenceHosts(explicit?: Iterable<string>): Set<string> {
  const values = explicit
    ? [...explicit]
    : String(process.env.PAWS_REFERENCE_DOWNLOAD_HOSTS || "").split(",");
  const mediaHost = normalizedHost(String(process.env.MEDIA_BUCKET_URL || ""));
  const result = new Set(values.map(normalizedHost).filter(Boolean));
  if (mediaHost) result.add(mediaHost);
  return result;
}

function requirePrivateWorkerUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ModelBuildProviderError("TRELLIS worker URL is invalid", "TRELLIS_CONFIG_INVALID", false);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new ModelBuildProviderError("TRELLIS worker URL is invalid", "TRELLIS_CONFIG_INVALID", false);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const explicitlyAllowed = String(process.env.TRELLIS_WORKER_ALLOWED_HOSTS || "")
    .split(",")
    .map(normalizedHost)
    .filter(Boolean)
    .includes(host.toLowerCase());
  if (!privateIpv4(host) && !privateIpv6(host) && !explicitlyAllowed) {
    throw new ModelBuildProviderError(
      "TRELLIS worker must use a private address or an explicitly allowed internal host",
      "TRELLIS_CONFIG_PUBLIC_ENDPOINT",
      false,
    );
  }
  return parsed;
}

function requireJobId(reference: string, prefix: string): string {
  if (!reference.startsWith(prefix)) {
    throw new ModelBuildProviderError("TRELLIS task reference is invalid", "TRELLIS_TASK_INVALID", false);
  }
  const id = reference.slice(prefix.length);
  if (!JOB_ID_PATTERN.test(id)) {
    throw new ModelBuildProviderError("TRELLIS task reference is invalid", "TRELLIS_TASK_INVALID", false);
  }
  return id;
}

async function readLimited(response: Response, maximumBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ModelBuildProviderError("Worker response exceeds the byte limit", "TRELLIS_RESPONSE_TOO_LARGE", false);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ModelBuildProviderError("Worker returned no response body", "TRELLIS_RESPONSE_INVALID", false);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ModelBuildProviderError("Worker response exceeds the byte limit", "TRELLIS_RESPONSE_TOO_LARGE", false);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function imageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function parseDataImage(raw: string): { bytes: Buffer; mimeType: string } | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/i.exec(raw);
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  const mimeType = match[1].toLowerCase();
  if (bytes.length === 0 || bytes.length > MAX_REFERENCE_BYTES || imageType(bytes) !== mimeType) {
    throw new ModelBuildProviderError("Approved reference image is invalid", "TRELLIS_REFERENCE_INVALID", false);
  }
  return { bytes, mimeType };
}

export class TrellisModelBuildAdapter implements ModelBuildProvider, ModelArtifactFinalizer {
  private readonly workerUrl: URL;
  private readonly sharedSecret: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly referenceHosts: Set<string>;
  private readonly selectReference: (input: ModelBuildProviderInput) => string;

  constructor(options: TrellisModelBuildAdapterOptions = {}) {
    const rawUrl = options.baseUrl || process.env.TRELLIS_WORKER_URL || "";
    this.workerUrl = requirePrivateWorkerUrl(rawUrl);
    this.sharedSecret = (options.sharedSecret ?? process.env.TRELLIS_WORKER_SHARED_SECRET ?? "").trim();
    if (!this.sharedSecret) {
      throw new ModelBuildProviderError("TRELLIS worker secret is required", "TRELLIS_CONFIG_MISSING_SECRET", false);
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.referenceHosts = configuredReferenceHosts(options.referenceHosts);
    this.selectReference = options.selectReference ?? ((input) => {
      const view = String(process.env.TRELLIS_PRIMARY_REFERENCE_VIEW || "front").trim();
      const candidates: Record<string, string | undefined> = {
        front: input.frontUrl,
        left: input.leftUrl,
        right: input.rightUrl,
        rear: input.rearUrl,
        threeQuarter: input.threeQuarterUrl,
      };
      return candidates[view] || input.frontUrl;
    });
  }

  async start(input: ModelBuildProviderInput, configHash: string): Promise<ModelBuildProviderResult> {
    const reference = await this.loadReference(this.selectReference(input));
    const form = new FormData();
    form.set("image", new Blob([reference.bytes], { type: reference.mimeType }), "approved-reference");
    form.set("pipeline_type", process.env.TRELLIS_PIPELINE_TYPE || "1024_cascade");
    const parsedSeed = Number.parseInt(configHash.slice(0, 8), 16);
    form.set("seed", String((Number.isFinite(parsedSeed) ? parsedSeed : 42) & 0x7fffffff));
    const requestedFaces = input.geometry?.faceLimit || 1_000_000;
    form.set("decimation_target", String(Math.max(10_000, Math.min(1_000_000, requestedFaces))));
    form.set("texture_size", input.geometry?.geometryQuality === "standard" ? "2048" : "4096");

    let response: Response;
    try {
      response = await this.fetchImpl(new URL("/v1/jobs", this.workerUrl), {
        method: "POST",
        headers: { "x-worker-secret": this.sharedSecret },
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_CONNECT_TIMEOUT_MS),
      });
    } catch {
      throw new ModelBuildProviderError(
        "TRELLIS submission outcome is unknown",
        "PROVIDER_SUBMISSION_AMBIGUOUS",
        false,
        "ambiguous_acceptance",
      );
    }
    const body = await this.readJson(response);
    if (response.status !== 202 || !JOB_ID_PATTERN.test(body.id || "")) {
      throw new ModelBuildProviderError("TRELLIS rejected the job", "PROVIDER_SUBMISSION_FAILED", response.status >= 500);
    }
    return {
      providerTaskHandle: `${TASK_PREFIX}${body.id}`,
      provider: "trellis2",
      model: `${process.env.TRELLIS_MODEL_ID || "microsoft/TRELLIS.2-4B"}@${process.env.TRELLIS_MODEL_REVISION || "af44b45f2e35a493886929c6d786e563ec68364d"}`,
    };
  }

  async poll(taskHandle: string): Promise<ModelBuildPollResult> {
    const id = requireJobId(taskHandle, TASK_PREFIX);
    const response = await this.workerFetch(`/v1/jobs/${id}`);
    const body = await this.readJson(response);
    if (!response.ok) {
      throw new ModelBuildProviderError("TRELLIS polling failed", "PROVIDER_POLL_FAILED", response.status >= 500);
    }
    if (body.id !== id || !["queued", "running", "succeeded", "failed"].includes(body.status)) {
      throw new ModelBuildProviderError("TRELLIS returned an invalid job status", "TRELLIS_RESPONSE_INVALID", false);
    }
    if (body.status === "failed") {
      return { done: true, error: "TRELLIS job failed", failureCode: "TRELLIS_JOB_FAILED", progress: body.progress };
    }
    if (body.status === "succeeded") {
      if (!body.artifact || !/^[0-9a-f]{64}$/i.test(body.artifact.sha256) || body.artifact.bytes <= 0) {
        throw new ModelBuildProviderError("TRELLIS artifact metadata is invalid", "TRELLIS_RESPONSE_INVALID", false);
      }
      return { done: true, glbUrl: `${ARTIFACT_PREFIX}${id}`, progress: 100 };
    }
    return { done: false, progress: Math.max(0, Math.min(99, Number(body.progress || 0))) };
  }

  async download(artifactReference: string): Promise<Buffer> {
    const id = requireJobId(artifactReference, ARTIFACT_PREFIX);
    return this.downloadWorkerArtifact(`/v1/jobs/${id}/artifact`);
  }

  async startFinalization(sourceTaskHandle: string): Promise<void> {
    const id = requireJobId(sourceTaskHandle, TASK_PREFIX);
    const response = await this.workerFetch(`/v1/jobs/${id}/finalize`, { method: "POST" }, PROVIDER_CONNECT_TIMEOUT_MS);
    const body = await this.readJson(response);
    if (![200, 202].includes(response.status) || body.id !== id || !["queued", "running", "succeeded"].includes(body.status)) {
      throw new ModelBuildProviderError(
        "TRELLIS finalization could not start",
        "TRELLIS_FINALIZATION_START_FAILED",
        response.status >= 500,
      );
    }
  }

  async pollFinalization(sourceTaskHandle: string): Promise<ModelFinalizationPollResult> {
    const id = requireJobId(sourceTaskHandle, TASK_PREFIX);
    const response = await this.workerFetch(`/v1/jobs/${id}`);
    const body = await this.readJson(response);
    if (!response.ok || body.id !== id || !body.finalization) {
      throw new ModelBuildProviderError(
        "TRELLIS finalization polling failed",
        "TRELLIS_FINALIZATION_POLL_FAILED",
        response.status >= 500,
      );
    }
    const finalization = body.finalization;
    if (!["not_requested", "queued", "running", "succeeded", "failed"].includes(finalization.status)) {
      throw new ModelBuildProviderError("TRELLIS returned an invalid finalization status", "TRELLIS_RESPONSE_INVALID", false);
    }
    if (finalization.status === "failed") {
      return { done: true, error: "In-house rig and animation failed", failureCode: "INHOUSE_FINALIZATION_FAILED" };
    }
    if (finalization.status === "succeeded") {
      if (!finalization.artifact
        || !/^[0-9a-f]{64}$/i.test(finalization.artifact.sha256)
        || !Number.isSafeInteger(finalization.artifact.bytes)
        || finalization.artifact.bytes <= 0
        || !Array.isArray(finalization.clips)
        || !finalization.clips.includes("idle")
        || !finalization.clips.includes("walk")) {
        throw new ModelBuildProviderError("TRELLIS final artifact metadata is invalid", "TRELLIS_RESPONSE_INVALID", false);
      }
      return { done: true, progress: 100 };
    }
    return { done: false, progress: Math.max(0, Math.min(99, Number(finalization.progress || 0))) };
  }

  async downloadFinal(sourceTaskHandle: string): Promise<Buffer> {
    const id = requireJobId(sourceTaskHandle, TASK_PREFIX);
    return this.downloadWorkerArtifact(`/v1/jobs/${id}/final-artifact`);
  }

  private async downloadWorkerArtifact(path: string): Promise<Buffer> {
    const response = await this.workerFetch(path);
    if (!response.ok) {
      throw new ModelBuildProviderError("TRELLIS artifact download failed", "PROVIDER_DOWNLOAD_FAILED", response.status >= 500);
    }
    const bytes = await readLimited(response, MAX_GLB_DOWNLOAD_BYTES);
    if (bytes.length < 12
      || bytes.readUInt32LE(0) !== 0x46546c67
      || bytes.readUInt32LE(4) !== 2
      || bytes.readUInt32LE(8) !== bytes.length) {
      throw new ModelBuildProviderError("TRELLIS artifact is not a valid GLB v2 file", "TRELLIS_ARTIFACT_INVALID", false);
    }
    const declaredHash = response.headers.get("x-artifact-sha256");
    const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (!declaredHash || !/^[0-9a-f]{64}$/i.test(declaredHash) || !crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(declaredHash.toLowerCase()))) {
      throw new ModelBuildProviderError("TRELLIS artifact integrity check failed", "TRELLIS_ARTIFACT_HASH_MISMATCH", false);
    }
    return bytes;
  }

  private async loadReference(raw: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const inline = parseDataImage(raw);
    if (inline) return inline;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ModelBuildProviderError("Approved reference URL is invalid", "TRELLIS_REFERENCE_INVALID", false);
    }
    if (parsed.protocol !== "https:" || !this.referenceHosts.has(parsed.hostname.toLowerCase())) {
      throw new ModelBuildProviderError("Approved reference host is not allowlisted", "TRELLIS_REFERENCE_HOST_BLOCKED", false);
    }
    const response = await this.fetchImpl(parsed, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new ModelBuildProviderError("Approved reference download failed", "TRELLIS_REFERENCE_DOWNLOAD_FAILED", response.status >= 500);
    }
    const bytes = await readLimited(response, MAX_REFERENCE_BYTES);
    const detected = imageType(bytes);
    const declared = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!detected || !ALLOWED_IMAGE_TYPES.has(declared) || detected !== declared) {
      throw new ModelBuildProviderError("Approved reference image is invalid", "TRELLIS_REFERENCE_INVALID", false);
    }
    return { bytes, mimeType: detected };
  }

  private async workerFetch(path: string, init: RequestInit = {}, timeoutMs = PROVIDER_READ_TIMEOUT_MS): Promise<Response> {
    try {
      return await this.fetchImpl(new URL(path, this.workerUrl), {
        ...init,
        headers: { "x-worker-secret": this.sharedSecret },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ModelBuildProviderError("TRELLIS worker is unavailable", "TRELLIS_WORKER_UNAVAILABLE", true);
    }
  }

  private async readJson(response: Response): Promise<WorkerJobResponse> {
    const bytes = await readLimited(response, 64 * 1024);
    try {
      return JSON.parse(bytes.toString("utf8")) as WorkerJobResponse;
    } catch {
      throw new ModelBuildProviderError("TRELLIS returned invalid JSON", "TRELLIS_RESPONSE_INVALID", false);
    }
  }
}
