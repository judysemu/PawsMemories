import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type mysql from "mysql2/promise";
import type { AuthedRequest } from "../../auth";
import { PetGlbService, type PetGlbServiceDeps } from "./service";
import { PetGenerationError } from "./provider";
import { assertPetGlbEnabled, PetGlbFeatureError } from "./featureFlag";

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
      err.code === "ILLEGAL_TRANSITION" || err.code === "CONCURRENT_TRANSITION" ||
      err.code === "ALREADY_DELIVERED" || err.code === "APPROVAL_REJECTED" ? 409 :
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
    res.json({
      sku: "CUSTOM_RIGGED_PET_GLB_V1",
      name: "Custom Rigged Pet 3D Model",
      deliverables: ["one approved GLB pet model", "one validated idle animation", "one validated walk animation"],
      operatorApprovalRequired: true,
      referenceRequirements: {
        required: ["front", "left", "right", "rear", "three_quarter"],
        guidance: [
          "Keep the full pet visible in every photo.",
          "Use consistent lighting across all views.",
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
    try {
      res.json(await service.createOrder(phone));
    } catch (err) { fail(res, err); }
  });

  router.get("/orders/:orderUuid", pollLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      const order = await service.repository.findByUuid(req.params.orderUuid);
      if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
      if (order.ownerPhone !== phone && !(await deps.isAdmin(phone))) {
        return res.status(403).json({ error: "FORBIDDEN" });
      }
      res.json(order);
    } catch (err) { fail(res, err); }
  });

  router.post("/orders/:orderUuid/references", writeLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    const sessionId = Number(req.body?.referenceSessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({ error: "INVALID_REFERENCE_SESSION" });
    }
    try {
      res.json(await service.attachReferences(req.params.orderUuid, phone, sessionId));
    } catch (err) { fail(res, err); }
  });

  router.post("/orders/:orderUuid/generate", writeLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    const r = req.body?.references;
    const required = ["frontUrl", "leftUrl", "rightUrl", "rearUrl", "threeQuarterUrl"];
    if (!r || required.some((k) => typeof r[k] !== "string" || !r[k])) {
      return res.status(400).json({ error: "INCOMPLETE_REFERENCES", required });
    }
    try {
      res.json(await service.startGeneration(req.params.orderUuid, r));
    } catch (err) { fail(res, err); }
  });

  router.post("/orders/:orderUuid/poll", pollLimiter, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      res.json(await service.pollAndValidate(req.params.orderUuid));
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

/** Webhook handler — mounted OUTSIDE the auth router; Stripe is not a user. */
export function createPetGlbWebhookHandler(deps: PetGlbServiceDeps) {
  const service = new PetGlbService(deps);
  return async (req: Request, res: Response) => {
    const eventId = String(req.body?.id || "");
    const eventType = String(req.body?.type || "");
    const orderUuid = String(req.body?.data?.object?.metadata?.order_uuid || "");
    if (!eventId || !orderUuid) return res.status(400).json({ error: "MALFORMED_EVENT" });
    try {
      const result = await service.handlePaymentSucceeded(eventId, eventType, orderUuid);
      res.json({ received: true, duplicate: result === null });
    } catch (err) { fail(res, err); }
  };
}

export type { mysql };
