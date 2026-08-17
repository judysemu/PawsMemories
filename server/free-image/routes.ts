// ─── Phase 1: Free first image ──────────────────────────────────────────────
// One free AI image per account, unlocked by verifying the account email and
// delivered through Fur Bin so it carries the same ownership, versioning, and
// provenance as every other generated asset.
//
// The entitlement is the abuse boundary, so it is spent server-side by a
// conditional UPDATE (db.claimFreeImage) and given back on any failure after
// the claim (db.releaseFreeImage) — a provider hiccup must never silently burn
// the customer's single free image.
import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import type mysql from "mysql2/promise";
import { requireAuth, type AuthedRequest } from "../../auth";
import { claimFreeImage, releaseFreeImage, findUserByPhone } from "../../db";
import { putPrivateObject, sha256Hex } from "../../storage.private";
import { FurBinService } from "../fur-bin/service";
import { isFurBinV5Enabled } from "../fur-bin/featureFlag";

/** Server-side cap; the client field is bounded to match. */
const MAX_PROMPT_LENGTH = 600;
const ASSET_TYPE = "free_generated_image";

export function isFreeFirstImageEnabled(): boolean {
  return process.env.FREE_FIRST_IMAGE_ENABLED === "true";
}

export interface FreeImageGenerator {
  (prompt: string, userPhone: string, aspectRatio: "1:1" | "4:5"): Promise<string | null>;
}

export function createFreeImageRouter(
  getPool: () => mysql.Pool,
  deps: { generateImage: FreeImageGenerator },
): Router {
  const router = Router();
  const furBin = new FurBinService(getPool);

  router.use((_req: Request, res: Response, next: () => void) => {
    if (!isFreeFirstImageEnabled()) {
      return res.status(503).json({ error: "The free image is not available yet.", code: "FEATURE_DISABLED" });
    }
    // Delivery depends on Fur Bin; refuse rather than generate an image with
    // nowhere to put it, which would spend the entitlement for nothing.
    if (!isFurBinV5Enabled()) {
      return res.status(503).json({ error: "Image delivery is temporarily unavailable.", code: "FEATURE_DISABLED" });
    }
    next();
  });

  /** Whether this account can still claim its free image, and why not. */
  router.get("/status", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await findUserByPhone((req as AuthedRequest).user!.phone);
      if (!user) return res.status(404).json({ error: "Account not found." });
      res.json({
        emailVerified: !!user.email_verified,
        claimed: !!user.free_image_claimed,
        eligible: !!user.email_verified && !user.free_image_claimed,
      });
    } catch (err: any) {
      console.error("[free-image/status]", err?.message || err);
      res.status(500).json({ error: "Could not check your free image." });
    }
  });

  router.post("/generate", requireAuth, async (req: Request, res: Response) => {
    const userPhone = (req as AuthedRequest).user!.phone;
    const prompt = String(req.body?.prompt || "").trim().slice(0, MAX_PROMPT_LENGTH);
    const aspectRatio = String(req.body?.aspectRatio || "1:1");
    if (!prompt) return res.status(400).json({ error: "Describe the image you'd like." });
    // The image generator supports these two shapes only.
    if (!["1:1", "4:5"].includes(aspectRatio)) {
      return res.status(400).json({ error: "Choose a supported image shape." });
    }

    // Verification and the entitlement are both re-checked here, in one
    // conditional UPDATE, rather than trusted from the caller's session — which
    // may predate either change. A losing race sees affectedRows 0.
    const claimed = await claimFreeImage(userPhone);
    if (!claimed) {
      const user = await findUserByPhone(userPhone);
      if (!user?.email_verified) {
        return res.status(403).json({ error: "Confirm your email to unlock your free image.", code: "EMAIL_NOT_VERIFIED" });
      }
      return res.status(402).json({ error: "You've already used your free image.", code: "FREE_IMAGE_ALREADY_USED" });
    }

    try {
      const generated = await deps.generateImage(prompt, userPhone, aspectRatio as "1:1" | "4:5");
      if (!generated) throw new Error("Image generation returned no image.");

      const [, mimeType = "image/png", base64 = ""] =
        /^data:([^;]+);base64,(.*)$/s.exec(generated) || [undefined, "image/png", generated];
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.length) throw new Error("Image generation returned an empty image.");

      const sha256 = sha256Hex(bytes);
      // Content-addressed key: regenerating identical bytes cannot collide with
      // another customer's object, and the owner segment keeps listings cheap.
      const objectKey = `free-image/${userPhone}/${sha256}.${mimeType === "image/jpeg" ? "jpg" : "png"}`;
      await putPrivateObject(objectKey, bytes, mimeType);

      const pool = getPool();
      const assetUuid = crypto.randomUUID();
      const [assetResult]: any = await pool.query(
        `INSERT INTO assets (asset_uuid, owner_id, asset_type, visibility, status)
         VALUES (?, ?, ?, 'private', 'active')`,
        [assetUuid, userPhone, ASSET_TYPE],
      );
      const assetId = Number(assetResult.insertId);

      await pool.query(
        `INSERT INTO asset_versions
           (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key,
            metadata, source_provider, license, commercial_use_eligible)
         VALUES (?, 1, ?, ?, ?, 'private', ?, ?, 'gemini', 'proprietary', 0)`,
        [assetId, sha256, mimeType, bytes.length, objectKey, JSON.stringify({ prompt, aspectRatio, free: true })],
      );

      const item = await furBin.registerItem(userPhone, {
        assetUuid,
        versionNumber: 1,
        title: prompt.slice(0, 80) || "My free PawPrint image",
        description: "Your free first image.",
        tags: ["free-image"],
      });

      return res.status(201).json({ success: true, item });
    } catch (err: any) {
      // Anything after the claim failed, so the customer keeps their free image.
      try {
        await releaseFreeImage(userPhone);
      } catch (releaseErr: any) {
        // Worth shouting about: the entitlement is now stuck spent.
        console.error("[free-image] FAILED TO RELEASE entitlement for", userPhone, releaseErr?.message || releaseErr);
      }
      console.error("[free-image/generate]", err?.message || err);
      return res.status(500).json({ error: "We couldn't create your image. Your free image is still available — please try again." });
    }
  });

  return router;
}
