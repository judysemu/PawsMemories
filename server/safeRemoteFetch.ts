export interface BoundedRemoteFetchOptions {
  allowedOrigins: readonly string[];
  maxBytes: number;
  timeoutMs: number;
  allowedContentTypes?: readonly string[];
  allowHttpForTests?: boolean;
}

export interface BoundedRemoteFetchResult {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
}

function normalizedOrigin(value: string): string {
  const url = new URL(value);
  return url.origin;
}

function contentTypeAllowed(contentType: string, allowed: readonly string[] | undefined): boolean {
  if (!allowed?.length) return true;
  const normalized = contentType.split(";", 1)[0].trim().toLowerCase();
  return allowed.some((candidate) => {
    const expected = candidate.toLowerCase();
    return expected.endsWith("/*")
      ? normalized.startsWith(expected.slice(0, -1))
      : normalized === expected;
  });
}

/**
 * Fetch one exact-origin HTTPS resource with redirects disabled and a streaming
 * byte ceiling. This is intentionally not a general URL proxy.
 */
export async function fetchBoundedRemoteBuffer(
  rawUrl: string,
  options: BoundedRemoteFetchOptions,
): Promise<BoundedRemoteFetchResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error("A positive remote-fetch size limit is required.");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 120_000) {
    throw new Error("A bounded remote-fetch timeout is required.");
  }
  const url = new URL(rawUrl);
  if (url.username || url.password) throw new Error("Remote URL credentials are not allowed.");
  if (url.protocol !== "https:" && !(options.allowHttpForTests && url.protocol === "http:")) {
    throw new Error("Remote URLs must use HTTPS.");
  }
  const allowedOrigins = new Set(options.allowedOrigins.map(normalizedOrigin));
  if (!allowedOrigins.has(url.origin)) throw new Error("Remote URL origin is not allowed.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/octet-stream,*/*;q=0.8" },
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Remote redirects are not allowed.");
    }
    if (!response.ok) throw new Error(`Remote fetch failed (${response.status}).`);
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    if (!contentTypeAllowed(contentType, options.allowedContentTypes)) {
      throw new Error("Remote content type is not allowed.");
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      throw new Error("Remote response exceeds the size limit.");
    }
    if (!response.body) throw new Error("Remote response had no body.");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Remote response exceeds the size limit.");
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return { buffer: Buffer.concat(chunks, received), contentType, finalUrl: url.toString() };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Remote fetch timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
