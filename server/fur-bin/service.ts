// ─── Phase 5: Fur Bin Service ────────────────────────────────────────────────
import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import { assertFurBinV5Enabled } from "./featureFlag";
import type {
  FurBinItemPublic,
  ShowcaseRecordPublic,
  ModerationState,
  MeasuredBadgePublic,
} from "./types";
import {
  insertFurBinItem,
  findFurBinItemByUuid,
  findFurBinItemById,
  findFurBinItemByUuidForUpdate,
  findFurBinItemByUuidForUpdateAnyStatus,
  findFurBinItemByOwnerAndAsset,
  sumAssetVersionStorageBytes,
  searchFurBinItems,
  updateItemVersionPointer,
  archiveFurBinItem,
  deleteFurBinItem,
  insertFurBinVersionEvent,
  findFurBinVersions,
  findFurBinDerivatives,
  findMeasuredCapabilityEvidence,
  hasDerivativeLineage,
  insertCollection,
  findCollectionByUuid,
  listCollectionsByOwner,
  addItemToCollection,
  insertShowcaseRecord,
  findShowcaseByUuid,
  findShowcaseByUuidForUpdate,
  findPublishedShowcaseByUuid,
  findLatestShowcaseByItemId,
  listShowcasesByOwner,
  searchPublishedShowcases,
  updateShowcaseModeration,
  markShowcaseUnpublished,
  insertShowcasePublicationEvent,
} from "./repository";
import {
  findVersionById,
  findAssetById,
  findAssetByUuid,
  findVersionByAssetAndNumber,
} from "../assets/repository";
import { generateSignedUrlForVersion } from "../assets/access";
import { sendMail } from "../mail";
import type { SubmitFurBinDefectReport } from "./schemas";
import { petGlbTotalCost } from "../../src/pricing";

export class FurBinError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "FurBinError";
  }
}

export class FurBinService {
  constructor(
    private readonly getPoolFn: () => mysql.Pool,
    private readonly signUrl: typeof generateSignedUrlForVersion = generateSignedUrlForVersion,
  ) {}

  // ── 1. Create or Register Fur Bin Item ────────────────────────────────────

  async registerItem(
    ownerId: string,
    params: {
      assetUuid: string;
      versionNumber: number;
      title: string;
      description?: string;
      tags?: string[];
    },
  ): Promise<FurBinItemPublic> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();
      const asset = await findAssetByUuid(conn, params.assetUuid);
      if (!asset) throw new FurBinError("Asset not found", "NOT_FOUND");
      if (asset.owner_id !== ownerId) throw new FurBinError("Not authorized", "FORBIDDEN");
      if (asset.status !== "active") throw new FurBinError("Asset is not active", "INVALID_ASSET");

      const version = await findVersionByAssetAndNumber(conn, asset.id, params.versionNumber);
      if (!version) throw new FurBinError("Asset version not found", "INVALID_VERSION");

      const existing = await findFurBinItemByOwnerAndAsset(conn, ownerId, asset.id);
      if (existing) {
        await conn.commit();
        return this.getItemPublic(ownerId, existing.item_uuid);
      }

      const storageBytes = await sumAssetVersionStorageBytes(conn, asset.id);
      const itemUuid = crypto.randomUUID();
      const itemId = await insertFurBinItem(conn, {
        itemUuid,
        ownerId,
        assetId: asset.id,
        currentVersionId: version.id,
        title: params.title,
        description: params.description,
        tagsJson: normalizeTags(params.tags || []),
        // Capability badges require measured Phase 4 manifests. Client claims
        // are deliberately ignored until that lineage is implemented.
        hasRig: false,
        hasFacial: false,
        hasAnimations: false,
        storageBytes,
      });
      await insertFurBinVersionEvent(conn, {
        eventUuid: crypto.randomUUID(),
        itemId,
        actorId: ownerId,
        eventType: "registered",
        toVersionId: version.id,
        evidenceHash: auditEvidenceHash("fur-bin-version", {
          itemUuid,
          eventType: "registered",
          toVersionId: version.id,
        }),
      });

      await conn.commit();
      return this.getItemPublic(ownerId, itemUuid);
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof FurBinError) throw err;
      throw new FurBinError(`Failed to register Fur Bin item: ${err.message}`, "REGISTER_FAILED");
    } finally {
      conn.release();
    }
  }

  async submitDefectReport(
    ownerId: string,
    itemUuid: string,
    input: SubmitFurBinDefectReport,
  ): Promise<{ emailSent: boolean; reportUuid: string }> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();
    const reportUuid = crypto.randomUUID();
    let reportId = 0;
    let context: Record<string, unknown> = {};
    try {
      await conn.beginTransaction();
      // A defect message is offered after deletion, so this lookup must retain
      // the soft-deleted row. The underlying asset/version is never removed.
      const item = await findFurBinItemByUuidForUpdateAnyStatus(conn, itemUuid);
      if (!item) throw new FurBinError("Fur Bin item not found", "NOT_FOUND");
      if (item.owner_id !== ownerId) throw new FurBinError("Not authorized", "FORBIDDEN");
      const [assetRows] = await conn.query(
        `SELECT a.asset_uuid, a.asset_type, av.version_number, av.sha256,
                av.mime_type, av.size_bytes
           FROM assets a
           LEFT JOIN asset_versions av ON av.id = ? AND av.asset_id = a.id
          WHERE a.id = ? LIMIT 1`,
        [item.current_version_id, item.asset_id],
      );
      const asset = (assetRows as any[])[0] || {};
      const [userRows] = await conn.query(
        "SELECT phone, email, full_name, city FROM users WHERE phone = ? LIMIT 1",
        [ownerId],
      );
      const user = (userRows as any[])[0] || { phone: ownerId };
      const [orderRows] = await conn.query(
        `SELECT order_uuid, state, current_stage, generation_job_id, created_at
           FROM pet_glb_orders WHERE owner_phone = ? AND asset_id = ?
          ORDER BY id DESC LIMIT 1`,
        [ownerId, item.asset_id],
      );
      const order = (orderRows as any[])[0] || null;
      context = {
        user: { phone: String(user.phone || ownerId), email: user.email || null, fullName: user.full_name || null, city: user.city || null },
        furBin: { itemUuid, itemTitle: item.title, itemStatus: item.status },
        asset: {
          assetUuid: asset.asset_uuid || null,
          assetType: asset.asset_type || null,
          versionNumber: asset.version_number ? Number(asset.version_number) : null,
          sha256: asset.sha256 || null,
          mimeType: asset.mime_type || null,
          sizeBytes: asset.size_bytes ? Number(asset.size_bytes) : null,
        },
        order: order ? {
          orderUuid: order.order_uuid,
          state: order.state,
          currentStage: order.current_stage,
          generationJobId: order.generation_job_id,
          createdAt: order.created_at,
        } : null,
      };
      const [insert] = await conn.query(
        `INSERT INTO fur_bin_feedback
           (feedback_uuid, item_id, owner_id, asset_id, asset_version_id,
            pet_glb_order_uuid, decision, subject, message, context_json, email_status)
         VALUES (?, ?, ?, ?, ?, ?, 'defect', ?, ?, ?, 'pending')`,
        [reportUuid, item.id, ownerId, item.asset_id, item.current_version_id, order?.order_uuid || null, input.subject, input.message, JSON.stringify(context)],
      );
      reportId = Number((insert as any).insertId);
      await conn.commit();
    } catch (error: any) {
      await conn.rollback().catch(() => {});
      if (error instanceof FurBinError) throw error;
      throw new FurBinError(`Could not save defect report: ${error.message}`, "FEEDBACK_FAILED");
    } finally {
      conn.release();
    }

    const adminEmail = process.env.MODEL_FEEDBACK_EMAIL || process.env.ADMIN_EMAIL || "rob@stelar.host";
    const safe = (value: unknown) => escapeHtml(String(value ?? "Not provided"));
    const user = context.user as Record<string, unknown>;
    const asset = context.asset as Record<string, unknown>;
    const order = context.order as Record<string, unknown> | null;
    const emailSent = await sendMail({
      to: adminEmail,
      subject: `[Pawsome3D model defect] ${input.subject}`,
      replyTo: typeof user.email === "string" ? user.email : undefined,
      html: `<div style="font-family:system-ui,Arial,sans-serif;line-height:1.55">
<h2>Customer reported a generated-model defect</h2>
<p><strong>Subject:</strong> ${safe(input.subject)}</p>
<p><strong>Message:</strong><br>${escapeHtml(input.message).replace(/\n/g, "<br>")}</p>
<h3>Customer</h3>
<ul><li>Name: ${safe(user.fullName)}</li><li>Email: ${safe(user.email)}</li><li>Phone: ${safe(user.phone)}</li><li>City: ${safe(user.city)}</li></ul>
<h3>Asset and order</h3>
<ul><li>Fur Bin item: ${safe(itemUuid)}</li><li>Asset: ${safe(asset.assetUuid)}</li><li>Version: ${safe(asset.versionNumber)}</li><li>SHA-256: ${safe(asset.sha256)}</li><li>Order: ${safe(order?.orderUuid)}</li><li>Order state: ${safe(order?.state)}</li><li>Provider job: ${safe(order?.generationJobId)}</li><li>Report record: ${safe(reportUuid)}</li></ul>
</div>`,
    });
    await pool.query(
      `UPDATE fur_bin_feedback SET email_status = ?, email_error = ? WHERE id = ?`,
      [emailSent ? "sent" : (process.env.RESEND_API_KEY && process.env.MAIL_FROM ? "failed" : "unconfigured"), emailSent ? null : "Admin email was not accepted by the configured mail service", reportId],
    );
    return { emailSent, reportUuid };
  }

  // ── 2. Search & View Private Library ──────────────────────────────────────

  async searchLibrary(
    ownerId: string,
    params: {
      query?: string;
      tag?: string;
      collectionUuid?: string;
      hasRig?: boolean;
      hasFacial?: boolean;
      hasAnimations?: boolean;
      page?: number;
      limit?: number;
    },
  ): Promise<{ items: FurBinItemPublic[]; total: number; page: number; limit: number }> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const page = Number.isSafeInteger(params.page) && Number(params.page) > 0
      ? Number(params.page)
      : 1;
    const limit = Number.isSafeInteger(params.limit) && Number(params.limit) > 0
      ? Math.min(100, Number(params.limit))
      : 20;
    const result = await searchFurBinItems(pool, {
      ownerId,
      query: params.query,
      tag: params.tag,
      collectionUuid: params.collectionUuid,
      hasRig: params.hasRig,
      hasFacial: params.hasFacial,
      hasAnimations: params.hasAnimations,
      page,
      limit,
    });

    const publicItems = await Promise.all(
      result.items.map((item) => this.formatItemPublic(pool, ownerId, item)),
    );

    return { items: publicItems, total: result.total, page, limit };
  }

  // ── 3. Short-lived Signed Viewing URL Generation ──────────────────────────

  async getItemPublic(ownerId: string, itemUuid: string): Promise<FurBinItemPublic> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const item = await findFurBinItemByUuid(pool, itemUuid);
    if (!item) throw new FurBinError("Fur Bin item not found", "NOT_FOUND");
    if (item.owner_id !== ownerId) throw new FurBinError("Not authorized", "FORBIDDEN");

    return this.formatItemPublic(pool, ownerId, item);
  }

  // ── 4. Version Rollback ───────────────────────────────────────────────────

  async rollbackVersion(ownerId: string, itemUuid: string, versionNumber: number): Promise<FurBinItemPublic> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();
      const item = await findFurBinItemByUuidForUpdate(conn, itemUuid);
      if (!item) throw new FurBinError("Item not found", "NOT_FOUND");
      if (item.owner_id !== ownerId) throw new FurBinError("Not authorized", "FORBIDDEN");

      const version = await findVersionByAssetAndNumber(conn, item.asset_id, versionNumber);
      if (!version) {
        throw new FurBinError("Invalid target version for asset", "INVALID_VERSION");
      }

      await updateItemVersionPointer(conn, item.id, version.id);
      await insertFurBinVersionEvent(conn, {
        eventUuid: crypto.randomUUID(),
        itemId: item.id,
        actorId: ownerId,
        eventType: "rollback",
        fromVersionId: item.current_version_id,
        toVersionId: version.id,
        evidenceHash: auditEvidenceHash("fur-bin-version", {
          itemUuid,
          eventType: "rollback",
          fromVersionId: item.current_version_id,
          toVersionId: version.id,
        }),
      });
      await conn.commit();

      return this.getItemPublic(ownerId, itemUuid);
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof FurBinError) throw err;
      throw new FurBinError(`Rollback failed: ${err.message}`, "ROLLBACK_FAILED");
    } finally {
      conn.release();
    }
  }

  async archiveItem(ownerId: string, itemUuid: string): Promise<FurBinItemPublic> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const item = await findFurBinItemByUuidForUpdate(conn, itemUuid);
      if (!item) throw new FurBinError("Item not found", "NOT_FOUND");
      if (item.owner_id !== ownerId) throw new FurBinError("Not authorized", "FORBIDDEN");
      if (item.status !== "active") throw new FurBinError("Only active items can be archived", "INVALID_STATE");
      await archiveFurBinItem(conn, item.id);
      await insertFurBinVersionEvent(conn, {
        eventUuid: crypto.randomUUID(),
        itemId: item.id,
        actorId: ownerId,
        eventType: "archived",
        fromVersionId: item.current_version_id,
        toVersionId: item.current_version_id,
        evidenceHash: auditEvidenceHash("fur-bin-version", {
          itemUuid,
          eventType: "archived",
          versionId: item.current_version_id,
        }),
      });
      await conn.commit();
      return this.getItemPublic(ownerId, itemUuid);
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof FurBinError) throw err;
      throw new FurBinError(`Archive failed: ${err.message}`, "ARCHIVE_FAILED");
    } finally {
      conn.release();
    }
  }

  async deleteItem(ownerId: string, itemUuid: string): Promise<{ itemUuid: string; status: "deleted" }> {
    assertFurBinV5Enabled();
    const conn = await this.getPoolFn().getConnection();
    try {
      await conn.beginTransaction();
      const item = await findFurBinItemByUuidForUpdateAnyStatus(conn, itemUuid);
      if (!item) throw new FurBinError("Item not found", "NOT_FOUND");
      if (item.owner_id !== ownerId) throw new FurBinError("Not authorized", "FORBIDDEN");
      if (item.status !== "deleted") {
        await deleteFurBinItem(conn, item.id);
        await insertFurBinVersionEvent(conn, {
          eventUuid: crypto.randomUUID(),
          itemId: item.id,
          actorId: ownerId,
          eventType: "deleted",
          fromVersionId: item.current_version_id,
          toVersionId: item.current_version_id,
          evidenceHash: auditEvidenceHash("fur-bin-version", {
            itemUuid,
            eventType: "deleted",
            versionId: item.current_version_id,
            storageRetained: true,
          }),
        });
      }
      await conn.commit();
      return { itemUuid, status: "deleted" };
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof FurBinError) throw err;
      throw new FurBinError(`Delete failed: ${err.message}`, "DELETE_FAILED");
    } finally {
      conn.release();
    }
  }

  async createCollection(
    ownerId: string,
    params: { name: string; description?: string },
  ): Promise<{ collectionUuid: string; name: string; description: string | null }> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();
    const collectionUuid = crypto.randomUUID();
    try {
      await conn.beginTransaction();
      await insertCollection(conn, { collectionUuid, ownerId, ...params });
      await conn.commit();
      return { collectionUuid, name: params.name, description: params.description || null };
    } catch (err: any) {
      await conn.rollback();
      throw new FurBinError(`Create collection failed: ${err.message}`, "COLLECTION_FAILED");
    } finally {
      conn.release();
    }
  }

  async listCollections(ownerId: string): Promise<Array<{
    collectionUuid: string;
    name: string;
    description: string | null;
    itemCount: number;
  }>> {
    assertFurBinV5Enabled();
    const records = await listCollectionsByOwner(this.getPoolFn(), ownerId);
    return records.map((record) => ({
      collectionUuid: record.collection_uuid,
      name: record.name,
      description: record.description,
      itemCount: record.item_count,
    }));
  }

  async addItemToCollection(ownerId: string, collectionUuid: string, itemUuid: string): Promise<void> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const collection = await findCollectionByUuid(conn, collectionUuid);
      const item = await findFurBinItemByUuidForUpdate(conn, itemUuid);
      if (!collection || !item) throw new FurBinError("Collection or item not found", "NOT_FOUND");
      if (collection.owner_id !== ownerId || item.owner_id !== ownerId) {
        throw new FurBinError("Not authorized", "FORBIDDEN");
      }
      await addItemToCollection(conn, collection.id, item.id);
      await conn.commit();
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof FurBinError) throw err;
      throw new FurBinError(`Add collection item failed: ${err.message}`, "COLLECTION_FAILED");
    } finally {
      conn.release();
    }
  }

  // ── 5. Showcase Publishing & Rights Enforcement ────────────────────────────

  async publishShowcase(
    ownerId: string,
    params: {
      itemUuid: string;
      publicDerivativeUuid: string;
      publicDerivativeVersionNumber: number;
      title: string;
      description?: string;
      tags?: string[];
      category?: string;
      attribution?: string;
      rightsDeclaration: string;
      commercialEligible?: boolean;
    },
  ): Promise<ShowcaseRecordPublic> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();
      const item = await findFurBinItemByUuidForUpdate(conn, params.itemUuid);
      if (!item) throw new FurBinError("Item not found", "NOT_FOUND");
      if (item.owner_id !== ownerId) throw new FurBinError("Not authorized", "FORBIDDEN");
      if (item.status !== "active") throw new FurBinError("Archived items cannot be published", "INVALID_STATE");
      if (!item.current_version_id) throw new FurBinError("Item has no active content version", "NO_VERSION");

      const sourceAsset = await findAssetById(conn, item.asset_id);
      const derivativeAsset = await findAssetByUuid(conn, params.publicDerivativeUuid);
      if (!sourceAsset || sourceAsset.owner_id !== ownerId) {
        throw new FurBinError("Private source lineage is invalid", "INVALID_ASSET");
      }
      if (!derivativeAsset || derivativeAsset.owner_id !== ownerId || derivativeAsset.status !== "active") {
        throw new FurBinError("Public derivative asset is unavailable", "INVALID_ASSET");
      }
      if (derivativeAsset.id === sourceAsset.id) {
        throw new FurBinError("Showcase publishing requires a separate public derivative asset", "PRIVATE_ASSET");
      }
      if (derivativeAsset.visibility !== "public" && derivativeAsset.visibility !== "published") {
        throw new FurBinError("Showcase derivative is not public", "PRIVATE_ASSET");
      }
      const version = await findVersionByAssetAndNumber(
        conn,
        derivativeAsset.id,
        params.publicDerivativeVersionNumber,
      );
      if (!version || version.mime_type !== "model/gltf-binary") {
        throw new FurBinError("Public derivative version is invalid", "INVALID_VERSION");
      }
      if (!(await hasDerivativeLineage(conn, sourceAsset.id, version.id))) {
        throw new FurBinError("Public derivative is not linked to the private source", "INVALID_LINEAGE");
      }

      if (params.commercialEligible && !version.commercial_use_eligible) {
        throw new FurBinError("Asset version is not declared eligible for commercial marketplace listing", "COMMERCIAL_INELIGIBLE");
      }

      const showcaseUuid = crypto.randomUUID();
      const showcaseId = await insertShowcaseRecord(conn, {
        showcaseUuid,
        ownerId,
        furBinItemId: item.id,
        publishedVersionId: version.id,
        title: params.title,
        description: params.description,
        tagsJson: params.tags || [],
        category: params.category || "general",
        attribution: params.attribution,
        rightsDeclaration: params.rightsDeclaration,
        commercialEligible: params.commercialEligible ?? false,
      });
      await insertShowcasePublicationEvent(conn, {
        eventUuid: crypto.randomUUID(),
        showcaseId,
        eventType: "submitted",
        publicVersionId: version.id,
        actorId: ownerId,
        evidenceHash: auditEvidenceHash("showcase-publication", {
          showcaseUuid,
          eventType: "submitted",
          publicVersionId: version.id,
          rightsDeclaration: params.rightsDeclaration,
        }),
      });

      await conn.commit();
      return this.getShowcaseForOwner(ownerId, showcaseUuid);
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof FurBinError) throw err;
      throw new FurBinError(`Publish showcase failed: ${err.message}`, "PUBLISH_FAILED");
    } finally {
      conn.release();
    }
  }

  // ── 6. Unpublish Showcase (Never Deletes Private Source) ───────────────────

  async unpublishShowcase(ownerId: string, showcaseUuid: string): Promise<void> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();
      const showcase = await findShowcaseByUuidForUpdate(conn, showcaseUuid);
      if (!showcase) throw new FurBinError("Showcase not found", "NOT_FOUND");
      if (showcase.owner_id !== ownerId) throw new FurBinError("Not authorized", "FORBIDDEN");

      await markShowcaseUnpublished(conn, showcase.id);
      await insertShowcasePublicationEvent(conn, {
        eventUuid: crypto.randomUUID(),
        showcaseId: showcase.id,
        eventType: "unpublished",
        publicVersionId: showcase.published_version_id,
        actorId: ownerId,
        evidenceHash: auditEvidenceHash("showcase-publication", {
          showcaseUuid,
          eventType: "unpublished",
          publicVersionId: showcase.published_version_id,
        }),
      });
      await conn.commit();
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof FurBinError) throw err;
      throw new FurBinError(`Unpublish failed: ${err.message}`, "UNPUBLISH_FAILED");
    } finally {
      conn.release();
    }
  }

  // ── 7. Fail-Closed Moderation Decision (Admin) ────────────────────────────

  async moderateShowcase(
    moderatorId: string,
    showcaseUuid: string,
    newState: ModerationState,
    reason: string,
    moderatorIsAdmin: boolean,
  ): Promise<ShowcaseRecordPublic> {
    assertFurBinV5Enabled();
    if (!moderatorIsAdmin) throw new FurBinError("Administrator access required", "ADMIN_REQUIRED");
    const pool = this.getPoolFn();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();
      const showcase = await findShowcaseByUuidForUpdate(conn, showcaseUuid);
      if (!showcase) throw new FurBinError("Showcase not found", "NOT_FOUND");
      if (!isModerationTransitionAllowed(showcase.moderation_state, newState)) {
        throw new FurBinError(
          `Invalid moderation transition: ${showcase.moderation_state} -> ${newState}`,
          "INVALID_STATE",
        );
      }

      await updateShowcaseModeration(conn, showcase.id, newState, moderatorId, reason);
      await insertShowcasePublicationEvent(conn, {
        eventUuid: crypto.randomUUID(),
        showcaseId: showcase.id,
        eventType: moderationEventType(newState),
        publicVersionId: showcase.published_version_id,
        actorId: moderatorId,
        evidenceHash: auditEvidenceHash("showcase-publication", {
          showcaseUuid,
          eventType: moderationEventType(newState),
          publicVersionId: showcase.published_version_id,
          reason,
        }),
      });
      await conn.commit();

      return this.getShowcaseForOwner(showcase.owner_id, showcaseUuid);
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof FurBinError) throw err;
      throw new FurBinError(`Moderation failed: ${err.message}`, "MODERATION_FAILED");
    } finally {
      conn.release();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  async getShowcasePublic(showcaseUuid: string): Promise<ShowcaseRecordPublic> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const showcase = await findPublishedShowcaseByUuid(pool, showcaseUuid);
    if (!showcase) throw new FurBinError("Showcase record not found", "NOT_FOUND");

    return this.formatShowcasePublic(pool, showcase, true);
  }

  async getShowcaseForOwner(ownerId: string, showcaseUuid: string): Promise<ShowcaseRecordPublic> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const showcase = await findShowcaseByUuid(pool, showcaseUuid);
    if (!showcase) throw new FurBinError("Showcase record not found", "NOT_FOUND");
    if (showcase.owner_id !== ownerId) throw new FurBinError("Not authorized", "FORBIDDEN");

    return this.formatShowcasePublic(pool, showcase, false);
  }

  async listOwnerShowcases(
    ownerId: string,
    params: { page: number; limit: number },
  ): Promise<{ items: ShowcaseRecordPublic[]; total: number }> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const result = await listShowcasesByOwner(pool, ownerId, params.page, params.limit);
    return {
      items: await Promise.all(result.records.map((record) => this.formatShowcasePublic(pool, record, false))),
      total: result.total,
    };
  }

  async browsePublicShowcases(params: {
    query?: string;
    tag?: string;
    category?: string;
    page: number;
    limit: number;
  }): Promise<{ items: ShowcaseRecordPublic[]; total: number }> {
    assertFurBinV5Enabled();
    const pool = this.getPoolFn();
    const result = await searchPublishedShowcases(pool, params);
    return {
      items: await Promise.all(result.records.map((record) => this.formatShowcasePublic(pool, record, true))),
      total: result.total,
    };
  }

  private async formatShowcasePublic(
    pool: mysql.Pool,
    showcase: any,
    includePublicViewUrl: boolean,
  ): Promise<ShowcaseRecordPublic> {
    let publicViewUrl: string | undefined;
    const version = await findVersionById(pool, showcase.published_version_id);
    const asset = version ? await findAssetById(pool, version.asset_id) : null;
    const item = await findFurBinItemById(pool, showcase.fur_bin_item_id);
    const derivativeLineagePass = Boolean(
      version
      && asset
      && item
      && asset.id !== item.asset_id
      && await hasDerivativeLineage(pool, item.asset_id, version.id),
    );
    if (!version || !asset || version.asset_id !== asset.id
      || asset.status !== "active"
      || (asset.visibility !== "public" && asset.visibility !== "published")
      || !derivativeLineagePass) {
      throw new FurBinError("Showcase public derivative lineage is invalid", "INVALID_ASSET");
    }
    if (includePublicViewUrl) {
      publicViewUrl = await this.signUrl(asset, version, undefined, false);
    }

    return {
      showcaseUuid: showcase.showcase_uuid,
      title: showcase.title,
      description: showcase.description,
      tags: showcase.tags_json,
      category: showcase.category,
      attribution: showcase.attribution,
      rightsDeclaration: showcase.rights_declaration,
      commercialEligible: showcase.commercial_eligible,
      moderationState: showcase.moderation_state,
      viewCount: showcase.view_count,
      publishedAt: showcase.published_at ? new Date(showcase.published_at).toISOString() : null,
      publicViewUrl,
      createdAt: new Date(showcase.created_at).toISOString(),
    };
  }

  private async formatItemPublic(pool: mysql.Pool, ownerId: string, item: any): Promise<FurBinItemPublic> {
    let signedViewUrl: string | undefined;
    let currentVersionNumber: number | undefined;
    let assetUuid: string | undefined;
    let evidence: any | null = null;

    if (item.current_version_id) {
      const version = await findVersionById(pool, item.current_version_id);
      if (version) {
        const asset = await findAssetById(pool, version.asset_id);
        if (asset) {
          if (asset.owner_id !== ownerId || version.asset_id !== asset.id) {
            throw new FurBinError("Item asset lineage is invalid", "INVALID_ASSET");
          }
          signedViewUrl = (await this.signUrl(asset, version, ownerId, false)) || undefined;
          assetUuid = asset.asset_uuid;
          currentVersionNumber = version.version_number;
          evidence = await findMeasuredCapabilityEvidence(pool, ownerId, asset.id, version.id);
        }
      }
    }

    const badges = buildMeasuredBadges(evidence);
    const versions = await findFurBinVersions(pool, item.asset_id);
    const derivatives = await findFurBinDerivatives(pool, ownerId, item.asset_id);
    const showcaseRecord = await findLatestShowcaseByItemId(pool, item.id);
    const showcase = showcaseRecord
      ? await this.formatShowcasePublic(pool, showcaseRecord, false)
      : undefined;
    const hasRig = badges.find((badge) => badge.id === "rig")?.state === "verified";
    const hasFacial = badges.find((badge) => badge.id === "facial")?.state === "verified";
    const hasAnimations = badges.find((badge) => badge.id === "animation")?.state === "verified";
    const [orderRows] = await pool.query(
      `SELECT order_uuid, reference_session_id, reference_manifest_json, include_texture, include_rig
         FROM pet_glb_orders
        WHERE owner_phone = ? AND asset_id = ?
        ORDER BY id DESC LIMIT 1`,
      [ownerId, item.asset_id],
    );
    const sourceOrder = (orderRows as any[])[0] || null;
    const manifest = sourceOrder
      ? (typeof sourceOrder.reference_manifest_json === "string"
          ? JSON.parse(sourceOrder.reference_manifest_json || "{}")
          : sourceOrder.reference_manifest_json || {})
      : {};
    let coverUrl: string | undefined;
    if (sourceOrder?.reference_session_id) {
      const [frontRows] = await pool.query(
        `SELECT rv.asset_version_id
           FROM reference_sessions rs
           JOIN reference_views rv
             ON rv.attempt_id = rs.approved_attempt_id
            AND rv.view_kind = 'front'
          WHERE rs.id = ? AND rs.owner_id = ?
          LIMIT 1`,
        [sourceOrder.reference_session_id, ownerId],
      );
      const frontVersionId = Number((frontRows as any[])[0]?.asset_version_id || 0);
      if (frontVersionId > 0) {
        const frontVersion = await findVersionById(pool, frontVersionId);
        const frontAsset = frontVersion ? await findAssetById(pool, frontVersion.asset_id) : null;
        if (frontVersion && frontAsset && frontAsset.owner_id === ownerId && frontVersion.asset_id === frontAsset.id) {
          coverUrl = (await this.signUrl(frontAsset, frontVersion, ownerId, false)) || undefined;
        }
      }
    }
    coverUrl ||= durableReferenceUrl(manifest.frontUrl);
    const retryPriceCredits = sourceOrder
      ? petGlbTotalCost({ texture: Boolean(sourceOrder.include_texture), rig: Boolean(sourceOrder.include_rig) })
      : undefined;

    return {
      itemUuid: item.item_uuid,
      assetUuid,
      title: item.title,
      description: item.description,
      tags: item.tags_json,
      dimensions: item.dimensions_json,
      hasRig,
      hasFacial,
      hasAnimations,
      accessoryCount: item.accessory_count,
      derivativeCount: item.derivative_count,
      storageBytes: await sumAssetVersionStorageBytes(pool, item.asset_id),
      status: item.status,
      badges,
      currentVersionNumber,
      versions: versions.map((version) => ({
        versionNumber: version.version_number,
        createdAt: version.created_at.toISOString(),
        sizeBytes: version.size_bytes,
        mimeType: version.mime_type,
        isCurrent: version.version_number === currentVersionNumber,
        validationLabel: version.version_number === currentVersionNumber && evidence
          ? `Accepted manifest ${String(evidence.metrics_hash).slice(0, 12)}`
          : undefined,
      })),
      derivatives: derivatives.map((derivative) => ({
        derivativeUuid: derivative.asset_uuid,
        versionNumber: derivative.version_number,
        label: derivative.source_provider || derivative.asset_type,
        scope: derivative.visibility === "private" ? "private" : "public",
        purpose: derivativePurpose(derivative.asset_type),
        validationLabel: derivative.visibility === "private" ? undefined : "Public derivative lineage verified",
      })),
      showcase,
      signedViewUrl,
      coverUrl,
      sourceOrderUuid: sourceOrder?.order_uuid || undefined,
      retryPriceCredits,
      createdAt: new Date(item.created_at).toISOString(),
      updatedAt: new Date(item.updated_at).toISOString(),
    };
  }
}

function durableReferenceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    const isPresigned = url.searchParams.has("X-Amz-Signature")
      || url.searchParams.has("X-Amz-Credential")
      || url.searchParams.has("X-Amz-Expires");
    return isPresigned ? undefined : url.toString();
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] || character);
}

function buildMeasuredBadges(evidence: any | null): MeasuredBadgePublic[] {
  const rules = Array.isArray(evidence?.rules_json) ? evidence.rules_json : [];
  const failedRules = rules.filter((rule: any) => rule && rule.pass === false);
  const base = evidence ? {
    manifestHash: String(evidence.metrics_hash),
    validatorVersion: String(evidence.validator_version),
    ruleIds: rules.map((rule: any) => String(rule.rule || "")).filter(Boolean),
  } : { ruleIds: [] as string[] };
  const rigPass = Boolean(evidence?.bind_matrix_valid && evidence?.mobile_budget_pass && failedRules.length === 0);
  const facialPass = rigPass
    && Boolean(evidence?.facial_deformation_pass)
    && ["full", "partial"].includes(String(evidence?.facial_capability));
  const animationPass = rigPass && Boolean(evidence?.animation_sweep_pass) && Boolean(evidence?.has_animation_clip);
  const hasAnimationClip = Boolean(evidence?.has_animation_clip);
  return [
    {
      id: "rig",
      label: "Body rig",
      state: evidence ? (rigPass ? "verified" : "failed") : "not_verified",
      evidenceLabel: evidence
        ? (rigPass ? `Measured by ${evidence.validator_version}` : "Accepted rig evidence contains a failed rule")
        : "No accepted measured rig evidence",
      ...base,
    },
    {
      id: "facial",
      label: "Facial rig",
      state: evidence ? (facialPass ? "verified" : "not_verified") : "not_verified",
      evidenceLabel: facialPass
        ? `${evidence.facial_capability} facial deformation verified`
        : "No accepted facial deformation evidence",
      ...base,
    },
    {
      id: "animation",
      label: "Animation",
      state: !hasAnimationClip ? "not_verified" : (animationPass ? "verified" : "failed"),
      evidenceLabel: animationPass
        ? "Measured animation sweep and canonical animation clip verified"
        : "No accepted animation clip with measured sweep evidence",
      ...base,
    },
  ];
}

function derivativePurpose(assetType: string): "preview" | "showcase" | "print" | "animation" | "other" {
  if (assetType === "thumbnail" || assetType === "turntable_video") return "preview";
  if (assetType === "model_stl" || assetType === "model_3mf" || assetType === "stationery_print_file") return "print";
  if (assetType === "animation_clip") return "animation";
  if (assetType.includes("model") || assetType.endsWith("_glb")) return "showcase";
  return "other";
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function isModerationTransitionAllowed(current: ModerationState, next: ModerationState): boolean {
  if (current === "pending") return next === "approved" || next === "rejected";
  if (current === "approved") return next === "suspended";
  return false;
}

function moderationEventType(state: ModerationState): "published" | "rejected" | "suspended" {
  if (state === "approved") return "published";
  if (state === "rejected") return "rejected";
  return "suspended";
}

function auditEvidenceHash(domain: string, value: Record<string, unknown>): string {
  const entries = Object.keys(value).sort().map((key) => [key, value[key]]);
  return crypto.createHash("sha256").update(JSON.stringify([domain, entries])).digest("hex");
}
