#!/usr/bin/env node
/**
 * verify-shopify-checkout.mjs
 * ============================
 * Drives the real Pawprints print-checkout flow end to end with zero manual
 * clicking, using headless Chromium (Playwright). Two modes:
 *
 *   --stop-before-payment   Loads the real cart/checkout page for a real
 *                           Pawprints product, screenshots it, and closes
 *                           without submitting. No money moves, no discount
 *                           code needed. This is the Milestone-3 evidence
 *                           that the Shopify flow works without a purchase.
 *
 *   --complete               Creates a single-use 100%-off discount code,
 *                           drives the checkout to a real $0 completed
 *                           order, confirms POST /api/webhooks/shopify-orders
 *                           flips pawprint_shopify_orders.status to 'paid',
 *                           then deletes the discount code and cancels the
 *                           test order so nothing pollutes real sales data.
 *                           This is the Milestone-2 evidence that the
 *                           checkout -> webhook loop works, with no manual
 *                           input once triggered.
 *
 * Requires (same vars used elsewhere in this repo):
 *   APP_BASE_URL (default https://pawsome3d.com)
 *   SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_API_VERSION
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 *
 * One-time setup: `npx playwright install chromium`
 *
 * Note: Shopify's checkout markup can change between theme/platform updates.
 * This uses label/role-based locators (resilient to CSS churn) rather than
 * raw selectors, but a real checkout redesign may still require updates here.
 */

import { chromium } from "playwright";
import mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";

const APP_BASE_URL = process.env.APP_BASE_URL || "https://pawsome3d.com";
const TEST_USER_EMAIL = process.env.VERIFY_TEST_EMAIL || "pawprint-checkout-verify@pawsome3d.com";
const TEST_USER_PASSWORD = process.env.VERIFY_TEST_PASSWORD || `Verify-${randomUUID().slice(0, 8)}!`;
// The Halloween Dog Bone Woven Blanket — the one live, genuinely
// photo-customizable PRINT_PRODUCTS entry as of this script's writing
// (shared/pawprintCatalog2.ts). Override via env if the catalog changes.
const TEST_SHOPIFY_PRODUCT_ID = process.env.VERIFY_SHOPIFY_PRODUCT_ID || "10550364111029";
const TEST_SHOPIFY_VARIANT_ID = process.env.VERIFY_SHOPIFY_VARIANT_ID || "52958687428789";
const OUTPUT_DIR = new URL("./verify-shopify-checkout-output/", import.meta.url);

const mode = process.argv.includes("--complete")
  ? "complete"
  : process.argv.includes("--stop-before-payment")
    ? "stop-before-payment"
    : null;
if (!mode) {
  console.error("Usage: node scripts/verify-shopify-checkout.mjs --stop-before-payment | --complete");
  process.exit(2);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see .env.example).`);
  return value;
}

// ---------------------------------------------------------------------------
// Shopify Admin API (client-credentials) — mirrors server/shopify.ts's own
// token-fetch pattern, kept self-contained here since this is a plain script.
// ---------------------------------------------------------------------------
async function shopifyAdmin() {
  const domain = requireEnv("SHOPIFY_STORE_DOMAIN").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-07";
  const clientId = requireEnv("SHOPIFY_CLIENT_ID");
  const clientSecret = requireEnv("SHOPIFY_CLIENT_SECRET");
  const tokenResponse = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  const tokenPayload = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenPayload?.access_token) {
    throw new Error(`Shopify token exchange failed: ${tokenPayload?.error_description || tokenResponse.status}`);
  }
  const base = `https://${domain}/admin/api/${apiVersion}`;
  const headers = { "X-Shopify-Access-Token": tokenPayload.access_token, "Content-Type": "application/json" };
  const call = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Shopify ${init.method || "GET"} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
    return payload;
  };
  return { domain, call };
}

async function createSingleUseDiscountCode(admin) {
  const code = `PAWPRINT-VERIFY-${randomUUID().slice(0, 8).toUpperCase()}`;
  const endsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour, generous for a same-run test
  const priceRule = await admin.call("/price_rules.json", {
    method: "POST",
    body: JSON.stringify({
      price_rule: {
        title: `Pawprint checkout verification (${code})`,
        target_type: "line_item",
        target_selection: "entitled",
        entitled_variant_ids: [Number(TEST_SHOPIFY_VARIANT_ID)],
        allocation_method: "across",
        value_type: "percentage",
        value: "-100.0",
        customer_selection: "all",
        usage_limit: 1,
        starts_at: new Date().toISOString(),
        ends_at: endsAt,
      },
    }),
  });
  const priceRuleId = priceRule.price_rule.id;
  await admin.call(`/price_rules/${priceRuleId}/discount_codes.json`, {
    method: "POST",
    body: JSON.stringify({ discount_code: { code } }),
  });
  return { code, priceRuleId };
}

async function deleteDiscountCode(admin, priceRuleId) {
  await admin.call(`/price_rules/${priceRuleId}.json`, { method: "DELETE" }).catch((err) =>
    console.warn(`[cleanup] Could not delete price rule ${priceRuleId}: ${err.message}`));
}

async function findAndCancelTestOrder(admin, orderReference) {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { orders } = await admin.call(`/orders.json?status=any&created_at_min=${encodeURIComponent(since)}&limit=10`);
  const match = (orders || []).find((order) => String(order.note || "").includes(orderReference));
  if (!match) {
    console.warn(`[cleanup] Could not find the test order to cancel (reference ${orderReference}). Check Shopify Admin manually.`);
    return null;
  }
  await admin.call(`/orders/${match.id}/cancel.json`, { method: "POST", body: JSON.stringify({ reason: "other" }) });
  console.log(`[cleanup] Cancelled test order #${match.order_number} (id ${match.id}).`);
  return match;
}

// ---------------------------------------------------------------------------
// App-side fixture: a real logged-in test user + a minimal creation to check
// out, via the app's own HTTP API (not a DB shortcut) so the real
// /api/pawprints/shopify-checkout route and insertPawprintShopifyOrder path
// are genuinely exercised.
// ---------------------------------------------------------------------------
async function ensureTestUserToken() {
  const signup = await fetch(`${APP_BASE_URL}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD, confirmPassword: TEST_USER_PASSWORD, acceptedTerms: true,
    }),
  });
  const signupPayload = await signup.json();
  let token = signupPayload?.token;
  if (signup.status === 409) {
    // Already exists from a prior run — VERIFY_TEST_PASSWORD must match what
    // was used to create it, or set VERIFY_TEST_EMAIL to a fresh address.
    const login = await fetch(`${APP_BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD }),
    });
    const loginPayload = await login.json();
    if (!login.ok) throw new Error(`Could not log in as the test user: ${loginPayload?.error || login.status}. Set VERIFY_TEST_PASSWORD to match the account, or VERIFY_TEST_EMAIL to a fresh address.`);
    token = loginPayload.token;
  } else if (!signup.ok) {
    throw new Error(`Could not create the test user: ${signupPayload?.error || signup.status}`);
  } else {
    await fetch(`${APP_BASE_URL}/api/auth/complete-profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fullName: "Pawprint Checkout Verify", birthdate: "1990-01-01", city: "Denver" }),
    });
  }
  return token;
}

async function createFixtureCreation(db, userPhone) {
  const imageUrl = `${APP_BASE_URL}/brand/pawprints.png`;
  const [result] = await db.query(
    `INSERT INTO creations (user_phone, media_type, style, backdrop_kind, preset_name, image_url, pet_name)
     VALUES (?, 'still', 'Artistic', 'preset', 'pawprint', ?, 'Checkout Verification')`,
    [userPhone, imageUrl],
  );
  return result.insertId;
}

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: requireEnv("DB_USER"),
    password: process.env.DB_PASSWORD || "",
    database: requireEnv("DB_NAME"),
  });

  try {
    console.log(`[1/5] Authenticating as test user ${TEST_USER_EMAIL}...`);
    const token = await ensureTestUserToken();
    const [[userRow]] = await db.query(`SELECT phone FROM users WHERE email = ? LIMIT 1`, [TEST_USER_EMAIL]);
    if (!userRow) throw new Error("Test user was created but not found in the database — check DB_* env vars point at the same database the app uses.");

    console.log("[2/5] Seeding a fixture Fur Bin creation to check out...");
    const creationId = await createFixtureCreation(db, userRow.phone);

    console.log("[3/5] Requesting a real checkout URL from POST /api/pawprints/shopify-checkout...");
    const idempotencyKey = randomUUID();
    const checkoutResponse = await fetch(`${APP_BASE_URL}/api/pawprints/shopify-checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ creationId, shopifyProductId: TEST_SHOPIFY_PRODUCT_ID, shopifyVariantId: TEST_SHOPIFY_VARIANT_ID }),
    });
    const checkoutPayload = await checkoutResponse.json();
    if (!checkoutResponse.ok || !checkoutPayload.checkoutUrl) {
      throw new Error(`shopify-checkout failed: ${checkoutPayload.error || checkoutResponse.status}`);
    }
    console.log(`       checkoutUrl: ${checkoutPayload.checkoutUrl}`);

    await import("node:fs/promises").then((fs) => fs.mkdir(OUTPUT_DIR, { recursive: true }));
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    if (mode === "stop-before-payment") {
      console.log("[4/5] Loading the real checkout page (screenshot only, no submission)...");
      await page.goto(checkoutPayload.checkoutUrl, { waitUntil: "networkidle", timeout: 30_000 });
      const screenshotPath = new URL(`stop-before-payment-${Date.now()}.png`, OUTPUT_DIR);
      await page.screenshot({ path: screenshotPath.pathname, fullPage: true });
      await browser.close();
      console.log(`[5/5] Screenshot saved: ${screenshotPath.pathname}`);
      console.log("No discount code created, nothing submitted, no order placed.");
      return;
    }

    // --complete: drive a real, zero-cost order through to completion.
    console.log("[4/5] Creating a single-use 100%-off discount code and completing checkout...");
    const admin = await shopifyAdmin();
    const { code, priceRuleId } = await createSingleUseDiscountCode(admin);
    try {
      const discountedUrl = `${checkoutPayload.checkoutUrl}&discount=${encodeURIComponent(code)}`;
      await page.goto(discountedUrl, { waitUntil: "networkidle", timeout: 30_000 });

      // Contact + shipping — required even on a $0 order. Uses role/label
      // locators so minor theme markup changes don't break this.
      await page.getByLabel(/email/i).first().fill("pawprint-checkout-verify@pawsome3d.com");
      const fillIfPresent = async (label, value) => {
        const field = page.getByLabel(label, { exact: false }).first();
        if (await field.count()) await field.fill(value);
      };
      await fillIfPresent(/first name/i, "Pawprint");
      await fillIfPresent(/last name/i, "Verify");
      await fillIfPresent(/^address$|address 1/i, "123 Test Ave");
      await fillIfPresent(/^city$/i, "Denver");
      await fillIfPresent(/^zip|postal code/i, "80202");
      await fillIfPresent(/phone/i, "3035550100");

      const continueOrPay = page.getByRole("button", { name: /pay now|complete order|continue to|continue/i }).first();
      await continueOrPay.click({ timeout: 15_000 }).catch(() => {});
      // A $0 total may require one more "Pay now"-style click after shipping.
      const payNow = page.getByRole("button", { name: /pay now|complete order/i }).first();
      if (await payNow.count()) await payNow.click({ timeout: 15_000 }).catch(() => {});

      await page.waitForURL(/thank[_-]?you|orders\//i, { timeout: 30_000 }).catch(() => {});
      const screenshotPath = new URL(`complete-${Date.now()}.png`, OUTPUT_DIR);
      await page.screenshot({ path: screenshotPath.pathname, fullPage: true });
      console.log(`       Order confirmation screenshot: ${screenshotPath.pathname}`);
    } finally {
      await browser.close();
    }

    console.log("[5/5] Waiting for the orders/paid webhook to update pawprint_shopify_orders.status...");
    let finalStatus = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const [[row]] = await db.query(
        `SELECT status FROM pawprint_shopify_orders WHERE user_phone = ? AND idempotency_key = ? LIMIT 1`,
        [userRow.phone, idempotencyKey],
      );
      finalStatus = row?.status || null;
      if (finalStatus === "paid") break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    console.log(`       pawprint_shopify_orders.status = ${finalStatus}`);

    console.log("Cleaning up: deleting the discount code and cancelling the test order...");
    await deleteDiscountCode(admin, priceRuleId);
    await findAndCancelTestOrder(admin, `pawprint_order:${idempotencyKey}`);

    if (finalStatus !== "paid") {
      throw new Error(
        "Order completed in Shopify but pawprint_shopify_orders.status never flipped to 'paid'. " +
        "Check: is the orders/paid webhook registered in Shopify Admin against " +
        "POST /api/webhooks/shopify-orders? Is SHOPIFY_WEBHOOK_SECRET set and matching? " +
        "Is the deployed app the one with this change (see docs/AUTOMATIONS.md)?",
      );
    }
    console.log("Verified end to end: checkout -> Shopify order -> webhook -> status update.");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error("verify-shopify-checkout.mjs failed:", error.message || error);
  process.exit(1);
});
