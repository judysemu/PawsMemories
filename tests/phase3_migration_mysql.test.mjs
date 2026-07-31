import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { runMigrations, CURRENT_SCHEMA_VERSION, MIGRATIONS } from "../server/migrations/runner.ts";
import { initializeLegacyUsersTable } from "./helpers/mysqlTestDatabase.mjs";

const MYSQL_HOST = process.env.MYSQL_TEST_HOST || "127.0.0.1";
const MYSQL_PORT = Number(process.env.MYSQL_TEST_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_TEST_USER || "root";
const MYSQL_PASSWORD = process.env.MYSQL_TEST_PASSWORD || "";
const TEST_DB = "paws_phase3_test_db";

async function isMysqlServerReachable() {
  try {
    const connection = await mysql.createConnection({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      connectTimeout: 2000,
    });
    await connection.ping();
    await connection.end();
    return true;
  } catch {
    return false;
  }
}

const mysqlAvailable = await isMysqlServerReachable();

describe("Phase 3 Migration 22 MySQL Integration", {
  skip: mysqlAvailable ? false : "Local MySQL is not available.",
}, () => {
  let pool;

  before(async () => {
    const adminConn = await mysql.createConnection({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
    });
    await adminConn.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await adminConn.query(`CREATE DATABASE \`${TEST_DB}\``);
    await adminConn.end();

    pool = mysql.createPool({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: TEST_DB,
      waitForConnections: true,
      connectionLimit: 5,
    });
    await initializeLegacyUsersTable(pool);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
    const adminConn = await mysql.createConnection({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
    });
    await adminConn.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await adminConn.end();
  });

  it("should execute all managed migrations while preserving Phase 3 tables", async () => {
    const result = await runMigrations(pool);
    // On a fresh database every managed migration is recorded exactly once —
    // including skipWhenTableMissing entries, which are ledgered even when their
    // optional legacy tables may be absent. Later product migrations are
    // intentionally included in the same production registry.
    assert.equal(result.applied, MIGRATIONS.length);
    assert.ok(CURRENT_SCHEMA_VERSION >= 22);

    const [rows] = await pool.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE 'model_%'`,
      [TEST_DB],
    );
    const tableNames = rows.map((r) => r.TABLE_NAME);
    const expected = [
      "model_build_jobs",
      "model_build_attempts",
      "model_provider_events",
      "model_build_artifacts",
      "model_post_build_reports",
      "model_build_acceptances",
      "model_build_credit_events",
    ];
    for (const tbl of expected) {
      assert.ok(tableNames.includes(tbl), `Table ${tbl} should exist`);
    }

    const [jobColumns] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'model_build_jobs'`,
      [TEST_DB],
    );
    const jobColumnNames = new Set(jobColumns.map((row) => row.COLUMN_NAME));
    for (const column of ["refund_pending_at", "refund_attempts", "last_refund_error_code"]) {
      assert.equal(jobColumnNames.has(column), true, `model_build_jobs.${column} should exist`);
    }

    const [attemptColumns] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'model_build_attempts'`,
      [TEST_DB],
    );
    const attemptColumnNames = new Set(attemptColumns.map((row) => row.COLUMN_NAME));
    for (const column of ["submission_claimed_at", "recovery_required_at", "handle_persist_attempts"]) {
      assert.equal(attemptColumnNames.has(column), true, `model_build_attempts.${column} should exist`);
    }
  });

  it("should be idempotent when rerun on an already upgraded database", async () => {
    const result = await runMigrations(pool);
    assert.equal(result.applied, 0, "No new migrations should be applied");
  });

  it("should enforce foreign key constraint when inserting invalid reference_session_id", async () => {
    const conn = await pool.getConnection();
    try {
      await assert.rejects(
        async () => {
          await conn.query(
            `INSERT INTO model_build_jobs
              (job_uuid, owner_id, reference_session_id, reference_attempt_id,
               manifest_asset_id, manifest_asset_version_id, manifest_hash,
               pricing_key, quoted_credits, state)
             VALUES (UUID(), 'user1', 999999, 999999, 999999, 999999, REPEAT('a', 64), 'STATIC_3D_PHOTO', 45, 'draft')`,
          );
        },
        (err) => {
          return err.code === "ER_NO_REFERENCED_ROW_2" || err.errno === 1452;
        },
      );
    } finally {
      conn.release();
    }
  });

  it("should enforce UNIQUE key on idempotency_key in model_build_attempts", async () => {
    const conn = await pool.getConnection();
    try {
      const [aRes] = await conn.query(
        "INSERT INTO assets (asset_uuid, owner_id, asset_type) VALUES (UUID(), '+15550001', 'reference_source_photo')",
      );
      const [vRes] = await conn.query(
        `INSERT INTO asset_versions (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key)
         VALUES (?, 1, REPEAT('a', 64), 'image/jpeg', 100, 'private', 'k1')`,
        [aRes.insertId],
      );

      const [sRes] = await conn.query(
        `INSERT INTO reference_sessions (session_uuid, owner_id, input_mode, subject_class, state)
         VALUES (UUID(), '+15550001', 'photo', 'dog', 'approved')`,
      );

      const [attRes] = await conn.query(
        `INSERT INTO reference_attempts (session_id, attempt_number, idempotency_key, provider, model, prompt_config_hash, state)
         VALUES (?, 1, UUID(), 'gemini', 'm1', REPEAT('b', 64), 'ready')`,
        [sRes.insertId],
      );

      const [jRes] = await conn.query(
        `INSERT INTO model_build_jobs
          (job_uuid, owner_id, reference_session_id, reference_attempt_id,
           manifest_asset_id, manifest_asset_version_id, manifest_hash,
           pricing_key, quoted_credits, state)
         VALUES (UUID(), '+15550001', ?, ?, ?, ?, REPEAT('c', 64), 'STATIC_3D_PHOTO', 45, 'draft')`,
        [sRes.insertId, attRes.insertId, aRes.insertId, vRes.insertId],
      );

      const idemKey = "00000000-0000-0000-0000-000000000001";
      await conn.query(
        `INSERT INTO model_build_attempts (job_id, attempt_number, idempotency_key, provider, model, input_config_hash)
         VALUES (?, 1, ?, 'tripo', 'def', REPEAT('d', 64))`,
        [jRes.insertId, idemKey],
      );

      await assert.rejects(
        async () => {
          await conn.query(
            `INSERT INTO model_build_attempts (job_id, attempt_number, idempotency_key, provider, model, input_config_hash)
             VALUES (?, 2, ?, 'tripo', 'def', REPEAT('e', 64))`,
            [jRes.insertId, idemKey],
          );
        },
        (err) => err.code === "ER_DUP_ENTRY" || err.errno === 1062,
      );
    } finally {
      conn.release();
    }
  });

  it("should handle concurrent migration calls safely", async () => {
    const pool2 = mysql.createPool({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: TEST_DB,
      connectionLimit: 2,
    });
    try {
      const [r1, r2] = await Promise.all([
        runMigrations(pool),
        runMigrations(pool2),
      ]);
      assert.equal(r1.applied + r2.applied, 0);
    } finally {
      await pool2.end();
    }
  });
});
