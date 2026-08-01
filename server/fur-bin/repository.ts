// ─── Phase 5: Fur Bin Repository ────────────────────────────────────────────
import type mysql from "mysql2/promise";
import type {
  FurBinItemRecord,
  FurBinCollectionRecord,
  ShowcaseRecord,
  ModerationHistoryRecord,
  ItemStatus,
  ModerationState,
} from "./types";

// ── Fur Bin Items ───────────────────────────────────────────────────────────

export async function insertFurBinItem(
  conn: mysql.PoolConnection,
  data: {
    itemUuid: string;
    ownerId: string;
    assetId: number;
    currentVersionId: number;
    title: string;
    description?: string;
    tagsJson: string[];
    dimensionsJson?: any;
    hasRig?: boolean;
    hasFacial?: boolean;
    hasAnimations?: boolean;
    storageBytes: number;
  },
): Promise<number> {
  const [res]: any = await conn.query(
    `INSERT INTO fur_bin_items
      (item_uuid, owner_id, asset_id, current_version_id, title, description, tags_json, dimensions_json, has_rig, has_facial, has_animations, storage_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.itemUuid,
      data.ownerId,
      data.assetId,
      data.currentVersionId,
      data.title,
      data.description || null,
      JSON.stringify(data.tagsJson),
      data.dimensionsJson ? JSON.stringify(data.dimensionsJson) : null,
      data.hasRig ?? false,
      data.hasFacial ?? false,
      data.hasAnimations ?? false,
      data.storageBytes,
    ],
  );
  return res.insertId;
}

export async function findFurBinItemByUuid(
  pool: mysql.Pool | mysql.PoolConnection,
  itemUuid: string,
): Promise<FurBinItemRecord | null> {
  const [rows]: any = await pool.query("SELECT * FROM fur_bin_items WHERE item_uuid = ? AND status != 'deleted'", [itemUuid]);
  if (!rows[0]) return null;
  return parseItemRecord(rows[0]);
}

export async function findFurBinItemByUuidForUpdate(
  conn: mysql.PoolConnection,
  itemUuid: string,
): Promise<FurBinItemRecord | null> {
  const [rows]: any = await conn.query(
    "SELECT * FROM fur_bin_items WHERE item_uuid = ? AND status != 'deleted' FOR UPDATE",
    [itemUuid],
  );
  return rows[0] ? parseItemRecord(rows[0]) : null;
}

export async function findFurBinItemByUuidForUpdateAnyStatus(
  conn: mysql.PoolConnection,
  itemUuid: string,
): Promise<FurBinItemRecord | null> {
  const [rows]: any = await conn.query(
    "SELECT * FROM fur_bin_items WHERE item_uuid = ? FOR UPDATE",
    [itemUuid],
  );
  return rows[0] ? parseItemRecord(rows[0]) : null;
}

export async function findFurBinItemByOwnerAndAsset(
  pool: mysql.Pool | mysql.PoolConnection,
  ownerId: string,
  assetId: number,
): Promise<FurBinItemRecord | null> {
  const [rows]: any = await pool.query(
    "SELECT * FROM fur_bin_items WHERE owner_id = ? AND asset_id = ? AND status != 'deleted' LIMIT 1",
    [ownerId, assetId],
  );
  return rows[0] ? parseItemRecord(rows[0]) : null;
}

export async function sumAssetVersionStorageBytes(
  pool: mysql.Pool | mysql.PoolConnection,
  assetId: number,
): Promise<number> {
  const [rows]: any = await pool.query(
    "SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes FROM asset_versions WHERE asset_id = ?",
    [assetId],
  );
  return Number(rows[0]?.total_bytes || 0);
}

export async function findFurBinItemById(
  pool: mysql.Pool | mysql.PoolConnection,
  id: number,
): Promise<FurBinItemRecord | null> {
  const [rows]: any = await pool.query("SELECT * FROM fur_bin_items WHERE id = ? AND status != 'deleted'", [id]);
  if (!rows[0]) return null;
  return parseItemRecord(rows[0]);
}

export async function searchFurBinItems(
  pool: mysql.Pool,
  params: {
    ownerId: string;
    query?: string;
    tag?: string;
    collectionUuid?: string;
    hasRig?: boolean;
    hasFacial?: boolean;
    hasAnimations?: boolean;
    page: number;
    limit: number;
  },
): Promise<{ items: FurBinItemRecord[]; total: number }> {
  const where: string[] = ["owner_id = ?", "status = 'active'"];
  const vals: any[] = [params.ownerId];

  if (params.query) {
    where.push("(title LIKE ? OR description LIKE ?)");
    vals.push(`%${params.query}%`, `%${params.query}%`);
  }

  if (params.tag) {
    where.push("JSON_CONTAINS(tags_json, ?)");
    vals.push(JSON.stringify(params.tag));
  }

  if (params.collectionUuid) {
    where.push(`EXISTS (
      SELECT 1 FROM fur_bin_collection_items fci
      JOIN fur_bin_collections fc ON fc.id = fci.collection_id
      WHERE fci.item_id = fur_bin_items.id
        AND fc.collection_uuid = ? AND fc.owner_id = ? AND fc.status = 'active'
    )`);
    vals.push(params.collectionUuid, params.ownerId);
  }

  if (params.hasRig !== undefined) {
    where.push(`${params.hasRig ? "" : "NOT "}EXISTS (${measuredRigEvidenceSql("fur_bin_items")})`);
    vals.push(params.ownerId);
  }

  if (params.hasFacial !== undefined) {
    where.push(`${params.hasFacial ? "" : "NOT "}EXISTS (${measuredFacialEvidenceSql("fur_bin_items")})`);
    vals.push(params.ownerId);
  }

  if (params.hasAnimations !== undefined) {
    where.push(`${params.hasAnimations ? "" : "NOT "}EXISTS (${measuredAnimationEvidenceSql("fur_bin_items")})`);
    vals.push(params.ownerId);
  }

  const offset = (params.page - 1) * params.limit;
  const whereSql = where.join(" AND ");

  const [countRows]: any = await pool.query(`SELECT COUNT(*) as c FROM fur_bin_items WHERE ${whereSql}`, vals);
  const total = Number(countRows[0]?.c || 0);

  const [rows]: any = await pool.query(
    `SELECT * FROM fur_bin_items WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...vals, params.limit, offset],
  );

  return { items: rows.map(parseItemRecord), total };
}

export async function updateItemVersionPointer(
  conn: mysql.PoolConnection,
  itemId: number,
  versionId: number,
): Promise<void> {
  await conn.query("UPDATE fur_bin_items SET current_version_id = ? WHERE id = ?", [versionId, itemId]);
}

export async function archiveFurBinItem(conn: mysql.PoolConnection, itemId: number): Promise<void> {
  await conn.query("UPDATE fur_bin_items SET status = 'archived' WHERE id = ? AND status = 'active'", [itemId]);
}

export async function deleteFurBinItem(conn: mysql.PoolConnection, itemId: number): Promise<void> {
  await conn.query("UPDATE fur_bin_items SET status = 'deleted' WHERE id = ? AND status != 'deleted'", [itemId]);
}

export async function insertFurBinVersionEvent(
  conn: mysql.PoolConnection,
  data: {
    eventUuid: string;
    itemId: number;
    actorId: string;
    eventType: "registered" | "current_changed" | "rollback" | "archived" | "restored" | "deleted";
    fromVersionId?: number | null;
    toVersionId?: number | null;
    evidenceHash: string;
  },
): Promise<void> {
  await conn.query(
    `INSERT INTO fur_bin_version_events
      (event_uuid, item_id, actor_id, event_type, from_version_id, to_version_id, evidence_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.eventUuid,
      data.itemId,
      data.actorId,
      data.eventType,
      data.fromVersionId ?? null,
      data.toVersionId ?? null,
      data.evidenceHash,
    ],
  );
}

export async function findFurBinVersions(
  pool: mysql.Pool | mysql.PoolConnection,
  assetId: number,
): Promise<Array<{ version_number: number; created_at: Date; size_bytes: number; mime_type: string }>> {
  const [rows]: any = await pool.query(
    `SELECT version_number, created_at, size_bytes, mime_type
       FROM asset_versions WHERE asset_id = ? ORDER BY version_number DESC`,
    [assetId],
  );
  return rows.map((row: any) => ({
    version_number: Number(row.version_number),
    created_at: new Date(row.created_at),
    size_bytes: Number(row.size_bytes),
    mime_type: String(row.mime_type),
  }));
}

export async function findFurBinDerivatives(
  pool: mysql.Pool | mysql.PoolConnection,
  ownerId: string,
  assetId: number,
): Promise<Array<{
  asset_uuid: string;
  version_number: number;
  visibility: "private" | "public" | "published";
  asset_type: string;
  source_provider: string;
}>> {
  const [rows]: any = await pool.query(
    `SELECT DISTINCT child_asset.asset_uuid, child_version.version_number,
            child_asset.visibility, child_asset.asset_type, child_version.source_provider
       FROM asset_versions parent_version
       JOIN asset_relations relation ON relation.parent_version_id = parent_version.id
       JOIN asset_versions child_version ON child_version.id = relation.child_version_id
       JOIN assets child_asset ON child_asset.id = child_version.asset_id
      WHERE parent_version.asset_id = ? AND child_asset.owner_id = ?
        AND child_asset.status = 'active'
        AND relation.relation_type IN ('derivative','render','stl','rig','print_file')
      ORDER BY child_version.version_number DESC`,
    [assetId, ownerId],
  );
  return rows.map((row: any) => ({
    asset_uuid: String(row.asset_uuid),
    version_number: Number(row.version_number),
    visibility: row.visibility,
    asset_type: String(row.asset_type),
    source_provider: String(row.source_provider),
  }));
}

export async function hasDerivativeLineage(
  pool: mysql.Pool | mysql.PoolConnection,
  sourceAssetId: number,
  derivativeVersionId: number,
): Promise<boolean> {
  const [rows]: any = await pool.query(
    `SELECT 1
       FROM asset_relations relation
       JOIN asset_versions parent_version ON parent_version.id = relation.parent_version_id
      WHERE parent_version.asset_id = ? AND relation.child_version_id = ?
        AND relation.relation_type IN ('derivative','render')
      LIMIT 1`,
    [sourceAssetId, derivativeVersionId],
  );
  return rows.length > 0;
}

export async function findMeasuredCapabilityEvidence(
  pool: mysql.Pool | mysql.PoolConnection,
  ownerId: string,
  assetId: number,
  versionId: number,
): Promise<any | null> {
  const [rows]: any = await pool.query(
    `SELECT manifest.validator_version, manifest.metrics_hash, manifest.rules_json,
            manifest.bind_matrix_valid, manifest.mobile_budget_pass,
            manifest.animation_sweep_pass, facial.capability AS facial_capability,
            facial.deformation_pass AS facial_deformation_pass,
            facial.has_blink, facial.has_jaw, facial.viseme_coverage,
            EXISTS (
              SELECT 1 FROM asset_relations animation_relation
              JOIN asset_versions animation_version ON animation_version.id = animation_relation.child_version_id
              JOIN assets animation_asset ON animation_asset.id = animation_version.asset_id
              WHERE animation_relation.parent_version_id = artifact.asset_version_id
                AND animation_relation.relation_type = 'derivative'
                AND animation_asset.asset_type = 'animation_clip'
                AND animation_asset.status = 'active'
            ) AS has_animation_clip
       FROM rig_attempt_artifacts artifact
       JOIN rig_attempts attempt ON attempt.id = artifact.rig_attempt_id
       JOIN rig_jobs job ON job.id = attempt.job_id AND job.current_attempt_id = attempt.id
       JOIN rig_acceptances acceptance ON acceptance.rig_job_id = job.id
         AND acceptance.rig_attempt_id = attempt.id
       JOIN rig_validation_manifests manifest ON manifest.id = acceptance.manifest_id
       LEFT JOIN facial_inventories facial ON facial.rig_attempt_id = attempt.id
      WHERE artifact.role = 'rigged_glb' AND artifact.asset_id = ?
        AND artifact.asset_version_id = ? AND job.owner_id = ? AND job.state = 'accepted'
      ORDER BY acceptance.created_at DESC LIMIT 1`,
    [assetId, versionId, ownerId],
  );
  if (!rows[0]) return null;
  return {
    ...rows[0],
    rules_json: typeof rows[0].rules_json === "string" ? JSON.parse(rows[0].rules_json) : rows[0].rules_json,
  };
}

// ── Collections ─────────────────────────────────────────────────────────────

export async function insertCollection(
  conn: mysql.PoolConnection,
  data: { collectionUuid: string; ownerId: string; name: string; description?: string },
): Promise<number> {
  const [res]: any = await conn.query(
    "INSERT INTO fur_bin_collections (collection_uuid, owner_id, name, description) VALUES (?, ?, ?, ?)",
    [data.collectionUuid, data.ownerId, data.name, data.description || null],
  );
  return res.insertId;
}

export async function findCollectionByUuid(pool: mysql.Pool | mysql.PoolConnection, uuid: string): Promise<FurBinCollectionRecord | null> {
  const [rows]: any = await pool.query("SELECT * FROM fur_bin_collections WHERE collection_uuid = ? AND status = 'active'", [uuid]);
  return rows[0] || null;
}

export async function listCollectionsByOwner(
  pool: mysql.Pool | mysql.PoolConnection,
  ownerId: string,
): Promise<Array<FurBinCollectionRecord & { item_count: number }>> {
  const [rows]: any = await pool.query(
    `SELECT collection.*, COUNT(item.id) AS item_count
       FROM fur_bin_collections collection
       LEFT JOIN fur_bin_collection_items membership ON membership.collection_id = collection.id
       LEFT JOIN fur_bin_items item ON item.id = membership.item_id AND item.status = 'active'
      WHERE collection.owner_id = ? AND collection.status = 'active'
      GROUP BY collection.id ORDER BY collection.sort_order ASC, collection.created_at DESC`,
    [ownerId],
  );
  return rows.map((row: any) => ({ ...row, item_count: Number(row.item_count || 0) }));
}

export async function addItemToCollection(conn: mysql.PoolConnection, collectionId: number, itemId: number): Promise<void> {
  await conn.query("INSERT IGNORE INTO fur_bin_collection_items (collection_id, item_id) VALUES (?, ?)", [collectionId, itemId]);
}

// ── Showcase Records ────────────────────────────────────────────────────────

export async function insertShowcaseRecord(
  conn: mysql.PoolConnection,
  data: {
    showcaseUuid: string;
    ownerId: string;
    furBinItemId: number;
    publishedVersionId: number;
    title: string;
    description?: string;
    tagsJson: string[];
    category: string;
    attribution?: string;
    rightsDeclaration: string;
    commercialEligible: boolean;
  },
): Promise<number> {
  const [res]: any = await conn.query(
    `INSERT INTO showcase_records
      (showcase_uuid, owner_id, fur_bin_item_id, published_version_id, title, description, tags_json, category, attribution, rights_declaration, commercial_eligible, moderation_state, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
    [
      data.showcaseUuid,
      data.ownerId,
      data.furBinItemId,
      data.publishedVersionId,
      data.title,
      data.description || null,
      JSON.stringify(data.tagsJson),
      data.category,
      data.attribution || null,
      data.rightsDeclaration,
      data.commercialEligible,
    ],
  );
  return res.insertId;
}

export async function findShowcaseByUuid(pool: mysql.Pool | mysql.PoolConnection, showcaseUuid: string): Promise<ShowcaseRecord | null> {
  const [rows]: any = await pool.query("SELECT * FROM showcase_records WHERE showcase_uuid = ?", [showcaseUuid]);
  if (!rows[0]) return null;
  return parseShowcaseRecord(rows[0]);
}

export async function findShowcaseByUuidForUpdate(conn: mysql.PoolConnection, showcaseUuid: string): Promise<ShowcaseRecord | null> {
  const [rows]: any = await conn.query("SELECT * FROM showcase_records WHERE showcase_uuid = ? FOR UPDATE", [showcaseUuid]);
  return rows[0] ? parseShowcaseRecord(rows[0]) : null;
}

export async function findPublishedShowcaseByUuid(
  pool: mysql.Pool | mysql.PoolConnection,
  showcaseUuid: string,
): Promise<ShowcaseRecord | null> {
  const [rows]: any = await pool.query(
    `SELECT * FROM showcase_records
     WHERE showcase_uuid = ? AND moderation_state = 'approved'
       AND published_at IS NOT NULL AND unpublished_at IS NULL`,
    [showcaseUuid],
  );
  return rows[0] ? parseShowcaseRecord(rows[0]) : null;
}

export async function findLatestShowcaseByItemId(
  pool: mysql.Pool | mysql.PoolConnection,
  itemId: number,
): Promise<ShowcaseRecord | null> {
  const [rows]: any = await pool.query(
    "SELECT * FROM showcase_records WHERE fur_bin_item_id = ? ORDER BY created_at DESC LIMIT 1",
    [itemId],
  );
  return rows[0] ? parseShowcaseRecord(rows[0]) : null;
}

export async function listShowcasesByOwner(
  pool: mysql.Pool | mysql.PoolConnection,
  ownerId: string,
  page: number,
  limit: number,
): Promise<{ records: ShowcaseRecord[]; total: number }> {
  const offset = (page - 1) * limit;
  const [countRows]: any = await pool.query("SELECT COUNT(*) AS c FROM showcase_records WHERE owner_id = ?", [ownerId]);
  const [rows]: any = await pool.query(
    "SELECT * FROM showcase_records WHERE owner_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    [ownerId, limit, offset],
  );
  return { records: rows.map(parseShowcaseRecord), total: Number(countRows[0]?.c || 0) };
}

export async function searchPublishedShowcases(
  pool: mysql.Pool | mysql.PoolConnection,
  params: { query?: string; tag?: string; category?: string; page: number; limit: number },
): Promise<{ records: ShowcaseRecord[]; total: number }> {
  const where = [
    "showcase.moderation_state = 'approved'",
    "showcase.published_at IS NOT NULL",
    "showcase.unpublished_at IS NULL",
    "asset.status = 'active'",
    "asset.visibility IN ('public','published')",
  ];
  const values: any[] = [];
  if (params.query) {
    where.push("(showcase.title LIKE ? OR showcase.description LIKE ?)");
    values.push(`%${params.query}%`, `%${params.query}%`);
  }
  if (params.tag) {
    where.push("JSON_CONTAINS(showcase.tags_json, ?)");
    values.push(JSON.stringify(params.tag.toLowerCase()));
  }
  if (params.category) {
    where.push("showcase.category = ?");
    values.push(params.category);
  }
  const from = `FROM showcase_records showcase
    JOIN asset_versions version ON version.id = showcase.published_version_id
    JOIN assets asset ON asset.id = version.asset_id`;
  const whereSql = where.join(" AND ");
  const [countRows]: any = await pool.query(`SELECT COUNT(*) AS c ${from} WHERE ${whereSql}`, values);
  const [rows]: any = await pool.query(
    `SELECT showcase.* ${from} WHERE ${whereSql}
      ORDER BY showcase.published_at DESC, showcase.id DESC LIMIT ? OFFSET ?`,
    [...values, params.limit, (params.page - 1) * params.limit],
  );
  return { records: rows.map(parseShowcaseRecord), total: Number(countRows[0]?.c || 0) };
}

export async function updateShowcaseModeration(
  conn: mysql.PoolConnection,
  showcaseId: number,
  newState: ModerationState,
  moderatorId: string,
  reason?: string,
): Promise<void> {
  const [current]: any = await conn.query("SELECT moderation_state FROM showcase_records WHERE id = ?", [showcaseId]);
  const prevState = current[0]?.moderation_state || "pending";

  await conn.query(
    "UPDATE showcase_records SET moderation_state = ?, moderation_notes = ? WHERE id = ?",
    [newState, reason || null, showcaseId],
  );

  await conn.query(
    "INSERT INTO moderation_history (showcase_id, previous_state, new_state, moderator_id, reason) VALUES (?, ?, ?, ?, ?)",
    [showcaseId, prevState, newState, moderatorId, reason || null],
  );
}

export async function markShowcaseUnpublished(conn: mysql.PoolConnection, showcaseId: number): Promise<void> {
  await conn.query("UPDATE showcase_records SET unpublished_at = NOW() WHERE id = ?", [showcaseId]);
}

export async function insertShowcasePublicationEvent(
  conn: mysql.PoolConnection,
  data: {
    eventUuid: string;
    showcaseId: number;
    eventType: "submitted" | "published" | "unpublished" | "rejected" | "suspended";
    publicVersionId: number;
    actorId: string;
    evidenceHash: string;
  },
): Promise<void> {
  await conn.query(
    `INSERT INTO showcase_publication_events
      (event_uuid, showcase_id, event_type, public_version_id, actor_id, evidence_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      data.eventUuid,
      data.showcaseId,
      data.eventType,
      data.publicVersionId,
      data.actorId,
      data.evidenceHash,
    ],
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseItemRecord(r: any): FurBinItemRecord {
  return {
    ...r,
    tags_json: typeof r.tags_json === "string" ? JSON.parse(r.tags_json) : r.tags_json,
    dimensions_json: r.dimensions_json ? (typeof r.dimensions_json === "string" ? JSON.parse(r.dimensions_json) : r.dimensions_json) : null,
    has_rig: Boolean(r.has_rig),
    has_facial: Boolean(r.has_facial),
    has_animations: Boolean(r.has_animations),
  };
}

function parseShowcaseRecord(r: any): ShowcaseRecord {
  return {
    ...r,
    tags_json: typeof r.tags_json === "string" ? JSON.parse(r.tags_json) : r.tags_json,
    commercial_eligible: Boolean(r.commercial_eligible),
  };
}

function measuredRigEvidenceSql(itemAlias: string): string {
  return `SELECT 1 FROM rig_attempt_artifacts artifact
    JOIN rig_attempts attempt ON attempt.id = artifact.rig_attempt_id
    JOIN rig_jobs job ON job.id = attempt.job_id AND job.current_attempt_id = attempt.id
    JOIN rig_acceptances acceptance ON acceptance.rig_job_id = job.id AND acceptance.rig_attempt_id = attempt.id
    JOIN rig_validation_manifests manifest ON manifest.id = acceptance.manifest_id
    WHERE artifact.role = 'rigged_glb' AND artifact.asset_id = ${itemAlias}.asset_id
      AND artifact.asset_version_id = ${itemAlias}.current_version_id
      AND job.owner_id = ? AND job.state = 'accepted'
      AND manifest.bind_matrix_valid = TRUE AND manifest.mobile_budget_pass = TRUE`;
}

function measuredFacialEvidenceSql(itemAlias: string): string {
  return `${measuredRigEvidenceSql(itemAlias)}
    AND EXISTS (SELECT 1 FROM facial_inventories facial
      WHERE facial.rig_attempt_id = attempt.id AND facial.deformation_pass = TRUE
        AND facial.capability IN ('full','partial'))`;
}

function measuredAnimationEvidenceSql(itemAlias: string): string {
  return `${measuredRigEvidenceSql(itemAlias)} AND manifest.animation_sweep_pass = TRUE
    AND EXISTS (SELECT 1 FROM asset_relations animation_relation
      JOIN asset_versions animation_version ON animation_version.id = animation_relation.child_version_id
      JOIN assets animation_asset ON animation_asset.id = animation_version.asset_id
      WHERE animation_relation.parent_version_id = artifact.asset_version_id
        AND animation_relation.relation_type = 'derivative'
        AND animation_asset.asset_type = 'animation_clip'
        AND animation_asset.status = 'active')`;
}
