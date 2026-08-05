/**
 * server/petSimRouter.ts — shared "Pet Simulator" paid-route router.
 *
 * This is the SINGLE source of truth for the three AR paid endpoints
 * (`/api/pets/classify`, `/api/pets/:id/rig`, `/api/ar/semantic-scan`).
 *
 * It is consumed two ways:
 *   1. Production: `server.ts` mounts `createPetSimApp(PROD_DEPS)`, which wraps
 *      this router with its route-specific body parsing and wires real DB + real
 *      Gemini/Tripo/Blender-worker providers.
 *   2. Tests: the contract suite calls `createPetSimApp(FAKE_DEPS)` with
 *      deterministic fakes + call counters and uses the SAME app/router, so the
 *      tests exercise the exact production route registration, auth, ownership,
 *      schema validation, feature flags, caps, and provider-gating logic.
 *
 * No `app.listen()` and no paid provider call happens at import time, so the
 * module is safe to import in `node:test` without binding a port or talking
 * to a real provider. The rig route stays disabled unless
 * `PETSIM_RIG_ENABLED === "true"` (H1/P0 containment).
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth, type AuthedRequest } from "../auth";
import { rejectLegacyExternal3dRoute } from "./externalGenerativePolicy";
import rateLimit from "express-rate-limit";
import {
  isEndpointEnabled,
  paidUsageLimitsFor,
  type PaidEndpoint,
  type PaidUsageLimits,
  type PaidUsageReservation,
} from "./paidApiGuards";
import { SemanticScanRequestSchema } from "../src/schemas/ar";
import { ClassifyRequestSchema, RigRequestSchema } from "../src/schemas/pets";
import { resolveBreedProfile } from "./breedProfiles";
import { weightsFromTemperament, DEFAULT_DRIVES, DEFAULT_HORMONES } from "../src/brain";
import { checkBudget, needsRetargetFallback, type BakeStats } from "./rigBudget";
import { SKELETON_CONTRACTS } from "../skeletonContract";
import { createHash } from "crypto";
import type { ClassifyResult } from "./petClassify";
import type { Zones } from "./semanticScan";
import {
  ImageInputValidationError,
  validateImageDataUrl,
} from "../src/security/image-input";

// ---------------------------------------------------------------------------
// Injected dependency contract
// ---------------------------------------------------------------------------

/** Injected DB surface (subset used by these routes). */
export interface PetSimDb {
  getAvatarById: (id: number, owner: string) => Promise<any>;
  getPetProfileByAvatar: (id: number, owner: string) => Promise<any>;
  upsertPetProfile: (id: number, owner: string, data: any) => Promise<any>;
  getPetProfileById: (id: number, owner: string) => Promise<any>;
  reservePaidUsage: (
    owner: string,
    ep: PaidEndpoint,
    limits: PaidUsageLimits,
  ) => Promise<PaidUsageReservation>;
  getSemanticScan: (owner: string, key: string) => Promise<any>;
  saveSemanticScan: (owner: string, key: string, zones: any) => Promise<void>;
  getAvatarByIdForRig: (id: number, owner: string) => Promise<any>;
  savePetRigUrls: (id: number, owner: string, urls: any) => Promise<void>;
  setAvatarGenerationFailed?: (id: number, err: string) => Promise<void>;
}

/** Injected provider surface (real in prod, fakes in tests). */
export interface PetSimProviders {
  classify: (input: { imageBase64: string; mimeType: string }) => Promise<ClassifyResult>;
  semanticScan: (input: { imageBase64: string; mimeType: string }) => Promise<Zones>;
  // Rig pipeline (only invoked when PETSIM_RIG_ENABLED === "true").
  // Typed loosely: the real Tripo adapter returns a handle-ish value; the
  // router only needs `.glbUrl` from the polled result.
  startRig: (genTaskId: string, opts: { avatarType?: "dog" | "human" | "object" }) => Promise<string>;
  pollTripoUntilDone: (handle: any, tries?: number, delayMs?: number) => Promise<{ glbUrl?: string; error?: string }>;
  uploadBinaryFromUrl: (url: string, mime: string) => Promise<string>;
  uploadBase64Binary: (b64: string, mime: string) => Promise<string>;
  bakeLod: (opts: { glbUrl: string; avatarType?: string }, headers: Record<string, string>) => Promise<{ glb_base64?: string; stats?: BakeStats; error?: string }>;
}

export interface PetSimDeps {
  db: PetSimDb;
  providers: PetSimProviders;
  // Optional override of the rate limiter (defaults to a per-IP/key limiter).
  paidLimiter?: (req: Request, res: Response, next: NextFunction) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function parseImageInput(
  input: unknown,
  res: Response,
): Promise<{ imageBase64: string; mimeType: string } | null> {
  try {
    const validated = await validateImageDataUrl(input);
    return {
      imageBase64: validated.data.toString("base64"),
      mimeType: validated.mimeType,
    };
  } catch (error) {
    if (error instanceof ImageInputValidationError) {
      res.status(error.status).json({ error: error.message, validation: [error.code] });
      return null;
    }
    throw error;
  }
}

/**
 * Shared kill-switch + atomic user/aggregate budget gate. If the endpoint is
 * disabled, respond 503 and return false (no DB reservation, no provider call).
 * Otherwise reserve user count, global count, and estimated cost together.
 * CRITICAL: when this returns false the caller MUST `return` without calling
 * the provider — that is what keeps usage increments and provider calls at zero
 * for rejected requests (H2/H7).
 */
async function guardPaidCall(
  ep: PaidEndpoint,
  req: AuthedRequest,
  res: Response,
  db: PetSimDb,
): Promise<boolean> {
  if (!isEndpointEnabled(ep)) {
    res.status(503).json({ error: "This feature is temporarily unavailable. Please try again later.", endpoint: ep });
    return false;
  }
  const limits = paidUsageLimitsFor(ep);
  const reservation = await db.reservePaidUsage(req.user!.phone, ep, limits);
  if (!reservation.allowed) {
    const aggregate = reservation.reason !== "user_cap";
    res.status(aggregate ? 503 : 429).json({
      error: aggregate
        ? "This feature has reached its daily service budget. Please try again tomorrow."
        : `Daily limit reached (${limits.userDailyCap}/day for ${ep}). Please try again tomorrow.`,
      endpoint: ep,
      reason: reservation.reason,
      cap: aggregate ? undefined : limits.userDailyCap,
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createPetSimRouter(deps: PetSimDeps): Router {
  const router = Router();
  const { db, providers } = deps;

  const paidLimiter = deps.paidLimiter ?? rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    // Fail closed: if the limiter itself errors, let the request through to
    // the (stricter) per-user daily cap rather than 500ing the caller.
    handler: (_req, res) => res.status(429).json({ error: "Too many requests. Please slow down." }),
  });

  // POST /api/pets/classify — one vision-LLM call → breed/build/temperament,
  // resolved to a breed profile and persisted onto the avatar's pet profile.
  router.post("/api/pets/classify", requireAuth, paidLimiter, async (req: AuthedRequest, res: Response) => {
    try {
      // P2 schema validation BEFORE any paid work. `imageUrl` is rejected by
      // the schema (`.never()`), so SSRF-via-URL input is impossible.
      const parsed = ClassifyRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid classify request.",
          validation: parsed.error.issues.map((i) => i.message),
        });
      }
      const { avatarId: aId, imageBase64, force } = parsed.data;
      const image = await parseImageInput(imageBase64, res);
      if (!image) return;

      // Ownership check up-front (before any paid LLM call).
      const owned = await db.getAvatarById(aId, req.user!.phone);
      if (!owned) return res.status(404).json({ error: "Avatar not found." });

      // Cache: never re-classify the same avatar unless force=true (H7).
      if (!force) {
        const existing = await db.getPetProfileByAvatar(aId, req.user!.phone);
        if (existing && existing.breed) {
          return res.json({ profile: existing, cached: true });
        }
      }

      // H2/H7: kill-switch + per-user daily cap (only paid, non-cached calls count).
      if (!(await guardPaidCall("classify", req, res, db))) return;

      const result = await providers.classify(image);
      const breedProfile = resolveBreedProfile(result.breed, result.size_class);
      const t = (result.temperament || {}) as Record<string, number>;
      const temperament = {
        energy: Number(t.energy) || 0.5,
        sociability: Number(t.sociability) || 0.5,
        stubbornness: Number(t.stubbornness) || 0.5,
        foodMotivation: Number(t.foodMotivation) || 0.5,
        vocality: Number(t.vocality) || 0.5,
      };
      const weights = weightsFromTemperament(temperament);
      const saved = await db.upsertPetProfile(aId, req.user!.phone, {
        breed: result.breed,
        breed_confidence: result.breed_confidence,
        size_class: result.size_class,
        build: result.build,
        temperament: result.temperament,
        personality_weights: weights,
        hormones: { ...DEFAULT_HORMONES },
        drives: { ...DEFAULT_DRIVES },
      });

      res.json({ profile: saved, classification: result, breedProfile, cached: false });
    } catch (err: any) {
      console.error("[pets/classify] failed:", err?.message || err);
      res.status(502).json({ error: "Classification failed." });
    }
  });

  // POST /api/pets/:id/rig — auto-rig a pet's avatar (DISABLED by default).
  router.post("/api/pets/:id/rig", requireAuth, rejectLegacyExternal3dRoute, paidLimiter, async (req: AuthedRequest, res: Response) => {
    // P0 containment: rig stays disabled unless explicitly enabled.
    if (process.env.PETSIM_RIG_ENABLED !== "true") {
      return res.status(501).json({ error: "Rig pipeline disabled.", featureFlag: "PETSIM_RIG_ENABLED", enabled: false });
    }
    try {
      const parsed = RigRequestSchema.safeParse({
        id: req.params.id,
        ...(req.body || {}),
      });
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid rig request.",
          validation: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const { id: petId } = parsed.data;
      const pet = await db.getPetProfileById(petId, req.user!.phone);
      if (!pet) return res.status(404).json({ error: "Pet not found." });

      const avatar = await db.getAvatarByIdForRig(pet.avatar_id, req.user!.phone);
      if (!avatar) return res.status(404).json({ error: "Avatar not found." });
      const genTaskId = avatar.meshy_handle || "";
      if (!genTaskId) {
        return res.status(400).json({ error: "No source model task is available for this pet." });
      }

      // H2/H7: master kill-switch + per-user daily cap before any paid Tripo work.
      if (!(await guardPaidCall("rig", req, res, db))) return;

      const rigHandle = await providers.startRig(genTaskId, { avatarType: avatar?.avatar_type || "dog" });
      const rig = await providers.pollTripoUntilDone(rigHandle, 60, 5000);
      if (!rig.glbUrl) {
        return res.status(502).json({ error: "Rig provider did not produce a model." });
      }

      const bakeRes = await providers.bakeLod(
        { glbUrl: rig.glbUrl, avatarType: avatar?.avatar_type },
        { "Content-Type": "application/json", "x-worker-secret": process.env.WORKER_SHARED_SECRET || "" },
      );
      if (!bakeRes.glb_base64 || bakeRes.error) {
        return res.status(502).json({ error: "Rig validation worker failed." });
      }
      const stats: BakeStats = bakeRes.stats || {
        tris: 0, bones: 0, bytes: 0, retarget_confidence: 0, leg_chains_ok: false,
      };
      const budget = checkBudget(stats);
      if (!budget.ok) {
        return res.status(422).json({ error: "Rig output exceeded the production asset budget." });
      }
      const threshold = avatar?.avatar_type === "human" ? 0.85 : 0.7;
      let retargetFallbackRecommended = needsRetargetFallback(stats, threshold);
      const bodyType = avatar?.avatar_type === "human" ? "biped" : "quadruped";
      const contract = SKELETON_CONTRACTS[bodyType];
      const missingContractBones = (stats.missing_bones || []).filter((b: string) => contract.allBones.includes(b));
      if (missingContractBones.length > 0) retargetFallbackRecommended = true;

      if (retargetFallbackRecommended) {
        if (avatar?.avatar_type === "human") {
          await db.setAvatarGenerationFailed?.(avatar.id, "humanoid retarget below confidence");
          return res.status(422).json({ error: "humanoid retarget below confidence" });
        }
      }

      // Persist only after every acceptance gate that can reject the output.
      const riggedGlbUrl = await providers.uploadBinaryFromUrl(rig.glbUrl, "model/gltf-binary");
      const lodGlbUrl = await providers.uploadBase64Binary(bakeRes.glb_base64, "model/gltf-binary");
      await db.savePetRigUrls(petId, req.user!.phone, {
        rigged_glb_url: riggedGlbUrl,
        lod_glb_url: lodGlbUrl,
      });

      res.json({ success: true, riggedGlbUrl, lodGlbUrl, stats, budget, retargetFallbackRecommended });
    } catch (err: any) {
      console.error("[pets/rig] failed:", err?.message || err);
      res.status(502).json({ error: "Rig pipeline failed." });
    }
  });

  // POST /api/ar/semantic-scan — one camera frame → vision LLM → zone polygons.
  router.post("/api/ar/semantic-scan", requireAuth, paidLimiter, async (req: AuthedRequest, res: Response) => {
    try {
      const parsed = SemanticScanRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid semantic-scan request.",
          validation: parsed.error.issues.map((i) => i.message),
        });
      }
      const { imageBase64, anchorHash, force } = parsed.data;
      const image = await parseImageInput(imageBase64, res);
      if (!image) return;

      // Anchor key: client-provided anchor id, else a content hash of the frame.
      const key: string =
        (typeof anchorHash === "string" && anchorHash) ||
        createHash("sha256").update(image.imageBase64).digest("hex").slice(0, 64);

      if (!force) {
        const cached = await db.getSemanticScan(req.user!.phone, key);
        if (cached) return res.json({ anchorHash: key, zones: cached.zones ?? cached, cached: true });
      }

      // H2/H7: kill-switch + per-user daily cap (only paid, non-cached scans count).
      if (!(await guardPaidCall("semantic_scan", req, res, db))) return;

      const result = await providers.semanticScan(image);
      await db.saveSemanticScan(req.user!.phone, key, result);
      res.json({ anchorHash: key, zones: result.zones, cached: false });
    } catch (err: any) {
      console.error("[ar/semantic-scan] failed:", err?.message || err);
      res.status(502).json({ error: "Semantic scan failed." });
    }
  });

  return router;
}
