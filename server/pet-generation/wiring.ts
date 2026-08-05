import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import { putPrivateObject } from "../../storage.private";
import {
  findAssetById,
  findAssetByUuid,
  findVersionByAssetAndNumber,
  findVersionById,
} from "../assets/repository";
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
import { petGlbProductCapabilities } from "./capabilities";

/**
 * Concrete wiring of PetGlbService against this repo's real subsystems:
 * Backblaze private storage, the canonical assets/asset_versions tables, and
 * the existing signed-URL path. No stubs.
 */

export async function loadRigProfileJoints(): Promise<string[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const raw = await readFile(
      resolve(process.cwd(), "blender-worker", "profiles", "quadruped.dog.medium.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    const joints: unknown[] = Array.isArray(parsed?.joints)
      ? parsed.joints
      : parsed?.joints && typeof parsed.joints === "object"
        ? Object.keys(parsed.joints)
        : [];
    const names = joints.reduce<string[]>((result, joint) => {
      if (typeof joint === "string" && joint.trim().length > 0) result.push(joint);
      return result;
    }, []);
    if (!names.length) throw new Error("profile contains no joints");
    return [...new Set(names)];
  } catch (error) {
    throw new PetGenerationError(
      "RIG_PROFILE_UNAVAILABLE",
      "The pinned quadruped rig validation profile is unavailable",
    );
  }
}

type ReferenceUrlField = "frontUrl" | "leftUrl" | "rightUrl" | "rearUrl" | "threeQuarterUrl";

const REFERENCE_FIELD_BY_KIND: Record<string, ReferenceUrlField> = {
  front: "frontUrl",
  left: "leftUrl",
  right: "rightUrl",
  rear: "rearUrl",
  front_three_quarter: "threeQuarterUrl",
};

const ASSET_VERSION_REFERENCE = /^asset:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/versions\/([1-9][0-9]*)$/i;

async function signDurableReferenceManifest(
  pool: mysql.Pool,
  manifest: PetModelGenerationInput,
  ownerPhone: string,
  ttlSeconds: number,
): Promise<PetModelGenerationInput> {
  const signed: Partial<Record<ReferenceUrlField, string>> = {};
  for (const field of Object.values(REFERENCE_FIELD_BY_KIND)) {
    const reference = manifest[field];
    if (reference === undefined) continue;
    const match = ASSET_VERSION_REFERENCE.exec(reference);
    if (!match) {
      throw new PetGenerationError(
        "REFERENCE_VERSION_BINDING_INVALID",
        "The approved reference binding is not an exact asset version",
      );
    }
    const asset = await findAssetByUuid(pool, match[1]);
    const versionNumber = Number(match[2]);
    const version = asset
      ? await findVersionByAssetAndNumber(pool, asset.id, versionNumber)
      : null;
    if (!asset
      || !version
      || asset.owner_id !== ownerPhone
      || version.asset_id !== asset.id) {
      throw new PetGenerationError(
        "REFERENCE_LINEAGE_INVALID",
        "The approved reference asset version is unavailable for this account",
      );
    }
    signed[field] = await generateSignedUrlForVersion(asset, version, ownerPhone, false, ttlSeconds);
  }
  const required = petGlbProductCapabilities().reference.requiredViewKinds
    .map((kind) => REFERENCE_FIELD_BY_KIND[kind]);
  if (required.some((field) => typeof signed[field] !== "string")) {
    throw new PetGenerationError(
      "REFERENCES_MISSING",
      `The approved reference binding is missing required views: ${required.join(", ")}`,
    );
  }
  return signed as PetModelGenerationInput;
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

    async resolveReferenceSession({ ownerPhone, ttlSeconds, sessionUuid, sessionId, durableManifest }) {
      const pool = getPool();
      const session = sessionUuid
        ? await findSessionByUuid(pool, sessionUuid)
        : sessionId
          ? await findSessionById(pool, sessionId)
          : null;
      if (!session || session.owner_id !== ownerPhone) {
        throw new PetGenerationError("REFERENCE_SESSION_INVALID", "Reference session was not found for this account");
      }
      if (durableManifest) {
        return {
          sessionId: session.id,
          sessionUuid: session.session_uuid,
          sourceAttemptCount: session.source_attempt_count,
          signedManifest: await signDurableReferenceManifest(
            pool,
            durableManifest,
            ownerPhone,
            ttlSeconds,
          ),
          durableManifest,
        };
      }
      const attemptId = session.approved_attempt_id || session.current_attempt_id;
      if (!attemptId) {
        throw new PetGenerationError("REFERENCES_MISSING", "Reference session has no completed view set");
      }
      const views = await findViewsByAttemptId(pool, attemptId);
      const signed: Partial<Record<ReferenceUrlField, string>> = {};
      const durable: Partial<Record<ReferenceUrlField, string>> = {};
      for (const view of views) {
        const field = REFERENCE_FIELD_BY_KIND[view.view_kind];
        if (!field) continue;
        const version = await findVersionById(pool, view.asset_version_id);
        const asset = version ? await findAssetById(pool, version.asset_id) : null;
        if (!version || !asset || asset.owner_id !== ownerPhone || version.asset_id !== asset.id) {
          throw new PetGenerationError("REFERENCE_LINEAGE_INVALID", "Reference asset lineage is invalid");
        }
        signed[field] = await generateSignedUrlForVersion(asset, version, ownerPhone, false, ttlSeconds);
        durable[field] = `asset://${asset.asset_uuid}/versions/${version.version_number}`;
      }
      const required = petGlbProductCapabilities().reference.requiredViewKinds
        .map((kind) => REFERENCE_FIELD_BY_KIND[kind]);
      if (required.some((field) => typeof signed[field] !== "string" || typeof durable[field] !== "string")) {
        throw new PetGenerationError(
          "REFERENCES_MISSING",
          `Reference session does not contain the selected provider's required views: ${required.join(", ")}`,
        );
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
      const fields: ReferenceUrlField[] = petGlbProductCapabilities().reference.requiredViewKinds
        .map((kind) => ({
          front: "frontUrl",
          left: "leftUrl",
          right: "rightUrl",
          rear: "rearUrl",
        } as const)[kind]);
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
