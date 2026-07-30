import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronLeft, Download, ImagePlus, LayoutGrid, Loader2, PawPrint, Printer, Sparkles, Type, X } from "lucide-react";
import type { Creation, PublicUser, UserProfile } from "../types";
import { authedFetch } from "../api";
import { CREDIT_PRICES } from "../pricing";
import { MAX_PAWPRINT_PHOTOS, planPawprintCollage, type PawprintLayoutId } from "../pawprints/collageEngine";
import { renderPhotosWebGL2 } from "../pawprints/gpuCompositor";

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

const PRINT_WIDTH = 2400;
const PRINT_HEIGHT = 3000;
const CANVAS_ASPECT = PRINT_WIDTH / PRINT_HEIGHT;

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
  input: { title: string; message: string; x: number; y: number; width: number; height: number; color: string },
) {
  const padding = Math.max(20, Math.min(56, input.width * 0.045));
  const maxWidth = Math.max(40, input.width - padding * 2);
  const maxHeight = Math.max(40, input.height - padding * 2);
  const compact = input.width < 1040 || input.height < 460;
  const baseTitleSize = compact ? 108 : 152;
  const baseMessageSize = compact ? 68 : 86;
  let scale = 1;
  let titleLines: string[] = [];
  let messageLines: string[] = [];
  let titleSize = baseTitleSize;
  let messageSize = baseMessageSize;
  let titleLineHeight = titleSize * 1.08;
  let messageLineHeight = messageSize * 1.25;
  let gap = 0;

  for (; scale >= 0.28; scale -= 0.04) {
    titleSize = Math.max(14, Math.round(baseTitleSize * scale));
    messageSize = Math.max(11, Math.round(baseMessageSize * scale));
    titleLineHeight = titleSize * 1.08;
    messageLineHeight = messageSize * 1.25;
    gap = input.title.trim() && input.message.trim() ? Math.max(6, messageSize * 0.45) : 0;
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
}): Promise<string> {
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
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
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
    ctx.lineWidth = 48;
    ctx.strokeRect(120, 120, PRINT_WIDTH - 240, PRINT_HEIGHT - 240);
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
  });
  try {
    const result = await canvasDataUrl(canvas, "image/webp", 0.92);
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
      <div className="relative aspect-[4/5] overflow-hidden rounded-xl" style={{ background: palette[0], color: palette[2] }}>
        {plan.insetFrame && <div className="absolute inset-3 border-[6px]" style={{ borderColor: palette[1] }} />}
        {photos.map((photo, index) => { const rect = plan.photos[index]; const borderRadius = rect?.shape === "circle" ? "50%" : rect?.shape === "arch" ? "50% 50% 8% 8%" : undefined; return rect ? <div key={photo.id} className="absolute bg-cover bg-center" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`, backgroundImage: `url(${photo.dataUrl})`, borderRadius }} /> : null; })}
        {plan.textOverlay && <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />}
        <div className={`absolute overflow-hidden ${plan.textOverlay ? "text-white" : ""}`} style={{ left: `${plan.text.x * 100}%`, top: `${plan.text.y * 100}%`, width: `${plan.text.width * 100}%`, height: `${plan.text.height * 100}%` }}><strong className="block font-serif text-base leading-tight">{title}</strong><span className="mt-2 block line-clamp-4 text-[9px]">{message}</span></div>
        {photos.length === 0 && <span className="pointer-events-none absolute right-3 top-2 text-5xl opacity-15">{CATEGORY_META[category]?.symbol || "🐾"}</span>}
        {selected && <span className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-primary text-on-primary"><Check size={15} /></span>}
      </div>
      <span className="mt-2 block px-1 text-xs font-black text-on-surface">{label}</span>
    </button>
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

  useEffect(() => {
    fetch("/api/pawprints/templates").then((response) => response.json()).then((data) => {
      setCategories(Array.isArray(data.categories) ? data.categories : []);
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
    }).catch(() => setError("Pawprint templates could not be loaded."));
  }, []);

  useEffect(() => {
    fetch("/api/pawprints/print-products").then((response) => response.json()).then((data) => {
      const products = Array.isArray(data.products) ? data.products : [];
      setPrintProducts(products);
      const firstPrintable = products.find((item: PawprintPrintProduct) => item.orderable === true && matchesCanvasAspect(item));
      setPrintProductCode((current) => current || firstPrintable?.code || products[0]?.code || "");
      setPrintOrderMode(data.orderMode === "payment" ? "payment" : "draft");
      setPrintAvailable(data.available === true);
    }).catch(() => { setPrintProducts([]); setPrintAvailable(false); });
  }, []);

  const categoryTemplates = useMemo(() => templates.filter((item) => item.category === category), [templates, category]);

  // Products actually usable for the Digital + Printed flow: server-owned
  // (orderable) AND close enough in aspect to the fixed Pawprint canvas that
  // the printed copy matches the digital design instead of cropping it.
  const printableProducts = useMemo(
    () => printProducts.filter((item) => item.orderable === true && matchesCanvasAspect(item)),
    [printProducts],
  );
  const digitalPrintedAvailable = printAvailable && printableProducts.length > 0;

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
        body: JSON.stringify({ category, layoutId: template.layoutId, fields, customName: title.trim(), customMessage: message.trim(), renderedImage }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The Pawprint could not be saved.");
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

  // Step 1: photo first. Everything downstream (occasion, layout, print
  // format) is chosen around the photo, not the other way around.
  if (!photosConfirmed) return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-28 pt-8">
      {!userProfile.email && (
        <section className="mb-12 overflow-hidden rounded-3xl bg-primary/5 p-8 text-center sm:p-16">
          <h1 className="text-4xl font-black text-on-surface">Personalized Pawprints Pet Art</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-on-surface-variant">Create digital and printable pet keepsakes with your photos, message, and chosen occasion. Sign in to save and print your designs.</p>
        </section>
      )}
      <div className="mb-8 max-w-2xl"><p className="text-xs font-black uppercase tracking-[.2em] text-primary">Pawprints Studio</p><h1 className="mt-2 text-3xl font-black text-on-surface">Add your photo</h1><p className="mt-2 text-on-surface-variant">Upload or choose the photo you want to feature. You can add a few more once you're in the editor.</p></div>
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

  // Step 2: two stylized paw buttons — digital-only, or digital + printed.
  // The printed option is only offered when a real, orderable Printful
  // product exists that matches the Pawprint's fixed canvas aspect ratio.
  if (!intent) return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-28 pt-8">
      <button onClick={() => setPhotosConfirmed(false)} className="mb-6 flex min-h-11 items-center gap-2 text-sm font-black text-primary"><ChevronLeft size={18} /> Photo</button>
      <div className="mb-8 max-w-2xl"><p className="text-xs font-black uppercase tracking-[.2em] text-primary">Pawprints Studio</p><h1 className="mt-2 text-3xl font-black text-on-surface">How do you want your Pawprint?</h1><p className="mt-2 text-on-surface-variant">Choose a digital-only keepsake, or add a physical print shipped to your door.</p></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <button type="button" onClick={() => setIntent("digital")} className="group rounded-3xl border-2 border-outline-variant/40 bg-surface p-8 text-left transition hover:-translate-y-1 hover:border-primary/60">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-primary/10 text-primary"><PawPrint size={30} /></span>
          <strong className="mt-4 block text-xl font-black">Digital Only</strong>
          <span className="mt-1 block text-sm text-on-surface-variant">Save, download, and email a finished Pawprint. No shipping.</span>
        </button>
        <button type="button" onClick={() => { if (digitalPrintedAvailable) setIntent("digital-printed"); }} disabled={!digitalPrintedAvailable} className="group rounded-3xl border-2 border-outline-variant/40 bg-surface p-8 text-left transition enabled:hover:-translate-y-1 enabled:hover:border-primary/60 disabled:cursor-not-allowed disabled:opacity-40">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-primary/10 text-primary"><PawPrint size={30} /></span>
          <strong className="mt-4 block text-xl font-black">Digital + Printed</strong>
          <span className="mt-1 block text-sm text-on-surface-variant">{digitalPrintedAvailable ? "Get the digital file plus a physical print shipped to your door." : "Physical printing isn't set up for this design's size yet — digital only for now."}</span>
        </button>
      </div>
    </main>
  );

  if (!category) return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-8">
      <button onClick={() => setIntent("")} className="mb-6 flex min-h-11 items-center gap-2 text-sm font-black text-primary"><ChevronLeft size={18} /> Digital or Printed</button>
      <div className="mb-8 max-w-2xl"><p className="text-xs font-black uppercase tracking-[.2em] text-primary">Pawprints Studio</p><h1 className="mt-2 text-3xl font-black text-on-surface">What are you creating?</h1><p className="mt-2 text-on-surface-variant">Choose an occasion, then add your exact words.</p></div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {categories.map((item) => { const meta = CATEGORY_META[item]; return <button key={item} onClick={() => setCategory(item)} className="relative aspect-[4/5] overflow-hidden rounded-3xl border border-outline-variant/40 p-4 text-left transition hover:-translate-y-1 hover:border-primary/50" style={{ background: meta?.colors[0] }}><span className="text-6xl opacity-70">{meta?.symbol || "🐾"}</span><span className="absolute inset-x-4 bottom-4 text-base font-black" style={{ color: meta?.colors[2] }}>{meta?.label || item}</span></button>; })}
      </div>
    </main>
  );

  if (!template) return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-8">
      <button onClick={() => setCategory("")} className="mb-6 flex min-h-11 items-center gap-2 text-sm font-black text-primary"><ChevronLeft size={18} /> Occasions</button>
      <h1 className="text-3xl font-black">Choose a starting layout</h1><p className="mt-2 text-on-surface-variant">Everything remains editable, with {VARIATIONS.length} responsive variations in the next step.</p>
      <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {categoryTemplates.map((item, index) => <button key={item.layoutId} onClick={() => chooseTemplate(item)} className="overflow-hidden rounded-3xl border border-outline-variant/40 bg-surface text-left transition hover:border-primary/50 hover:shadow-lg"><div className="aspect-[16/9] p-6" style={{ background: CATEGORY_META[category]?.colors[index % 2 ? 1 : 0], color: CATEGORY_META[category]?.colors[2] }}><span className="text-5xl opacity-50">{CATEGORY_META[category]?.symbol}</span></div><div className="p-5"><strong className="text-base">{item.name}</strong><span className="mt-1 block text-xs capitalize text-on-surface-variant">{item.tone} · {VARIATIONS.length} variations</span></div></button>)}
      </div>
    </main>
  );

  return (
    <main className="mx-auto w-full max-w-[1500px] px-3 pb-28 pt-4 sm:px-5">
      <header className="mb-4 flex items-center gap-3 border-b border-outline-variant/30 pb-4"><button onClick={() => setTemplate(null)} className="grid h-11 w-11 place-items-center rounded-full border border-outline-variant"><ChevronLeft size={19} /></button><div><p className="text-xs font-bold text-primary">{CATEGORY_META[category]?.label}</p><h1 className="font-black text-on-surface">{template.name}</h1></div><span className="ml-auto hidden text-xs font-bold text-on-surface-variant sm:block">Select a variation, then save</span></header>
      <div className="grid gap-4 lg:grid-cols-[72px_minmax(0,1fr)_360px]">
        <nav className="hidden rounded-2xl border border-outline-variant/30 bg-surface p-2 lg:block"><button onClick={() => photoInput.current?.click()} className="mb-2 flex w-full flex-col items-center gap-1 rounded-xl py-3 text-[10px] font-black hover:bg-primary/10"><ImagePlus size={20} />Photo</button><button onClick={() => document.getElementById("pawprint-text")?.focus()} className="mb-2 flex w-full flex-col items-center gap-1 rounded-xl py-3 text-[10px] font-black hover:bg-primary/10"><Type size={20} />Text</button><button className="flex w-full flex-col items-center gap-1 rounded-xl bg-primary/10 py-3 text-[10px] font-black text-primary"><LayoutGrid size={20} />Layouts</button></nav>
        <section className="rounded-3xl bg-surface-container-low p-3 sm:p-6"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-black">Choose a variation</h2><p className="text-xs text-on-surface-variant">Your photos and words stay the same.</p></div><span className="rounded-full bg-surface px-3 py-1 text-xs font-black">{VARIATIONS.length} options</span></div><div className="grid grid-cols-2 gap-2 sm:gap-4">{VARIATIONS.map((item) => <VariationPreview key={item.id} variation={item.id} selected={variation === item.id} photos={photos} title={title || "Your title"} message={message || "Your message"} category={category} onSelect={() => setVariation(item.id)} />)}</div></section>
        <aside className="space-y-4">
          <section className="rounded-3xl border border-outline-variant/30 bg-surface p-5"><div className="mb-3 flex items-center gap-2"><ImagePlus size={18} className="text-primary" /><h2 className="font-black">Photos</h2><span className="ml-auto text-xs font-black text-primary">{photos.length}/{MAX_PAWPRINT_PHOTOS}</span></div><button type="button" onClick={() => photoInput.current?.click()} className="min-h-40 w-full overflow-hidden rounded-2xl border-2 border-dashed border-outline-variant bg-surface-container-low transition hover:border-primary"><span className="flex min-h-40 flex-col items-center justify-center gap-2 p-6 text-center"><ImagePlus size={30} className="text-primary" /><strong>Add photos</strong><small className="text-on-surface-variant">Multiple PNG, JPEG, or WebP files · up to 20 MB each<br />Minimum 600 × 600 · large images optimize automatically</small></span></button><input ref={photoInput} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); if (files.length) void choosePhotos(files); event.target.value = ""; }} />{photos.length > 0 && <div className="mt-3 grid grid-cols-3 gap-2">{photos.map((photo, index) => <div key={photo.id} className="group relative aspect-square overflow-hidden rounded-xl border border-outline-variant"><img src={photo.dataUrl} alt={photo.name} className="h-full w-full object-cover" /><button type="button" onClick={() => setPhotos((current) => current.filter((item) => item.id !== photo.id))} aria-label={`Remove ${photo.name}`} className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/65 text-white"><X size={14} /></button><div className="absolute inset-x-1 bottom-1 flex justify-between"><button type="button" disabled={index === 0} onClick={() => movePhoto(index, -1)} aria-label={`Move ${photo.name} earlier`} className="grid h-7 w-7 place-items-center rounded-full bg-black/65 text-white disabled:opacity-30"><ArrowLeft size={13} /></button><button type="button" disabled={index === photos.length - 1} onClick={() => movePhoto(index, 1)} aria-label={`Move ${photo.name} later`} className="grid h-7 w-7 place-items-center rounded-full bg-black/65 text-white disabled:opacity-30"><ArrowRight size={13} /></button></div></div>)}</div>}</section>
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
              {digitalPrintedAvailable ? <>
                <label className="mt-3 block text-xs font-bold text-on-surface-variant">Print format</label>
                <select value={printProductCode} onChange={(event) => setPrintProductCode(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-outline-variant bg-surface px-3 text-sm">
                  {printableProducts.map((product) => <option key={product.code} value={product.code}>{product.label}{product.priceCents ? ` · $${(product.priceCents / 100).toFixed(2)}` : ""}</option>)}
                </select>
                {selectedPrintProduct && <p className="mt-1 text-[10px] text-on-surface-variant">{selectedPrintProduct.description} · {selectedPrintProduct.widthIn} × {selectedPrintProduct.heightIn} in · a separate 300-DPI print file will be prepared.</p>}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <input aria-label="Shipping name" placeholder="Full name" value={shipping.name} onChange={(event) => setShipping((current) => ({ ...current, name: event.target.value }))} className="col-span-2 min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" />
                  <input aria-label="Shipping email" type="email" placeholder="Email" value={shipping.email} onChange={(event) => setShipping((current) => ({ ...current, email: event.target.value }))} className="col-span-2 min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" />
                  <input aria-label="Shipping address" placeholder="Street address" value={shipping.address1} onChange={(event) => setShipping((current) => ({ ...current, address1: event.target.value }))} className="col-span-2 min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" />
                  <input aria-label="Shipping city" placeholder="City" value={shipping.city} onChange={(event) => setShipping((current) => ({ ...current, city: event.target.value }))} className="min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" />
                  <input aria-label="Shipping state" placeholder="State" value={shipping.state_code} onChange={(event) => setShipping((current) => ({ ...current, state_code: event.target.value.toUpperCase() }))} className="min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" />
                  <input aria-label="Shipping postal code" placeholder="Postal code" value={shipping.zip} onChange={(event) => setShipping((current) => ({ ...current, zip: event.target.value }))} className="min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" />
                  <input aria-label="Shipping country" placeholder="Country" maxLength={2} value={shipping.country_code} onChange={(event) => setShipping((current) => ({ ...current, country_code: event.target.value.toUpperCase() }))} className="min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" />
                </div>
                <button type="button" onClick={() => void submitPrintOrder()} disabled={printBusy || !savedCreationId} className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-black text-on-primary disabled:cursor-not-allowed disabled:opacity-40">{printBusy ? <Loader2 size={17} className="animate-spin" /> : <Printer size={17} />}{printBusy ? "Preparing print…" : printOrderMode === "payment" ? "Price & secure checkout" : "Create print order"}</button>
                {printOrder && <p className="mt-2 rounded-xl bg-primary/10 p-3 text-xs font-bold text-primary">Printful order {printOrder.id || "created"} · {printOrder.status}. You can return to this order from your FurBin.</p>}
                <p className="mt-2 text-[10px] text-on-surface-variant">The print file is prepared at 300 DPI. Printful receives a draft first; it enters production only after Stripe confirms your payment.</p>
              </> : <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs font-bold text-amber-700">Physical Pawprint ordering just became unavailable for this format — your finished digital Pawprint is ready to download and email right now.</p>}
            </div>}
          </>}
          {!userProfile.email ? (
            <button onClick={() => { window.location.href = "/sign-up"; }} className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 font-black text-on-primary">Sign In to Save Pawprint</button>
          ) : (
            <>
              <button onClick={() => void save()} disabled={busy || (!userProfile.isAdmin && userProfile.credits < CREDIT_PRICES.PAWPRINT)} className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 font-black text-on-primary disabled:opacity-40">{busy ? <Loader2 className="animate-spin" size={19} /> : <Sparkles size={19} />}{busy ? "Saving…" : `Save selected variation · ${CREDIT_PRICES.PAWPRINT} PupCoins`}</button>
              {!userProfile.isAdmin && userProfile.credits < CREDIT_PRICES.PAWPRINT && <button onClick={onOpenCreditStore} className="min-h-12 w-full rounded-xl border border-primary font-black text-primary">Buy PupCoins</button>}
            </>
          )}
        </aside>
      </div>
    </main>
  );
}
