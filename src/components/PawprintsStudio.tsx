import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronLeft, Download, ImagePlus, LayoutGrid, Loader2, PawPrint, Printer, Sparkles, Type, X } from "lucide-react";
import type { Creation, PublicUser, UserProfile } from "../types";
import { authedFetch } from "../api";
import { CREDIT_PRICES } from "../pricing";
import { MAX_PAWPRINT_PHOTOS, planPawprintCollage, type PawprintLayoutId } from "../pawprints/collageEngine";
import { renderPhotosWebGL2 } from "../pawprints/gpuCompositor";
import {
  HISTORIC_PHYSICAL_TEMPLATE_IDS,
  HISTORIC_ROLE_IDS,
  HISTORIC_ROLE_SHEET_COLUMNS,
  HISTORIC_ROLE_SHEET_ROWS,
} from "../../shared/historicPawprintTemplates.ts";

interface PawprintsStudioProps {
  userProfile: UserProfile;
  creations: Creation[];
  onOpenCreditStore: () => void;
  onUserUpdate: (user: PublicUser) => void;
  onCreationSaved?: () => Promise<void> | void;
}

interface TemplateField {
  key: string;
  type: string;
  label: string;
  maxLength?: number;
}

interface PawprintTemplate {
  category: string;
  layoutId: string;
  name: string;
  tone: string;
  sampleCopy: string[];
  fieldSchema: TemplateField[];
  sourceUrl?: string;
  sourceLicense?: string;
  sourceName?: string;
}

type Variation = PawprintLayoutId;

interface StudioPhoto {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
}

interface PawprintPrintProduct {
  code: string;
  label: string;
  description: string;
  widthIn: number;
  heightIn: number;
  priceCents?: number;
  /**
   * False for showcase formats returned while Printful has no variant IDs
   * configured. Such a row is displayed but can never be ordered — the server
   * rejects any code that has no real, server-owned Printful variant.
   */
  orderable?: boolean;
}

interface ShippingForm {
  name: string;
  email: string;
  address1: string;
  city: string;
  state_code: string;
  country_code: string;
  zip: string;
}

const FULL_PRINT_WIDTH = 2400;
const FULL_PRINT_HEIGHT = 3000;
const CANVAS_ASPECT = FULL_PRINT_WIDTH / FULL_PRINT_HEIGHT;

/**
 * PP-1: live-preview resolution. Same 4:5 canvas, ~1/16th the pixels, so a
 * re-render on every keystroke/photo/variation change stays interactive.
 */
const PREVIEW_WIDTH = 600;
const PREVIEW_HEIGHT = 750;
const PREVIEW_DEBOUNCE_MS = 260;

// "Small box" (title) and "large box" (message) character limits for the
// digital template text feature — keeps copy from overflowing the fitted
// text block at small render scales.
const TITLE_MAX_LENGTH = 60;
const MESSAGE_MAX_LENGTH = 220;

/**
 * Every Pawprint template renders onto the same fixed 4:5 canvas
 * (PRINT_WIDTH x PRINT_HEIGHT). A Printful product only reproduces that
 * design correctly if its own print-file aspect ratio is close to 4:5 —
 * a mismatched size crops or letterboxes the art. This is the "digital
 * template matches the product variant" check for the Digital + Printed
 * flow: only orderable products within tolerance of the canvas aspect are
 * offered, instead of every configured Printful variant regardless of fit.
 */
function matchesCanvasAspect(product: PawprintPrintProduct): boolean {
  if (!product.widthIn || !product.heightIn) return false;
  const productAspect = product.widthIn / product.heightIn;
  return Math.abs(productAspect - CANVAS_ASPECT) < 0.03;
}

const VARIATIONS: Array<{ id: Variation; label: string }> = [
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

const CATEGORY_META: Record<string, { label: string; symbol: string; colors: [string, string, string] }> = {
  historic_portraits: { label: "Historic Pawprints", symbol: "👑", colors: ["#efe3c4", "#9f6b4f", "#30243b"] },
  grieving_loss: { label: "Grieving Loss", symbol: "🕊️", colors: ["#e8e8e4", "#6b7280", "#25313c"] },
  new_puppy: { label: "New Puppy", symbol: "🐶", colors: ["#fff0d8", "#e69a52", "#58321d"] },
  veterinarian: { label: "Veterinarian", symbol: "🩺", colors: ["#dff5ef", "#4f9c8b", "#173f3a"] },
  holiday_birthday: { label: "Holiday & Birthday", symbol: "🎂", colors: ["#ffe6ef", "#d86791", "#5e2137"] },
  environment: { label: "Environment", symbol: "🌿", colors: ["#e3f2df", "#5c9563", "#203f28"] },
  postcard_travel: { label: "Postcard & Travel", symbol: "✈️", colors: ["#e3f1ff", "#5689bd", "#1d3955"] },
  get_well: { label: "Get Well", symbol: "💐", colors: ["#fff1e8", "#dc8067", "#5d2b24"] },
  miss_you: { label: "Miss You", symbol: "💌", colors: ["#eee7ff", "#846cb5", "#38265e"] },
  pet_business: { label: "Pet Business", symbol: "🏪", colors: ["#e7eaff", "#626db3", "#252d61"] },
};

function canvasDataUrl(canvas: HTMLCanvasElement, mimeType = "image/jpeg", quality = 0.9): Promise<string> {
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

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The prepared photo could not be read."));
    reader.readAsDataURL(blob);
  });
}

async function normalizePhotoInWorker(file: File, mobile: boolean): Promise<StudioPhoto> {
  const worker = new Worker(new URL("../pawprints/photoWorker.ts", import.meta.url), { type: "module" });
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  try {
    const result = await new Promise<{ width: number; height: number; mimeType: string; buffer: ArrayBuffer }>((resolve, reject) => {
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
    return { id, name: file.name, dataUrl: await blobDataUrl(new Blob([result.buffer], { type: result.mimeType })), width: result.width, height: result.height };
  } finally {
    worker.terminate();
  }
}

async function normalizePhoto(file: File): Promise<StudioPhoto> {
  if (!file.type.match(/^image\/(png|jpe?g|webp)$/i)) throw new Error(`${file.name}: choose PNG, JPEG, or WebP.`);
  if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: choose a photo smaller than 20 MB.`);
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(sourceUrl);
    if (image.naturalWidth < 600 || image.naturalHeight < 600) throw new Error(`${file.name}: minimum size is 600 × 600 pixels.`);
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
    };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function preparePhoto(file: File): Promise<StudioPhoto> {
  if (!file.type.match(/^image\/(png|jpe?g|webp)$/i)) throw new Error(`${file.name}: choose PNG, JPEG, or WebP.`);
  if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: choose a photo smaller than 20 MB.`);
  const mobile = window.matchMedia?.("(max-width: 760px), (pointer: coarse)").matches ?? false;
  if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function") {
    try {
      return await normalizePhotoInWorker(file, mobile);
    } catch (error: any) {
      if (/minimum size|smaller than|choose PNG/i.test(error?.message || "")) throw error;
      // Safari versions without worker OffscreenCanvas use the bounded main-thread path.
    }
  }
  return normalizePhoto(file);
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The photo could not be opened."));
    image.src = source;
  });
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
  input: {
    title: string; message: string; x: number; y: number; width: number; height: number; color: string;
    /**
     * PP-1: canvas scale relative to the full print canvas. Every typographic
     * constant below is expressed in print pixels, so the live preview must
     * scale them — otherwise preview text wraps and sizes differently from the
     * artifact the customer actually pays for, which is worse than no preview.
     */
    scale?: number;
  },
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

async function renderPawprint(input: {
  variation: Variation;
  photos: StudioPhoto[];
  title: string;
  message: string;
  category: string;
  /**
   * PP-1: the live preview renders the SAME pipeline at a fraction of the
   * print resolution. Full 2400x3000 is reserved for the paid Save so the
   * preview stays cheap enough to re-run on every edit.
   */
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
  const palette = CATEGORY_META[input.category]?.colors || ["#f8efe8", "#b7795d", "#3f2c24"];
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

function VariationPreview({ variation, selected, photos, title, message, category, onSelect }: {
  variation: Variation; selected: boolean; photos: StudioPhoto[]; title: string; message: string; category: string; onSelect: () => void;
}) {
  const palette = CATEGORY_META[category]?.colors || ["#f8efe8", "#b7795d", "#3f2c24"];
  const label = VARIATIONS.find((item) => item.id === variation)?.label;
  const plan = planPawprintCollage(variation, Math.max(1, photos.length));
  return (
    <button type="button" onClick={onSelect} className={`group text-left rounded-2xl border-2 p-2 transition ${selected ? "border-primary shadow-lg" : "border-transparent hover:border-outline-variant"}`}>
      <div className="relative aspect-[4/5] overflow-hidden rounded-xl [container-type:inline-size]" style={{ background: palette[0], color: palette[2] }}>
        {plan.insetFrame && <div className="absolute inset-3 border-[6px]" style={{ borderColor: palette[1] }} />}
        {photos.map((photo, index) => { const rect = plan.photos[index]; const borderRadius = rect?.shape === "circle" ? "50%" : rect?.shape === "arch" ? "50% 50% 8% 8%" : undefined; return rect ? <div key={photo.id} className="absolute bg-cover bg-center" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`, backgroundImage: `url(${photo.dataUrl})`, borderRadius }} /> : null; })}
        {plan.textOverlay && <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />}
        {/* PP-9: the message was text-[9px] with line-clamp-4 — effectively
            unreadable, so the thumbnail gave no sense of how the words would
            actually look. Sizes are now viewport-relative to the tile so they
            stay legible at every breakpoint, and the real typography lives in
            the live preview (PP-1). */}
        <div className={`absolute overflow-hidden ${plan.textOverlay ? "text-white" : ""}`} style={{ left: `${plan.text.x * 100}%`, top: `${plan.text.y * 100}%`, width: `${plan.text.width * 100}%`, height: `${plan.text.height * 100}%` }}><strong className="block break-words font-serif text-[clamp(11px,3.2cqw,17px)] leading-tight">{title}</strong><span className="mt-1.5 block line-clamp-5 break-words text-[clamp(8px,2.1cqw,12px)] leading-snug opacity-90">{message}</span></div>
        {photos.length === 0 && <span className="pointer-events-none absolute right-3 top-2 text-5xl opacity-15">{CATEGORY_META[category]?.symbol || "🐾"}</span>}
        {selected && <span className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-primary text-on-primary"><Check size={15} /></span>}
      </div>
      <span className="mt-2 block px-1 text-xs font-black text-on-surface">{label}</span>
    </button>
  );
}

/**
 * PP-2: one 5-across x 4-down contact sheet holds all twenty role portraits.
 * Slicing it with background-position gives every role a real thumbnail
 * without twenty extra network requests — and, critically, connects the
 * picture to the choice. Previously the sheet was decorative: tapping a face
 * did nothing and the actual selection happened in a separate flat <select>.
 */
/**
 * PP-10: the shipping form used free-text 2-character Country and State
 * inputs with no validation, so a shopper could type "zz" and only find out
 * at server submission. These are the destinations the print path supports.
 */
const SUPPORTED_COUNTRIES: Array<{ code: string; label: string }> = [
  { code: "US", label: "United States" },
  { code: "CA", label: "Canada" },
  { code: "GB", label: "United Kingdom" },
  { code: "AU", label: "Australia" },
  { code: "NZ", label: "New Zealand" },
  { code: "IE", label: "Ireland" },
];

const US_STATES: Array<{ code: string; label: string }> = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"],
  ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"],
  ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"],
  ["ME", "Maine"], ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
  ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"],
  ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
  ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"],
  ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"], ["SD", "South Dakota"],
  ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"],
  ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
].map(([code, label]) => ({ code, label }));

const CA_PROVINCES: Array<{ code: string; label: string }> = [
  ["AB", "Alberta"], ["BC", "British Columbia"], ["MB", "Manitoba"], ["NB", "New Brunswick"],
  ["NL", "Newfoundland and Labrador"], ["NS", "Nova Scotia"], ["NT", "Northwest Territories"],
  ["NU", "Nunavut"], ["ON", "Ontario"], ["PE", "Prince Edward Island"], ["QC", "Quebec"],
  ["SK", "Saskatchewan"], ["YT", "Yukon"],
].map(([code, label]) => ({ code, label }));

const AU_STATES: Array<{ code: string; label: string }> = [
  ["ACT", "Australian Capital Territory"], ["NSW", "New South Wales"], ["NT", "Northern Territory"],
  ["QLD", "Queensland"], ["SA", "South Australia"], ["TAS", "Tasmania"], ["VIC", "Victoria"],
  ["WA", "Western Australia"],
].map(([code, label]) => ({ code, label }));

/** Countries absent here (GB, NZ, IE) do not use a required region code. */
const REGIONS_BY_COUNTRY: Record<string, Array<{ code: string; label: string }> | undefined> = {
  US: US_STATES,
  CA: CA_PROVINCES,
  AU: AU_STATES,
};

const ROLE_SHEET_URL = "/collections/historic-pawprints/historic-pawprints-20-v1.webp";

function roleSheetStyle(layoutId: string): React.CSSProperties | undefined {
  const index = HISTORIC_ROLE_IDS.indexOf(layoutId);
  if (index < 0) return undefined;
  const column = index % HISTORIC_ROLE_SHEET_COLUMNS;
  const row = Math.floor(index / HISTORIC_ROLE_SHEET_COLUMNS);
  return {
    backgroundImage: `url(${ROLE_SHEET_URL})`,
    backgroundSize: `${HISTORIC_ROLE_SHEET_COLUMNS * 100}% ${HISTORIC_ROLE_SHEET_ROWS * 100}%`,
    backgroundPosition: `${(column / (HISTORIC_ROLE_SHEET_COLUMNS - 1)) * 100}% ${(row / (HISTORIC_ROLE_SHEET_ROWS - 1)) * 100}%`,
  };
}

/**
 * PP-2: twenty undifferentiated options is far past what anyone can scan, so
 * the grid is filterable by theme as well as by name.
 */
const ROLE_GROUPS: Array<{ id: string; label: string; ids: string[] }> = [
  { id: "historical", label: "Historical", ids: ["joan-of-arc", "cleopatra", "the-visionary", "the-statespet", "hopeful-leader", "peaceful-guide", "mountain-guide", "courageous-guide"] },
  { id: "occupations", label: "Occupations", ids: ["the-composer", "the-chef", "the-rock-star", "the-moon-explorer"] },
  { id: "sports", label: "Sports", ids: ["championship-boxer", "the-gymnast", "purrs-23", "gridiron-12", "tennis-champion"] },
  { id: "seasonal", label: "Seasonal & Legends", ids: ["santa", "snow-guardian", "forest-legend"] },
];

/** Shown before "See all" is expanded — a scannable 7±2 rather than twenty. */
const FEATURED_ROLE_IDS = [
  "joan-of-arc",
  "cleopatra",
  "the-composer",
  "santa",
  "the-chef",
  "the-moon-explorer",
];

/**
 * PP-6: a persistent stepper. The flow is five linear steps gated by early
 * returns; without this the customer had no idea how many steps remained, and
 * each back button undid exactly one step with no way to jump.
 */
function WizardSteps({ steps, activeIndex, onSelect }: {
  steps: Array<{ id: string; label: string; done: boolean }>;
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <nav aria-label="Pawprint progress" className="mb-6">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-xs font-black">
        {steps.map((step, index) => {
          const isActive = index === activeIndex;
          const reachable = index < activeIndex;
          return (
            <li key={step.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onSelect(index)}
                disabled={!reachable}
                aria-current={isActive ? "step" : undefined}
                className={`flex min-h-11 items-center gap-2 rounded-full px-3 transition ${
                  isActive
                    ? "bg-primary text-on-primary"
                    : reachable
                      ? "text-primary hover:bg-primary/10"
                      : "text-on-surface-variant opacity-60"
                }`}
              >
                <span className={`grid h-5 w-5 place-items-center rounded-full text-[10px] ${isActive ? "bg-on-primary/20" : "bg-outline-variant/30"}`}>
                  {step.done && !isActive ? <Check size={11} /> : index + 1}
                </span>
                {step.label}
              </button>
              {index < steps.length - 1 && <span aria-hidden className="text-on-surface-variant/50">·</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default function PawprintsStudio({ userProfile, onOpenCreditStore, onUserUpdate, onCreationSaved }: PawprintsStudioProps) {
  const [categories, setCategories] = useState<string[]>([]);
  const [templates, setTemplates] = useState<PawprintTemplate[]>([]);
  const [category, setCategory] = useState("");
  const [template, setTemplate] = useState<PawprintTemplate | null>(null);
  const [photos, setPhotos] = useState<StudioPhoto[]>([]);
  const [photosConfirmed, setPhotosConfirmed] = useState(false);
  const [intent, setIntent] = useState<"" | "digital" | "digital-printed">("");
  const [title, setTitle] = useState("A little love, saved forever");
  const [message, setMessage] = useState("Every day is better with paws beside us.");
  const [variation, setVariation] = useState<Variation>("classic");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [savedCreationId, setSavedCreationId] = useState<number | null>(null);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [printProducts, setPrintProducts] = useState<PawprintPrintProduct[]>([]);
  const [printProductCode, setPrintProductCode] = useState("");
  const [printOrderMode, setPrintOrderMode] = useState<"payment" | "draft">("payment");
  const [printAvailable, setPrintAvailable] = useState(false);
  const [shipping, setShipping] = useState<ShippingForm>({
    name: userProfile.fullName || "",
    email: userProfile.email || "",
    address1: "",
    city: userProfile.city || "",
    state_code: "",
    country_code: "US",
    zip: userProfile.zip || "",
  });
  const [printBusy, setPrintBusy] = useState(false);
  const [printOrder, setPrintOrder] = useState<{ id: string; status: string } | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  // PP-11: fetches used to render nothing while in flight and swallow their
  // errors, so a slow or failed load looked identical to an empty catalogue.
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState("");
  const [printProductsLoading, setPrintProductsLoading] = useState(true);
  const [printProductsError, setPrintProductsError] = useState("");
  const [printProductsReloadToken, setPrintProductsReloadToken] = useState(0);
  const [templatesReloadToken, setTemplatesReloadToken] = useState(0);

  // PP-2: name filter + theme chips + progressive disclosure of all twenty.
  const [roleQuery, setRoleQuery] = useState("");
  const [roleGroup, setRoleGroup] = useState("");
  const [showAllRoles, setShowAllRoles] = useState(false);

  // PP-1: debounced live preview of the real render pipeline.
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewRendering, setPreviewRendering] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const previewRequestRef = useRef(0);

  // PP-12: the sign-in requirement is surfaced early, and dismissible.
  const [signInNoticeDismissed, setSignInNoticeDismissed] = useState(false);

  // PP-10: per-field validation for the print shipping form.
  const [shippingTouched, setShippingTouched] = useState<Partial<Record<keyof ShippingForm, boolean>>>({});

  const variationsSectionRef = useRef<HTMLElement | null>(null);
  const designSignature = useMemo(() => JSON.stringify([
    category,
    template?.layoutId || "",
    variation,
    title,
    message,
    photos.map((photo) => photo.id),
  ]), [category, template?.layoutId, variation, title, message, photos]);
  const liveDesignSignatureRef = useRef(designSignature);
  const previousDesignSignatureRef = useRef(designSignature);
  liveDesignSignatureRef.current = designSignature;

  useEffect(() => {
    if (previousDesignSignatureRef.current !== designSignature) {
      // A saved creation is immutable. Any visual edit must detach actions
      // from that older artifact so email/print can never submit stale art.
      setResultUrl("");
      setSavedCreationId(null);
      setPrintOrder(null);
    }
    previousDesignSignatureRef.current = designSignature;
  }, [designSignature]);

  // PP-11: scoped loading + error state, and a retry, instead of writing into
  // the single global `error` string shared by every step.
  useEffect(() => {
    let active = true;
    setTemplatesLoading(true);
    setTemplatesError("");
    fetch("/api/pawprints/templates").then((response) => response.json()).then((data) => {
      if (!active) return;
      setCategories(Array.isArray(data.categories) ? data.categories : []);
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
    }).catch(() => {
      if (active) setTemplatesError("Pawprint titles could not be loaded.");
    }).finally(() => {
      if (active) setTemplatesLoading(false);
    });
    return () => { active = false; };
  }, [templatesReloadToken]);

  useEffect(() => {
    let active = true;
    setPrintProductsLoading(true);
    setPrintProductsError("");
    fetch("/api/pawprints/print-products").then((response) => response.json()).then((data) => {
      if (!active) return;
      const products = Array.isArray(data.products) ? data.products : [];
      setPrintProducts(products);
      const firstPrintable = products.find((item: PawprintPrintProduct) => item.orderable === true && matchesCanvasAspect(item));
      setPrintProductCode((current) => current || firstPrintable?.code || products[0]?.code || "");
      setPrintOrderMode(data.orderMode === "payment" ? "payment" : "draft");
      setPrintAvailable(data.available === true);
    }).catch(() => {
      if (!active) return;
      setPrintProducts([]);
      setPrintAvailable(false);
      setPrintProductsError("Print sizes could not be loaded.");
    }).finally(() => {
      if (active) setPrintProductsLoading(false);
    });
    return () => { active = false; };
  }, [printProductsReloadToken]);

  /**
   * PP-1: live preview.
   *
   * The only real render used to happen inside save(), so a customer could not
   * see their design until they had already spent a PupCoin — and the variation
   * tiles are CSS mockups that show placement but not the real typography,
   * colour grading, gradient overlays or inset frame. This runs the identical
   * renderPawprint pipeline at PREVIEW_WIDTH x PREVIEW_HEIGHT, debounced, on
   * every edit. The full-resolution render stays exclusive to the paid Save.
   */
  useEffect(() => {
    if (!template) return;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setPreviewRendering(true);
    const timer = window.setTimeout(() => {
      renderPawprint({
        variation,
        photos,
        title: title.trim() || template.name,
        message: message.trim(),
        category,
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
        quality: 0.82,
      }).then((dataUrl) => {
        if (previewRequestRef.current !== requestId) return;
        setPreviewUrl(dataUrl);
        setPreviewError("");
      }).catch((caught: any) => {
        if (previewRequestRef.current !== requestId) return;
        setPreviewError(caught?.message || "The preview could not be drawn.");
      }).finally(() => {
        if (previewRequestRef.current === requestId) setPreviewRendering(false);
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [template, variation, photos, title, message, category]);

  const categoryTemplates = useMemo(() => {
    const historic = templates.filter((item) => item.category === "historic_portraits");
    if (intent !== "digital-printed") return historic;
    const physicalIds = new Set<string>(HISTORIC_PHYSICAL_TEMPLATE_IDS);
    return historic.filter((item) => physicalIds.has(item.layoutId));
  }, [templates, intent]);

  // Products actually usable for the Digital + Printed flow: server-owned
  // (orderable) AND close enough in aspect to the fixed Pawprint canvas that
  // the printed copy matches the digital design instead of cropping it.
  const printableProducts = useMemo(
    () => printProducts.filter((item) => item.orderable === true && matchesCanvasAspect(item)),
    [printProducts],
  );
  const digitalPrintedAvailable = printAvailable && printableProducts.length > 0;

  // PP-2: name search + theme chips over the allowlisted roles.
  const filteredRoleTemplates = useMemo(() => {
    const query = roleQuery.trim().toLowerCase();
    const groupIds = roleGroup ? new Set(ROLE_GROUPS.find((group) => group.id === roleGroup)?.ids || []) : null;
    return categoryTemplates.filter((item) => {
      if (groupIds && !groupIds.has(item.layoutId)) return false;
      if (!query) return true;
      return `${item.name} ${item.tone}`.toLowerCase().includes(query);
    });
  }, [categoryTemplates, roleQuery, roleGroup]);

  const roleFiltersActive = Boolean(roleQuery.trim() || roleGroup);
  const visibleRoleTemplates = useMemo(() => {
    if (showAllRoles || roleFiltersActive) return filteredRoleTemplates;
    const featured = new Set<string>(FEATURED_ROLE_IDS);
    const preferred = filteredRoleTemplates.filter((item) => featured.has(item.layoutId));
    // The physical path is already limited to five designs; never hide any of them.
    return preferred.length >= 4 ? preferred : filteredRoleTemplates;
  }, [filteredRoleTemplates, showAllRoles, roleFiltersActive]);
  const hiddenRoleCount = filteredRoleTemplates.length - visibleRoleTemplates.length;

  // PP-6: one persistent progress model for a flow that was five silent,
  // early-returning steps with no sense of position or distance travelled.
  const wizardSteps = [
    { id: "intent", label: "Keepsake", done: Boolean(intent) },
    { id: "template", label: "Portrait", done: Boolean(template) },
    { id: "photo", label: "Photo", done: photosConfirmed },
    { id: "finish", label: "Finish", done: Boolean(resultUrl) },
  ];
  const activeStepIndex = !intent ? 0 : !template ? 1 : !photosConfirmed ? 2 : 3;
  const goToStep = (index: number) => {
    if (index > activeStepIndex) return; // never skip ahead past unfinished work
    if (index <= 0) { setIntent(""); setCategory(""); setTemplate(null); setPhotosConfirmed(false); return; }
    if (index === 1) { setTemplate(null); setPhotosConfirmed(false); return; }
    if (index === 2) { setPhotosConfirmed(false); }
  };

  // PP-4: explain the disabled Save rather than greying it out silently.
  const pawprintCost = CREDIT_PRICES.PAWPRINT;
  const creditsShort = !userProfile.isAdmin && userProfile.credits < pawprintCost;
  const creditsNeeded = Math.max(0, pawprintCost - userProfile.credits);

  // PP-10: inline, per-field validation with visible messages, instead of
  // free-text country/state that only fails at server submission.
  const shippingErrors: Partial<Record<keyof ShippingForm, string>> = {};
  if (!shipping.name.trim()) shippingErrors.name = "Enter the recipient's full name.";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(shipping.email.trim())) shippingErrors.email = "Enter a valid email address.";
  if (!shipping.address1.trim()) shippingErrors.address1 = "Enter a street address.";
  if (!shipping.city.trim()) shippingErrors.city = "Enter a city.";
  if (!SUPPORTED_COUNTRIES.some((country) => country.code === shipping.country_code)) shippingErrors.country_code = "Choose a shipping country.";
  const regionOptions = REGIONS_BY_COUNTRY[shipping.country_code];
  if (regionOptions && !regionOptions.some((region) => region.code === shipping.state_code)) {
    shippingErrors.state_code = "Choose a state or province.";
  }
  if (!shipping.zip.trim()) shippingErrors.zip = "Enter a postal code.";
  const shippingValid = Object.keys(shippingErrors).length === 0;
  const shippingFieldError = (field: keyof ShippingForm) => (shippingTouched[field] ? shippingErrors[field] : undefined);
  const markShippingTouched = (field: keyof ShippingForm) =>
    setShippingTouched((current) => (current[field] ? current : { ...current, [field]: true }));

  const chooseTemplate = (item: PawprintTemplate) => {
    setTemplate(item);
    setTitle(item.name);
    setMessage(item.sampleCopy[0] || "Made with love.");
    setVariation("classic");
    setResultUrl("");
    setSavedCreationId(null);
  };

  const choosePhotos = async (files: File[]) => {
    setError("");
    const remaining = MAX_PAWPRINT_PHOTOS - photos.length;
    if (remaining < 1) return setError(`A Pawprint can contain up to ${MAX_PAWPRINT_PHOTOS} photos.`);
    const accepted = files.slice(0, remaining);
    try {
      const prepared: StudioPhoto[] = [];
      // Sequential work is intentional: decoding many large photos in parallel
      // can exceed the memory ceiling on iOS and lower-end Android devices.
      for (const file of accepted) prepared.push(await preparePhoto(file));
      setPhotos((current) => [...current, ...prepared]);
      setResultUrl("");
    } catch (caught: any) {
      setError(caught.message || "The photo could not be opened.");
    }
  };

  const movePhoto = (index: number, direction: -1 | 1) => {
    setPhotos((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const save = async () => {
    if (!template) return;
    const submittedDesignSignature = designSignature;
    setBusy(true); setError(""); setResultUrl(""); setSavedCreationId(null);
    try {
      const renderedImage = await renderPawprint({ variation, photos, title: title.trim() || template.name, message: message.trim(), category });
      const fields: Record<string, string> = {};
      for (const field of template.fieldSchema) {
        if (field.type === "image") fields[field.key] = "";
        else if (/name|title/i.test(field.key)) fields[field.key] = title.trim();
        else fields[field.key] = message.trim();
      }
      const idempotencyKey = crypto.randomUUID();
      const response = await authedFetch("/api/pawprints/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          category,
          layoutId: template.layoutId,
          fields,
          customName: title.trim(),
          customMessage: message.trim(),
          renderedImage,
          photoBase64: category === "historic_portraits" ? photos[0]?.dataUrl : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The Pawprint could not be saved.");
      if (liveDesignSignatureRef.current !== submittedDesignSignature) {
        await onCreationSaved?.();
        if (data.user) onUserUpdate(data.user);
        throw new Error("Your design changed while it was saving. Save the updated design before sending or printing it.");
      }
      setResultUrl(data.url);
      setSavedCreationId(Number(data.creationId) || null);
      await onCreationSaved?.();
      if (data.user) onUserUpdate(data.user);
    } catch (caught: any) {
      setError(caught.message || "The Pawprint could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const submitPrintOrder = async () => {
    if (!savedCreationId || !printProductCode) return;
    setPrintBusy(true);
    setPrintOrder(null);
    setError("");
    try {
      const response = await authedFetch("/api/pawprints/printful-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ creationId: savedCreationId, productCode: printProductCode, quantity: 1, recipient: shipping }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The print order could not be created.");
      if (data.checkoutUrl) {
        window.location.assign(String(data.checkoutUrl));
        return;
      }
      setPrintOrder({ id: String(data.order?.id || data.order?.provider_order_id || ""), status: String(data.order?.status || "draft") });
    } catch (caught: any) {
      setError(caught.message || "The print order could not be created.");
    } finally {
      setPrintBusy(false);
    }
  };

  const selectedPrintProduct = printableProducts.find((item) => item.code === printProductCode);

  /**
   * PP-12: signed-out visitors could build an entire design and only discover
   * the sign-in wall at the final step. Say it up front, non-blocking — the
   * whole design flow still works without an account.
   */
  const signInNotice = !userProfile.email && !signInNoticeDismissed ? (
    <div className="mb-6 flex items-start gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-3 text-sm">
      <PawPrint size={18} className="mt-0.5 shrink-0 text-primary" />
      <p className="flex-1 font-semibold text-on-surface">
        Free to design — <a href="/sign-up" className="underline">sign in</a> when you're ready to save, download, or print.
      </p>
      <button type="button" onClick={() => setSignInNoticeDismissed(true)} aria-label="Dismiss sign-in notice" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-on-surface-variant hover:bg-on-surface/10">
        <X size={15} />
      </button>
    </div>
  ) : null;

  // Step 1: choose the keepsake first, in plain customer language.
  if (!intent) return (
    <main className="mx-auto w-full max-w-4xl px-4 pb-28 pt-8">
      <WizardSteps steps={wizardSteps} activeIndex={activeStepIndex} onSelect={goToStep} />
      {signInNotice}
      <div className="mb-8 max-w-2xl"><p className="text-xs font-black uppercase tracking-[.2em] text-primary">Historic Pawprints</p><h1 className="mt-2 text-3xl font-black text-on-surface">How will you celebrate your pet?</h1><p className="mt-2 text-on-surface-variant">Choose a portrait you can share online, or a physical keepsake delivered to your door.</p></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <button type="button" onClick={() => { setIntent("digital"); setCategory("historic_portraits"); }} className="group rounded-3xl border-2 border-outline-variant/40 bg-surface p-8 text-left transition hover:-translate-y-1 hover:border-primary/60">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-primary/10 text-primary"><Sparkles size={30} /></span>
          <strong className="mt-4 block text-xl font-black">Historic Pawprint Pet Digital</strong>
          <span className="mt-2 block text-sm leading-relaxed text-on-surface-variant">Turn your photo into a famous portrait to save, download, share, or email.</span>
        </button>
        <button type="button" onClick={() => { if (digitalPrintedAvailable) { setIntent("digital-printed"); setCategory("historic_portraits"); } }} disabled={!digitalPrintedAvailable} className="group rounded-3xl border-2 border-outline-variant/40 bg-surface p-8 text-left transition enabled:hover:-translate-y-1 enabled:hover:border-primary/60 disabled:cursor-not-allowed disabled:opacity-55">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-primary/10 text-primary"><Printer size={30} /></span>
          <strong className="mt-4 block text-xl font-black">Pawprint Pet Physical</strong>
          <span className="mt-2 block text-sm leading-relaxed text-on-surface-variant">{digitalPrintedAvailable ? "Create a historic pet portrait and order it as a lasting printed keepsake." : "Physical ordering will appear here as soon as the configured print size is available."}</span>
        </button>
      </div>
    </main>
  );

  // Step 2: choose one title from a compact click-through control. The master
  // image shows the visual range without turning the page into twenty cards.
  if (!template) return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-28 pt-8">
      <WizardSteps steps={wizardSteps} activeIndex={activeStepIndex} onSelect={goToStep} />
      {signInNotice}
      <button onClick={() => { setIntent(""); setCategory(""); }} className="mb-6 flex min-h-11 items-center gap-2 text-sm font-black text-primary"><ChevronLeft size={18} /> Keepsake type</button>
      <p className="text-xs font-black uppercase tracking-[.2em] text-primary">Historic Pawprints</p>
      <h1 className="mt-2 text-3xl font-black text-on-surface">Choose a portrait title</h1>
      <p className="mt-2 max-w-2xl text-on-surface-variant">Pick the role first — tap any portrait. On the next screen, add the pet photo that the portrait should preserve.</p>

      {/* PP-2: a searchable, thumbnail-backed grid replaces a flat twenty-item
          <select> plus a decorative, non-interactive contact sheet. Each card
          IS the picture the customer was previously only allowed to look at. */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <label htmlFor="historic-role-search" className="sr-only">Search portrait titles</label>
        <input
          id="historic-role-search"
          type="search"
          value={roleQuery}
          onChange={(event) => setRoleQuery(event.target.value)}
          placeholder="Search titles…"
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-outline-variant bg-surface px-3 text-sm font-semibold"
        />
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => setRoleGroup("")} aria-pressed={roleGroup === ""} className={`min-h-11 rounded-full border px-3 text-xs font-black transition ${roleGroup === "" ? "border-primary bg-primary text-on-primary" : "border-outline-variant text-on-surface-variant hover:border-primary/60"}`}>All</button>
          {ROLE_GROUPS.map((group) => {
            const available = categoryTemplates.some((item) => group.ids.includes(item.layoutId));
            if (!available) return null;
            return (
              <button key={group.id} type="button" onClick={() => setRoleGroup((current) => (current === group.id ? "" : group.id))} aria-pressed={roleGroup === group.id} className={`min-h-11 rounded-full border px-3 text-xs font-black transition ${roleGroup === group.id ? "border-primary bg-primary text-on-primary" : "border-outline-variant text-on-surface-variant hover:border-primary/60"}`}>
                {group.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* PP-11: loading skeletons and a retry, rather than an empty control. */}
      {templatesLoading ? (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="animate-pulse overflow-hidden rounded-2xl border border-outline-variant/30">
              <div className="aspect-square bg-surface-container" />
              <div className="h-9 bg-surface-container-low" />
            </div>
          ))}
        </div>
      ) : templatesError ? (
        <div className="mt-6 rounded-2xl border border-error/30 bg-error/10 p-4 text-sm font-bold text-error">
          {templatesError}
          <button type="button" onClick={() => setTemplatesReloadToken((token) => token + 1)} className="mt-3 block min-h-11 rounded-xl border border-error/40 px-4 font-black">Retry</button>
        </div>
      ) : visibleRoleTemplates.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4 text-sm font-semibold text-on-surface-variant">
          No portrait title matches “{roleQuery}”. <button type="button" onClick={() => { setRoleQuery(""); setRoleGroup(""); }} className="underline">Clear filters</button>
        </p>
      ) : (
        <>
          <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {visibleRoleTemplates.map((item) => {
              const sheetStyle = roleSheetStyle(item.layoutId);
              return (
                <li key={item.layoutId}>
                  <button
                    type="button"
                    onClick={() => chooseTemplate(item)}
                    className="group w-full overflow-hidden rounded-2xl border-2 border-outline-variant/40 bg-surface text-left transition hover:-translate-y-0.5 hover:border-primary focus-visible:border-primary"
                  >
                    <span
                      role="img"
                      aria-label={`${item.name} portrait example`}
                      className="block aspect-square w-full bg-surface-container bg-cover"
                      style={sheetStyle}
                    />
                    <span className="block px-3 py-2.5">
                      <strong className="block text-sm font-black leading-tight text-on-surface">{item.name}</strong>
                      <small className="mt-0.5 block line-clamp-2 text-[11px] leading-snug text-on-surface-variant">{item.tone}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {hiddenRoleCount > 0 && (
            <button type="button" onClick={() => setShowAllRoles(true)} className="mt-4 min-h-12 w-full rounded-2xl border border-primary px-4 font-black text-primary sm:w-auto sm:px-8">
              See all {filteredRoleTemplates.length} titles
            </button>
          )}
        </>
      )}
    </main>
  );

  // Step 3: add the pet photo after choosing the portrait title.
  if (!photosConfirmed) return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-28 pt-8">
      <WizardSteps steps={wizardSteps} activeIndex={activeStepIndex} onSelect={goToStep} />
      {signInNotice}
      <button onClick={() => setTemplate(null)} className="mb-6 flex min-h-11 items-center gap-2 text-sm font-black text-primary"><ChevronLeft size={18} /> Portrait title</button>
      {/* PP-5: a full marketing hero (mb-12 + p-8/p-16) used to sit here,
          pushing "Choose your pet's photo" most of a viewport down on mobile.
          The same message now lives in the dismissible PP-12 sign-in notice at
          the top of the flow, where it does not interrupt the wizard. */}
      <div className="mb-8 max-w-2xl"><p className="text-xs font-black uppercase tracking-[.2em] text-primary">{template.name}</p><h1 className="mt-2 text-3xl font-black text-on-surface">Choose your pet's photo</h1><p className="mt-2 text-on-surface-variant">A clear photo facing the camera gives the image generator the best chance of preserving your pet's face, markings, and expression.</p></div>
      <button type="button" onClick={() => photoInput.current?.click()} className="min-h-64 w-full overflow-hidden rounded-3xl border-2 border-dashed border-outline-variant bg-surface-container-low transition hover:border-primary">
        <span className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center">
          <ImagePlus size={40} className="text-primary" />
          <strong className="text-lg">Upload or choose a photo</strong>
          <small className="text-on-surface-variant">PNG, JPEG, or WebP · up to 20 MB each · minimum 600 × 600</small>
        </span>
      </button>
      <input ref={photoInput} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); if (files.length) void choosePhotos(files); event.target.value = ""; }} />
      {photos.length > 0 && (
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((photo) => (
            <div key={photo.id} className="group relative aspect-square overflow-hidden rounded-xl border border-outline-variant">
              <img src={photo.dataUrl} alt={photo.name} className="h-full w-full object-cover" />
              <button type="button" onClick={() => setPhotos((current) => current.filter((item) => item.id !== photo.id))} aria-label={`Remove ${photo.name}`} className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/65 text-white"><X size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="mt-4 rounded-xl bg-error/10 p-3 text-sm font-bold text-error">{error}</p>}
      <button type="button" onClick={() => setPhotosConfirmed(true)} disabled={photos.length === 0} className="mt-6 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-6 font-black text-on-primary disabled:opacity-40 sm:w-auto">
        Continue <ArrowRight size={18} />
      </button>
    </main>
  );

  return (
    <main className="mx-auto w-full max-w-[1500px] px-3 pb-28 pt-4 sm:px-5">
      <WizardSteps steps={wizardSteps} activeIndex={activeStepIndex} onSelect={goToStep} />
      {signInNotice}
      <header className="mb-4 flex items-center gap-3 border-b border-outline-variant/30 pb-4"><button onClick={() => setTemplate(null)} className="grid h-11 w-11 place-items-center rounded-full border border-outline-variant" aria-label="Back to portrait titles"><ChevronLeft size={19} /></button><div><p className="text-xs font-bold text-primary">{CATEGORY_META[category]?.label}</p><h1 className="font-black text-on-surface">{template.name}</h1></div><span className="ml-auto hidden text-xs font-bold text-on-surface-variant sm:block">Select a variation, then save</span></header>
      {/* PP-7: the layout only became multi-column at lg (>=1024px), so every
          tablet between 760px and 1023px got one tall single-column scroll and
          lost the icon rail entirely. A md two-column step sits in between. */}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_320px] lg:grid-cols-[72px_minmax(0,1fr)_360px]">
        {/* PP-8: the rail is now md-and-up rather than lg-only, and "Layouts"
            scrolls to the variations section instead of being an inert label
            styled to look like a button. */}
        <nav className="hidden rounded-2xl border border-outline-variant/30 bg-surface p-2 lg:block"><button onClick={() => photoInput.current?.click()} className="mb-2 flex w-full flex-col items-center gap-1 rounded-xl py-3 text-[10px] font-black hover:bg-primary/10"><ImagePlus size={20} />Photo</button><button onClick={() => document.getElementById("pawprint-text")?.focus()} className="mb-2 flex w-full flex-col items-center gap-1 rounded-xl py-3 text-[10px] font-black hover:bg-primary/10"><Type size={20} />Text</button><button onClick={() => variationsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} className="flex w-full flex-col items-center gap-1 rounded-xl bg-primary/10 py-3 text-[10px] font-black text-primary"><LayoutGrid size={20} />Layouts</button></nav>
        <div className="space-y-4 md:col-start-1 lg:col-start-2">
          {/* PP-1: the live preview. Renders the real pipeline at preview
              resolution so the customer sees typography, colour grading,
              gradient overlays and the inset frame BEFORE paying. */}
          <section className="rounded-3xl border border-outline-variant/30 bg-surface p-3 sm:p-5">
            <div className="mb-3 flex items-center gap-2">
              <Sparkles size={18} className="text-primary" />
              <h2 className="font-black">Live preview</h2>
              {previewRendering && <Loader2 size={15} className="animate-spin text-primary" aria-label="Updating preview" />}
              <span className="ml-auto text-xs font-bold text-on-surface-variant">Updates as you edit</span>
            </div>
            <div className="mx-auto aspect-[4/5] w-full max-w-sm overflow-hidden rounded-2xl border border-outline-variant/40 bg-surface-container-low">
              {previewUrl ? (
                <img src={previewUrl} alt={`Live preview of "${title || template.name}"`} className="h-full w-full object-contain" />
              ) : (
                <div className="grid h-full w-full place-items-center text-xs font-bold text-on-surface-variant" aria-busy={previewRendering}>
                  {previewError || (previewRendering ? "Drawing your Pawprint…" : "Your preview will appear here.")}
                </div>
              )}
            </div>
            {previewError && <p role="alert" className="mt-2 text-center text-xs font-bold text-error">{previewError}</p>}
            <p className="mt-2 text-center text-[11px] text-on-surface-variant">Preview only — saving renders the full {FULL_PRINT_WIDTH} × {FULL_PRINT_HEIGHT} print file.</p>
          </section>
          <section ref={variationsSectionRef} id="pawprint-variations" className="rounded-3xl bg-surface-container-low p-3 sm:p-6"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-black">Choose a variation</h2><p className="text-xs text-on-surface-variant">Your photos and words stay the same.</p></div><span className="rounded-full bg-surface px-3 py-1 text-xs font-black">{VARIATIONS.length} options</span></div><div className="grid grid-cols-2 gap-2 sm:gap-4">{VARIATIONS.map((item) => <VariationPreview key={item.id} variation={item.id} selected={variation === item.id} photos={photos} title={title || "Your title"} message={message || "Your message"} category={category} onSelect={() => setVariation(item.id)} />)}</div></section>
        </div>
        <aside className="space-y-4 md:col-start-2 lg:col-start-3">
          <section className="rounded-3xl border border-outline-variant/30 bg-surface p-5"><div className="mb-3 flex items-center gap-2"><ImagePlus size={18} className="text-primary" /><h2 className="font-black">Photos</h2><span className="ml-auto text-xs font-black text-primary">{photos.length}/{MAX_PAWPRINT_PHOTOS}</span></div><button type="button" onClick={() => photoInput.current?.click()} className="min-h-40 w-full overflow-hidden rounded-2xl border-2 border-dashed border-outline-variant bg-surface-container-low transition hover:border-primary"><span className="flex min-h-40 flex-col items-center justify-center gap-2 p-6 text-center"><ImagePlus size={30} className="text-primary" /><strong>Add photos</strong><small className="text-on-surface-variant">Multiple PNG, JPEG, or WebP files · up to 20 MB each<br />Minimum 600 × 600 · large images optimize automatically</small></span></button><input ref={photoInput} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); if (files.length) void choosePhotos(files); event.target.value = ""; }} />{photos.length > 0 && <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{photos.map((photo, index) => <div key={photo.id} className="group relative aspect-square overflow-hidden rounded-xl border border-outline-variant"><img src={photo.dataUrl} alt={photo.name} className="h-full w-full object-cover" /><button type="button" onClick={() => setPhotos((current) => current.filter((item) => item.id !== photo.id))} aria-label={`Remove ${photo.name}`} className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/65 text-white"><X size={14} /></button>{/* PP-15: 28px controls sat below the 44x44 touch-target guideline and
    overlapped the thumbnail. They now sit in their own strip beneath the
    image at 40px, and the grid drops to two columns on the smallest
    screens so the thumbnails themselves are tappable. */}
<div className="absolute inset-x-0 bottom-0 flex justify-between bg-gradient-to-t from-black/70 to-transparent p-1"><button type="button" disabled={index === 0} onClick={() => movePhoto(index, -1)} aria-label={`Move ${photo.name} earlier`} className="grid h-10 w-10 place-items-center rounded-full bg-black/70 text-white disabled:opacity-30"><ArrowLeft size={16} /></button><button type="button" disabled={index === photos.length - 1} onClick={() => movePhoto(index, 1)} aria-label={`Move ${photo.name} later`} className="grid h-10 w-10 place-items-center rounded-full bg-black/70 text-white disabled:opacity-30"><ArrowRight size={16} /></button></div></div>)}</div>}</section>
          <section className="rounded-3xl border border-outline-variant/30 bg-surface p-5"><div className="mb-3 flex items-center gap-2"><Type size={18} className="text-primary" /><h2 className="font-black">Your words</h2></div><label className="text-xs font-bold text-on-surface-variant">Title</label><input id="pawprint-text" value={title} maxLength={TITLE_MAX_LENGTH} onChange={(event) => setTitle(event.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-outline-variant bg-surface-container px-3" /><p className="mt-1 text-right text-[10px] text-on-surface-variant">{title.length}/{TITLE_MAX_LENGTH}</p><label className="mt-2 block text-xs font-bold text-on-surface-variant">Message</label><textarea value={message} maxLength={MESSAGE_MAX_LENGTH} rows={4} onChange={(event) => setMessage(event.target.value)} className="mt-1 w-full resize-none rounded-xl border border-outline-variant bg-surface-container p-3" /><p className="mt-1 text-right text-[10px] text-on-surface-variant">{message.length}/{MESSAGE_MAX_LENGTH}</p></section>
          {error && <p className="rounded-xl bg-error/10 p-3 text-sm font-bold text-error">{error}</p>}
          {resultUrl && <>
            <a href={resultUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-primary font-black text-primary"><Download size={17} /> Open finished Pawprint</a>
            <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4">
              <label className="text-xs font-black text-on-surface-variant">Send this Pawprint by email</label>
              <div className="mt-2 flex gap-2"><input type="email" value={recipientEmail} onChange={(event) => setRecipientEmail(event.target.value)} placeholder="friend@example.com" className="min-h-11 min-w-0 flex-1 rounded-xl border border-outline-variant bg-surface px-3 text-sm" /><button type="button" disabled={sending || !savedCreationId || !recipientEmail.trim()} onClick={async () => { setSending(true); setError(""); try { const response = await authedFetch("/api/pawprints/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ creationId: savedCreationId, email: recipientEmail }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not send the Pawprint."); setRecipientEmail(""); } catch (caught: any) { setError(caught.message || "Could not send the Pawprint."); } finally { setSending(false); } }} className="min-h-11 rounded-xl bg-primary px-4 text-xs font-black text-on-primary disabled:opacity-40">{sending ? "Sending…" : "Send"}</button></div>
              <p className="mt-2 text-[10px] text-on-surface-variant">The email includes the ${CREDIT_PRICES.PAWPRINT} PupCoins creation price.</p>
            </div>
            {/* Only shown when the shopper chose "Digital + Printed" up front.
                Print format options are pre-filtered to printableProducts —
                orderable Printful variants whose aspect matches this Pawprint's
                fixed canvas — so every option here is a digital template that
                genuinely matches its printed product. */}
            {intent === "digital-printed" && <div className="rounded-2xl border border-primary/25 bg-surface-container-low p-4">
              <div className="flex items-center gap-2"><Printer size={17} className="text-primary" /><h2 className="text-sm font-black">Order a physical Pawprint</h2></div>
              {printProductsLoading ? (
                <div className="mt-3 space-y-2" aria-busy="true">
                  <div className="h-4 w-24 animate-pulse rounded bg-surface-container" />
                  <div className="h-11 w-full animate-pulse rounded-xl bg-surface-container" />
                </div>
              ) : printProductsError ? (
                <div className="mt-3 rounded-xl border border-error/30 bg-error/10 p-3 text-xs font-bold text-error">
                  {printProductsError}
                  <button type="button" onClick={() => setPrintProductsReloadToken((token) => token + 1)} className="mt-2 block min-h-11 rounded-lg border border-error/40 px-3 font-black">Retry</button>
                </div>
              ) : digitalPrintedAvailable ? <>
                <label htmlFor="pawprint-print-format" className="mt-3 block text-xs font-bold text-on-surface-variant">Print format</label>
                <select id="pawprint-print-format" value={printProductCode} onChange={(event) => setPrintProductCode(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-outline-variant bg-surface px-3 text-sm">
                  {printableProducts.map((product) => <option key={product.code} value={product.code}>{product.label}{product.priceCents ? ` · $${(product.priceCents / 100).toFixed(2)}` : ""}</option>)}
                </select>
                {selectedPrintProduct && <p className="mt-1 text-[10px] text-on-surface-variant">{selectedPrintProduct.description} · {selectedPrintProduct.widthIn} × {selectedPrintProduct.heightIn} in · a separate 300-DPI print file will be prepared.</p>}
                {/* PP-10: real <label>/<input> pairs (there were none — only
                    aria-label + placeholder, so the field name vanished as
                    soon as you typed), country and region as selects instead
                    of unvalidated free-text 2-char inputs, and inline error
                    text per field rather than a server rejection at submit. */}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {([
                    { field: "name" as const, label: "Full name", type: "text", span: true, autoComplete: "name" },
                    { field: "email" as const, label: "Email", type: "email", span: true, autoComplete: "email" },
                    { field: "address1" as const, label: "Street address", type: "text", span: true, autoComplete: "street-address" },
                    { field: "city" as const, label: "City", type: "text", span: false, autoComplete: "address-level2" },
                  ]).map(({ field, label, type, span, autoComplete }) => (
                    <div key={field} className={span ? "col-span-2" : ""}>
                      <label htmlFor={`pawprint-ship-${field}`} className="block text-[11px] font-black text-on-surface-variant">{label}</label>
                      <input
                        id={`pawprint-ship-${field}`}
                        type={type}
                        autoComplete={autoComplete}
                        value={shipping[field]}
                        onChange={(event) => setShipping((current) => ({ ...current, [field]: event.target.value }))}
                        onBlur={() => markShippingTouched(field)}
                        aria-invalid={shippingFieldError(field) ? true : undefined}
                        aria-describedby={shippingFieldError(field) ? `pawprint-ship-${field}-error` : undefined}
                        className={`mt-1 min-h-11 w-full rounded-xl border bg-surface px-3 text-sm ${shippingFieldError(field) ? "border-error" : "border-outline-variant"}`}
                      />
                      {shippingFieldError(field) && <p id={`pawprint-ship-${field}-error`} className="mt-1 text-[11px] font-bold text-error">{shippingFieldError(field)}</p>}
                    </div>
                  ))}

                  <div>
                    <label htmlFor="pawprint-ship-country" className="block text-[11px] font-black text-on-surface-variant">Country</label>
                    <select
                      id="pawprint-ship-country"
                      autoComplete="country"
                      value={shipping.country_code}
                      onChange={(event) => {
                        const nextCountry = event.target.value;
                        // Region codes are country-specific; a stale code from
                        // the previous country would silently fail at Printful.
                        setShipping((current) => ({ ...current, country_code: nextCountry, state_code: "" }));
                        markShippingTouched("country_code");
                      }}
                      aria-invalid={shippingFieldError("country_code") ? true : undefined}
                      className={`mt-1 min-h-11 w-full rounded-xl border bg-surface px-3 text-sm ${shippingFieldError("country_code") ? "border-error" : "border-outline-variant"}`}
                    >
                      {SUPPORTED_COUNTRIES.map((country) => <option key={country.code} value={country.code}>{country.label}</option>)}
                    </select>
                    {shippingFieldError("country_code") && <p className="mt-1 text-[11px] font-bold text-error">{shippingFieldError("country_code")}</p>}
                  </div>

                  <div>
                    <label htmlFor="pawprint-ship-state" className="block text-[11px] font-black text-on-surface-variant">
                      {shipping.country_code === "CA" ? "Province" : "State"}
                    </label>
                    {regionOptions ? (
                      <select
                        id="pawprint-ship-state"
                        autoComplete="address-level1"
                        value={shipping.state_code}
                        onChange={(event) => setShipping((current) => ({ ...current, state_code: event.target.value }))}
                        onBlur={() => markShippingTouched("state_code")}
                        aria-invalid={shippingFieldError("state_code") ? true : undefined}
                        className={`mt-1 min-h-11 w-full rounded-xl border bg-surface px-3 text-sm ${shippingFieldError("state_code") ? "border-error" : "border-outline-variant"}`}
                      >
                        <option value="">Select…</option>
                        {regionOptions.map((region) => <option key={region.code} value={region.code}>{region.label}</option>)}
                      </select>
                    ) : (
                      <input
                        id="pawprint-ship-state"
                        autoComplete="address-level1"
                        value={shipping.state_code}
                        onChange={(event) => setShipping((current) => ({ ...current, state_code: event.target.value }))}
                        placeholder="Not required"
                        className="mt-1 min-h-11 w-full rounded-xl border border-outline-variant bg-surface px-3 text-sm"
                      />
                    )}
                    {shippingFieldError("state_code") && <p className="mt-1 text-[11px] font-bold text-error">{shippingFieldError("state_code")}</p>}
                  </div>

                  <div className="col-span-2">
                    <label htmlFor="pawprint-ship-zip" className="block text-[11px] font-black text-on-surface-variant">Postal code</label>
                    <input
                      id="pawprint-ship-zip"
                      autoComplete="postal-code"
                      value={shipping.zip}
                      onChange={(event) => setShipping((current) => ({ ...current, zip: event.target.value }))}
                      onBlur={() => markShippingTouched("zip")}
                      aria-invalid={shippingFieldError("zip") ? true : undefined}
                      className={`mt-1 min-h-11 w-full rounded-xl border bg-surface px-3 text-sm ${shippingFieldError("zip") ? "border-error" : "border-outline-variant"}`}
                    />
                    {shippingFieldError("zip") && <p className="mt-1 text-[11px] font-bold text-error">{shippingFieldError("zip")}</p>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (!shippingValid) {
                      // Reveal every outstanding problem at once rather than
                      // one blur at a time.
                      setShippingTouched({ name: true, email: true, address1: true, city: true, state_code: true, country_code: true, zip: true });
                      return;
                    }
                    void submitPrintOrder();
                  }}
                  disabled={printBusy || !savedCreationId}
                  aria-disabled={!shippingValid || undefined}
                  title={!shippingValid ? "Complete the shipping details first" : undefined}
                  className={`mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-black text-on-primary disabled:cursor-not-allowed disabled:opacity-40 ${!shippingValid ? "opacity-60" : ""}`}
                >{printBusy ? <Loader2 size={17} className="animate-spin" /> : <Printer size={17} />}{printBusy ? "Preparing print…" : printOrderMode === "payment" ? "Price & secure checkout" : "Create print order"}</button>
                {printOrder && <p className="mt-2 rounded-xl bg-primary/10 p-3 text-xs font-bold text-primary">Printful order {printOrder.id || "created"} · {printOrder.status}. You can return to this order from your FurBin.</p>}
                <p className="mt-2 text-[10px] text-on-surface-variant">The print file is prepared at 300 DPI. Printful receives a draft first; it enters production only after Stripe confirms your payment.</p>
              </> : <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs font-bold text-amber-700">Physical Pawprint ordering just became unavailable for this format — your finished digital Pawprint is ready to download and email right now.</p>}
            </div>}
          </>}
          {/* PP-7: on narrow screens the primary CTA could scroll off-screen
              entirely. Sticking it to the bottom keeps Save reachable at any
              scroll position. PP-4: when credits are short the CTA is no
              longer a silent greyed-out button — it becomes an enabled,
              explicit "you need N more PupCoins" action. */}
          <div className="sticky bottom-4 z-20 space-y-2 rounded-2xl bg-surface/85 p-2 backdrop-blur md:static md:bg-transparent md:p-0 md:backdrop-blur-none">
            {!userProfile.email ? (
              <button onClick={() => { window.location.href = "/sign-up"; }} className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 font-black text-on-primary">Sign In to Save Pawprint</button>
            ) : creditsShort ? (
              <>
                <button onClick={onOpenCreditStore} className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 font-black text-on-primary">
                  You need {creditsNeeded} more PupCoin{creditsNeeded === 1 ? "" : "s"} — Get coins
                </button>
                <p className="text-center text-[11px] font-semibold text-on-surface-variant">
                  Saving this Pawprint costs {pawprintCost} PupCoins. You have {userProfile.credits}.
                </p>
              </>
            ) : (
              <button onClick={() => void save()} disabled={busy} title={busy ? "Saving your Pawprint…" : undefined} className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 font-black text-on-primary disabled:opacity-40">{busy ? <Loader2 className="animate-spin" size={19} /> : <Sparkles size={19} />}{busy ? "Saving…" : `Save selected variation · ${pawprintCost} PupCoins`}</button>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
