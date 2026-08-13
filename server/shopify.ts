/** Small Shopify adapter for Pawprints physical fulfillment.
 * v1 scope: create/upsert one Shopify Product per finished Pawprint design
 * via the Admin API, then hand back a cart-permalink checkout URL. Shopify's
 * own checkout collects payment and shipping — there is no local order
 * webhook or reconciliation sweep yet (see PAWPRINTS_SHOPIFY_ENABLED and
 * docs/superpowers/specs/2026-08-12-pawprints-flow-repair-design.md's sibling
 * plan doc for the full design and its explicit v1/follow-up split).
 */

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

function configuration() {
  const domain = (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const token = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN || "";
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-01";
  if (!domain || !token) throw new Error("Shopify is not configured: set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_API_ACCESS_TOKEN.");
  return {
    domain,
    base: `https://${domain}/admin/api/${apiVersion}`,
    headers: {
      "X-Shopify-Access-Token": token,
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
  const { base, headers } = configuration();
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
  const { base, headers } = configuration();
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
}

export interface PawprintCheckoutResult {
  checkoutUrl: string;
}

/** v1: reuses the customer's chosen product/variant as-is and builds a cart
 *  permalink pointed at it. The design image is attached to the saved
 *  Fur Bin creation (already public); a future version can instead create a
 *  per-design product/variant so the printed art is enforced Shopify-side. */
export async function createPawprintCheckout(input: CreatePawprintCheckoutInput): Promise<PawprintCheckoutResult> {
  const { domain } = configuration();
  const variantId = Number(input.shopifyVariantId);
  if (!variantId) throw new Error("A valid Shopify variant is required.");
  const note = encodeURIComponent(`Pawprint design: ${input.imageUrl}`);
  return { checkoutUrl: `https://${domain}/cart/${variantId}:1?note=${note}` };
}
