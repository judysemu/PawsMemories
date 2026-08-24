/**
 * Off-platform photo claims.
 *
 * Someone sends a pet photo to the @pawsome3d X account. Rather than generating
 * a model there -- which would mean spending real provider compute for an
 * anonymous sender with no account, no credits, and no way to approve the
 * result -- the photo is parked here and the bot replies with a one-time link.
 *
 * The link lands in the existing studio, where the gates already are: the
 * claim endpoint below is mounted behind requireAuth, the order still reserves
 * PupCoins, and the customer still approves the generated views before any paid
 * stage. All a claim removes is re-uploading a photo we were already sent.
 *
 * Two endpoints with deliberately different trust:
 *   POST /api/x-claims          -- service-to-service, shared-secret bearer
 *   POST /api/x-claims/consume  -- a signed-in person, mounted behind requireAuth
 *
 * The mint endpoint is NOT behind requireAuth (x-dm-service holds no user
 * session), which is exactly why it must stay narrow: it accepts an image and
 * returns a link, and can do nothing else.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type { AuthedRequest } from "../../auth";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { z } from "zod";
import { createPhotoClaim, consumePhotoClaim } from "../../db";
import { uploadBase64Binary } from "../../storage";
import { fetchBoundedRemoteBuffer } from "../safeRemoteFetch";

/** A claim is a funnel step, not a shopping cart. Short enough that a leaked
 *  link is stale before it is useful, long enough to survive making an account. */
const CLAIM_TTL_MS = 72 * 60 * 60 * 1000;

/** X serves photos well under this; the ceiling exists so a hostile or broken
 *  upstream cannot push an arbitrary payload through the mint endpoint. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const ACCEPTED_MIME = ["image/png", "image/jpeg", "image/webp"] as const;

export const MintClaimSchema = z
  .object({
    imageBase64: z.string().min(1).max(20_000_000),
    mimeType: z.enum(ACCEPTED_MIME),
    // The X conversation id. Enough for support to answer "my link never
    // arrived" without this becoming a record of who messaged us.
    sourceRef: z.string().min(1).max(191).nullable().optional(),
    source: z.enum(["x_dm"]).default("x_dm"),
  })
  .strict();

export const ConsumeClaimSchema = z.object({ token: z.string().min(16).max(128) }).strict();

export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time comparison of the service secret. Hashing first keeps the
 * comparison fixed-width, so a wrong-length secret cannot be distinguished from
 * a wrong-value one by timing.
 */
export function matchesClaimServiceSecret(candidate: string): boolean {
  const configured = String(process.env.X_CLAIM_SERVICE_SECRET || "");
  if (!candidate || !configured) return false;
  const actual = createHash("sha256").update(candidate).digest();
  const expected = createHash("sha256").update(configured).digest();
  return timingSafeEqual(actual, expected);
}

/** Fails closed: with no secret configured the mint endpoint accepts nothing. */
export function isClaimMintEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.X_CLAIM_SERVICE_SECRET && env.X_CLAIM_SERVICE_SECRET.trim().length >= 32);
}

function publicBaseUrl(): string {
  return String(process.env.PUBLIC_BASE_URL || "https://pawsome3d.com").replace(/\/+$/, "");
}

/**
 * The only origins a claim may be re-fetched from: our own media bucket, which
 * is the only place the mint endpoint ever writes. An empty list means the
 * bucket is unconfigured, and the bounded fetcher then refuses every URL --
 * which is the correct outcome, not a reason to widen this.
 */
export function claimMediaOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const endpoint = env.MEDIA_BUCKET_URL;
  const bucket = env.MEDIA_BUCKET_NAME;
  if (!endpoint || !bucket) return [];
  const url = new URL(endpoint);
  return [url.origin, `${url.protocol}//${bucket}.${url.host}`];
}

/**
 * Mint router — mounted OUTSIDE requireAuth. Keep it to this one route.
 */
export function createClaimMintRouter(): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    if (!isClaimMintEnabled()) {
      // Indistinguishable from "no such route" on purpose: an unconfigured
      // deployment should not advertise that this surface exists.
      return res.status(404).json({ error: "Not found." });
    }
    const authHeader = String(req.headers.authorization || "");
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!matchesClaimServiceSecret(bearer)) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const parsed = MintClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_CLAIM", issues: parsed.error.issues });
    }

    const raw = parsed.data.imageBase64.startsWith("data:")
      ? parsed.data.imageBase64.split(",")[1] || ""
      : parsed.data.imageBase64;
    // Decoded size, not string length -- base64 inflates by ~4/3 and the
    // meaningful limit is what we will store and later re-fetch.
    const decodedBytes = Math.floor((raw.length * 3) / 4);
    if (decodedBytes > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: "IMAGE_TOO_LARGE" });
    }

    try {
      const imageUrl = await uploadBase64Binary(raw, parsed.data.mimeType, "x-claims");
      const token = randomBytes(32).toString("base64url");
      await createPhotoClaim({
        tokenHash: hashClaimToken(token),
        imageUrl,
        mimeType: parsed.data.mimeType,
        source: parsed.data.source,
        sourceRef: parsed.data.sourceRef ?? null,
        expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
      });
      // The only time the raw token exists outside the sender's DM.
      return res.status(201).json({
        claimUrl: `${publicBaseUrl()}/claim/${token}?utm_source=x&utm_medium=dm&utm_campaign=photo_claim`,
        expiresInHours: Math.round(CLAIM_TTL_MS / 3_600_000),
      });
    } catch (err: any) {
      console.error("[x-claims mint]", err?.message || err);
      return res.status(502).json({ error: "CLAIM_MINT_FAILED" });
    }
  });

  return router;
}

/**
 * Consume router — mounted BEHIND requireAuth. Spending a claim is the moment
 * the photo acquires an owner, so it needs a real one.
 */
export function createClaimConsumeRouter(): Router {
  const router = Router();

  router.post("/consume", async (req: Request, res: Response) => {
    const userPhone = (req as AuthedRequest).user?.phone || null;
    if (!userPhone) return res.status(401).json({ error: "UNAUTHORIZED" });

    const parsed = ConsumeClaimSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_TOKEN" });

    const claim = await consumePhotoClaim(hashClaimToken(parsed.data.token), userPhone);
    // Unknown, expired, and already-spent are one answer on purpose: telling
    // them apart lets someone probe which tokens ever existed.
    if (!claim) return res.status(410).json({ error: "CLAIM_UNAVAILABLE" });

    try {
      const fetched = await fetchBoundedRemoteBuffer(claim.imageUrl, {
        allowedOrigins: claimMediaOrigins(),
        maxBytes: MAX_IMAGE_BYTES,
        timeoutMs: 20_000,
        allowedContentTypes: ACCEPTED_MIME,
      });
      // Handed back as a data URL so the studio can treat it exactly like a
      // photo the customer picked themselves. Deliberately NOT a reference
      // session: the studio creates its own on start, and minting a second one
      // here would leave an orphan behind whenever someone changes their mind.
      return res.status(200).json({
        imageDataUrl: `data:${claim.mimeType};base64,${fetched.buffer.toString("base64")}`,
        source: claim.source,
      });
    } catch (err: any) {
      // The claim is already spent at this point. That is the safe direction to
      // fail: the photo is recoverable by re-sending, a replayable link is not.
      console.error("[x-claims consume]", err?.message || err);
      return res.status(502).json({ error: "CLAIM_FETCH_FAILED" });
    }
  });

  return router;
}
