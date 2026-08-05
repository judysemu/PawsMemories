import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type mysql from "mysql2/promise";
import { getPool, isUserAdmin } from "../../db";
import type { AuthedRequest } from "../../auth";
import { assertModelBuildV3Enabled } from "./featureFlag";
import {
  StartBuildSchema,
  QuoteBuildSchema,
  RetryBuildSchema,
  AcceptBuildSchema,
  CancelBuildSchema,
} from "./schemas";
import { ModelBuildService, ModelBuildServiceError } from "./service";
import type { ModelBuildProvider } from "./provider";
import { createConfiguredModelBuildProvider } from "./configuredProvider";

function getRequestUserPhone(req: Request): string | null {
  return (req as AuthedRequest).user?.phone || null;
}

export function createModelBuildsRouter(
  options: {
    provider: ModelBuildProvider;
    pool?: mysql.Pool;
    isAdmin?: (userId: string) => Promise<boolean>;
    service?: ModelBuildService;
  },
): Router {
  const router = Router();
  const service = options.service || new ModelBuildService(options.provider, () => options.pool || getPool());
  const checkAdmin = options.isAdmin || isUserAdmin;

  const buildLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Too many model build requests. Try again shortly.", code: "RATE_LIMITED" },
  });

  // Feature flag check on all router routes
  router.use((_req, res, next) => {
    try {
      assertModelBuildV3Enabled();
      next();
    } catch (err: any) {
      return res.status(403).json({
        success: false,
        error: err.message,
        code: "FEATURE_DISABLED",
      });
    }
  });

  /**
   * POST /api/model-builds/quote
   * Get a preflight quote for a build from an approved reference session.
   */
  router.post("/quote", buildLimiter, async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });

      const parsed = QuoteBuildSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: "Invalid request", details: parsed.error.issues });
      }

      const quote = await service.getQuote(userPhone, parsed.data.referenceSessionUuid);
      return res.json({ success: true, data: quote });
    } catch (err: any) {
      return handleError(res, err);
    }
  });

  /**
   * POST /api/model-builds/start
   * Start a new 3D model build with an idempotency key.
   */
  router.post("/start", buildLimiter, async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });

      const parsed = StartBuildSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: "Invalid request", details: parsed.error.issues });
      }

      const job = await service.startBuild(userPhone, parsed.data);
      return res.status(201).json({ success: true, data: job });
    } catch (err: any) {
      return handleError(res, err);
    }
  });

  /**
   * GET /api/model-builds/:jobUuid
   * Get job status and details including signed URLs for artifacts.
   */
  router.get("/:jobUuid", async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });

      const jobUuid = req.params.jobUuid;
      if (!jobUuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobUuid)) {
        return res.status(400).json({ success: false, error: "Invalid job UUID" });
      }

      const detail = await service.getJobDetail(userPhone, jobUuid);
      return res.json({ success: true, data: detail });
    } catch (err: any) {
      return handleError(res, err);
    }
  });

  /**
   * GET /api/model-builds
   * List the caller's build jobs.
   */
  router.get("/", async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });

      const jobs = await service.listJobs(userPhone);
      return res.json({ success: true, data: jobs });
    } catch (err: any) {
      return handleError(res, err);
    }
  });

  /**
   * POST /api/model-builds/:jobUuid/retry
   * Bounded correction retry after failed validation.
   */
  router.post("/:jobUuid/retry", buildLimiter, async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });

      const jobUuid = req.params.jobUuid;
      if (!jobUuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobUuid)) {
        return res.status(400).json({ success: false, error: "Invalid job UUID" });
      }

      const parsed = RetryBuildSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: "Invalid request", details: parsed.error.issues });
      }

      const job = await service.retryBuild(userPhone, jobUuid, parsed.data);
      return res.json({ success: true, data: job });
    } catch (err: any) {
      return handleError(res, err);
    }
  });

  /**
   * POST /api/model-builds/:jobUuid/cancel
   * Cancel a build before provider submission.
   */
  router.post("/:jobUuid/cancel", async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });

      const jobUuid = req.params.jobUuid;
      if (!jobUuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobUuid)) {
        return res.status(400).json({ success: false, error: "Invalid job UUID" });
      }

      const parsed = CancelBuildSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: "Invalid request", details: parsed.error.issues });
      }

      const job = await service.cancelBuild(userPhone, jobUuid);
      return res.json({ success: true, data: job });
    } catch (err: any) {
      return handleError(res, err);
    }
  });

  /**
   * POST /api/model-builds/:jobUuid/accept
   * Explicitly accept a validated artifact and report.
   */
  router.post("/:jobUuid/accept", async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });

      const jobUuid = req.params.jobUuid;
      if (!jobUuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobUuid)) {
        return res.status(400).json({ success: false, error: "Invalid job UUID" });
      }

      const parsed = AcceptBuildSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: "Invalid request", details: parsed.error.issues });
      }

      const job = await service.acceptBuild(userPhone, jobUuid, parsed.data);
      return res.json({ success: true, data: job });
    } catch (err: any) {
      return handleError(res, err);
    }
  });

  /**
   * POST /api/model-builds/admin/reconcile
   * Admin-only stale-job reconciliation.
   */
  router.post("/admin/reconcile", async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });

      const isAdmin = await checkAdmin(userPhone);
      if (!isAdmin) return res.status(403).json({ success: false, error: "Admin access required" });

      const report = await service.recoverStaleBuilds();
      return res.json({ success: true, data: report });
    } catch (err: any) {
      return handleError(res, err);
    }
  });

  return router;
}

const productionProvider = createConfiguredModelBuildProvider();
export const modelBuildService = new ModelBuildService(productionProvider);
export const modelBuildsRouter = createModelBuildsRouter({ provider: productionProvider, service: modelBuildService });


function handleError(res: Response, err: any): Response {
  if (err instanceof ModelBuildServiceError) {
    const statusMap: Record<string, number> = {
      NOT_FOUND: 404,
      FORBIDDEN: 403,
      FEATURE_DISABLED: 403,
      INVALID_STATE: 409,
      PREFLIGHT_FAILED: 422,
      INSUFFICIENT_CREDITS: 402,
      HASH_MISMATCH: 409,
      MAX_RETRIES_EXCEEDED: 429,
    };
    const status = statusMap[err.code] || 400;
    return res.status(status).json({
      success: false,
      error: err.message,
      code: err.code,
    });
  }

  // Don't leak internal details
  console.error("[model-builds route error]", err.message);
  return res.status(500).json({
    success: false,
    error: "Internal server error",
    code: "INTERNAL_ERROR",
  });
}
