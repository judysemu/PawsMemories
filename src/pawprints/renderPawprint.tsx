/**
 * Pawprints v2 Stage 2 compositor.
 *
 * This is the ONE rendering pipeline used by both the Finish step's Live
 * Preview and the final Save — deliberately the same code path for both, so
 * what the customer previews is byte-for-byte what gets delivered. See
 * docs/superpowers/specs/2026-08-12-pawprints-flow-repair-design.md.
 *
 * Stage 1 (server-side AI subject-art generation) produces one hero image;
 * this module composites that hero (plus any additional uploaded photos, for
 * multi-slot layouts like filmstrip/mosaic/story) with the customer's title
 * and message onto the fixed 4:5 Pawprint canvas.
 */
import React from "react";
import { Check } from "lucide-react";
import { planPawprintCollage, type PawprintLayoutId } from "./collageEngine";
import { renderPhotosWebGL2 } from "./gpuCompositor";

export type Variation = PawprintLayoutId;

export interface StudioPhoto {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  lowResolution: boolean;
}

export const FULL_PRINT_WIDTH = 2400;
export const FULL_PRINT_HEIGHT = 3000;
export const CANVAS_ASPECT = FULL_PRINT_WIDTH / FULL_PRINT_HEIGHT;

/** Same 4:5 canvas, ~1/16th the pixels, so a re-render on every edit stays interactive. */
export const PREVIEW_WIDTH = 600;
export const PREVIEW_HEIGHT = 750;
export const PREVIEW_DEBOUNCE_MS = 260;

export const TITLE_MAX_LENGTH = 60;
export const MESSAGE_MAX_LENGTH = 220;
export const CUSTOM_PROMPT_MAX_LENGTH = 600;

export const VARIATIONS: Array<{ id: Variation; label: string }> = [
  { id: "classic", label: "Classic" },
  { id: "overlay", label: "Editorial" },
  { id: "split", label: "Split" },
  { id: "frame", label: "Keepsake" },
  { id: "story", label: "Story" },
  { id: "filmstrip", label: "Filmstrip" },
  { id: "circles", label: "Bubbles" },
  { id: "mosaic", label: "Arch Mosaic" },
  { id: "polaroid", label: "Polaroids" },
  { id: "triptych", label: "Gallery" },
  { id: "magazine", label: "Magazine" },
  { id: "panorama", label: "Panorama" },
];

/** Background/frame/text-color palette. Digital categories get their own
 *  tone; anything else (Print products, custom prompts) falls back to a
 *  neutral warm palette. */
const CATEGORY_PALETTES: Record<string, [string, string, string]> = {
  event_themed: ["#fff0e0", "#d9834f", "#4a2c1c"],
  seasonal_holiday: ["#e9f2ea", "#5c8a6a", "#1f3626"],
  professional_commercial: ["#e7eaff", "#626db3", "#252d61"],
};
const DEFAULT_PALETTE: [string, string, string] = ["#f8efe8", "#b7795d", "#3f2c24"];

function paletteFor(category: string): [string, string, string] {
  return CATEGORY_PALETTES[category] || DEFAULT_PALETTE;
}

export function matchesCanvasAspect(widthIn: number, heightIn: number): boolean {
  if (!widthIn || !heightIn) return false;
  return Math.abs(widthIn / heightIn - CANVAS_ASPECT) < 0.03;
}

export function canvasDataUrl(canvas: HTMLCanvasElement, mimeType = "image/jpeg", quality = 0.9): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("The browser ran out of memory while preparing the photo."));
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("The prepared photo could not be read."));
      reader.readAsDataURL(blob);
    }, mimeType, quality);
  });
}

export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The prepared photo could not be read."));
    reader.readAsDataURL(blob);
  });
}

/** Fetches a same-app image URL (e.g. the Stage 1 subject art) and returns it
 *  as a data: URL so it composites into <canvas> exactly like an uploaded
 *  photo, with no cross-origin taint risk. */
export async function urlToDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("The generated Pawprint art could not be loaded.");
  const blob = await response.blob();
  return blobDataUrl(blob);
}

async function normalizePhotoInWorker(file: File, mobile: boolean): Promise<StudioPhoto> {
  const worker = new Worker(new URL("./photoWorker.ts", import.meta.url), { type: "module" });
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  try {
    const result = await new Promise<{ width: number; height: number; originalWidth: number; originalHeight: number; mimeType: string; buffer: ArrayBuffer }>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Photo optimization timed out.")), 30_000);
      worker.onmessage = (event) => {
        if (event.data?.id !== id) return;
        window.clearTimeout(timeout);
        if (!event.data.ok) reject(new Error(event.data.error || "The photo could not be prepared."));
        else resolve(event.data);
      };
      worker.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Background photo optimization is unavailable."));
      };
      worker.postMessage({
        id,
        file,
        maxEdge: mobile ? 1_600 : 2_400,
        maxPixels: mobile ? 3_200_000 : 7_000_000,
        quality: mobile ? 0.86 : 0.9,
      });
    });
    return {
      id,
      name: file.name,
      dataUrl: await blobDataUrl(new Blob([result.buffer], { type: result.mimeType })),
      width: result.width,
      height: result.height,
      originalWidth: result.originalWidth,
      originalHeight: result.originalHeight,
      lowResolution: result.originalWidth < 600 || result.originalHeight < 600,
    };
  } finally {
    worker.terminate();
  }
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The photo could not be opened."));
    image.src = source;
  });
}

async function normalizePhoto(file: File): Promise<StudioPhoto> {
  if (!file.type.match(/^image\/(png|jpe?g|webp)$/i)) throw new Error(`${file.name}: choose PNG, JPEG, or WebP.`);
  if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: choose a photo smaller than 20 MB.`);
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(sourceUrl);
    const originalWidth = image.naturalWidth;
    const originalHeight = image.naturalHeight;
    const mobile = window.matchMedia?.("(max-width: 760px), (pointer: coarse)").matches ?? false;
    const maxEdge = mobile ? 1_600 : 2_400;
    const maxPixels = mobile ? 3_200_000 : 7_000_000;
    const edgeScale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
    const pixelScale = Math.min(1, Math.sqrt(maxPixels / (image.naturalWidth * image.naturalHeight)));
    const scale = Math.min(edgeScale, pixelScale);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser cannot prepare photos.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = await canvasDataUrl(canvas, "image/jpeg", mobile ? 0.86 : 0.9);
    canvas.width = 1;
    canvas.height = 1;
    image.src = "";
    return {
      id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      name: file.name,
      dataUrl,
      width,
      height,
      originalWidth,
      originalHeight,
      lowResolution: originalWidth < 600 || originalHeight < 600,
    };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export async function preparePhoto(file: File): Promise<StudioPhoto> {
  if (!file.type.match(/^image\/(png|jpe?g|webp)$/i)) throw new Error(`${file.name}: choose PNG, JPEG, or WebP.`);
  if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: choose a photo smaller than 20 MB.`);
  const mobile = window.matchMedia?.("(max-width: 760px), (pointer: coarse)").matches ?? false;
  if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function") {
    try {
      return await normalizePhotoInWorker(file, mobile);
    } catch (error: any) {
      if (/smaller than|choose PNG/i.test(error?.message || "")) throw error;
      // Safari versions without worker OffscreenCanvas use the bounded main-thread path.
    }
  }
  return normalizePhoto(file);
}

function cover(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number, shape: "rect" | "circle" | "arch" = "rect") {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  ctx.save();
  ctx.beginPath();
  if (shape === "circle") ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  else if (shape === "arch") ctx.roundRect(x, y, width, height, [Math.min(width / 2, height / 3), Math.min(width / 2, height / 3), 20, 20]);
  else ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
  ctx.restore();
}

function wrapTextLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const paragraphs = text.replace(/\r/g, "").split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      if (paragraphs.length > 1) lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (!line || ctx.measureText(next).width <= maxWidth) line = next;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function drawFittedTextBlock(
  ctx: CanvasRenderingContext2D,
  input: { title: string; message: string; x: number; y: number; width: number; height: number; color: string; scale?: number },
) {
  const scale = input.scale && input.scale > 0 ? input.scale : 1;
  const padding = Math.max(20, Math.min(56, (input.width / scale) * 0.045)) * scale;
  const maxWidth = Math.max(40 * scale, input.width - padding * 2);
  const maxHeight = Math.max(40 * scale, input.height - padding * 2);
  const compact = input.width / scale < 1040 || input.height / scale < 460;
  const baseTitleSize = (compact ? 108 : 152) * scale;
  const baseMessageSize = (compact ? 68 : 86) * scale;
  let fitScale = 1;
  let titleLines: string[] = [];
  let messageLines: string[] = [];
  let titleSize = baseTitleSize;
  let messageSize = baseMessageSize;
  let titleLineHeight = titleSize * 1.08;
  let messageLineHeight = messageSize * 1.25;
  let gap = 0;

  for (; fitScale >= 0.28; fitScale -= 0.04) {
    titleSize = Math.max(4, Math.round(baseTitleSize * fitScale));
    messageSize = Math.max(3, Math.round(baseMessageSize * fitScale));
    titleLineHeight = titleSize * 1.08;
    messageLineHeight = messageSize * 1.25;
    gap = input.title.trim() && input.message.trim() ? Math.max(6 * scale, messageSize * 0.45) : 0;
    ctx.font = `700 ${titleSize}px Georgia, serif`;
    titleLines = input.title.trim() ? wrapTextLines(ctx, input.title, maxWidth) : [];
    ctx.font = `500 ${messageSize}px Arial, sans-serif`;
    messageLines = input.message.trim() ? wrapTextLines(ctx, input.message, maxWidth) : [];
    const needed = titleLines.length * titleLineHeight + gap + messageLines.length * messageLineHeight;
    if (needed <= maxHeight) break;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(input.x, input.y, input.width, input.height);
  ctx.clip();
  ctx.fillStyle = input.color;
  ctx.textBaseline = "top";
  let cursorY = input.y + padding;
  ctx.font = `700 ${titleSize}px Georgia, serif`;
  for (const line of titleLines) {
    ctx.fillText(line, input.x + padding, cursorY, maxWidth);
    cursorY += titleLineHeight;
  }
  if (titleLines.length && messageLines.length) cursorY += gap;
  ctx.font = `500 ${messageSize}px Arial, sans-serif`;
  for (const line of messageLines) {
    if (cursorY + messageLineHeight > input.y + input.height - padding / 2) break;
    ctx.fillText(line, input.x + padding, cursorY, maxWidth);
    cursorY += messageLineHeight;
  }
  ctx.restore();
}

export async function renderPawprint(input: {
  variation: Variation;
  photos: StudioPhoto[];
  title: string;
  message: string;
  category: string;
  width?: number;
  height?: number;
  mimeType?: string;
  quality?: number;
}): Promise<string> {
  const PRINT_WIDTH = input.width ?? FULL_PRINT_WIDTH;
  const PRINT_HEIGHT = input.height ?? FULL_PRINT_HEIGHT;
  const scaleFromPrint = PRINT_WIDTH / FULL_PRINT_WIDTH;
  const canvas = document.createElement("canvas");
  canvas.width = PRINT_WIDTH;
  canvas.height = PRINT_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot render the Pawprint.");
  const palette = paletteFor(input.category);
  ctx.fillStyle = palette[0];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const plan = planPawprintCollage(input.variation, Math.max(1, input.photos.length));

  if (input.photos.length === 0) {
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = palette[1];
    for (const [x, y, r] of [[180, 220, 120], [940, 310, 180], [310, 1080, 170], [930, 1210, 110]] as const) {
      ctx.beginPath();
      ctx.arc(x * scaleFromPrint, y * scaleFromPrint, r * scaleFromPrint, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  const gpuLayer = await renderPhotosWebGL2({ photos: input.photos, rects: plan.photos, width: PRINT_WIDTH, height: PRINT_HEIGHT, background: palette[0] });
  if (gpuLayer) {
    ctx.drawImage(gpuLayer, 0, 0);
    gpuLayer.width = 1; gpuLayer.height = 1;
  } else {
    for (let index = 0; index < input.photos.length; index += 1) {
      const image = await loadImage(input.photos[index].dataUrl);
      const rect = plan.photos[index];
      if (rect) cover(ctx, image, rect.x * PRINT_WIDTH, rect.y * PRINT_HEIGHT, rect.width * PRINT_WIDTH, rect.height * PRINT_HEIGHT, rect.shape);
      image.src = "";
    }
  }
  if (plan.insetFrame) {
    ctx.strokeStyle = palette[1];
    ctx.lineWidth = 48 * scaleFromPrint;
    const inset = 120 * scaleFromPrint;
    ctx.strokeRect(inset, inset, PRINT_WIDTH - inset * 2, PRINT_HEIGHT - inset * 2);
  }

  if (plan.textOverlay) {
    const gradient = ctx.createLinearGradient(0, PRINT_HEIGHT / 3, 0, PRINT_HEIGHT);
    gradient.addColorStop(0, "rgba(0,0,0,0)"); gradient.addColorStop(1, "rgba(18,14,12,.86)");
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, PRINT_WIDTH, PRINT_HEIGHT);
  }
  drawFittedTextBlock(ctx, {
    title: input.title,
    message: input.message,
    x: plan.text.x * PRINT_WIDTH,
    y: plan.text.y * PRINT_HEIGHT,
    width: plan.text.width * PRINT_WIDTH,
    height: plan.text.height * PRINT_HEIGHT,
    color: plan.textOverlay ? "#fff" : palette[2],
    scale: scaleFromPrint,
  });
  try {
    const result = await canvasDataUrl(canvas, input.mimeType ?? "image/webp", input.quality ?? 0.92);
    canvas.width = 1; canvas.height = 1;
    return result;
  } catch {
    const result = await canvasDataUrl(canvas, "image/png");
    canvas.width = 1; canvas.height = 1;
    return result;
  }
}

export function VariationPreview({ variation, selected, photos, title, message, category, onSelect }: {
  variation: Variation; selected: boolean; photos: StudioPhoto[]; title: string; message: string; category: string; onSelect: () => void;
}) {
  const palette = paletteFor(category);
  const label = VARIATIONS.find((item) => item.id === variation)?.label;
  const plan = planPawprintCollage(variation, Math.max(1, photos.length));
  return (
    <button type="button" onClick={onSelect} className={`group text-left rounded-2xl border-2 p-2 transition ${selected ? "border-primary shadow-lg" : "border-transparent hover:border-outline-variant"}`}>
      <div className="relative aspect-[4/5] overflow-hidden rounded-xl [container-type:inline-size]" style={{ background: palette[0], color: palette[2] }}>
        {plan.insetFrame && <div className="absolute inset-3 border-[6px]" style={{ borderColor: palette[1] }} />}
        {photos.map((photo, index) => { const rect = plan.photos[index]; const borderRadius = rect?.shape === "circle" ? "50%" : rect?.shape === "arch" ? "50% 50% 8% 8%" : undefined; return rect ? <div key={photo.id} className="absolute bg-cover bg-center" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`, backgroundImage: `url(${photo.dataUrl})`, borderRadius }} /> : null; })}
        {plan.textOverlay && <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />}
        <div className={`absolute overflow-hidden ${plan.textOverlay ? "text-white" : ""}`} style={{ left: `${plan.text.x * 100}%`, top: `${plan.text.y * 100}%`, width: `${plan.text.width * 100}%`, height: `${plan.text.height * 100}%` }}><strong className="block break-words font-serif text-[clamp(11px,3.2cqw,17px)] leading-tight">{title}</strong><span className="mt-1.5 block line-clamp-5 break-words text-[clamp(8px,2.1cqw,12px)] leading-snug opacity-90">{message}</span></div>
        {photos.length === 0 && <span className="pointer-events-none absolute right-3 top-2 text-5xl opacity-15">🐾</span>}
        {selected && <span className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-primary text-on-primary"><Check size={15} /></span>}
      </div>
      <span className="mt-2 block px-1 text-xs font-black text-on-surface">{label}</span>
    </button>
  );
}
