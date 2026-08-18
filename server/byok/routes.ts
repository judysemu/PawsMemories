// ─── Phase 4: BYOK image playground ─────────────────────────────────────────
// A standalone playground: prompt in, image out, on the customer's OWN Google
// AI Studio key. Deliberately NOT a mode layered onto PawPrints — no theme
// catalog, no personalization templates, no Shopify, no print path, and no
// PupCoin billing, because their key pays Google and there is nothing for us
// to meter.
//
// This is where the teaching content lands: a customer who wants to go further
// than the guided product comes here and burns their own quota.
import { Router, type Request, type Response } from "express";
import type mysql from "mysql2/promise";
import { requireAuth, type AuthedRequest } from "../../auth";
import { KeyVaultError, looksLikeGoogleApiKey } from "./keyVault";
import { saveUserApiKey, getUserKeyStatus, useUserApiKey, deleteUserApiKey } from "./repository";

const PROVIDER = "google";
const MAX_PROMPT_LENGTH = 600;

export function isByokPlaygroundEnabled(): boolean {
  return process.env.BYOK_PLAYGROUND_ENABLED === "true";
}

/** Generates using a caller-supplied key. Injected so the route never reaches
 *  for the house credentials — the whole point is that it cannot. */
export interface ByokImageGenerator {
  (apiKey: string, prompt: string, aspectRatio: "1:1" | "4:5"): Promise<string | null>;
}

/** Confirms a key works before storing it, so a typo fails at connect time
 *  rather than on the customer's first generation. */
export type ByokKeyValidator = (apiKey: string) => Promise<boolean>;

export function createByokRouter(
  getPool: () => mysql.Pool,
  deps: { generateImage: ByokImageGenerator; validateKey: ByokKeyValidator },
): Router {
  const router = Router();

  router.use((_req: Request, res: Response, next: () => void) => {
    if (!isByokPlaygroundEnabled()) {
      return res.status(503).json({ error: "The playground is not available yet.", code: "FEATURE_DISABLED" });
    }
    next();
  });

  /** Whether a key is connected. Returns last-4 only — never the key. */
  router.get("/key", requireAuth, async (req: Request, res: Response) => {
    try {
      const status = await getUserKeyStatus(getPool(), (req as AuthedRequest).user!.phone, PROVIDER);
      return res.json(status);
    } catch (err: any) {
      console.error("[byok/key]", err?.message || err);
      return res.status(500).json({ error: "Could not check your key." });
    }
  });

  router.post("/key", requireAuth, async (req: Request, res: Response) => {
    const userPhone = (req as AuthedRequest).user!.phone;
    const apiKey = String(req.body?.apiKey || "").trim();
    if (!looksLikeGoogleApiKey(apiKey)) {
      return res.status(400).json({ error: "That doesn't look like a Google AI Studio key. Copy the whole key and try again." });
    }
    try {
      // One cheap provider call. Rejecting here means the customer learns the
      // key is wrong while they still have the AI Studio tab open.
      if (!(await deps.validateKey(apiKey))) {
        return res.status(400).json({ error: "Google rejected that key. Check it was copied in full and is enabled for the Gemini API.", code: "KEY_REJECTED" });
      }
      const { last4 } = await saveUserApiKey(getPool(), userPhone, PROVIDER, apiKey);
      return res.status(201).json({ success: true, connected: true, last4 });
    } catch (err: any) {
      if (err instanceof KeyVaultError) {
        // A misconfigured server secret is an operator problem; do not imply
        // the customer's key was at fault.
        console.error("[byok/key] vault:", err.code, err.message);
        return res.status(503).json({ error: "Key storage is not configured. Please try again later.", code: err.code });
      }
      console.error("[byok/key]", err?.message || err);
      return res.status(500).json({ error: "Could not save your key." });
    }
  });

  router.delete("/key", requireAuth, async (req: Request, res: Response) => {
    try {
      const removed = await deleteUserApiKey(getPool(), (req as AuthedRequest).user!.phone, PROVIDER);
      return res.json({ success: true, removed });
    } catch (err: any) {
      console.error("[byok/key delete]", err?.message || err);
      return res.status(500).json({ error: "Could not disconnect your key." });
    }
  });

  router.post("/generate", requireAuth, async (req: Request, res: Response) => {
    const userPhone = (req as AuthedRequest).user!.phone;
    const prompt = String(req.body?.prompt || "").trim().slice(0, MAX_PROMPT_LENGTH);
    const aspectRatio = String(req.body?.aspectRatio || "1:1");
    if (!prompt) return res.status(400).json({ error: "Describe the image you'd like." });
    if (!["1:1", "4:5"].includes(aspectRatio)) {
      return res.status(400).json({ error: "Choose a supported image shape." });
    }

    try {
      const apiKey = await useUserApiKey(getPool(), userPhone, PROVIDER);
      // No fallback to the house key. Falling back would silently bill us for
      // what the customer believes their own key is paying for.
      if (!apiKey) {
        return res.status(403).json({ error: "Connect your Google AI Studio key to use the playground.", code: "NO_KEY_CONNECTED" });
      }
      const image = await deps.generateImage(apiKey, prompt, aspectRatio as "1:1" | "4:5");
      if (!image) throw new Error("Generation returned no image.");
      return res.status(201).json({ success: true, image });
    } catch (err: any) {
      if (err instanceof KeyVaultError) {
        console.error("[byok/generate] vault:", err.code);
        return res.status(503).json({ error: "Key storage is unavailable right now.", code: err.code });
      }
      // Provider errors are surfaced as a quota/permission hint rather than a
      // raw message, which can echo the key back in some SDK error strings.
      console.error("[byok/generate]", err?.message || err);
      return res.status(502).json({
        error: "Google refused that request. Check your key's quota and that the Gemini API is enabled.",
        code: "PROVIDER_ERROR",
      });
    }
  });

  return router;
}
