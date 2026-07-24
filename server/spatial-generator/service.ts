import type mysql from "mysql2/promise";
import crypto from "node:crypto";
import {
  assertInhouseSpatialGeneratorEnabled,
  isInhouseSpatialGeneratorEnabled,
} from "./featureFlag";
import {
  SpatialGeneratorRepository,
} from "./repository";
import {
  SpatialJobState,
  SpatialAttemptState,
  SpatialArtifactRole,
  SpatialJobPublic,
  SpatialAttemptPublic,
  SpatialArtifactPublic,
  SpatialReviewPublic,
  SpatialEventPublic,
  SpatialQuotePublic,
  SpatialPreflightResult,
  SpatialObserveOutput,
  SpatialPlanOutput,
  SpatialMathInput,
  SpatialMathOutput,
  SpatialVerifyOutput,
  MAX_CORRECTION_ATTEMPTS,
  DEFAULT_LEASE_DURATION_MS,
  MATH_LIMITS,
} from "./types";
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
  SpatialMathOutputSchema,
  SpatialVerifyOutputSchema,
} from "./schemas";
import { getPool } from "../../db";
import { isUserAdmin } from "../../db";

export class SpatialGeneratorServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SpatialGeneratorServiceError";
  }
}

export interface SpatialGeneratorOptions {
  pool?: mysql.Pool;
  isAdmin?: (userId: string) => Promise<boolean>;
  // Layer8 clients (injected for testing)
  observeClient?: SpatialObserveClient;
  planClient?: SpatialPlanClient;
  mathExecutor?: SpatialMathExecutor;
  verifyClient?: SpatialVerifyClient;
  blenderWorker?: BlenderWorkerClient;
  // Canonical asset registry
  assetService?: any; // will be typed from assets/service
}

// ─── Layer8 Client Interfaces (for DI and testing) ────────────────────────────

export interface SpatialObserveClient {
  observe(input: { referenceAssetVersionIds: number[]; scaleAnchor: any }): Promise<SpatialObserveOutput>;
}

export interface SpatialPlanClient {
  plan(input: {
    observation: SpatialObserveOutput;
    userPrompt: string;
    targetEnvelopeMm: { x: number; y: number; z: number };
    scaleAnchor: any;
    attachmentInterface: any;
  }): Promise<SpatialPlanOutput>;
}

export interface SpatialMathExecutor {
  execute(input: SpatialMathInput): Promise<SpatialMathOutput>;
}

export interface SpatialVerifyClient {
  verify(input: {
    observation: SpatialObserveOutput;
    draftRenderAssetVersions: number[];
    attemptHash: string;
  }): Promise<SpatialVerifyOutput>;
}

export interface BlenderWorkerClient {
  buildDraft(input: {
    attemptId: number;
    plan: SpatialPlanOutput;
    math: SpatialMathOutput;
    compiledProgramHash: string;
  }): Promise<{
    draftGlbAssetVersionId: number;
    renderAssetVersionIds: number[]; // 5 views
    boundsMm: { min: [number, number, number]; max: [number, number, number] };
  }>;
  buildFinal(input: {
    attemptId: number;
    plan: SpatialPlanOutput;
    math: SpatialMathOutput;
    compiledProgramHash: string;
    targetUse: "digital" | "attachment" | "print";
  }): Promise<{
    finalGlbAssetVersionId: number;
    finalStlAssetVersionId?: number;
    manufacturingReportAssetVersionId?: number;
    boundsMm: { min: [number, number, number]; max: [number, number, number] };
  }>;
}

// ─── Deterministic Math Solver (server-side, per §2.6 amendment) ─────────────

export class DeterministicMathSolver implements SpatialMathExecutor {
  async execute(input: SpatialMathInput): Promise<SpatialMathOutput> {
    // Recompute every primitive's dimensions and positions from normalized values
    const envelope = input.envelopeMm;
    const halfEnvelope = { x: envelope.x / 2, y: envelope.y / 2, z: envelope.z / 2 };

    const resolvedPrimitives = input.primitives.map((prim) => {
      const dims = {
        x: Math.round(prim.normalizedSize.x * envelope.x * 1000) / 1000,
        y: Math.round(prim.normalizedSize.y * envelope.y * 1000) / 1000,
        z: Math.round(prim.normalizedSize.z * envelope.z * 1000) / 1000,
      };

      const pos = {
        x: Math.round(prim.normalizedPosition.x * halfEnvelope.x * 1000) / 1000,
        y: Math.round(prim.normalizedPosition.y * halfEnvelope.y * 1000) / 1000,
        z: Math.round(prim.normalizedPosition.z * halfEnvelope.z * 1000) / 1000,
      };

      const rotation = {
        x: Math.round(prim.rotationDeg.x * 1000) / 1000,
        y: Math.round(prim.rotationDeg.y * 1000) / 1000,
        z: Math.round(prim.rotationDeg.z * 1000) / 1000,
      };

      return {
        id: prim.id,
        dimensionsMm: dims,
        positionMm: pos,
        rotationDeg: rotation,
      };
    });

    // Compute derived bounds
    let boundsMin = { x: Infinity, y: Infinity, z: Infinity };
    let boundsMax = { x: -Infinity, y: -Infinity, z: -Infinity };
    let totalVolume = 0;

    for (const prim of resolvedPrimitives) {
      const halfX = prim.dimensionsMm.x / 2;
      const halfY = prim.dimensionsMm.y / 2;
      const halfZ = prim.dimensionsMm.z / 2;

      const min = {
        x: prim.positionMm.x - halfX,
        y: prim.positionMm.y - halfY,
        z: prim.positionMm.z - halfZ,
      };
      const max = {
        x: prim.positionMm.x + halfX,
        y: prim.positionMm.y + halfY,
        z: prim.positionMm.z + halfZ,
      };

      boundsMin.x = Math.min(boundsMin.x, min.x);
      boundsMin.y = Math.min(boundsMin.y, min.y);
      boundsMin.z = Math.min(boundsMin.z, min.z);
      boundsMax.x = Math.max(boundsMax.x, max.x);
      boundsMax.y = Math.max(boundsMax.y, max.y);
      boundsMax.z = Math.max(boundsMax.z, max.z);

      totalVolume += prim.dimensionsMm.x * prim.dimensionsMm.y * prim.dimensionsMm.z;
    }

    // Round bounds
    boundsMin = {
      x: Math.round(boundsMin.x * 1000) / 1000,
      y: Math.round(boundsMin.y * 1000) / 1000,
      z: Math.round(boundsMin.z * 1000) / 1000,
    };
    boundsMax = {
      x: Math.round(boundsMax.x * 1000) / 1000,
      y: Math.round(boundsMax.y * 1000) / 1000,
      z: Math.round(boundsMax.z * 1000) / 1000,
    };

    const calculations = input.primitives.map((prim) => {
      const dims = {
        x: Math.round(prim.normalizedSize.x * envelope.x * 1000) / 1000,
        y: Math.round(prim.normalizedSize.y * envelope.y * 1000) / 1000,
        z: Math.round(prim.normalizedSize.z * envelope.z * 1000) / 1000,
      };
      return `${prim.id}.x = ${prim.normalizedSize.x.toFixed(7)} * ${envelope.x} mm = ${dims.x} mm`;
    });

    return {
      schemaVersion: "pawsome.spatial-math.v1",
      planHash: input.planHash,
      units: "mm",
      resolvedPrimitives,
      derived: {
        boundsMinMm: boundsMin,
        boundsMaxMm: boundsMax,
        estimatedVolumeMm3: Math.round(totalVolume),
      },
      calculations,
    };
  }
}

// ─── Service Implementation ──────────────────────────────────────────────────

export class SpatialGeneratorService {
  private readonly repo: SpatialGeneratorRepository;
  private readonly pool: mysql.Pool;
  private readonly isAdmin: (userId: string) => Promise<boolean>;
  private readonly observeClient: SpatialObserveClient;
  private readonly planClient: SpatialPlanClient;
  private readonly mathExecutor: SpatialMathExecutor;
  private readonly verifyClient: SpatialVerifyClient;
  private readonly blenderWorker: BlenderWorkerClient;

  constructor(options: SpatialGeneratorOptions = {}) {
    this.pool = options.pool || getPool();
    this.repo = new SpatialGeneratorRepository(this.pool);
    this.isAdmin = options.isAdmin || isUserAdmin;

    // Use injected clients or create default ones (to be implemented)
    this.observeClient = options.observeClient || this.createDefaultObserveClient();
    this.planClient = options.planClient || this.createDefaultPlanClient();
    this.mathExecutor = options.mathExecutor || new DeterministicMathSolver();
    this.verifyClient = options.verifyClient || this.createDefaultVerifyClient();
    this.blenderWorker = options.blenderWorker || this.createDefaultBlenderWorker();
  }

  // Default client factories (throw if not configured - to be implemented in Phase 2+)
  private createDefaultObserveClient(): SpatialObserveClient {
    return {
      observe: async () => {
        throw new SpatialGeneratorServiceError(
          "NOT_CONFIGURED",
          "Spatial observe client not configured. Requires Layer8 spatial.observe.v1 integration.",
        );
      },
    };
  }

  private createDefaultPlanClient(): SpatialPlanClient {
    return {
      plan: async () => {
        throw new SpatialGeneratorServiceError(
          "NOT_CONFIGURED",
          "Spatial plan client not configured. Requires Layer8 spatial.plan.v1 integration.",
        );
      },
    };
  }

  private createDefaultVerifyClient(): SpatialVerifyClient {
    return {
      verify: async () => {
        throw new SpatialGeneratorServiceError(
          "NOT_CONFIGURED",
          "Spatial verify client not configured. Requires Layer8 spatial.verify.v1 integration.",
        );
      },
    };
  }

  private createDefaultBlenderWorker(): BlenderWorkerClient {
    return {
      buildDraft: async () => {
        throw new SpatialGeneratorServiceError(
          "NOT_CONFIGURED",
          "Blender worker not configured. Requires authenticated Render worker integration.",
        );
      },
      buildFinal: async () => {
        throw new SpatialGeneratorServiceError(
          "NOT_CONFIGURED",
          "Blender worker not configured. Requires authenticated Render worker integration.",
        );
      },
    };
  }

  // ─── Quote / Preflight ─────────────────────────────────────────────────────

  async getQuote(ownerPhone: string, input: QuoteSpatialJobInput): Promise<SpatialQuotePublic> {
    assertInhouseSpatialGeneratorEnabled();

    const preflight = await this.preflight(ownerPhone, input);
    const currentBalance = await this.getCreditBalance(ownerPhone);

    return {
      subjectKind: input.subjectKind,
      targetUse: input.targetUse,
      estimatedCredits: preflight.quotedCredits,
      currentBalance,
      sufficientBalance: currentBalance >= preflight.quotedCredits,
      preflightPassed: preflight.passed,
      preflightErrors: preflight.errors,
    };
  }

  async preflight(ownerPhone: string, input: QuoteSpatialJobInput): Promise<SpatialPreflightResult> {
    const errors: string[] = [];

    // Validate envelope dimensions
    if (input.targetEnvelopeMm.x > 5000 || input.targetEnvelopeMm.y > 5000 || input.targetEnvelopeMm.z > 5000) {
      errors.push("Envelope dimensions exceed 5000 mm limit");
    }

    // Validate reference assets exist and are owned
    if (input.referenceAssetVersionIds.length > 0) {
      const valid = await this.validateReferenceAssets(ownerPhone, input.referenceAssetVersionIds);
      if (!valid) errors.push("One or more reference assets not found or not owned");
    }

    // Scale anchor required when references present
    if (input.referenceAssetVersionIds.length > 0 && !input.scaleAnchor) {
      errors.push("Scale anchor is required when reference images are provided");
    }

    // Attachment interface required for attachment use
    if (input.targetUse === "attachment" && !input.attachment) {
      errors.push("Attachment interface required for attachment use");
    }

    // Calculate credits (simplified - will be refined)
    const baseCredits = 50;
    const viewMultiplier = Math.max(1, input.referenceAssetVersionIds.length);
    const quotedCredits = baseCredits * viewMultiplier;

    return {
      passed: errors.length === 0,
      errors,
      quotedCredits,
      pricingKey: `spatial_${input.subjectKind}_${input.targetUse}`,
      currentBalance: await this.getCreditBalance(ownerPhone),
    };
  }

  private async validateReferenceAssets(ownerPhone: string, assetVersionIds: number[]): Promise<boolean> {
    // Use canonical asset registry to verify ownership
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) as count FROM asset_versions av
       JOIN assets a ON a.id = av.asset_id
       WHERE av.id IN (${assetVersionIds.map(() => "?").join(",")}) AND a.owner_id = ?`,
      [...assetVersionIds, ownerPhone],
    );
    return (rows as any[])[0]?.count === assetVersionIds.length;
  }

  private async getCreditBalance(ownerPhone: string): Promise<number> {
    const [rows] = await this.pool.query(
      "SELECT credits FROM users WHERE phone = ?",
      [ownerPhone],
    );
    return (rows as any[])[0]?.credits || 0;
  }

  // ─── Job Lifecycle ─────────────────────────────────────────────────────────

  async startJob(ownerPhone: string, input: CreateSpatialJobInput): Promise<SpatialJobPublic> {
    assertInhouseSpatialGeneratorEnabled();

    const preflight = await this.preflight(ownerPhone, {
      subjectKind: input.subjectKind,
      targetUse: input.targetUse,
      targetEnvelopeMm: input.targetEnvelopeMm,
      referenceAssetVersionIds: input.referenceAssetVersionIds,
      scaleAnchor: input.scaleAnchor,
      attachment: input.attachment,
    });

    if (!preflight.passed) {
      throw new SpatialGeneratorServiceError("PREFLIGHT_FAILED", preflight.errors.join("; "));
    }

    const currentBalance = await this.getCreditBalance(ownerPhone);
    if (currentBalance < preflight.quotedCredits) {
      throw new SpatialGeneratorServiceError("INSUFFICIENT_CREDITS", "Insufficient credits for this job");
    }

    // Check idempotency
    const existing = await this.repo.getJobByOwnerAndIdempotency(
      await this.pool.getConnection(),
      ownerPhone,
      input.idempotencyKey,
    );
    if (existing) {
      return this.toJobPublic(existing);
    }

    const jobUuid = crypto.randomUUID();
    const inputHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const jobId = await this.repo.createJob(conn, {
        jobUuid,
        ownerPhone,
        subjectKind: input.subjectKind,
        targetUse: input.targetUse,
        idempotencyKey: input.idempotencyKey,
        creditsReserved: preflight.quotedCredits,
      });

      await this.repo.createJobInputs(conn, {
        jobId,
        prompt: input.prompt,
        targetEnvelopeMm: input.targetEnvelopeMm,
        scaleAnchor: input.scaleAnchor,
        attachmentInterface: input.attachment,
        referenceAssetVersionIds: input.referenceAssetVersionIds,
        inputHash,
      });

      // Reserve credits
      await conn.query(
        "UPDATE users SET credits = credits - ? WHERE phone = ?",
        [preflight.quotedCredits, ownerPhone],
      );

      await this.repo.logEvent(conn, {
        jobId,
        attemptId: null,
        eventType: "job_created",
        payload: { jobUuid, subjectKind: input.subjectKind, targetUse: input.targetUse, creditsReserved: preflight.quotedCredits },
      });

      await conn.commit();

      return this.getJobDetail(ownerPhone, jobUuid);
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async getJobDetail(ownerPhone: string, jobUuid: string): Promise<SpatialJobPublic> {
    const conn = await this.pool.getConnection();
    try {
      const job = await this.repo.getJobByUuid(conn, jobUuid);
      if (!job) {
        throw new SpatialGeneratorServiceError("NOT_FOUND", "Job not found");
      }
      if (job.owner_phone !== ownerPhone) {
        const isAdmin = await this.isAdmin(ownerPhone);
        if (!isAdmin) throw new SpatialGeneratorServiceError("FORBIDDEN", "Not authorized");
      }
      return this.toJobPublic(job);
    } finally {
      conn.release();
    }
  }

  async listJobs(ownerPhone: string, limit = 50, offset = 0): Promise<SpatialJobPublic[]> {
    const conn = await this.pool.getConnection();
    try {
      const jobs = await this.repo.listJobsByOwner(conn, ownerPhone, limit, offset);
      return jobs.map((j) => this.toJobPublic(j));
    } finally {
      conn.release();
    }
  }

  async retryJob(ownerPhone: string, jobUuid: string, input: RetrySpatialJobInput): Promise<SpatialJobPublic> {
    assertInhouseSpatialGeneratorEnabled();

    const conn = await this.pool.getConnection();
    try {
      const job = await this.repo.getJobByUuid(conn, jobUuid);
      if (!job) throw new SpatialGeneratorServiceError("NOT_FOUND", "Job not found");
      if (job.owner_phone !== ownerPhone) {
        const isAdmin = await this.isAdmin(ownerPhone);
        if (!isAdmin) throw new SpatialGeneratorServiceError("FORBIDDEN", "Not authorized");
      }

      // Check if job is in a retryable state
      if (job.state !== "awaiting_human_review" && job.state !== "correction_requested") {
        throw new SpatialGeneratorServiceError("INVALID_STATE", "Job cannot be retried from current state");
      }

      // Check attempt count
      const attempts = await this.repo.listAttemptsByJob(conn, job.id);
      if (attempts.length >= MAX_CORRECTION_ATTEMPTS + 1) {
        throw new SpatialGeneratorServiceError("MAX_RETRIES_EXCEEDED", "Maximum correction attempts exceeded");
      }

      await conn.beginTransaction();

      // Create new attempt
      const nextAttemptNumber = attempts.length + 1;
      const idempotencyKey = crypto.randomUUID();
      const attemptId = await this.repo.createAttempt(conn, {
        jobId: job.id,
        attemptNumber: nextAttemptNumber,
        idempotencyKey,
      });

      // Update job state
      await this.repo.updateJobState(conn, job.id, "correction_requested", {
        currentAttemptId: attemptId,
      });

      // Log event
      await this.repo.logEvent(conn, {
        jobId: job.id,
        attemptId,
        eventType: "correction_requested",
        payload: { attemptNumber: nextAttemptNumber, correctionTags: input.correctionTags, comment: input.correctionComment },
      });

      await conn.commit();

      return this.getJobDetail(ownerPhone, jobUuid);
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async cancelJob(ownerPhone: string, jobUuid: string, reason?: string): Promise<SpatialJobPublic> {
    const conn = await this.pool.getConnection();
    try {
      const job = await this.repo.getJobByUuid(conn, jobUuid);
      if (!job) throw new SpatialGeneratorServiceError("NOT_FOUND", "Job not found");
      if (job.owner_phone !== ownerPhone) {
        const isAdmin = await this.isAdmin(ownerPhone);
        if (!isAdmin) throw new SpatialGeneratorServiceError("FORBIDDEN", "Not authorized");
      }

      // Can only cancel before finalization
      if (["completed", "failed", "cancelled"].includes(job.state)) {
        throw new SpatialGeneratorServiceError("INVALID_STATE", "Job cannot be cancelled");
      }

      await conn.beginTransaction();

      // Release credits if still reserved
      if (job.credits_disposition === "reserved") {
        await conn.query("UPDATE users SET credits = credits + ? WHERE phone = ?", [job.credits_reserved, ownerPhone]);
        await this.repo.refundCredits(conn, job.id);
      }

      // Release any active lease
      const currentAttempt = await this.repo.getCurrentAttempt(conn, job.id);
      if (currentAttempt) {
        await this.repo.releaseLease(conn, currentAttempt.id, currentAttempt.lease_owner || "");
      }

      await this.repo.updateJobState(conn, job.id, "cancelled");

      await this.repo.logEvent(conn, {
        jobId: job.id,
        attemptId: currentAttempt?.id || null,
        eventType: "job_cancelled",
        payload: { jobUuid },
      });

      await conn.commit();

      return this.getJobDetail(ownerPhone, jobUuid);
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async reviewJob(ownerPhone: string, jobUuid: string, input: ReviewSpatialJobInput): Promise<SpatialJobPublic> {
    assertInhouseSpatialGeneratorEnabled();

    const conn = await this.pool.getConnection();
    try {
      const job = await this.repo.getJobByUuid(conn, jobUuid);
      if (!job) throw new SpatialGeneratorServiceError("NOT_FOUND", "Job not found");
      if (job.owner_phone !== ownerPhone) {
        const isAdmin = await this.isAdmin(ownerPhone);
        if (!isAdmin) throw new SpatialGeneratorServiceError("FORBIDDEN", "Not authorized");
      }

      // Verify job is in awaiting_human_review state
      if (job.state !== "awaiting_human_review") {
        throw new SpatialGeneratorServiceError("INVALID_STATE", "Job is not awaiting review");
      }

      const currentAttempt = await this.repo.getCurrentAttempt(conn, job.id);
      if (!currentAttempt) throw new SpatialGeneratorServiceError("NOT_FOUND", "No current attempt");

      // Verify attempt hash matches
      const attemptHash = this.computeAttemptHash(currentAttempt);
      if (attemptHash !== input.attemptHash) {
        throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Attempt hash does not match current attempt");
      }

      // Verify report hash matches
      if (currentAttempt.automated_report_hash !== input.reportHash) {
        throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Report hash does not match current report");
      }

      // Check automated pass
      if (!currentAttempt.automated_report_json) {
        throw new SpatialGeneratorServiceError("INVALID_STATE", "No automated report available");
      }
      const automatedReport = currentAttempt.automated_report_json as SpatialVerifyOutput;
      if (!automatedReport.automatedPass) {
        throw new SpatialGeneratorServiceError("AUTOMATED_REVIEW_FAILED", "Automated review did not pass");
      }

      await conn.beginTransaction();

      // Create review record
      const actorAuditHash = crypto.createHash("sha256").update(`${ownerPhone}:${Date.now()}`).digest("hex");
      await this.repo.createReview(conn, {
        jobId: job.id,
        attemptId: currentAttempt.id,
        attemptHash,
        reportHash: input.reportHash,
        ownerPhone,
        decision: input.decision,
        correctionTags: input.correctionTags,
        comment: input.comment,
        actorAuditHash,
      });

      if (input.decision === "approve") {
        // Move to finalizing
        await this.repo.updateJobState(conn, job.id, "finalizing");
        await this.repo.logEvent(conn, {
          jobId: job.id,
          attemptId: currentAttempt.id,
          eventType: "approved",
          payload: { attemptNumber: currentAttempt.attempt_number },
        });

        // Trigger final build (async - will be picked up by worker)
        // For now, just log the event
      } else {
        // Request correction - check if we can create another attempt
        const attempts = await this.repo.listAttemptsByJob(conn, job.id);
        if (attempts.length >= MAX_CORRECTION_ATTEMPTS + 1) {
          throw new SpatialGeneratorServiceError("MAX_RETRIES_EXCEEDED", "Maximum correction attempts exceeded");
        }

        await this.repo.updateJobState(conn, job.id, "correction_requested");
        await this.repo.logEvent(conn, {
          jobId: job.id,
          attemptId: currentAttempt.id,
          eventType: "correction_requested",
          payload: { correctionTags: input.correctionTags, comment: input.comment },
        });
      }

      await conn.commit();

      return this.getJobDetail(ownerPhone, jobUuid);
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  // ─── Internal Pipeline Operations (called by workers) ──────────────────────

  async observeAndPlan(jobId: number): Promise<void> {
    // This will be called by a background worker
    // Phase 2 implementation
  }

  async executeMath(attemptId: number): Promise<void> {
    // This will be called by a background worker
    // Phase 2 implementation
  }

  async buildDraft(attemptId: number): Promise<void> {
    // This will be called by a background worker
    // Phase 3 implementation
  }

  async verifyDraft(attemptId: number): Promise<void> {
    // This will be called by a background worker
    // Phase 4 implementation
  }

  async finalizeJob(jobId: number): Promise<void> {
    // This will be called after approval
    // Phase 5 implementation
  }

  // ─── Recovery / Reconciliation ─────────────────────────────────────────────

  async recoverStaleJobs(): Promise<{ recovered: number; failed: number }> {
    const conn = await this.pool.getConnection();
    try {
      const staleAttempts = await this.repo.findStaleLeases(conn);
      let recovered = 0;
      let failed = 0;

      for (const attempt of staleAttempts) {
        try {
          await conn.beginTransaction();
          await this.repo.releaseLease(conn, attempt.id, attempt.lease_owner!);
          await this.repo.updateAttemptState(conn, attempt.id, "queued", {
            failureCode: "LEASE_EXPIRED",
            errorMessage: "Lease expired, re-queued for retry",
          });
          await this.repo.logEvent(conn, {
            jobId: attempt.job_id,
            attemptId: attempt.id,
            eventType: "lease_expired",
            payload: { attemptNumber: attempt.attempt_number },
          });
          await conn.commit();
          recovered++;
        } catch {
          await conn.rollback();
          failed++;
        }
      }

      return { recovered, failed };
    } finally {
      conn.release();
    }
  }

  // ─── Health ──────────────────────────────────────────────────────────────────

  async getHealthStatus(): Promise<{
    featureEnabled: boolean;
    layer8Configured: boolean;
    pixelWorkerOnline: boolean;
    blenderWorkerHealthy: boolean;
    activeJobs: number;
    queuedAttempts: number;
  }> {
    const conn = await this.pool.getConnection();
    try {
      const featureEnabled = isInhouseSpatialGeneratorEnabled();
      
      // Check Layer8 config
      const layer8Configured = !!(process.env.LAYER8_BASE_URL && process.env.LAYER8_TENANT_API_KEY);
      
      // Count active jobs
      const [activeRows] = await conn.query(
        "SELECT COUNT(*) as count FROM spatial_generation_jobs WHERE state NOT IN ('completed', 'failed', 'cancelled')",
      );
      const activeJobs = (activeRows as any[])[0]?.count || 0;
      
      // Count queued attempts
      const [queuedRows] = await conn.query(
        "SELECT COUNT(*) as count FROM spatial_generation_attempts WHERE state IN ('queued', 'observing', 'planning', 'awaiting_math', 'validating_math')",
      );
      const queuedAttempts = (queuedRows as any[])[0]?.count || 0;

      return {
        featureEnabled,
        layer8Configured,
        pixelWorkerOnline: false, // Will be implemented in Phase 1
        blenderWorkerHealthy: false, // Will be implemented in Phase 3
        activeJobs,
        queuedAttempts,
      };
    } finally {
      conn.release();
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private computeAttemptHash(attempt: any): string {
    const payload = {
      observationHash: attempt.observation_hash,
      planHash: attempt.plan_hash,
      mathHash: attempt.math_hash,
      compiledProgramHash: attempt.compiled_program_hash,
      automatedReportHash: attempt.automated_report_hash,
    };
    return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  private toJobPublic(job: any): SpatialJobPublic {
    return {
      jobUuid: job.job_uuid,
      ownerPhone: job.owner_phone,
      subjectKind: job.subject_kind,
      targetUse: job.target_use,
      state: job.state,
      currentAttemptNumber: job.current_attempt_id ? 1 : null, // Will be populated from attempt
      creditsReserved: job.credits_reserved,
      creditsDisposition: job.credits_disposition,
      failureCode: job.failure_code,
      createdAt: job.created_at.toISOString(),
      updatedAt: job.updated_at.toISOString(),
    };
  }
}

// Export factory for router
export function createSpatialGeneratorService(options: SpatialGeneratorOptions = {}): SpatialGeneratorService {
  return new SpatialGeneratorService(options);
}