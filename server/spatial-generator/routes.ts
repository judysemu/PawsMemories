import { Router, type Request, type Response } from "express";
import type mysql from "mysql2/promise";
import rateLimit from "express-rate-limit";
import { getPool, isUserAdmin } from "../../db";
import type { AuthedRequest } from "../../auth";
import { assertInhouseSpatialGeneratorEnabled } from "./featureFlag";
import {
  CreateSpatialJobSchema,
  QuoteSpatialJobSchema,
  RetrySpatialJobSchema,
  ReviewSpatialJobSchema,
  CancelSpatialJobSchema,
  type CreateSpatialJobInput,
  type QuoteSpatialJobInput,
  type RetrySpatialJobInput,
  type ReviewSpatialJobInput,
  type CancelSpatialJobInput,
} from "./schemas";
import { SpatialGeneratorService, SpatialGeneratorServiceError } from "./service";
import { DeterministicMathSolver } from "./service";

function getRequestUserPhone(req: Request): string | null {
  return (req as AuthedRequest).user?.phone || null;
}

export function createSpatialGeneratorRouter(
  options: {
    pool?: mysql.Pool;
    isAdmin?: (userId: string) => Promise<boolean>;
    service?: SpatialGeneratorService;
  } = {},
): Router {
  const router = Router();
  const pool = options.pool || getPool();
  const checkAdmin = options.isAdmin || isUserAdmin;
  const service = options.service || new SpatialGeneratorService({ pool });

  // Admin-only for initial release
  const adminGuard = async (req: Request, res: Response, next: Function) => {
    const userPhone = getRequestUserPhone(req);
    if (!userPhone) return res.status(401).json({ error: "Unauthorized" });
    const isAdmin = await checkAdmin(userPhone);
    if (!isAdmin) return res.status(403).json({ error: "Admin only" });
    next();
  };

  // Feature flag guard
  const featureGuard = (_req: Request, res: Response, next: Function) => {
    try {
      assertInhouseSpatialGeneratorEnabled();
      next();
    } catch (e) {
      if (e instanceof Error && e.name === "SpatialGeneratorFeatureError") {
        return res.status(403).json({ error: "In-house spatial generator is disabled" });
      }
      return res.status(500).json({ error: "Feature check failed" });
    }
  };

  // Apply admin and feature guards to all routes
  router.use(adminGuard);
  router.use(featureGuard);

  // ─── Rate Limiting ─────────────────────────────────────────────────────────
  const jobCreateLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    message: { error: "Too many job creation requests" },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const pollLimiter = rateLimit({
    windowMs: 10_000,
    max: 30,
    message: { error: "Too many poll requests" },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // ─── POST /api/spatial-generator/jobs ──────────────────────────────────────
  router.post("/jobs", jobCreateLimiter, async (req: Request, res: Response) => {
    const userPhone = getRequestUserPhone(req);
    if (!userPhone) return res.status(401).json({ error: "Unauthorized" });

    const parsed = CreateSpatialJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    try {
      const job = await service.startJob(userPhone, parsed.data);
      return res.status(202).json(job);
    } catch (error) {
      if (error instanceof SpatialGeneratorServiceError) {
        return res.status(400).json({ error: error.code, message: error.message });
      }
      console.error("Spatial job creation failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── GET /api/spatial-generator/jobs/quote ────────────────────────────────
  router.get("/jobs/quote", async (req: Request, res: Response) => {
    const userPhone = getRequestUserPhone(req);
    if (!userPhone) return res.status(401).json({ error: "Unauthorized" });

    const parsed = QuoteSpatialJobSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    }

    try {
      const quote = await service.getQuote(userPhone, parsed.data);
      return res.json(quote);
    } catch (error) {
      if (error instanceof SpatialGeneratorServiceError) {
        return res.status(400).json({ error: error.code, message: error.message });
      }
      console.error("Spatial quote failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── GET /api/spatial-generator/jobs ───────────────────────────────────────
  router.get("/jobs", async (req: Request, res: Response) => {
    const userPhone = getRequestUserPhone(req);
    if (!userPhone) return res.status(401).json({ error: "Unauthorized" });

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    try {
      const jobs = await service.listJobs(userPhone, limit, offset);
      return res.json(jobs);
    } catch (error) {
      console.error("List spatial jobs failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── GET /api/spatial-generator/jobs/:jobUuid ──────────────────────────────
  router.get("/jobs/:jobUuid", pollLimiter, async (req: Request, res: Response) => {
    const userPhone = getRequestUserPhone(req);
    if (!userPhone) return res.status(401).json({ error: "Unauthorized" });

    const { jobUuid } = req.params;

    try {
      const job = await service.getJobDetail(userPhone, jobUuid);
      return res.json(job);
    } catch (error) {
      if (error instanceof SpatialGeneratorServiceError) {
        return res.status(404).json({ error: error.code, message: error.message });
      }
      console.error("Get spatial job failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── POST /api/spatial-generator/jobs/:jobUuid/review ──────────────────────
  router.post("/jobs/:jobUuid/review", async (req: Request, res: Response) => {
    const userPhone = getRequestUserPhone(req);
    if (!userPhone) return res.status(401).json({ error: "Unauthorized" });

    const { jobUuid } = req.params;
    const parsed = ReviewSpatialJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    try {
      const job = await service.reviewJob(userPhone, jobUuid, parsed.data);
      return res.json(job);
    } catch (error) {
      if (error instanceof SpatialGeneratorServiceError) {
        const status = error.code === "CONFLICT" ? 409 : 400;
        return res.status(status).json({ error: error.code, message: error.message });
      }
      console.error("Spatial job review failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── POST /api/spatial-generator/jobs/:jobUuid/retry ───────────────────────
  router.post("/jobs/:jobUuid/retry", async (req: Request, res: Response) => {
    const userPhone = getRequestUserPhone(req);
    if (!userPhone) return res.status(401).json({ error: "Unauthorized" });

    const { jobUuid } = req.params;
    const parsed = RetrySpatialJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    try {
      const job = await service.retryJob(userPhone, jobUuid, parsed.data);
      return res.status(202).json(job);
    } catch (error) {
      if (error instanceof SpatialGeneratorServiceError) {
        return res.status(400).json({ error: error.code, message: error.message });
      }
      console.error("Spatial job retry failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── POST /api/spatial-generator/jobs/:jobUuid/cancel ──────────────────────
  router.post("/jobs/:jobUuid/cancel", async (req: Request, res: Response) => {
    const userPhone = getRequestUserPhone(req);
    if (!userPhone) return res.status(401).json({ error: "Unauthorized" });

    const { jobUuid } = req.params;
    const parsed = CancelSpatialJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    try {
      const job = await service.cancelJob(userPhone, jobUuid, parsed.data.reason);
      return res.json(job);
    } catch (error) {
      if (error instanceof SpatialGeneratorServiceError) {
        return res.status(400).json({ error: error.code, message: error.message });
      }
      console.error("Spatial job cancel failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── GET /api/spatial-generator/health ─────────────────────────────────────
  router.get("/health", async (_req: Request, res: Response) => {
    const userPhone = getRequestUserPhone(_req);
    if (!userPhone) return res.status(401).json({ error: "Unauthorized" });

    const isAdmin = await checkAdmin(userPhone);
    if (!isAdmin) return res.status(403).json({ error: "Admin only" });

    try {
      const health = await service.getHealthStatus();
      return res.json(health);
    } catch (error) {
      console.error("Spatial generator health check failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

const productionService = new SpatialGeneratorService();
export const spatialGeneratorRouter = createSpatialGeneratorRouter({ service: productionService });