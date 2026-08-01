// ─── Phase 5: Fur Bin HTTP Router ───────────────────────────────────────────
import { Router, type Request, type Response } from "express";
import type mysql from "mysql2/promise";
import { requireAuth, type AuthedRequest } from "../../auth";
import { isUserAdmin } from "../../db";
import { assertFurBinV5Enabled } from "./featureFlag";
import { FurBinService, FurBinError } from "./service";
import {
  SearchFurBinRequestSchema,
  RegisterFurBinItemRequestSchema,
  SubmitFurBinDefectReportSchema,
  CreateCollectionRequestSchema,
  AddCollectionItemRequestSchema,
  PublishShowcaseRequestSchema,
  ModerationDecisionRequestSchema,
  RollbackVersionRequestSchema,
  ShowcaseBrowseRequestSchema,
  OwnerShowcaseListRequestSchema,
} from "./schemas";

export function createFurBinRouter(
  getPool: () => mysql.Pool,
  options: { isAdmin?: (userId: string) => Promise<boolean> } = {},
): Router {
  const router = Router();
  const service = new FurBinService(getPool);
  const checkAdmin = options.isAdmin || isUserAdmin;
  const ownerId = (req: Request): string => (req as AuthedRequest).user!.phone;

  router.use((req: Request, res: Response, next: () => void) => {
    try {
      assertFurBinV5Enabled();
      next();
    } catch (err: any) {
      res.status(503).json({ error: err.message || "Fur Bin showcase disabled", code: "FEATURE_DISABLED" });
    }
  });

  // Static showcase routes must precede /showcase/:uuid.
  router.get("/showcase/browse", async (req: Request, res: Response) => {
    try {
      const query = ShowcaseBrowseRequestSchema.parse({
        query: singleQueryValue(req.query.query),
        tag: singleQueryValue(req.query.tag),
        category: singleQueryValue(req.query.category),
        page: req.query.page ? Number(singleQueryValue(req.query.page)) : 1,
        limit: req.query.limit ? Number(singleQueryValue(req.query.limit)) : 20,
      });
      res.json(await service.browsePublicShowcases(query));
    } catch (err: any) {
      handleError(res, err);
    }
  });

  router.get("/showcase/owner", requireAuth, async (req: Request, res: Response) => {
    try {
      const query = OwnerShowcaseListRequestSchema.parse({
        page: req.query.page ? Number(singleQueryValue(req.query.page)) : 1,
        limit: req.query.limit ? Number(singleQueryValue(req.query.limit)) : 20,
      });
      res.json(await service.listOwnerShowcases(ownerId(req), query));
    } catch (err: any) {
      handleError(res, err);
    }
  });

  router.get("/showcase/owner/:uuid", requireAuth, async (req: Request, res: Response) => {
    try {
      res.json(await service.getShowcaseForOwner(ownerId(req), req.params.uuid));
    } catch (err: any) {
      handleError(res, err);
    }
  });

  // GET /api/fur-bin/showcase/:uuid — approved, published public derivative only
  router.get("/showcase/:uuid", async (req: Request, res: Response) => {
    try {
      res.json(await service.getShowcasePublic(req.params.uuid));
    } catch (err: any) {
      handleError(res, err);
    }
  });

  router.post("/items", requireAuth, async (req: Request, res: Response) => {
    try {
      const body = RegisterFurBinItemRequestSchema.parse(req.body);
      res.status(201).json(await service.registerItem(ownerId(req), body));
    } catch (err: any) {
      handleError(res, err);
    }
  });

  // GET /api/fur-bin/items — Search private library
  router.get("/items", requireAuth, async (req: Request, res: Response) => {
    try {
      const query = SearchFurBinRequestSchema.parse({
        query: singleQueryValue(req.query.query),
        tag: singleQueryValue(req.query.tag),
        collectionUuid: singleQueryValue(req.query.collectionUuid),
        hasRig: req.query.hasRig === "true" ? true : req.query.hasRig === "false" ? false : undefined,
        hasFacial: req.query.hasFacial === "true" ? true : req.query.hasFacial === "false" ? false : undefined,
        hasAnimations: req.query.hasAnimations === "true" ? true : req.query.hasAnimations === "false" ? false : undefined,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 20,
      });

      const result = await service.searchLibrary(ownerId(req), query);
      res.json(result);
    } catch (err: any) {
      handleError(res, err);
    }
  });

  // GET /api/fur-bin/items/:uuid — Get private item details
  router.get("/items/:uuid", requireAuth, async (req: Request, res: Response) => {
    try {
      const item = await service.getItemPublic(ownerId(req), req.params.uuid);
      res.json(item);
    } catch (err: any) {
      handleError(res, err);
    }
  });

  router.delete("/items/:uuid", requireAuth, async (req: Request, res: Response) => {
    try {
      res.json(await service.deleteItem(ownerId(req), req.params.uuid));
    } catch (err: any) {
      handleError(res, err);
    }
  });

  router.post("/items/:uuid/defect-report", requireAuth, async (req: Request, res: Response) => {
    try {
      const body = SubmitFurBinDefectReportSchema.parse(req.body);
      const result = await service.submitDefectReport(ownerId(req), req.params.uuid, body);
      res.status(result.emailSent ? 201 : 202).json(result);
    } catch (err: any) {
      handleError(res, err);
    }
  });

  // POST /api/fur-bin/items/:uuid/rollback — Rollback current version pointer
  router.post("/items/:uuid/rollback", requireAuth, async (req: Request, res: Response) => {
    try {
      const body = RollbackVersionRequestSchema.parse(req.body);
      const updated = await service.rollbackVersion(ownerId(req), req.params.uuid, body.versionNumber);
      res.json(updated);
    } catch (err: any) {
      handleError(res, err);
    }
  });

  router.post("/items/:uuid/archive", requireAuth, async (req: Request, res: Response) => {
    try {
      res.json(await service.archiveItem(ownerId(req), req.params.uuid));
    } catch (err: any) {
      handleError(res, err);
    }
  });

  // POST /api/fur-bin/showcase — Publish showcase record
  router.post("/showcase", requireAuth, async (req: Request, res: Response) => {
    try {
      const body = PublishShowcaseRequestSchema.parse(req.body);
      const showcase = await service.publishShowcase(ownerId(req), body);
      res.status(201).json(showcase);
    } catch (err: any) {
      handleError(res, err);
    }
  });

  // POST /api/fur-bin/showcase/:uuid/unpublish — Unpublish showcase record
  router.post("/showcase/:uuid/unpublish", requireAuth, async (req: Request, res: Response) => {
    try {
      await service.unpublishShowcase(ownerId(req), req.params.uuid);
      res.json({ success: true, message: "Showcase record unpublished" });
    } catch (err: any) {
      handleError(res, err);
    }
  });

  // POST /api/fur-bin/showcase/:uuid/moderate — Admin moderation decision
  router.post("/showcase/:uuid/moderate", requireAuth, async (req: Request, res: Response) => {
    try {
      const body = ModerationDecisionRequestSchema.parse(req.body);
      const moderatorId = ownerId(req);
      const moderatorIsAdmin = await checkAdmin(moderatorId);
      const updated = await service.moderateShowcase(
        moderatorId,
        req.params.uuid,
        body.newState,
        body.reason,
        moderatorIsAdmin,
      );
      res.json(updated);
    } catch (err: any) {
      handleError(res, err);
    }
  });

  router.post("/collections", requireAuth, async (req: Request, res: Response) => {
    try {
      const body = CreateCollectionRequestSchema.parse(req.body);
      res.status(201).json(await service.createCollection(ownerId(req), body));
    } catch (err: any) {
      handleError(res, err);
    }
  });

  router.get("/collections", requireAuth, async (req: Request, res: Response) => {
    try {
      res.json(await service.listCollections(ownerId(req)));
    } catch (err: any) {
      handleError(res, err);
    }
  });

  router.post("/collections/:uuid/items", requireAuth, async (req: Request, res: Response) => {
    try {
      const body = AddCollectionItemRequestSchema.parse(req.body);
      await service.addItemToCollection(ownerId(req), req.params.uuid, body.itemUuid);
      res.status(204).end();
    } catch (err: any) {
      handleError(res, err);
    }
  });

  return router;
}

function handleError(res: Response, err: any): void {
  if (err instanceof FurBinError) {
    const statusMap: Record<string, number> = {
      NOT_FOUND: 404,
      FORBIDDEN: 403,
      COMMERCIAL_INELIGIBLE: 422,
      INVALID_VERSION: 400,
      INVALID_ASSET: 422,
      PRIVATE_ASSET: 422,
      INVALID_LINEAGE: 422,
      INVALID_STATE: 409,
      ADMIN_REQUIRED: 403,
      FEEDBACK_FAILED: 500,
      DELETE_FAILED: 500,
    };
    res.status(statusMap[err.code] || 400).json({ error: err.message, code: err.code });
    return;
  }
  if (err.name === "ZodError") {
    res.status(400).json({ error: "Validation error", details: err.errors });
    return;
  }
  console.error("[fur-bin] Router error:", err);
  res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
}

function singleQueryValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
