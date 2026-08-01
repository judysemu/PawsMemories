import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import type mysql from "mysql2/promise";
import sharp from "sharp";
import { getPool } from "../../db";
import { getPrivateObjectBuffer } from "../../storage.private";
import { addLineage, registerAsset } from "../assets/service";
import { generateSignedUrlForVersion } from "../assets/access";
import { findAssetById, findVersionById, hardDeleteUnpublishedAsset } from "../assets/repository";
import {
  CreateSessionSchema,
  StartAttemptSchema,
  RetryAttemptSchema,
  ApproveManifestSchema,
  type CreateSessionInput,
} from "./schemas";
import {
  insertSession,
  findSessionByUuid,
  findSessionByUuidForUpdate,
  findSessionsByOwner,
  updateSessionState,
  insertAttempt,
  findAttemptById,
  findAttemptsBySessionId,
  findAttemptByIdempotencyKey,
  updateAttemptState,
  updateAttemptProvider,
  updateSessionSource,
  insertView,
  findViewsByAttemptId,
  insertReport,
  findReportByAttemptId,
  insertApproval,
  findApprovalBySessionId,
} from "./repository";
import { storeReferenceImage, storeReferenceSource, storeReferenceReport, storeReferenceManifest, cleanupReferenceImage } from "./storage";
import { evaluateReferenceConsistency } from "./consistency";
import { inspectReferenceImage, type ReferenceImageProvider } from "./provider";
import type {
  ReferenceSessionRecord,
  ReferenceAttemptRecord,
  ReferenceViewRecord,
  SessionPublic,
  ViewItemPublic,
  ReportPublic,
  ViewKind,
  ORDERED_VIEW_KINDS,
} from "./types";

export class ReferenceSessionError extends Error {
  constructor(message: string, public code: string = "REFERENCE_SESSION_ERROR") {
    super(message);
    this.name = "ReferenceSessionError";
  }
}

function decodeBase64Image(value: string): Buffer {
  const normalized = value.replace(/^data:image\/(?:png|jpeg|webp);base64,/i, "").replace(/\s/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new ReferenceSessionError("Source image is not valid base64.", "INVALID_SOURCE_IMAGE");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) throw new ReferenceSessionError("Source image is empty.", "INVALID_SOURCE_IMAGE");
  return buffer;
}

export function computeOrderedManifestHash(
  views: { viewKind: ViewKind; assetUuid: string; sha256: string }[],
  reportHash: string,
): string {
  const ordered = ["front", "left", "right", "rear", "front_three_quarter"] as const;
  const parts: string[] = [];

  for (const kind of ordered) {
    const found = views.find((v) => v.viewKind === kind);
    if (!found) {
      throw new ReferenceSessionError(`Missing required view kind: ${kind}`, "INCOMPLETE_MANIFEST");
    }
    parts.push(`${kind}:${found.assetUuid}:${found.sha256}`);
  }

  if (!/^[a-f0-9]{64}$/i.test(reportHash)) {
    throw new ReferenceSessionError("A canonical report hash is required.", "INCOMPLETE_MANIFEST");
  }
  return crypto.createHash("sha256").update(`${parts.join("|")}|report:${reportHash.toLowerCase()}`).digest("hex");
}

export class ReferenceSessionService {
  constructor(
    private provider: ReferenceImageProvider,
    private getPoolFn: () => mysql.Pool = getPool,
  ) {}

  async createSession(
    ownerId: string,
    input: CreateSessionInput,
  ): Promise<ReferenceSessionRecord> {
    const validated = CreateSessionSchema.parse(input);
    const pool = this.getPoolFn();
    const sessionUuid = uuidv4();

    let sourceAsset: { id: number; versionId: number } | null = null;
    let sourceObjectKey: string | null = null;
    if (validated.inputMode === "photo") {
      const encodedImages = validated.sourceImagesBase64?.length
        ? validated.sourceImagesBase64
        : [validated.sourceImageBase64!];
      const mimeTypes = validated.sourceMimeTypes?.length
        ? validated.sourceMimeTypes
        : [validated.sourceMimeType!];
      const inspectedInputs = await Promise.all(encodedImages.map(async (encoded, index) => {
        const imageBuffer = decodeBase64Image(encoded);
        const inspected = await inspectReferenceImage(imageBuffer, mimeTypes[index] || mimeTypes[0], 1);
        return { imageBuffer, ...inspected };
      }));
      const imageBuffer = inspectedInputs.length === 1
        ? inspectedInputs[0].imageBuffer
        : await sharp({
          create: { width: 2048, height: 2048, channels: 3, background: "#f5f5f5" },
        }).composite(await Promise.all(inspectedInputs.slice(0, 4).map(async ({ imageBuffer }, index) => ({
          input: await sharp(imageBuffer).resize(1024, 1024, { fit: "contain", background: "#ffffff" }).png().toBuffer(),
          left: (index % 2) * 1024,
          top: Math.floor(index / 2) * 1024,
        })))).png().toBuffer();
      const imageMimeType = inspectedInputs.length === 1 ? inspectedInputs[0].mimeType : "image/png";
      // User uploads only need to decode safely. Gemini generates the canonical
      // high-resolution approval views, which retain the stricter 1024px gate.
      const inspected = await inspectReferenceImage(imageBuffer, imageMimeType, 1);
      const stored = await storeReferenceSource(sessionUuid, imageBuffer, inspected.mimeType);
      sourceObjectKey = stored.objectKey;
      try {
        const registered = await registerAsset({
          ownerId,
          assetType: "reference_source_photo",
          visibility: "private",
          mimeType: inspected.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          bucket: "private",
          objectKey: stored.objectKey,
          metadata: { sessionUuid, widthPx: inspected.widthPx, heightPx: inspected.heightPx },
          sourceProvider: "user_upload",
          license: "user_supplied",
          commercialUseEligible: false,
        }, { authorization: { internal: true }, isNewObjectUpload: false, pool });
        sourceAsset = { id: registered.asset.id, versionId: registered.version.id };
      } catch (error) {
        await cleanupReferenceImage(stored.objectKey);
        throw error;
      }
    }

    try {
      return await insertSession(pool, {
      sessionUuid,
      ownerId,
      inputMode: validated.inputMode,
      subjectClass: validated.subjectClass,
      prompt: validated.prompt,
        sourceAssetId: sourceAsset?.id,
        sourceAssetVersionId: sourceAsset?.versionId,
      });
    } catch (error) {
      if (sourceObjectKey) await cleanupReferenceImage(sourceObjectKey);
      if (sourceAsset) await hardDeleteUnpublishedAsset(pool, sourceAsset.id).catch(() => {});
      throw error;
    }
  }

  async replaceSourcePhoto(ownerId: string, sessionUuid: string, imageBase64: string, mimeType: string): Promise<ReferenceSessionRecord> {
    const pool = this.getPoolFn();
    const imageBuffer = decodeBase64Image(imageBase64);
    const inspected = await inspectReferenceImage(imageBuffer, mimeType, 1);
    const connection = await pool.getConnection();
    let storedKey: string | null = null;
    let registeredAssetId: number | null = null;
    try {
      await connection.beginTransaction();
      const session = await findSessionByUuidForUpdate(connection, sessionUuid);
      if (!session) throw new ReferenceSessionError("Session not found", "NOT_FOUND");
      if (session.owner_id !== ownerId) throw new ReferenceSessionError("Unauthorized", "UNAUTHORIZED");
      if (session.input_mode !== "photo") throw new ReferenceSessionError("Only photo sessions have a replaceable source.", "INVALID_INPUT_MODE");
      if (!["draft", "ready", "failed"].includes(session.state)) throw new ReferenceSessionError("Source cannot be replaced in the current state.", "INVALID_STATE");

      const stored = await storeReferenceSource(sessionUuid, imageBuffer, inspected.mimeType);
      storedKey = stored.objectKey;
      const registered = await registerAsset({
        ownerId, assetType: "reference_source_photo", visibility: "private", mimeType: inspected.mimeType,
        sizeBytes: stored.sizeBytes, sha256: stored.sha256, bucket: "private", objectKey: stored.objectKey,
        metadata: { sessionUuid, widthPx: inspected.widthPx, heightPx: inspected.heightPx },
        sourceProvider: "user_upload", license: "user_supplied", commercialUseEligible: false,
      }, { authorization: { internal: true }, isNewObjectUpload: false, pool });
      registeredAssetId = registered.asset.id;
      await updateSessionSource(connection, session.id, registered.asset.id, registered.version.id);
      await connection.commit();
      return (await findSessionByUuid(pool, sessionUuid))!;
    } catch (error) {
      await connection.rollback().catch(() => {});
      if (storedKey) await cleanupReferenceImage(storedKey);
      if (registeredAssetId) await hardDeleteUnpublishedAsset(pool, registeredAssetId).catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async startOrRetryAttempt(
    ownerId: string,
    sessionUuid: string,
    idempotencyKey: string,
    retryNotes?: string | null,
  ): Promise<{ session: ReferenceSessionRecord; attempt: ReferenceAttemptRecord }> {
    const pool = this.getPoolFn();
    const connection = await pool.getConnection();

    const createdObjectKeys: string[] = [];
    const createdAssetIds: number[] = [];

    try {
      await connection.beginTransaction();

      const session = await findSessionByUuidForUpdate(connection, sessionUuid);
      if (!session) throw new ReferenceSessionError("Reference session not found", "NOT_FOUND");

      if (session.owner_id !== ownerId) {
        throw new ReferenceSessionError("Unauthorized access to session", "UNAUTHORIZED");
      }

      // Check idempotency
      // Use a current/locking read so this check cannot establish a stale
      // REPEATABLE READ snapshot before the global budget query.
      const existingAttempt = await findAttemptByIdempotencyKey(connection, session.id, idempotencyKey, true);
      if (existingAttempt) {
        await connection.rollback();
        return { session, attempt: existingAttempt };
      }

      if (session.state === "approved") {
        throw new ReferenceSessionError("Session is already approved and immutable.", "SESSION_APPROVED");
      }
      if (!["draft", "ready", "failed"].includes(session.state)) {
        throw new ReferenceSessionError(`Session cannot start an attempt while ${session.state}.`, "INVALID_STATE");
      }
      const configuredMaxAttempts = Number(process.env.REFERENCE_GENERATION_MAX_ATTEMPTS || 2);
      const maxAttempts = Number.isSafeInteger(configuredMaxAttempts)
        ? Math.max(1, Math.min(3, configuredMaxAttempts))
        : 2;
      if (session.source_attempt_count >= maxAttempts) {
        throw new ReferenceSessionError(
          `This source photo has reached its ${maxAttempts}-attempt safety limit. Replace the source photo or create a new session to try again.`,
          "ATTEMPT_LIMIT_REACHED",
        );
      }

      const nextAttemptNumber = session.retry_count + 1;
      const promptConfigHash = crypto
        .createHash("sha256")
        .update(`${session.prompt || ""}:${retryNotes || ""}:${nextAttemptNumber}`)
        .digest("hex");

      const attempt = await insertAttempt(connection, {
        sessionId: session.id,
        attemptNumber: nextAttemptNumber,
        idempotencyKey,
        provider: this.provider.name,
        model: this.provider.model,
        promptConfigHash,
        retryNotes: retryNotes || null,
      });

      await updateSessionState(connection, session.id, "generating", {
        currentAttemptId: attempt.id,
        incrementRetry: true,
        incrementSourceAttempt: true,
      });

      await connection.commit();

      // Generate reference views via provider
      let photoBuffer: Buffer | null = null;
      let photoMimeType: string | null = null;
      if (session.input_mode === "photo") {
        if (!session.source_asset_version_id) throw new ReferenceSessionError("Photo session has no source image.", "MISSING_SOURCE");
        const sourceVersion = await findVersionById(pool, session.source_asset_version_id);
        if (!sourceVersion || sourceVersion.asset_id !== session.source_asset_id) throw new ReferenceSessionError("Source image reference is corrupt.", "CORRUPT_SOURCE");
        photoBuffer = await getPrivateObjectBuffer(sourceVersion.object_key);
        photoMimeType = sourceVersion.mime_type;
      }
      const genResult = await this.provider.generateMultiview(
        { prompt: session.prompt, photoBuffer, photoMimeType, retryNotes },
        session.input_mode,
      );
      const requiredKinds = new Set(["front", "left", "right", "rear", "front_three_quarter"]);
      if (genResult.views.length !== requiredKinds.size || new Set(genResult.views.map((view) => view.viewKind)).size !== requiredKinds.size || genResult.views.some((view) => !requiredKinds.has(view.viewKind))) {
        throw new ReferenceSessionError("Provider must return exactly one of each required view.", "INVALID_PROVIDER_OUTPUT");
      }
      for (const view of genResult.views) {
        const inspected = await inspectReferenceImage(view.imageBuffer, view.mimeType);
        view.widthPx = inspected.widthPx;
        view.heightPx = inspected.heightPx;
        view.mimeType = inspected.mimeType;
      }
      await updateAttemptProvider(pool, attempt.id, genResult.provider, genResult.model);

      // Store generated views and register canonical assets
      for (const viewPayload of genResult.views) {
        const stored = await storeReferenceImage(
          session.session_uuid,
          nextAttemptNumber,
          viewPayload.viewKind,
          viewPayload.imageBuffer,
          viewPayload.mimeType,
        );
        createdObjectKeys.push(stored.objectKey);

        const { asset, version } = await registerAsset(
          {
            ownerId,
            assetType: `reference_${viewPayload.viewKind}`,
            visibility: "private",
            mimeType: viewPayload.mimeType,
            sizeBytes: stored.sizeBytes,
            sha256: stored.sha256,
            bucket: "private",
            objectKey: stored.objectKey,
            metadata: {
              sessionUuid: session.session_uuid,
              attemptNumber: nextAttemptNumber,
              viewKind: viewPayload.viewKind,
            },
            sourceProvider: this.provider.name,
            license: "proprietary",
            commercialUseEligible: false,
          },
          { authorization: { internal: true }, isNewObjectUpload: false, pool },
        );
        createdAssetIds.push(asset.id);

        await insertView(pool, {
          attemptId: attempt.id,
          viewKind: viewPayload.viewKind,
          assetId: asset.id,
          assetVersionId: version.id,
          widthPx: viewPayload.widthPx,
          heightPx: viewPayload.heightPx,
          isSynthesized: viewPayload.isSynthesized,
        });
      }

      // Evaluate AI consistency report
      const { payload: reportPayload, hash: reportHash } = evaluateReferenceConsistency(
        genResult.views,
        session.input_mode,
      );

      const reportBytes = Buffer.from(JSON.stringify(reportPayload), "utf8");
      const storedReport = await storeReferenceReport(session.session_uuid, nextAttemptNumber, reportBytes);
      createdObjectKeys.push(storedReport.objectKey);
      const reportRegistration = await registerAsset({
        ownerId, assetType: "validation_report", visibility: "private", mimeType: "application/json",
        sizeBytes: storedReport.sizeBytes, sha256: storedReport.sha256, bucket: "private", objectKey: storedReport.objectKey,
        metadata: { sessionUuid: session.session_uuid, attemptNumber: nextAttemptNumber, reportHash },
        sourceProvider: "pawsome3d_reference_validation", license: "proprietary", commercialUseEligible: false,
      }, { authorization: { internal: true }, isNewObjectUpload: false, pool });
      createdAssetIds.push(reportRegistration.asset.id);

      await insertReport(pool, {
        attemptId: attempt.id,
        reportAssetId: reportRegistration.asset.id,
        reportAssetVersionId: reportRegistration.version.id,
        status: reportPayload.status,
        scaleConfidence: reportPayload.scaleConfidence,
        reportHash,
        metricsJson: reportPayload,
      });

      const persistedViews = await findViewsByAttemptId(pool, attempt.id);
      for (const view of persistedViews) {
        const viewAsset = await findAssetById(pool, view.asset_id);
        const viewVersion = await findVersionById(pool, view.asset_version_id);
        if (viewAsset && viewVersion) {
          await addLineage({
            parentAssetUuid: viewAsset.asset_uuid, parentVersionNumber: viewVersion.version_number,
            childAssetUuid: reportRegistration.asset.asset_uuid, childVersionNumber: reportRegistration.version.version_number,
            relationType: "derivative",
          }, { internal: true }, pool);
        }
      }

      await updateAttemptState(pool, attempt.id, "ready");
      await updateSessionState(pool, session.id, "ready");

      // A successful five-view result is finalized immediately. There is no
      // customer review pause; integrity and consistency evidence still bind
      // the exact immutable manifest used by the model build.
      const readyPublic = await this.getSessionPublic(sessionUuid, ownerId, false);
      if (!readyPublic.manifestHash) {
        throw new ReferenceSessionError("Generated reference manifest is incomplete.", "INCOMPLETE_MANIFEST");
      }
      await this.approveManifest(ownerId, sessionUuid, readyPublic.manifestHash);
      const updatedSession = (await findSessionByUuid(pool, sessionUuid))!;
      const updatedAttempt = (await findAttemptById(pool, attempt.id))!;

      return { session: updatedSession, attempt: updatedAttempt };
    } catch (error: any) {
      await connection.rollback().catch(() => {});

      // Compensating storage cleanup for failed attempts
      for (const key of createdObjectKeys) {
        await cleanupReferenceImage(key);
      }

      if (createdAssetIds.length > 0) {
        const failedAttempt = await findAttemptByIdempotencyKey(pool, (await findSessionByUuid(pool, sessionUuid))?.id || 0, idempotencyKey).catch(() => null);
        if (failedAttempt) {
          await pool.query("DELETE FROM reference_reports WHERE attempt_id = ?", [failedAttempt.id]).catch(() => {});
          await pool.query("DELETE FROM reference_views WHERE attempt_id = ?", [failedAttempt.id]).catch(() => {});
        }
        for (const assetId of createdAssetIds) await hardDeleteUnpublishedAsset(pool, assetId).catch(() => {});
      }

      const session = await findSessionByUuid(pool, sessionUuid);
      if (session) {
        const failedAttempt = await findAttemptByIdempotencyKey(pool, session.id, idempotencyKey);
        if (failedAttempt && session.current_attempt_id === failedAttempt.id) {
          await updateAttemptState(pool, failedAttempt.id, "failed", "GENERATION_FAILED", error.message).catch(() => {});
          await updateSessionState(pool, session.id, "failed").catch(() => {});
        }
      }

      throw error instanceof ReferenceSessionError
        ? error
        : new ReferenceSessionError(`Attempt generation failed: ${error.message}`, "GENERATION_FAILED");
    } finally {
      connection.release();
    }
  }

  async cancelSession(ownerId: string, sessionUuid: string): Promise<void> {
    const pool = this.getPoolFn();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const session = await findSessionByUuidForUpdate(connection, sessionUuid);
      if (!session) throw new ReferenceSessionError("Session not found", "NOT_FOUND");
      if (session.owner_id !== ownerId) throw new ReferenceSessionError("Unauthorized", "UNAUTHORIZED");
      if (!["draft", "ready", "failed"].includes(session.state)) throw new ReferenceSessionError("Session cannot be cancelled in its current state.", "INVALID_STATE");
      await updateSessionState(connection, session.id, "cancelled");
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async approveManifest(
    ownerId: string,
    sessionUuid: string,
    manifestHash: string,
  ): Promise<SessionPublic> {
    const pool = this.getPoolFn();
    const connection = await pool.getConnection();
    let manifestObjectKey: string | null = null;
    let manifestAssetId: number | null = null;

    try {
      await connection.beginTransaction();

      const session = await findSessionByUuidForUpdate(connection, sessionUuid);
      if (!session) throw new ReferenceSessionError("Session not found", "NOT_FOUND");
      if (session.owner_id !== ownerId) throw new ReferenceSessionError("Unauthorized", "UNAUTHORIZED");

      const existingApproval = await findApprovalBySessionId(connection, session.id);
      if (existingApproval || session.state === "approved") {
        if (existingApproval?.manifest_hash === manifestHash) {
          await connection.commit();
          return this.getSessionPublic(sessionUuid, ownerId, false);
        }
        throw new ReferenceSessionError("Session is already approved with a different manifest.", "ALREADY_APPROVED");
      }

      if (session.state !== "ready" || !session.current_attempt_id) {
        throw new ReferenceSessionError("Session is not in ready state for approval.", "NOT_READY");
      }

      const attempt = await findAttemptById(connection, session.current_attempt_id);
      if (!attempt || attempt.state !== "ready") {
        throw new ReferenceSessionError("Attempt is not ready for approval.", "ATTEMPT_NOT_READY");
      }

      const views = await findViewsByAttemptId(connection, attempt.id);
      if (views.length !== 5) {
        throw new ReferenceSessionError("Approval requires exactly 5 reference views.", "INCOMPLETE_VIEWS");
      }

      // Compute server-side ordered manifest hash and verify match
      const viewManifestItems: { viewKind: ViewKind; assetUuid: string; sha256: string }[] = [];
      for (const v of views) {
        const asset = await findAssetById(connection, v.asset_id);
        const version = await findVersionById(connection, v.asset_version_id);
        if (!asset || !version) {
          throw new ReferenceSessionError("Corrupt view asset reference", "CORRUPT_VIEW");
        }
        if (version.asset_id !== asset.id || v.width_px < 1024 || v.height_px < 1024) {
          throw new ReferenceSessionError("View asset/version or decoded dimensions are invalid.", "CORRUPT_VIEW");
        }
        viewManifestItems.push({
          viewKind: v.view_kind,
          assetUuid: asset.asset_uuid,
          sha256: version.sha256,
        });
      }

      const report = await findReportByAttemptId(connection, attempt.id);
      if (!report) {
        throw new ReferenceSessionError("Consistency report is required for approval.", "MISSING_REPORT");
      }
      if (report.status === "fail") throw new ReferenceSessionError("Failed consistency checks cannot be approved.", "REPORT_FAILED");
      if (!report.report_asset_id || !report.report_asset_version_id) throw new ReferenceSessionError("Consistency report is not canonical.", "CORRUPT_REPORT");
      const reportVersion = await findVersionById(connection, report.report_asset_version_id);
      if (!reportVersion || reportVersion.asset_id !== report.report_asset_id || reportVersion.sha256 !== report.report_hash) {
        throw new ReferenceSessionError("Consistency report identity does not match its canonical bytes.", "CORRUPT_REPORT");
      }
      const computedHash = computeOrderedManifestHash(viewManifestItems, report.report_hash);
      if (computedHash !== manifestHash) {
        throw new ReferenceSessionError(
          "Manifest hash mismatch. Reviewed views or report have changed.",
          "MANIFEST_HASH_MISMATCH",
        );
      }

      const manifestBytes = Buffer.from(JSON.stringify({
        sessionUuid: session.session_uuid,
        attemptNumber: attempt.attempt_number,
        orderedViews: viewManifestItems,
        reportHash: report.report_hash,
        manifestHash: computedHash,
      }), "utf8");
      const storedManifest = await storeReferenceManifest(session.session_uuid, manifestBytes);
      manifestObjectKey = storedManifest.objectKey;
      const manifestRegistration = await registerAsset({
        ownerId, assetType: "provider_manifest", visibility: "private", mimeType: "application/json",
        sizeBytes: storedManifest.sizeBytes, sha256: storedManifest.sha256, bucket: "private", objectKey: storedManifest.objectKey,
        metadata: { sessionUuid: session.session_uuid, attemptNumber: attempt.attempt_number, manifestHash: computedHash },
        sourceProvider: "pawsome3d_reference_approval", license: "proprietary", commercialUseEligible: false,
      }, { authorization: { internal: true }, isNewObjectUpload: false, pool });
      manifestAssetId = manifestRegistration.asset.id;

      for (const item of viewManifestItems) {
        const viewAsset = await findAssetById(connection, views.find((view) => view.view_kind === item.viewKind)!.asset_id);
        const viewVersion = views.find((view) => view.view_kind === item.viewKind)!;
        if (viewAsset) await addLineage({
          parentAssetUuid: viewAsset.asset_uuid,
          parentVersionNumber: (await findVersionById(connection, viewVersion.asset_version_id))!.version_number,
          childAssetUuid: manifestRegistration.asset.asset_uuid,
          childVersionNumber: manifestRegistration.version.version_number,
          relationType: "derivative",
        }, { internal: true }, pool);
      }

      await insertApproval(connection, {
        sessionId: session.id,
        attemptId: attempt.id,
        manifestAssetId: manifestRegistration.asset.id,
        manifestAssetVersionId: manifestRegistration.version.id,
        manifestHash: computedHash,
        approvedByUser: ownerId,
      });

      await updateSessionState(connection, session.id, "approved", {
        approvedAttemptId: attempt.id,
      });

      await connection.commit();

      return this.getSessionPublic(sessionUuid, ownerId, false);
    } catch (error: any) {
      await connection.rollback().catch(() => {});
      if (manifestObjectKey) await cleanupReferenceImage(manifestObjectKey);
      if (manifestAssetId) await hardDeleteUnpublishedAsset(pool, manifestAssetId).catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async getSessionPublic(
    sessionUuid: string,
    requestingUserPhone?: string,
    isAdmin: boolean = false,
  ): Promise<SessionPublic> {
    const pool = this.getPoolFn();
    const session = await findSessionByUuid(pool, sessionUuid);
    if (!session) throw new ReferenceSessionError("Session not found", "NOT_FOUND");

    if (session.owner_id !== requestingUserPhone && !isAdmin) {
      throw new ReferenceSessionError("Access denied to reference session", "UNAUTHORIZED");
    }

    let viewsPublic: ViewItemPublic[] = [];
    let reportPublic: ReportPublic | null = null;
    let manifestHash: string | null = null;
    let approvedAt: string | null = null;

    const targetAttemptId = session.approved_attempt_id || session.current_attempt_id;

    if (targetAttemptId) {
      const views = await findViewsByAttemptId(pool, targetAttemptId);
      const manifestItems: { viewKind: ViewKind; assetUuid: string; sha256: string }[] = [];

      for (const v of views) {
        const asset = await findAssetById(pool, v.asset_id);
        const version = await findVersionById(pool, v.asset_version_id);
        if (asset && version) {
          const signedUrl = await generateSignedUrlForVersion(asset, version, requestingUserPhone, isAdmin, 900);
          viewsPublic.push({
            viewKind: v.view_kind,
            assetUuid: asset.asset_uuid,
            versionNumber: version.version_number,
            widthPx: v.width_px,
            heightPx: v.height_px,
            isSynthesized: v.is_synthesized,
            signedUrl,
          });
          manifestItems.push({
            viewKind: v.view_kind,
            assetUuid: asset.asset_uuid,
            sha256: version.sha256,
          });
        }
      }

      const reportRecord = await findReportByAttemptId(pool, targetAttemptId);
      if (reportRecord) {
        reportPublic = {
          status: reportRecord.status,
          scaleConfidence: reportRecord.scale_confidence,
          reportHash: reportRecord.report_hash,
          metrics: reportRecord.metrics_json,
        };
        if (viewsPublic.length === 5) manifestHash = computeOrderedManifestHash(manifestItems, reportRecord.report_hash);
      }
    }

    const approvalRecord = await findApprovalBySessionId(pool, session.id);
    if (approvalRecord) {
      approvedAt = approvalRecord.created_at.toISOString();
      manifestHash = approvalRecord.manifest_hash;
    }

    const attempts = await findAttemptsBySessionId(pool, session.id);
    const currentAttempt = session.current_attempt_id ? attempts.find((a) => a.id === session.current_attempt_id) : null;
    const approvedAttempt = session.approved_attempt_id ? attempts.find((a) => a.id === session.approved_attempt_id) : null;

    return {
      sessionUuid: session.session_uuid,
      ownerId: session.owner_id,
      inputMode: session.input_mode,
      subjectClass: session.subject_class,
      prompt: session.prompt,
      state: session.state,
      currentAttemptNumber: currentAttempt ? currentAttempt.attempt_number : null,
      approvedAttemptNumber: approvedAttempt ? approvedAttempt.attempt_number : null,
      retryCount: session.retry_count,
      createdAt: session.created_at.toISOString(),
      updatedAt: session.updated_at.toISOString(),
      views: viewsPublic,
      report: reportPublic,
      manifestHash,
      approvedAt,
    };
  }
}
