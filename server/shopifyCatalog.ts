import { getPool } from "../db";
import type {
  ShopifyCatalogSyncResult,
  ShopifyCatalogSyncStatus,
  ShopifyStoreProduct,
  ShopifyStoreVariant,
} from "../shared/shopifyStoreCatalog";
import { listShopifyProducts } from "./shopify";

function parseVariants(value: unknown): ShopifyStoreVariant[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

export async function listPublicStoreProducts(): Promise<ShopifyStoreProduct[]> {
  const [rows] = await getPool().query(
    `SELECT shopify_product_gid, handle, title, description, featured_image_url,
            featured_image_alt, min_price, max_price, currency_code,
            available_for_sale, published, product_url,
            pawprint_personalizable, variants_json, shopify_updated_at,
            last_synced_at
       FROM shopify_store_products
      WHERE active = 1 AND published = 1
      ORDER BY pawprint_personalizable DESC, title ASC`,
  ) as any;
  return (Array.isArray(rows) ? rows : []).map((row: any) => ({
    id: String(row.shopify_product_gid),
    handle: String(row.handle),
    title: String(row.title),
    description: String(row.description || ""),
    featuredImageUrl: row.featured_image_url ? String(row.featured_image_url) : null,
    featuredImageAlt: row.featured_image_alt ? String(row.featured_image_alt) : null,
    minPrice: String(row.min_price ?? "0.00"),
    maxPrice: String(row.max_price ?? "0.00"),
    currencyCode: String(row.currency_code || "USD"),
    availableForSale: Boolean(row.available_for_sale),
    published: Boolean(row.published),
    productUrl: String(row.product_url),
    pawprintPersonalizable: Boolean(row.pawprint_personalizable),
    variants: parseVariants(row.variants_json),
    shopifyUpdatedAt: iso(row.shopify_updated_at),
    lastSyncedAt: iso(row.last_synced_at),
  }));
}

export async function getShopifyCatalogSyncStatus(): Promise<ShopifyCatalogSyncStatus | null> {
  const [rows] = await getPool().query(
    `SELECT id, status, product_count, duration_ms, error_summary, started_at, completed_at
       FROM shopify_catalog_sync_runs
      ORDER BY id DESC
      LIMIT 1`,
  ) as any;
  const row = rows?.[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    status: row.status,
    productCount: Number(row.product_count || 0),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    errorSummary: row.error_summary ? String(row.error_summary) : null,
    startedAt: iso(row.started_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
  };
}

/** Refreshes the runtime snapshot atomically. A Shopify or database failure
 * records a failed run but leaves the previous public snapshot unchanged. */
export async function synchronizeShopifyCatalog(): Promise<ShopifyCatalogSyncResult> {
  const pool = getPool();
  const started = Date.now();
  const [runResult] = await pool.query(
    `INSERT INTO shopify_catalog_sync_runs (status, started_at)
     VALUES ('running', NOW(3))`,
  ) as any;
  const runId = Number(runResult.insertId);

  try {
    const products = await listShopifyProducts();
    const connection = await pool.getConnection();
    try {
      await connection.query("START TRANSACTION");
      await connection.query("UPDATE shopify_store_products SET active = 0");
      for (const product of products) {
        if (!product.id || !product.handle || !product.productUrl) continue;
        await connection.query(
          `INSERT INTO shopify_store_products
             (shopify_product_gid, handle, title, description,
              featured_image_url, featured_image_alt, min_price, max_price,
              currency_code, available_for_sale, published, product_url,
              pawprint_personalizable, variants_json, shopify_updated_at,
              last_synced_at, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), 1)
           ON DUPLICATE KEY UPDATE
             handle = VALUES(handle),
             title = VALUES(title),
             description = VALUES(description),
             featured_image_url = VALUES(featured_image_url),
             featured_image_alt = VALUES(featured_image_alt),
             min_price = VALUES(min_price),
             max_price = VALUES(max_price),
             currency_code = VALUES(currency_code),
             available_for_sale = VALUES(available_for_sale),
             published = VALUES(published),
             product_url = VALUES(product_url),
             pawprint_personalizable = VALUES(pawprint_personalizable),
             variants_json = VALUES(variants_json),
             shopify_updated_at = VALUES(shopify_updated_at),
             last_synced_at = VALUES(last_synced_at),
             active = 1`,
          [
            product.id,
            product.handle,
            product.title.slice(0, 255),
            product.description,
            product.featuredImageUrl,
            product.featuredImageAlt?.slice(0, 500) || null,
            product.minPrice,
            product.maxPrice,
            product.currencyCode.slice(0, 3),
            product.availableForSale ? 1 : 0,
            product.published ? 1 : 0,
            product.productUrl,
            product.pawprintPersonalizable ? 1 : 0,
            JSON.stringify(product.variants),
            new Date(product.shopifyUpdatedAt),
          ],
        );
      }
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }

    const durationMs = Date.now() - started;
    await pool.query(
      `UPDATE shopify_catalog_sync_runs
          SET status = 'succeeded', product_count = ?, duration_ms = ?, completed_at = NOW(3)
        WHERE id = ?`,
      [products.length, durationMs, runId],
    );
    return { runId, productCount: products.length, durationMs, completedAt: new Date().toISOString() };
  } catch (error: any) {
    const durationMs = Date.now() - started;
    const summary = String(error?.message || "Shopify catalog sync failed.").replace(/\s+/g, " ").slice(0, 500);
    await pool.query(
      `UPDATE shopify_catalog_sync_runs
          SET status = 'failed', duration_ms = ?, error_summary = ?, completed_at = NOW(3)
        WHERE id = ?`,
      [durationMs, summary, runId],
    ).catch(() => undefined);
    throw error;
  }
}
