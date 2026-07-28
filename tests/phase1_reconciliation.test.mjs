import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { runMigrations } from "../server/migrations/runner.ts";
import { registerAsset, addAssetVersion, formatPublicAssetMetadata } from "../server/assets/service.ts";
import { calculateOwnerStorageUsage } from "../server/assets/accounting.ts";
import { runAssetReconciliation } from "../server/assets/reconciliation.ts";

const mysqlHost = process.env.MYSQL_TEST_HOST || "127.0.0.1";
const mysqlPort = Number(process.env.MYSQL_TEST_PORT || 3306);
const mysqlUser = process.env.MYSQL_TEST_USER || "root";
const mysqlPassword = process.env.MYSQL_TEST_PASSWORD || "";
const INTERNAL = { internal: true };

test("Phase 1 Storage Accounting and Reconciliation Suite", async (t) => {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: mysqlHost,
      port: mysqlPort,
      user: mysqlUser,
      password: mysqlPassword,
      connectTimeout: 2000,
    });
    await conn.ping();
    await conn.end();
  } catch {
    t.skip("Local test MySQL instance not running on 127.0.0.1:3306. Provision MySQL to run reconciliation tests.");
    return;
  }

  const testDbName = `paws_test_recon_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  let pool;

  t.before(async () => {
    const adminConn = await mysql.createConnection({ host: mysqlHost, port: mysqlPort, user: mysqlUser, password: mysqlPassword });
    await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${testDbName}\``);
    await adminConn.end();

    pool = mysql.createPool({ host: mysqlHost, port: mysqlPort, user: mysqlUser, password: mysqlPassword, database: testDbName, connectionLimit: 5 });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        phone VARCHAR(32) PRIMARY KEY,
        password_hash VARCHAR(255) NULL,
        credits INT NOT NULL DEFAULT 0
      )
    `);
    await runMigrations(pool);
  });

  t.after(async () => {
    if (pool) await pool.end();
    const cleanupConn = await mysql.createConnection({ host: mysqlHost, port: mysqlPort, user: mysqlUser, password: mysqlPassword });
    await cleanupConn.query(`DROP DATABASE IF EXISTS \`${testDbName}\``);
    await cleanupConn.end();
  });

  await t.test("Distinct storage accounting avoids double-counting shared storage objects", async () => {
    const ownerId = "+15558887777";
    const sharedObjectKey = "private/shared_model.glb";
    const shaVal = "9".repeat(64);

    // Asset 1 references sharedObjectKey (50,000 bytes)
    const { asset: a1 } = await registerAsset(
      {
        ownerId,
        assetType: "model_glb",
        visibility: "private",
        mimeType: "model/gltf-binary",
        sizeBytes: 50000,
        sha256: shaVal,
        bucket: "private",
        objectKey: sharedObjectKey,
      },
      { authorization: INTERNAL, isNewObjectUpload: false, pool },
    );

    // Asset 2 references the exact same sharedObjectKey (50,000 bytes)
    await registerAsset(
      {
        ownerId,
        assetType: "model_glb",
        visibility: "private",
        mimeType: "model/gltf-binary",
        sizeBytes: 50000,
        sha256: shaVal,
        bucket: "private",
        objectKey: sharedObjectKey,
      },
      { authorization: INTERNAL, isNewObjectUpload: false, pool },
    );

    // Version 2 of Asset 1 also references sharedObjectKey
    await addAssetVersion(
      {
        assetUuid: a1.asset_uuid,
        mimeType: "model/gltf-binary",
        sizeBytes: 50000,
        sha256: shaVal,
        bucket: "private",
        objectKey: sharedObjectKey,
      },
      INTERNAL,
      pool,
    );

    const usage = await calculateOwnerStorageUsage(ownerId, pool);
    assert.equal(usage.ownerId, ownerId);
    assert.equal(usage.distinctObjectsCount, 1, "Must count distinct physical storage objects only");
    assert.equal(usage.totalSizeBytes, 50000, "Total size must equal 50000 bytes without double counting");
  });

  await t.test("Reconciliation detects invalid current version pointer in report mode and fixes it in fix mode", async () => {
    const { asset, version } = await registerAsset(
      {
        ownerId: "+15553334444",
        assetType: "source_photo",
        visibility: "private",
        mimeType: "image/png",
        sizeBytes: 1000,
        sha256: "8".repeat(64),
        bucket: "private",
        objectKey: "private/photo.png",
      },
      { authorization: INTERNAL, isNewObjectUpload: false, pool },
    );

    // Manually corrupt current_version_id to a non-existent version ID 99999 (disabling FK check for corruption test)
    await pool.query("SET FOREIGN_KEY_CHECKS=0");
    await pool.query("UPDATE assets SET current_version_id = 99999 WHERE id = ?", [asset.id]);
    await pool.query("SET FOREIGN_KEY_CHECKS=1");

    // Report-only mode
    const report1 = await runAssetReconciliation({ fixMode: false, pool });
    assert.ok(report1.totalFindings >= 1);
    const pointerFinding = report1.findings.find((f) => f.type === "INVALID_CURRENT_VERSION_POINTER");
    assert.ok(pointerFinding);
    assert.equal(pointerFinding.fixed, false);

    // Fix mode
    const report2 = await runAssetReconciliation({ fixMode: true, pool });
    const fixedFinding = report2.findings.find((f) => f.type === "INVALID_CURRENT_VERSION_POINTER");
    assert.ok(fixedFinding);
    assert.equal(fixedFinding.fixed, true);

    // Verify pointer was reconciled back to valid version ID
    const [rows] = await pool.query("SELECT current_version_id FROM assets WHERE id = ?", [asset.id]);
    assert.equal(Number(rows[0].current_version_id), version.id);
  });

  await t.test("Public asset metadata formatting never leaks internal object_key", async () => {
    const { asset, version } = await registerAsset(
      {
        ownerId: "+15552223333",
        assetType: "model_glb",
        visibility: "public",
        mimeType: "model/gltf-binary",
        sizeBytes: 12000,
        sha256: "7".repeat(64),
        bucket: "public",
        objectKey: "secret/internal/path/model_key_12345.glb",
      },
      { authorization: INTERNAL, isNewObjectUpload: false, pool },
    );

    const formatted = formatPublicAssetMetadata(asset, version);
    const jsonStr = JSON.stringify(formatted);

    assert.equal(jsonStr.includes("model_key_12345"), false, "Must not leak internal object_key in public metadata");
    assert.equal(formatted.currentVersion.object_key, undefined);
  });
});
