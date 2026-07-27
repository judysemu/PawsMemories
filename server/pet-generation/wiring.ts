import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import { putPrivateObject } from "../../storage.private";
import { findAssetById, findVersionById } from "../assets/repository";
import { generateSignedUrlForVersion } from "../assets/access";
import type { PetGlbServiceDeps } from "./service";
import type { ValidationReport } from "./validation";

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

    async persistVersion({ ownerPhone, assetId, glb, sha256, validationReport, metadata }) {
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
           VALUES (?, ?, 'model_rigged_glb', 'private', 'active')`,
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
          JSON.stringify({ ...metadata, validationReport }),
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
