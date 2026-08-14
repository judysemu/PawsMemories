import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import net from "node:net";
import { z } from "zod";
import { assertExternalGenerativeProviderAllowed } from "../externalGenerativePolicy";

export const FAL_VEO_ENDPOINT = "fal-ai/veo3.1/fast/image-to-video" as const;
export const FAL_KLING_ENDPOINT = "fal-ai/kling-video/v3/pro/image-to-video" as const;
export type FalVideoEndpoint = typeof FAL_VEO_ENDPOINT | typeof FAL_KLING_ENDPOINT;
export type FurReelDuration = 8 | 15;

const TRUSTED_OUTPUT_SUFFIX = ".fal.media";

export class FalVideoError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "FAL_VIDEO_NOT_CONFIGURED"
      | "FAL_VIDEO_SUBMISSION_FAILED"
      | "FAL_VIDEO_TIMEOUT"
      | "FAL_VIDEO_PROVIDER_FAILED"
      | "FAL_VIDEO_OUTPUT_INVALID"
      | "FAL_VIDEO_DOWNLOAD_BLOCKED",
  ) {
    super(message);
    this.name = "FalVideoError";
  }
}

export interface FalVideoQueue {
  submit(endpoint: string, options: { input: Record<string, unknown> }): Promise<{ request_id?: unknown }>;
  status(endpoint: string, options: { requestId: string; logs: false }): Promise<{ status?: unknown; error?: unknown }>;
  result(endpoint: string, options: { requestId: string }): Promise<{ data?: unknown }>;
}

const FalVideoResultSchema = z.object({
  video: z.object({ url: z.string().url() }).passthrough(),
}).passthrough();

function buildVeoInput(input: { imageUrl: string; prompt: string; aspectRatio: "16:9" | "9:16" }): Record<string, unknown> {
  return {
    prompt: input.prompt,
    image_url: input.imageUrl,
    duration: "8s",
    aspect_ratio: input.aspectRatio,
    resolution: "720p",
    generate_audio: true,
  };
}

function buildKlingInput(input: { imageUrl: string; prompt: string }): Record<string, unknown> {
  // Kling has no aspect_ratio param — it infers framing from the source image.
  return {
    start_image_url: input.imageUrl,
    prompt: input.prompt,
    duration: "15",
    generate_audio: true,
  };
}

function endpointForDuration(durationSeconds: FurReelDuration): FalVideoEndpoint {
  return durationSeconds === 15 ? FAL_KLING_ENDPOINT : FAL_VEO_ENDPOINT;
}

function buildInput(
  endpoint: FalVideoEndpoint,
  input: { imageUrl: string; prompt: string; aspectRatio: "16:9" | "9:16" },
): Record<string, unknown> {
  return endpoint === FAL_KLING_ENDPOINT ? buildKlingInput(input) : buildVeoInput(input);
}

function safeRequestId(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(value)) {
    throw new FalVideoError("fal.ai did not return a valid request ID", "FAL_VIDEO_SUBMISSION_FAILED");
  }
  return value;
}

async function createOfficialQueue(apiKey: string): Promise<FalVideoQueue> {
  const moduleName = "@fal-ai/client";
  const imported = await import(moduleName) as { fal?: any };
  if (!imported.fal?.queue) {
    throw new FalVideoError("fal.ai client is unavailable", "FAL_VIDEO_NOT_CONFIGURED");
  }
  imported.fal.config({ credentials: apiKey });
  return imported.fal.queue as FalVideoQueue;
}

async function resolveQueue(options: { apiKey?: string; queue?: FalVideoQueue }): Promise<FalVideoQueue> {
  if (options.queue) return options.queue;
  const apiKey = String(options.apiKey ?? process.env.FAL_KEY ?? "").trim();
  if (!apiKey) {
    throw new FalVideoError("FAL_KEY is not configured", "FAL_VIDEO_NOT_CONFIGURED");
  }
  return createOfficialQueue(apiKey);
}

/** True if the raw address is a private/loopback/link-local/multicast IP. */
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
    throw new FalVideoError("fal.ai returned an invalid output URL", "FAL_VIDEO_OUTPUT_INVALID");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (host !== "fal.media" && !host.endsWith(TRUSTED_OUTPUT_SUFFIX))) {
    throw new FalVideoError("fal.ai returned an untrusted output URL", "FAL_VIDEO_OUTPUT_INVALID");
  }
  if (parsed.username || parsed.password || parsed.port) {
    throw new FalVideoError("fal.ai returned a malformed output URL", "FAL_VIDEO_OUTPUT_INVALID");
  }
  return parsed;
}

/**
 * Resolves the URL's host and rejects private/loopback/link-local addresses,
 * guarding against a compromised or malicious provider response pointing the
 * app's own download step at an internal address (SSRF).
 */
export async function assertResolvesToPublicHost(
  url: URL,
  resolveHost: (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]> = dns.lookup as any,
): Promise<void> {
  let addresses: LookupAddress[];
  try {
    addresses = await resolveHost(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new FalVideoError("fal.ai output host could not be resolved", "FAL_VIDEO_DOWNLOAD_BLOCKED");
  }
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new FalVideoError("fal.ai output host resolved to a blocked address", "FAL_VIDEO_DOWNLOAD_BLOCKED");
  }
}

export async function submitFalVideo(
  input: { imageUrl: string; prompt: string; durationSeconds: FurReelDuration; aspectRatio: "16:9" | "9:16" },
  options: { apiKey?: string; queue?: FalVideoQueue } = {},
): Promise<{ requestId: string; endpoint: FalVideoEndpoint }> {
  assertExternalGenerativeProviderAllowed("fal");
  const endpoint = endpointForDuration(input.durationSeconds);
  const queue = await resolveQueue(options);
  let submitted: { request_id?: unknown };
  try {
    // Do not auto-retry: a transport failure may still have accepted a paid
    // request, and this route already owns credit-refund semantics on error.
    submitted = await queue.submit(endpoint, { input: buildInput(endpoint, input) });
  } catch {
    throw new FalVideoError("fal.ai video submission failed", "FAL_VIDEO_SUBMISSION_FAILED");
  }
  return { requestId: safeRequestId(submitted.request_id), endpoint };
}

export async function pollFalVideo(
  endpoint: string,
  requestId: string,
  options: { apiKey?: string; queue?: FalVideoQueue } = {},
): Promise<{ done: boolean; videoUrl?: URL; error?: string }> {
  const queue = await resolveQueue(options);
  let status;
  try {
    status = await queue.status(endpoint, { requestId, logs: false });
  } catch {
    throw new FalVideoError("fal.ai status check failed", "FAL_VIDEO_PROVIDER_FAILED");
  }
  const state = String(status?.status || "").toUpperCase();
  if (["IN_QUEUE", "IN_PROGRESS", "QUEUED", ""].includes(state)) {
    return { done: false };
  }
  if (["FAILED", "CANCELLED", "ERROR"].includes(state)) {
    return { done: true, error: String(status?.error || "fal.ai video generation failed") };
  }
  if (state !== "COMPLETED") {
    throw new FalVideoError("fal.ai returned an unknown status", "FAL_VIDEO_PROVIDER_FAILED");
  }
  let rawResult: unknown;
  try {
    rawResult = (await queue.result(endpoint, { requestId })).data;
  } catch {
    throw new FalVideoError("fal.ai result fetch failed", "FAL_VIDEO_PROVIDER_FAILED");
  }
  const parsed = FalVideoResultSchema.safeParse(rawResult);
  if (!parsed.success) {
    throw new FalVideoError("fal.ai output did not match its schema", "FAL_VIDEO_OUTPUT_INVALID");
  }
  return { done: true, videoUrl: validateOutputUrl(parsed.data.video.url) };
}
