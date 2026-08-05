import { Router, type Request, type Response } from "express";
import type mysql from "mysql2/promise";
import { getPool, isUserAdmin } from "../../db";
import type { AuthedRequest } from "../../auth";
import {
  CreateSessionSchema,
  StartAttemptSchema,
  RetryAttemptSchema,
  ApproveManifestSchema,
  CancelSessionSchema,
  ReplaceSourcePhotoSchema,
} from "./schemas";
import { ReferenceSessionService, ReferenceSessionError } from "./service";
import { TripoReferenceImageProvider, type ReferenceImageProvider } from "./provider";
import type { ReferenceStorageAdapter } from "./storage";
import { rejectLegacyExternal3dRoute } from "../externalGenerativePolicy";

function getRequestUserPhone(req: Request): string | null {
  return (req as AuthedRequest).user?.phone || null;
}

export function createReferenceSessionsRouter(
  options: {
    provider: ReferenceImageProvider;
    pool?: mysql.Pool;
    isAdmin?: (userId: string) => Promise<boolean>;
    storage?: ReferenceStorageAdapter;
  },
): Router {
  const router = Router();
  const service = new ReferenceSessionService(options.provider, () => options.pool || getPool(), options.storage);
  const checkAdmin = options.isAdmin || isUserAdmin;

  /**
   * POST /api/reference-sessions/create
   */
  router.post("/create", async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });

      const validated = CreateSessionSchema.parse(req.body);
      const session = await service.createSession(userPhone, validated);

      return res.status(201).json({ success: true, sessionUuid: session.session_uuid, state: session.state });
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ success: false, error: "Invalid input schema", details: error.errors });
      }
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post("/replace-source", async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });
      const validated = ReplaceSourcePhotoSchema.parse(req.body);
      const session = await service.replaceSourcePhoto(userPhone, validated.sessionUuid, validated.imageBufferBase64, validated.mimeType);
      return res.json({ success: true, session });
    } catch (error: any) {
      if (error.name === "ZodError") return res.status(400).json({ success: false, error: "Invalid input schema", details: error.errors });
      const statusCode = error instanceof ReferenceSessionError && error.code === "UNAUTHORIZED" ? 403 : 422;
      return res.status(statusCode).json({ success: false, error: error.message, code: error.code });
    }
  });

  /**
   * POST /api/reference-sessions/start
   */
  router.post("/start", rejectLegacyExternal3dRoute, async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });

      const validated = StartAttemptSchema.parse(req.body);
      const { session } = await service.startOrRetryAttempt(
        userPhone,
        validated.sessionUuid,
        validated.idempotencyKey,
      );

      const publicData = await service.getSessionPublic(session.session_uuid, userPhone, false);
      return res.status(201).json({ success: true, session: publicData });
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ success: false, error: "Invalid input schema", details: error.errors });
      }
      const statusCode = error instanceof ReferenceSessionError && error.code === "UNAUTHORIZED"
        ? 403
        : error instanceof ReferenceSessionError && error.code === "GENERATION_FAILED"
          ? 502
          : 422;
      return res.status(statusCode).json({ success: false, error: error.message, code: error.code });
    }
  });

  /**
   * POST /api/reference-sessions/retry
   */
  router.post("/retry", rejectLegacyExternal3dRoute, async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });

      const validated = RetryAttemptSchema.parse(req.body);
      const { session } = await service.startOrRetryAttempt(
        userPhone,
        validated.sessionUuid,
        validated.idempotencyKey,
        validated.retryNotes,
      );

      const publicData = await service.getSessionPublic(session.session_uuid, userPhone, false);
      return res.status(201).json({ success: true, session: publicData });
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ success: false, error: "Invalid input schema", details: error.errors });
      }
      const statusCode = error instanceof ReferenceSessionError && error.code === "UNAUTHORIZED"
        ? 403
        : error instanceof ReferenceSessionError && error.code === "GENERATION_FAILED"
          ? 502
          : 422;
      return res.status(statusCode).json({ success: false, error: error.message, code: error.code });
    }
  });

  /**
   * POST /api/reference-sessions/cancel
   */
  router.post("/cancel", async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });

      const { sessionUuid } = CancelSessionSchema.parse(req.body);
      await service.cancelSession(userPhone, sessionUuid);

      return res.json({ success: true, state: "cancelled" });
    } catch (error: any) {
      const statusCode = error instanceof ReferenceSessionError && error.code === "UNAUTHORIZED" ? 403 : 422;
      return res.status(statusCode).json({ success: false, error: error.message, code: error.code });
    }
  });

  /**
   * POST /api/reference-sessions/approve
   */
  router.post("/approve", async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      if (!userPhone) return res.status(401).json({ success: false, error: "Authentication required" });

      const validated = ApproveManifestSchema.parse(req.body);
      const approvedSession = await service.approveManifest(
        userPhone,
        validated.sessionUuid,
        validated.manifestHash,
      );

      return res.json({ success: true, session: approvedSession });
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ success: false, error: "Invalid input schema", details: error.errors });
      }
      const statusCode = error instanceof ReferenceSessionError && error.code === "UNAUTHORIZED"
        ? 403
        : error instanceof ReferenceSessionError && (error.code === "MANIFEST_HASH_MISMATCH" || error.code === "ALREADY_APPROVED")
          ? 409
          : 422;
      return res.status(statusCode).json({ success: false, error: error.message, code: error.code });
    }
  });

  /**
   * GET /api/reference-sessions/detail/:sessionUuid
   */
  router.get("/detail/:sessionUuid", async (req: Request, res: Response) => {
    try {
      const userPhone = getRequestUserPhone(req);
      const sessionUuid = String(req.params.sessionUuid);
      const userIsAdmin = userPhone ? await checkAdmin(userPhone).catch(() => false) : false;

      const publicData = await service.getSessionPublic(sessionUuid, userPhone || undefined, userIsAdmin);
      return res.json({ success: true, session: publicData });
    } catch (error: any) {
      const statusCode = error instanceof ReferenceSessionError && error.code === "UNAUTHORIZED" ? 403 : 404;
      return res.status(statusCode).json({ success: false, error: error.message });
    }
  });

  return router;
}

export const referenceSessionsRouter = createReferenceSessionsRouter({
  provider: new TripoReferenceImageProvider(),
});
