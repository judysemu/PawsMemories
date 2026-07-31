/**
 * Marketplace Product Customizer — P1 business logic.
 * (MARKETPLACE_CUSTOMIZER_SPEC.md §3–§5)
 *
 * This module holds pure / independently-testable functions:
 *   - computeRetailPrice   — margin guard formula
 *   - buildPrintComposite  — server-side sharp composite at print-file resolution
 *   - handleCustomizeOrderPayment — webhook branch handler
 *
 * The Express route (POST /api/customize/checkout) and admin CRUD routes are
 * registered inline in server.ts using registerCustomizerBuyerRoutes(), which
 * is also exported here so server.ts stays thin.
 *
 * Invariant: Printful order is created as a draft and confirmed ONLY after the
 * Stripe webhook fires. Mirrors the pawprint_print_order flow exactly.
 */

import sharp from "sharp";
import { z } from "zod";
import { createHash } from "crypto";
import type { Express, RequestHandler } from "express";
import { getPool } from "../db";
import { uploadBase64Binary } from "../storage";
import {
  createPrintfulOrder,
  getPrintfulOrder,
  confirmPrintfulOrderIfDraft,
} from "./printful";
import { fetchBoundedRemoteBuffer } from "./safeRemoteFetch";

export function isCustomizerCheckoutEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.CUSTOMIZER_CHECKOUT_ENABLED?.trim().toLowerCase() === "true";
}

// ── Pure functions (exported for tests) ──────────────────────────────────────

/**
 * Margin guard: returns the retail price the buyer should pay.
 * Never returns a value that would result in a loss.
 * Re-checked at submit time — a Printful cost increase after publish
 * will raise the price rather than eat the difference.
 */
export function computeRetailPrice(
  publishedRetailCents: number,
  providerCostCents: number,
  markupPercent: number,
  minimumMarginCents: number,
): number {
  return Math.max(
    publishedRetailCents,
    providerCostCents + minimumMarginCents,
    Math.ceil(providerCostCents * (1 + markupPercent / 100)),
  );
}

/**
 * Server-side sharp composite: places the buyer photo inside the admin-defined
 * box on a white canvas sized exactly to the Printful print-file dimensions.
 *
 * The server re-derives this; the client's canvas output is never trusted.
 * Box coordinates are in PIXELS (pre-scaled from the fractional box).
 *
 * Returns a PNG buffer — posters are forgiving; apparel/PNG alpha is P3.
 */
export async function buildPrintComposite(
  sourceBuffer: Buffer,
  widthPx: number,
  heightPx: number,
  boxXPx: number,
  boxYPx: number,
  boxWPx: number,
  boxHPx: number,
): Promise<Buffer> {
  if (widthPx <= 0 || heightPx <= 0 || boxWPx <= 0 || boxHPx <= 0) {
    throw new Error("Print-file dimensions must be positive integers.");
  }
  // Resize buyer photo to cover the placement box exactly.
  const photoResized = await sharp(sourceBuffer)
    .resize({ width: boxWPx, height: boxHPx, fit: "cover" })
    .toBuffer();
  // Composite onto a white canvas at full print-file resolution.
  return sharp({
    create: {
      width: widthPx,
      height: heightPx,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([{ input: photoResized, left: boxXPx, top: boxYPx }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// ── Zod schema (exported for tests) ──────────────────────────────────────────

export const customizerCheckoutSchema = z.object({
  customizableId: z.number().int().positive(),
  sourcePhotoUrl: z.string().url().max(2048),
  sourceKind: z.enum(["upload", "furbin"]),
  recipient: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(200),
    address1: z.string().trim().min(3).max(200),
    city: z.string().trim().min(2).max(80),
    state_code: z.string().trim().max(10).optional(),
    country_code: z
      .string()
      .trim()
      .length(2)
      .transform((v) => v.toUpperCase()),
    zip: z.string().trim().min(2).max(20),
  }),
});

function decodeCustomizerDataImage(value: string): Buffer {
  const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(
    value,
  );
  if (!match)
    throw new Error("Uploaded customizer photos must be PNG, JPEG, or WebP.");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 25 * 1024 * 1024) {
    throw new Error("The source photo is too large (max 25 MB).");
  }
  return buffer;
}

function customizerMediaOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const endpoint = env.MEDIA_BUCKET_URL;
  const bucket = env.MEDIA_BUCKET_NAME;
  if (!endpoint || !bucket) return [];
  const url = new URL(endpoint);
  return [url.origin, `${url.protocol}//${bucket}.${url.host}`];
}

export async function resolveOwnedCustomizerSource(
  ownerId: string,
  sourceKind: "upload" | "furbin",
  sourcePhotoUrl: string,
): Promise<Buffer> {
  if (sourceKind === "upload") return decodeCustomizerDataImage(sourcePhotoUrl);
  const [ownedRows] = (await getPool().query(
    `SELECT image_url FROM creations
      WHERE user_phone=? AND image_url=? LIMIT 1`,
    [ownerId, sourcePhotoUrl],
  )) as any;
  if (!ownedRows?.[0])
    throw new Error("The selected Fur Bin photo is not owned by this account.");
  if (sourcePhotoUrl.startsWith("data:"))
    return decodeCustomizerDataImage(sourcePhotoUrl);
  const fetched = await fetchBoundedRemoteBuffer(sourcePhotoUrl, {
    allowedOrigins: customizerMediaOrigins(),
    maxBytes: 25 * 1024 * 1024,
    timeoutMs: 20_000,
    allowedContentTypes: ["image/png", "image/jpeg", "image/webp"],
  });
  return fetched.buffer;
}

// ── Webhook handler (exported for tests; called from server.ts) ───────────────

/**
 * Handles the Stripe webhook for a completed customize_order payment.
 * Mirrors the pawprint_print_order branch exactly:
 *   claim row → fetch provider_order_id → confirmPrintfulOrderIfDraft → update status.
 *
 * Never confirms the Printful order before this function is called.
 */
export async function handleCustomizeOrderPayment(
  metadata: Record<string, string>,
): Promise<void> {
  const customizeOrderId = Number(metadata.customizeOrderId);
  if (!customizeOrderId || !metadata.userPhone) return;

  const [claimed] = (await getPool().query(
    `UPDATE customize_orders SET status = 'submitting', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_phone = ? AND status IN ('awaiting_payment', 'payment_received')`,
    [customizeOrderId, metadata.userPhone],
  )) as any;
  if (!claimed?.affectedRows) {
    console.log(
      `↩︎ Customize order ${customizeOrderId} already submitted or in progress.`,
    );
    return;
  }

  const [rows] = (await getPool().query(
    `SELECT provider_order_id FROM customize_orders WHERE id = ? AND user_phone = ? LIMIT 1`,
    [customizeOrderId, metadata.userPhone],
  )) as any;
  const providerOrderId = String(rows?.[0]?.provider_order_id || "");
  if (!providerOrderId) {
    throw new Error(
      `Customize order ${customizeOrderId} has no Printful order ID.`,
    );
  }

  try {
    const confirmed = await confirmPrintfulOrderIfDraft(providerOrderId);
    const status = String(confirmed?.status || "pending").toLowerCase();
    await getPool().query(
      `UPDATE customize_orders SET status = ?, provider_payload_json = ? WHERE id = ?`,
      [status, JSON.stringify(confirmed || {}), customizeOrderId],
    );
  } catch (error) {
    // Revert to payment_received so the webhook can be retried.
    await getPool().query(
      `UPDATE customize_orders SET status = 'payment_received' WHERE id = ?`,
      [customizeOrderId],
    );
    throw error;
  }
}

// ── Route registration (called from server.ts) ────────────────────────────────

export function registerCustomizerBuyerRoutes(
  app: Express,
  deps: {
    stripe: any;
    requireAuth: RequestHandler;
    paidLimiter: RequestHandler;
    requireMarketplaceAdmin: (req: any, res: any) => Promise<boolean>;
  },
): void {
  const { stripe, requireAuth, paidLimiter, requireMarketplaceAdmin } = deps;

  // ── Admin: manage customizable_products rows ──────────────────────────────

  /** Create a customizable product (admin only). */
  app.post(
    "/api/admin/customizer/customizable-products",
    requireAuth,
    async (req: any, res) => {
      if (!(await requireMarketplaceAdmin(req, res))) return;
      try {
        const schema = z.object({
          listingId: z.number().int().positive(),
          printfulProductId: z.number().int().positive(),
          printfulVariantId: z.number().int().positive(),
          placement: z.string().min(1).max(32).default("default"),
          printfileWidthPx: z.number().int().positive(),
          printfileHeightPx: z.number().int().positive(),
          printfileDpi: z.number().int().positive().default(150),
          boxX: z.number().min(0).max(1),
          boxY: z.number().min(0).max(1),
          boxW: z.number().min(0.01).max(1),
          boxH: z.number().min(0.01).max(1),
          boxShape: z.enum(["rect", "circle", "arch"]).default("rect"),
          retailPriceCents: z.number().int().positive(),
          status: z.enum(["draft", "published"]).default("draft"),
        });
        const input = schema.parse(req.body);
        const [result] = (await getPool().query(
          `INSERT INTO customizable_products
          (listing_id, printful_product_id, printful_variant_id, placement,
           printfile_width_px, printfile_height_px, printfile_dpi,
           box_x, box_y, box_w, box_h, box_shape,
           retail_price_cents, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.listingId,
            input.printfulProductId,
            input.printfulVariantId,
            input.placement,
            input.printfileWidthPx,
            input.printfileHeightPx,
            input.printfileDpi,
            input.boxX,
            input.boxY,
            input.boxW,
            input.boxH,
            input.boxShape,
            input.retailPriceCents,
            input.status,
          ],
        )) as any;
        res.status(201).json({ success: true, id: result.insertId });
      } catch (error: any) {
        if (error instanceof z.ZodError)
          return res
            .status(400)
            .json({ error: error.issues[0]?.message || "Validation failed." });
        console.error(
          "[POST /api/admin/customizer/customizable-products]",
          error,
        );
        res.status(500).json({ error: error.message });
      }
    },
  );

  /** List customizable products (admin only). */
  app.get(
    "/api/admin/customizer/customizable-products",
    requireAuth,
    async (req: any, res) => {
      if (!(await requireMarketplaceAdmin(req, res))) return;
      try {
        const status = String(req.query.status || "").trim() || null;
        const [rows] = (await getPool().query(
          `SELECT * FROM customizable_products${status ? " WHERE status = ?" : ""} ORDER BY id DESC LIMIT 100`,
          status ? [status] : [],
        )) as any;
        res.json(rows);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  /** Public: list published customizable products for Shop display. */
  app.get("/api/customize/products", async (_req, res) => {
    if (!isCustomizerCheckoutEnabled()) return res.json({ products: [] });
    try {
      const [rows] = (await getPool().query(
        `SELECT
           cp.id,
           cp.listing_id,
           cp.placement,
           cp.printfile_width_px,
           cp.printfile_height_px,
           cp.printfile_dpi,
           cp.box_x,
           cp.box_y,
           cp.box_w,
           cp.box_h,
           cp.box_shape,
           cp.overlay_asset_uuid,
           cp.retail_price_cents,
           cp.status,
           cp.created_at,
           cp.updated_at,
           l.name AS listing_name,
           l.slug AS listing_slug,
           l.description AS listing_description
         FROM customizable_products cp
         LEFT JOIN marketplace_listings l ON cp.listing_id = l.id
         WHERE cp.status = 'published'
         ORDER BY cp.id DESC LIMIT 100`,
      )) as any;
      res.json({ products: rows || [] });
    } catch (error: any) {
      console.error("[GET /api/customize/products]", error);
      res.status(500).json({ error: error.message });
    }
  });

  /** Buyer: list user's customizer orders for FurBin display with tracking. */
  app.get("/api/customize/orders", requireAuth, async (req: any, res) => {
    try {
      const [rows] = (await getPool().query(
        `SELECT o.*, cp.printful_product_id, cp.printful_variant_id, cp.placement
         FROM customize_orders o
         LEFT JOIN customizable_products cp ON o.customizable_id = cp.id
         WHERE o.user_phone = ?
         ORDER BY o.id DESC LIMIT 50`,
        [req.user.phone],
      )) as any;
      res.json({ orders: rows || [] });
    } catch (error: any) {
      console.error("[GET /api/customize/orders]", error);
      res.status(500).json({ error: error.message });
    }
  });

  /** Update a customizable product (admin only). */
  app.patch(
    "/api/admin/customizer/customizable-products/:id",
    requireAuth,
    async (req: any, res) => {
      if (!(await requireMarketplaceAdmin(req, res))) return;
      try {
        const schema = z.object({
          status: z.enum(["draft", "published", "archived"]).optional(),
          retailPriceCents: z.number().int().positive().optional(),
          boxX: z.number().min(0).max(1).optional(),
          boxY: z.number().min(0).max(1).optional(),
          boxW: z.number().min(0.01).max(1).optional(),
          boxH: z.number().min(0.01).max(1).optional(),
        });
        const input = schema.parse(req.body);
        const sets: string[] = [];
        const vals: any[] = [];
        if (input.status !== undefined) {
          sets.push("status = ?");
          vals.push(input.status);
        }
        if (input.retailPriceCents !== undefined) {
          sets.push("retail_price_cents = ?");
          vals.push(input.retailPriceCents);
        }
        if (input.boxX !== undefined) {
          sets.push("box_x = ?");
          vals.push(input.boxX);
        }
        if (input.boxY !== undefined) {
          sets.push("box_y = ?");
          vals.push(input.boxY);
        }
        if (input.boxW !== undefined) {
          sets.push("box_w = ?");
          vals.push(input.boxW);
        }
        if (input.boxH !== undefined) {
          sets.push("box_h = ?");
          vals.push(input.boxH);
        }
        if (!sets.length)
          return res.status(400).json({ error: "Nothing to update." });
        vals.push(Number(req.params.id));
        await getPool().query(
          `UPDATE customizable_products SET ${sets.join(", ")} WHERE id = ?`,
          vals,
        );
        res.json({ success: true });
      } catch (error: any) {
        if (error instanceof z.ZodError)
          return res
            .status(400)
            .json({ error: error.issues[0]?.message || "Validation failed." });
        res.status(500).json({ error: error.message });
      }
    },
  );

  // ── Buyer: POST /api/customize/checkout ──────────────────────────────────

  /**
   * Creates a customize_order row, a draft Printful order, and a Stripe session.
   * Idempotency-Key required. Mirrors POST /api/pawprints/printful-order exactly.
   *
   * Non-negotiables:
   *  - Server re-derives the print file; never trusts client-supplied dimensions.
   *  - Printful order is draft-only here; confirmed only in webhook.
   *  - Margin guard re-checked at submit time; order fails rather than eats a loss.
   */
  app.post(
    "/api/customize/checkout",
    requireAuth,
    paidLimiter,
    async (req: any, res) => {
      let preparedOrderId: number | null = null;
      try {
        if (!isCustomizerCheckoutEnabled()) {
          return res
            .status(503)
            .json({ error: "Custom product checkout is not available yet." });
        }
        if (!stripe) {
          return res
            .status(503)
            .json({
              error: "Stripe checkout is not configured for physical orders.",
            });
        }

        const input = customizerCheckoutSchema.parse(req.body);
        const idempotencyKey = String(req.header("Idempotency-Key") || "")
          .trim()
          .slice(0, 128);
        if (!idempotencyKey)
          return res
            .status(400)
            .json({ error: "An idempotency key is required." });

        // Idempotent resume: if this key was already used, return the existing order.
        const [existingRows] = (await getPool().query(
          `SELECT id, retail_price_cents, status, checkout_url
         FROM customize_orders WHERE user_phone = ? AND idempotency_key = ? LIMIT 1`,
          [req.user.phone, idempotencyKey],
        )) as any;
        if (existingRows?.[0]) {
          return res.json({
            success: true,
            idempotent: true,
            order: existingRows[0],
            checkoutUrl: existingRows[0].checkout_url,
          });
        }

        // Load the published product config — never read from request body.
        const [productRows] = (await getPool().query(
          `SELECT id, printful_product_id, printful_variant_id, placement,
                printfile_width_px, printfile_height_px,
                box_x, box_y, box_w, box_h,
                retail_price_cents
         FROM customizable_products WHERE id = ? AND status = 'published' LIMIT 1`,
          [input.customizableId],
        )) as any;
        const cp = productRows?.[0];
        if (!cp)
          return res
            .status(404)
            .json({ error: "This customizable product is not available." });

        // Translate fractional box to pixels at the authoritative printfile resolution.
        const widthPx = Number(cp.printfile_width_px);
        const heightPx = Number(cp.printfile_height_px);
        const boxXPx = Math.round(Number(cp.box_x) * widthPx);
        const boxYPx = Math.round(Number(cp.box_y) * heightPx);
        const boxWPx = Math.round(Number(cp.box_w) * widthPx);
        const boxHPx = Math.round(Number(cp.box_h) * heightPx);

        // Resolve only a local upload data URL or an exact owner-scoped Fur Bin
        // URL. Arbitrary caller URLs never reach the network.
        const sourceBuffer = await resolveOwnedCustomizerSource(
          req.user.phone,
          input.sourceKind,
          input.sourcePhotoUrl,
        );

        // Server-side sharp composite at printfile resolution.
        const printBuffer = await buildPrintComposite(
          sourceBuffer,
          widthPx,
          heightPx,
          boxXPx,
          boxYPx,
          boxWPx,
          boxHPx,
        );
        // Pass explicit mime type — uploadBase64Binary defaults to model/gltf-binary otherwise.
        const printFileUrl = await uploadBase64Binary(
          printBuffer.toString("base64"),
          "image/png",
          "customizer-print",
        );

        // Create draft Printful order. Customer never sees the provider.
        const externalId = `customize-${createHash("sha256")
          .update(`${req.user.phone}:${idempotencyKey}`)
          .digest("hex")
          .slice(0, 32)}`;
        const order = await createPrintfulOrder({
          recipient: {
            name: input.recipient.name,
            email: input.recipient.email,
            address1: input.recipient.address1,
            city: input.recipient.city,
            state_code: input.recipient.state_code || undefined,
            country_code: String(
              input.recipient.country_code || "US",
            ).toUpperCase(),
            zip: input.recipient.zip,
          },
          imageUrl: printFileUrl,
          variantId: Number(cp.printful_variant_id),
          quantity: 1,
          externalId,
        });

        // Margin guard: re-check cost at submit time, not just at publish time.
        const currentOrder = order.costs?.total
          ? order
          : await getPrintfulOrder(order.id);
        const providerCurrency = String(
          currentOrder?.costs?.currency || "USD",
        ).toUpperCase();
        if (providerCurrency !== "USD") {
          throw new Error(
            `Printful returned ${providerCurrency} pricing, but checkout is configured for USD.`,
          );
        }
        const providerCost = Number(currentOrder?.costs?.total || 0);
        if (!Number.isFinite(providerCost) || providerCost <= 0) {
          throw new Error(
            "Printful is still calculating this order. Try again after the print file finishes processing.",
          );
        }
        const providerCostCents = Math.ceil(providerCost * 100);
        const markupPercent = Math.max(
          0,
          Number(process.env.FULFILLMENT_MARKUP_PERCENT || 80),
        );
        const minimumMarginCents = Math.max(
          0,
          Number(process.env.FULFILLMENT_MIN_MARGIN_CENTS || 500),
        );
        const retailPriceCents = computeRetailPrice(
          Number(cp.retail_price_cents),
          providerCostCents,
          markupPercent,
          minimumMarginCents,
        );

        // Insert order row as awaiting_payment.
        const [inserted] = (await getPool().query(
          `INSERT INTO customize_orders
          (user_phone, customizable_id, source_photo_url, source_kind, print_file_url,
           recipient_json, retail_price_cents, provider_order_id, provider_payload_json,
           status, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?)
         ON DUPLICATE KEY UPDATE
           provider_order_id = VALUES(provider_order_id),
           status             = VALUES(status),
           updated_at         = CURRENT_TIMESTAMP`,
          [
            req.user.phone,
            input.customizableId,
            input.sourcePhotoUrl,
            input.sourceKind,
            printFileUrl,
            JSON.stringify(input.recipient),
            retailPriceCents,
            order.id,
            JSON.stringify(currentOrder || order),
            idempotencyKey,
          ],
        )) as any;
        preparedOrderId = Number(inserted.insertId);

        // Create Stripe Checkout session with type tag for webhook routing.
        const appUrl = process.env.APP_URL || "http://localhost:3000";
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: "Custom Photo Product",
                  description:
                    "Printed and fulfilled by our print partner — we keep it simple.",
                  images: [printFileUrl],
                },
                unit_amount: retailPriceCents,
              },
              quantity: 1,
            },
          ],
          customer_email: input.recipient.email,
          mode: "payment",
          metadata: {
            type: "customize_order",
            customizeOrderId: String(preparedOrderId),
            userPhone: req.user.phone,
            printfulOrderId: String(order.id),
          },
          success_url: `${appUrl}/?customize_success=true&order_id=${preparedOrderId}`,
          cancel_url: `${appUrl}/?customize_cancelled=true&order_id=${preparedOrderId}`,
        });

        await getPool().query(
          `UPDATE customize_orders SET checkout_url = ?, stripe_session_id = ? WHERE id = ?`,
          [session.url, session.id, preparedOrderId],
        );

        res.status(201).json({
          success: true,
          checkoutUrl: session.url,
          retailPriceCents,
          order: { ...order, printFileUrl },
        });
      } catch (error: any) {
        // Mark failed so a fresh idempotency key can retry (don't block the key forever).
        if (preparedOrderId) {
          try {
            await getPool().query(
              `UPDATE customize_orders SET status = 'failed' WHERE id = ?`,
              [preparedOrderId],
            );
          } catch {}
        }
        if (error instanceof z.ZodError) {
          return res
            .status(400)
            .json({ error: error.issues[0]?.message || "Invalid request." });
        }
        const message =
          error?.message || "Could not create the customizer order.";
        if (/not configured/i.test(message))
          return res.status(503).json({ error: message });
        console.error("[POST /api/customize/checkout] Error:", message);
        res.status(502).json({ error: message });
      }
    },
  );
}
