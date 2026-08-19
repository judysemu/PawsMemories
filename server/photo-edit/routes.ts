// ─── Photo edit: background removal ─────────────────────────────────────────
// Removes the background from a customer photo, returning WebP-with-alpha.
//
// Fails OPEN by design: on any provider error the original image is returned
// with removed:false and a reason. A matting outage must degrade the photo,
// never block an order. The customer can also always decline the cutout.
import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import type mysql from "mysql2/promise";
import { requireAuth, type AuthedRequest } from "../../auth";
import { putPrivateObject, getPrivateSignedUrl } from "../../storage.private";
import { BackgroundRemovalError, type BackgroundRemovalProvider } from "./provider";

/** Matches the finalize route's ceiling so a photo accepted here cannot be
 *  rejected later in the pipeline. */
const MAX_INPUT_BYTES = 15 * 1024 * 1024;
const DATA_URL = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/;

export function isPhotoEditEnabled(): boolean {
  return process.env.PHOTO_EDIT_ENABLED === "true";
}

export function createPhotoEditRouter(
  getPool: () => mysql.Pool,
  provider: BackgroundRemovalProvider,
): Router {
  const router = Router();

  router.use((_req: Request, res: Response, next: () => void) => {
    if (!isPhotoEditEnabled()) {
      return res.status(503).json({ error: "Photo editing is not available yet.", code: "FEATURE_DISABLED" });
    }
    next();
  });

  router.post("/remove-background", requireAuth, async (req: Request, res: Response) => {
    const userPhone = (req as AuthedRequest).user!.phone;
    const dataUrl = String(req.body?.imageDataUrl || "");
    const match = DATA_URL.exec(dataUrl);
    if (!match) {
      return res.status(400).json({ error: "Send a PNG, JPEG or WebP image." });
    }
    const [, mimeType, base64] = match;
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length || bytes.length > MAX_INPUT_BYTES) {
      return res.status(400).json({ error: "That image is too large. Please use one under 15 MB." });
    }

    // Keyed on the ORIGINAL bytes, so a retry of the same photo never pays for
    // matting twice. Provider is part of the key: swapping models re-mattes
    // rather than serving a cutout from a model we no longer run.
    const sourceSha = crypto.createHash("sha256").update(bytes).digest("hex");
    const pool = getPool();

    try {
      const [cached]: any = await pool.query(
        `SELECT object_key, mime_type, width_px, height_px FROM photo_edit_cache
          WHERE source_sha256 = ? AND provider = ? LIMIT 1`,
        [sourceSha, provider.id],
      );
      if (cached.length) {
        const url = await getPrivateSignedUrl(cached[0].object_key);
        return res.json({
          removed: true, cached: true, url,
          mimeType: cached[0].mime_type,
          widthPx: cached[0].width_px, heightPx: cached[0].height_px,
        });
      }
    } catch (err: any) {
      // A cache miss must never be fatal — fall through and matte.
      console.error("[photo-edit] cache read failed:", err?.message || err);
    }

    // Matting and storage are separated deliberately. Once the provider returns,
    // the compute-seconds are already billed, so a failure after this point is a
    // different event with a different remedy — and collapsing both into
    // PROVIDER_FAILED made a live outage undiagnosable: the message blamed the
    // provider while the provider had in fact succeeded and been paid.
    let cutout;
    try {
      cutout = await provider.removeBackground({ base64, mimeType });
    } catch (err: any) {
      const code = err instanceof BackgroundRemovalError ? err.code : "PROVIDER_FAILED";
      console.error("[photo-edit/remove-background] provider", code, err?.message || err);
      return res.json({
        removed: false,
        code,
        reason: "We couldn't separate the background on this photo. Your original is unchanged.",
      });
    }

    try {
      const cutoutBytes = Buffer.from(cutout.base64, "base64");

      // Cutouts are derived customer content, not storefront assets, so they go
      // to the PRIVATE bucket — unlike finished PawPrint art, which is public.
      const objectKey = `photo-edit/${userPhone}/${sourceSha}.webp`;
      await putPrivateObject(objectKey, cutoutBytes, cutout.mimeType);

      await pool.query(
        `INSERT INTO photo_edit_cache
           (source_sha256, provider, object_key, mime_type, width_px, height_px)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE object_key = VALUES(object_key)`,
        [sourceSha, provider.id, objectKey, cutout.mimeType, cutout.widthPx, cutout.heightPx],
      ).catch((err: any) => {
        // Losing the cache row costs a future provider call, nothing more.
        console.error("[photo-edit] cache write failed:", err?.message || err);
      });

      const url = await getPrivateSignedUrl(objectKey);
      return res.json({
        removed: true, cached: false, url,
        mimeType: cutout.mimeType, widthPx: cutout.widthPx, heightPx: cutout.heightPx,
      });
    } catch (err: any) {
      // FAIL OPEN, but say what actually broke. The matte succeeded and was
      // billed; the cutout simply could not be stored or signed. The usual cause
      // is a Backblaze application key scoped to a single bucket, which reaches
      // the public bucket and is refused by the private one — so the message
      // names storage rather than implying the model failed.
      console.error(
        "[photo-edit/remove-background] storage STORAGE_FAILED",
        `objectKey=photo-edit/${userPhone}/${sourceSha}.webp`,
        err?.message || err,
      );
      return res.json({
        removed: false,
        code: "STORAGE_FAILED",
        reason: "The cutout was created but could not be saved. Your original is unchanged.",
      });
    }
  });

  return router;
}
