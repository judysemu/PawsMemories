import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import { createProviderForSku } from "./factory";
import { MySqlProviderJobStore } from "./jobStore";
import { PetGlbOrderRepository, type PetGlbOrder } from "./orderRepository";
import { validatePetGlb, validatePetGlbStage, type ValidationReport } from "./validation";
import { CUSTOM_RIGGED_PET_GLB_V1 } from "./skuRegistry";
import { PetGenerationError } from "./provider";
import type {
  PetGlbModelStageKind,
  PetGlbOrderConfiguration,
  PetGlbStageKind,
  PetModelGenerationInput,
} from "./types";
import {
  canonicalHash,
  FACIAL_RIG_POLICY,
  meshProfilePolicy,
  productQuote,
  rigTypeForSubject,
  stagePrice,
} from "./contracts";
import {
  PetGlbStageRepository,
  type ExactStageApproval,
  type PetGlbStageAttempt,
} from "./stageRepository";
import { CREDIT_PRICES } from "../../src/pricing";

export interface PetGlbServiceDeps {
  getPool: () => mysql.Pool;
  isAdmin: (phone: string) => Promise<boolean>;
  isOperator?: (phone: string) => Promise<boolean>;
  /** Persists a GLB buffer as an immutable asset version. Returns version id. */
  persistVersion: (input: {
    ownerPhone: string;
    assetId: number | null;
    glb: Buffer;
    sha256: string;
    validationReport: ValidationReport;
    metadata: Record<string, unknown>;
    stage?: PetGlbModelStageKind;
  }) => Promise<{ assetId: number; versionId: number }>;
  /** Issues a short-lived authenticated download URL for an approved version. */
  signDownload: (versionId: number, ownerPhone: string, ttlSeconds: number) => Promise<string>;
  rigProfileJoints?: string[];
}

export const DOWNLOAD_TTL_SECONDS = 900;

/** Credits quote — reuses the existing formula unchanged. Do not "refine". */
export function quoteCredits(viewCount: number, baseCredits = 10): number {
  const viewMultiplier = viewCount >= 5 ? 1.5 : 1;
  return Math.ceil(baseCredits * viewMultiplier);
}

export class PetGlbService {
  private readonly orders: PetGlbOrderRepository;
  private readonly stages: PetGlbStageRepository;

  constructor(private readonly deps: PetGlbServiceDeps) {
    this.orders = new PetGlbOrderRepository(deps.getPool);
    this.stages = new PetGlbStageRepository(deps.getPool);
  }

  get repository(): PetGlbOrderRepository {
    return this.orders;
  }

  get stageRepository(): PetGlbStageRepository {
    return this.stages;
  }

  // ── Customer-gated product ───────────────────────────────────────────────

  async createConfiguredOrder(
    ownerPhone: string,
    configuration: PetGlbOrderConfiguration,
  ): Promise<PetGlbOrderView> {
    const order = await this.orders.createConfigured(
      ownerPhone,
      CUSTOM_RIGGED_PET_GLB_V1,
      configuration,
    );
    return this.buildView(order);
  }

  async getOrderView(orderUuid: string, ownerPhone: string): Promise<PetGlbOrderView> {
    return this.buildView(await this.requireOwned(orderUuid, ownerPhone));
  }

  async listOrderViews(ownerPhone: string, limit = 20): Promise<PetGlbOrderView[]> {
    const orders = await this.orders.listByOwner(ownerPhone, limit);
    return Promise.all(orders.map((order) => this.buildView(order)));
  }

  async submitReferenceManifest(
    orderUuid: string,
    ownerPhone: string,
    manifest: PetModelGenerationInput,
  ): Promise<PetGlbOrderView> {
    const order = await this.requireOwned(orderUuid, ownerPhone);
    const inputHash = canonicalHash({
      manifest,
      meshProfile: order.meshProfile,
      subjectProfile: order.subjectProfile,
      includeTexture: order.includeTexture,
      includeRig: order.includeRig,
      textureQuality: order.textureQuality,
      styleDirection: order.styleDirection,
    });
    await this.stages.saveReferenceManifest(
      order.id,
      ownerPhone,
      { ...manifest } as Record<string, string>,
      inputHash,
    );
    return this.buildView((await this.orders.findByUuid(orderUuid))!);
  }

  async approveCustomerStage(
    orderUuid: string,
    ownerPhone: string,
    approval: ExactStageApproval,
  ): Promise<PetGlbOrderView> {
    const order = await this.requireOwned(orderUuid, ownerPhone);
    const current = await this.stages.findCurrent(order.id);
    if (!current) throw new PetGenerationError("STAGE_NOT_FOUND", "Order has no current stage");

    const nextStage = this.nextStage(order, current.stage);
    const nextInputHash = nextStage
      ? canonicalHash({
          orderUuid,
          nextStage,
          sourceAttemptUuid: current.attemptUuid,
          sourceArtifactSha256: current.artifactSha256,
          meshProfile: order.meshProfile,
          subjectProfile: order.subjectProfile,
          textureQuality: order.textureQuality,
          styleDirection: order.styleDirection,
        })
      : null;

    const queued = await this.stages.approveAndQueueNext({
      orderId: order.id,
      ownerPhone,
      approval,
      nextStage,
      nextInputHash,
      nextPriceCredits: nextStage ? stagePrice(nextStage) : 0,
    });

    if (queued.next) {
      await this.startQueuedStage(orderUuid, ownerPhone, queued.next);
    }
    return this.buildView((await this.orders.findByUuid(orderUuid))!);
  }

  async pollCustomerStage(
    orderUuid: string,
    ownerPhone: string,
    requestedStage: PetGlbStageKind,
  ): Promise<PetGlbOrderView> {
    const order = await this.requireOwned(orderUuid, ownerPhone);
    let attempt = await this.stages.findCurrent(order.id);
    if (!attempt || attempt.stage !== requestedStage) {
      throw new PetGenerationError("STALE_STAGE", "Requested stage is not current");
    }
    if (attempt.state === "recovery_required") {
      if (
        attempt.stage !== "reference"
        && attempt.stage !== "rig_check"
        && attempt.assetId
        && attempt.assetVersionId
        && attempt.validationReport
        && attempt.validationReportSha256
      ) {
        await this.stages.recoverPersistedModelStage(order.id, attempt.id);
        return this.buildView((await this.orders.findByUuid(orderUuid))!);
      }
      attempt = await this.stages.resumeProviderRecovery(order.id, attempt.id);
    }
    let completionClaimed = false;
    if (attempt.state === "persisting") {
      // Another request normally owns the active completion claim. The
      // repository returns true only when its bounded stale interval elapsed.
      completionClaimed = await this.stages.claimCompletion(order.id, attempt.id);
      if (!completionClaimed) return this.buildView(order, attempt);
      attempt = { ...attempt, state: "persisting" };
    }
    if ((!completionClaimed && attempt.state !== "processing") || !attempt.providerJobId) {
      return this.buildView(order);
    }

    const provider = this.provider();
    const job = await provider.getJob(attempt.providerJobId);
    if (job.status === "failed" || job.status === "cancelled") {
      await this.stages.failAndRefund(
        order.id,
        attempt.id,
        ownerPhone,
        job.reason || job.status.toUpperCase(),
      );
      return this.buildView((await this.orders.findByUuid(orderUuid))!);
    }
    if (job.status !== "completed") return this.buildView(order, attempt, job.progress);

    if (attempt.stage === "reference") {
      throw new PetGenerationError("INVALID_POLL_STAGE", "Reference approval has no provider job");
    }
    const claimed = completionClaimed || await this.stages.claimCompletion(order.id, attempt.id);
    if (!claimed) {
      return this.buildView((await this.orders.findByUuid(orderUuid))!);
    }

    if (attempt.stage === "rig_check") {
      try {
        const expected = rigTypeForSubject(order.subjectProfile);
        const capability = job.capability || { riggable: false, rigType: null };
        const verified = {
          riggable: capability.riggable && capability.rigType === expected,
          rigType: capability.rigType,
        };
        await this.stages.completeRigCheck(
          order.id,
          attempt.id,
          verified,
          canonicalHash(verified),
        );
      } catch (error) {
        await this.stages.markRecoveryRequired({
          orderId: order.id,
          attemptId: attempt.id,
          providerJobId: attempt.providerJobId,
          failureCode: "RIG_CHECK_FINALIZE_FAILED",
        });
        throw error;
      }
      return this.buildView((await this.orders.findByUuid(orderUuid))!);
    }

    let persisted: {
      assetId: number;
      versionId: number;
      artifactSha256: string;
      report: ValidationReport;
      reportSha256: string;
    } | null = null;
    try {
      const artifacts = await provider.fetchArtifacts(attempt.providerJobId);
      const report = validatePetGlbStage(artifacts.glb.data, {
        stage: attempt.stage,
        meshProfile: order.meshProfile,
        rigProfileJoints: attempt.stage === "rig" ? this.deps.rigProfileJoints : undefined,
      });
      const reportSha256 = canonicalHash(report);
      const { assetId, versionId } = await this.deps.persistVersion({
        ownerPhone: order.ownerPhone,
        assetId: order.assetId,
        glb: artifacts.glb.data,
        sha256: artifacts.glb.sha256,
        validationReport: report,
        stage: attempt.stage,
        metadata: {
          ...artifacts.metadata,
          orderUuid,
          stage: attempt.stage,
          stageAttemptUuid: attempt.attemptUuid,
          meshProfile: order.meshProfile,
          subjectProfile: order.subjectProfile,
          styleDirection: order.styleDirection,
          triangleCount: report.triangleCount,
        },
      });
      persisted = {
        assetId,
        versionId,
        artifactSha256: artifacts.glb.sha256,
        report,
        reportSha256,
      };
      await this.stages.completeModelStage({
        orderId: order.id,
        attemptId: attempt.id,
        stage: attempt.stage,
        assetId,
        assetVersionId: versionId,
        artifactSha256: artifacts.glb.sha256,
        report,
        reportSha256,
      });
    } catch (error) {
      if (persisted) {
        await this.stages.markPersistedRecovery({
          orderId: order.id,
          attemptId: attempt.id,
          providerJobId: attempt.providerJobId,
          assetId: persisted.assetId,
          assetVersionId: persisted.versionId,
          artifactSha256: persisted.artifactSha256,
          report: persisted.report,
          reportSha256: persisted.reportSha256,
        });
      } else {
        await this.stages.failAndRefund(
          order.id,
          attempt.id,
          ownerPhone,
          error instanceof PetGenerationError ? error.code : "STAGE_PERSIST_FAILED",
        );
      }
      throw error;
    }
    return this.buildView((await this.orders.findByUuid(orderUuid))!);
  }

  async previewCurrentStage(
    orderUuid: string,
    ownerPhone: string,
  ): Promise<{ url: string; versionId: number; expiresInSeconds: number }> {
    const order = await this.requireOwned(orderUuid, ownerPhone);
    const current = await this.stages.findCurrent(order.id);
    if (!current?.assetVersionId) {
      throw new PetGenerationError("NO_STAGE_ARTIFACT", "Current stage has no previewable GLB");
    }
    return {
      url: await this.deps.signDownload(current.assetVersionId, ownerPhone, DOWNLOAD_TTL_SECONDS),
      versionId: current.assetVersionId,
      expiresInSeconds: DOWNLOAD_TTL_SECONDS,
    };
  }

  async rejectCustomerStage(
    orderUuid: string,
    ownerPhone: string,
    input: { attemptUuid: string; reason: string; idempotencyKey: string },
  ): Promise<PetGlbOrderView> {
    const order = await this.requireOwned(orderUuid, ownerPhone);
    await this.stages.rejectCurrent(
      order.id,
      ownerPhone,
      input.attemptUuid,
      input.reason,
      input.idempotencyKey,
    );
    return this.buildView((await this.orders.findByUuid(orderUuid))!);
  }

  async retryCustomerStage(
    orderUuid: string,
    ownerPhone: string,
    input: { attemptUuid: string; idempotencyKey: string },
  ): Promise<PetGlbOrderView> {
    const order = await this.requireOwned(orderUuid, ownerPhone);
    const current = await this.stages.findCurrent(order.id);
    if (!current || current.attemptUuid !== input.attemptUuid) {
      throw new PetGenerationError("STALE_STAGE", "Retry does not match the current stage");
    }
    const retryPrice = current.attemptNumber === 1
      ? CREDIT_PRICES.FIRST_REGENERATION
      : CREDIT_PRICES.ADDITIONAL_REGENERATION;
    const retry = await this.stages.queueRetry({
      orderId: order.id,
      ownerPhone,
      attemptUuid: input.attemptUuid,
      idempotencyKey: input.idempotencyKey,
      inputHash: canonicalHash({
        retryOf: current.attemptUuid,
        stage: current.stage,
        nextAttemptNumber: current.attemptNumber + 1,
        sourceAttemptId: current.sourceAttemptId,
      }),
      priceCredits: retryPrice,
    });
    await this.startQueuedStage(orderUuid, ownerPhone, retry);
    return this.buildView((await this.orders.findByUuid(orderUuid))!);
  }

  private provider() {
    return createProviderForSku(CUSTOM_RIGGED_PET_GLB_V1, {
      store: new MySqlProviderJobStore(this.deps.getPool),
    });
  }

  private async startQueuedStage(
    orderUuid: string,
    ownerPhone: string,
    attempt: PetGlbStageAttempt,
  ): Promise<void> {
    if (attempt.state !== "queued") return;
    const order = await this.requireOwned(orderUuid, ownerPhone);
    const provider = this.provider();
    let startedJobId: string | null = null;
    try {
      let job;
      if (attempt.stage === "base") {
        if (!order.referenceManifest) {
          throw new PetGenerationError("REFERENCES_MISSING", "Approved references are missing");
        }
        job = await provider.createBaseJob({
          ...(order.referenceManifest as unknown as PetModelGenerationInput),
          meshProfile: order.meshProfile,
          subjectProfile: order.subjectProfile,
        });
      } else {
        const source = await this.resolveSourceModelAttempt(attempt);
        if (!source.providerJobId) {
          throw new PetGenerationError("SOURCE_JOB_MISSING", "Approved source stage has no provider job");
        }
        if (attempt.stage === "texture") {
          job = await provider.createTextureJob(source.providerJobId, {
            styleDirection: order.styleDirection,
            quality: order.textureQuality,
          });
        } else if (attempt.stage === "rig_check") {
          job = await provider.createRigCheckJob(source.providerJobId);
        } else if (attempt.stage === "rig") {
          job = await provider.createRigJob(source.providerJobId, order.subjectProfile);
        } else {
          throw new PetGenerationError("UNSUPPORTED_STAGE", `Cannot start ${attempt.stage}`);
        }
      }
      startedJobId = job.id;
      await this.stages.attachProviderJob(order.id, attempt.id, job.id);
    } catch (error: any) {
      if (startedJobId) {
        await this.stages.markRecoveryRequired({
          orderId: order.id,
          attemptId: attempt.id,
          providerJobId: startedJobId,
          failureCode: "PROVIDER_JOB_ATTACH_FAILED",
        });
      } else {
        await this.stages.failAndRefund(
          order.id,
          attempt.id,
          ownerPhone,
          error instanceof PetGenerationError ? error.code : "PROVIDER_START_FAILED",
        );
      }
      throw error;
    }
  }

  private async resolveSourceModelAttempt(attempt: PetGlbStageAttempt): Promise<PetGlbStageAttempt> {
    if (!attempt.sourceAttemptId) {
      throw new PetGenerationError("SOURCE_STAGE_MISSING", "Stage has no approved source");
    }
    let source = await this.stages.findById(attempt.sourceAttemptId);
    if (!source) throw new PetGenerationError("SOURCE_STAGE_MISSING", "Source stage was not found");
    // Rig is queued from the approved rig-check. The provider must receive the
    // model that the rig check inspected, not the rig-check task itself.
    if (source.stage === "rig_check") {
      if (!source.sourceAttemptId) {
        throw new PetGenerationError("SOURCE_STAGE_MISSING", "Rig check has no source model");
      }
      source = await this.stages.findById(source.sourceAttemptId);
      if (!source) throw new PetGenerationError("SOURCE_STAGE_MISSING", "Rig source model was not found");
    }
    if (source.state !== "approved") {
      throw new PetGenerationError("SOURCE_NOT_APPROVED", "Next stage source is not customer-approved");
    }
    return source;
  }

  private nextStage(
    order: PetGlbOrder,
    current: PetGlbStageKind,
  ): Exclude<PetGlbStageKind, "reference"> | null {
    if (current === "reference") return "base";
    if (current === "base") {
      if (order.includeTexture) return "texture";
      if (order.includeRig) return "rig_check";
      return null;
    }
    if (current === "texture") return order.includeRig ? "rig_check" : null;
    if (current === "rig_check") return "rig";
    return null;
  }

  private async buildView(
    order: PetGlbOrder,
    currentOverride?: PetGlbStageAttempt | null,
    progress?: number,
  ): Promise<PetGlbOrderView> {
    const current = currentOverride === undefined
      ? await this.stages.findCurrent(order.id)
      : currentOverride;
    return {
      order,
      currentStage: current,
      progress,
      quote: productQuote(order),
      meshPolicy: meshProfilePolicy(order.meshProfile),
      facialRig: FACIAL_RIG_POLICY,
    };
  }

  // ── 1. Order creation + credit reservation ────────────────────────────────
  async createOrder(ownerPhone: string): Promise<PetGlbOrder> {
    const credits = quoteCredits(5);
    const pool = this.deps.getPool();

    const [balRows] = await pool.query("SELECT credits FROM users WHERE phone = ? LIMIT 1", [ownerPhone]);
    const balance = (balRows as any[])[0]?.credits ?? 0;
    if (balance < credits) {
      throw new PetGenerationError("INSUFFICIENT_CREDITS", `Requires ${credits} credits; balance ${balance}`);
    }

    const order = await this.orders.create(ownerPhone, CUSTOM_RIGGED_PET_GLB_V1, credits);
    await pool.query("UPDATE users SET credits = credits - ? WHERE phone = ?", [credits, ownerPhone]);
    return this.orders.transition(order.id, "awaiting_payment", {
      actorType: "customer",
      actorId: ownerPhone,
      reason: "credits_reserved",
    });
  }

  // ── 2. Payment — ONLY a verified webhook may set paid ─────────────────────
  async handlePaymentSucceeded(eventId: string, eventType: string, orderUuid: string): Promise<PetGlbOrder | null> {
    const order = await this.orders.findByUuid(orderUuid);
    if (!order) throw new PetGenerationError("ORDER_NOT_FOUND", `No order ${orderUuid}`);

    // Inbound replay defence — a redelivered event is a no-op.
    const first = await this.orders.claimStripeEvent(eventId, eventType, order.id);
    if (!first) return null;

    await this.deps.getPool().query(
      `UPDATE pet_glb_orders SET credits_disposition = 'charged' WHERE id = ?`,
      [order.id],
    );
    const paid = await this.orders.transition(order.id, "paid", {
      actorType: "system",
      reason: "stripe_webhook_verified",
      requestId: eventId,
    });
    return this.orders.transition(paid.id, "awaiting_references", { actorType: "system" });
  }

  // ── 2b. Payment — credits-only path ───────────────────────────────────────
  /**
   * This SKU is paid entirely in credits; there is no per-order Stripe charge.
   * Credits are bought separately via the site's existing (verified) credit-
   * purchase webhook and already sit in the user's wallet. They were debited
   * and marked `reserved` at order creation (createOrder). "Paying" the order
   * simply finalises that reservation to `charged` and advances the state
   * machine — no money moves here, so no signature to verify. Customer-driven
   * and idempotent: a second call after payment returns the current order.
   */
  async payWithCredits(orderUuid: string, ownerPhone: string): Promise<PetGlbOrder> {
    const order = await this.requireOwned(orderUuid, ownerPhone);

    if (order.state !== "awaiting_payment") {
      // Already paid → idempotent success. Anything else is illegal.
      if (order.creditsDisposition === "charged") return order;
      throw new PetGenerationError(
        "ILLEGAL_TRANSITION",
        `Order ${orderUuid} cannot be paid from state ${order.state}`,
      );
    }

    // Guarded charge: finalise the reservation. Credits already left the wallet
    // at reserve time; affectedRows 0 (already charged) is a safe no-op.
    await this.deps.getPool().query(
      `UPDATE pet_glb_orders SET credits_disposition = 'charged' WHERE id = ? AND credits_disposition = 'reserved'`,
      [order.id],
    );

    const paid = await this.orders.transition(order.id, "paid", {
      actorType: "customer",
      actorId: ownerPhone,
      reason: "credits_charged",
    });
    return this.orders.transition(paid.id, "awaiting_references", { actorType: "system" });
  }

  // ── 3. References ─────────────────────────────────────────────────────────
  async attachReferences(orderUuid: string, ownerPhone: string, referenceSessionId: number): Promise<PetGlbOrder> {
    const order = await this.requireOwned(orderUuid, ownerPhone);
    await this.deps.getPool().query(
      `UPDATE pet_glb_orders SET reference_session_id = ? WHERE id = ?`,
      [referenceSessionId, order.id],
    );
    return this.orders.transition(order.id, "references_received", {
      actorType: "customer",
      actorId: ownerPhone,
    });
  }

  // ── 4. Generation — unpaid orders can never reach here ────────────────────
  async startGeneration(orderUuid: string, refs: PetModelGenerationInput): Promise<PetGlbOrder> {
    const order = await this.mustFind(orderUuid);
    if (order.creditsDisposition !== "charged") {
      throw new PetGenerationError("NOT_PAID", `Order ${orderUuid} is not paid`);
    }
    if (order.generationJobId) {
      // Retry reuses the existing job — never a second charge.
      return this.orders.transition(order.id, "generating", { actorType: "system", jobId: order.generationJobId });
    }

    // The storefront submits reference URLs straight to /generate without a
    // separate reference-session step, so an order arrives here still in
    // `awaiting_references`. `queued` is only legal from `references_received`
    // (LEGAL map), so advance through it first, recording that references were
    // supplied inline with the generate call.
    let ready = order;
    if (ready.state === "awaiting_references") {
      ready = await this.orders.transition(ready.id, "references_received", {
        actorType: "customer",
        actorId: ready.ownerPhone,
        reason: "references_supplied_via_generate",
      });
    }

    const queued = await this.orders.transition(ready.id, "queued", { actorType: "system" });
    const provider = createProviderForSku(CUSTOM_RIGGED_PET_GLB_V1, {
      store: new MySqlProviderJobStore(this.deps.getPool),
    });
    const job = await provider.createJob(refs);
    await this.orders.attachGenerationJob(queued.id, job.id);
    return this.orders.transition(queued.id, "generating", { actorType: "system", jobId: job.id });
  }

  // ── 5. Poll + validate + persist immutable version ────────────────────────
  async pollAndValidate(orderUuid: string): Promise<{ order: PetGlbOrder; report?: ValidationReport }> {
    const order = await this.mustFind(orderUuid);
    if (!order.generationJobId) throw new PetGenerationError("NO_JOB", "Order has no generation job");

    const provider = createProviderForSku(CUSTOM_RIGGED_PET_GLB_V1, {
      store: new MySqlProviderJobStore(this.deps.getPool),
    });

    const job = await provider.getJob(order.generationJobId);
    if (job.status === "cancelled") {
      return { order: await this.orders.transition(order.id, "cancelled", { actorType: "system" }) };
    }
    if (job.status === "failed") {
      return { order: await this.orders.transition(order.id, "failed", { actorType: "system", reason: job.reason }) };
    }
    if (job.status !== "completed") return { order };

    const validating = await this.orders.transition(order.id, "validating", { actorType: "system" });
    const artifacts = await provider.fetchArtifacts(order.generationJobId);

    const report = validatePetGlb(artifacts.glb.data, {
      rigProfileJoints: this.deps.rigProfileJoints,
    });

    const { assetId, versionId } = await this.deps.persistVersion({
      ownerPhone: order.ownerPhone,
      assetId: order.assetId,
      glb: artifacts.glb.data,
      sha256: artifacts.glb.sha256,
      validationReport: report,
      metadata: { ...artifacts.metadata, orderUuid, versionCandidate: true },
    });

    await this.deps.getPool().query(
      `UPDATE pet_glb_orders SET asset_id = ? WHERE id = ?`,
      [assetId, validating.id],
    );

    // Automation may reach awaiting_human_review — never approved.
    //
    // Verify mode (PET_GLB_VERIFY_MODE=1): raw Tripo output does not yet carry
    // the idle/walk clips this SKU promises (they come from a later animation
    // step that is not wired in), so `operatorReady` is false and every order
    // would dead-end at `repair_required`, never reaching operator approval.
    // With the flag on, a model that at least PARSED as valid glTF is routed to
    // the operator queue instead — carrying its full, honest validation report
    // so the operator sees exactly which gates failed. The human approval gate
    // is untouched; this only lets a real sale be exercised end-to-end. Default
    // OFF keeps strict production routing.
    const verifyMode = process.env.PET_GLB_VERIFY_MODE === "1";
    const glbParsed = report.checks.some((c) => c.id === "glb_parses" && c.passed === true);
    const routeToReview = report.operatorReady || (verifyMode && glbParsed);
    const next = routeToReview ? "awaiting_human_review" : "repair_required";
    const updated = await this.orders.transition(validating.id, next, {
      actorType: "system",
      reason: report.operatorReady
        ? "validators_passed"
        : routeToReview
          ? "verify_mode_review:" + report.reasonCodes.join(",")
          : report.reasonCodes.join(","),
      jobId: order.generationJobId,
    });

    // Surface versionId so the operator knows which candidate to approve
    // (POST /operator/orders/:uuid/approve needs it) — there is no operator UI yet.
    return { order: { ...updated, assetId }, report: { ...report, fileHash: artifacts.glb.sha256, versionId } as ValidationReport & { versionId?: number } };
  }

  // ── 6. Operator approval — role-gated, one immutable version ──────────────
  async approve(orderUuid: string, actorPhone: string, versionId: number, note?: string): Promise<PetGlbOrder> {
    await this.assertOperator(actorPhone);
    const order = await this.mustFind(orderUuid);
    if (!order.finalCustomerVersionId || order.finalCustomerVersionId !== versionId) {
      throw new PetGenerationError(
        "APPROVAL_REJECTED",
        "Operator approval must bind the exact customer-approved final version",
      );
    }
    return this.orders.approve(order.id, versionId, actorPhone, note);
  }

  async requestRepair(orderUuid: string, actorPhone: string, reasonCode: string): Promise<PetGlbOrder> {
    await this.assertOperator(actorPhone);
    const order = await this.mustFind(orderUuid);
    return this.orders.transition(order.id, "repair_required", {
      actorType: "operator",
      actorId: actorPhone,
      reason: reasonCode,
    });
  }

  async operatorQueue(actorPhone: string, limit = 50): Promise<PetGlbOrderView[]> {
    await this.assertOperator(actorPhone);
    const orders = await this.orders.listByState("awaiting_human_review", limit);
    return Promise.all(orders.map((order) => this.buildView(order)));
  }

  async operatorPreview(
    orderUuid: string,
    actorPhone: string,
  ): Promise<{ url: string; versionId: number; expiresInSeconds: number }> {
    await this.assertOperator(actorPhone);
    const order = await this.mustFind(orderUuid);
    if (!order.finalCustomerVersionId) {
      throw new PetGenerationError(
        "NO_FINAL_ASSET",
        "The customer has not approved a final version",
      );
    }
    return {
      url: await this.deps.signDownload(
        order.finalCustomerVersionId,
        order.ownerPhone,
        DOWNLOAD_TTL_SECONDS,
      ),
      versionId: order.finalCustomerVersionId,
      expiresInSeconds: DOWNLOAD_TTL_SECONDS,
    };
  }

  // ── 7. Delivery — exactly once, hash-bound ────────────────────────────────
  async deliver(orderUuid: string, ownerPhone: string): Promise<{ url: string; versionId: number }> {
    const order = await this.requireOwned(orderUuid, ownerPhone);
    if (!order.approvedVersionId) {
      throw new PetGenerationError("NOT_APPROVED", "No operator-approved version for this order");
    }

    if (order.state === "approved") {
      await this.orders.transition(order.id, "delivering", { actorType: "system" });
      await this.orders.markDelivered(order.id);
    }

    const url = await this.deps.signDownload(order.approvedVersionId, ownerPhone, DOWNLOAD_TTL_SECONDS);
    return { url, versionId: order.approvedVersionId };
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private async mustFind(orderUuid: string): Promise<PetGlbOrder> {
    const order = await this.orders.findByUuid(orderUuid);
    if (!order) throw new PetGenerationError("ORDER_NOT_FOUND", `No order ${orderUuid}`);
    return order;
  }

  private async requireOwned(orderUuid: string, phone: string): Promise<PetGlbOrder> {
    const order = await this.mustFind(orderUuid);
    if (order.ownerPhone !== phone) {
      const admin = await this.deps.isAdmin(phone);
      if (!admin) throw new PetGenerationError("FORBIDDEN", "Not your order");
    }
    return order;
  }

  /**
   * Operator gate. Deliberately NOT the same as isAdmin: the existing admin
   * bypass in spatial-generator reviewJob must not silently satisfy a
   * mandatory-operator-approval requirement. If no operator predicate is
   * configured, approval is refused outright rather than falling back to admin.
   */
  private async assertOperator(phone: string): Promise<void> {
    if (!this.deps.isOperator) {
      throw new PetGenerationError(
        "OPERATOR_ROLE_UNCONFIGURED",
        "No operator role configured; refusing to fall back to admin for approval",
      );
    }
    if (!(await this.deps.isOperator(phone))) {
      throw new PetGenerationError("NOT_OPERATOR", "Operator role required");
    }
  }
}

export interface PetGlbOrderView {
  order: PetGlbOrder;
  currentStage: PetGlbStageAttempt | null;
  progress?: number;
  quote: ReturnType<typeof productQuote>;
  meshPolicy: ReturnType<typeof meshProfilePolicy>;
  facialRig: typeof FACIAL_RIG_POLICY;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
