import crypto from "node:crypto";
import { z } from "zod";
import {
  CompleteRenderJobRequestSchema,
  CreatePrintOrderRequestSchema,
  CreateRenderJobRequestSchema,
  PaymentEvidenceSchema,
  PrintOrderPublicSchema,
  ProviderEventResultSchema,
  ProviderReconciliationObservationSchema,
  ProviderSubmissionAcknowledgementSchema,
  ProviderWebhookRequestSchema,
  ReconcileOrderRequestSchema,
  ReconciliationResultSchema,
  RenderDispatchSchema,
  RenderJobPublicSchema,
  SubmitPrintOrderRequestSchema,
  type CompleteRenderJobRequest,
  type CreatePrintOrderRequest,
  type CreateRenderJobRequest,
  type PrintOrderPublic,
  type ProviderEventResult,
  type ProviderWebhookRequest,
  type ReconciliationResult,
  type RenderJobPublic,
} from "./apiContracts.ts";
import { parseNativeProviderWebhook } from "./nativeWebhooks.ts";
import type {
  FrozenFileAccessPort,
  PaymentEvidenceReaderPort,
  RenderDispatcherPort,
  StationeryApiRepositoryPort,
  StationeryClockPort,
  StationeryProviderMap,
  StationeryTemplateVersionRecord,
} from "./apiPorts.ts";
import { sha256Canonical } from "./canonical.ts";
import {
  AssetVersionRefSchema,
  StationeryValidationReportSchema,
  type StationeryValidationReport,
  type TemplateVersionSpec,
} from "./contracts.ts";
import { assertStationeryV2Enabled } from "./featureFlag.ts";
import {
  applyProviderEvent,
  createProviderSubmission,
  decideProviderReconciliation,
  ProviderEventSchema,
  type ProviderEvent,
} from "./fulfillment.ts";
import { hashTemplateSpec, sealPrintManifest, verifyPrintManifest, verifyRenderManifest } from "./manifests.ts";
import { findTextOverflow, validateTemplateSpec } from "./validation.ts";

export class StationeryApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "StationeryApiError";
  }
}

export interface StationeryV2ServiceDependencies {
  repository: StationeryApiRepositoryPort;
  renderDispatcher: RenderDispatcherPort;
  paymentEvidence: PaymentEvidenceReaderPort;
  frozenFileAccess: FrozenFileAccessPort;
  providers: StationeryProviderMap;
  clock?: StationeryClockPort;
}

const systemClock: StationeryClockPort = { now: () => new Date().toISOString() };

export class StationeryV2Service {
  private readonly repository: StationeryApiRepositoryPort;
  private readonly renderDispatcher: RenderDispatcherPort;
  private readonly paymentEvidence: PaymentEvidenceReaderPort;
  private readonly frozenFileAccess: FrozenFileAccessPort;
  private readonly providers: StationeryProviderMap;
  private readonly clock: StationeryClockPort;

  constructor(dependencies: StationeryV2ServiceDependencies) {
    this.repository = dependencies.repository;
    this.renderDispatcher = dependencies.renderDispatcher;
    this.paymentEvidence = dependencies.paymentEvidence;
    this.frozenFileAccess = dependencies.frozenFileAccess;
    this.providers = dependencies.providers;
    this.clock = dependencies.clock ?? systemClock;
  }

  async getTemplateVersion(templateUuid: string, versionNumber: number): Promise<StationeryTemplateVersionRecord> {
    assertStationeryV2Enabled();
    const template = await this.repository.getTemplateVersion(templateUuid, versionNumber);
    if (!template || template.status !== "active") {
      throw new StationeryApiError("Template version was not found.", "TEMPLATE_NOT_FOUND", 404);
    }
    this.verifyTemplateHash(template);
    return template;
  }

  async createRenderJob(ownerId: string, rawRequest: CreateRenderJobRequest): Promise<RenderJobPublic> {
    assertStationeryV2Enabled();
    const request = CreateRenderJobRequestSchema.parse(rawRequest);
    const requestHash = sha256Canonical(request);
    const existing = await this.repository.getRenderJobByIdempotency(ownerId, request.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new StationeryApiError("The idempotency key is already bound to a different render request.", "IDEMPOTENCY_CONFLICT", 409);
      }
      return RenderJobPublicSchema.strip().parse(existing);
    }
    const template = await this.getTemplateVersion(request.templateUuid, request.templateVersionNumber);
    const validationReport = await this.validateRenderRequest(ownerId, template.spec, request);
    if (!validationReport.overallPass) {
      throw new StationeryApiError("Render request failed stationery validation.", "VALIDATION_FAILED", 422);
    }

    const now = this.now();
    const result = await this.repository.createRenderJobIdempotent({
      jobUuid: crypto.randomUUID(),
      ownerId,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      request,
      template,
      validationReport,
      createdAt: now,
    });
    if (result.job.requestHash !== requestHash) {
      throw new StationeryApiError("The idempotency key is already bound to a different render request.", "IDEMPOTENCY_CONFLICT", 409);
    }
    if (!result.created) return RenderJobPublicSchema.strip().parse(result.job);

    const dispatch = RenderDispatchSchema.parse({
      contractVersion: 1,
      jobUuid: result.job.jobUuid,
      ownerId,
      template: template.spec,
      templateSpecHash: template.specHash,
      presetId: request.presetId,
      requestHash,
      slotInputs: request.slotInputs,
      sourceUrls: await this.resolveRenderSourceUrls(ownerId, template.spec, request),
    });
    try {
      // This is intentionally outside createRenderJobIdempotent's transaction.
      await this.renderDispatcher.dispatch(dispatch);
    } catch {
      await this.repository.recordRenderDispatchFailure(result.job.jobUuid, "RENDER_DISPATCH_FAILED", this.now());
      const failed = await this.repository.getRenderJob(ownerId, result.job.jobUuid);
      if (!failed) throw new StationeryApiError("Render dispatch failed and the durable job could not be reloaded.", "RENDER_DISPATCH_FAILED", 503);
      return RenderJobPublicSchema.strip().parse(failed);
    }
    // If this write fails, the pending outbox safely retries the same job UUID.
    await this.repository.recordRenderDispatched(result.job.jobUuid, this.now());
    const dispatched = await this.repository.getRenderJob(ownerId, result.job.jobUuid);
    return RenderJobPublicSchema.strip().parse(dispatched ?? result.job);
  }

  private async resolveRenderSourceUrls(ownerId: string, template: TemplateVersionSpec, request: CreateRenderJobRequest): Promise<Record<string, string>> {
    const refs = new Map<string, { assetUuid: string; versionNumber: number; sha256: string }>();
    refs.set(template.backgroundAsset.assetUuid, template.backgroundAsset);
    for (const input of request.slotInputs) {
      if (input.kind === "image") refs.set(input.source.assetUuid, input.source);
    }
    const urls: Record<string, string> = {};
    for (const ref of refs.values()) {
      urls[ref.assetUuid] = await this.frozenFileAccess.createProviderReadUrl({
        ownerId,
        assetUuid: ref.assetUuid,
        versionNumber: ref.versionNumber,
        expectedSha256: ref.sha256,
      });
    }
    return urls;
  }

  async getRenderJob(ownerId: string, jobUuid: string): Promise<RenderJobPublic> {
    assertStationeryV2Enabled();
    const job = await this.repository.getRenderJob(ownerId, jobUuid);
    if (!job) throw new StationeryApiError("Render job was not found.", "RENDER_JOB_NOT_FOUND", 404);
    return RenderJobPublicSchema.strip().parse(job);
  }

  async completeRenderJob(jobUuid: string, rawRequest: CompleteRenderJobRequest): Promise<RenderJobPublic> {
    assertStationeryV2Enabled();
    const request = CompleteRenderJobRequestSchema.parse(rawRequest);
    const job = await this.repository.getRenderJobForCompletion(jobUuid);
    if (!job) throw new StationeryApiError("Render job was not found.", "RENDER_JOB_NOT_FOUND", 404);
    if (job.state === "ready") {
      if (job.renderManifest?.manifestHash !== request.renderManifest.manifestHash) {
        throw new StationeryApiError("A ready render job is immutable.", "IMMUTABLE_RENDER_CONFLICT", 409);
      }
      return RenderJobPublicSchema.strip().parse(job);
    }
    if (!["queued", "dispatch_failed", "rendering"].includes(job.state)) {
      throw new StationeryApiError("Render job cannot be completed from its current state.", "INVALID_RENDER_STATE", 409);
    }
    if (!verifyRenderManifest(request.renderManifest)) {
      throw new StationeryApiError("Render manifest hash is invalid.", "INVALID_RENDER_MANIFEST", 422);
    }
    const report = StationeryValidationReportSchema.parse(request.validationReport);
    if (!report.overallPass || report.findings.some((finding) => finding.severity === "error")) {
      throw new StationeryApiError("Renderer validation did not pass.", "RENDER_VALIDATION_FAILED", 422);
    }
    const manifest = request.renderManifest;
    if (
      manifest.templateUuid !== job.templateUuid
      || manifest.templateVersionNumber !== job.templateVersionNumber
      || manifest.templateSpecHash !== job.templateSpecHash
      || manifest.presetId !== job.presetId
      || report.templateUuid !== job.templateUuid
      || report.templateVersionNumber !== job.templateVersionNumber
    ) {
      throw new StationeryApiError("Renderer evidence is not bound to this render job.", "RENDER_BINDING_MISMATCH", 422);
    }
    if (manifest.validationReportHash !== sha256Canonical(report)) {
      throw new StationeryApiError("Render manifest does not bind the supplied validation report.", "VALIDATION_HASH_MISMATCH", 422);
    }

    const template = await this.requireTemplate(job.templateUuid, job.templateVersionNumber);
    const preset = template.spec.presets.find((candidate) => candidate.presetId === job.presetId);
    if (!preset
      || preset.format !== manifest.format
      || preset.widthPx !== manifest.widthPx
      || preset.heightPx !== manifest.heightPx
      || preset.targetDpi !== manifest.dpi
      || preset.colorProfile !== manifest.colorProfile) {
      throw new StationeryApiError("Render output does not match the frozen output preset.", "PRESET_OUTPUT_MISMATCH", 422);
    }
    const requiredSources = this.requiredSourceVersions(job.request, template);
    this.requireManifestSources(manifest.sourceVersions, requiredSources);
    await this.requireOwnedAssetEvidence(job.ownerId, manifest.output);
    return RenderJobPublicSchema.strip().parse(await this.repository.completeRenderJobImmutable({
      jobUuid,
      renderManifest: manifest,
      validationReport: report,
      updatedAt: this.now(),
    }));
  }

  async createPrintOrder(ownerId: string, rawRequest: CreatePrintOrderRequest): Promise<PrintOrderPublic> {
    assertStationeryV2Enabled();
    const request = CreatePrintOrderRequestSchema.parse(rawRequest);
    // Never accept payment evidence into a durable print order unless the
    // selected provider can actually receive the order. This prevents a
    // misleading paid-but-unfulfillable queue when production adapters are
    // missing or misconfigured.
    const provider = this.providers[request.provider];
    if (!provider || provider.provider !== request.provider) {
      throw new StationeryApiError("Fulfillment provider is not configured.", "PROVIDER_UNAVAILABLE", 503);
    }
    const requestHash = sha256Canonical(request);
    const existing = await this.repository.getPrintOrderByIdempotency(ownerId, request.idempotencyKey);
    if (existing) {
      this.assertPrintRequestBinding(existing, request, requestHash);
      return PrintOrderPublicSchema.strip().parse(existing);
    }
    const renderJob = await this.getRenderJob(ownerId, request.renderJobUuid);
    if (renderJob.state !== "ready" || !renderJob.renderManifest || !renderJob.output) {
      throw new StationeryApiError("A verified ready render is required before freezing a print order.", "RENDER_NOT_READY", 409);
    }
    if (!verifyRenderManifest(renderJob.renderManifest)) {
      throw new StationeryApiError("Stored render manifest failed integrity verification.", "INVALID_RENDER_MANIFEST", 422);
    }
    await this.requireOwnedAssetEvidence(ownerId, renderJob.output);

    const rawPayment = await this.paymentEvidence.getPaymentEvidence(ownerId, request.paidPaymentUuid);
    if (!rawPayment) throw new StationeryApiError("Confirmed paid-payment evidence is required.", "PAYMENT_REQUIRED", 402);
    const payment = PaymentEvidenceSchema.parse(rawPayment);
    if (payment.ownerId !== ownerId || payment.state !== "paid" || !payment.confirmedAt) {
      throw new StationeryApiError("Confirmed paid-payment evidence is required.", "PAYMENT_REQUIRED", 402);
    }

    const localOrderUuid = crypto.randomUUID();
    const now = this.now();
    const manifest = sealPrintManifest({
      schemaVersion: "stationery.print-manifest.v1",
      localOrderUuid,
      fulfillmentKind: "stationery_print",
      provider: request.provider,
      providerSku: request.providerSku,
      placement: request.placement,
      quantity: request.quantity,
      recipient: request.recipient,
      frozenFile: renderJob.output,
      renderManifestHash: renderJob.renderManifest.manifestHash,
      validationReportHash: renderJob.renderManifest.validationReportHash,
      paidPaymentUuid: payment.paymentUuid,
      frozenAt: now,
    });
    const snapshot = createProviderSubmission({
      localOrderUuid,
      provider: request.provider,
      printManifestHash: manifest.manifestHash,
      paymentState: "paid",
      createdAt: now,
    });
    const result = await this.repository.createFrozenPrintOrderIdempotent({
      localOrderUuid,
      ownerId,
      renderJobUuid: renderJob.jobUuid,
      clientIdempotencyKey: request.idempotencyKey,
      requestHash,
      manifest,
      paymentEvidence: payment,
      providerIdempotencyKey: snapshot.idempotencyKey,
      createdAt: now,
    });
    this.assertPrintRequestBinding(result.order, request, requestHash);
    return PrintOrderPublicSchema.strip().parse(result.order);
  }

  private assertPrintRequestBinding(order: PrintOrderPublic, request: CreatePrintOrderRequest, requestHash: string): void {
    if (sha256Canonical({
      renderJobUuid: order.renderJobUuid,
      provider: order.provider,
      providerSku: order.printManifest.providerSku,
      placement: order.printManifest.placement,
      quantity: order.printManifest.quantity,
      recipient: order.printManifest.recipient,
      paidPaymentUuid: order.paymentEvidence.paymentUuid,
      idempotencyKey: request.idempotencyKey,
    }) !== requestHash) {
      throw new StationeryApiError("The idempotency key is already bound to a different print request.", "IDEMPOTENCY_CONFLICT", 409);
    }
  }

  async getPrintOrder(ownerId: string, localOrderUuid: string): Promise<PrintOrderPublic> {
    assertStationeryV2Enabled();
    const order = await this.repository.getPrintOrder(ownerId, localOrderUuid);
    if (!order) throw new StationeryApiError("Print order was not found.", "PRINT_ORDER_NOT_FOUND", 404);
    return PrintOrderPublicSchema.parse(order);
  }

  async submitPrintOrder(ownerId: string, localOrderUuid: string, rawRequest: unknown): Promise<PrintOrderPublic> {
    assertStationeryV2Enabled();
    const request = SubmitPrintOrderRequestSchema.parse(rawRequest);
    const order = await this.getPrintOrder(ownerId, localOrderUuid);
    if (request.providerIdempotencyKey !== order.providerIdempotencyKey) {
      throw new StationeryApiError("Submission must reuse the order's original provider idempotency key.", "IDEMPOTENCY_CONFLICT", 409);
    }
    this.assertOrderSubmittable(order);
    const provider = this.providers[order.provider];
    if (!provider || provider.provider !== order.provider) {
      throw new StationeryApiError("Fulfillment provider is not configured.", "PROVIDER_UNAVAILABLE", 503);
    }

    const shouldSubmit = await this.applyEventUnderLock(order, {
      eventId: `submission-started:${order.providerIdempotencyKey}`,
      occurredAt: this.now(),
      type: "submission_started",
    });
    if (["submitted", "processing", "fulfilled"].includes(shouldSubmit.order.state)
      || (shouldSubmit.disposition === "duplicate" && !["failed_retryable", "reconciliation_required"].includes(shouldSubmit.order.state))) {
      return shouldSubmit.order;
    }

    try {
      const frozenFileUrl = z.string().url().parse(await this.frozenFileAccess.createProviderReadUrl({
        ownerId,
        assetUuid: order.printManifest.frozenFile.assetUuid,
        versionNumber: order.printManifest.frozenFile.versionNumber,
        expectedSha256: order.printManifest.frozenFile.sha256,
      }));
      const acknowledgement = ProviderSubmissionAcknowledgementSchema.parse(await provider.submitFrozenManifest({
        idempotencyKey: order.providerIdempotencyKey,
        printManifestHash: order.printManifest.manifestHash,
        frozenFileUrl,
        providerSku: order.printManifest.providerSku,
        placement: order.printManifest.placement,
        quantity: order.printManifest.quantity,
        recipient: order.printManifest.recipient,
      }));
      const applied = await this.applyEventUnderLock(order, {
        eventId: `submission-acknowledged:${order.providerIdempotencyKey}:${acknowledgement.providerOrderId}`,
        occurredAt: this.now(),
        type: "submission_acknowledged",
        providerOrderId: acknowledgement.providerOrderId,
      });
      if (acknowledgement.state === "processing") {
        return (await this.applyEventUnderLock(applied.order, {
          eventId: `submission-processing:${order.providerIdempotencyKey}:${acknowledgement.providerOrderId}`,
          occurredAt: this.now(),
          type: "provider_processing",
          providerOrderId: acknowledgement.providerOrderId,
        })).order;
      }
      return applied.order;
    } catch {
      return (await this.applyEventUnderLock(order, {
        eventId: `submission-uncertain:${order.providerIdempotencyKey}`,
        occurredAt: this.now(),
        type: "outcome_uncertain",
      })).order;
    }
  }

  async applyAuthenticatedProviderEvent(
    provider: "printful" | "slant3d",
    rawRequest: ProviderWebhookRequest,
  ): Promise<ProviderEventResult> {
    assertStationeryV2Enabled();
    const request = ProviderWebhookRequestSchema.parse(rawRequest);
    const order = await this.repository.getPrintOrderByUuid(request.localOrderUuid);
    if (!order || order.provider !== provider) {
      throw new StationeryApiError("Print order was not found for this provider.", "PRINT_ORDER_NOT_FOUND", 404);
    }
    return ProviderEventResultSchema.parse(await this.applyEventUnderLock(PrintOrderPublicSchema.strip().parse(order), request.event));
  }

  async applyNativeProviderEvent(provider: "printful" | "slant3d", payload: unknown): Promise<ProviderEventResult> {
    assertStationeryV2Enabled();
    const reference = parseNativeProviderWebhook(provider, payload);
    const order = await this.repository.getPrintOrderByProviderReference({
      provider,
      providerIdempotencyKey: reference.providerIdempotencyKey ?? undefined,
      providerOrderId: reference.providerOrderId ?? undefined,
    });
    if (!order) throw new StationeryApiError("Native provider event could not be mapped to a local print order.", "PRINT_ORDER_NOT_FOUND", 404);
    return ProviderEventResultSchema.parse(await this.applyEventUnderLock(order, reference.event));
  }

  async reconcilePrintOrder(ownerId: string, localOrderUuid: string, reason: string): Promise<ReconciliationResult> {
    assertStationeryV2Enabled();
    const reconcileRequest = ReconcileOrderRequestSchema.parse({ reason });
    const order = await this.getPrintOrder(ownerId, localOrderUuid);
    const provider = this.providers[order.provider];
    if (!provider) throw new StationeryApiError("Fulfillment provider is not configured.", "PROVIDER_UNAVAILABLE", 503);

    let observation = null;
    try {
      observation = ProviderReconciliationObservationSchema.parse(await provider.observe(order.providerOrderId, order.providerIdempotencyKey));
    } catch {
      observation = { availability: "unavailable" as const, checkedAt: this.now() };
    }
    const durableSubmission = await this.repository.getByLocalOrderUuid(localOrderUuid);
    if (!durableSubmission) throw new StationeryApiError("Fulfillment state was not found.", "PRINT_ORDER_NOT_FOUND", 404);
    const decision = decideProviderReconciliation(durableSubmission, observation, this.now());
    let current = order;
    if (decision.action === "adopt_provider_state" && decision.targetState && decision.providerOrderId) {
      const event = this.reconciliationEvent(decision.targetState, decision.providerOrderId);
      current = (await this.applyEventUnderLock(order, event)).order;
    }
    await this.repository.recordReconciliation({
      reconciliationUuid: crypto.randomUUID(),
      localOrderUuid,
      requestedByOwnerId: ownerId,
      reason: reconcileRequest.reason,
      observation,
      decision,
      recordedAt: this.now(),
    });
    return ReconciliationResultSchema.parse({ order: current, decision });
  }

  private async validateRenderRequest(
    ownerId: string,
    template: TemplateVersionSpec,
    request: CreateRenderJobRequest,
  ): Promise<StationeryValidationReport> {
    const templateReport = validateTemplateSpec(template);
    const inputs = new Map(request.slotInputs.map((input) => [input.slotId, input]));
    const findings = [...templateReport.findings];
    for (const slot of template.slots) {
      const input = inputs.get(slot.slotId);
      if (!input && slot.required) {
        findings.push({ ruleId: "input.required_slot", severity: "error", subject: slot.slotId, message: "Required slot input is missing." });
        continue;
      }
      if (input && input.kind !== slot.kind) {
        findings.push({ ruleId: "input.slot_kind", severity: "error", subject: slot.slotId, message: "Slot input kind does not match the template." });
      }
    }
    for (const input of request.slotInputs) {
      if (!template.slots.some((slot) => slot.slotId === input.slotId)) {
        findings.push({ ruleId: "input.unknown_slot", severity: "error", subject: input.slotId, message: "Slot is not present in this template version." });
      }
    }
    findings.push(...findTextOverflow(request.slotInputs.filter((input) => input.kind === "text").map((input) => input.measurement)));

    for (const input of request.slotInputs) {
      if (input.kind === "image") await this.requireOwnedAssetEvidence(ownerId, input.source);
    }
    await this.requireAssetEvidence(template.backgroundAsset, true);
    return StationeryValidationReportSchema.parse({
      ...templateReport,
      findings,
      overallPass: findings.every((finding) => finding.severity !== "error"),
    });
  }

  private async requireTemplate(templateUuid: string, versionNumber: number): Promise<StationeryTemplateVersionRecord> {
    const template = await this.repository.getTemplateVersion(templateUuid, versionNumber);
    if (!template) throw new StationeryApiError("Template version was not found.", "TEMPLATE_NOT_FOUND", 404);
    this.verifyTemplateHash(template);
    return template;
  }

  private verifyTemplateHash(template: StationeryTemplateVersionRecord): void {
    if (hashTemplateSpec(template.spec) !== template.specHash) {
      throw new StationeryApiError("Template version failed integrity verification.", "TEMPLATE_HASH_MISMATCH", 422);
    }
  }

  private requiredSourceVersions(request: CreateRenderJobRequest, template: StationeryTemplateVersionRecord): Array<z.infer<typeof AssetVersionRefSchema>> {
    return [
      template.spec.backgroundAsset,
      ...request.slotInputs.filter((input) => input.kind === "image").map((input) => input.source),
    ];
  }

  private requireManifestSources(actual: Array<z.infer<typeof AssetVersionRefSchema>>, required: Array<z.infer<typeof AssetVersionRefSchema>>): void {
    const actualKeys = actual.map((item) => `${item.assetUuid}:${item.versionNumber}:${item.sha256}`);
    const requiredKeys = required.map((item) => `${item.assetUuid}:${item.versionNumber}:${item.sha256}`);
    const actualSet = new Set(actualKeys);
    const requiredSet = new Set(requiredKeys);
    if (
      actualSet.size !== actualKeys.length
      || actualSet.size !== requiredSet.size
      || [...requiredSet].some((key) => !actualSet.has(key))
    ) {
      throw new StationeryApiError("Render manifest source versions do not exactly match the approved frozen inputs.", "SOURCE_LINEAGE_MISMATCH", 422);
    }
  }

  private async requireOwnedAssetEvidence(ownerId: string, ref: z.infer<typeof AssetVersionRefSchema>): Promise<void> {
    const evidence = await this.requireAssetEvidence(ref, true);
    if (evidence.ownerId !== ownerId) {
      throw new StationeryApiError("Asset version is not owned by the authenticated user.", "ASSET_FORBIDDEN", 403);
    }
  }

  private async requireAssetEvidence(ref: z.infer<typeof AssetVersionRefSchema>, requireCommercial: boolean) {
    const parsed = AssetVersionRefSchema.parse(ref);
    const evidence = await this.repository.getAssetEvidence(parsed.assetUuid, parsed.versionNumber);
    if (!evidence || evidence.status !== "active" || evidence.sha256 !== parsed.sha256) {
      throw new StationeryApiError("Frozen asset version evidence is missing or mismatched.", "ASSET_VERSION_MISMATCH", 422);
    }
    if (requireCommercial && !evidence.commercialUseEligible) {
      throw new StationeryApiError("Asset version is not eligible for commercial output.", "ASSET_RIGHTS_FAILED", 422);
    }
    return evidence;
  }

  private assertOrderSubmittable(order: PrintOrderPublic): void {
    if (!verifyPrintManifest(order.printManifest)) {
      throw new StationeryApiError("Frozen print manifest failed integrity verification.", "INVALID_PRINT_MANIFEST", 422);
    }
    if (order.paymentEvidence.state !== "paid" || !order.paymentEvidence.confirmedAt) {
      throw new StationeryApiError("Confirmed payment evidence is required before provider submission.", "PAYMENT_REQUIRED", 402);
    }
    if (["failed_terminal", "canceled"].includes(order.state)) {
      throw new StationeryApiError("Order cannot be submitted from its current state.", "INVALID_ORDER_STATE", 409);
    }
  }

  private async applyEventUnderLock(order: PrintOrderPublic, rawEvent: ProviderEvent): Promise<ProviderEventResult> {
    const event = ProviderEventSchema.parse(rawEvent);
    return this.repository.withOrderLock(order.localOrderUuid, async (locked) => {
      const current = await locked.getForUpdate();
      if (!current) throw new StationeryApiError("Fulfillment state was not found.", "PRINT_ORDER_NOT_FOUND", 404);
      const claim = await locked.claimProviderEventId(order.provider, event.eventId, order.localOrderUuid);
      if (claim === "conflict") {
        throw new StationeryApiError("Provider event identity is already bound to another order.", "PROVIDER_EVENT_CONFLICT", 409);
      }
      if (claim === "existing") {
        return ProviderEventResultSchema.parse({
          order: this.withSubmission(order, current),
          disposition: "duplicate",
          reason: "Provider event was already claimed.",
        });
      }
      const result = applyProviderEvent(current, event);
      if (result.snapshot.updatedAt !== current.updatedAt || result.snapshot.state !== current.state || result.snapshot.appliedEventIds.length !== current.appliedEventIds.length) {
        const saved = await locked.saveTransition(current.updatedAt, result.snapshot);
        if (saved !== "saved") throw new StationeryApiError("Order changed during the transition.", "ORDER_CONFLICT", 409);
      }
      await locked.recordProviderEventEvidence({
        provider: order.provider,
        localOrderUuid: order.localOrderUuid,
        event,
        disposition: result.disposition,
        reason: result.reason,
        recordedAt: this.now(),
      });
      return ProviderEventResultSchema.parse({
        order: this.withSubmission(order, result.snapshot),
        disposition: result.disposition,
        reason: result.reason,
      });
    });
  }

  private withSubmission(order: PrintOrderPublic, snapshot: ReturnType<typeof createProviderSubmission>): PrintOrderPublic {
    return PrintOrderPublicSchema.parse({
      ...order,
      state: snapshot.state,
      providerOrderId: snapshot.providerOrderId,
      providerIdempotencyKey: snapshot.idempotencyKey,
      updatedAt: snapshot.updatedAt,
    });
  }

  private reconciliationEvent(state: string, providerOrderId: string): ProviderEvent {
    const base = { eventId: `reconciliation:${crypto.randomUUID()}`, occurredAt: this.now(), providerOrderId };
    if (state === "submitted") return { ...base, type: "submission_acknowledged" };
    if (state === "processing") return { ...base, type: "provider_processing" };
    if (state === "fulfilled") return { ...base, type: "provider_fulfilled" };
    if (state === "canceled") return { ...base, type: "cancellation_confirmed" };
    if (state === "failed_retryable") return { ...base, type: "provider_failed", retryable: true };
    return { ...base, type: "provider_failed", retryable: false };
  }

  private now(): string {
    const value = this.clock.now();
    if (!Number.isFinite(Date.parse(value))) throw new StationeryApiError("Clock returned an invalid timestamp.", "INVALID_CLOCK", 500);
    return value;
  }
}
