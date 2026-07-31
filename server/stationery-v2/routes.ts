import { Router, json, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../../auth.ts";
import {
  CompleteRenderJobRequestSchema,
  CreatePrintOrderRequestSchema,
  CreateRenderJobRequestSchema,
  PrintOrderPublicSchema,
  ProviderEventResultSchema,
  ProviderParamSchema,
  ProviderWebhookRequestSchema,
  ReconcileOrderRequestSchema,
  ReconciliationResultSchema,
  RenderJobPublicSchema,
  StationeryUuidParamSchema,
  SubmitPrintOrderRequestSchema,
  TemplateVersionParamSchema,
  TemplateVersionPublicSchema,
  WorkerAssetRegistrationSchema,
} from "./apiContracts.ts";
import type { ProviderWebhookAuthenticatorPort, RenderCallbackAuthenticatorPort } from "./apiPorts.ts";
import { StationeryFeatureDisabledError, assertStationeryV2Enabled } from "./featureFlag.ts";
import { StationeryApiError, StationeryV2Service } from "./service.ts";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export interface StationeryV2RouterDependencies {
  providerWebhookAuthenticator: ProviderWebhookAuthenticatorPort;
  renderCallbackAuthenticator: RenderCallbackAuthenticatorPort;
  workerAssetRegistrar?: (input: z.infer<typeof WorkerAssetRegistrationSchema>) => Promise<{ assetUuid: string; versionNumber: number; sha256: string }>;
}

export function createStationeryV2Router(
  service: StationeryV2Service,
  dependencies: StationeryV2RouterDependencies,
): Router {
  const router = Router();

  router.use((_req: Request, res: Response, next: NextFunction) => {
    try {
      assertStationeryV2Enabled();
      next();
    } catch (error) {
      handleStationeryError(res, error);
    }
  });

  router.use(json({
    limit: "1mb",
    verify(req: RawBodyRequest, _res, buffer) {
      req.rawBody = Buffer.from(buffer);
    },
  }));

  router.get("/templates/:templateUuid/versions/:versionNumber", requireAuth, async (req: Request, res: Response) => {
    try {
      const params = TemplateVersionParamSchema.parse(req.params);
      res.json(TemplateVersionPublicSchema.parse(await service.getTemplateVersion(params.templateUuid, params.versionNumber)));
    } catch (error) {
      handleStationeryError(res, error);
    }
  });

  router.post("/render-jobs", requireAuth, async (req: Request, res: Response) => {
    try {
      const body = CreateRenderJobRequestSchema.parse(req.body);
      res.status(202).json(RenderJobPublicSchema.parse(await service.createRenderJob(ownerId(req), body)));
    } catch (error) {
      handleStationeryError(res, error);
    }
  });

  router.get("/render-jobs/:uuid", requireAuth, async (req: Request, res: Response) => {
    try {
      const params = StationeryUuidParamSchema.parse(req.params);
      res.json(RenderJobPublicSchema.parse(await service.getRenderJob(ownerId(req), params.uuid)));
    } catch (error) {
      handleStationeryError(res, error);
    }
  });

  router.post("/render-jobs/:uuid/complete", async (req: RawBodyRequest, res: Response) => {
    try {
      await requireTrustedCallback(req, dependencies.renderCallbackAuthenticator);
      const params = StationeryUuidParamSchema.parse(req.params);
      const body = CompleteRenderJobRequestSchema.parse(req.body);
      res.json(RenderJobPublicSchema.parse(await service.completeRenderJob(params.uuid, body)));
    } catch (error) {
      handleStationeryError(res, error);
    }
  });

  router.post("/print-orders", requireAuth, async (req: Request, res: Response) => {
    try {
      const body = CreatePrintOrderRequestSchema.parse(req.body);
      res.status(201).json(PrintOrderPublicSchema.parse(await service.createPrintOrder(ownerId(req), body)));
    } catch (error) {
      handleStationeryError(res, error);
    }
  });

  router.get("/print-orders/:uuid", requireAuth, async (req: Request, res: Response) => {
    try {
      const params = StationeryUuidParamSchema.parse(req.params);
      res.json(PrintOrderPublicSchema.parse(await service.getPrintOrder(ownerId(req), params.uuid)));
    } catch (error) {
      handleStationeryError(res, error);
    }
  });

  router.post("/print-orders/:uuid/submit", requireAuth, async (req: Request, res: Response) => {
    try {
      const params = StationeryUuidParamSchema.parse(req.params);
      const body = SubmitPrintOrderRequestSchema.parse(req.body);
      res.json(PrintOrderPublicSchema.parse(await service.submitPrintOrder(ownerId(req), params.uuid, body)));
    } catch (error) {
      handleStationeryError(res, error);
    }
  });

  router.post("/print-orders/:uuid/reconcile", requireAuth, async (req: Request, res: Response) => {
    try {
      const params = StationeryUuidParamSchema.parse(req.params);
      const body = ReconcileOrderRequestSchema.parse(req.body);
      res.json(ReconciliationResultSchema.parse(await service.reconcilePrintOrder(ownerId(req), params.uuid, body.reason)));
    } catch (error) {
      handleStationeryError(res, error);
    }
  });

  router.post("/provider-events/:provider", async (req: RawBodyRequest, res: Response) => {
    try {
      const params = ProviderParamSchema.parse(req.params);
      const rawBody = requireRawBody(req);
      const authenticated = await dependencies.providerWebhookAuthenticator.authenticate({
        provider: params.provider,
        headers: req.headers,
        rawBody,
      });
      if (!authenticated) throw new StationeryApiError("Provider webhook authentication failed.", "WEBHOOK_UNAUTHORIZED", 401);
      const body = ProviderWebhookRequestSchema.parse(req.body);
      res.json(ProviderEventResultSchema.parse(await service.applyAuthenticatedProviderEvent(params.provider, body)));
    } catch (error) {
      handleStationeryError(res, error);
    }
  });

  router.post("/worker-assets/register", async (req: RawBodyRequest, res: Response) => {
    try {
      if (!dependencies.workerAssetRegistrar) throw new StationeryApiError("Stationery worker asset registration is not configured.", "WORKER_UNAVAILABLE", 503);
      await requireTrustedCallback(req, dependencies.renderCallbackAuthenticator);
      const body = WorkerAssetRegistrationSchema.parse(req.body);
      res.status(201).json(await dependencies.workerAssetRegistrar(body));
    } catch (error) {
      handleStationeryError(res, error);
    }
  });

  return router;
}

async function requireTrustedCallback(req: RawBodyRequest, authenticator: RenderCallbackAuthenticatorPort): Promise<void> {
  const authenticated = await authenticator.authenticate({ headers: req.headers, rawBody: requireRawBody(req) });
  if (!authenticated) throw new StationeryApiError("Render callback authentication failed.", "CALLBACK_UNAUTHORIZED", 401);
}

function requireRawBody(req: RawBodyRequest): Buffer {
  if (!Buffer.isBuffer(req.rawBody) || req.rawBody.byteLength === 0) {
    throw new StationeryApiError("Verified raw request bytes are required.", "RAW_BODY_REQUIRED", 401);
  }
  return req.rawBody;
}

function ownerId(req: Request): string {
  const owner = (req as AuthedRequest).user?.phone;
  if (!owner) throw new StationeryApiError("Authentication context is missing.", "UNAUTHORIZED", 401);
  return owner;
}

export function handleStationeryError(res: Response, error: unknown): void {
  if (error instanceof StationeryFeatureDisabledError) {
    res.status(503).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof StationeryApiError) {
    res.status(error.httpStatus).json({ error: error.message, code: error.code });
    return;
  }
  if (error && typeof error === "object" && "name" in error && error.name === "ZodError") {
    const issues = "issues" in error ? error.issues : undefined;
    res.status(400).json({ error: "Validation error", code: "INVALID_REQUEST", issues });
    return;
  }
  console.error("[stationery-v2] Request failed", error);
  res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
}
