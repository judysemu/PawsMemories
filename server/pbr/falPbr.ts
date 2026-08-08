import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import sharp from "sharp";
import { z } from "zod";
import { WARDROBE_PBR_MAP_KINDS, type WardrobePbrMapKind } from "../../shared/wardrobePbrCatalog";
import { assertExternalGenerativeProviderAllowed } from "../externalGenerativePolicy";

export const FAL_PBR_ENDPOINT = "fal-ai/patina/material" as const;
export const FAL_PBR_MAP_KINDS = WARDROBE_PBR_MAP_KINDS;
export type FalPbrMapKind = WardrobePbrMapKind;

const MAX_MAP_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_DIMENSION = 1024;
const TRUSTED_OUTPUT_SUFFIX = ".fal.media";
const TRUSTED_OUTPUT_SUFFIX_AZURE = ".azurecontainerapps.io";

const InputSchema = z.object({
  prompt: z.string().trim().min(24).max(600),
  seed: z.number().int().min(0).max(2_147_483_647),
}).strict();

const FalImageSchema = z.object({
  url: z.string().url(),
  map_type: z.string().optional(),
  content_type: z.string().optional(),
}).passthrough();

const FalResultSchema = z.object({
  images: z.array(FalImageSchema).min(1).max(12),
  seed: z.number().int().optional(),
  prompt: z.string().optional(),
}).passthrough();

export class FalPbrError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "FAL_PBR_INPUT_INVALID"
      | "FAL_PBR_NOT_CONFIGURED"
      | "FAL_PBR_SUBMISSION_FAILED"
      | "FAL_PBR_TIMEOUT"
      | "FAL_PBR_PROVIDER_FAILED"
      | "FAL_PBR_OUTPUT_INVALID"
      | "FAL_PBR_DOWNLOAD_BLOCKED"
      | "FAL_PBR_DOWNLOAD_FAILED",
  ) {
    super(message);
    this.name = "FalPbrError";
  }
}

export interface FalPbrQueue {
  submit(endpoint: string, options: { input: Record<string, unknown> }): Promise<{ request_id?: unknown }>;
  status(endpoint: string, options: { requestId: string; logs: false }): Promise<{ status?: unknown; error?: unknown }>;
  result(endpoint: string, options: { requestId: string }): Promise<{ data?: unknown }>;
}

export interface GeneratedFalPbrMap {
  kind: FalPbrMapKind;
  bytes: Buffer;
  sha256: string;
  mimeType: "image/png";
  width: number;
  height: number;
}

export interface GeneratedFalPbrMaterial {
  provider: "fal-ai";
  model: typeof FAL_PBR_ENDPOINT;
  requestId: string;
  seed: number;
  requestedPrompt: string;
  providerPrompt: string | null;
  maps: Record<FalPbrMapKind, GeneratedFalPbrMap>;
}

export function normalizeFalPbrInput(input: { prompt: string; seed: number }) {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    throw new FalPbrError("PBR material prompt or seed is invalid", "FAL_PBR_INPUT_INVALID");
  }
  return {
    prompt: parsed.data.prompt,
    image_size: { width: DEFAULT_DIMENSION, height: DEFAULT_DIMENSION },
    num_inference_steps: 8,
    num_images: 1,
    enable_prompt_expansion: false,
    enable_safety_checker: true,
    tiling_mode: "both" as const,
    tile_size: 128,
    tile_stride: 64,
    maps: [...FAL_PBR_MAP_KINDS],
    seed: parsed.data.seed,
    output_format: "png" as const,
  };
}

function isPrivateIp(raw: string): boolean {
  const address = raw.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      octets[0] >= 224;
  }
  if (net.isIP(address) === 6) {
    return address === "::" || address === "::1" || address.startsWith("fc") ||
      address.startsWith("fd") || /^fe[89ab]/.test(address) ||
      address.startsWith("::ffff:127.") || address.startsWith("::ffff:10.") ||
      address.startsWith("::ffff:192.168.");
  }
  return true;
}

function validateOutputUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new FalPbrError("PBR provider returned an invalid output URL", "FAL_PBR_OUTPUT_INVALID");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (host !== "fal.media" && !host.endsWith(TRUSTED_OUTPUT_SUFFIX) && !host.endsWith(TRUSTED_OUTPUT_SUFFIX_AZURE))) {
    throw new FalPbrError("PBR provider returned an untrusted output URL", "FAL_PBR_OUTPUT_INVALID");
  }
  if (parsed.username || parsed.password || parsed.port) {
    throw new FalPbrError("PBR provider returned a malformed output URL", "FAL_PBR_OUTPUT_INVALID");
  }
  return parsed;
}

function collectMapUrls(rawResult: unknown): {
  seed: number | undefined;
  providerPrompt: string | null;
  urls: Record<FalPbrMapKind, URL>;
} {
  const parsed = FalResultSchema.safeParse(rawResult);
  if (!parsed.success) {
    throw new FalPbrError("PBR provider output did not match its schema", "FAL_PBR_OUTPUT_INVALID");
  }

  const selected = new Map<FalPbrMapKind, URL>();
  for (const image of parsed.data.images) {
    if (!FAL_PBR_MAP_KINDS.includes(image.map_type as FalPbrMapKind)) continue;
    const kind = image.map_type as FalPbrMapKind;
    if (selected.has(kind)) {
      throw new FalPbrError("PBR provider returned duplicate maps", "FAL_PBR_OUTPUT_INVALID");
    }
    if (image.content_type && image.content_type !== "image/png") {
      throw new FalPbrError("PBR provider returned an unexpected map type", "FAL_PBR_OUTPUT_INVALID");
    }
    selected.set(kind, validateOutputUrl(image.url));
  }

  if (selected.size !== FAL_PBR_MAP_KINDS.length || FAL_PBR_MAP_KINDS.some((kind) => !selected.has(kind))) {
    throw new FalPbrError("PBR provider returned an incomplete map set", "FAL_PBR_OUTPUT_INVALID");
  }

  return {
    seed: parsed.data.seed,
    providerPrompt: parsed.data.prompt || null,
    urls: Object.fromEntries(FAL_PBR_MAP_KINDS.map((kind) => [kind, selected.get(kind)!])) as Record<FalPbrMapKind, URL>,
  };
}

async function downloadMap(
  kind: FalPbrMapKind,
  url: URL,
  options: {
    fetchImpl: typeof fetch;
    resolveHost: typeof dns.lookup;
    expectedDimension: number;
  },
): Promise<GeneratedFalPbrMap> {
  let addresses: Awaited<ReturnType<typeof dns.lookup>>;
  try {
    addresses = await options.resolveHost(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new FalPbrError("PBR output host could not be resolved", "FAL_PBR_DOWNLOAD_BLOCKED");
  }
  const addressList = Array.isArray(addresses) ? addresses : [addresses];
  if (!addressList.length || addressList.some((entry) => isPrivateIp(entry.address))) {
    throw new FalPbrError("PBR output host resolved to a blocked address", "FAL_PBR_DOWNLOAD_BLOCKED");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await options.fetchImpl(url, { signal: controller.signal, redirect: "error" });
  } catch {
    throw new FalPbrError("PBR map download failed", "FAL_PBR_DOWNLOAD_FAILED");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new FalPbrError("PBR map download failed", "FAL_PBR_DOWNLOAD_FAILED");
  }
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > MAX_MAP_BYTES) {
    throw new FalPbrError("PBR map exceeded the size limit", "FAL_PBR_OUTPUT_INVALID");
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_MAP_BYTES || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new FalPbrError("PBR map was not a bounded PNG", "FAL_PBR_OUTPUT_INVALID");
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(bytes, { limitInputPixels: options.expectedDimension ** 2 }).metadata();
  } catch {
    throw new FalPbrError("PBR map could not be decoded", "FAL_PBR_OUTPUT_INVALID");
  }
  if (metadata.format !== "png" || metadata.width !== options.expectedDimension || metadata.height !== options.expectedDimension) {
    throw new FalPbrError("PBR map dimensions were unexpected", "FAL_PBR_OUTPUT_INVALID");
  }

  return {
    kind,
    bytes,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    mimeType: "image/png",
    width: metadata.width,
    height: metadata.height,
  };
}

function safeRequestId(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(value)) {
    throw new FalPbrError("PBR provider did not return a valid request ID", "FAL_PBR_SUBMISSION_FAILED");
  }
  return value;
}

async function createOfficialQueue(apiKey: string): Promise<FalPbrQueue> {
  const moduleName = "@fal-ai/client";
  const imported = await import(moduleName) as { fal?: any };
  if (!imported.fal?.queue) {
    throw new FalPbrError("fal.ai client is unavailable", "FAL_PBR_NOT_CONFIGURED");
  }
  imported.fal.config({ credentials: apiKey });
  return imported.fal.queue as FalPbrQueue;
}

export async function generateFalPbrMaterial(
  input: { prompt: string; seed: number },
  options: {
    apiKey?: string;
    queue?: FalPbrQueue;
    fetchImpl?: typeof fetch;
    resolveHost?: typeof dns.lookup;
    timeoutMs?: number;
    pollIntervalMs?: number;
    expectedDimension?: number;
  } = {},
): Promise<GeneratedFalPbrMaterial> {
  assertExternalGenerativeProviderAllowed("fal");
  const normalized = normalizeFalPbrInput(input);

  let resolvedQueue: FalPbrQueue;
  if (options.queue) {
    // Pre-built queue (e.g. Azure Container Apps adapter) — no FAL_KEY needed.
    resolvedQueue = options.queue;
  } else {
    const apiKey = String(options.apiKey ?? process.env.FAL_KEY ?? "").trim();
    if (!apiKey) {
      throw new FalPbrError("FAL_KEY is not configured", "FAL_PBR_NOT_CONFIGURED");
    }
    resolvedQueue = await createOfficialQueue(apiKey);
  }
  let submitted: { request_id?: unknown };
  try {
    // Do not auto-retry submit: a transport failure may still have accepted a
    // paid request. The authoring operator must reconcile it explicitly.
    submitted = await resolvedQueue.submit(FAL_PBR_ENDPOINT, { input: normalized });
  } catch {
    throw new FalPbrError("PBR request submission failed", "FAL_PBR_SUBMISSION_FAILED");
  }
  const requestId = safeRequestId(submitted.request_id);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;

  let rawResult: unknown;
  while (Date.now() <= deadline) {
    let status;
    try {
      status = await resolvedQueue.status(FAL_PBR_ENDPOINT, { requestId, logs: false });
    } catch {
      throw new FalPbrError("PBR request status failed", "FAL_PBR_PROVIDER_FAILED");
    }
    const state = String(status?.status || "").toUpperCase();
    if (state === "COMPLETED") {
      try {
        rawResult = (await resolvedQueue.result(FAL_PBR_ENDPOINT, { requestId })).data;
      } catch {
        throw new FalPbrError("PBR request result failed", "FAL_PBR_PROVIDER_FAILED");
      }
      break;
    }
    if (["FAILED", "CANCELLED", "ERROR"].includes(state)) {
      throw new FalPbrError("PBR provider did not complete the material", "FAL_PBR_PROVIDER_FAILED");
    }
    if (!["IN_QUEUE", "IN_PROGRESS", "QUEUED", ""].includes(state)) {
      throw new FalPbrError("PBR provider returned an unknown status", "FAL_PBR_PROVIDER_FAILED");
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, pollIntervalMs)));
  }
  if (rawResult === undefined) {
    throw new FalPbrError("PBR request timed out", "FAL_PBR_TIMEOUT");
  }

  const collected = collectMapUrls(rawResult);
  const fetchImpl = options.fetchImpl || fetch;
  const resolveHost = options.resolveHost || dns.lookup;
  const expectedDimension = options.expectedDimension ?? DEFAULT_DIMENSION;
  const entries = await Promise.all(FAL_PBR_MAP_KINDS.map(async (kind) => [
    kind,
    await downloadMap(kind, collected.urls[kind], { fetchImpl, resolveHost, expectedDimension }),
  ] as const));

  return {
    provider: "fal-ai",
    model: FAL_PBR_ENDPOINT,
    requestId,
    seed: collected.seed ?? normalized.seed,
    requestedPrompt: normalized.prompt,
    providerPrompt: collected.providerPrompt,
    maps: Object.fromEntries(entries) as Record<FalPbrMapKind, GeneratedFalPbrMap>,
  };
}
