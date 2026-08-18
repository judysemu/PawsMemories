#!/usr/bin/env -S npx tsx
/**
 * Runnable Shopify catalog sync.
 *
 * The sync already existed as an HTTP route (POST /api/admin/shopify/catalog-sync),
 * but that needs a live server plus either an admin session or the shared
 * secret. This runs the same synchronizeShopifyCatalog() directly against the
 * configured database, so it works from a laptop or an agent session with only
 * the .env credentials.
 *
 *   npx tsx scripts/sync-shopify-catalog.ts            # sync, then report
 *   npx tsx scripts/sync-shopify-catalog.ts --status   # report only, no writes
 *
 * The sync is atomic and last-known-good: it marks every row inactive inside a
 * transaction, re-upserts what Shopify returns, and rolls back on failure, so a
 * partial or failed run never empties the live storefront.
 */
import "dotenv/config";
import { getPool, closePool } from "../db";
import { synchronizeShopifyCatalog, getShopifyCatalogSyncStatus } from "../server/shopifyCatalog";

const statusOnly = process.argv.includes("--status");

function requireConfig(): void {
  const missing = ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"]
    .filter((name) => !String(process.env[name] || "").trim());
  if (missing.length) {
    console.error(`Missing Shopify configuration: ${missing.join(", ")}`);
    process.exit(2);
  }
}

/** The number that actually matters for the PawPrint purchase gate: checkout
 *  fails closed unless at least one product carries the personalizable
 *  metafield, so report it explicitly rather than leaving it to be inferred. */
async function reportCatalog(): Promise<void> {
  const [rows]: any = await getPool().query(
    `SELECT COUNT(*) AS total,
            SUM(active = 1) AS active,
            SUM(active = 1 AND published = 1 AND available_for_sale = 1
                AND pawprint_personalizable = 1) AS purchasable_personalizable
       FROM shopify_store_products`,
  );
  const row = rows[0] || {};
  console.log(`\nCatalog: ${row.total ?? 0} products, ${row.active ?? 0} active`);
  console.log(`Personalizable AND purchasable: ${row.purchasable_personalizable ?? 0}`);

  const [named]: any = await getPool().query(
    `SELECT handle, title, min_price, currency_code
       FROM shopify_store_products
      WHERE active = 1 AND published = 1 AND available_for_sale = 1
        AND pawprint_personalizable = 1
      ORDER BY min_price ASC`,
  );
  for (const product of named) {
    console.log(`  • ${product.title} (${product.handle}) — ${product.min_price} ${product.currency_code}`);
  }
  if (!named.length) {
    console.log("  (none — PawPrint checkout will return NO_PERSONALIZABLE_PRODUCT)");
    console.log("  Set the custom.pawprint_personalizable metafield to TRUE on a");
    console.log("  published, in-stock product in Shopify, then re-run this sync.");
  }
}

async function main(): Promise<void> {
  if (!statusOnly) {
    requireConfig();
    console.log("Syncing the Shopify catalog…");
    const result = await synchronizeShopifyCatalog();
    console.log(`Synced ${result.productCount} product(s) in ${result.durationMs}ms.`);
  }

  const status = await getShopifyCatalogSyncStatus();
  if (status) {
    console.log(`Last run: ${status.status} · ${status.productCount} product(s) · ${status.startedAt}`);
    if (status.errorSummary) console.log(`Error: ${status.errorSummary}`);
  }

  await reportCatalog();
}

main()
  .then(() => closePool())
  .catch(async (error: any) => {
    // The sync rolls its own transaction back, so the previous snapshot is
    // still serving. Say so, rather than implying the storefront is empty.
    console.error(`\nSync failed: ${error?.message || error}`);
    console.error("The last known-good catalog remains live.");
    await closePool().catch(() => undefined);
    process.exit(1);
  });
