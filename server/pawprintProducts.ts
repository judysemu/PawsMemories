export interface PawprintPrintProduct {
  code: string;
  label: string;
  description: string;
  variantId: number;
  templateId?: number;
  widthIn: number;
  heightIn: number;
  priceCents?: number;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeProduct(value: unknown): PawprintPrintProduct | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const code = String(row.code || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 48);
  const label = String(row.label || "").trim().slice(0, 80);
  const variantId = positiveNumber(row.variantId);
  const widthIn = positiveNumber(row.widthIn);
  const heightIn = positiveNumber(row.heightIn);
  if (!code || !label || !variantId || !widthIn || !heightIn) return null;
  return {
    code,
    label,
    description: String(row.description || `${widthIn} × ${heightIn} in`).trim().slice(0, 180),
    variantId: Math.floor(variantId),
    templateId: positiveNumber(row.templateId) ? Math.floor(Number(row.templateId)) : undefined,
    widthIn,
    heightIn,
    priceCents: positiveNumber(row.priceCents) ? Math.floor(Number(row.priceCents)) : undefined,
  };
}

/**
 * Print product IDs are server-owned. This prevents a browser from selecting
 * an arbitrary Printful catalog variant or changing fulfillment pricing.
 *
 * PAWPRINT_PRINT_PRODUCTS_JSON example:
 * [{"code":"poster-8x10","label":"8 × 10 Art Print","description":"Museum-quality matte poster","variantId":123,"templateId":456,"widthIn":8,"heightIn":10,"priceCents":2499}]
 */
export function getPawprintPrintProducts(): PawprintPrintProduct[] {
  const configured = String(process.env.PAWPRINT_PRINT_PRODUCTS_JSON || "").trim();
  if (configured) {
    try {
      const parsed = JSON.parse(configured);
      if (Array.isArray(parsed)) {
        const products = parsed.map(normalizeProduct).filter((item): item is PawprintPrintProduct => Boolean(item));
        const unique = new Map(products.map((item) => [item.code, item]));
        if (unique.size) return [...unique.values()];
      }
    } catch (error) {
      console.error("Invalid PAWPRINT_PRINT_PRODUCTS_JSON:", error);
    }
  }

  const legacy = normalizeProduct({
    code: "pawprint-standard",
    label: "Pawprint Art Print",
    description: "Standard portrait Pawprint",
    variantId: process.env.PRINTFUL_PAWPRINT_VARIANT_ID,
    templateId: process.env.PRINTFUL_PAWPRINT_TEMPLATE_ID,
    widthIn: 8,
    heightIn: 10,
  });
  return legacy ? [legacy] : [];
}

export function publicPawprintPrintProducts() {
  return getPawprintPrintProducts().map(({ variantId: _variantId, templateId: _templateId, ...product }) => product);
}

export function requirePawprintPrintProduct(code: string): PawprintPrintProduct {
  const product = getPawprintPrintProducts().find((item) => item.code === code);
  if (!product) throw new Error("That Pawprint print format is not configured.");
  return product;
}

/**
 * Showcase formats used purely to populate the storefront when Printful has no
 * variant IDs configured yet.
 *
 * These deliberately carry NO variantId. An order can only ever be placed
 * against getPawprintPrintProducts(), which still demands a real, server-owned
 * Printful variant — so a showcase row can never be turned into a real order by
 * a crafted request. The sizes below are the standard Printful poster and
 * canvas trim sizes, so once real variant IDs are configured the customer-facing
 * list does not visibly change shape.
 */
const SHOWCASE_FORMATS: PublicPawprintPrintProduct[] = [
  { code: "poster-8x10", label: "8 × 10 Art Print", description: "Museum-quality matte poster paper", widthIn: 8, heightIn: 10 },
  { code: "poster-12x16", label: "12 × 16 Art Print", description: "Museum-quality matte poster paper", widthIn: 12, heightIn: 16 },
  { code: "poster-18x24", label: "18 × 24 Statement Print", description: "Large-format matte poster paper", widthIn: 18, heightIn: 24 },
  { code: "canvas-12x16", label: "12 × 16 Canvas", description: "Stretched canvas on a solid wood frame", widthIn: 12, heightIn: 16 },
];

export interface PublicPawprintPrintProduct {
  code: string;
  label: string;
  description: string;
  widthIn: number;
  heightIn: number;
  priceCents?: number;
}

export interface PawprintDisplayProduct extends PublicPawprintPrintProduct {
  /** False for showcase rows — the studio renders them read-only. */
  orderable: boolean;
}

/**
 * What the storefront renders. Real configured products when they exist,
 * otherwise the showcase list flagged `orderable: false`.
 *
 * Kept separate from publicPawprintPrintProducts() on purpose: readiness and
 * order placement must keep counting only genuinely orderable products, or an
 * unconfigured deployment would advertise itself as ready to take money.
 */
export function pawprintDisplayCatalog(): PawprintDisplayProduct[] {
  const configured = publicPawprintPrintProducts();
  if (configured.length) return configured.map((product) => ({ ...product, orderable: true }));
  return SHOWCASE_FORMATS.map((product) => ({ ...product, orderable: false }));
}
