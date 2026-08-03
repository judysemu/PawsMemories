import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import { putPrivateObject } from "../../storage.private";
import { findAssetById, findVersionById } from "../assets/repository";
import { generateSignedUrlForVersion } from "../assets/access";
import type { PetGlbServiceDeps } from "./service";
import type { ValidationReport } from "./validation";
import { PetGenerationError } from "./provider";
import {
  findSessionById,
  findSessionByUuid,
  findViewsByAttemptId,
} from "../reference-sessions/repository";
import type { PetModelGenerationInput } from "./types";
import { privateReferenceObjectKey } from "../assets/privateObjectReference";

/**
 * Concrete wiring of PetGlbService against this repo's real subsystems:
 * Backblaze private storage, the canonical assets/asset_versions tables, and
 * the existing signed-URL path. No stubs.
 */

async function loadRigProfileJoints(): Promise<string[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const raw = await readFile(resolve(process.cwd(), "bonemap.json"), "utf8");
    const parsed = JSON.parse(raw);
    const joints = Array.isArray(parsed?.joints)
      ? parsed.joints
      : Object.keys(parsed?.bones || parsed || {});
    return joints.filter((j: unknown): j is string => typeof j === "string");
  } catch {
    // Absent profile => rig coverage reports UNMEASURED, never a silent pass.
    return [];
  }
}

/** Operator role. Distinct from is_admin by design — see service.assertOperator. */
export async function isUserOperator(getPool: () => mysql.Pool, phone: string): Promise<boolean> {
  try {
    const [rows] = await getPool().query(
      "SELECT is_operator FROM users WHERE phone = ? LIMIT 1",
      [phone],
    );
    const arr = rows as any[];
    return arr.length ? arr[0].is_operator === 1 : false;
  } catch {
    // Column absent (migration not yet applied) => refuse, never fall back.
    return false;
  }
}

export async function buildPetGlbDeps(
  getPool: () => mysql.Pool,
  isAdmin: (phone: string) => Promise<boolean>,
): Promise<PetGlbServiceDeps> {
  const rigProfileJoints = await loadRigProfileJoints();

  return {
    getPool,
    isAdmin,
    isOperator: (phone) => isUserOperator(getPool, phone),
    rigProfileJoints,

    async resolveReferenceSession({ ownerPhone, ttlSeconds, sessionUuid, sessionId }) {
      const pool = getPool();
      const session = sessionUuid
        ? await findSessionByUuid(pool, sessionUuid)
        : sessionId
          ? await findSessionById(pool, sessionId)
          : null;
      if (!session || session.owner_id !== ownerPhone) {
        throw new PetGenerationError("REFERENCE_SESSION_INVALID", "Reference session was not found for this account");
      }
      const attemptId = session.approved_attempt_id || session.current_attempt_id;
      if (!attemptId) {
        throw new PetGenerationError("REFERENCES_MISSING", "Reference session has no completed view set");
      }
      const views = await findViewsByAttemptId(pool, attemptId);
      type ReferenceUrlField = "frontUrl" | "leftUrl" | "rightUrl" | "rearUrl" | "threeQuarterUrl";
      const signed: Partial<Record<ReferenceUrlField, string>> = {};
      const durable: Partial<Record<ReferenceUrlField, string>> = {};
      const fieldByKind: Record<string, ReferenceUrlField> = {
        front: "frontUrl",
        left: "leftUrl",
        right: "rightUrl",
        rear: "rearUrl",
        front_three_quarter: "threeQuarterUrl",
      };
      for (const view of views) {
        const field = fieldByKind[view.view_kind];
        if (!field) continue;
        const version = await findVersionById(pool, view.asset_version_id);
        const asset = version ? await findAssetById(pool, version.asset_id) : null;
        if (!version || !asset || asset.owner_id !== ownerPhone || version.asset_id !== asset.id) {
          throw new PetGenerationError("REFERENCE_LINEAGE_INVALID", "Reference asset lineage is invalid");
        }
        signed[field] = await generateSignedUrlForVersion(asset, version, ownerPhone, false, ttlSeconds);
        durable[field] = `asset://${asset.asset_uuid}/versions/${version.version_number}`;
      }
      const required: ReferenceUrlField[] = ["frontUrl", "leftUrl", "rightUrl", "rearUrl"];
      if (required.some((field) => typeof signed[field] !== "string" || typeof durable[field] !== "string")) {
        throw new PetGenerationError("REFERENCES_MISSING", "Reference session does not contain front, left, right, and rear views");
      }
      return {
        sessionId: session.id,
        sessionUuid: session.session_uuid,
        sourceAttemptCount: session.source_attempt_count,
        signedManifest: signed as PetModelGenerationInput,
        durableManifest: durable as PetModelGenerationInput,
      };
    },

    async refreshLegacyReferenceManifest(manifest, ownerPhone, ttlSeconds) {
      type ReferenceUrlField = "frontUrl" | "leftUrl" | "rightUrl" | "rearUrl" | "threeQuarterUrl";
      const fields: ReferenceUrlField[] = ["frontUrl", "leftUrl", "rightUrl", "rearUrl"];
      const refreshed: Partial<Record<ReferenceUrlField, string>> = {};
      const pool = getPool();
      for (const field of fields) {
        const objectKey = privateReferenceObjectKey(manifest[field]);
        if (!objectKey) return null;
        const [rows] = await pool.query(
          `SELECT av.id AS version_id, av.asset_id
             FROM asset_versions av
             JOIN assets a ON a.id = av.asset_id
            WHERE av.object_key = ? AND a.owner_id = ?
            ORDER BY av.id DESC LIMIT 1`,
          [objectKey, ownerPhone],
        );
        const versionId = Number((rows as any[])[0]?.version_id || 0);
        if (!versionId) return null;
        const version = await findVersionById(pool, versionId);
        const asset = version ? await findAssetById(pool, version.asset_id) : null;
        if (!version || !asset || asset.owner_id !== ownerPhone) return null;
        refreshed[field] = await generateSignedUrlForVersion(asset, version, ownerPhone, false, ttlSeconds);
      }
      return refreshed as PetModelGenerationInput;
    },

    async persistVersion({ ownerPhone, assetId, glb, sha256, validationReport, metadata, stage }) {
      const pool = getPool();

      // 1. Immutable object key — includes the content hash, so an approved
      //    key can never be overwritten by a later candidate.
      const objectKey = `pet-glb/${ownerPhone}/${sha256}.glb`;
      await putPrivateObject(objectKey, glb, "model/gltf-binary");

      // 2. Asset row (create once, reuse across candidate versions).
      let resolvedAssetId = assetId;
      if (!resolvedAssetId) {
        const assetUuid = crypto.randomUUID();
        const [res] = await pool.query(
          `INSERT INTO assets (asset_uuid, owner_id, asset_type, visibility, status)
           VALUES (?, ?, 'model_generated_glb', 'private', 'active')`,
          [assetUuid, ownerPhone],
        );
        resolvedAssetId = (res as any).insertId;
      }

      // 3. Next version number — versions are append-only.
      const [vRows] = await pool.query(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM asset_versions WHERE asset_id = ?`,
        [resolvedAssetId],
      );
      const versionNumber = (vRows as any[])[0].next;

      const [insert] = await pool.query(
        `INSERT INTO asset_versions
           (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key,
            metadata, source_provider, license, commercial_use_eligible,
            salti_condition, salti_damage, salti_margin)
         VALUES (?, ?, ?, 'model/gltf-binary', ?, 'private', ?, ?, ?, 'standard', 0, NULL, NULL, NULL)`,
        [
          resolvedAssetId,
          versionNumber,
          sha256,
          glb.length,
          objectKey,
          JSON.stringify({ ...metadata, stage: stage || "legacy", validationReport }),
          String((metadata as any).providerId || "unknown"),
        ],
      );
      const versionId = (insert as any).insertId;

      // 4. Point the asset at the newest candidate. Approval binds a specific
      //    version id separately, so this pointer is not the approval.
      await pool.query(`UPDATE assets SET current_version_id = ? WHERE id = ?`, [versionId, resolvedAssetId]);

      return { assetId: resolvedAssetId!, versionId };
    },

    async signDownload(versionId, ownerPhone, ttlSeconds) {
      const pool = getPool();
      const version = await findVersionById(pool, versionId);
      if (!version) throw new Error(`Asset version ${versionId} not found`);
      const asset = await findAssetById(pool, version.asset_id);
      if (!asset) throw new Error(`Asset ${version.asset_id} not found`);

      // isAdmin=false on every customer path — the server-to-server bypass
      // used by spatial-generator must never be reused here.
      return generateSignedUrlForVersion(asset, version, ownerPhone, false, ttlSeconds);
    },
  };
}
