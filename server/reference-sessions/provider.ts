import sharp from "sharp";
import {
  downloadTripoReferenceImage,
  pollTripoImageToMultiview,
  startTripoImageToMultiview,
} from "../../tripo";
import type { GeneratedViewPayload, ProviderGenerationResult, ViewKind } from "./types";
import { ORDERED_VIEW_KINDS } from "./types";
import { isInHouseOnly } from "../externalGenerativePolicy";

export const MIN_REFERENCE_DIMENSION_PX = 256;
export const CANONICAL_REFERENCE_DIMENSION_PX = 1024;
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const REFERENCE_PROVIDER_TIMEOUT_MS = 120_000;
const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface ReferenceGenerationInput {
  prompt?: string | null;
  photoBuffer?: Buffer | null;
  photoMimeType?: string | null;
  retryNotes?: string | null;
  onProviderTaskCreated?: (taskHandle: string) => Promise<void>;
}

export interface ReferenceImageProvider {
  readonly name: string;
  readonly model: string;
  /** Exact canonical view set this provider promises for every successful attempt. */
  readonly outputViewKinds: readonly ViewKind[];
  /** Optional upper bound used before source photos are combined or submitted. */
  readonly maxSourceImages?: number;
  generateMultiview(
    input: ReferenceGenerationInput,
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
  readonly name = "fake_tripo";
  readonly model = "fake-reference-provider-v1";
  readonly outputViewKinds = ORDERED_VIEW_KINDS;
  calls = 0;

  async generateMultiview(
    _input: { prompt?: string | null; photoBuffer?: Buffer | null },
    inputMode: "text" | "photo",
  ): Promise<ProviderGenerationResult> {
    this.calls += 1;
    const imageBuffer = await sharp({
      create: { width: CANONICAL_REFERENCE_DIMENSION_PX, height: CANONICAL_REFERENCE_DIMENSION_PX, channels: 3, background: "#d6c7a8" },
    }).png().toBuffer();
    return {
      provider: this.name,
      model: this.model,
      views: ORDERED_VIEW_KINDS.map((viewKind) => ({
        viewKind,
        imageBuffer,
        mimeType: "image/png",
        widthPx: CANONICAL_REFERENCE_DIMENSION_PX,
        heightPx: CANONICAL_REFERENCE_DIMENSION_PX,
        isSynthesized: inputMode === "text" || viewKind !== "front",
      })),
    };
  }
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function canonicalFrontImage(photoBuffer: Buffer): Promise<GeneratedViewPayload> {
  const imageBuffer = await sharp(photoBuffer, { failOn: "error", limitInputPixels: 40_000_000 })
    .rotate()
    .resize(CANONICAL_REFERENCE_DIMENSION_PX, CANONICAL_REFERENCE_DIMENSION_PX, {
      fit: "contain",
      background: "#ffffff",
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return {
    viewKind: "front",
    imageBuffer,
    mimeType: "image/png",
    widthPx: CANONICAL_REFERENCE_DIMENSION_PX,
    heightPx: CANONICAL_REFERENCE_DIMENSION_PX,
    isSynthesized: false,
  };
}

/**
 * Internal reference preparation for single-image TRELLIS builds.
 *
 * The customer's upload is decoded, orientation-corrected, padded, and encoded
 * as one immutable front reference. No side/rear views are inferred or copied,
 * so the resulting manifest remains truthful about the evidence supplied.
 */
export class UploadedFrontReferenceImageProvider implements ReferenceImageProvider {
  readonly name = "uploaded_front";
  readonly model = "canonical-front-v1";
  readonly outputViewKinds = ["front"] as const;
  readonly maxSourceImages = 1;

  async generateMultiview(
    input: ReferenceGenerationInput,
    inputMode: "text" | "photo",
  ): Promise<ProviderGenerationResult> {
    if (inputMode !== "photo") {
      throw new Error("The internal reference path requires one uploaded front photo.");
    }
    if (!input.photoBuffer || !input.photoMimeType) {
      throw new Error("A source front photo is required.");
    }
    await inspectReferenceImage(input.photoBuffer, input.photoMimeType);
    return {
      provider: this.name,
      model: this.model,
      views: [await canonicalFrontImage(input.photoBuffer)],
    };
  }
}

/** Production reference provider: one uploaded image -> Tripo left/back/right views. */
export class TripoReferenceImageProvider implements ReferenceImageProvider {
  readonly name = "tripo";
  readonly model = "generate-multiview-image-v2";
  readonly outputViewKinds = ORDERED_VIEW_KINDS;

  async generateMultiview(
    input: ReferenceGenerationInput,
    inputMode: "text" | "photo",
  ): Promise<ProviderGenerationResult> {
    if (inputMode !== "photo") throw new Error("This reference builder requires one uploaded pet photo.");
    if (!input.photoBuffer || !input.photoMimeType) throw new Error("A source photo is required.");
    const front = await canonicalFrontImage(input.photoBuffer);
    const taskHandle = await startTripoImageToMultiview(input.photoBuffer);
    await input.onProviderTaskCreated?.(taskHandle);

    const deadline = Date.now() + REFERENCE_PROVIDER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const polled = await pollTripoImageToMultiview(taskHandle);
      if (polled.error) throw new Error(polled.error);
      if (!polled.done || !polled.views) {
        await sleep(1_500);
        continue;
      }
      const [leftBuffer, backBuffer, rightBuffer] = await Promise.all([
        downloadTripoReferenceImage(polled.views.leftUrl),
        downloadTripoReferenceImage(polled.views.backUrl),
        downloadTripoReferenceImage(polled.views.rightUrl),
      ]);
      const providerViews: Array<{ viewKind: ViewKind; imageBuffer: Buffer }> = [
        { viewKind: "left", imageBuffer: leftBuffer },
        { viewKind: "right", imageBuffer: rightBuffer },
        { viewKind: "rear", imageBuffer: backBuffer },
      ];
      const generatedViews = await Promise.all(providerViews.map(async ({ viewKind, imageBuffer }) => {
        const metadata = await sharp(imageBuffer, { failOn: "error" }).metadata();
        const mimeType = metadata.format === "jpeg" ? "image/jpeg" : metadata.format === "webp" ? "image/webp" : "image/png";
        const inspected = await inspectReferenceImage(imageBuffer, mimeType);
        return { viewKind, imageBuffer, ...inspected, isSynthesized: true } as GeneratedViewPayload;
      }));
      const byKind = new Map(generatedViews.map((view) => [view.viewKind, view]));
      return {
        provider: this.name,
        model: this.model,
        views: ORDERED_VIEW_KINDS.map((kind) => kind === "front" ? front : byKind.get(kind)!),
      };
    }
    throw new Error("Tripo is still preparing the reference views. Please try again shortly.");
  }
}

export type ReferenceImageProviderFactory = () => ReferenceImageProvider;

export class ReferenceProviderConfigurationError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "ReferenceProviderConfigurationError";
  }
}

function configuredExternalReferenceProviders(env: NodeJS.ProcessEnv): Set<string> {
  return new Set([
    "tripo",
    ...String(env.PAWS_REFERENCE_EXTERNAL_PROVIDER_IDS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ]);
}

/** Select a reference-preparation implementation without constructing it. */
export function selectedReferenceImageProvider(env: NodeJS.ProcessEnv = process.env): string {
  const strictInHouse = isInHouseOnly(env);
  const fallback = strictInHouse ? "uploaded_front" : "tripo";
  const selected = String(env.PAWS_REFERENCE_PROVIDER || fallback).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(selected)) {
    throw new ReferenceProviderConfigurationError(
      "Configured reference provider id is invalid",
      "REFERENCE_PROVIDER_CONFIG_INVALID",
    );
  }
  if (strictInHouse && configuredExternalReferenceProviders(env).has(selected)) {
    throw new ReferenceProviderConfigurationError(
      "In-house-only mode rejects the selected external reference provider",
      "INHOUSE_REFERENCE_PROVIDER_REQUIRED",
    );
  }
  return selected;
}

export function createConfiguredReferenceImageProvider(
  env: NodeJS.ProcessEnv = process.env,
  factories: ReadonlyMap<string, ReferenceImageProviderFactory> = new Map<string, ReferenceImageProviderFactory>([
    ["uploaded_front", () => new UploadedFrontReferenceImageProvider()],
    ["tripo", () => new TripoReferenceImageProvider()],
  ]),
): ReferenceImageProvider {
  const selected = selectedReferenceImageProvider(env);
  const factory = factories.get(selected);
  if (!factory) {
    throw new ReferenceProviderConfigurationError(
      "Configured reference provider is unavailable",
      "REFERENCE_PROVIDER_CONFIG_UNAVAILABLE",
    );
  }
  return factory();
}
