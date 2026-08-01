import test from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import { runMigrations } from "../server/migrations/runner.ts";
import { FurBinService, FurBinError } from "../server/fur-bin/service.ts";
import { initializeLegacyUsersTable } from "./helpers/mysqlTestDatabase.mjs";

const MYSQL_CONFIG = {
  host: process.env.MYSQL_TEST_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_TEST_PORT || 3306),
  user: process.env.MYSQL_TEST_USER || "root",
  password: process.env.MYSQL_TEST_PASSWORD || "",
};
const TEST_DB = "paws_phase5_service_test_db";

test("Phase 5 FurBinService Integration Test Suite", async (t) => {
  let pool;
  try {
    const admin = await mysql.createConnection(MYSQL_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    pool = mysql.createPool({ ...MYSQL_CONFIG, database: TEST_DB });
    await initializeLegacyUsersTable(pool);
    await pool.query(`CREATE TABLE generation_jobs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_phone VARCHAR(32) NOT NULL,
      creation_id INT NULL,
      kind ENUM('still','video','model') NOT NULL,
      status ENUM('queued','running','done','failed') NOT NULL DEFAULT 'queued',
      operation_name VARCHAR(255) NULL,
      credits_reserved INT NOT NULL DEFAULT 0,
      error VARCHAR(512) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX (user_phone),
      INDEX (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (err) {
    t.skip("MySQL server not available, skipping Fur Bin service integration tests.");
    return;
  }
  t.after(async () => {
    await pool.end();
    const admin = await mysql.createConnection(MYSQL_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  await runMigrations(pool);
  process.env.FUR_BIN_V5_ENABLED = "true";

  async function createAssetAndVersion(ownerPhone) {
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO users (phone, email, password_hash, full_name, credits)
         VALUES (?, 'furbin@test.com', 'hash', 'FurBin User', 100)
         ON DUPLICATE KEY UPDATE credits = 100`,
        [ownerPhone],
      );

      const [aRes] = await conn.query(
        "INSERT INTO assets (asset_uuid, owner_id, asset_type, visibility, status) VALUES (UUID(), ?, 'model_glb', 'private', 'active')",
        [ownerPhone],
      );

      const [vRes1] = await conn.query(
        `INSERT INTO asset_versions (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key, commercial_use_eligible)
         VALUES (?, 1, REPEAT('a', 64), 'model/gltf-binary', 2048, 'private', 'model_v1.glb', 1)`,
        [aRes.insertId],
      );

      const [vRes2] = await conn.query(
        `INSERT INTO asset_versions (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key, commercial_use_eligible)
         VALUES (?, 2, REPEAT('b', 64), 'model/gltf-binary', 4096, 'private', 'model_v2.glb', 1)`,
        [aRes.insertId],
      );

      await conn.query("UPDATE assets SET current_version_id = ? WHERE id = ?", [vRes2.insertId, aRes.insertId]);

      const [publicAssetResult] = await conn.query(
        "INSERT INTO assets (asset_uuid, owner_id, asset_type, visibility, status) VALUES (UUID(), ?, 'model_glb', 'published', 'active')",
        [ownerPhone],
      );
      const [publicVersionResult] = await conn.query(
        `INSERT INTO asset_versions (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key, commercial_use_eligible)
         VALUES (?, 1, REPEAT('d', 64), 'model/gltf-binary', 4096, 'private', 'model_public.glb', 1)`,
        [publicAssetResult.insertId],
      );
      await conn.query("UPDATE assets SET current_version_id = ? WHERE id = ?", [publicVersionResult.insertId, publicAssetResult.insertId]);
      await conn.query(
        "INSERT INTO asset_relations (parent_version_id, child_version_id, relation_type) VALUES (?, ?, 'derivative')",
        [vRes2.insertId, publicVersionResult.insertId],
      );

      const [assetRows] = await conn.query("SELECT asset_uuid FROM assets WHERE id = ?", [aRes.insertId]);
      const [publicRows] = await conn.query("SELECT asset_uuid FROM assets WHERE id = ?", [publicAssetResult.insertId]);
      return {
        assetId: aRes.insertId,
        assetUuid: assetRows[0].asset_uuid,
        publicDerivativeUuid: publicRows[0].asset_uuid,
        v1Id: vRes1.insertId,
        v2Id: vRes2.insertId,
        ownerPhone,
      };
    } finally {
      conn.release();
    }
  }

  await t.test("should register item, search library, rollback version, and publish showcase", async () => {
    const ownerPhone = `+1555${Math.floor(1000000 + Math.random() * 9000000)}`;
    const setup = await createAssetAndVersion(ownerPhone);
    const service = new FurBinService(() => pool, async () => "https://signed.fixture/model.glb");

    // 1. Register Item
    const registered = await service.registerItem(ownerPhone, {
      assetUuid: setup.assetUuid,
      versionNumber: 2,
      title: "Hero Golden Retriever 3D",
      description: "Custom photorealistic dog model",
      tags: ["dog", "golden", "hero"],
    });

    assert.equal(registered.title, "Hero Golden Retriever 3D");
    assert.equal(registered.hasRig, false);
    assert.equal(registered.hasFacial, false);
    assert.equal(registered.storageBytes, 6144);

    // 2. Search Private Library
    const searchRes = await service.searchLibrary(ownerPhone, { tag: "golden" });
    assert.equal(searchRes.total, 1);
    assert.equal(searchRes.items[0].itemUuid, registered.itemUuid);

    // 3. Rollback Version Pointer
    const rolledBack = await service.rollbackVersion(ownerPhone, registered.itemUuid, 1);
    assert.equal(rolledBack.itemUuid, registered.itemUuid);

    // 4. Publish Showcase Record
    const showcase = await service.publishShowcase(ownerPhone, {
      itemUuid: registered.itemUuid,
      publicDerivativeUuid: setup.publicDerivativeUuid,
      publicDerivativeVersionNumber: 1,
      title: "Showcase Golden Retriever",
      description: "Public showcase model",
      tags: ["dog", "showcase"],
      category: "pets",
      rightsDeclaration: "cc_by_4_0",
      commercialEligible: true,
    });

    assert.equal(showcase.title, "Showcase Golden Retriever");
    assert.equal(showcase.moderationState, "pending");

    // 5. Unpublish Showcase Record
    await service.unpublishShowcase(ownerPhone, showcase.showcaseUuid);
    const unpublished = await service.getShowcaseForOwner(ownerPhone, showcase.showcaseUuid);
    assert.ok(unpublished !== null);
  });

  await t.test("should refresh the front reference cover instead of returning an expired manifest URL", async () => {
    const ownerPhone = `+1555${Math.floor(1000000 + Math.random() * 9000000)}`;
    const setup = await createAssetAndVersion(ownerPhone);
    const [referenceAsset] = await pool.query(
      "INSERT INTO assets (asset_uuid, owner_id, asset_type, visibility, status) VALUES (UUID(), ?, 'reference_image', 'private', 'active')",
      [ownerPhone],
    );
    const [referenceVersion] = await pool.query(
      `INSERT INTO asset_versions
         (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key, commercial_use_eligible)
       VALUES (?, 1, REPEAT('c', 64), 'image/jpeg', 8192, 'private', 'references/session/front.jpg', 0)`,
      [referenceAsset.insertId],
    );
    await pool.query("UPDATE assets SET current_version_id = ? WHERE id = ?", [referenceVersion.insertId, referenceAsset.insertId]);
    const [referenceSession] = await pool.query(
      `INSERT INTO reference_sessions (session_uuid, owner_id, input_mode, state)
       VALUES (UUID(), ?, 'photo', 'ready')`,
      [ownerPhone],
    );
    const [referenceAttempt] = await pool.query(
      `INSERT INTO reference_attempts
         (session_id, attempt_number, idempotency_key, provider, model, prompt_config_hash, state)
       VALUES (?, 1, UUID(), 'gemini', 'fixture', REPEAT('d', 64), 'ready')`,
      [referenceSession.insertId],
    );
    await pool.query(
      "UPDATE reference_sessions SET current_attempt_id = ?, approved_attempt_id = ?, state = 'approved' WHERE id = ?",
      [referenceAttempt.insertId, referenceAttempt.insertId, referenceSession.insertId],
    );
    await pool.query(
      `INSERT INTO reference_views
         (attempt_id, view_kind, asset_id, asset_version_id, width_px, height_px, is_synthesized)
       VALUES (?, 'front', ?, ?, 1024, 1024, 1)`,
      [referenceAttempt.insertId, referenceAsset.insertId, referenceVersion.insertId],
    );
    await pool.query(
      `INSERT INTO pet_glb_orders
         (order_uuid, owner_phone, sku, state, reference_session_id, asset_id,
          reference_manifest_json, include_texture, include_rig)
       VALUES (UUID(), ?, 'pet-glb', 'delivered', ?, ?, ?, 1, 1)`,
      [
        ownerPhone,
        referenceSession.insertId,
        setup.assetId,
        JSON.stringify({
          frontUrl: "https://private.example/front.jpg?X-Amz-Signature=expired&X-Amz-Expires=900",
        }),
      ],
    );

    const service = new FurBinService(
      () => pool,
      async (_asset, version) => `https://signed.fixture/${version.object_key}`,
    );
    const registered = await service.registerItem(ownerPhone, {
      assetUuid: setup.assetUuid,
      versionNumber: 2,
      title: "Front-facing pet",
    });

    assert.equal(registered.coverUrl, "https://signed.fixture/references/session/front.jpg");
    assert.equal(registered.signedViewUrl, "https://signed.fixture/model_v2.glb");
  });

});
