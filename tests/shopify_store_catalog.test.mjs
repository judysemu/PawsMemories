import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "../server/migrations/runner.ts";

const shopify = fs.readFileSync("server/shopify.ts", "utf8");
const snapshot = fs.readFileSync("server/shopifyCatalog.ts", "utf8");
const server = fs.readFileSync("server.ts", "utf8");
const store = fs.readFileSync("src/components/Store.tsx", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");
const envExample = fs.readFileSync(".env.example", "utf8");
const shopifyAppConfig = fs.readFileSync("tools/shopify-app/shopify.app.toml", "utf8");

test("Shopify catalog reads use paginated Admin GraphQL with read-only scope", () => {
  assert.match(shopify, /\/graphql\.json/);
  assert.match(shopify, /products\(first: \$first, after: \$after/);
  assert.match(shopify, /pageInfo \{ hasNextPage endCursor \}/);
  assert.match(shopify, /sellableOnlineQuantity/);
  assert.doesNotMatch(shopify, /\/products\.json/);
  assert.match(envExample, /catalog app installed on SHOPIFY_STORE_DOMAIN, with at least read_products/i);
  assert.match(shopifyAppConfig, /scopes = "read_products"/);
  assert.doesNotMatch(shopifyAppConfig, /write_products/);
  assert.doesNotMatch(shopify, /productCreate|productUpdate|metafieldsSet/);
});

test("PawPrint personalization is an explicit Shopify boolean metafield", () => {
  assert.match(shopify, /metafield\(namespace: "custom", key: "pawprint_personalizable"\)/);
  assert.match(shopify, /pawprintPersonalizable\?\.type === "boolean"/);
  assert.doesNotMatch(shopify, /option.*personal|title.*personal/i);
});

test("schema v50 persists dual PawPrint assets and the last-known-good catalog", () => {
  // Migration 50 must remain present and intact; later migrations may raise the
  // current version, so this asserts a floor rather than an exact match.
  assert.ok(CURRENT_SCHEMA_VERSION >= 50);
  const migration = MIGRATIONS.find((item) => item.version === 50);
  assert.ok(migration);
  const sql = migration.statements.join("\n");
  for (const marker of ["subject_art_id", "clean_image_url", "shopify_store_products", "shopify_catalog_sync_runs", "shopify_webhook_receipts"]) {
    assert.match(sql, new RegExp(marker));
  }
});

test("catalog refresh is atomic and retains the previous snapshot on failure", () => {
  assert.match(snapshot, /START TRANSACTION/);
  assert.match(snapshot, /UPDATE shopify_store_products SET active = 0/);
  assert.match(snapshot, /ON DUPLICATE KEY UPDATE/);
  assert.match(snapshot, /COMMIT/);
  assert.match(snapshot, /ROLLBACK/);
  assert.match(snapshot, /status = 'failed'/);
});

test("sync supports a machine secret or admin JWT without exposing either", () => {
  assert.match(server, /app\.post\("\/api\/admin\/shopify\/catalog-sync"/);
  assert.match(server, /SHOPIFY_CATALOG_SYNC_SECRET/);
  assert.match(server, /verifyToken\(bearer\)/);
  assert.match(server, /isUserAdmin\(user\.phone\)/);
  assert.match(server, /last good catalog remains live/);
});

test("Store is public, links directly to Shopify, and offers both PawPrint downloads", () => {
  assert.match(app, /PUBLIC_SCREENS[\s\S]*Screen\.STORE/);
  assert.match(app, /\/store\?pawprint=\$\{pawprintId\}/);
  assert.match(store, /fetch\("\/api\/store\/products"\)/);
  assert.match(store, /href=\{product\.productUrl\}/);
  assert.match(store, /target="_blank"/);
  assert.match(store, /Download clean image/);
  assert.match(store, /Download layout \+ words/);
});

test("new PawPrint checkout creation is retired while legacy history remains readable", () => {
  assert.match(server, /app\.post\("\/api\/pawprints\/shopify-checkout"[\s\S]*res\.status\(410\)/);
  assert.match(server, /app\.get\("\/api\/pawprints\/print-orders"/);
  assert.doesNotMatch(shopify, /createPawprintCheckout/);
});
