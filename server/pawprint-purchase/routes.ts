// ─── Phase 3: purchase-gated PawPrints ──────────────────────────────────────
// The gate moved earlier than the original design: nothing is generated until
// the Shopify order webhook confirms payment. That removes the awkward middle
// state where a customer held finished art they had not paid for, and it means
// the prompt they paid for is the prompt that runs — the spec is frozen at
// checkout and read back after payment.
//
// Lifecycle: draft -> paid -> generated -> (review) -> delivered
// A failure after payment never strands the customer silently: the order lands
// in the admin queue with the error recorded.
import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import type mysql from "mysql2/promise";
import { requireAuth, type AuthedRequest } from "../../auth";
import { isUserAdmin } from "../../db";
import { buildCartPermalink, CartPermalinkError } from "./cartPermalink";

export function isPawprintPurchaseGateEnabled(): boolean {
  return process.env.PAWPRINT_PURCHASE_GATE_ENABLED === "true";
}

/** Human review before art is released. Default ON: at launch volume the cost
 *  of a bad render reaching a paying customer far exceeds the cost of a queue. */
export function isPawprintReviewRequired(): boolean {
  return process.env.PAWPRINT_AUTO_APPROVE !== "true";
}

const MAX_PROMPT_LENGTH = 600;
const MAX_PERSONAL_TEXT = 120;

export interface PawprintDraftSpec {
  prompt: string;
  personalText: string;
  categoryId: string | null;
  optionId: string | null;
  photoAssetKeys: string[];
}

export function createPawprintPurchaseRouter(getPool: () => mysql.Pool): Router {
  const router = Router();

  router.use((_req: Request, res: Response, next: () => void) => {
    if (!isPawprintPurchaseGateEnabled()) {
      return res.status(503).json({ error: "PawPrint ordering is not available yet.", code: "FEATURE_DISABLED" });
    }
    next();
  });

  /**
   * Freeze the composed spec and hand back a Shopify cart permalink.
   * Nothing is generated here — that is the entire point of the phase.
   */
  router.post("/checkout", requireAuth, async (req: Request, res: Response) => {
    const userPhone = (req as AuthedRequest).user!.phone;
    try {
      const prompt = String(req.body?.prompt || "").trim().slice(0, MAX_PROMPT_LENGTH);
      const personalText = String(req.body?.personalText || "").trim().slice(0, MAX_PERSONAL_TEXT);
      const photoAssetKeys: string[] = Array.isArray(req.body?.photoAssetKeys)
        ? req.body.photoAssetKeys.filter((k: unknown) => typeof k === "string").slice(0, 10)
        : [];
      if (!prompt) return res.status(400).json({ error: "Describe the PawPrint you'd like." });
      if (!photoAssetKeys.length) return res.status(400).json({ error: "Add at least one pet photo." });

      const pool = getPool();
      // Only a product Shopify has explicitly flagged personalizable can be the
      // checkout target. Failing closed here is deliberate: silently picking an
      // arbitrary product would take money for the wrong item.
      //
      // The customer chooses which one. The handle is re-validated against the
      // same filter rather than trusted, so a stale or forged handle cannot
      // route an order to a product that is not actually on sale. With no
      // handle supplied there is no safe default — a portrait printed on
      // whichever product happens to be cheapest is not a choice anyone made —
      // so the request is refused with the list to choose from.
      const requestedHandle = String(req.body?.productHandle || "").trim().slice(0, 255);
      const [rows]: any = await pool.query(
        `SELECT shopify_product_gid, variants_json, title
           FROM shopify_store_products
          WHERE active = 1 AND published = 1 AND available_for_sale = 1
            AND pawprint_personalizable = 1
            AND handle = ?
          LIMIT 1`,
        [requestedHandle],
      );
      if (!rows.length) {
        const [available]: any = await pool.query(
          `SELECT COUNT(*) AS n FROM shopify_store_products
            WHERE active = 1 AND published = 1 AND available_for_sale = 1
              AND pawprint_personalizable = 1`,
        );
        if (!Number(available[0]?.n || 0)) {
          return res.status(503).json({
            error: "PawPrint prints are not on sale yet. Please check back shortly.",
            code: "NO_PERSONALIZABLE_PRODUCT",
          });
        }
        return res.status(400).json({
          error: "Choose which product to print your PawPrint on.",
          code: "PRODUCT_NOT_CHOSEN",
        });
      }

      let variantGid = "";
      try {
        const variants = JSON.parse(rows[0].variants_json || "[]");
        variantGid = variants?.[0]?.id || variants?.[0]?.variantGid || "";
      } catch {
        variantGid = "";
      }
      if (!variantGid) {
        return res.status(503).json({ error: "That product has no purchasable option right now.", code: "NO_VARIANT" });
      }

      const reference = crypto.randomUUID();
      const spec: PawprintDraftSpec = {
        prompt,
        personalText,
        categoryId: req.body?.categoryId ? String(req.body.categoryId).slice(0, 80) : null,
        optionId: req.body?.optionId ? String(req.body.optionId).slice(0, 80) : null,
        photoAssetKeys,
      };

      const checkoutUrl = buildCartPermalink({
        storeDomain: process.env.SHOPIFY_STORE_DOMAIN || "",
        variantGid,
        reference,
      });

      await pool.query(
        `INSERT INTO pawprint_shopify_orders
           (user_phone, creation_id, shopify_product_id, shopify_variant_id,
            checkout_url, status, idempotency_key, draft_spec_json, review_status)
         VALUES (?, NULL, ?, ?, ?, 'draft', ?, ?, 'none')`,
        [userPhone, rows[0].shopify_product_gid, variantGid, checkoutUrl, reference, JSON.stringify(spec)],
      );

      return res.status(201).json({ success: true, reference, checkoutUrl, product: rows[0].title });
    } catch (err: any) {
      if (err instanceof CartPermalinkError) {
        console.error("[pawprint-purchase/checkout] permalink:", err.code, err.message);
        return res.status(503).json({ error: "Checkout is temporarily unavailable.", code: err.code });
      }
      console.error("[pawprint-purchase/checkout]", err?.message || err);
      return res.status(500).json({ error: "Could not start checkout. Please try again." });
    }
  });

  /**
   * The products a PawPrint can be printed on. Only Shopify-flagged
   * personalizable, published, in-stock products qualify — the same filter the
   * checkout enforces, so the list can never offer something checkout refuses.
   */
  router.get("/products", requireAuth, async (_req: Request, res: Response) => {
    try {
      const [rows]: any = await getPool().query(
        `SELECT shopify_product_gid, handle, title, description, featured_image_url,
                min_price, currency_code, variants_json
           FROM shopify_store_products
          WHERE active = 1 AND published = 1 AND available_for_sale = 1
            AND pawprint_personalizable = 1
          ORDER BY min_price ASC`,
      );
      const products = (rows as any[]).map((row) => ({
        handle: row.handle,
        title: row.title,
        description: row.description,
        imageUrl: row.featured_image_url,
        price: Number(row.min_price),
        currency: row.currency_code,
      }));
      return res.json({ products });
    } catch (err: any) {
      console.error("[pawprint-purchase/products]", err?.message || err);
      return res.status(500).json({ error: "Could not load the print options." });
    }
  });

  /** The customer's own orders, so the UI can show progress after paying. */
  router.get("/orders", requireAuth, async (req: Request, res: Response) => {
    try {
      const [rows]: any = await getPool().query(
        `SELECT idempotency_key AS reference, status, review_status, furbin_item_uuid,
                generation_error, created_at, paid_at
           FROM pawprint_shopify_orders
          WHERE user_phone = ? ORDER BY id DESC LIMIT 25`,
        [(req as AuthedRequest).user!.phone],
      );
      return res.json({ orders: rows });
    } catch (err: any) {
      console.error("[pawprint-purchase/orders]", err?.message || err);
      return res.status(500).json({ error: "Could not load your orders." });
    }
  });

  // ── Admin review queue ────────────────────────────────────────────────────

  const requireAdmin = async (req: Request, res: Response, next: () => void) => {
    const phone = (req as AuthedRequest).user!.phone;
    if (!(await isUserAdmin(phone))) return res.status(403).json({ error: "Admins only." });
    next();
  };

  router.get("/admin/reviews", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const [rows]: any = await getPool().query(
        `SELECT id, user_phone, idempotency_key AS reference, status, review_status,
                draft_spec_json, furbin_item_uuid, generation_error, paid_at, created_at
           FROM pawprint_shopify_orders
          WHERE status IN ('paid','generated','failed')
          ORDER BY paid_at IS NULL, paid_at ASC, id ASC LIMIT 100`,
      );
      return res.json({ reviews: rows });
    } catch (err: any) {
      console.error("[pawprint-purchase/admin/reviews]", err?.message || err);
      return res.status(500).json({ error: "Could not load the review queue." });
    }
  });

  router.post("/admin/reviews/:reference/decide", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const reference = String(req.params.reference || "");
    const decision = String(req.body?.decision || "");
    if (!["approve", "regenerate"].includes(decision)) {
      return res.status(400).json({ error: "Decision must be approve or regenerate." });
    }
    try {
      // Approving releases the art; regenerate sends it back to 'paid' so the
      // generation sweep picks it up again. Payment state is never touched by a
      // review decision — a rejected render is not a refund.
      const [result]: any = await getPool().query(
        `UPDATE pawprint_shopify_orders
            SET review_status = ?, status = ?, reviewed_by = ?, reviewed_at = NOW()
          WHERE idempotency_key = ? AND status IN ('generated','failed')`,
        [
          decision === "approve" ? "approved" : "rejected",
          decision === "approve" ? "delivered" : "paid",
          (req as AuthedRequest).user!.phone,
          reference,
        ],
      );
      if (!result.affectedRows) {
        return res.status(409).json({ error: "That order is not awaiting a review decision." });
      }
      return res.json({ success: true, decision });
    } catch (err: any) {
      console.error("[pawprint-purchase/admin/decide]", err?.message || err);
      return res.status(500).json({ error: "Could not record the decision." });
    }
  });

  return router;
}

/**
 * Turns paid orders into artwork. Runs on an interval rather than inline in the
 * webhook because Shopify expects a fast 200 — generation takes tens of
 * seconds, and a webhook timeout would make Shopify retry and risk duplicate
 * work. Claiming the row first (status paid -> generating) makes that retry
 * safe and keeps two sweep ticks from racing.
 */
export async function sweepPaidPawprintOrders(
  getPool: () => mysql.Pool,
  deps: {
    generate: (spec: PawprintDraftSpec, userPhone: string) => Promise<string>;
    deliver: (userPhone: string, imageBase64: string, spec: PawprintDraftSpec) => Promise<string>;
  },
  limit = 3,
): Promise<{ processed: number; failed: number }> {
  if (!isPawprintPurchaseGateEnabled()) return { processed: 0, failed: 0 };
  const pool = getPool();
  let processed = 0;
  let failed = 0;

  const [rows]: any = await pool.query(
    `SELECT id, user_phone, draft_spec_json FROM pawprint_shopify_orders
      WHERE status = 'paid' ORDER BY paid_at ASC, id ASC LIMIT ?`,
    [limit],
  );

  for (const row of rows as any[]) {
    // Conditional claim: whoever flips paid -> generating owns this order.
    const [claim]: any = await pool.query(
      `UPDATE pawprint_shopify_orders SET status = 'generating'
        WHERE id = ? AND status = 'paid'`,
      [row.id],
    );
    if (!claim.affectedRows) continue;

    let spec: PawprintDraftSpec;
    try {
      spec = JSON.parse(row.draft_spec_json || "{}");
      if (!spec?.prompt) throw new Error("Order has no stored prompt.");
    } catch (err: any) {
      failed += 1;
      await pool.query(
        `UPDATE pawprint_shopify_orders SET status='failed', generation_error=? WHERE id = ?`,
        [String(err?.message || "Unreadable order spec").slice(0, 500), row.id],
      );
      continue;
    }

    try {
      const image = await deliverOrThrow(deps, spec, row.user_phone);
      // Auto-approve short-circuits the queue; review leaves it for an admin.
      const nextStatus = isPawprintReviewRequired() ? "generated" : "delivered";
      const nextReview = isPawprintReviewRequired() ? "pending" : "approved";
      await pool.query(
        `UPDATE pawprint_shopify_orders
            SET status = ?, review_status = ?, furbin_item_uuid = ?, generation_error = NULL
          WHERE id = ?`,
        [nextStatus, nextReview, image, row.id],
      );
      processed += 1;
    } catch (err: any) {
      // A paid customer must never be stranded silently: record the reason and
      // surface the order in the admin queue rather than dropping it.
      failed += 1;
      await pool.query(
        `UPDATE pawprint_shopify_orders SET status='failed', generation_error=? WHERE id = ?`,
        [String(err?.message || "Generation failed").slice(0, 500), row.id],
      );
      console.error(`[pawprint-purchase] order ${row.id} failed:`, err?.message || err);
    }
  }
  return { processed, failed };
}

async function deliverOrThrow(
  deps: { generate: (spec: PawprintDraftSpec, userPhone: string) => Promise<string>;
          deliver: (userPhone: string, imageBase64: string, spec: PawprintDraftSpec) => Promise<string> },
  spec: PawprintDraftSpec,
  userPhone: string,
): Promise<string> {
  const generated = await deps.generate(spec, userPhone);
  if (!generated) throw new Error("Generation returned no image.");
  return deps.deliver(userPhone, generated, spec);
}
