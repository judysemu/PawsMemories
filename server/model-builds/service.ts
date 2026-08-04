import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import type mysql from "mysql2/promise";
import { getPool } from "../../db";
import { CREDIT_PRICES } from "../../src/pricing";
import { registerAsset, addLineage } from "../assets/service";
import { findAssetById, findVersionById, hardDeleteUnpublishedAsset } from "../assets/repository";
import { generateSignedUrlForVersion } from "../assets/access";
import {
  findSessionByUuid as findRefSession,
  findApprovalBySessionId as findRefApproval,
  findAttemptById as findRefAttempt,
  findViewsByAttemptId as findRefViews,
  findReportByAttemptId as findRefReport,
} from "../reference-sessions/repository";
import { computeOrderedManifestHash } from "../reference-sessions/service";
import type { ViewKind } from "../reference-sessions/types";
import {
  insertJob,
  findJobByUuid,
  findJobByUuidForUpdate,
  findJobsByOwner,
  findJobBySessionAndOwner,
  updateJobState,
  insertAttempt,
  findAttemptById,
  findAttemptByIdForUpdate,
  findAttemptsByJobId,
  findAttemptByIdempotencyKey,
  updateAttemptState,
  claimLease,
  renewLease,
  releaseLease,
  insertProviderEvent,
  computeEventHash,
  insertArtifact,
  findArtifactsByAttemptId,
  findArtifactByAttemptAndRole,
  insertReport,
  findReportByAttemptId,
  insertAcceptance,
  findAcceptanceByJobId,
  findExpiredLeases,
  findStaleQueuedAttempts,
  findAmbiguousSubmissions,
  findRefundPendingJobs,
  markRefundPending,
  markRefundComplete,
  markRefundFailure,
} from "./repository";
import { storeProviderGlb, storeValidatedGlb, storeReport as storeReportJson, storeRenderArtifact, cleanupPrivateObject } from "./storage";
import { getPrivateObjectBuffer } from "../../storage.private";
import { computeAdvisoryLikeness } from "./likeness";
import { validateGlb, validatePngImage, createValidPngBuffer, VALIDATOR_VERSION } from "./validation";
import { ModelBuildProviderError, type ModelBuildProvider, type ModelBuildProviderInput } from "./provider";
import {
  canCancelBeforeSubmission,
  DurableModelBuildError,
  persistProviderHandleDurably,
  persistRecoveryRequiredDurably,
  pollProviderWithLease,
  RecoveryPersistenceUnavailableError,
  startProviderWithLease,
  type DurabilityRuntime,
} from "./durability";
import { assertModelBuildV3Enabled } from "./featureFlag";
import {
  TERMINAL_JOB_STATES,
  MAX_BUILD_CORRECTION_ATTEMPTS,
  DEFAULT_LEASE_DURATION_MS,
  type BuildJobRecord,
  type BuildAttemptRecord,
  type BuildJobState,
  type BuildJobPublic,
  type BuildAttemptPublic,
  type BuildArtifactPublic,
  type PostBuildReportPublic,
  type BuildQuotePublic,
  type PreflightResult,
  type ArtifactRole,
} from "./types";
import type { StartBuildInput, RetryBuildInput, AcceptBuildInput } from "./schemas";

export class ModelBuildServiceError extends Error {
  constructor(message: string, public code: string = "MODEL_BUILD_ERROR") {
    super(message);
    this.name = "ModelBuildServiceError";
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export class ModelBuildService {
  constructor(
    private provider: ModelBuildProvider,
    private getPoolFn: () => mysql.Pool = getPool,
    private durabilityRuntime: Partial<DurabilityRuntime> = {},
  ) {}

  // ── Preflight & Quote ───────────────────────────────────────────────────

  async preflight(ownerId: string, sessionUuid: string): Promise<PreflightResult> {
    assertModelBuildV3Enabled();
    const pool = this.getPoolFn();
    const errors: string[] = [];

    // 1. Load reference session
    const session = await findRefSession(pool, sessionUuid);
    if (!session) {
      return { passed: false, errors: ["Reference session not found"], sessionId: 0, attemptId: 0, manifestAssetId: 0, manifestAssetVersionId: 0, manifestHash: "", quotedCredits: 0, pricingKey: "", currentBalance: 0 };
    }

    // 2. Verify ownership
    if (session.owner_id !== ownerId) {
      return { passed: false, errors: ["Not authorized for this reference session"], sessionId: 0, attemptId: 0, manifestAssetId: 0, manifestAssetVersionId: 0, manifestHash: "", quotedCredits: 0, pricingKey: "", currentBalance: 0 };
    }

    // 3. Check approval exists
    if (session.state !== "approved") {
      errors.push(`Reference session state is '${session.state}', not 'approved'`);
    }

    const approval = await findRefApproval(pool, session.id);
    if (!approval) {
      errors.push("No approval found for this reference session");
      return { passed: false, errors, sessionId: session.id, attemptId: 0, manifestAssetId: 0, manifestAssetVersionId: 0, manifestHash: "", quotedCredits: 0, pricingKey: "", currentBalance: 0 };
    }

    // 4. Verify approved attempt
    const attempt = await findRefAttempt(pool, approval.attempt_id);
    if (!attempt) {
      errors.push("Approved attempt not found");
      return { passed: false, errors, sessionId: session.id, attemptId: 0, manifestAssetId: 0, manifestAssetVersionId: 0, manifestHash: "", quotedCredits: 0, pricingKey: "", currentBalance: 0 };
    }
    if (attempt.session_id !== session.id || session.approved_attempt_id !== attempt.id) {
      errors.push("Approved attempt does not belong to this approved session");
    }

    // 5. Verify manifest asset exists with versions
    if (!approval.manifest_asset_id || !approval.manifest_asset_version_id) {
      errors.push("Manifest asset not registered in approval");
    } else {
      const manifestAsset = await findAssetById(pool, approval.manifest_asset_id);
      if (!manifestAsset) errors.push("Manifest asset not found in canonical registry");
      else if (manifestAsset.owner_id !== ownerId || manifestAsset.status !== "active") errors.push("Manifest asset owner or status is invalid");
      const manifestVersion = await findVersionById(pool, approval.manifest_asset_version_id);
      if (!manifestVersion) errors.push("Manifest asset version not found");
      else {
        if (manifestVersion.asset_id !== approval.manifest_asset_id) errors.push("Manifest version belongs to another asset");
        if (manifestVersion.metadata?.manifestHash !== approval.manifest_hash) errors.push("Manifest metadata hash does not match approval");
      }
    }

    // 6. Verify Tripo's four canonical views
    const views = await findRefViews(pool, attempt.id);
    const requiredKinds = ["front", "left", "right", "rear"];
    const viewManifestItems: { viewKind: ViewKind; assetUuid: string; sha256: string }[] = [];
    if (requiredKinds.some((kind) => !views.some((view) => view.view_kind === kind))) {
      errors.push("Approved attempt must contain front, left, right, and rear views");
    }
    for (const kind of requiredKinds) {
      const view = views.find(v => v.view_kind === kind);
      if (!view) {
        errors.push(`Missing required view: ${kind}`);
      } else {
        // Verify asset/version exists
        const asset = await findAssetById(pool, view.asset_id);
        if (!asset) errors.push(`View ${kind}: asset not found`);
        else if (asset.owner_id !== ownerId || asset.status !== "active") errors.push(`View ${kind}: owner or status is invalid`);
        const version = await findVersionById(pool, view.asset_version_id);
        if (!version) errors.push(`View ${kind}: version not found`);
        else if (version.asset_id !== view.asset_id) errors.push(`View ${kind}: version belongs to another asset`);
        if (view.width_px < 1024 || view.height_px < 1024) errors.push(`View ${kind}: decoded dimensions are below 1024x1024`);
        if (asset && version) viewManifestItems.push({ viewKind: kind as ViewKind, assetUuid: asset.asset_uuid, sha256: version.sha256 });
      }
    }

    // 7. Verify report
    const report = await findRefReport(pool, attempt.id);
    if (!report) {
      errors.push("Reference report not found for approved attempt");
    } else if (report.status === "fail") {
      errors.push("Reference report has status 'fail'");
    } else {
      const reportAsset = report.report_asset_id ? await findAssetById(pool, report.report_asset_id) : null;
      const reportVersion = report.report_asset_version_id ? await findVersionById(pool, report.report_asset_version_id) : null;
      if (!reportAsset || !reportVersion || reportAsset.owner_id !== ownerId || reportVersion.asset_id !== reportAsset.id || reportVersion.sha256 !== report.report_hash) {
        errors.push("Reference report canonical identity is invalid");
      }
      if (viewManifestItems.length === 4) {
        try {
          if (computeOrderedManifestHash(viewManifestItems, report.report_hash) !== approval.manifest_hash) {
            errors.push("Approved manifest hash no longer matches its views and report");
          }
        } catch {
          errors.push("Approved manifest cannot be recomputed");
        }
      }
    }

    // 8. Pricing
    const pricingKey = "STATIC_3D_PHOTO";
    const quotedCredits = CREDIT_PRICES.STATIC_3D_PHOTO;

    // 9. Balance check
    const [userRows]: any = await pool.query("SELECT credits FROM users WHERE phone = ?", [ownerId]);
    const currentBalance = userRows[0] ? Number(userRows[0].credits || 0) : 0;
    if (currentBalance < quotedCredits) {
      errors.push(`Insufficient credit balance: ${currentBalance} < ${quotedCredits}`);
    }

    return {
      passed: errors.length === 0,
      errors,
      sessionId: session.id,
      attemptId: attempt.id,
      manifestAssetId: approval.manifest_asset_id || 0,
      manifestAssetVersionId: approval.manifest_asset_version_id || 0,
      manifestHash: approval.manifest_hash,
      quotedCredits,
      pricingKey,
      currentBalance,
    };
  }

  async getQuote(ownerId: string, sessionUuid: string): Promise<BuildQuotePublic> {
    const pf = await this.preflight(ownerId, sessionUuid);
    return {
      referenceSessionUuid: sessionUuid,
      manifestHashPrefix: pf.manifestHash.slice(0, 12),
      pricingKey: pf.pricingKey,
      quotedCredits: pf.quotedCredits,
      currentBalance: pf.currentBalance,
      sufficientBalance: pf.currentBalance >= pf.quotedCredits,
      preflightPassed: pf.passed,
      preflightErrors: pf.errors,
    };
  }

  // ── Start Build ─────────────────────────────────────────────────────────

  async startBuild(ownerId: string, input: StartBuildInput): Promise<BuildJobPublic> {
    assertModelBuildV3Enabled();
    const pool = this.getPoolFn();

    // 1. Run preflight
    const pf = await this.preflight(ownerId, input.referenceSessionUuid);
    if (!pf.passed) {
      throw new ModelBuildServiceError(
        `Preflight failed: ${pf.errors.join("; ")}`,
        "PREFLIGHT_FAILED",
      );
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // 2. Check idempotency — duplicate start returns existing job
      const existingAttempt = await findAttemptByIdempotencyKey(connection, input.idempotencyKey);
      if (existingAttempt) {
        const [rows] = await connection.query(
          "SELECT job_uuid FROM model_build_jobs WHERE id = ?",
          [existingAttempt.job_id],
        ) as any;
        await connection.commit();
        if (rows[0]) {
          return this.getJobPublic(ownerId, rows[0].job_uuid);
        }
      }

      // 3. Check for existing active job on this session
      const existingJob = await findJobBySessionAndOwner(connection, pf.sessionId, ownerId);
      if (existingJob && !TERMINAL_JOB_STATES.includes(existingJob.state as any)) {
        await connection.commit();
        return this.formatJobPublicHydrated(pool, existingJob);
      }

      // 4. Create job
      const jobUuid = uuidv4();
      const creditCorrelationId = `model_build:${jobUuid}`;

      const job = await insertJob(connection, {
        jobUuid,
        ownerId,
        referenceSessionId: pf.sessionId,
        referenceAttemptId: pf.attemptId,
        manifestAssetId: pf.manifestAssetId,
        manifestAssetVersionId: pf.manifestAssetVersionId,
        manifestHash: pf.manifestHash,
        requestedOutput: input.requestedOutput || "glb",
        pricingKey: pf.pricingKey,
        quotedCredits: pf.quotedCredits,
        state: "reserving",
      });

      // 5. Create the attempt before charging so the ledger can bind to it.
      const inputConfigHash = crypto.createHash("sha256")
        .update(`${pf.manifestHash}:${input.requestedOutput || "glb"}`)
        .digest("hex");

      const attempt = await insertAttempt(connection, {
        jobId: job.id,
        attemptNumber: 1,
        idempotencyKey: input.idempotencyKey,
        provider: "tripo",
        model: process.env.TRIPO_MODEL_VERSION || "default",
        inputConfigHash,
      });

      const debited = await this.chargeCredits(connection, job.id, attempt.id, ownerId, pf.quotedCredits, creditCorrelationId);
      if (!debited) throw new ModelBuildServiceError("Insufficient credits", "INSUFFICIENT_CREDITS");

      await updateJobState(connection, job.id, "queued", {
        currentAttemptId: attempt.id,
        creditCorrelationId,
        refundCorrelationId: null,
        failureCode: null,
      });

      await connection.commit();

      // 7. Launch background processing (fire and forget)
      this.processAttempt(ownerId, jobUuid, attempt.id).catch((err) => {
        console.error(`[model-build] Background processing error for job ${jobUuid}:`, err.message);
      });

      const updatedJob = await findJobByUuid(pool, jobUuid);
      return this.formatJobPublicHydrated(pool, updatedJob!);
    } catch (err: any) {
      await connection.rollback();
      if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062) {
        const existing = await findJobBySessionAndOwner(pool, pf.sessionId, ownerId);
        if (existing) return this.formatJobPublicHydrated(pool, existing);
      }
      if (err instanceof ModelBuildServiceError) throw err;
      throw new ModelBuildServiceError(`Build start failed: ${err.message}`, "START_FAILED");
    } finally {
      connection.release();
    }
  }

  // ── Background Processing ─────────────────────────────────────────────

  /**
   * MG-7: processAttempt is invoked fire-and-forget, and its callers only
   * `.catch` and log. Connection acquisition used to sit OUTSIDE the try, so a
   * pool-exhaustion throw from getConnection()/beginTransaction() escaped
   * before any lease was claimed and left the attempt in `queued` with no
   * lease and no worker — invisible to findExpiredLeases and therefore
   * unrecoverable. Everything now runs inside a guard, and stale `queued`
   * attempts are picked up by the recurring recovery sweep (see MG-1).
   */
  async processAttempt(ownerId: string, jobUuid: string, attemptId: number): Promise<void> {
    try {
      await this.processAttemptGuarded(ownerId, jobUuid, attemptId);
    } catch (error: any) {
      console.error(
        `[model-build] processAttempt failed before/outside lease ownership for job ${jobUuid} attempt ${attemptId}:`,
        error?.message || error,
      );
    }
  }

  private async processAttemptGuarded(ownerId: string, jobUuid: string, attemptId: number): Promise<void> {
    const pool = this.getPoolFn();
    const leaseOwner = `worker-${process.pid}-${Date.now()}`;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const job = await findJobByUuidForUpdate(connection, jobUuid);
      if (!job || job.owner_id !== ownerId || TERMINAL_JOB_STATES.includes(job.state as any) || job.state === "recovery_required") {
        await connection.commit();
        return;
      }

      const attempt = await findAttemptByIdForUpdate(connection, attemptId);
      if (!attempt || job.current_attempt_id !== attempt.id ||
          !["queued", "submitted", "processing", "downloading", "validating"].includes(attempt.state)) {
        await connection.commit();
        return;
      }

      // Lock order is always job then attempt. Cancellation uses the same order,
      // so exactly one side wins the queued -> submitted submission claim.
      const leaseExpiry = new Date(Date.now() + DEFAULT_LEASE_DURATION_MS);
      const claimed = await claimLease(connection, attemptId, leaseOwner, leaseExpiry);
      if (!claimed) {
        await connection.commit();
        return;
      }

      const isNewSubmission = attempt.state === "queued";
      const isValidationRecovery = attempt.state === "validating";
      if (isNewSubmission) {
        await updateJobState(connection, job.id, "submitted");
        await updateAttemptState(connection, attemptId, "submitted", {
          submissionClaimedAt: new Date(),
        });
      } else if (!isValidationRecovery && !attempt.provider_task_handle) {
        // A submitted attempt without a handle may have crossed the provider
        // boundary before a crash. Never refund or submit it automatically.
        await updateJobState(connection, job.id, "recovery_required", {
          failureCode: "PROVIDER_HANDLE_RECOVERY_REQUIRED",
        });
        await updateAttemptState(connection, attemptId, "recovery_required", {
          failureCode: "PROVIDER_HANDLE_RECOVERY_REQUIRED",
          errorMessage: "Provider submission requires operator recovery",
          recoveryRequiredAt: new Date(),
        });
        await connection.commit();
        return;
      }
      await connection.commit();

      if (isValidationRecovery) {
        await this.failJob(
          jobUuid,
          attemptId,
          "VALIDATION_RESTART_UNSAFE",
          "Validation was interrupted and cannot be resumed safely",
          leaseOwner,
        );
        return;
      }

      let providerTaskHandle = attempt.provider_task_handle;
      let providerName = attempt.provider;
      if (isNewSubmission) {
        const views = await findRefViews(pool, job.reference_attempt_id);
        const viewUrls: ModelBuildProviderInput = { frontUrl: "", leftUrl: "", rightUrl: "", rearUrl: "" };
        for (const view of views) {
          const asset = await findAssetById(pool, view.asset_id);
          const version = await findVersionById(pool, view.asset_version_id);
          if (!asset || !version) continue;
          const url = await generateSignedUrlForVersion(asset, version, ownerId, true);
          if (!url) continue;
          if (view.view_kind === "front") viewUrls.frontUrl = url;
          else if (view.view_kind === "left") viewUrls.leftUrl = url;
          else if (view.view_kind === "right") viewUrls.rightUrl = url;
          else if (view.view_kind === "rear") viewUrls.rearUrl = url;
          else if (view.view_kind === "front_three_quarter") viewUrls.threeQuarterUrl = url;
        }
        if ([viewUrls.frontUrl, viewUrls.leftUrl, viewUrls.rightUrl, viewUrls.rearUrl].some((url) => !url)) {
          await this.failJob(jobUuid, attemptId, "REFERENCE_URL_FAILED", "All four approved reference URLs are required", leaseOwner);
          return;
        }
        try {
          const providerResult = await startProviderWithLease(
            this.provider,
            viewUrls,
            attempt.input_config_hash,
            () => this.renewOwnedLease(
              pool,
              jobUuid,
              attemptId,
              leaseOwner,
              ["submitted"],
              ["submitted"],
            ),
            this.durabilityRuntime,
          );
          providerTaskHandle = providerResult.providerTaskHandle;
          providerName = providerResult.provider;
          if (!providerTaskHandle) {
            throw new ModelBuildProviderError(
              "Provider submission outcome is unknown because no task handle was returned",
              "PROVIDER_SUBMISSION_AMBIGUOUS",
              false,
              "ambiguous_acceptance",
            );
          }

          const persistenceResult = await persistProviderHandleDurably(
            async (persistenceAttempt) => {
              const conn2 = await pool.getConnection();
              try {
                await conn2.beginTransaction();
                const current = await this.lockCurrentAttempt(
                  conn2, jobUuid, attemptId, leaseOwner, true,
                  ["submitted"], ["submitted"],
                );
                if (!current) {
                  throw new DurableModelBuildError("Submission attempt is no longer current", "ATTEMPT_REPLACED");
                }
                await updateAttemptState(conn2, attemptId, "submitted", {
                  providerTaskHandle,
                  handlePersistAttempts: persistenceAttempt,
                });
                await conn2.commit();
              } catch (error) {
                await conn2.rollback().catch(() => {});
                throw error;
              } finally {
                conn2.release();
              }
            },
            async (persistenceAttempt) => {
              const conn2 = await pool.getConnection();
              try {
                await conn2.beginTransaction();
                const current = await this.lockCurrentAttempt(
                  conn2, jobUuid, attemptId, leaseOwner, false,
                  ["submitted", "recovery_required"], ["submitted", "recovery_required"],
                );
                if (!current) {
                  throw new DurableModelBuildError("Submission attempt is no longer current", "ATTEMPT_REPLACED");
                }
                await updateJobState(conn2, current.job.id, "recovery_required", {
                  failureCode: "PROVIDER_HANDLE_PERSISTENCE_AMBIGUOUS",
                });
                await updateAttemptState(conn2, attemptId, "recovery_required", {
                  providerTaskHandle,
                  failureCode: "PROVIDER_HANDLE_PERSISTENCE_AMBIGUOUS",
                  errorMessage: "Provider accepted submission but its handle was not durably bound",
                  recoveryRequiredAt: new Date(),
                  handlePersistAttempts: persistenceAttempt + 3,
                });
                await conn2.commit();
              } catch (error) {
                await conn2.rollback().catch(() => {});
                throw error;
              } finally {
                conn2.release();
              }
            },
            this.durabilityRuntime,
          );

          if (persistenceResult === "recovery_required") return;
        } catch (error: any) {
          if (error instanceof RecoveryPersistenceUnavailableError) throw error;
          if (error instanceof DurableModelBuildError && error.code === "LEASE_LOST") return;
          if (error instanceof ModelBuildProviderError &&
              error.submissionDisposition === "ambiguous_acceptance") {
            await persistRecoveryRequiredDurably(
              async (persistenceAttempt) => {
                const recoveryConn = await pool.getConnection();
                try {
                  await recoveryConn.beginTransaction();
                  const current = await this.lockCurrentAttempt(
                    recoveryConn,
                    jobUuid,
                    attemptId,
                    leaseOwner,
                    false,
                    ["submitted", "recovery_required"],
                    ["submitted", "recovery_required"],
                  );
                  if (!current || current.attempt.provider_task_handle) {
                    throw new DurableModelBuildError(
                      "Submission attempt is no longer an ambiguous current attempt",
                      "ATTEMPT_REPLACED",
                    );
                  }
                  await updateJobState(recoveryConn, current.job.id, "recovery_required", {
                    failureCode: "PROVIDER_SUBMISSION_AMBIGUOUS",
                  });
                  await updateAttemptState(recoveryConn, attemptId, "recovery_required", {
                    failureCode: "PROVIDER_SUBMISSION_AMBIGUOUS",
                    errorMessage: "Provider submission requires operator recovery",
                    recoveryRequiredAt: new Date(),
                    handlePersistAttempts: persistenceAttempt,
                  });
                  await recoveryConn.commit();
                } catch (recoveryError) {
                  await recoveryConn.rollback().catch(() => {});
                  throw recoveryError;
                } finally {
                  recoveryConn.release();
                }
              },
              this.durabilityRuntime,
            );
            return;
          }
          const code = error instanceof ModelBuildProviderError
            ? error.code
            : "PROVIDER_START_FAILED";
          await this.failJob(jobUuid, attemptId, code, "Provider submission failed", leaseOwner);
          return;
        }
      }

      // A submitted attempt advances to processing once. Attempts recovered
      // from processing/downloading keep their persisted handle and resume
      // polling without calling provider.start again.
      if (isNewSubmission || attempt.state === "submitted") {
        const eventHash = computeEventHash(
          providerName, attemptId, "task_created",
          providerTaskHandle!,
        );
        const conn3 = await pool.getConnection();
        try {
          await conn3.beginTransaction();
          const current = await this.lockCurrentAttempt(
            conn3, jobUuid, attemptId, leaseOwner, true,
            ["submitted"], ["submitted"],
          );
          if (!current) {
            await conn3.commit();
            return;
          }
          await insertProviderEvent(conn3, {
            provider: providerName,
            eventHash,
            attemptId,
            eventType: "task_created",
          });
          await updateJobState(conn3, current.job.id, "processing");
          await updateAttemptState(conn3, attemptId, "processing");
          await conn3.commit();
        } catch (error) {
          await conn3.rollback().catch(() => {});
          throw error;
        } finally {
          conn3.release();
        }
      }

      // Poll until done
      let pollResult;
      try {
        pollResult = await pollProviderWithLease(
          this.provider,
          providerTaskHandle!,
          () => this.renewOwnedLease(pool, jobUuid, attemptId, leaseOwner),
          this.durabilityRuntime,
        );
      } catch (error: any) {
        if (error instanceof DurableModelBuildError && error.code === "LEASE_LOST") return;
        const code = error instanceof DurableModelBuildError
          ? error.code
          : "PROVIDER_POLL_FAILED";
        await this.failJob(jobUuid, attemptId, code, "Provider polling failed", leaseOwner);
        return;
      }

      if (pollResult.error || !pollResult.glbUrl) {
        await this.failJob(
          jobUuid,
          attemptId,
          pollResult.failureCode || "PROVIDER_FAILED",
          "Provider task ended without a usable model artifact",
          leaseOwner,
        );
        return;
      }

      // Download GLB
      const transitionedToDownload = await this.transitionOwnedAttempt(
        pool, jobUuid, attemptId, leaseOwner,
        ["processing", "downloading"], ["processing", "downloading"], "downloading",
      );
      if (!transitionedToDownload) return;

      let glbBuffer: Buffer;
      try {
        glbBuffer = await this.provider.download(pollResult.glbUrl);
      } catch {
        await this.failJob(jobUuid, attemptId, "DOWNLOAD_FAILED", "Provider artifact download failed", leaseOwner);
        return;
      }

      // Store provider GLB
      let providerGlbStored;
      try {
        providerGlbStored = await storeProviderGlb(ownerId, jobUuid, attempt.attempt_number, glbBuffer);
      } catch {
        console.error(`[model-build] Provider GLB storage failed for job ${jobUuid}`);
        await this.failJob(jobUuid, attemptId, "STORAGE_FAILED", "Provider GLB storage failed", leaseOwner);
        return;
      }

      // Register provider GLB as canonical asset
      let providerGlbAsset;
      try {
        providerGlbAsset = await registerAsset({
          ownerId,
          assetType: "model_glb",
          visibility: "private",
          mimeType: "model/gltf-binary",
          sizeBytes: providerGlbStored.sizeBytes,
          sha256: providerGlbStored.sha256,
          bucket: "private",
          objectKey: providerGlbStored.objectKey,
          sourceProvider: "tripo",
          license: "proprietary",
          commercialUseEligible: false,
          metadata: { phase: 3, role: "provider_glb", jobUuid },
        }, { authorization: { internal: true }, pool });
      } catch {
        await cleanupPrivateObject(providerGlbStored.objectKey);
        await this.failJob(jobUuid, attemptId, "ASSET_REGISTRATION_FAILED", "Provider GLB asset registration failed", leaseOwner);
        return;
      }

      // Record provider GLB artifact
      const conn5 = await pool.getConnection();
      try {
        await conn5.beginTransaction();
        await insertArtifact(conn5, {
          attemptId,
          assetId: providerGlbAsset.asset.id,
          assetVersionId: providerGlbAsset.version.id,
          role: "provider_glb",
          computedHash: providerGlbStored.sha256,
          sizeBytes: providerGlbStored.sizeBytes,
          mimeType: "model/gltf-binary",
        });
        await conn5.commit();
      } catch {
        await conn5.rollback().catch(() => {});
        await cleanupPrivateObject(providerGlbStored.objectKey);
        await hardDeleteUnpublishedAsset(pool, providerGlbAsset.asset.id).catch(() => {});
        await this.failJob(jobUuid, attemptId, "ARTIFACT_PERSIST_FAILED", "Provider GLB artifact persistence failed", leaseOwner);
        return;
      } finally {
        conn5.release();
      }

      // Validate GLB
      const transitionedToValidation = await this.transitionOwnedAttempt(
        pool, jobUuid, attemptId, leaseOwner,
        ["downloading"], ["downloading"], "validating",
      );
      if (!transitionedToValidation) return;

      const validationResult = await validateGlb(glbBuffer);

      // Compute advisory likeness comparison between approved reference views and build model
      const refImageBuffers: Buffer[] = [];
      try {
        const refViews = await findRefViews(pool, job.reference_attempt_id);
        for (const rv of refViews) {
          const rVersion = await findVersionById(pool, rv.asset_version_id);
          if (rVersion && rVersion.object_key) {
            const buf = await getPrivateObjectBuffer(rVersion.object_key).catch(() => null);
            if (buf) refImageBuffers.push(buf);
          }
        }
      } catch (err: any) {
        console.warn("[model-build] Ref image loading warning:", err?.message);
      }

      const advisoryLikeness = await computeAdvisoryLikeness(glbBuffer, refImageBuffers);

      let validatedGlbStored: Awaited<ReturnType<typeof storeValidatedGlb>> | null = null;
      let validatedGlbAsset: Awaited<ReturnType<typeof registerAsset>> | null = null;
      if (validationResult.status !== "fail") {
        try {
          validatedGlbStored = await storeValidatedGlb(ownerId, jobUuid, attempt.attempt_number, glbBuffer);
          validatedGlbAsset = await registerAsset({
          ownerId,
          assetType: "model_glb",
          visibility: "private",
          mimeType: "model/gltf-binary",
          sizeBytes: validatedGlbStored.sizeBytes,
          sha256: validatedGlbStored.sha256,
          bucket: "private",
          objectKey: validatedGlbStored.objectKey,
          sourceProvider: "tripo",
          license: "proprietary",
          commercialUseEligible: false,
          metadata: {
            phase: 3,
            role: "validated_glb",
            jobUuid,
            validationStatus: validationResult.status,
            validatorVersion: VALIDATOR_VERSION,
          },
          }, { authorization: { internal: true }, pool });
        } catch (err: any) {
          if (validatedGlbStored) await cleanupPrivateObject(validatedGlbStored.objectKey);
          await this.failJob(jobUuid, attemptId, "ASSET_REGISTRATION_FAILED", err.message, leaseOwner);
          return;
        }
      }

      // Add lineage: manifest → provider GLB → validated GLB
      try {
        const manifestAsset = await findAssetById(pool, job.manifest_asset_id);
        const manifestVersion = await findVersionById(pool, job.manifest_asset_version_id);
        if (!manifestAsset || !manifestVersion) throw new Error("Canonical manifest disappeared during build");
        await addLineage({
          parentAssetUuid: manifestAsset.asset_uuid,
          parentVersionNumber: manifestVersion.version_number,
          childAssetUuid: providerGlbAsset.asset.asset_uuid,
          childVersionNumber: providerGlbAsset.version.version_number,
          relationType: "mesh",
        }, { internal: true }, pool);

        if (validatedGlbAsset) await addLineage({
          parentAssetUuid: providerGlbAsset.asset.asset_uuid,
          parentVersionNumber: providerGlbAsset.version.version_number,
          childAssetUuid: validatedGlbAsset.asset.asset_uuid,
          childVersionNumber: validatedGlbAsset.version.version_number,
          relationType: "derivative",
        }, { internal: true }, pool);
      } catch (err: any) {
        if (validatedGlbStored) await cleanupPrivateObject(validatedGlbStored.objectKey);
        if (validatedGlbAsset) await hardDeleteUnpublishedAsset(pool, validatedGlbAsset.asset.id).catch(() => {});
        await this.failJob(jobUuid, attemptId, "LINEAGE_FAILED", err.message, leaseOwner);
        return;
      }

      // Mandatory 5 standard high-resolution review renders via Blender worker boundary
      const REQUIRED_RENDER_ROLES: ArtifactRole[] = [
        "render_front",
        "render_rear",
        "render_left",
        "render_right",
        "render_three_quarter",
      ];
      const renderArtifactsStored: { role: ArtifactRole; objectKey: string; sha256: string; sizeBytes: number; assetId: number; versionId: number }[] = [];

      if (validatedGlbAsset && validationResult.status !== "fail") {
        const renderedViews = await this.renderStandardViewsWithWorker(glbBuffer);
        if (!renderedViews || Object.keys(renderedViews).length !== 5) {
          if (validatedGlbStored) await cleanupPrivateObject(validatedGlbStored.objectKey);
          if (validatedGlbAsset) await hardDeleteUnpublishedAsset(pool, validatedGlbAsset.asset.id).catch(() => {});
          await this.failJob(jobUuid, attemptId, "RENDER_FAILED", "Standard review renders missing or incomplete (expected exactly 5 valid PNG views)", leaseOwner);
          return;
        }

        try {
          for (const role of REQUIRED_RENDER_ROLES) {
            const imgBuf = renderedViews[role];
            if (!imgBuf) throw new Error(`Missing required render view role: ${role}`);

            const pngCheck = validatePngImage(imgBuf, 1024, 1024);
            if (!pngCheck.valid) throw new Error(`Invalid render image for ${role}: ${pngCheck.error}`);

            const stored = await storeRenderArtifact(ownerId, jobUuid, attempt.attempt_number, role, imgBuf);
            const assetReg = await registerAsset({
              ownerId,
              assetType: "model_render",
              visibility: "private",
              mimeType: "image/png",
              sizeBytes: stored.sizeBytes,
              sha256: stored.sha256,
              bucket: "private",
              objectKey: stored.objectKey,
              sourceProvider: "blender",
              license: "proprietary",
              commercialUseEligible: false,
              metadata: { phase: 3, role, jobUuid },
            }, { authorization: { internal: true }, pool });

            // Track the object and canonical asset before lineage so every
            // subsequent failure can compensate the complete partial batch.
            renderArtifactsStored.push({
              role,
              objectKey: stored.objectKey,
              sha256: stored.sha256,
              sizeBytes: stored.sizeBytes,
              assetId: assetReg.asset.id,
              versionId: assetReg.version.id,
            });

            await addLineage({
              parentAssetUuid: validatedGlbAsset.asset.asset_uuid,
              parentVersionNumber: validatedGlbAsset.version.version_number,
              childAssetUuid: assetReg.asset.asset_uuid,
              childVersionNumber: assetReg.version.version_number,
              relationType: "derivative",
            }, { internal: true }, pool);

          }
        } catch (err: any) {
          // ATOMIC BATCH CLEANUP of any created render artifacts
          for (const art of renderArtifactsStored) {
            await cleanupPrivateObject(art.objectKey).catch(() => {});
            await hardDeleteUnpublishedAsset(pool, art.assetId).catch(() => {});
          }
          if (validatedGlbStored) await cleanupPrivateObject(validatedGlbStored.objectKey);
          if (validatedGlbAsset) await hardDeleteUnpublishedAsset(pool, validatedGlbAsset.asset.id).catch(() => {});
          await this.failJob(jobUuid, attemptId, "RENDER_PERSISTENCE_FAILED", err.message || String(err), leaseOwner);
          return;
        }
      }

      // Compute complete canonical metrics object & canonical metricsHash covering geometry, likeness, AND renders
      const renderEvidence = renderArtifactsStored.map((r) => ({
        role: r.role,
        sha256: r.sha256,
        sizeBytes: r.sizeBytes,
      }));

      const completeMetrics = {
        ...validationResult.metrics,
        advisoryLikeness,
        renders: renderEvidence,
      };

      const canonicalReportContent = {
        validatorVersion: VALIDATOR_VERSION,
        status: validationResult.status,
        metrics: completeMetrics,
        providerGlbHash: providerGlbStored.sha256,
        validatedGlbHash: validatedGlbStored?.sha256 || null,
        jobUuid,
        attemptNumber: attempt.attempt_number,
      };
      const canonicalMetricsHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(canonicalReportContent))
        .digest("hex");

      // Store report
      const reportJson = {
        ...canonicalReportContent,
        metricsHash: canonicalMetricsHash,
      };

      let reportStored;
      try {
        reportStored = await storeReportJson(ownerId, jobUuid, attempt.attempt_number, reportJson);
      } catch (err: any) {
        for (const art of renderArtifactsStored) {
          await cleanupPrivateObject(art.objectKey).catch(() => {});
          await hardDeleteUnpublishedAsset(pool, art.assetId).catch(() => {});
        }
        if (validatedGlbStored) await cleanupPrivateObject(validatedGlbStored.objectKey).catch(() => {});
        if (validatedGlbAsset) await hardDeleteUnpublishedAsset(pool, validatedGlbAsset.asset.id).catch(() => {});
        await this.failJob(jobUuid, attemptId, "STORAGE_FAILED", err.message, leaseOwner);
        return;
      }

      // Register report asset
      let reportAsset;
      try {
        reportAsset = await registerAsset({
          ownerId,
          assetType: "validation_report",
          visibility: "private",
          mimeType: "application/json",
          sizeBytes: reportStored.sizeBytes,
          sha256: reportStored.sha256,
          bucket: "private",
          objectKey: reportStored.objectKey,
          sourceProvider: "pawsome3d",
          license: "proprietary",
          commercialUseEligible: false,
          metadata: { phase: 3, role: "post_build_report", jobUuid },
        }, { authorization: { internal: true }, pool });
      } catch (err: any) {
        await cleanupPrivateObject(reportStored.objectKey);
        for (const art of renderArtifactsStored) {
          await cleanupPrivateObject(art.objectKey).catch(() => {});
          await hardDeleteUnpublishedAsset(pool, art.assetId).catch(() => {});
        }
        if (validatedGlbStored) await cleanupPrivateObject(validatedGlbStored.objectKey).catch(() => {});
        if (validatedGlbAsset) await hardDeleteUnpublishedAsset(pool, validatedGlbAsset.asset.id).catch(() => {});
        await this.failJob(jobUuid, attemptId, "ASSET_REGISTRATION_FAILED", err.message, leaseOwner);
        return;
      }
      try {
        const reportParent = validatedGlbAsset || providerGlbAsset;
        await addLineage({
          parentAssetUuid: reportParent.asset.asset_uuid,
          parentVersionNumber: reportParent.version.version_number,
          childAssetUuid: reportAsset.asset.asset_uuid,
          childVersionNumber: reportAsset.version.version_number,
          relationType: "derivative",
        }, { internal: true }, pool);
      } catch (err: any) {
        await cleanupPrivateObject(reportStored.objectKey);
        await hardDeleteUnpublishedAsset(pool, reportAsset.asset.id).catch(() => {});
        for (const art of renderArtifactsStored) {
          await cleanupPrivateObject(art.objectKey).catch(() => {});
          await hardDeleteUnpublishedAsset(pool, art.assetId).catch(() => {});
        }
        if (validatedGlbStored) await cleanupPrivateObject(validatedGlbStored.objectKey).catch(() => {});
        if (validatedGlbAsset) await hardDeleteUnpublishedAsset(pool, validatedGlbAsset.asset.id).catch(() => {});
        await this.failJob(jobUuid, attemptId, "LINEAGE_FAILED", err.message, leaseOwner);
        return;
      }

      // Record validated GLB artifact + report + renders
      const conn7 = await pool.getConnection();
      try {
        await conn7.beginTransaction();
        const current = await this.lockCurrentAttempt(
          conn7, jobUuid, attemptId, leaseOwner, true,
          ["validating"], ["validating"],
        );
        if (!current) {
          await conn7.commit();
          return;
        }

        if (validatedGlbAsset && validatedGlbStored) await insertArtifact(conn7, {
          attemptId,
          assetId: validatedGlbAsset.asset.id,
          assetVersionId: validatedGlbAsset.version.id,
          role: "validated_glb",
          computedHash: validatedGlbStored.sha256,
          sizeBytes: validatedGlbStored.sizeBytes,
          mimeType: "model/gltf-binary",
        });

        for (const renderArt of renderArtifactsStored) {
          await insertArtifact(conn7, {
            attemptId,
            assetId: renderArt.assetId,
            assetVersionId: renderArt.versionId,
            role: renderArt.role,
            computedHash: renderArt.sha256,
            sizeBytes: renderArt.sizeBytes,
            mimeType: "image/png",
          });
        }

        await insertReport(conn7, {
          attemptId,
          reportAssetId: reportAsset.asset.id,
          reportAssetVersionId: reportAsset.version.id,
          status: validationResult.status,
          validatorVersions: VALIDATOR_VERSION,
          metricsHash: canonicalMetricsHash,
          metricsJson: completeMetrics as any,
        });

        if (validationResult.status === "fail") {
          console.error(`[model-build] Validation failed for ${jobUuid}:`, validationResult.metrics.errors);
          await updateAttemptState(conn7, attemptId, "failed", {
            failureCode: "VALIDATION_FAILED",
            errorMessage: (validationResult.metrics.errors || []).join("; ").slice(0, 500),
            completedAt: new Date(),
          });
          await updateJobState(conn7, current.job.id, "failed_validation", {
            failureCode: "VALIDATION_FAILED",
          });
          await conn7.commit();

          // Refund
          await this.refundJob(jobUuid, attemptId);
          return;
        }

        await updateAttemptState(conn7, attemptId, "ready", {
          completedAt: new Date(),
        });
        await updateJobState(conn7, current.job.id, "ready");
        await conn7.commit();
      } catch {
        await conn7.rollback().catch(() => {});
        if (validatedGlbStored) await cleanupPrivateObject(validatedGlbStored.objectKey);
        if (validatedGlbAsset) await hardDeleteUnpublishedAsset(pool, validatedGlbAsset.asset.id).catch(() => {});
        for (const renderArt of renderArtifactsStored) {
          await cleanupPrivateObject(renderArt.objectKey).catch(() => {});
          await hardDeleteUnpublishedAsset(pool, renderArt.assetId).catch(() => {});
        }
        await cleanupPrivateObject(reportStored.objectKey);
        await hardDeleteUnpublishedAsset(pool, reportAsset.asset.id).catch(() => {});
        await this.failJob(jobUuid, attemptId, "ARTIFACT_PERSIST_FAILED", "Final artifact persistence failed", leaseOwner);
        return;
      } finally {
        conn7.release();
      }
    } catch (error: any) {
      if (error instanceof RecoveryPersistenceUnavailableError) {
        console.error(`[model-build] Provider submission recovery persistence is unavailable for job ${jobUuid}`);
      } else {
        console.error(`[model-build] Unexpected processing failure for job ${jobUuid}`);
        await this.failJob(jobUuid, attemptId, "INTERNAL_ERROR", "Unexpected model build processing failure", leaseOwner).catch(() => {});
      }
    } finally {
      await releaseLease(pool, attemptId, leaseOwner).catch(() => {});
      connection.release();
    }
  }

  // ── Fail Job ──────────────────────────────────────────────────────────

  private async failJob(
    jobUuid: string,
    attemptId: number,
    failureCode: string,
    message: string,
    leaseOwner?: string,
  ): Promise<void> {
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const job = await findJobByUuidForUpdate(conn, jobUuid);
      if (!job || job.current_attempt_id !== attemptId ||
          TERMINAL_JOB_STATES.includes(job.state as any) || job.state === "recovery_required") {
        await conn.commit();
        return;
      }
      const attempt = await findAttemptByIdForUpdate(conn, attemptId);
      if (!attempt || attempt.job_id !== job.id ||
          (leaseOwner && !this.hasLiveLease(attempt, leaseOwner))) {
        await conn.commit();
        return;
      }

      const isProvider = failureCode.startsWith("PROVIDER_") || failureCode === "DOWNLOAD_FAILED";
      const jobState: BuildJobState = isProvider ? "failed_provider" : "failed_validation";

      await updateAttemptState(conn, attemptId, "failed", {
        failureCode,
        errorMessage: this.sanitizeDiagnostic(message),
        completedAt: new Date(),
      });
      await updateJobState(conn, job.id, jobState, { failureCode });
      await conn.commit();

      // Refund if credits were charged
      if (job.credit_correlation_id && !job.refund_correlation_id) {
        await this.refundJob(jobUuid, attemptId);
      }
    } catch (err: any) {
      await conn.rollback();
      console.error(`[model-build] Failed to persist terminal state for job ${jobUuid}`);
    } finally {
      conn.release();
    }
  }

  // ── Refund ────────────────────────────────────────────────────────────

  private async refundJob(jobUuid: string, attemptId: number): Promise<boolean> {
    const pool = this.getPoolFn();

    // Persist refund_pending before touching the balance. This evidence remains
    // sweepable if the credit transaction encounters a transient database error.
    const pendingConn = await pool.getConnection();
    try {
      await pendingConn.beginTransaction();
      const job = await findJobByUuidForUpdate(pendingConn, jobUuid);
      if (!job || job.current_attempt_id !== attemptId || !job.credit_correlation_id) {
        await pendingConn.commit();
        return false;
      }
      if (job.refund_correlation_id) {
        await pendingConn.commit();
        return true;
      }
      await markRefundPending(pendingConn, job.id, null);
      await pendingConn.commit();
    } catch {
      await pendingConn.rollback().catch(() => {});
      console.error(`[model-build] Could not persist refund-pending evidence for job ${jobUuid}`);
      return false;
    } finally {
      pendingConn.release();
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const job = await findJobByUuidForUpdate(conn, jobUuid);
      if (!job || job.current_attempt_id !== attemptId || !job.credit_correlation_id) {
        await conn.commit();
        return false;
      }
      if (job.refund_correlation_id) {
        await conn.commit();
        return true;
      }
      const refundCorrelationId = `${job.credit_correlation_id}:refund`;
      await this.refundCredits(conn, job.id, attemptId, job.owner_id, job.quoted_credits, refundCorrelationId);
      await markRefundComplete(conn, job.id, refundCorrelationId);
      await conn.commit();
      return true;
    } catch {
      await conn.rollback().catch(() => {});
      const failureConn = await pool.getConnection();
      try {
        await markRefundFailure(failureConn, (await findJobByUuid(failureConn, jobUuid))?.id || 0);
      } catch {
        // The terminal job plus missing unique refund correlation still makes
        // the refund discoverable on the next sweep.
      } finally {
        failureConn.release();
      }
      console.error(`[model-build] Refund remains pending for job ${jobUuid}`);
      return false;
    } finally {
      conn.release();
    }
  }

  // ── Retry / Correction ────────────────────────────────────────────────

  async retryBuild(ownerId: string, jobUuid: string, input: RetryBuildInput): Promise<BuildJobPublic> {
    assertModelBuildV3Enabled();
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();
      const job = await findJobByUuidForUpdate(conn, jobUuid);
      if (!job) throw new ModelBuildServiceError("Job not found", "NOT_FOUND");
      if (job.owner_id !== ownerId) throw new ModelBuildServiceError("Not authorized", "FORBIDDEN");
      if (job.state !== "failed_validation" && job.state !== "failed_provider") {
        throw new ModelBuildServiceError(`Cannot retry job in state '${job.state}'`, "INVALID_STATE");
      }
      if (job.credit_correlation_id && !job.refund_correlation_id) {
        throw new ModelBuildServiceError(
          "Cannot retry while the prior attempt refund is pending",
          "REFUND_PENDING",
        );
      }

      // Check idempotency
      const existing = await findAttemptByIdempotencyKey(conn, input.idempotencyKey);
      if (existing) {
        await conn.commit();
        return this.getJobPublic(ownerId, jobUuid);
      }

      // Check correction limit
      const attempts = await findAttemptsByJobId(conn, job.id);
      if (attempts.length >= MAX_BUILD_CORRECTION_ATTEMPTS) {
        throw new ModelBuildServiceError(
          `Maximum correction attempts (${MAX_BUILD_CORRECTION_ATTEMPTS}) reached`,
          "MAX_RETRIES_EXCEEDED",
        );
      }

      const nextNumber = attempts.length + 1;
      const inputConfigHash = crypto.createHash("sha256")
        .update(`${job.manifest_hash}:${job.requested_output}:${nextNumber}:${input.correctionNotes || ""}`)
        .digest("hex");

      const attempt = await insertAttempt(conn, {
        jobId: job.id,
        attemptNumber: nextNumber,
        idempotencyKey: input.idempotencyKey,
        provider: "tripo",
        model: process.env.TRIPO_MODEL_VERSION || "default",
        inputConfigHash,
      });

      // Charge this immutable attempt exactly once.
      const creditCorrelationId = `model_build:${jobUuid}:retry:${nextNumber}`;
      const debited = await this.chargeCredits(conn, job.id, attempt.id, ownerId, job.quoted_credits, creditCorrelationId);
      if (!debited) throw new ModelBuildServiceError("Insufficient credits for retry", "INSUFFICIENT_CREDITS");

      await updateJobState(conn, job.id, "queued", {
        currentAttemptId: attempt.id,
        creditCorrelationId,
        refundCorrelationId: null,
        failureCode: null,
      });

      await conn.commit();

      // Launch background processing
      this.processAttempt(ownerId, jobUuid, attempt.id).catch((err) => {
        console.error(`[model-build] Retry processing error for job ${jobUuid}:`, err.message);
      });

      const updatedJob = await findJobByUuid(pool, jobUuid);
      return this.formatJobPublicHydrated(pool, updatedJob!);
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof ModelBuildServiceError) throw err;
      throw new ModelBuildServiceError(`Retry failed: ${err.message}`, "RETRY_FAILED");
    } finally {
      conn.release();
    }
  }

  // ── Cancel ────────────────────────────────────────────────────────────

  async cancelBuild(ownerId: string, jobUuid: string): Promise<BuildJobPublic> {
    assertModelBuildV3Enabled();
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();
      const job = await findJobByUuidForUpdate(conn, jobUuid);
      if (!job) throw new ModelBuildServiceError("Job not found", "NOT_FOUND");
      if (job.owner_id !== ownerId) throw new ModelBuildServiceError("Not authorized", "FORBIDDEN");

      const currentAttempt = job.current_attempt_id
        ? await findAttemptByIdForUpdate(conn, job.current_attempt_id)
        : null;

      // Cancellation and submission claim lock the same job/attempt rows. Once
      // submitted is claimed, cancellation must reject and may not refund.
      if (!canCancelBeforeSubmission(job.state, currentAttempt ? {
        state: currentAttempt.state,
        providerTaskHandle: currentAttempt.provider_task_handle,
        submissionClaimedAt: currentAttempt.submission_claimed_at,
      } : null)) {
        throw new ModelBuildServiceError(
          `Cannot cancel job in state '${job.state}'`,
          "INVALID_STATE",
        );
      }

      await updateJobState(conn, job.id, "cancelled", { failureCode: "USER_CANCELLED" });

      // Cancel any pending attempts
      if (currentAttempt?.state === "queued") {
        await updateAttemptState(conn, currentAttempt.id, "cancelled", {
          completedAt: new Date(),
        });
      }

      await conn.commit();

      // Refund if charged
      if (job.credit_correlation_id && !job.refund_correlation_id) {
        if (job.current_attempt_id) await this.refundJob(jobUuid, job.current_attempt_id);
      }

      const updatedJob = await findJobByUuid(pool, jobUuid);
      return this.formatJobPublicHydrated(pool, updatedJob!);
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof ModelBuildServiceError) throw err;
      throw new ModelBuildServiceError(`Cancel failed: ${err.message}`, "CANCEL_FAILED");
    } finally {
      conn.release();
    }
  }

  // ── Accept ────────────────────────────────────────────────────────────

  async acceptBuild(ownerId: string, jobUuid: string, input: AcceptBuildInput): Promise<BuildJobPublic> {
    assertModelBuildV3Enabled();
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();
      const job = await findJobByUuidForUpdate(conn, jobUuid);
      if (!job) throw new ModelBuildServiceError("Job not found", "NOT_FOUND");
      if (job.owner_id !== ownerId) throw new ModelBuildServiceError("Not authorized", "FORBIDDEN");

      if (job.state === "accepted") {
        // Idempotent: already accepted
        await conn.commit();
        return this.formatJobPublicHydrated(pool, job);
      }

      if (job.state !== "ready") {
        throw new ModelBuildServiceError(
          `Cannot accept job in state '${job.state}'`,
          "INVALID_STATE",
        );
      }

      // Find the validated GLB artifact and report for the current attempt
      if (!job.current_attempt_id) {
        throw new ModelBuildServiceError("No current attempt", "INVALID_STATE");
      }

      const artifact = await findArtifactByAttemptAndRole(conn, job.current_attempt_id, "validated_glb");
      if (!artifact) throw new ModelBuildServiceError("Validated GLB artifact not found", "ARTIFACT_NOT_FOUND");
      if (artifact.computed_hash !== input.artifactHash) {
        throw new ModelBuildServiceError("Artifact hash mismatch", "HASH_MISMATCH");
      }

      const report = await findReportByAttemptId(conn, job.current_attempt_id);
      if (!report) throw new ModelBuildServiceError("Post-build report not found", "REPORT_NOT_FOUND");
      if (report.metrics_hash !== input.reportHash) {
        throw new ModelBuildServiceError("Report hash mismatch", "HASH_MISMATCH");
      }

      // Insert acceptance
      const acceptance = await insertAcceptance(conn, {
        jobId: job.id,
        attemptId: job.current_attempt_id,
        artifactId: artifact.id,
        reportId: report.id,
        acceptedByUser: ownerId,
      });

      await updateJobState(conn, job.id, "accepted", {
        acceptedArtifactId: artifact.id,
        acceptedReportId: report.id,
      });

      await conn.commit();

      const updatedJob = await findJobByUuid(pool, jobUuid);
      return this.formatJobPublicHydrated(pool, updatedJob!);
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof ModelBuildServiceError) throw err;
      throw new ModelBuildServiceError(`Accept failed: ${err.message}`, "ACCEPT_FAILED");
    } finally {
      conn.release();
    }
  }

  // ── Read ──────────────────────────────────────────────────────────────

  async getJobPublic(ownerId: string, jobUuid: string): Promise<BuildJobPublic> {
    assertModelBuildV3Enabled();
    const pool = this.getPoolFn();
    const job = await findJobByUuid(pool, jobUuid);
    if (!job) throw new ModelBuildServiceError("Job not found", "NOT_FOUND");
    if (job.owner_id !== ownerId) throw new ModelBuildServiceError("Not authorized", "FORBIDDEN");
    return this.formatJobPublicHydrated(pool, job);
  }

  async getJobDetail(ownerId: string, jobUuid: string): Promise<{
    job: BuildJobPublic;
    attempts: BuildAttemptPublic[];
    artifacts: BuildArtifactPublic[];
    report: PostBuildReportPublic | null;
  }> {
    assertModelBuildV3Enabled();
    const pool = this.getPoolFn();
    const job = await findJobByUuid(pool, jobUuid);
    if (!job) throw new ModelBuildServiceError("Job not found", "NOT_FOUND");
    if (job.owner_id !== ownerId) throw new ModelBuildServiceError("Not authorized", "FORBIDDEN");

    const attempts = await findAttemptsByJobId(pool, job.id);
    const attemptPublics = attempts.map(a => ({
      attemptNumber: a.attempt_number,
      provider: a.provider,
      model: a.model,
      state: a.state,
      failureCode: a.failure_code,
      startedAt: a.started_at.toISOString(),
      completedAt: a.completed_at?.toISOString() || null,
    }));

    // Get artifacts for the current/latest attempt
    let artifactPublics: BuildArtifactPublic[] = [];
    let reportPublic: PostBuildReportPublic | null = null;

    if (job.current_attempt_id) {
      const artifacts = await findArtifactsByAttemptId(pool, job.current_attempt_id);
      for (const art of artifacts) {
        const asset = await findAssetById(pool, art.asset_id);
        const version = await findVersionById(pool, art.asset_version_id);
        if (asset && version) {
          let signedUrl: string | undefined;
          try {
            signedUrl = await generateSignedUrlForVersion(asset, version, ownerId, true) || undefined;
          } catch { /* non-fatal */ }
          artifactPublics.push({
            role: art.role,
            assetUuid: asset.asset_uuid,
            versionNumber: version.version_number,
            sha256: art.computed_hash,
            sizeBytes: art.size_bytes,
            mimeType: art.mime_type,
            signedUrl,
          });
        }
      }

      const report = await findReportByAttemptId(pool, job.current_attempt_id);
      if (report) {
        reportPublic = {
          status: report.status,
          validatorVersions: report.validator_versions,
          metricsHash: report.metrics_hash,
          metrics: report.metrics_json,
        };
      }
    }

    return {
      job: await this.formatJobPublicHydrated(pool, job),
      attempts: attemptPublics,
      artifacts: artifactPublics,
      report: reportPublic,
    };
  }

  async listJobs(ownerId: string): Promise<BuildJobPublic[]> {
    assertModelBuildV3Enabled();
    const pool = this.getPoolFn();
    const jobs = await findJobsByOwner(pool, ownerId);
    return Promise.all(jobs.map(j => this.formatJobPublicHydrated(pool, j)));
  }

  async recoverAmbiguousSubmissions(): Promise<{ recoveryRequired: number; recoveredJobs: string[] }> {
    const pool = this.getPoolFn();
    const ambiguous = await findAmbiguousSubmissions(pool);
    await this.durabilityRuntime.afterAmbiguousSubmissionScan?.();
    const recoveredJobs: string[] = [];

    for (const candidate of ambiguous) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [jobRows]: any = await conn.query(
          "SELECT * FROM model_build_jobs WHERE id = ? FOR UPDATE",
          [candidate.job_id],
        );
        const job = jobRows[0] as BuildJobRecord | undefined;
        const attempt = await findAttemptByIdForUpdate(conn, candidate.id);
        if (!job || !attempt || job.current_attempt_id !== attempt.id ||
            TERMINAL_JOB_STATES.includes(job.state as any) ||
            attempt.provider_task_handle !== null ||
            (attempt.lease_owner !== null && attempt.lease_expires_at !== null &&
             new Date(attempt.lease_expires_at).getTime() >= Date.now())) {
          await conn.commit();
          continue;
        }

        await updateJobState(conn, job.id, "recovery_required", {
          failureCode: "PROVIDER_HANDLE_RECOVERY_REQUIRED",
        });
        await updateAttemptState(conn, attempt.id, "recovery_required", {
          leaseOwner: null,
          leaseExpiresAt: null,
          failureCode: "PROVIDER_HANDLE_RECOVERY_REQUIRED",
          errorMessage: "Provider submission requires operator recovery",
          recoveryRequiredAt: attempt.recovery_required_at || new Date(),
        });
        await conn.commit();
        recoveredJobs.push(job.job_uuid);
      } catch {
        await conn.rollback().catch(() => {});
      } finally {
        conn.release();
      }
    }

    return { recoveryRequired: recoveredJobs.length, recoveredJobs };
  }

  async recoverPendingRefunds(): Promise<{ pendingRefunds: number; refundedJobs: string[] }> {
    const pool = this.getPoolFn();
    const pending = await findRefundPendingJobs(pool);
    const refundedJobs: string[] = [];

    for (const job of pending) {
      if (job.current_attempt_id && await this.refundJob(job.job_uuid, job.current_attempt_id)) {
        refundedJobs.push(job.job_uuid);
      }
    }

    return { pendingRefunds: pending.length, refundedJobs };
  }

  async recoverStaleBuilds(): Promise<{ timestamp: string; expiredLeases: number; recoveredJobs: string[] }> {
    const pool = this.getPoolFn();
    await this.recoverAmbiguousSubmissions();
    await this.recoverPendingRefunds();
    const expired = await findExpiredLeases(pool);
    // MG-7: also re-enter attempts stranded in `queued` with no lease, which
    // findExpiredLeases does not match.
    const staleQueued = await findStaleQueuedAttempts(pool);
    const seenAttemptIds = new Set(expired.map((attempt) => attempt.id));
    const recoverable = [...expired, ...staleQueued.filter((attempt) => !seenAttemptIds.has(attempt.id))];
    const recoveredJobs: string[] = [];
    for (const attempt of recoverable) {
      const [rows]: any = await pool.query("SELECT job_uuid, owner_id FROM model_build_jobs WHERE id = ?", [attempt.job_id]);
      if (!rows[0]) continue;
      await this.processAttempt(String(rows[0].owner_id), String(rows[0].job_uuid), attempt.id);
      recoveredJobs.push(String(rows[0].job_uuid));
    }
    return { timestamp: new Date().toISOString(), expiredLeases: expired.length, recoveredJobs };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private hasLiveLease(attempt: BuildAttemptRecord, leaseOwner: string): boolean {
    return attempt.lease_owner === leaseOwner &&
      !!attempt.lease_expires_at &&
      new Date(attempt.lease_expires_at).getTime() >= Date.now();
  }

  private async lockCurrentAttempt(
    conn: mysql.PoolConnection,
    jobUuid: string,
    attemptId: number,
    leaseOwner: string,
    requireLiveLease: boolean,
    allowedJobStates: BuildJobState[],
    allowedAttemptStates: BuildAttemptRecord["state"][],
  ): Promise<{ job: BuildJobRecord; attempt: BuildAttemptRecord } | null> {
    const job = await findJobByUuidForUpdate(conn, jobUuid);
    if (!job || job.current_attempt_id !== attemptId ||
        !allowedJobStates.includes(job.state) ||
        TERMINAL_JOB_STATES.includes(job.state as any)) return null;

    const attempt = await findAttemptByIdForUpdate(conn, attemptId);
    if (!attempt || attempt.job_id !== job.id || !allowedAttemptStates.includes(attempt.state)) return null;
    if (requireLiveLease && !this.hasLiveLease(attempt, leaseOwner)) return null;
    return { job, attempt };
  }

  private async renewOwnedLease(
    pool: mysql.Pool,
    jobUuid: string,
    attemptId: number,
    leaseOwner: string,
    allowedJobStates: BuildJobState[] = ["processing", "downloading"],
    allowedAttemptStates: BuildAttemptRecord["state"][] = ["processing", "downloading"],
  ): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const current = await this.lockCurrentAttempt(
        conn, jobUuid, attemptId, leaseOwner, true,
        allowedJobStates, allowedAttemptStates,
      );
      if (!current) {
        await conn.commit();
        return false;
      }
      const renewed = await renewLease(
        conn,
        attemptId,
        leaseOwner,
        new Date(Date.now() + DEFAULT_LEASE_DURATION_MS),
      );
      await conn.commit();
      return renewed;
    } catch {
      await conn.rollback().catch(() => {});
      return false;
    } finally {
      conn.release();
    }
  }

  private async transitionOwnedAttempt(
    pool: mysql.Pool,
    jobUuid: string,
    attemptId: number,
    leaseOwner: string,
    allowedJobStates: BuildJobState[],
    allowedAttemptStates: BuildAttemptRecord["state"][],
    nextState: "processing" | "downloading" | "validating",
  ): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const current = await this.lockCurrentAttempt(
        conn, jobUuid, attemptId, leaseOwner, true,
        allowedJobStates, allowedAttemptStates,
      );
      if (!current) {
        await conn.commit();
        return false;
      }
      await updateJobState(conn, current.job.id, nextState);
      await updateAttemptState(conn, attemptId, nextState, {
        leaseExpiresAt: new Date(Date.now() + DEFAULT_LEASE_DURATION_MS),
      });
      await conn.commit();
      return true;
    } catch {
      await conn.rollback().catch(() => {});
      throw new DurableModelBuildError("Durable phase transition failed", "PHASE_TRANSITION_FAILED");
    } finally {
      conn.release();
    }
  }

  private sanitizeDiagnostic(message: string): string {
    return String(message || "Model build failed")
      .replace(/https?:\/\/\S+/gi, "[redacted-url]")
      .replace(/(?:api[_-]?key|authorization|bearer|signature|token)=?\s*[^\s,;]+/gi, "[redacted-credential]")
      .slice(0, 500);
  }

  private formatJobPublic(job: BuildJobRecord): BuildJobPublic {
    return {
      jobUuid: job.job_uuid,
      ownerId: job.owner_id,
      referenceSessionUuid: "", // Filled by route layer via join
      manifestHashPrefix: job.manifest_hash.slice(0, 12),
      requestedOutput: job.requested_output,
      pricingKey: job.pricing_key,
      quotedCredits: job.quoted_credits,
      state: job.state,
      currentAttemptNumber: null, // Filled by route layer
      failureCode: job.failure_code,
      diagnostic: job.state === "recovery_required"
        ? "provider_submission_recovery_required"
        : null,
      billingDisposition: "not_charged",
      createdAt: job.created_at.toISOString(),
      updatedAt: job.updated_at.toISOString(),
    };
  }

  private async formatJobPublicHydrated(
    db: mysql.Pool,
    job: BuildJobRecord,
  ): Promise<BuildJobPublic> {
    const value = this.formatJobPublic(job);
    const [sessionRows] = await db.query(
      "SELECT session_uuid FROM reference_sessions WHERE id = ? LIMIT 1",
      [job.reference_session_id],
    ) as any;
    let currentAttemptNumber: number | null = null;
    if (job.current_attempt_id) {
      const attempt = await findAttemptById(db, job.current_attempt_id);
      currentAttemptNumber = attempt?.attempt_number ?? null;
    }

    let billingDisposition: "charged" | "refunded" | "not_charged" | "refund_pending" = "not_charged";
    const currentChargeCorrelation = job.credit_correlation_id;
    const matchingRefundCorrelation = currentChargeCorrelation
      ? `${currentChargeCorrelation}:refund`
      : null;
    const [creditEvents]: any = currentChargeCorrelation && job.current_attempt_id
      ? await db.query(
        `SELECT event_type, delta, correlation_id
         FROM model_build_credit_events
         WHERE job_id = ? AND attempt_id = ?
           AND correlation_id IN (?, ?)`,
        [job.id, job.current_attempt_id, currentChargeCorrelation, matchingRefundCorrelation],
      )
      : [[]];
    const hasCharge = creditEvents.some((e: any) =>
      e.correlation_id === currentChargeCorrelation &&
      (e.event_type === "charge" || Number(e.delta) < 0));
    const hasRefund = creditEvents.some((e: any) =>
      e.correlation_id === matchingRefundCorrelation &&
      (e.event_type === "refund" || Number(e.delta) > 0));

    if (hasRefund) {
      billingDisposition = "refunded";
    } else if (hasCharge) {
      if (["failed_provider", "failed_validation", "cancelled"].includes(job.state)) {
        billingDisposition = "refund_pending";
      } else {
        billingDisposition = "charged";
      }
    } else {
      billingDisposition = "not_charged";
    }

    return {
      ...value,
      referenceSessionUuid: sessionRows[0]?.session_uuid || "",
      currentAttemptNumber,
      billingDisposition,
      diagnostic: billingDisposition === "refund_pending"
        ? "refund_pending"
        : value.diagnostic,
    };
  }

  private async chargeCredits(
    conn: mysql.PoolConnection,
    jobId: number,
    attemptId: number,
    phone: string,
    amount: number,
    correlationId: string,
  ): Promise<boolean> {
    const [existing]: any = await conn.query("SELECT 1 FROM model_build_credit_events WHERE correlation_id = ?", [correlationId]);
    if (existing.length > 0) return true;
    const [result]: any = await conn.query(
      "UPDATE users SET credits = credits - ? WHERE phone = ? AND credits >= ?",
      [amount, phone, amount],
    );
    if (result.affectedRows === 1) {
      await this.recordCreditEvent(conn, jobId, attemptId, phone, -Math.abs(amount), correlationId, "charge");
    }
    return result.affectedRows === 1;
  }

  private async refundCredits(
    conn: mysql.PoolConnection,
    jobId: number,
    attemptId: number,
    phone: string,
    amount: number,
    correlationId: string,
  ): Promise<void> {
    const [existing]: any = await conn.query("SELECT 1 FROM model_build_credit_events WHERE correlation_id = ?", [correlationId]);
    if (existing.length > 0) return;
    const [result]: any = await conn.query("UPDATE users SET credits = credits + ? WHERE phone = ?", [amount, phone]);
    if (result.affectedRows !== 1) throw new Error("Refund owner no longer exists");
    await this.recordCreditEvent(conn, jobId, attemptId, phone, Math.abs(amount), correlationId, "refund");
  }

  private async recordCreditEvent(
    conn: mysql.PoolConnection,
    jobId: number,
    attemptId: number,
    phone: string,
    delta: number,
    correlationId: string,
    eventType: "charge" | "refund",
  ): Promise<void> {
    const [rows]: any = await conn.query("SELECT credits FROM users WHERE phone = ? FOR UPDATE", [phone]);
    if (!rows[0]) throw new Error("Credit owner not found");
    const balance = Number(rows[0].credits || 0);
    await conn.query(
      `INSERT INTO model_build_credit_events
       (job_id, attempt_id, owner_id, correlation_id, event_type, delta, balance_after)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [jobId, attemptId, phone, correlationId, eventType, delta, balance],
    );
    await conn.query(
      "INSERT INTO credit_transactions (user_phone, delta, reason, balance_after) VALUES (?, ?, ?, ?)",
      [phone, delta, correlationId.slice(0, 80), balance],
    );
  }

  /**
   * MG-8: the five standard review renders are mandatory, and a single failed
   * call used to fail AND refund the whole build — discarding an already
   * validated GLB plus the Tripo credits that produced it. The realistic
   * trigger is a cold or briefly unavailable Render instance, or five 1024²
   * renders simply taking longer than the old 60s timeout. Retry with
   * exponential backoff before giving up.
   */
  private async renderStandardViewsWithWorker(
    glbBuffer: Buffer,
    maxAttempts = 3,
  ): Promise<Record<Extract<ArtifactRole, `render_${string}`>, Buffer> | null> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let result: Record<Extract<ArtifactRole, `render_${string}`>, Buffer> | null = null;
      try {
        result = await this.renderStandardViewsWithWorkerOnce(glbBuffer);
      } catch (error: any) {
        console.warn(
          `[model-build] Blender worker render attempt ${attempt}/${maxAttempts} threw: ${error?.message || error}`,
        );
      }
      if (result && Object.keys(result).length === 5) return result;
      if (attempt < maxAttempts) {
        const backoffMs = 2000 * (2 ** (attempt - 1));
        console.warn(
          `[model-build] Blender worker render attempt ${attempt}/${maxAttempts} incomplete; retrying in ${backoffMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    console.error(`[model-build] Blender worker renders failed after ${maxAttempts} attempts`);
    return null;
  }

  private async renderStandardViewsWithWorkerOnce(
    glbBuffer: Buffer,
  ): Promise<Record<Extract<ArtifactRole, `render_${string}`>, Buffer> | null> {
    const rawWorkerUrl = String(process.env.BLENDER_WORKER_URL || "").trim().replace(/\/render$/, "").replace(/\/$/, "");

    // Non-production fallback when worker URL is unconfigured
    if (!rawWorkerUrl) {
      if (process.env.NODE_ENV !== "production") {
        const fixturePng = createValidPngBuffer(1024, 1024);
        return {
          render_front: fixturePng,
          render_rear: fixturePng,
          render_left: fixturePng,
          render_right: fixturePng,
          render_three_quarter: fixturePng,
        };
      }
      return null;
    }

    let urlObj: URL;
    try {
      urlObj = new URL(rawWorkerUrl);
    } catch {
      console.error("[model-build] Invalid Blender worker URL format");
      return null;
    }

    if (process.env.NODE_ENV === "production" && urlObj.protocol !== "https:") {
      console.error("[model-build] Blender worker URL must use HTTPS in production");
      return null;
    }

    const secret = process.env.WORKER_SHARED_SECRET || "";
    if (process.env.NODE_ENV === "production" && !secret) {
      console.error("[model-build] WORKER_SHARED_SECRET is required in production");
      return null;
    }

    const res = await fetch(`${rawWorkerUrl}/texture/render-views`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-secret": secret },
      body: JSON.stringify({
        glb_base64: glbBuffer.toString("base64"),
        tier: "standard",
        views: ["front", "back", "left", "right", "front_right"],
        resolution: 1024,
      }),
      // MG-8: five 1024² renders regularly exceed 60s on a cold Render dyno.
      signal: AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      console.warn(`[model-build] Blender worker render-views returned HTTP ${res.status}`);
      return null;
    }

    const contentLength = Number(res.headers.get("content-length") || "0");
    if (contentLength > 50 * 1024 * 1024) {
      console.error("[model-build] Worker response exceeds 50MB limit");
      return null;
    }

    const responseBytes = Buffer.from(await res.arrayBuffer());
    if (responseBytes.length > 50 * 1024 * 1024) {
      console.error("[model-build] Worker response exceeds 50MB limit");
      return null;
    }
    const data: any = (() => {
      try { return JSON.parse(responseBytes.toString("utf8")); } catch { return null; }
    })();
    if (!data || data.success !== true || !data.views || typeof data.views !== "object") {
      return null;
    }

    const roleMap: Record<string, ArtifactRole> = {
      front: "render_front",
      back: "render_rear",
      rear: "render_rear",
      left: "render_left",
      right: "render_right",
      front_right: "render_three_quarter",
      front_three_quarter: "render_three_quarter",
    };

    const requiredRoles: ArtifactRole[] = [
      "render_front",
      "render_rear",
      "render_left",
      "render_right",
      "render_three_quarter",
    ];

    const result: Partial<Record<ArtifactRole, Buffer>> = {};
    const suppliedKeys: string[] = Object.keys(data.views as Record<string, unknown>);
    const expectedKeys = ["front", "back", "left", "right", "front_right"];
    if (suppliedKeys.length !== expectedKeys.length || expectedKeys.some((key) => !suppliedKeys.includes(key))) {
      console.error("[model-build] Worker response must contain exactly the five requested views");
      return null;
    }

    for (const [viewKey, base64Val] of Object.entries(data.views as Record<string, unknown>)) {
      const role = roleMap[viewKey];
      if (!role) continue;

      if (typeof base64Val !== "string" || !base64Val.length) continue;
      const raw = base64Val.startsWith("data:") ? base64Val.split(",")[1] : base64Val;

      if (raw.length < 100 || raw.length > 15 * 1024 * 1024) continue;

      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) continue;
      const imgBuf = Buffer.from(raw, "base64");
      const pngVal = validatePngImage(imgBuf, 1024, 1024);
      if (!pngVal.valid) {
        console.warn(`[model-build] View ${viewKey} failed PNG validation: ${pngVal.error}`);
        continue;
      }

      result[role] = imgBuf;
    }

    const hasAll5 = requiredRoles.every((r) => result[r] !== undefined);
    if (!hasAll5) {
      console.error("[model-build] Worker response missing one or more required render views");
      return null;
    }

    return result as Record<ArtifactRole, Buffer>;
  }
}
