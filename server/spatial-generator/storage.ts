import type mysql from "mysql2/promise";
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../../db";
import { registerAsset, addAssetVersion } from "../assets/service";
import { deletePrivateObject, putPrivateObject, getPrivateSignedUrl, extensionForMime, sha256Hex } from "../../storage.private";
import { SpatialArtifactRole } from "./types";

export interface StorageUploadResult {
  assetId: number;
  assetVersionId: number;
  assetUuid: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
}

export class SpatialStorage {
  private readonly pool: mysql.Pool;

  constructor(pool?: mysql.Pool) {
    this.pool = pool || getPool();
  }

  private generateObjectKey(role: SpatialArtifactRole, jobUuid: string, attemptNumber: number): string {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString("hex");
    return `models/spatial/${jobUuid}/attempt-${attemptNumber}/${role}-${timestamp}-${random}.glb`;
  }

  async uploadArtifact(
    params: {
      buffer: Buffer;
      mimeType: string;
      role: SpatialArtifactRole;
      jobUuid: string;
      attemptNumber: number;
      ownerPhone: string;
    },
  ): Promise<StorageUploadResult> {
    const { buffer, mimeType, role, jobUuid, attemptNumber, ownerPhone } = params;
    const sha256 = sha256Hex(buffer);
    const sizeBytes = buffer.length;
    const assetUuid = uuidv4();
    const objectKey = this.generateObjectKey(role, jobUuid, attemptNumber);

    // Upload to B2 private bucket
    await putPrivateObject(objectKey, buffer, mimeType);

    // Register in canonical asset registry
    const registered = await registerAsset(
      {
        ownerId: ownerPhone,
        assetType: "spatial_artifact",
        visibility: "private",
        bucket: "private",
        objectKey,
        sha256,
        mimeType,
        sizeBytes,
        metadata: {
          spatialJobUuid: jobUuid,
          attemptNumber,
          role,
        },
        sourceProvider: "spatial_generator",
        license: "proprietary",
        commercialUseEligible: false,
      },
      { internal: true },
    );

    return {
      assetId: registered.asset.id,
      assetVersionId: registered.version.id,
      assetUuid: registered.asset.asset_uuid,
      objectKey,
      sha256,
      sizeBytes,
      mimeType,
    };
  }

  async addArtifactVersion(
    params: {
      assetUuid: string;
      buffer: Buffer;
      mimeType: string;
      role: SpatialArtifactRole;
      jobUuid: string;
      attemptNumber: number;
      ownerPhone: string;
    },
  ): Promise<StorageUploadResult> {
    const { assetUuid, buffer, mimeType, role, jobUuid, attemptNumber, ownerPhone } = params;
    const sha256 = sha256Hex(buffer);
    const sizeBytes = buffer.length;
    const objectKey = this.generateObjectKey(role, jobUuid, attemptNumber);

    // Upload to B2 private bucket
    await putPrivateObject(objectKey, buffer, mimeType);

    // Add version to existing asset
    const added = await addAssetVersion(
      {
        assetUuid,
        sha256,
        mimeType,
        sizeBytes,
        bucket: "private",
        objectKey,
        metadata: {
          spatialJobUuid: jobUuid,
          attemptNumber,
          role,
        },
        sourceProvider: "spatial_generator",
        license: "proprietary",
        commercialUseEligible: false,
        setAsCurrent: false,
      },
      { internal: true },
    );

    return {
      assetId: added.asset.id,
      assetVersionId: added.version.id,
      assetUuid: added.asset.asset_uuid,
      objectKey,
      sha256,
      sizeBytes,
      mimeType,
    };
  }

  async deleteArtifact(assetId: number, assetVersionId: number): Promise<void> {
    // Get asset details first
    const conn = await this.pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT a.asset_uuid, av.object_key FROM assets a JOIN asset_versions av ON av.asset_id = a.id WHERE a.id = ? AND av.id = ?",
        [assetId, assetVersionId],
      );
      const record = (rows as any[])[0];
      if (record) {
        await deletePrivateObject(record.object_key);
        await conn.query("UPDATE assets SET status = 'deleted' WHERE id = ?", [assetId]);
      }
    } finally {
      conn.release();
    }
  }

  async getSignedUrl(assetId: number, assetVersionId: number, ttlSeconds = 900): Promise<string> {
    const conn = await this.pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT a.asset_uuid, av.version_number FROM assets a JOIN asset_versions av ON av.asset_id = a.id WHERE a.id = ? AND av.id = ?",
        [assetId, assetVersionId],
      );
      const record = (rows as any[])[0];
      if (!record) throw new Error("Asset version not found");
      const result = await getPrivateSignedUrl(record.asset_uuid, ttlSeconds);
      return result.url;
    } finally {
      conn.release();
    }
  }
}

export const spatialStorage = new SpatialStorage();