import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { runMigrations, CURRENT_SCHEMA_VERSION } from "../server/migrations/runner.ts";

const mysqlHost = process.env.MYSQL_TEST_HOST || "127.0.0.1";
const mysqlPort = Number(process.env.MYSQL_TEST_PORT || 3306);
const mysqlUser = process.env.MYSQL_TEST_USER || "root";
const mysqlPassword = process.env.MYSQL_TEST_PASSWORD || "";

export async function isMysqlServerReachable() {
  try {
    const conn = await mysql.createConnection({
      host: mysqlHost,
      port: mysqlPort,
      user: mysqlUser,
      password: mysqlPassword,
      connectTimeout: 2000,
    });
    await conn.ping();
    await conn.end();
    return true;
  } catch {
    return false;
  }
}

test("Phase 2 Real MySQL 8.4 Migrations 20-21 Test Suite", async (t) => {
  const reachable = await isMysqlServerReachable();
  if (!reachable) {
    t.skip("Local test MySQL instance not running on 127.0.0.1:3306. Provision MySQL to run integration tests.");
    return;
  }

  const testDbName = `paws_test_mig20_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  t.before(async () => {
    const adminConn = await mysql.createConnection({
      host: mysqlHost,
      port: mysqlPort,
      user: mysqlUser,
      password: mysqlPassword,
    });
    await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${testDbName}\``);
    await adminConn.end();
  });

  t.after(async () => {
    const adminConn = await mysql.createConnection({
      host: mysqlHost,
      port: mysqlPort,
      user: mysqlUser,
      password: mysqlPassword,
    });
    await adminConn.query(`DROP DATABASE IF EXISTS \`${testDbName}\``);
    await adminConn.end();
  });

  const getTestPool = () =>
    mysql.createPool({
      host: mysqlHost,
      port: mysqlPort,
      user: mysqlUser,
      password: mysqlPassword,
      database: testDbName,
      waitForConnections: true,
      connectionLimit: 5,
    });

  await t.test("1. Migrations 20-21 create and harden reference session tables", async () => {
    const pool = getTestPool();
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          phone VARCHAR(32) PRIMARY KEY,
          password_hash VARCHAR(255) NULL,
          credits INT NOT NULL DEFAULT 0
        )
      `);
      const res = await runMigrations(pool);
      assert.ok(res.applied >= 1, "Must apply migrations up to version 21");
      assert.ok(CURRENT_SCHEMA_VERSION >= 21);

      // Verify all 5 Phase 2 tables exist
      const [tables] = await pool.query(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('reference_sessions', 'reference_attempts', 'reference_views', 'reference_reports', 'reference_approvals')",
        [testDbName],
      );
      assert.equal(tables.length, 5, "All 5 reference session tables must be created");
    } finally {
      await pool.end();
    }
  });

  await t.test("2. Idempotency - rerun applies zero migrations", async () => {
    const pool = getTestPool();
    try {
      const res = await runMigrations(pool);
      assert.equal(res.applied, 0, "Rerun must apply 0 migrations");
    } finally {
      await pool.end();
    }
  });

  await t.test("3. Unique constraints for reference views and session approvals", async () => {
    const pool = getTestPool();
    try {
      const conn = await pool.getConnection();

      // Insert reference session
      const [sRes] = await conn.query(
        "INSERT INTO reference_sessions (session_uuid, owner_id, input_mode, state) VALUES ('22222222-2222-4222-8222-222222222222', '+15550001', 'text', 'ready')",
      );
      const sessionId = sRes.insertId;

      // Insert attempt 1
      const [attRes] = await conn.query(
        "INSERT INTO reference_attempts (session_id, attempt_number, idempotency_key, model, prompt_config_hash, state) VALUES (?, 1, 'idem_1', 'gemini-model', 'hash1', 'ready')",
        [sessionId],
      );
      const attemptId = attRes.insertId;

      // Create a dummy canonical asset & version for FK
      const [aRes] = await conn.query(
        "INSERT INTO assets (asset_uuid, owner_id, asset_type, visibility) VALUES ('33333333-3333-4333-8333-333333333333', '+15550001', 'reference_front', 'private')",
      );
      const assetId = aRes.insertId;

      const shaA = "a".repeat(64);
      const [vRes] = await conn.query(
        "INSERT INTO asset_versions (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key) VALUES (?, 1, ?, 'image/png', 1000, 'private', 'references/f.png')",
        [assetId, shaA],
      );
      const versionId = vRes.insertId;

      // Insert 'front' view
      await conn.query(
        "INSERT INTO reference_views (attempt_id, view_kind, asset_id, asset_version_id, width_px, height_px) VALUES (?, 'front', ?, ?, 1024, 1024)",
        [attemptId, assetId, versionId],
      );

      // Duplicate 'front' view kind for same attempt must fail (unique key)
      await assert.rejects(
        async () => {
          await conn.query(
            "INSERT INTO reference_views (attempt_id, view_kind, asset_id, asset_version_id, width_px, height_px) VALUES (?, 'front', ?, ?, 1024, 1024)",
            [attemptId, assetId, versionId],
          );
        },
        (err) => err.code === "ER_DUP_ENTRY" || err.errno === 1062,
      );

      const [otherAssetResult] = await conn.query(
        "INSERT INTO assets (asset_uuid, owner_id, asset_type, visibility) VALUES ('44444444-4444-4444-8444-444444444444', '+15550001', 'reference_left', 'private')",
      );
      const [otherVersionResult] = await conn.query(
        "INSERT INTO asset_versions (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key) VALUES (?, 1, ?, 'image/png', 1000, 'private', 'references/l.png')",
        [otherAssetResult.insertId, "b".repeat(64)],
      );
      await assert.rejects(
        () => conn.query(
          "INSERT INTO reference_views (attempt_id, view_kind, asset_id, asset_version_id, width_px, height_px) VALUES (?, 'left', ?, ?, 1024, 1024)",
          [attemptId, assetId, otherVersionResult.insertId],
        ),
        (err) => err.code === "ER_NO_REFERENCED_ROW_2" || err.errno === 1452,
      );
      await assert.rejects(
        () => conn.query(
          "INSERT INTO reference_views (attempt_id, view_kind, asset_id, asset_version_id, width_px, height_px) VALUES (?, 'left', ?, ?, 512, 1024)",
          [attemptId, otherAssetResult.insertId, otherVersionResult.insertId],
        ),
        (err) => err.code === "ER_CHECK_CONSTRAINT_VIOLATED" || err.errno === 3819,
      );

      // Insert approval
      await conn.query(
        "INSERT INTO reference_approvals (session_id, attempt_id, manifest_hash, approved_by_user) VALUES (?, ?, 'mhash123', '+15550001')",
        [sessionId, attemptId],
      );

      // Second approval for same session_id must fail (unique key on session_id)
      await assert.rejects(
        async () => {
          await conn.query(
            "INSERT INTO reference_approvals (session_id, attempt_id, manifest_hash, approved_by_user) VALUES (?, ?, 'mhash123', '+15550001')",
            [sessionId, attemptId],
          );
        },
        (err) => err.code === "ER_DUP_ENTRY" || err.errno === 1062,
      );

      conn.release();
    } finally {
      await pool.end();
    }
  });
});
