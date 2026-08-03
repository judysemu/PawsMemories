import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { MAX_GLB_DOWNLOAD_BYTES, PROVIDER_CONNECT_TIMEOUT_MS, PROVIDER_READ_TIMEOUT_MS } from "./types";
import { startImageTo3D, pollImageTo3D, isTripoHandle, TripoError, type TripoJobInput } from "../../tripo";

// ─── Provider Port ──────────────────────────────────────────────────────────

export interface ModelBuildProviderInput {
  /** Public URLs or data URIs for the approved reference views. */
  frontUrl: string;
  leftUrl: string;
  rightUrl: string;
  rearUrl: string;
  threeQuarterUrl?: string;
  geometry?: {
    faceLimit?: number;
    texture?: boolean;
    pbr?: boolean;
    modelVersion?: string;
    smartLowPoly?: boolean;
    geometryQuality?: "standard" | "detailed";
  };
}

export interface ModelBuildProviderResult {
  providerTaskHandle: string;
  provider: string;
  model: string;
}

export interface ModelBuildPollResult {
  done: boolean;
  glbUrl?: string;
  error?: string;
  failureCode?: string;
  progress?: number;
  capability?: {
    riggable: boolean;
    rigType:
      | "biped" | "quadruped" | "hexapod" | "octopod"
      | "avian" | "serpentine" | "aquatic" | null;
  };
}

export type ProviderSubmissionDisposition =
  | "definitive_rejection"
  | "safe_retry"
  | "ambiguous_acceptance";

export class ModelBuildProviderError extends Error {
  constructor(
    message: string,
    public code: string,
    public retryable: boolean,
    public submissionDisposition: ProviderSubmissionDisposition = retryable
      ? "safe_retry"
      : "definitive_rejection",
  ) {
    super(message);
    this.name = "ModelBuildProviderError";
  }
}

function normalizeTripoError(error: unknown, fallbackCode: string): ModelBuildProviderError {
  if (!(error instanceof TripoError)) {
    return new ModelBuildProviderError("Provider operation failed", fallbackCode, false);
  }
  if (error.submissionDisposition === "ambiguous_acceptance") {
    return new ModelBuildProviderError(
      "Provider submission outcome is unknown",
      "PROVIDER_SUBMISSION_AMBIGUOUS",
      false,
      "ambiguous_acceptance",
    );
  }
  if (error.status === 429 || error.code === 2000) {
    return new ModelBuildProviderError(
      "Provider operation was rate limited",
      "PROVIDER_RATE_LIMITED",
      true,
      "safe_retry",
    );
  }
  if (error.status === 401 || error.status === 403) {
    return new ModelBuildProviderError("Provider authentication failed", "PROVIDER_AUTH_FAILED", false);
  }
  if (error.status === 404) {
    return new ModelBuildProviderError("Provider task was not found", "PROVIDER_TASK_NOT_FOUND", false);
  }
  return new ModelBuildProviderError("Provider operation failed", fallbackCode, false);
}

export interface ModelBuildProvider {
  /** Submit a new generation task using approved reference views. */
  start(input: ModelBuildProviderInput, configHash: string): Promise<ModelBuildProviderResult>;
  /** Poll the task status. */
  poll(taskHandle: string): Promise<ModelBuildPollResult>;
  /** Download the generated GLB bytes with security checks. */
  download(glbUrl: string): Promise<Buffer>;
}

// ─── SSRF Protection ────────────────────────────────────────────────────────

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "api.tripo3d.ai",
  "tripo-data.cdn.bcebos.com",
  "cdn.tripo3d.ai",
  // Tripo's regional signed-download host observed in production output.
  // Keep this exact: allowing the parent tripo3d.com domain would broaden the
  // SSRF boundary to unrelated provider-controlled subdomains.
  "tripo-data.rg1.data.tripo3d.com",
]);

function isAllowedUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    // Check exact match or subdomain of allowed hosts
    for (const allowed of ALLOWED_DOWNLOAD_HOSTS) {
      if (host === allowed || host.endsWith(`.${allowed}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isPrivateIp(hostname: string): boolean {
  // Block obvious private ranges and localhost
  const patterns = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^0\./,
    /^169\.254\./,
    /^\[::1\]$/,
    /^\[fe80:/i,
    /^\[fc/i,
    /^\[fd/i,
  ];
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (patterns.some(p => p.test(hostname))) return true;
  if (net.isIP(normalized) === 6) {
    return normalized === "::1" || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.");
  }
  return false;
}

async function assertPublicDns(hostname: string): Promise<void> {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Blocked: download host resolves to a private address");
  }
}

// ─── Tripo Adapter ──────────────────────────────────────────────────────────

export class TripoModelBuildAdapter implements ModelBuildProvider {
  async start(input: ModelBuildProviderInput, _configHash: string): Promise<ModelBuildProviderResult> {
    // Tripo's canonical multiview contract is [FRONT, LEFT, BACK, RIGHT].
    const tripoInput: TripoJobInput = {
      imageUrl: input.frontUrl,
      views: {
        left: input.leftUrl,
        back: input.rearUrl,
        right: input.rightUrl,
      },
      geometry: input.geometry,
    };

    let taskHandle: string;
    try {
      taskHandle = await startImageTo3D(tripoInput);
    } catch (error) {
      throw normalizeTripoError(error, "PROVIDER_SUBMISSION_FAILED");
    }

    return {
      providerTaskHandle: taskHandle,
      provider: "tripo",
      model: input.geometry?.modelVersion || process.env.TRIPO_MODEL_VERSION || "default",
    };
  }

  async poll(taskHandle: string): Promise<ModelBuildPollResult> {
    if (!isTripoHandle(taskHandle)) {
      throw new Error(`Invalid Tripo handle: ${taskHandle?.slice(0, 20)}`);
    }
    let result;
    try {
      result = await pollImageTo3D(taskHandle);
    } catch (error) {
      throw normalizeTripoError(error, "PROVIDER_POLL_FAILED");
    }
    return {
      done: result.done,
      glbUrl: result.glbUrl,
      error: result.error,
      failureCode: result.failureCode,
      progress: result.progress,
      capability: result.capability,
    };
  }

  async download(glbUrl: string): Promise<Buffer> {
    if (!isAllowedUrl(glbUrl)) {
      throw new Error(`Blocked download URL: host not in allowlist`);
    }

    try {
      const parsed = new URL(glbUrl);
      if (isPrivateIp(parsed.hostname)) {
        throw new Error("Blocked: URL resolves to private address");
      }
      await assertPublicDns(parsed.hostname);
    } catch (err: any) {
      if (err.message.includes("Blocked")) throw err;
      throw new Error(`Invalid download URL`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_READ_TIMEOUT_MS);

    try {
      const res = await fetch(glbUrl, {
        signal: controller.signal,
        redirect: "error", // No redirects — prevent SSRF via redirect
      });

      if (!res.ok) {
        throw new Error(`Download failed: HTTP ${res.status}`);
      }

      // Validate content type
      const contentType = res.headers.get("content-type") || "";
      const validMimeTypes = ["model/gltf-binary", "application/octet-stream", "binary/octet-stream"];
      if (!validMimeTypes.some(m => contentType.includes(m))) {
        // Tripo may not always set the right content type, so check magic bytes instead
        // Don't fail here - we'll validate magic bytes after download
      }

      // Stream with byte limit
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.length;
        if (totalBytes > MAX_GLB_DOWNLOAD_BYTES) {
          reader.cancel();
          throw new Error(`Download exceeds maximum size: ${MAX_GLB_DOWNLOAD_BYTES} bytes`);
        }
        chunks.push(Buffer.from(value));
      }

      const buffer = Buffer.concat(chunks);

      // Validate GLB magic bytes
      if (buffer.length < 12) {
        throw new Error("Downloaded file too small to be a valid GLB");
      }
      const magic = buffer.readUInt32LE(0);
      if (magic !== 0x46546C67) {
        throw new Error(`Downloaded file is not a GLB (magic: 0x${magic.toString(16)})`);
      }
      if (buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) {
        throw new Error("Downloaded GLB header length or version is invalid");
      }

      return buffer;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─── Fake Provider (Tests) ──────────────────────────────────────────────────

/**
 * Minimal valid GLB for testing. Contains one scene, one node, one mesh with
 * a triangle, and one material. 464 bytes.
 */
function createMinimalGlb(): Buffer {
  const gltfJson = JSON.stringify({
    asset: { version: "2.0", generator: "pawsome3d-fake" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0 },
        material: 0,
      }],
    }],
    accessors: [{
      bufferView: 0,
      componentType: 5126, // FLOAT
      count: 3,
      type: "VEC3",
      max: [1, 1, 0],
      min: [0, 0, 0],
    }],
    bufferViews: [{
      buffer: 0,
      byteOffset: 0,
      byteLength: 36,
    }],
    buffers: [{ byteLength: 36 }],
    materials: [{ name: "default" }],
  });

  // Position data: 3 vertices forming a triangle
  const positionData = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ]);

  // Pad JSON to 4-byte alignment
  const jsonBytes = Buffer.from(gltfJson);
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)]);

  // Binary data
  const binData = Buffer.from(positionData.buffer);
  const binPadding = (4 - (binData.length % 4)) % 4;
  const paddedBin = Buffer.concat([binData, Buffer.alloc(binPadding, 0x00)]);

  // GLB header (12 bytes) + JSON chunk header (8 bytes) + JSON + BIN chunk header (8 bytes) + BIN
  const totalLength = 12 + 8 + paddedJson.length + 8 + paddedBin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546C67, 0);  // magic "glTF"
  header.writeUInt32LE(2, 4);            // version 2
  header.writeUInt32LE(totalLength, 8);  // total length

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(paddedJson.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4); // "JSON"

  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(paddedBin.length, 0);
  binChunkHeader.writeUInt32LE(0x004E4942, 4);  // "BIN\0"

  return Buffer.concat([header, jsonChunkHeader, paddedJson, binChunkHeader, paddedBin]);
}

export class FakeModelBuildProvider implements ModelBuildProvider {
  public startCalls = 0;
  public pollCalls = 0;
  public downloadCalls = 0;
  public shouldFail = false;
  public failAtPoll = false;
  public pollsUntilDone = 2;
  private _pollCount = 0;

  async start(_input: ModelBuildProviderInput, _configHash: string): Promise<ModelBuildProviderResult> {
    this.startCalls++;
    if (this.shouldFail) {
      throw new Error("Fake provider: simulated start failure");
    }
    return {
      providerTaskHandle: `fake:${crypto.randomUUID()}`,
      provider: "fake",
      model: "fake-v1",
    };
  }

  async poll(_taskHandle: string): Promise<ModelBuildPollResult> {
    this.pollCalls++;
    this._pollCount++;
    if (this.failAtPoll) {
      return { done: true, error: "Fake provider: simulated poll failure" };
    }
    if (this._pollCount >= this.pollsUntilDone) {
      return { done: true, glbUrl: "https://api.tripo3d.ai/fake/output.glb", progress: 100 };
    }
    return { done: false, progress: Math.min(90, this._pollCount * 30) };
  }

  async download(_glbUrl: string): Promise<Buffer> {
    this.downloadCalls++;
    return createMinimalGlb();
  }

  reset(): void {
    this.startCalls = 0;
    this.pollCalls = 0;
    this.downloadCalls = 0;
    this.shouldFail = false;
    this.failAtPoll = false;
    this.pollsUntilDone = 2;
    this._pollCount = 0;
  }
}

export { createMinimalGlb };
