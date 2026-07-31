import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type mysql from "mysql2/promise";
import type { AuthedRequest } from "../../auth";
import { PetGlbService, type PetGlbServiceDeps } from "./service";
import { PetGenerationError } from "./provider";
import { assertPetGlbEnabled, PetGlbFeatureError } from "./featureFlag";
import {
  canonicalHash,
  CreatePetGlbOrderSchema,
  FACIAL_RIG_POLICY,
  meshProfilePolicy,
  ReferenceManifestSchema,
  rigGenerationAvailability,
  StageApprovalSchema,
  StageKindSchema,
  StageRejectionSchema,
  StageRetrySchema,
} from "./contracts";
import { PET_GLB_STAGE_PRICES } from "../../src/pricing";

function phoneOf(req: Request): string | null {
  return (req as AuthedRequest).user?.phone || null;
}

function fail(res: Response, err: unknown) {
  if (err instanceof PetGlbFeatureError) {
    return res.status(403).json({ error: "FEATURE_DISABLED", message: err.message });
  }
  if (err instanceof PetGenerationError) {
    const status =
      err.code === "ORDER_NOT_FOUND" || err.code === "JOB_NOT_FOUND" ? 404 :
      err.code === "FORBIDDEN" || err.code === "NOT_OPERATOR" || err.code === "OPERATOR_ROLE_UNCONFIGURED" ? 403 :
      err.code === "INSUFFICIENT_CREDITS" ? 402 :
      err.code === "ILLEGAL_TRANSITION" || err.code === "CONCURRENT_TRANSITION" ||
      err.code === "ALREADY_DELIVERED" || err.code === "APPROVAL_REJECTED" ||
      err.code === "STALE_STAGE" || err.code === "IDEMPOTENCY_CONFLICT" ||
      err.code === "STAGE_NOT_APPROVABLE" ? 409 :
      400;
    return res.status(status).json({ error: err.code, message: err.message });
  }
  console.error("[pet-generation] unhandled:", err);
  return res.status(500).json({ error: "INTERNAL_ERROR" });
}

export function createPetGenerationRouter(deps: PetGlbServiceDeps): Router {
  const router = Router();
  const service = new PetGlbService(deps);

  const writeLimiter = rateLimit({
    windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: { error: "RATE_LIMITED" },
  });
  const pollLimiter = rateLimit({
    windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
    message: { error: "RATE_LIMITED" },
  });

  // Flag check on every route in this router.
  router.use((_req, res, next) => {
    try { assertPetGlbEnabled(); next(); } catch (err) { fail(res, err); }
  });

  // ── Product / quote ───────────────────────────────────────────────────────
  router.get("/product", (_req, res) => {
    const rigGeneration = rigGenerationAvailability();
    res.json({
      sku: "CUSTOM_RIGGED_PET_GLB_V1",
      name: "Custom 3D Model",
      deliverables: ["customer-approved GLB", "measured mesh report", "secure private download"],
      operatorApprovalRequired: true,
      prices: {
        base: PET_GLB_STAGE_PRICES.BASE,
        texture: PET_GLB_STAGE_PRICES.TEXTURE,
        rig: PET_GLB_STAGE_PRICES.RIG,
        currency: "PupCoins",
      },
      meshProfiles: {
        hd: meshProfilePolicy("hd"),
        smart_mesh: meshProfilePolicy("smart_mesh"),
      },
      subjectProfiles: [
        { id: "pet", label: "Pet / animal", rigType: "quadruped" },
        { id: "humanoid", label: "Humanoid character", rigType: "biped" },
      ],
      facialRig: FACIAL_RIG_POLICY,
      rigGeneration,
      styleDirection: {
        stage: "texture",
        maxCharacters: 400,
        presets: ["reference-faithful", "soft-stylized", "toy-collectible", "studio-realistic"],
      },
      referenceRequirements: {
        requiredSourceUploads: 4,
        optionalSourceAngles: [],
        generatedForApproval: ["front", "left", "right", "rear", "three_quarter"],
        guidance: [
          "Four clear, full-body photos are required: front, left, rear, and right angles.",
          "Pawsome3D generates the complete multi-angle set before model building.",
          "Approve the generated views or request an immediate remake.",
          "Avoid filters and motion blur.",
          "Include clear views of distinctive markings.",
          "Measurements improve scale confidence.",
          "Hidden anatomy and exact dimensions cannot be reliably inferred from photographs alone.",
          "Every model is reviewed by an operator before delivery.",
        ],
      },
    });
  });

  // ── Order lifecycle ───────────────────────────────────────────────────────
  router.post("/orders", writeLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    const parsed = CreatePetGlbOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "INVALID_CONFIGURATION",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }
    try {
      if (parsed.data.includeRig && !rigGenerationAvailability().available) {
        return res.status(503).json({
          error: "RIG_GENERATION_DISABLED",
          message: rigGenerationAvailability().reason,
        });
      }
      res.json(await service.createConfiguredOrder(phone, {
        meshProfile: parsed.data.meshProfile,
        subjectProfile: parsed.data.subjectProfile,
        includeTexture: parsed.data.includeTexture,
        includeRig: parsed.data.includeRig,
        textureQuality: parsed.data.textureQuality,
        styleDirection: parsed.data.styleDirection || null,
      }));
    } catch (err) { fail(res, err); }
  });

  router.get("/orders", pollLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      res.json(await service.listOrderViews(phone, Number(req.query.limit || 20)));
    } catch (err) { fail(res, err); }
  });

  // Credits-only payment: charge the reserved credits and advance the order.
  // No Stripe session — this SKU is paid from the wallet the credit-purchase
  // flow already funds.
  router.post("/orders/:orderUuid/pay", writeLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      res.json(await service.payWithCredits(req.params.orderUuid, phone));
    } catch (err) { fail(res, err); }
  });

  router.get("/orders/:orderUuid", pollLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      res.json(await service.getOrderView(req.params.orderUuid, phone));
    } catch (err) { fail(res, err); }
  });

  router.post("/orders/:orderUuid/references", writeLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    const parsed = ReferenceManifestSchema.safeParse(req.body?.references);
    if (!parsed.success) {
      return res.status(400).json({
        error: "INCOMPLETE_REFERENCES",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }
    try {
      res.json(await service.submitReferenceManifest(req.params.orderUuid, phone, parsed.data));
    } catch (err) { fail(res, err); }
  });

  // The former /generate endpoint crossed every customer gate. Keep a stable,
  // non-mutating error for stale clients instead of silently starting work.
  router.post("/orders/:orderUuid/generate", writeLimiter, async (req, res) => {
    if (!phoneOf(req)) return res.status(401).json({ error: "UNAUTHORIZED" });
    res.status(409).json({
      error: "GATED_FLOW_REQUIRED",
      message: "Save and approve references before starting the base model.",
    });
  });

  router.post("/orders/:orderUuid/stages/:stage/approve", writeLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    const stage = StageKindSchema.safeParse(req.params.stage);
    const parsed = StageApprovalSchema.safeParse(req.body);
    if (!stage.success || !parsed.success) {
      return res.status(400).json({ error: "INVALID_STAGE_APPROVAL" });
    }
    try {
      const view = await service.getOrderView(req.params.orderUuid, phone);
      if (view.currentStage?.stage !== stage.data) {
        return res.status(409).json({ error: "STALE_STAGE" });
      }
      res.json(await service.approveCustomerStage(req.params.orderUuid, phone, {
        idempotencyKey: parsed.data.idempotencyKey,
        attemptUuid: parsed.data.attemptUuid,
        artifactSha256: parsed.data.artifactSha256,
        assetVersionId: parsed.data.assetVersionId ?? null,
        reportSha256: parsed.data.reportSha256 ?? null,
        approvalHash: canonicalHash({ orderUuid: req.params.orderUuid, stage: stage.data, ...parsed.data }),
      }));
    } catch (err) { fail(res, err); }
  });

  router.post("/orders/:orderUuid/stages/:stage/reject", writeLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    const stage = StageKindSchema.safeParse(req.params.stage);
    const parsed = StageRejectionSchema.safeParse(req.body);
    if (!stage.success || !parsed.success) {
      return res.status(400).json({ error: "INVALID_STAGE_REJECTION" });
    }
    try {
      const view = await service.getOrderView(req.params.orderUuid, phone);
      if (view.currentStage?.stage !== stage.data) {
        return res.status(409).json({ error: "STALE_STAGE" });
      }
      res.json(await service.rejectCustomerStage(req.params.orderUuid, phone, parsed.data));
    } catch (err) { fail(res, err); }
  });

  router.post("/orders/:orderUuid/stages/:stage/retry", writeLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    const stage = StageKindSchema.safeParse(req.params.stage);
    const parsed = StageRetrySchema.safeParse(req.body);
    if (!stage.success || !parsed.success || stage.data === "reference") {
      return res.status(400).json({ error: "INVALID_STAGE_RETRY" });
    }
    try {
      const view = await service.getOrderView(req.params.orderUuid, phone);
      if (view.currentStage?.stage !== stage.data) {
        return res.status(409).json({ error: "STALE_STAGE" });
      }
      res.json(await service.retryCustomerStage(req.params.orderUuid, phone, parsed.data));
    } catch (err) { fail(res, err); }
  });

  router.post("/orders/:orderUuid/stages/:stage/poll", pollLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    const stage = StageKindSchema.safeParse(req.params.stage);
    if (!stage.success || stage.data === "reference") {
      return res.status(400).json({ error: "INVALID_POLL_STAGE" });
    }
    try {
      res.json(await service.pollCustomerStage(req.params.orderUuid, phone, stage.data));
    } catch (err) { fail(res, err); }
  });

  router.get("/orders/:orderUuid/stages/current/preview", pollLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      res.json(await service.previewCurrentStage(req.params.orderUuid, phone));
    } catch (err) { fail(res, err); }
  });

  // Legacy poll route is read-compatible but can no longer advance the
  // automatic pipeline.
  router.post("/orders/:orderUuid/poll", pollLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      const view = await service.getOrderView(req.params.orderUuid, phone);
      if (!view.currentStage || view.currentStage.stage === "reference") {
        return res.json(view);
      }
      res.json(await service.pollCustomerStage(req.params.orderUuid, phone, view.currentStage.stage));
    } catch (err) { fail(res, err); }
  });

  // ── Customer delivery ─────────────────────────────────────────────────────
  router.post("/orders/:orderUuid/download", writeLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      res.json(await service.deliver(req.params.orderUuid, phone));
    } catch (err) { fail(res, err); }
  });

  // ── Operator surfaces — role-gated, separate from customer review ─────────
  router.get("/operator/queue", async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      res.json(await service.operatorQueue(phone));
    } catch (err) { fail(res, err); }
  });

  router.get("/operator/orders/:orderUuid/recovery-evidence", pollLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      if (!deps.isOperator || !(await deps.isOperator(phone))) return res.status(403).json({ error: "NOT_OPERATOR" });
      const order = await service.repository.findByUuid(req.params.orderUuid);
      if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
      res.json(await service.stageRepository.listRecoveryEvidence(order.id));
    } catch (err) { fail(res, err); }
  });

  router.get("/operator/orders/:orderUuid/preview", pollLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      res.json(await service.operatorPreview(req.params.orderUuid, phone));
    } catch (err) { fail(res, err); }
  });

  router.post("/operator/orders/:orderUuid/approve", writeLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    const versionId = Number(req.body?.versionId);
    if (!Number.isInteger(versionId) || versionId <= 0) {
      return res.status(400).json({ error: "INVALID_VERSION_ID" });
    }
    try {
      res.json(await service.approve(req.params.orderUuid, phone, versionId, req.body?.note));
    } catch (err) { fail(res, err); }
  });

  router.post("/operator/orders/:orderUuid/repair", writeLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    const reason = String(req.body?.reasonCode || "").trim();
    if (!reason) return res.status(400).json({ error: "REASON_REQUIRED" });
    try {
      res.json(await service.requestRepair(req.params.orderUuid, phone, reason));
    } catch (err) { fail(res, err); }
  });

  router.get("/health", (_req, res) => res.json({ ok: true, module: "pet-generation" }));

  return router;
}

/**
 * Webhook handler — mounted OUTSIDE the auth router; Stripe is not a user.
 *
 * The body arrives as raw bytes (express.raw) because signature verification
 * must run over the exact payload Stripe signed — any JSON re-serialisation
 * invalidates it. Only a signature-verified event may mark an order paid.
 */
export function createPetGlbWebhookHandler(deps: PetGlbServiceDeps) {
  const service = new PetGlbService(deps);
  const secret = process.env.PET_GLB_STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || "";
  const apiKey = process.env.STRIPE_SECRET_KEY || "";

  return async (req: Request, res: Response) => {
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) {
      console.error("[pet-glb] webhook body is not raw bytes — check express.raw() mount order");
      return res.status(400).json({ error: "RAW_BODY_REQUIRED" });
    }

    let event: any;
    if (secret && apiKey) {
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string" || !signature) {
        return res.status(400).json({ error: "MISSING_SIGNATURE" });
      }
      try {
        const { default: Stripe } = await import("stripe");
        const stripe = new Stripe(apiKey);
        event = stripe.webhooks.constructEvent(raw, signature, secret);
      } catch (err: any) {
        console.error("[pet-glb] webhook signature verification failed:", err.message);
        return res.status(400).json({ error: "INVALID_SIGNATURE" });
      }
    } else {
      // No secret configured => sandbox simulation. Refuse in production so a
      // missing secret can never become an unauthenticated "mark as paid" hole.
      if (process.env.NODE_ENV === "production") {
        return res.status(503).json({ error: "WEBHOOK_SECRET_NOT_CONFIGURED" });
      }
      console.warn("[pet-glb] no webhook secret — accepting UNVERIFIED event (non-production only)");
      try { event = JSON.parse(raw.toString("utf8")); }
      catch { return res.status(400).json({ error: "MALFORMED_EVENT" }); }
    }

    const eventId = String(event?.id || "");
    const eventType = String(event?.type || "");
    const orderUuid = String(event?.data?.object?.metadata?.order_uuid || "");

    if (eventType !== "checkout.session.completed" && eventType !== "payment_intent.succeeded") {
      return res.json({ received: true, ignored: eventType });
    }
    if (!eventId || !orderUuid) return res.status(400).json({ error: "MALFORMED_EVENT" });

    try {
      const result = await service.handlePaymentSucceeded(eventId, eventType, orderUuid);
      res.json({ received: true, duplicate: result === null });
    } catch (err) { fail(res, err); }
  };
}

export type { mysql };
