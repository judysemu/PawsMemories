import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import type { GeneratedViewPayload, ProviderGenerationResult, ViewKind } from "./types";
import { ORDERED_VIEW_KINDS } from "./types";

export const MIN_REFERENCE_DIMENSION_PX = 1024;
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const REFERENCE_PROVIDER_TIMEOUT_MS = 120_000;
const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface ReferenceImageProvider {
  readonly name: string;
  readonly model: string;
  generateMultiview(
    input: { prompt?: string | null; photoBuffer?: Buffer | null; photoMimeType?: string | null; retryNotes?: string | null },
    inputMode: "text" | "photo",
  ): Promise<ProviderGenerationResult>;
}

export async function inspectReferenceImage(
  imageBuffer: Buffer,
  declaredMimeType: string,
  minimumDimensionPx = MIN_REFERENCE_DIMENSION_PX,
): Promise<{ mimeType: string; widthPx: number; heightPx: number }> {
  if (!ALLOWED_IMAGE_MIME.has(declaredMimeType)) throw new Error(`Unsupported reference image MIME type: ${declaredMimeType}`);
  if (imageBuffer.byteLength === 0 || imageBuffer.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`Reference image must be between 1 byte and ${MAX_REFERENCE_IMAGE_BYTES} bytes.`);
  }
  const metadata = await sharp(imageBuffer, { failOn: "error" }).metadata();
  const widthPx = Number(metadata.width || 0);
  const heightPx = Number(metadata.height || 0);
  const actualMime = metadata.format === "jpeg" ? "image/jpeg" : metadata.format === "png" ? "image/png" : metadata.format === "webp" ? "image/webp" : "";
  if (!actualMime || actualMime !== declaredMimeType) throw new Error("Reference image bytes do not match the declared MIME type.");
  if (widthPx < minimumDimensionPx || heightPx < minimumDimensionPx) {
    throw new Error(`Reference images must be at least ${minimumDimensionPx}x${minimumDimensionPx}px.`);
  }
  return { mimeType: actualMime, widthPx, heightPx };
}

/** Deterministic provider used only when explicitly injected by tests. */
export class FakeReferenceImageProvider implements ReferenceImageProvider {
  readonly name = "fake_gemini";
  readonly model = "fake-reference-provider-v1";
  calls = 0;

  async generateMultiview(
    _input: { prompt?: string | null; photoBuffer?: Buffer | null },
    inputMode: "text" | "photo",
  ): Promise<ProviderGenerationResult> {
    this.calls += 1;
    const imageBuffer = await sharp({
      create: { width: MIN_REFERENCE_DIMENSION_PX, height: MIN_REFERENCE_DIMENSION_PX, channels: 3, background: "#d6c7a8" },
    }).png().toBuffer();
    return {
      provider: this.name,
      model: this.model,
      views: ORDERED_VIEW_KINDS.map((viewKind) => ({
        viewKind,
        imageBuffer,
        mimeType: "image/png",
        widthPx: MIN_REFERENCE_DIMENSION_PX,
        heightPx: MIN_REFERENCE_DIMENSION_PX,
        isSynthesized: inputMode === "text" || viewKind !== "front",
      })),
    };
  }
}

const VIEW_INSTRUCTIONS: Record<ViewKind, string> = {
  front: "straight-on front view",
  left: "exact left profile view",
  right: "exact right profile view",
  rear: "straight-on rear view",
  front_three_quarter: "front three-quarter view",
};

export class GeminiReferenceImageProvider implements ReferenceImageProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly ai: GoogleGenAI | null;
  private inFlight = false;

  constructor(
    apiKey = process.env.GEMINI_API_KEY || "",
    model = process.env.GEMINI_REFERENCE_IMAGE_MODEL || "gemini-3.1-flash-image",
  ) {
    const configuredModel = model.trim();
    this.model = !configuredModel || /^gemini-2\./i.test(configuredModel)
      ? "gemini-3.1-flash-image"
      : configuredModel;
    this.ai = apiKey.trim() ? new GoogleGenAI({
      apiKey: apiKey.trim(),
      httpOptions: {
        headers: { "User-Agent": "pawsome3d-reference-builder" },
        timeout: REFERENCE_PROVIDER_TIMEOUT_MS,
        // Keep this explicit even though the installed SDK does not retry
        // without retryOptions. A future SDK/config change must not multiply
        // this workflow's five intentional angle calls.
        retryOptions: { attempts: 1 },
      },
    }) : null;
  }

  private async generateImage(parts: any[], label: string): Promise<{ imageBuffer: Buffer; mimeType: string; widthPx: number; heightPx: number; model: string }> {
    if (!this.ai) throw new Error("GEMINI_API_KEY is required for multiview reference generation.");
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts }],
      config: { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: "1:1" } },
    });
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (!part.inlineData?.data) continue;
      const mimeType = part.inlineData.mimeType || "image/png";
      const imageBuffer = Buffer.from(part.inlineData.data, "base64");
      const inspected = await inspectReferenceImage(imageBuffer, mimeType);
      return { imageBuffer, ...inspected, model: this.model };
    }
    throw new Error(`${label} returned no image output from the configured reference model.`);
  }

  async generateMultiview(
    input: { prompt?: string | null; photoBuffer?: Buffer | null; photoMimeType?: string | null; retryNotes?: string | null },
    inputMode: "text" | "photo",
  ): Promise<ProviderGenerationResult> {
    if (inputMode === "text" && !input.prompt?.trim()) throw new Error("A text prompt is required.");
    if (inputMode === "photo" && (!input.photoBuffer || !input.photoMimeType)) throw new Error("A source photo is required.");
    if (this.inFlight) throw new Error("Reference generation is already running. Please wait for it to finish.");
    this.inFlight = true;

    try {
      const sourceParts: any[] = [];
      if (input.photoBuffer && input.photoMimeType) {
        sourceParts.push({ inlineData: { data: input.photoBuffer.toString("base64"), mimeType: input.photoMimeType } });
      }
      const baseDescription = `${input.prompt?.trim() || "Preserve the exact identity, anatomy, markings, colors, proportions, and accessories of the supplied subject."} The supplied photo may be a four-photo contact sheet ordered top-left front, top-right left profile, bottom-left rear, bottom-right right profile; treat those four panels as separate observed angles of the same subject, not as a collage to reproduce.`;
      const retryClause = input.retryNotes?.trim() ? ` Requested correction: ${input.retryNotes.trim()}` : "";
      const front = await this.generateImage([
        ...sourceParts,
        { text: `${baseDescription}${retryClause} Create a clean, full-subject, centered ${VIEW_INSTRUCTIONS.front} on a neutral background for multi-view 3D reconstruction. Preserve identity exactly. No text, collage, props, crop, or perspective distortion.` },
      ], "front reference view");

      const views: GeneratedViewPayload[] = [{
        viewKind: "front",
        imageBuffer: front.imageBuffer,
        mimeType: front.mimeType,
        widthPx: front.widthPx,
        heightPx: front.heightPx,
        isSynthesized: true,
      }];
      const anchor = { inlineData: { data: front.imageBuffer.toString("base64"), mimeType: front.mimeType } };
      for (const viewKind of ORDERED_VIEW_KINDS.slice(1)) {
        const generated = await this.generateImage([
          anchor,
          { text: `Using the supplied front image as the immutable identity anchor, generate the same subject in an exact ${VIEW_INSTRUCTIONS[viewKind]}. Preserve anatomy, silhouette, markings, colors, face, accessories, scale, lighting, and neutral background. Full subject visible. No text or collage.` },
        ], `${viewKind} reference view`);
        views.push({ viewKind, imageBuffer: generated.imageBuffer, mimeType: generated.mimeType, widthPx: generated.widthPx, heightPx: generated.heightPx, isSynthesized: true });
      }
      return { provider: this.name, model: this.model, views };
    } finally {
      this.inFlight = false;
    }
  }
}
