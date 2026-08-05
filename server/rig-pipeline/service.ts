// ─── Phase 4: Rig Pipeline Service ─────────────────────────────────────────
import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import { assertRigPipelineV4Enabled } from "./featureFlag";
import type {
  RigJobPublic,
  RigJobState,
  ClassificationType,
  FacialCapability,
} from "./types";
import {
  DEFAULT_RIG_LEASE_DURATION_MS,
  MAX_RIG_ATTEMPTS,
  TERMINAL_RIG_JOB_STATES,
} from "./types";
import {
  insertClassification,
  findClassificationByJobId,
  updateClassificationOverride,
  insertRigJob,
  findRigJobByUuid,
  findRigJobByUuidForUpdate,
  findRigJobByIdempotencyKey,
  updateRigJobState,
  insertRigAttempt,
  findRigAttemptById,
  findRigAttemptsByJobId,
  updateRigAttemptState,
  claimRigLease,
  releaseRigLease,
  renewRigLease,
  insertRigWorkerAttempt,
  findRigWorkerAttemptByRigAttemptId,
  updateRigWorkerAttempt,
  insertRigWorkerEvent,
  insertRigAttemptArtifact,
  findRigAttemptArtifact,
  insertRigValidationManifest,
  insertFacialInventory,
  findAccessoryByUuid,
  insertAccessoryFit,
  findStaleRigAttempts,
  findManifestByAttemptId,
  findFacialInventoryByAttemptId,
  findFitsByRigJobId,
  insertRigAcceptance,
} from "./repository";
import { classifyModel, validateRigGeometry } from "./validation";
import { findJobByUuid, findJobByUuidForUpdate as findModelBuildJobByUuidForUpdate } from "../model-builds/repository";
import { findAssetById, findVersionById } from "../assets/repository";
import { generateSignedUrlForVersion } from "../assets/access";
import type { AssetRecord, AssetVersionRecord } from "../assets/types";
import {
  HttpRigWorkerClient,
  canonicalWorkerHash,
  createRigWorkerRequest,
  inspectRiggedGlb,
  verifyFusedPrintOutput,
  verifyWorkerOutput,
  type RigWorkerPort,
  type RigWorkerRequest,
  type RigWorkerResult,
} from "./worker";
import { cleanupPersistedRigResult, persistRigWorkerResult, type PersistedRigResult } from "./resultPersistence";

export class RigPipelineError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "RigPipelineError";
  }
}

export class RigPipelineService {
  private readonly worker: RigWorkerPort;
  private readonly signVersion: (asset: AssetRecord, version: AssetVersionRecord, ownerId: string) => Promise<string>;

  constructor(
    private readonly getPoolFn: () => mysql.Pool,
    dependencies: {
      worker?: RigWorkerPort;
      signVersion?: (asset: AssetRecord, version: AssetVersionRecord, ownerId: string) => Promise<string>;
    } = {},
  ) {
    this.worker = dependencies.worker || new HttpRigWorkerClient();
    this.signVersion = dependencies.signVersion
      || ((asset, version, ownerId) => generateSignedUrlForVersion(asset, version, ownerId, false, 600));
  }

  // ── 1. Start Rig Job ──────────────────────────────────────────────────────

  async startRigJob(
    ownerId: string,
    params: {
      modelBuildJobUuid: string;
      idempotencyKey: string;
      profileId?: string;
      requestFacial?: boolean;
      accessoryUuids?: string[];
      overrideClassification?: ClassificationType;
      overrideReason?: string;
    },
  ): Promise<RigJobPublic> {
    assertRigPipelineV4Enabled();
    const pool = this.getPoolFn();

    // Idempotency check
    const existingJob = await findRigJobByIdempotencyKey(pool, params.idempotencyKey);
    if (existingJob) {
      if (existingJob.owner_id !== ownerId) {
        throw new RigPipelineError("Not authorized", "FORBIDDEN");
      }
      return this.getJobPublic(ownerId, existingJob.job_uuid);
    }

    // Load Phase 3 build job
    let modelBuildJob = await findJobByUuid(pool, params.modelBuildJobUuid);
    if (!modelBuildJob) {
      throw new RigPipelineError("Phase 3 model build job not found", "NOT_FOUND");
    }
    if (modelBuildJob.owner_id !== ownerId) {
      throw new RigPipelineError("Not authorized to access model build", "FORBIDDEN");
    }
    if (modelBuildJob.state !== "accepted" || !modelBuildJob.accepted_artifact_id) {
      throw new RigPipelineError("Model build must be in accepted state before rigging", "UNACCEPTED_MODEL");
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      modelBuildJob = await findModelBuildJobByUuidForUpdate(conn, params.modelBuildJobUuid);
      if (!modelBuildJob) throw new RigPipelineError("Phase 3 model build job not found", "NOT_FOUND");
      if (modelBuildJob.owner_id !== ownerId) throw new RigPipelineError("Not authorized to access model build", "FORBIDDEN");

      const existingLocked = await findRigJobByIdempotencyKey(conn, params.idempotencyKey);
      if (existingLocked) {
        await conn.commit();
        return this.getJobPublic(ownerId, existingLocked.job_uuid);
      }

      const [artifactRows]: any = await conn.query(
        `SELECT mba.*
         FROM model_build_artifacts mba
         WHERE mba.id = ? AND mba.attempt_id = ? AND mba.role = 'validated_glb'`,
        [modelBuildJob.accepted_artifact_id, modelBuildJob.current_attempt_id],
      );
      const artifact = artifactRows[0];
      if (!artifact) throw new RigPipelineError("Accepted artifact not found", "ARTIFACT_NOT_FOUND");

      // 1. Get or create classification
      let classRec = await findClassificationByJobId(conn, modelBuildJob.id);
      if (!classRec) {
        // Run classification on accepted artifact metadata and its report.
        const [contextRows]: any = await conn.query(
          `SELECT rs.subject_class, reports.metrics_json
           FROM reference_sessions rs
           LEFT JOIN model_post_build_reports reports ON reports.id = ?
           WHERE rs.id = ?`,
          [modelBuildJob.accepted_report_id, modelBuildJob.reference_session_id],
        );
        const context = contextRows[0] || {};
        const metrics = parseJsonRecord(context.metrics_json);
        const dimensions = parseDimensions(metrics.dimensions);
        const classRes = classifyModel({
          triangleCount: finiteNonNegative(metrics.triangleCount),
          boundingVolume: dimensions,
          subjectClass: typeof context.subject_class === "string" ? context.subject_class : undefined,
        });

        const requestedClassification = params.overrideClassification || classRes.classification;
        const selectedProfileId = params.profileId || profileForClassification(requestedClassification);
        if (!profileMatchesClassification(selectedProfileId, requestedClassification)) {
          throw new RigPipelineError("Selected rig profile does not match the measured classification", "PROFILE_MISMATCH");
        }

        const classId = await insertClassification(conn, {
          modelBuildJobId: modelBuildJob.id,
          acceptedArtifactId: artifact.id,
          classification: requestedClassification,
          classifierVersion: classRes.classifierVersion,
          confidence: classRes.confidence,
          evidenceJson: classRes.evidence,
          selectedProfileId,
        });

        classRec = (await findClassificationByJobId(conn, modelBuildJob.id))!;
      } else if (params.overrideClassification) {
        await updateClassificationOverride(
          conn,
          classRec.id,
          ownerId,
          params.overrideReason || "User override",
          params.overrideClassification,
          params.profileId || profileForClassification(params.overrideClassification),
        );
        classRec = (await findClassificationByJobId(conn, modelBuildJob.id))!;
      }

      // Check classification validity
      if (classRec.classification === "unsupported") {
        throw new RigPipelineError("Model geometry is classified as unsupported for auto-rigging", "UNSUPPORTED_GEOMETRY");
      }

      // 2. Create rig job record
      const jobUuid = crypto.randomUUID();
      const jobId = await insertRigJob(conn, {
        jobUuid,
        ownerId,
        modelBuildJobId: modelBuildJob.id,
        classificationId: classRec.id,
        sourceArtifactId: modelBuildJob.accepted_artifact_id,
        sourceVersionId: Number(artifact.asset_version_id),
        requestFacial: params.requestFacial ?? true,
        idempotencyKey: params.idempotencyKey,
      });

      // 3. Create attempt 1
      const attemptId = await insertRigAttempt(conn, {
        jobId,
        attemptNumber: 1,
        idempotencyKey: `${params.idempotencyKey}_att1`,
      });

      await updateRigJobState(conn, jobId, "queued", { currentAttemptId: attemptId });

      await conn.commit();

      // Trigger durable processing through the authenticated Blender worker.
      // Acceptance still fails closed unless measured artifacts survive reopen.
      this.processAttempt(ownerId, jobUuid, attemptId, params.accessoryUuids).catch((err) => {
        console.error(`[rig-pipeline] Unhandled error in processAttempt for ${jobUuid}:`, err);
      });

      return this.getJobPublic(ownerId, jobUuid);
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof RigPipelineError) throw err;
      throw new RigPipelineError(`Start rig job failed: ${err.message}`, "START_FAILED");
    } finally {
      conn.release();
    }
  }

  // ── 2. Background Attempt Processing ──────────────────────────────────────

  async processAttempt(
    ownerId: string,
    jobUuid: string,
    attemptId: number,
    accessoryUuids: string[] = [],
  ): Promise<void> {
    const pool = this.getPoolFn();
    const leaseOwner = `worker-${process.pid}-${Date.now()}`;
    let job: any = null;
    let persisted: PersistedRigResult | null = null;
    let heartbeat: { stop: () => void; leaseLost: () => boolean } = { stop: () => {}, leaseLost: () => false };
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const claimed = await claimRigLease(conn, attemptId, leaseOwner, new Date(Date.now() + DEFAULT_RIG_LEASE_DURATION_MS));
      if (!claimed) {
        await conn.commit();
        return;
      }

      job = await findRigJobByUuidForUpdate(conn, jobUuid);
      if (!job || TERMINAL_RIG_JOB_STATES.includes(job.state as any)) {
        await releaseRigLease(conn, attemptId, leaseOwner);
        await conn.commit();
        return;
      }

      await updateRigAttemptState(conn, attemptId, "submitted", {
        provider: "blender",
        startedAt: new Date(),
      });
      await updateRigJobState(conn, job.id, "submitted");
      await conn.commit();
    } catch (err: any) {
      await conn.rollback();
      console.error(`[rig-pipeline] Error claiming attempt ${attemptId}:`, err.message);
      return;
    } finally {
      conn.release();
    }

    heartbeat = this.startLeaseHeartbeat(attemptId, leaseOwner);
    try {
      const attempt = await findRigAttemptById(pool, attemptId);
      const classification = await findClassificationByJobId(pool, job.model_build_job_id);
      const sourceVersion = await findVersionById(pool, Number(job.source_version_id));
      const sourceAsset = sourceVersion ? await findAssetById(pool, sourceVersion.asset_id) : null;
      if (!attempt || !classification || !sourceVersion || !sourceAsset) {
        throw new RigPipelineError("Rig source lineage is incomplete", "SOURCE_LINEAGE_MISSING");
      }
      if (classification.classification !== "biped" && classification.classification !== "quadruped") {
        throw new RigPipelineError("Measured classification is not riggable", "UNSUPPORTED_GEOMETRY");
      }
      if (sourceAsset.owner_id !== ownerId || job.owner_id !== ownerId) {
        throw new RigPipelineError("Rig source ownership changed", "FORBIDDEN");
      }

      const existingWorkerAttempt = await findRigWorkerAttemptByRigAttemptId(pool, attemptId);
      if (existingWorkerAttempt?.state === "persisted") {
        const output = await findRigAttemptArtifact(pool, attemptId, "rigged_glb");
        if (output) {
          await this.releaseAttemptLease(attemptId, leaseOwner);
          return;
        }
        throw new RigPipelineError("Persisted worker attempt is missing its canonical output", "ARTIFACT_NOT_FOUND");
      }

      const attemptUuid = existingWorkerAttempt?.attempt_uuid || crypto.randomUUID();
      const accessoryInputs = await this.resolveAccessoryInputs(ownerId, accessoryUuids);
      const stableRequest = {
        contractVersion: 1,
        jobUuid,
        attemptUuid,
        idempotencyKey: String(attempt.idempotency_key),
        profileId: String(classification.selected_profile_id),
        classification: classification.classification as "biped" | "quadruped",
        requestFacial: Boolean(job.request_facial),
        source: { assetId: sourceAsset.id, versionId: sourceVersion.id, sha256: sourceVersion.sha256, sizeBytes: sourceVersion.size_bytes },
        accessories: accessoryInputs.map((item) => ({
          accessoryUuid: item.record.accessory_uuid,
          assetId: item.asset.id,
          versionId: item.version.id,
          sha256: item.version.sha256,
          sizeBytes: item.version.size_bytes,
        })),
      };
      const requestHash = canonicalWorkerHash(stableRequest);
      const request = createRigWorkerRequest({
        jobUuid,
        attemptUuid,
        idempotencyKey: String(attempt.idempotency_key),
        profileId: String(classification.selected_profile_id),
        classification: classification.classification as "biped" | "quadruped",
        requestFacial: Boolean(job.request_facial),
        source: {
          locator: await this.signVersion(sourceAsset, sourceVersion, ownerId),
          sha256: sourceVersion.sha256,
          sizeBytes: sourceVersion.size_bytes,
        },
        accessories: await Promise.all(accessoryInputs.map(async (item) => ({
          accessoryUuid: item.record.accessory_uuid,
          attachmentBone: item.record.attachment_bone,
          locator: await this.signVersion(item.asset, item.version, ownerId),
          sha256: item.version.sha256,
          sizeBytes: item.version.size_bytes,
        }))),
      });

      const submitted = await pool.getConnection();
      try {
        await submitted.beginTransaction();
        if (!existingWorkerAttempt) {
          await insertRigWorkerAttempt(submitted, {
            rigAttemptId: attemptId,
            attemptUuid,
            contractVersion: 1,
            profileId: request.profileId,
            sourceSha256: request.source.sha256,
            requestHash,
            requestJson: stableRequest,
          });
        }
        await updateRigWorkerAttempt(submitted, attemptId, "submitted");
        await insertRigWorkerEvent(submitted, {
          eventUuid: crypto.randomUUID(),
          rigAttemptId: attemptId,
          eventType: "submitted",
          payloadHash: requestHash,
        });
        await updateRigAttemptState(submitted, attemptId, "rigging");
        await updateRigJobState(submitted, job.id, "rigging");
        await submitted.commit();
      } catch (error) {
        await submitted.rollback();
        throw error;
      } finally {
        submitted.release();
      }

      const result = await this.worker.process(request);
      if (heartbeat.leaseLost()) throw new RigPipelineError("Rig attempt lease was lost while the worker was running", "RIG_LEASE_LOST");
      const outputBuffer = verifyWorkerOutput(request, result);
      const reopenedGlb = await inspectRiggedGlb(outputBuffer, result);
      const verifiedPrint = await verifyFusedPrintOutput(request, result, outputBuffer);
      const resultHash = canonicalWorkerHash(compactWorkerEvidence(result));
      const { report, metricsHash } = validateRigGeometry({
        boneCount: result.rig.metrics.boneCount,
        jointCount: result.rig.metrics.jointCount,
        skinnedVertexCount: result.rig.metrics.skinnedVertexCount,
        maxInfluencesPerVertex: result.rig.metrics.maxInfluences,
        unweightedIslands: result.rig.metrics.unweightedIslands,
        bindMatrixValid: result.rig.metrics.bindMatrixValid,
        animationSweepPass: result.rig.metrics.animationSweepPass,
        silhouetteDeviation: result.rig.metrics.silhouetteDeviation,
        triangleCount: result.rig.metrics.triangleCount,
        textureMaxDimension: result.rig.metrics.textureMaxDimension,
        boneNames: result.rig.metrics.boneNames,
      });
      const allRules = [
        ...report.rules,
        ...result.rig.rules.map((rule) => ({ ...rule, rule: `worker:${rule.rule}` })),
        ...result.facial.rules.map((rule) => ({ ...rule, rule: `facial:${rule.rule}` })),
      ];
      if (!result.rig.overallPass || allRules.some((rule) => !rule.pass)) {
        throw new RigPipelineError("Measured rig or facial validation failed", "VALIDATION_FAILED");
      }
      if (["full", "partial"].includes(result.facial.capability)) {
        const roles = new Set(result.renders.map((render) => render.role));
        if (!roles.has("facial_render_front") || !roles.has("facial_render_three_quarter")) {
          throw new RigPipelineError("Measured facial capability requires both deformation renders", "FACIAL_EVIDENCE_MISSING");
        }
      }

      const passedVisemes = new Set(
        result.facial.targets
          .filter((target) => target.deformationPass && target.localityPass && target.canonicalName)
          .map((target) => target.canonicalName),
      );
      const visemeCoverage = ["A", "B", "C", "D", "E", "F", "G", "H", "X"]
        .filter((viseme) => passedVisemes.has(viseme)).length / 9;
      const facialDeformationPass = ["full", "partial"].includes(result.facial.capability)
        && result.facial.targets.some((target) => target.deformationPass && target.localityPass);
      const manifestHash = canonicalWorkerHash({
        contractVersion: 1,
        jobUuid,
        attemptUuid,
        sourceSha256: request.source.sha256,
        outputSha256: result.output.sha256,
        resultHash,
        localMetricsHash: metricsHash,
        reopenedGlb,
        fusedPrint: verifiedPrint ? {
          sha256: result.fusedPrint!.sha256,
          sizeBytes: result.fusedPrint!.sizeBytes,
          inspection: verifiedPrint.inspection,
          metrics: result.fusedPrint!.metrics,
          rules: result.fusedPrint!.rules,
        } : null,
        fusedPrintFailure: result.fusedPrintFailure || null,
        rules: allRules,
        facial: compactWorkerEvidence(result).facial,
        renders: result.renders.map((render) => ({ role: render.role, sha256: render.sha256, sizeBytes: render.sizeBytes })),
      });
      const manifestDocument = {
        contractVersion: 1,
        jobUuid,
        attemptUuid,
        sourceSha256: request.source.sha256,
        outputSha256: result.output.sha256,
        workerResultHash: resultHash,
        metricsHash: manifestHash,
        validatorVersion: report.validatorVersion,
        reopenedGlb,
        fusedPrint: verifiedPrint ? {
          sha256: result.fusedPrint!.sha256,
          sizeBytes: result.fusedPrint!.sizeBytes,
          inspection: verifiedPrint.inspection,
          metrics: result.fusedPrint!.metrics,
          rules: result.fusedPrint!.rules,
        } : null,
        fusedPrintFailure: result.fusedPrintFailure || null,
        rig: { ...report, rules: allRules },
        facial: compactWorkerEvidence(result).facial,
        renders: result.renders.map((render) => ({ role: render.role, sha256: render.sha256, sizeBytes: render.sizeBytes })),
        warnings: result.warnings,
      };

      persisted = await persistRigWorkerResult({
        pool,
        ownerId,
        jobUuid,
        attemptUuid,
        sourceAsset,
        sourceVersion,
        outputBuffer,
        fusedPrintBuffer: verifiedPrint?.buffer || null,
        accessorySources: accessoryInputs.map(({ asset, version }) => ({ asset, version })),
        result,
        manifest: manifestDocument,
      });

      const saved = await pool.getConnection();
      try {
        await saved.beginTransaction();
        await insertRigValidationManifest(saved, {
          rigAttemptId: attemptId,
          validatorVersion: report.validatorVersion,
          boneCount: report.boneCount,
          skinnedVertexCount: report.skinnedVertexCount,
          maxInfluences: report.maxInfluences,
          unweightedIslands: report.unweightedIslands,
          bindMatrixValid: report.bindMatrixValid,
          animationSweepPass: report.animationSweepPass,
          silhouetteDeviation: report.silhouetteDeviation,
          mobileBudgetPass: report.mobileBudgetPass,
          triangleCount: report.triangleCount,
          textureMaxDimension: report.textureMaxDimension,
          jointCount: report.jointCount,
          rulesJson: allRules,
          metricsHash: manifestHash,
        });
        await insertFacialInventory(saved, {
          rigJobId: job.id,
          rigAttemptId: attemptId,
          capability: result.facial.capability,
          morphCount: result.facial.targets.length,
          visemeCoverage,
          hasBlink: result.facial.hasBlink,
          hasJaw: result.facial.hasJaw,
          hasEyeControls: result.facial.hasEyeControls,
          morphNamesJson: result.facial.targets.map((target) => target.name),
          canonicalMapJson: result.facial.canonicalMap,
          deformationPass: facialDeformationPass,
          notes: result.facial.capability === "body_only"
            ? "Body rig passed; no measured facial deformation was accepted."
            : `${Math.round(visemeCoverage * 100)}% canonical viseme coverage passed measured deformation.`,
        });
        for (const artifact of [persisted.output, persisted.fusedPrint, persisted.manifest, ...persisted.renders]) {
          if (!artifact) continue;
          await insertRigAttemptArtifact(saved, {
            rigAttemptId: attemptId,
            artifactKey: artifact.artifactKey,
            role: artifact.role,
            assetId: artifact.asset.id,
            assetVersionId: artifact.version.id,
            computedHash: artifact.stored.sha256,
            sizeBytes: artifact.stored.sizeBytes,
            mimeType: artifact.mimeType,
            evidence: artifact.role === "fused_print_glb" ? {
              overallPass: result.fusedPrint?.overallPass,
              validatorVersion: result.fusedPrint?.validatorVersion,
              metrics: result.fusedPrint?.metrics,
              rules: result.fusedPrint?.rules,
            } : null,
          });
        }
        for (const fit of result.accessories) {
          const source = accessoryInputs.find((item) => item.record.accessory_uuid === fit.accessoryUuid);
          if (!source) throw new RigPipelineError("Worker returned an unrequested accessory", "ACCESSORY_RESULT_MISMATCH");
          await insertAccessoryFit(saved, {
            fitUuid: crypto.randomUUID(),
            rigJobId: job.id,
            accessoryId: source.record.id,
            attachmentBone: fit.attachmentBone,
            transformJson: fit.transform,
            floatingDistance: fit.floatingDistance,
            penetrationDepth: fit.penetrationDepth,
            animationSweepPass: fit.animationSweepPass,
            polygonBudgetPass: fit.polygonBudgetPass,
            printClearanceMm: fit.printClearanceMm,
          });
        }
        await updateRigWorkerAttempt(saved, attemptId, "persisted", { responseHash: resultHash, warnings: result.warnings });
        await insertRigWorkerEvent(saved, {
          eventUuid: crypto.randomUUID(),
          rigAttemptId: attemptId,
          eventType: "persisted",
          payloadHash: resultHash,
        });
        await updateRigAttemptState(saved, attemptId, "ready", { completedAt: new Date() });
        await updateRigJobState(saved, job.id, "ready", { acceptedArtifactId: persisted.output.asset.id });
        await releaseRigLease(saved, attemptId, leaseOwner);
        await saved.commit();
      } catch (error) {
        await saved.rollback();
        throw error;
      } finally {
        saved.release();
      }
    } catch (err: any) {
      if (persisted) await cleanupPersistedRigResult(pool, persisted);
      if (heartbeat.leaseLost()) {
        console.warn(`[rig-pipeline] Attempt ${attemptId} lost its lease; stale worker result was discarded`);
      } else {
        await this.handleAttemptFailure(job.id, attemptId, normalizeRigFailureCode(err), err.message || String(err), leaseOwner);
      }
    } finally {
      heartbeat.stop();
    }
  }

  async retryRigJob(
    ownerId: string,
    jobUuid: string,
    params: { idempotencyKey: string; accessoryUuids?: string[] },
  ): Promise<RigJobPublic> {
    assertRigPipelineV4Enabled();
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();
    let attemptId = 0;
    try {
      await conn.beginTransaction();
      const job = await findRigJobByUuidForUpdate(conn, jobUuid);
      if (!job) throw new RigPipelineError("Job not found", "NOT_FOUND");
      if (job.owner_id !== ownerId) throw new RigPipelineError("Not authorized", "FORBIDDEN");
      const attempts = await findRigAttemptsByJobId(conn, job.id);
      if (attempts.some((attempt) => attempt.idempotency_key === params.idempotencyKey)) {
        await conn.commit();
        return this.getJobPublic(ownerId, jobUuid);
      }
      if (!["failed_rig", "failed_validation"].includes(job.state)) {
        throw new RigPipelineError(`Cannot retry job in state '${job.state}'`, "INVALID_STATE");
      }
      if (attempts.length >= MAX_RIG_ATTEMPTS) throw new RigPipelineError("Maximum rig attempts reached", "MAX_ATTEMPTS");
      attemptId = await insertRigAttempt(conn, {
        jobId: job.id,
        attemptNumber: attempts.length + 1,
        idempotencyKey: params.idempotencyKey,
      });
      await updateRigJobState(conn, job.id, "queued", {
        currentAttemptId: attemptId,
        failureCode: null,
        acceptedArtifactId: null,
      });
      await conn.commit();
      this.processAttempt(ownerId, jobUuid, attemptId, params.accessoryUuids || []).catch((error) => {
        console.error(`[rig-pipeline] Retry processing failed for ${jobUuid}:`, error.message);
      });
      return this.getJobPublic(ownerId, jobUuid);
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async recoverStaleRigJobs(): Promise<{ expiredLeases: number; recoveredJobs: string[] }> {
    const pool = this.getPoolFn();
    const stale = await findStaleRigAttempts(pool);
    const recoveredJobs: string[] = [];
    for (const attempt of stale) {
      const workerAttempt = await findRigWorkerAttemptByRigAttemptId(pool, Number(attempt.id));
      const saved = parseJsonRecord(workerAttempt?.request_json);
      const accessoryUuids = Array.isArray(saved.accessories)
        ? saved.accessories.map((item: any) => item?.accessoryUuid).filter((value: unknown): value is string => typeof value === "string")
        : [];
      await this.processAttempt(String(attempt.owner_id), String(attempt.job_uuid), Number(attempt.id), accessoryUuids);
      recoveredJobs.push(String(attempt.job_uuid));
    }
    return { expiredLeases: stale.length, recoveredJobs };
  }

  private async handleAttemptFailure(jobId: number, attemptId: number, code: string, detail: string, leaseOwner?: string): Promise<void> {
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await updateRigAttemptState(conn, attemptId, "failed", { failureCode: code, failureDetail: detail, completedAt: new Date() });
      await updateRigJobState(conn, jobId, code === "VALIDATION_FAILED" ? "failed_validation" : "failed_rig", { failureCode: code });
      await updateRigWorkerAttempt(conn, attemptId, "failed").catch(() => {});
      if (leaseOwner) await releaseRigLease(conn, attemptId, leaseOwner);
      await conn.commit();
    } finally {
      conn.release();
    }
  }

  private async releaseAttemptLease(attemptId: number, leaseOwner: string): Promise<void> {
    const conn = await this.getPoolFn().getConnection();
    try {
      await conn.beginTransaction();
      await releaseRigLease(conn, attemptId, leaseOwner);
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  private startLeaseHeartbeat(attemptId: number, leaseOwner: string): { stop: () => void; leaseLost: () => boolean } {
    let lost = false;
    const timer = setInterval(() => {
      renewRigLease(
        this.getPoolFn(),
        attemptId,
        leaseOwner,
        new Date(Date.now() + DEFAULT_RIG_LEASE_DURATION_MS),
      ).then((renewed) => {
        if (!renewed) lost = true;
      }).catch((error) => {
        console.error(`[rig-pipeline] Lease heartbeat failed for attempt ${attemptId}:`, (error as Error).message);
      });
    }, Math.max(30_000, Math.floor(DEFAULT_RIG_LEASE_DURATION_MS / 3)));
    timer.unref();
    return { stop: () => clearInterval(timer), leaseLost: () => lost };
  }

  private async resolveAccessoryInputs(ownerId: string, accessoryUuids: string[]): Promise<Array<{
    record: any;
    asset: AssetRecord;
    version: AssetVersionRecord;
  }>> {
    const pool = this.getPoolFn();
    const unique = [...new Set(accessoryUuids)];
    const resolved = [];
    for (const uuid of unique) {
      const record = await findAccessoryByUuid(pool, uuid);
      if (!record) throw new RigPipelineError(`Accessory ${uuid} was not found`, "ACCESSORY_NOT_FOUND");
      if (record.owner_id !== ownerId) throw new RigPipelineError("Accessory access denied", "FORBIDDEN");
      const version = await findVersionById(pool, Number(record.asset_version_id));
      const asset = version ? await findAssetById(pool, version.asset_id) : null;
      if (!asset || !version || asset.owner_id !== ownerId || asset.status !== "active") {
        throw new RigPipelineError("Accessory canonical version is unavailable", "INVALID_ASSET");
      }
      resolved.push({ record, asset, version });
    }
    return resolved;
  }

  // ── 3. Accept Rig Job ─────────────────────────────────────────────────────

  async acceptRigJob(
    ownerId: string,
    jobUuid: string,
    params: { manifestHash: string },
  ): Promise<RigJobPublic> {
    assertRigPipelineV4Enabled();
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();
      const job = await findRigJobByUuidForUpdate(conn, jobUuid);
      if (!job) throw new RigPipelineError("Job not found", "NOT_FOUND");
      if (job.owner_id !== ownerId) throw new RigPipelineError("Not authorized", "FORBIDDEN");
      if (job.state !== "ready" || !job.current_attempt_id) {
        throw new RigPipelineError("Rig job is not in ready state for acceptance", "INVALID_STATE");
      }

      const manifest = await findManifestByAttemptId(conn, job.current_attempt_id);
      if (!manifest) throw new RigPipelineError("Validation manifest not found", "MANIFEST_NOT_FOUND");

      const rules = parseRules(manifest.rules_json);
      const outputArtifact = await findRigAttemptArtifact(conn, job.current_attempt_id, "rigged_glb");
      const outputAsset = outputArtifact ? await findAssetById(conn, Number(outputArtifact.asset_id)) : null;
      const outputVersion = outputArtifact ? await findVersionById(conn, Number(outputArtifact.asset_version_id)) : null;
      const outputIntegrityPass = Boolean(
        outputArtifact
        && outputAsset
        && outputVersion
        && outputAsset.owner_id === ownerId
        && outputAsset.status === "active"
        && Number(outputArtifact.asset_id) === Number(job.accepted_artifact_id)
        && outputVersion.asset_id === outputAsset.id
        && outputVersion.sha256 === outputArtifact.computed_hash
        && outputVersion.size_bytes === Number(outputArtifact.size_bytes)
        && outputVersion.mime_type === "model/gltf-binary",
      );
      if (!outputIntegrityPass || rules.length === 0 || rules.some((rule) => !rule.pass)) {
        throw new RigPipelineError("Rig output or validation evidence is incomplete", "VALIDATION_FAILED");
      }

      const printArtifact = await findRigAttemptArtifact(conn, job.current_attempt_id, "fused_print_glb");
      if (printArtifact) {
        const printAsset = await findAssetById(conn, Number(printArtifact.asset_id));
        const printVersion = await findVersionById(conn, Number(printArtifact.asset_version_id));
        const evidence = parseJsonRecord(printArtifact.evidence_json);
        const printRules = Array.isArray(evidence.rules) ? evidence.rules : [];
        const printIntegrityPass = Boolean(
          printAsset
          && printVersion
          && printAsset.owner_id === ownerId
          && printAsset.status === "active"
          && printVersion.asset_id === printAsset.id
          && printVersion.sha256 === printArtifact.computed_hash
          && printVersion.sha256 !== outputVersion?.sha256
          && printVersion.size_bytes === Number(printArtifact.size_bytes)
          && printVersion.mime_type === "model/gltf-binary"
          && evidence.overallPass === true
          && printRules.length > 0
          && printRules.every((rule: any) => rule?.pass === true),
        );
        if (!printIntegrityPass) {
          throw new RigPipelineError("Fused print artifact or validation evidence is incomplete", "VALIDATION_FAILED");
        }
      }

      if (manifest.metrics_hash !== params.manifestHash) {
        throw new RigPipelineError("Manifest hash mismatch", "HASH_MISMATCH");
      }

      await insertRigAcceptance(conn, {
        rigJobId: job.id,
        rigAttemptId: job.current_attempt_id,
        manifestId: manifest.id,
        acceptedByUser: ownerId,
        manifestHash: params.manifestHash,
      });

      await updateRigJobState(conn, job.id, "accepted");

      await conn.commit();
      return this.getJobPublic(ownerId, jobUuid);
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof RigPipelineError) throw err;
      throw new RigPipelineError(`Accept rig failed: ${err.message}`, "ACCEPT_FAILED");
    } finally {
      conn.release();
    }
  }

  // ── 4. Public DTO Hydration ───────────────────────────────────────────────

  async getJobPublic(ownerId: string, jobUuid: string): Promise<RigJobPublic> {
    assertRigPipelineV4Enabled();
    const pool = this.getPoolFn();
    const job = await findRigJobByUuid(pool, jobUuid);
    if (!job) throw new RigPipelineError("Job not found", "NOT_FOUND");
    if (job.owner_id !== ownerId) throw new RigPipelineError("Not authorized", "FORBIDDEN");

    const classRec = await findClassificationByJobId(pool, job.model_build_job_id);
    let manifestData = null;
    let facialData = null;

    if (job.current_attempt_id) {
      const manifest = await findManifestByAttemptId(pool, job.current_attempt_id);
      if (manifest) {
        const rules = typeof manifest.rules_json === "string" ? JSON.parse(manifest.rules_json) : manifest.rules_json;
        manifestData = {
          boneCount: manifest.bone_count,
          maxInfluences: manifest.max_influences,
          mobileBudgetPass: Boolean(manifest.mobile_budget_pass),
          animationSweepPass: Boolean(manifest.animation_sweep_pass),
          overallPass: rules.length > 0 && rules.every((rule: any) => Boolean(rule.pass)),
          rules,
        };
      }

      const facial = await findFacialInventoryByAttemptId(pool, job.current_attempt_id);
      if (facial) {
        facialData = {
          capability: facial.capability as FacialCapability,
          morphCount: facial.morph_count,
          visemeCoverage: Number(facial.viseme_coverage),
          hasBlink: Boolean(facial.has_blink),
          hasJaw: Boolean(facial.has_jaw),
          hasEyeControls: Boolean(facial.has_eye_controls),
          deformationPass: Boolean(facial.deformation_pass),
        };
      }
    }

    const fitRows = await findFitsByRigJobId(pool, job.id);
    const accessories = fitRows.map((f: any) => ({
      fitUuid: f.fit_uuid,
      accessoryName: f.accessory_name || "Accessory",
      attachmentBone: f.attachment_bone,
      floatingDistance: Number(f.floating_distance),
      penetrationDepth: Number(f.penetration_depth),
      animationSweepPass: Boolean(f.animation_sweep_pass),
      polygonBudgetPass: Boolean(f.polygon_budget_pass),
      printClearanceMm: Number(f.print_clearance_mm),
      status: f.status,
    }));

    let outputArtifact = null;
    let fusedPrintArtifact = null;
    if (job.current_attempt_id) {
      const artifact = await findRigAttemptArtifact(pool, job.current_attempt_id, "rigged_glb");
      if (artifact) {
        const asset = await findAssetById(pool, Number(artifact.asset_id));
        const version = await findVersionById(pool, Number(artifact.asset_version_id));
        if (asset && version && asset.owner_id === ownerId) {
          let signedUrl: string | undefined;
          try { signedUrl = await this.signVersion(asset, version, ownerId); } catch { /* metadata remains usable */ }
          outputArtifact = {
            assetUuid: asset.asset_uuid,
            versionNumber: version.version_number,
            sha256: artifact.computed_hash,
            sizeBytes: Number(artifact.size_bytes),
            ...(signedUrl ? { signedUrl } : {}),
          };
        }
      }
      const printArtifact = await findRigAttemptArtifact(pool, job.current_attempt_id, "fused_print_glb");
      if (printArtifact) {
        const asset = await findAssetById(pool, Number(printArtifact.asset_id));
        const version = await findVersionById(pool, Number(printArtifact.asset_version_id));
        const evidence = parseJsonRecord(printArtifact.evidence_json);
        if (asset && version && asset.owner_id === ownerId && evidence.overallPass === true) {
          let signedUrl: string | undefined;
          try { signedUrl = await this.signVersion(asset, version, ownerId); } catch { /* metadata remains usable */ }
          fusedPrintArtifact = {
            assetUuid: asset.asset_uuid,
            versionNumber: version.version_number,
            sha256: printArtifact.computed_hash,
            sizeBytes: Number(printArtifact.size_bytes),
            printReady: true as const,
            ...(signedUrl ? { signedUrl } : {}),
          };
        }
      }
    }

    return {
      jobUuid: job.job_uuid,
      state: job.state as RigJobState,
      classification: classRec ? (classRec.classification as ClassificationType) : null,
      selectedProfile: classRec ? classRec.selected_profile_id : null,
      facialCapability: facialData ? facialData.capability : null,
      rigValidation: manifestData,
      facialInventory: facialData,
      accessories,
      outputArtifact,
      fusedPrintArtifact,
      manifestHash: manifestData && job.current_attempt_id
        ? (await findManifestByAttemptId(pool, job.current_attempt_id))?.metrics_hash || null
        : null,
      failureCode: job.failure_code || null,
      createdAt: new Date(job.created_at).toISOString(),
      updatedAt: new Date(job.updated_at).toISOString(),
    };
  }
}

function parseJsonRecord(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return typeof value === "object" ? value as Record<string, any> : {};
}

function finiteNonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseDimensions(value: unknown): { x: number; y: number; z: number } {
  const dimensions = parseJsonRecord(value);
  return {
    x: finiteNonNegative(dimensions.width),
    y: finiteNonNegative(dimensions.height),
    z: finiteNonNegative(dimensions.depth),
  };
}

function profileForClassification(classification: ClassificationType): string {
  if (classification === "biped") return "biped.standard";
  if (classification === "quadruped") return "quadruped.dog.medium";
  return "unsupported.static";
}

function profileMatchesClassification(profileId: string, classification: ClassificationType): boolean {
  return profileId === "unsupported.static"
    ? classification === "unsupported"
    : profileId.startsWith(`${classification}.`);
}

function parseRules(value: unknown): Array<{ pass: boolean }> {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return []; } })() : value;
  return Array.isArray(parsed) ? parsed.filter((rule) => rule && typeof rule === "object") as Array<{ pass: boolean }> : [];
}

function compactWorkerEvidence(result: RigWorkerResult): Record<string, unknown> {
  return {
    contractVersion: result.contractVersion,
    jobUuid: result.jobUuid,
    attemptUuid: result.attemptUuid,
    sourceSha256: result.sourceSha256,
    output: { sha256: result.output.sha256, sizeBytes: result.output.sizeBytes },
    fusedPrint: result.fusedPrint ? {
      sha256: result.fusedPrint.sha256,
      sizeBytes: result.fusedPrint.sizeBytes,
      validatorVersion: result.fusedPrint.validatorVersion,
      metrics: result.fusedPrint.metrics,
      rules: result.fusedPrint.rules,
      overallPass: result.fusedPrint.overallPass,
    } : null,
    fusedPrintFailure: result.fusedPrintFailure || null,
    rig: result.rig,
    facial: result.facial,
    renders: result.renders.map((render) => ({ role: render.role, sha256: render.sha256, sizeBytes: render.sizeBytes })),
    accessories: result.accessories.map(({ glbBase64: _bytes, ...accessory }) => accessory),
    warnings: result.warnings,
  };
}

function normalizeRigFailureCode(error: unknown): string {
  if (error instanceof RigPipelineError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  if (/WORKER_SHARED_SECRET|fetch failed|ECONN|ENOTFOUND|abort|timed? out/i.test(message)) return "RIG_WORKER_UNAVAILABLE";
  if (/Rig worker failed/i.test(message)) return "RIG_WORKER_REJECTED";
  if (/hash mismatch|byte count|GLB|facial targets|joint count|skin binding|scene geometry|non-finite|fused print|watertight|topology/i.test(message)) {
    return "RIG_WORKER_OUTPUT_INVALID";
  }
  if (/storage|asset|lineage|persist/i.test(message)) return "RIG_PERSISTENCE_FAILED";
  return "RIG_PROCESSING_FAILED";
}
