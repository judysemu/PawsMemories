/**
 * BiRefNet background removal via fal.ai.
 *
 * BiRefNet is MIT-licensed on both code and weights — the only high-quality
 * option evaluated that carries an explicit commercial grant on the weight
 * artifacts themselves. Hosted rather than self-hosted because at current
 * volume (~25 images/month) a container costs more in engineering than it
 * saves, and the same model can be self-hosted later behind this same
 * interface without a rewrite.
 *
 * Note: fal bills this endpoint per COMPUTE-SECOND, not per image. Cost per
 * image varies with resolution; measure rather than assume.
 */
import { assertExternalGenerativeProviderAllowed } from "../externalGenerativePolicy";
import { BackgroundRemovalError, type BackgroundRemovalProvider, type CutoutResult } from "./provider";

export const FAL_BIREFNET_ENDPOINT = "fal-ai/birefnet/v2" as const;

/** Only fal.media may serve a result we then download — the same SSRF boundary
 *  the video path enforces. A compromised response must not be able to point
 *  our own fetch at an internal address. */
const TRUSTED_OUTPUT_SUFFIX = ".fal.media";

export interface FalQueueLike {
  subscribe(endpoint: string, options: { input: Record<string, unknown> }): Promise<any>;
}

function assertTrustedUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BackgroundRemovalError("fal.ai returned an invalid output URL", "OUTPUT_INVALID");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (host !== "fal.media" && !host.endsWith(TRUSTED_OUTPUT_SUFFIX))) {
    throw new BackgroundRemovalError("fal.ai returned an untrusted output URL", "OUTPUT_INVALID");
  }
  if (parsed.username || parsed.password || parsed.port) {
    throw new BackgroundRemovalError("fal.ai returned a malformed output URL", "OUTPUT_INVALID");
  }
  return parsed;
}

export function createFalBirefnetProvider(options: { apiKey?: string; client?: FalQueueLike } = {}): BackgroundRemovalProvider {
  return {
    id: "fal-birefnet",
    async removeBackground(input): Promise<CutoutResult> {
      assertExternalGenerativeProviderAllowed("fal");
      const apiKey = String(options.apiKey ?? process.env.FAL_KEY ?? "").trim();
      if (!options.client && !apiKey) {
        throw new BackgroundRemovalError("FAL_KEY is not configured", "NOT_CONFIGURED");
      }

      let client = options.client;
      if (!client) {
        const imported = await import("@fal-ai/client") as { fal?: any };
        if (!imported.fal) throw new BackgroundRemovalError("fal.ai client is unavailable", "NOT_CONFIGURED");
        imported.fal.config({ credentials: apiKey });
        client = imported.fal as FalQueueLike;
      }

      let result: any;
      try {
        result = await client.subscribe(FAL_BIREFNET_ENDPOINT, {
          input: {
            image_url: `data:${input.mimeType};base64,${input.base64}`,
            // Soft alpha rather than a hard mask. Fur is the whole point: a
            // binary cutout on a printed canvas looks like a paper stencil.
            output_format: "png",
            refine_foreground: true,
          },
        });
      } catch (err: any) {
        throw new BackgroundRemovalError(`fal.ai background removal failed: ${err?.message || "unknown"}`, "PROVIDER_FAILED");
      }

      const imageUrl = result?.data?.image?.url || result?.image?.url;
      if (typeof imageUrl !== "string") {
        throw new BackgroundRemovalError("fal.ai returned no image", "OUTPUT_INVALID");
      }
      const url = assertTrustedUrl(imageUrl);

      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        throw new BackgroundRemovalError(`Could not download the cutout (${response.status})`, "PROVIDER_FAILED");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw new BackgroundRemovalError("fal.ai returned an empty image", "OUTPUT_INVALID");

      // Re-encode to WebP-with-alpha. Measured: WebP carries alpha at roughly a
      // 24th of PNG's size for the same image, which keeps the payload inside
      // the existing 1 MB limit on /api/pawprints/generate-subject.
      const sharp = (await import("sharp")).default;
      const image = sharp(bytes, { failOn: "error", limitInputPixels: 16_000_000 });
      const metadata = await image.metadata();
      const webp = await image.webp({ quality: 90, alphaQuality: 100 }).toBuffer();

      return {
        base64: webp.toString("base64"),
        mimeType: "image/webp",
        widthPx: metadata.width || 0,
        heightPx: metadata.height || 0,
      };
    },
  };
}
