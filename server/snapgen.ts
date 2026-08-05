import type { Express, Response } from "express";
import crypto from "node:crypto";
import { requireAuth, type AuthedRequest } from "../auth";
import { getPool } from "../db";
import { uploadBase64Image, uploadBinaryFromUrl } from "../storage";
import { startImageTo3D, pollImageTo3D, type TripoJobInput } from "../tripo";
import {
  SnapgenPurchaseError,
  assertSnapgenProductionConfiguration,
  claimSnapgenPoll,
  claimSnapgenSubmission,
  persistSnapgenProviderHandle,
  quarantineSnapgenOrder,
  reserveSnapgenOrder,
  snapgenSha256,
} from "./snapgenStore";
import { rejectLegacyExternal3dRoute } from "./externalGenerativePolicy";

/**
 * SnapGen API — pic-to-3D storefront (Phase 0).
 *
 * Mounted under /api/snapgen/*. Reuses PawsMemories auth (JWT), storage
 * (Backblaze) and the Tripo pipeline. All tables are prefixed sg_ (see
 * server/migrations/002_snapgen_tables.sql).
 *
 * Purchase model: one-time IAP per model (Google Play Billing via RevenueCat).
 * Generation only starts after a purchase token is verified. In development,
 * set SNAPGEN_SKIP_PURCHASE_VERIFY=1 to bypass verification.
 *
 * Env vars:
 *   SNAPGEN_SKIP_PURCHASE_VERIFY  ("1" in dev only)
 *   REVENUECAT_WEBHOOK_SECRET     (Authorization header value RevenueCat sends)
 */

const REMAKE_DISCOUNT = 0.5; // remakes are 50% off base price

// ---------------------------------------------------------------------------
// Customization options — every field OPTIONAL with a safe default so the
// generator can never error or drift on missing/garbage input.
// ---------------------------------------------------------------------------

const STYLE_PRESETS = ["realistic", "hyper-realistic", "cyberpunk", "industrial", "anatomical", "low-poly"] as const;
const SURFACE_FINISHES = ["matte", "gloss", "metallic", "iridescent"] as const;
const POSES = ["standing", "sitting", "laying"] as const;
const MESH_DENSITIES = ["low", "medium", "high"] as const;

export interface SnapgenOptions {
  prompt: string;          // free text, sanitized, "" allowed
  negativePrompt: string;  // free text, sanitized, "" allowed
  stylePreset: (typeof STYLE_PRESETS)[number];
  surfaceFinish: (typeof SURFACE_FINISHES)[number];
  pose: (typeof POSES)[number];
  meshDensity: (typeof MESH_DENSITIES)[number];
  palette: string | null;  // hex or named palette id
  tags: string[];
  location: string;        // capture location label, optional metadata
}

function sanitizeText(v: unknown, maxLen: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function pick<T extends readonly string[]>(v: unknown, allowed: T, fallback: T[number]): T[number] {
  const s = typeof v === "string" ? v.toLowerCase().trim() : "";
  return (allowed as readonly string[]).includes(s) ? (s as T[number]) : fallback;
}

/** Coerce arbitrary client input into a guaranteed-safe options object. */
export function normalizeOptions(raw: any): SnapgenOptions {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    prompt: sanitizeText(o.prompt, 500),
    negativePrompt: sanitizeText(o.negativePrompt, 300),
    stylePreset: pick(o.stylePreset, STYLE_PRESETS, "realistic"),
    surfaceFinish: pick(o.surfaceFinish, SURFACE_FINISHES, "matte"),
    pose: pick(o.pose, POSES, "standing"),
    meshDensity: pick(o.meshDensity, MESH_DENSITIES, "medium"),
    palette: typeof o.palette === "string" && /^#?[0-9a-fA-F]{3,8}$|^[a-z0-9_-]{1,32}$/.test(o.palette) ? o.palette : null,
    tags: Array.isArray(o.tags) ? o.tags.slice(0, 10).map((t: unknown) => sanitizeText(t, 32)).filter(Boolean) : [],
    location: sanitizeText(o.location, 120),
  };
}

interface TierRow {
  code: string;
  name: string;
  price_cents: number;
  face_limit: number;
  pbr: number;
  rig: number;
  texture_res: string;
}

/** Map a tier + mesh density to Tripo geometry settings. */
function tierToGeometry(tier: TierRow, density: SnapgenOptions["meshDensity"]) {
  const densityScale = density === "low" ? 0.5 : density === "high" ? 1.0 : 0.75;
  return {
    faceLimit: Math.max(2000, Math.round(tier.face_limit * densityScale)),
    texture: true,
    pbr: !!tier.pbr,
  };
}

function safeSecretEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function allowSnapgenDevBypass(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.SNAPGEN_SKIP_PURCHASE_VERIFY === "1";
}

function snapgenRequestHash(input: Record<string, unknown>): string {
  return snapgenSha256(JSON.stringify(input));
}

function providerAssetUrlAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "tripo3d.com" || url.hostname.endsWith(".tripo3d.com"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerSnapgenRoutes(app: Express): void {
  assertSnapgenProductionConfiguration();
  const pool = () => getPool();

  /** Public catalog: categories + tiers (+ remake pricing). */
  app.get("/api/snapgen/catalog", async (_req, res: Response) => {
    try {
      const [tiers] = await pool().query("SELECT code, name, price_cents, face_limit, pbr, rig, texture_res FROM sg_tiers WHERE active = 1 ORDER BY sort_order");
      const [categories] = await pool().query("SELECT code, name FROM sg_categories WHERE active = 1 ORDER BY sort_order");
      res.json({
        tiers: (tiers as any[]).map(t => ({ ...t, remake_price_cents: Math.round(t.price_cents * REMAKE_DISCOUNT) })),
        categories,
        options: { stylePresets: STYLE_PRESETS, surfaceFinishes: SURFACE_FINISHES, poses: POSES, meshDensities: MESH_DENSITIES },
      });
    } catch (err: any) {
      console.error("[GET /api/snapgen/catalog]", err);
      res.status(500).json({ error: "Failed to load catalog." });
    }
  });

  /** RevenueCat webhook — records verified purchases. */
  app.post("/api/snapgen/purchases/webhook", async (req, res: Response) => {
    try {
      const secret = process.env.REVENUECAT_WEBHOOK_SECRET || "";
      if (!secret || !safeSecretEqual(String(req.headers.authorization || ""), secret)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const ev = (req.body && req.body.event) || {};
      if (!["NON_RENEWING_PURCHASE", "INITIAL_PURCHASE"].includes(ev.type)) {
        return res.json({ ok: true, ignored: ev.type || "unknown" });
      }
      const userKey = sanitizeText(ev.app_user_id, 32);
      const productId = sanitizeText(ev.product_id, 128);
      const token = sanitizeText(ev.transaction_id, 512);
      const priceCents = Math.round(Number(ev.price_in_purchased_currency || 0) * 100);
      const currency = sanitizeText(ev.currency, 3).toUpperCase();
      if (!userKey || !productId || !token || !Number.isSafeInteger(priceCents) || priceCents <= 0 || !/^[A-Z]{3}$/.test(currency)) {
        return res.status(400).json({ error: "Missing or invalid purchase evidence" });
      }
      const tokenHash = snapgenSha256(token);
      const [existingRows] = await pool().query(
        `SELECT user_key, product_id, purchase_token, price_cents, currency
           FROM sg_purchases WHERE purchase_token_sha256=? LIMIT 1`,
        [tokenHash],
      ) as any;
      const existing = existingRows?.[0];
      if (existing) {
        if (
          String(existing.user_key) !== userKey
          || String(existing.product_id) !== productId
          || String(existing.purchase_token) !== token
          || Number(existing.price_cents) !== priceCents
          || String(existing.currency) !== currency
        ) return res.status(409).json({ error: "Purchase identity conflicts with existing evidence" });
        return res.json({ ok: true, replay: true });
      }
      await pool().query(
        `INSERT INTO sg_purchases
          (user_key, platform, product_id, purchase_token, purchase_token_sha256, price_cents, currency, raw_json)
         VALUES (?, 'play', ?, ?, ?, ?, ?, ?)`,
        [userKey, productId, token, tokenHash, priceCents, currency, JSON.stringify(ev)],
      );
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[POST /api/snapgen/purchases/webhook]", err);
      res.status(500).json({ error: "Webhook failed." });
    }
  });

  /** Create an order: verify purchase, upload photo, start Tripo job. */
  app.post("/api/snapgen/orders", requireAuth, rejectLegacyExternal3dRoute, async (req: AuthedRequest, res: Response) => {
    let durableOrderId: number | null = null;
    try {
      const userKey = req.user!.phone;
      const { tier, category, photos, options, purchaseToken } = req.body || {};
      const photoList: string[] = Array.isArray(photos) ? photos.filter((p: unknown) => typeof p === "string" && (p as string).length > 0).slice(0, 5) : [];
      if (photoList.length === 0) return res.status(400).json({ error: "At least one photo is required." });
      const opts = normalizeOptions(options);
      const requestHash = snapgenRequestHash({
        owner: userKey,
        tier: String(tier || ""),
        category: String(category || ""),
        photo: snapgenSha256(photoList[0]),
        options: opts,
        isRemake: false,
      });
      const reserved = await reserveSnapgenOrder(pool(), {
        ownerId: userKey,
        tierCode: String(tier || ""),
        categoryCode: String(category || ""),
        purchaseToken: typeof purchaseToken === "string" ? purchaseToken : "",
        requestHash,
        optionsJson: JSON.stringify(opts),
        isRemake: false,
        allowDevBypass: allowSnapgenDevBypass(),
      });
      durableOrderId = reserved.orderId;
      if (reserved.replay) {
        const [rows] = await pool().query(
          `SELECT id, status, progress, source_image_url, model_url, error_code
             FROM sg_orders WHERE id=? AND user_key=? LIMIT 1`,
          [reserved.orderId, userKey],
        ) as any;
        return res.status(200).json(rows[0]);
      }
      const claimed = await claimSnapgenSubmission(pool(), reserved.orderId, userKey);
      if (!claimed) throw new Error("Snapgen order submission was not claimable.");
      const sourceImageUrl = await uploadBase64Image(photoList[0]);
      const job: TripoJobInput = { imageUrl: sourceImageUrl, geometry: tierToGeometry(reserved.tier, opts.meshDensity) };
      const tripoOp = await startImageTo3D(job);
      const persisted = await persistSnapgenProviderHandle(pool(), reserved.orderId, userKey, tripoOp, sourceImageUrl);
      if (!persisted) {
        await quarantineSnapgenOrder(pool(), reserved.orderId, userKey, "HANDLE_PERSIST_CONFLICT");
        return res.status(503).json({ id: reserved.orderId, status: "recovery_required", error: "Provider submission requires reconciliation." });
      }
      res.status(202).json({ id: reserved.orderId, status: "processing", sourceImageUrl });
    } catch (err: any) {
      if (err instanceof SnapgenPurchaseError) {
        const status = err.code === "CATALOG_MISMATCH" || err.code === "ORDER_REPLAY_MISMATCH" ? 400 : 402;
        return res.status(status).json({ error: err.message, code: err.code });
      }
      if (durableOrderId) {
        await quarantineSnapgenOrder(pool(), durableOrderId, req.user!.phone, "SUBMISSION_UNCERTAIN").catch(() => undefined);
      }
      console.error("[POST /api/snapgen/orders]", err?.message || err);
      res.status(503).json({ id: durableOrderId, status: durableOrderId ? "recovery_required" : undefined, error: "Failed to submit the durable order." });
    }
  });

  /** Poll order status; updates DB from Tripo. */
  app.get("/api/snapgen/orders/:id/status", requireAuth, rejectLegacyExternal3dRoute, async (req: AuthedRequest, res: Response) => {
    let activeOrderId: number | null = null;
    let activeLeaseOwner: string | null = null;
    try {
      const userKey = req.user!.phone;
      const orderId = Number(req.params.id);
      if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: "Invalid order." });
      const claim = await claimSnapgenPoll(pool(), orderId, userKey);
      if (!claim) return res.status(404).json({ error: "Order not found." });
      const order = claim.order;
      activeOrderId = orderId;
      activeLeaseOwner = claim.leaseOwner;
      if (!claim.claimed) {
        return res.json({
          id: order.id,
          status: order.status,
          progress: Number(order.progress || 0),
          modelUrl: order.status === "completed" ? order.model_url : null,
          error: order.error,
          errorCode: order.error_code,
        });
      }
      if (!order.tripo_op) {
        await pool().query(
          `UPDATE sg_orders SET status='recovery_required', error_code='MISSING_PROVIDER_HANDLE',
             error='Provider submission requires reconciliation.', poll_lease_owner=NULL, poll_lease_expires_at=NULL
           WHERE id=? AND user_key=? AND poll_lease_owner=?`,
          [order.id, userKey, claim.leaseOwner],
        );
        return res.status(503).json({ id: order.id, status: "recovery_required", error: "Provider submission requires reconciliation." });
      }
      const poll = await pollImageTo3D(order.tripo_op);
      if (poll.done && poll.glbUrl) {
        if (!providerAssetUrlAllowed(poll.glbUrl)) throw new Error("Provider returned an untrusted model URL.");
        const durableUrl = await uploadBinaryFromUrl(poll.glbUrl, "model/gltf-binary", `snapgen/${snapgenSha256(userKey).slice(0, 16)}/${order.id}`);
        const [completed] = await pool().query(
          `UPDATE sg_orders
              SET status='completed', model_url=?, progress=100, provider_completed_at=NOW(3),
                  storage_persisted_at=NOW(3), poll_lease_owner=NULL, poll_lease_expires_at=NULL,
                  error=NULL, error_code=NULL
            WHERE id=? AND user_key=? AND status='processing' AND poll_lease_owner=?`,
          [durableUrl, order.id, userKey, claim.leaseOwner],
        ) as any;
        if (completed?.affectedRows !== 1) {
          return res.status(409).json({ id: order.id, status: "processing", error: "Order state changed during finalization." });
        }
        return res.json({ id: order.id, status: "completed", progress: 100, modelUrl: durableUrl });
      }
      if (poll.error) {
        await pool().query(
          `UPDATE sg_orders
              SET status='failed', error=?, error_code='PROVIDER_FAILED', progress=100,
                  poll_lease_owner=NULL, poll_lease_expires_at=NULL
            WHERE id=? AND user_key=? AND status='processing' AND poll_lease_owner=?`,
          [String(poll.error).slice(0, 1000), order.id, userKey, claim.leaseOwner],
        );
        return res.json({ id: order.id, status: "failed", error: poll.error });
      }
      const progress = typeof poll.progress === "number" ? poll.progress : order.progress;
      await pool().query(
        `UPDATE sg_orders
            SET progress=?, poll_lease_owner=NULL, poll_lease_expires_at=NULL
          WHERE id=? AND user_key=? AND status='processing' AND poll_lease_owner=?`,
        [progress, order.id, userKey, claim.leaseOwner],
      );
      res.json({ id: order.id, status: "processing", progress });
    } catch (err: any) {
      if (activeOrderId && activeLeaseOwner) {
        await pool().query(
          `UPDATE sg_orders
              SET poll_lease_owner=NULL, poll_lease_expires_at=NULL, error_code='FINALIZATION_RETRY'
            WHERE id=? AND user_key=? AND status='processing' AND poll_lease_owner=?`,
          [activeOrderId, req.user!.phone, activeLeaseOwner],
        ).catch(() => undefined);
      }
      console.error(`[GET /api/snapgen/orders/:id/status] failed for order ${activeOrderId || "unknown"}`);
      res.status(503).json({ error: "Status check failed; the durable order can be retried." });
    }
  });

  /** List the user's orders/models (newest first). */
  app.get("/api/snapgen/models", requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const [rows] = await pool().query(
        `SELECT id, tier_code, category_code, status, progress, source_image_url, model_url, price_cents, is_remake, error, created_at
         FROM sg_orders WHERE user_key = ? ORDER BY id DESC LIMIT 100`,
        [req.user!.phone]
      );
      res.json({ models: rows });
    } catch (err: any) {
      console.error("[GET /api/snapgen/models]", err);
      res.status(500).json({ error: "Failed to load models." });
    }
  });

  /** Remake an owned model at 50% off (separate half-price SKU). */
  app.post("/api/snapgen/orders/:id/remake", requireAuth, rejectLegacyExternal3dRoute, async (req: AuthedRequest, res: Response) => {
    let durableOrderId: number | null = null;
    try {
      const userKey = req.user!.phone;
      const [rows] = await pool().query("SELECT * FROM sg_orders WHERE id = ? AND user_key = ?", [Number(req.params.id), userKey]);
      const original = (rows as any[])[0];
      if (!original) return res.status(404).json({ error: "Original order not found." });
      if (original.status !== "completed") return res.status(400).json({ error: "Only completed models can be remade." });

      const [tierRows] = await pool().query("SELECT * FROM sg_tiers WHERE code = ?", [original.tier_code]);
      const tierRow = (tierRows as TierRow[])[0];
      if (!tierRow) return res.status(500).json({ error: "Tier no longer exists." });

      const opts = normalizeOptions(req.body?.options);
      const requestHash = snapgenRequestHash({
        owner: userKey,
        tier: tierRow.code,
        category: original.category_code,
        sourceOrder: Number(original.id),
        sourceImage: snapgenSha256(String(original.source_image_url)),
        options: opts,
        isRemake: true,
      });
      const reserved = await reserveSnapgenOrder(pool(), {
        ownerId: userKey,
        tierCode: tierRow.code,
        categoryCode: String(original.category_code),
        purchaseToken: typeof req.body?.purchaseToken === "string" ? req.body.purchaseToken : "",
        requestHash,
        optionsJson: JSON.stringify(opts),
        isRemake: true,
        originalOrderId: Number(original.id),
        allowDevBypass: allowSnapgenDevBypass(),
      });
      durableOrderId = reserved.orderId;
      if (reserved.replay) {
        const [replayedRows] = await pool().query(
          `SELECT id, status, progress, model_url, error_code FROM sg_orders WHERE id=? AND user_key=? LIMIT 1`,
          [reserved.orderId, userKey],
        ) as any;
        return res.status(200).json(replayedRows[0]);
      }
      if (!(await claimSnapgenSubmission(pool(), reserved.orderId, userKey))) {
        throw new Error("Snapgen remake submission was not claimable.");
      }
      const job: TripoJobInput = { imageUrl: original.source_image_url, geometry: tierToGeometry(tierRow, opts.meshDensity) };
      const tripoOp = await startImageTo3D(job);
      const persisted = await persistSnapgenProviderHandle(pool(), reserved.orderId, userKey, tripoOp, original.source_image_url);
      if (!persisted) {
        await quarantineSnapgenOrder(pool(), reserved.orderId, userKey, "HANDLE_PERSIST_CONFLICT");
        return res.status(503).json({ id: reserved.orderId, status: "recovery_required", error: "Provider submission requires reconciliation." });
      }
      res.status(202).json({ id: reserved.orderId, status: "processing" });
    } catch (err: any) {
      if (err instanceof SnapgenPurchaseError) {
        const status = err.code === "CATALOG_MISMATCH" || err.code === "ORDER_REPLAY_MISMATCH" ? 400 : 402;
        return res.status(status).json({ error: err.message, code: err.code });
      }
      if (durableOrderId) {
        await quarantineSnapgenOrder(pool(), durableOrderId, req.user!.phone, "SUBMISSION_UNCERTAIN").catch(() => undefined);
      }
      console.error("[POST /api/snapgen/orders/:id/remake]", err?.message || err);
      res.status(503).json({ id: durableOrderId, status: durableOrderId ? "recovery_required" : undefined, error: "Failed to submit the durable remake." });
    }
  });

  /** Order a photobook from an order's pre-model source image. */
  app.post("/api/snapgen/photobooks", requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const userKey = req.user!.phone;
      const { orderId, kind } = req.body || {};
      const [rows] = await pool().query("SELECT id, source_image_url FROM sg_orders WHERE id = ? AND user_key = ?", [Number(orderId), userKey]);
      const order = (rows as any[])[0];
      if (!order || !order.source_image_url) return res.status(404).json({ error: "Order (with source image) not found." });

      const bookKind = kind === "physical" ? "physical" : "digital";
      return res.status(503).json({
        error: bookKind === "physical"
          ? "Physical photobook checkout is not yet connected to verified payment."
          : "Digital photobook purchase is temporarily unavailable while durable purchase verification is enabled.",
        code: "PHOTOBOOK_CHECKOUT_UNAVAILABLE",
      });
    } catch (err: any) {
      console.error("[POST /api/snapgen/photobooks]", err);
      res.status(500).json({ error: "Failed to create photobook order." });
    }
  });
}
