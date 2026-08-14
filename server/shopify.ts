/** Small Shopify adapter for Pawprints physical fulfillment.
 * v1 scope: create/upsert one Shopify Product per finished Pawprint design
 * via the Admin API, then hand back a cart-permalink checkout URL. Shopify's
 * own checkout collects payment and shipping. Order status is reconciled by
 * the orders/paid and orders/cancelled webhooks registered in Shopify Admin
 * (Settings → Notifications → Webhooks) against POST /api/webhooks/shopify-orders
 * — see docs/superpowers/specs/2026-08-12-pawprints-flow-repair-design.md's
 * sibling plan doc for the full design and its explicit v1/follow-up split.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies Shopify's X-Shopify-Hmac-Sha256 header against the raw request
 *  body, mirroring the Stripe webhook verification pattern in server.ts.
 *  `rawBody` must be the exact bytes Shopify sent (mount this route with
 *  express.raw({ type: "application/json" }) BEFORE the global JSON parser). */
export function verifyShopifyWebhookSignature(rawBody: Buffer, hmacHeader: string | undefined): boolean {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || "";
  if (!secret || !hmacHeader) return false;
  const computed = createHmac("sha256", secret).update(rawBody).digest("base64");
  const expected = Buffer.from(hmacHeader, "base64");
  const actual = Buffer.from(computed, "base64");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

const PAWPRINT_ORDER_REFERENCE_PATTERN = /pawprint_order:([a-f0-9-]{36})/i;

/** Extracts the idempotency key we stamped into the order's note at checkout
 *  time (see createPawprintCheckout), so an incoming webhook payload can be
 *  matched back to its pawprint_shopify_orders row without a customer/order
 *  ID we don't otherwise have a way to correlate. */
export function extractPawprintOrderReference(shopifyOrderNote: string | null | undefined): string | null {
  const match = PAWPRINT_ORDER_REFERENCE_PATTERN.exec(String(shopifyOrderNote || ""));
  return match ? match[1] : null;
}

export const PAWPRINTS_SHOPIFY_FEATURE_FLAG = "PAWPRINTS_SHOPIFY_ENABLED";

export function isPawprintsShopifyEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[PAWPRINTS_SHOPIFY_FEATURE_FLAG]?.trim().toLowerCase() === "true";
}

export class PawprintsShopifyDisabledError extends Error {
  readonly code = "FEATURE_DISABLED";
  constructor() {
    super("Shopify print fulfillment is not enabled.");
    this.name = "PawprintsShopifyDisabledError";
  }
}

export function assertPawprintsShopifyEnabled(environment: NodeJS.ProcessEnv = process.env): void {
  if (!isPawprintsShopifyEnabled(environment)) throw new PawprintsShopifyDisabledError();
}

/** Client credentials grant tokens are valid 24h (86399s); refreshed a
 *  minute early so an in-flight request never races an expiring token. */
const TOKEN_REFRESH_BUFFER_MS = 60_000;
let cachedToken: { token: string; expiresAt: number } | null = null;

async function fetchAccessToken(domain: string): Promise<{ token: string; expiresAt: number }> {
  const clientId = process.env.SHOPIFY_CLIENT_ID || "";
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) throw new Error("Shopify is not configured: set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.");
  const response = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.error || `Shopify token exchange failed (${response.status}).`);
  }
  return { token: String(payload.access_token), expiresAt: Date.now() + Number(payload.expires_in || 0) * 1000 };
}

async function configuration() {
  const domain = (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-07";
  if (!domain) throw new Error("Shopify is not configured: set SHOPIFY_STORE_DOMAIN.");
  if (!cachedToken || cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS <= Date.now()) {
    cachedToken = await fetchAccessToken(domain);
  }
  return {
    domain,
    base: `https://${domain}/admin/api/${apiVersion}`,
    headers: {
      "X-Shopify-Access-Token": cachedToken.token,
      "Content-Type": "application/json",
    },
  };
}

async function parseShopify(response: Response): Promise<any> {
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(payload?.errors ? JSON.stringify(payload.errors) : `Shopify returned ${response.status}.`);
  return payload;
}

/** Non-mutating authentication check for the admin deployment gate. */
export async function verifyShopifyConfiguration(): Promise<{ authenticated: true; shopName: string }> {
  const { base, headers } = await configuration();
  const payload = await parseShopify(await fetch(`${base}/shop.json`, { headers, signal: AbortSignal.timeout(30_000) }));
  return { authenticated: true, shopName: String(payload?.shop?.name || "") };
}

export interface ShopifyProductSummary {
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
}

/** Used for the one-time §1.3 catalog sync — pulls the store's real product
 *  list so the owner can assign each one's Pawprint theme categories. */
export async function listShopifyProducts(): Promise<ShopifyProductSummary[]> {
  const { base, headers } = await configuration();
  const payload = await parseShopify(await fetch(`${base}/products.json?limit=100`, { headers, signal: AbortSignal.timeout(30_000) }));
  const products = Array.isArray(payload?.products) ? payload.products : [];
  return products.map((product: any) => ({
    shopifyProductId: String(product.id),
    shopifyVariantId: String(product.variants?.[0]?.id || ""),
    title: String(product.title || ""),
  }));
}

export interface CreatePawprintCheckoutInput {
  title: string;
  imageUrl: string;
  shopifyVariantId: string;
  /** The pawprint_shopify_orders row's idempotency key. Stamped into the
   *  Shopify order's note so the orders/paid webhook can correlate the
   *  completed order back to this row — see extractPawprintOrderReference. */
  orderReference: string;
}

export interface PawprintCheckoutResult {
  checkoutUrl: string;
}

/** v1: reuses the customer's chosen product/variant as-is and builds a cart
 *  permalink pointed at it. The design image is attached to the saved
 *  Fur Bin creation (already public); a future version can instead create a
 *  per-design product/variant so the printed art is enforced Shopify-side. */
export async function createPawprintCheckout(input: CreatePawprintCheckoutInput): Promise<PawprintCheckoutResult> {
  const { domain } = await configuration();
  const variantId = Number(input.shopifyVariantId);
  if (!variantId) throw new Error("A valid Shopify variant is required.");
  const note = encodeURIComponent(`Pawprint design: ${input.imageUrl} | pawprint_order:${input.orderReference}`);
  return { checkoutUrl: `https://${domain}/cart/${variantId}:1?note=${note}` };
}
