/**
 * Shopify cart-permalink builder for the PawPrint purchase gate.
 *
 * Chosen over the Draft Order API deliberately: a permalink is a plain URL, so
 * the app keeps its existing read-mostly Shopify scope and needs no write
 * permission on the custom app. The trade-off is that we cannot attach
 * server-side line-item properties, so the order reference travels as a cart
 * attribute and is recovered from the webhook payload.
 */

/** Cart attribute key carrying our order reference through checkout. */
export const PAWPRINT_ATTRIBUTE_KEY = "pawprint_order";

export class CartPermalinkError extends Error {
  constructor(message: string, public readonly code: "NO_PRODUCT" | "BAD_VARIANT" | "NOT_CONFIGURED") {
    super(message);
    this.name = "CartPermalinkError";
  }
}

/** Shopify variant GIDs arrive as gid://shopify/ProductVariant/1234567890.
 *  Cart permalinks need the bare numeric id. */
export function numericVariantId(variantGid: string): string {
  const match = /(\d{6,})\s*$/.exec(String(variantGid || "").trim());
  if (!match) throw new CartPermalinkError(`Unusable Shopify variant id: ${variantGid}`, "BAD_VARIANT");
  return match[1];
}

/**
 * Builds `https://{shop}/cart/{variantId}:{qty}?attributes[pawprint_order]={ref}`.
 *
 * The reference is also mirrored into `note` because some themes and channels
 * drop cart attributes; the webhook reads either. Belt and braces here is
 * cheap, and losing the reference means a paid order we cannot match to a
 * customer's artwork.
 */
export function buildCartPermalink(input: {
  storeDomain: string;
  variantGid: string;
  reference: string;
  quantity?: number;
}): string {
  const domain = String(input.storeDomain || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!domain) throw new CartPermalinkError("Shopify store domain is not configured.", "NOT_CONFIGURED");
  if (!/^[0-9a-f-]{36}$/i.test(input.reference)) {
    throw new CartPermalinkError("Order reference must be a UUID.", "BAD_VARIANT");
  }
  const variantId = numericVariantId(input.variantGid);
  const quantity = Math.min(Math.max(Math.trunc(input.quantity ?? 1), 1), 10);
  const params = new URLSearchParams();
  params.set(`attributes[${PAWPRINT_ATTRIBUTE_KEY}]`, input.reference);
  params.set("note", `pawprint_order:${input.reference}`);
  return `https://${domain}/cart/${variantId}:${quantity}?${params.toString()}`;
}

/**
 * Recovers our reference from a Shopify order payload, checking cart attributes
 * first and falling back to the note. Mirrors extractPawprintOrderReference in
 * server/shopify.ts, which only ever read the note.
 */
export function referenceFromOrderPayload(order: any): string | null {
  const attributes = Array.isArray(order?.note_attributes) ? order.note_attributes : [];
  for (const attribute of attributes) {
    if (String(attribute?.name || "") === PAWPRINT_ATTRIBUTE_KEY) {
      const value = String(attribute?.value || "").trim();
      if (/^[0-9a-f-]{36}$/i.test(value)) return value;
    }
  }
  const match = /pawprint_order:([a-f0-9-]{36})/i.exec(String(order?.note || ""));
  return match ? match[1] : null;
}
