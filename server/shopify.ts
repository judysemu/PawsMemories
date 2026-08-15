/** Shopify adapter for the public Pawsome3D catalog.
 *
 * The active PawPrint flow is digital-only. Catalog reads use Admin GraphQL
 * and are persisted into a last-known-good local snapshot by
 * server/shopifyCatalog.ts. Legacy order references remain readable so
 * existing webhook records can still be reconciled; new checkout creation is
 * intentionally absent.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ShopifyStoreProduct, ShopifyStoreVariant } from "../shared/shopifyStoreCatalog";

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

/** Extracts the idempotency key stamped into a legacy order note so incoming
 * webhook payloads can still reconcile historic pawprint_shopify_orders rows. */
export function extractPawprintOrderReference(shopifyOrderNote: string | null | undefined): string | null {
  const match = PAWPRINT_ORDER_REFERENCE_PATTERN.exec(String(shopifyOrderNote || ""));
  return match ? match[1] : null;
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

type GraphqlError = { message?: string; extensions?: { code?: string } };

function graphqlErrorMessage(errors: GraphqlError[]): string {
  return errors.map((error) => String(error?.message || "Shopify GraphQL request failed.")).join("; ").slice(0, 800);
}

/** Executes one Admin GraphQL operation and keeps HTTP, GraphQL, and throttle
 * failures distinct. Read callers never receive a partial `data` payload when
 * Shopify also returned top-level errors. */
export async function shopifyAdminGraphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const { base, headers } = await configuration();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${base}/graphql.json`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => ({})) as {
      data?: T;
      errors?: GraphqlError[];
      extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } };
    };
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
        continue;
      }
      throw new Error(`Shopify Admin GraphQL returned HTTP ${response.status}.`);
    }
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.length) {
      const throttled = errors.some((error) => error?.extensions?.code === "THROTTLED");
      if (throttled && attempt < 2) {
        const status = payload.extensions?.cost?.throttleStatus;
        const restoreRate = Math.max(1, Number(status?.restoreRate || 50));
        const available = Math.max(0, Number(status?.currentlyAvailable || 0));
        const waitMs = Math.max(500, Math.ceil(((50 - available) / restoreRate) * 1_000));
        await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs * (attempt + 1), 5_000)));
        continue;
      }
      throw new Error(graphqlErrorMessage(errors));
    }
    if (!payload.data) throw new Error("Shopify Admin GraphQL returned no data.");
    return payload.data;
  }
  throw new Error("Shopify Admin GraphQL retry limit was reached.");
}

/** Non-mutating authentication check for the admin deployment gate. */
export async function verifyShopifyConfiguration(): Promise<{ authenticated: true; shopName: string }> {
  const data = await shopifyAdminGraphql<{ shop: { name: string } }>(`query VerifyShopifyConfiguration { shop { name } }`);
  return { authenticated: true, shopName: String(data.shop?.name || "") };
}

const STORE_PRODUCTS_QUERY = `
  query StoreProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      nodes {
        id
        handle
        title
        description
        status
        updatedAt
        onlineStoreUrl
        featuredMedia {
          ... on MediaImage {
            image { url altText }
          }
        }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        pawprintPersonalizable: metafield(namespace: "custom", key: "pawprint_personalizable") {
          type
          value
        }
        variants(first: 100) {
          nodes { id title price availableForSale sellableOnlineQuantity }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Pulls every active product with cursor pagination. Personalization is an
 * explicit boolean metafield; option names and product titles are never used
 * as a classification heuristic. */
export async function listShopifyProducts(): Promise<ShopifyStoreProduct[]> {
  const { domain } = await configuration();
  const products: ShopifyStoreProduct[] = [];
  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data: {
      products: {
        nodes: any[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await shopifyAdminGraphql(STORE_PRODUCTS_QUERY, { first: 50, after });
    const nodes = Array.isArray(data.products?.nodes) ? data.products.nodes : [];
    for (const product of nodes) {
      const variants: ShopifyStoreVariant[] = (Array.isArray(product?.variants?.nodes) ? product.variants.nodes : []).map((variant: any) => ({
        id: String(variant.id || ""),
        title: String(variant.title || ""),
        price: String(variant.price || "0.00"),
        availableForSale: variant.availableForSale === true,
        sellableOnlineQuantity: Number(variant.sellableOnlineQuantity || 0),
      }));
      const onlineStoreUrl = product.onlineStoreUrl ? String(product.onlineStoreUrl) : "";
      products.push({
        id: String(product.id || ""),
        handle: String(product.handle || ""),
        title: String(product.title || ""),
        description: String(product.description || ""),
        featuredImageUrl: product.featuredMedia?.image?.url ? String(product.featuredMedia.image.url) : null,
        featuredImageAlt: product.featuredMedia?.image?.altText ? String(product.featuredMedia.image.altText) : null,
        minPrice: String(product.priceRangeV2?.minVariantPrice?.amount || "0.00"),
        maxPrice: String(product.priceRangeV2?.maxVariantPrice?.amount || "0.00"),
        currencyCode: String(product.priceRangeV2?.minVariantPrice?.currencyCode || "USD"),
        availableForSale: variants.some((variant) => variant.availableForSale),
        published: String(product.status || "") === "ACTIVE" && Boolean(onlineStoreUrl),
        productUrl: onlineStoreUrl || `https://${domain}/products/${encodeURIComponent(String(product.handle || ""))}`,
        pawprintPersonalizable: product.pawprintPersonalizable?.type === "boolean" && String(product.pawprintPersonalizable.value).toLowerCase() === "true",
        variants,
        shopifyUpdatedAt: String(product.updatedAt || new Date(0).toISOString()),
      });
    }
    hasNextPage = data.products?.pageInfo?.hasNextPage === true;
    after = data.products?.pageInfo?.endCursor || null;
    if (hasNextPage && !after) throw new Error("Shopify product pagination returned no cursor.");
  }
  return products;
}
