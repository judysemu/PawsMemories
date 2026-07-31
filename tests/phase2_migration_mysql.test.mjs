import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import { runMigrations, CURRENT_SCHEMA_VERSION } from "../server/migrations/runner.ts";
import { updateSessionSource, updateSessionState } from "../server/reference-sessions/repository.ts";

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
      const [allowanceColumns] = await pool.query(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reference_sessions' AND COLUMN_NAME = 'source_attempt_count'",
        [testDbName],
      );
      assert.equal(allowanceColumns.length, 1, "source-specific allowance column must be migrated");
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

  await t.test("4. Replacing a source resets its allowance but preserves monotonic attempt history", async () => {
    const pool = getTestPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const ownerId = "+15550041";
      const createSource = async (suffix) => {
        const [asset] = await conn.query(
          "INSERT INTO assets (asset_uuid, owner_id, asset_type, visibility) VALUES (?, ?, 'reference_source_photo', 'private')",
          [crypto.randomUUID(), ownerId],
        );
        const [version] = await conn.query(
          `INSERT INTO asset_versions
           (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key)
           VALUES (?, 1, ?, 'image/png', 1024, 'private', ?)`,
          [asset.insertId, suffix.repeat(64), `references/source-${suffix}.png`],
        );
        await conn.query("UPDATE assets SET current_version_id = ? WHERE id = ?", [version.insertId, asset.insertId]);
        return { assetId: asset.insertId, versionId: version.insertId };
      };
      const firstSource = await createSource("a");
      const replacement = await createSource("b");
      const [session] = await conn.query(
        `INSERT INTO reference_sessions
         (session_uuid, owner_id, input_mode, state, source_asset_id, source_asset_version_id,
          retry_count, source_attempt_count)
         VALUES (?, ?, 'photo', 'ready', ?, ?, 2, 2)`,
        [crypto.randomUUID(), ownerId, firstSource.assetId, firstSource.versionId],
      );
      const attemptIds = [];
      for (const attemptNumber of [1, 2]) {
        const [attempt] = await conn.query(
          `INSERT INTO reference_attempts
           (session_id, attempt_number, idempotency_key, model, prompt_config_hash, state)
           VALUES (?, ?, ?, 'fixture', ?, 'ready')`,
          [session.insertId, attemptNumber, crypto.randomUUID(), "c".repeat(64)],
        );
        attemptIds.push(attempt.insertId);
      }
      await conn.query(
        "UPDATE reference_sessions SET current_attempt_id = ?, approved_attempt_id = ? WHERE id = ?",
        [attemptIds[1], attemptIds[1], session.insertId],
      );

      await updateSessionSource(conn, session.insertId, replacement.assetId, replacement.versionId);
      const [afterReplacementRows] = await conn.query(
        "SELECT state, retry_count, source_attempt_count, current_attempt_id, approved_attempt_id FROM reference_sessions WHERE id = ?",
        [session.insertId],
      );
      assert.deepEqual(
        {
          state: afterReplacementRows[0].state,
          lifetime: Number(afterReplacementRows[0].retry_count),
          source: Number(afterReplacementRows[0].source_attempt_count),
          current: afterReplacementRows[0].current_attempt_id,
          approved: afterReplacementRows[0].approved_attempt_id,
        },
        { state: "draft", lifetime: 2, source: 0, current: null, approved: null },
      );

      const nextAttemptNumber = Number(afterReplacementRows[0].retry_count) + 1;
      const [third] = await conn.query(
        `INSERT INTO reference_attempts
         (session_id, attempt_number, idempotency_key, model, prompt_config_hash, state)
         VALUES (?, ?, ?, 'fixture', ?, 'queued')`,
        [session.insertId, nextAttemptNumber, crypto.randomUUID(), "d".repeat(64)],
      );
      await updateSessionState(conn, session.insertId, "generating", {
        currentAttemptId: third.insertId,
        incrementRetry: true,
        incrementSourceAttempt: true,
      });

      const [attemptRows] = await conn.query(
        "SELECT attempt_number FROM reference_attempts WHERE session_id = ? ORDER BY attempt_number",
        [session.insertId],
      );
      assert.deepEqual(attemptRows.map((row) => Number(row.attempt_number)), [1, 2, 3]);
      const [finalRows] = await conn.query(
        "SELECT retry_count, source_attempt_count FROM reference_sessions WHERE id = ?",
        [session.insertId],
      );
      assert.equal(Number(finalRows[0].retry_count), 3);
      assert.equal(Number(finalRows[0].source_attempt_count), 1);
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
      await pool.end();
    }
  });
});
