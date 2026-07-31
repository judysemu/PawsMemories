import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mysql from "mysql2/promise";

import { MIGRATIONS, runMigrations } from "../server/migrations/runner.ts";
import { PipelineRigRecoveryStore } from "../server/pipeline-rig-recovery.ts";

const MYSQL_HOST = process.env.MYSQL_TEST_HOST || "127.0.0.1";
const MYSQL_PORT = Number(process.env.MYSQL_TEST_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_TEST_USER || "root";
const MYSQL_PASSWORD = process.env.MYSQL_TEST_PASSWORD || "";
const TEST_DB = "paws_pipeline_rig_recovery_test";

async function mysqlAvailable() {
  try {
    const conn = await mysql.createConnection({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      connectTimeout: 2000,
    });
    await conn.end();
    return true;
  } catch {
    return false;
  }
}

const available = await mysqlAvailable();
let pool;

before(async () => {
  if (!available) return;
  const admin = await mysql.createConnection({ host: MYSQL_HOST, port: MYSQL_PORT, user: MYSQL_USER, password: MYSQL_PASSWORD });
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
  await admin.end();
  pool = mysql.createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: TEST_DB,
    connectionLimit: 4,
  });
  await pool.query(`CREATE TABLE users (
    phone VARCHAR(32) PRIMARY KEY,
    credits INT NOT NULL,
    is_admin TINYINT(1) NOT NULL DEFAULT 0
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE credit_transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_phone VARCHAR(32) NOT NULL,
    delta INT NOT NULL,
    reason VARCHAR(80) NOT NULL,
    balance_after INT NOT NULL,
    idempotency_key VARCHAR(190) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_credit_transaction_idempotency (idempotency_key)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE creations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_phone VARCHAR(32) NOT NULL,
    model_url LONGTEXT NULL,
    rigged_model_url LONGTEXT NULL,
    rig_report JSON NULL
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE generation_jobs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_phone VARCHAR(32) NOT NULL,
    creation_id INT NULL,
    kind ENUM('still','video','model') NOT NULL,
    status ENUM('queued','running','rigging','validating','done','done_static_fallback','failed') NOT NULL DEFAULT 'queued',
    operation_name VARCHAR(255) NULL,
    credits_reserved INT NOT NULL DEFAULT 0,
    error VARCHAR(512) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX (status)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE create_pipeline_sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_phone VARCHAR(32) NOT NULL,
    customization_state JSON NULL,
    status ENUM('building','complete','failed','recovery_required') NOT NULL DEFAULT 'building',
    build_job_id INT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  const migration30 = MIGRATIONS.find((migration) => migration.version === 30);
  await runMigrations(pool, [migration30]);
});

after(async () => {
  if (!available) return;
  await pool?.end();
  const admin = await mysql.createConnection({ host: MYSQL_HOST, port: MYSQL_PORT, user: MYSQL_USER, password: MYSQL_PASSWORD });
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await admin.end();
});

test("provider and rig recovery claims are leased, bounded, and refunded once", {
  skip: available ? false : "Local MySQL is not available.",
}, async () => {
  await pool.query("INSERT INTO users (phone, credits, is_admin) VALUES ('+15555550123', 100, 0)");
  const [creation] = await pool.query("INSERT INTO creations (user_phone) VALUES ('+15555550123')");
  const [job] = await pool.query(
    "INSERT INTO generation_jobs (user_phone, creation_id, kind, status, operation_name, credits_reserved) VALUES ('+15555550123', ?, 'model', 'running', 'tripo:test', 100)",
    [creation.insertId],
  );
  await pool.query(
    "INSERT INTO create_pipeline_sessions (id, user_phone, customization_state, status, build_job_id) VALUES ('session-33', '+15555550123', ?, 'building', ?)",
    [JSON.stringify({ rigging: { enabled: true, facial: true } }), job.insertId],
  );

  const firstProcess = new PipelineRigRecoveryStore(pool);
  const secondProcess = new PipelineRigRecoveryStore(pool);
  const provider = await firstProcess.claimProviderPoll(job.insertId);
  assert.equal(provider.eligible, true);
  assert.ok(provider.leaseOwner);
  const duplicateProvider = await secondProcess.claimProviderPoll(job.insertId);
  assert.equal(duplicateProvider.eligible, false);
  assert.equal(duplicateProvider.reason, "active_lease");

  const modelUrl = "https://storage.example/models/current.glb";
  await pool.query("UPDATE creations SET model_url = ? WHERE id = ?", [modelUrl, creation.insertId]);
  const prepared = await firstProcess.prepareRig(job.insertId, provider.leaseOwner, modelUrl);
  assert.equal(prepared.eligible, true);

  const attempt1 = await firstProcess.claimRigAttempt(job.insertId);
  assert.equal(attempt1.eligible, true);
  assert.equal(attempt1.attemptNumber, 1);
  const duplicateRig = await secondProcess.claimRigAttempt(job.insertId);
  assert.equal(duplicateRig.eligible, false);
  assert.equal(duplicateRig.reason, "active_lease");
  await firstProcess.recordAttemptFailure(job.insertId, attempt1.leaseOwner, "attempt one failed");

  const attempt2 = await secondProcess.claimRigAttempt(job.insertId);
  assert.equal(attempt2.eligible, true);
  assert.equal(attempt2.attemptNumber, 2);
  await secondProcess.recordAttemptFailure(job.insertId, attempt2.leaseOwner, "attempt two failed");
  const exhausted = await firstProcess.claimRigAttempt(job.insertId);
  assert.equal(exhausted.eligible, false);
  assert.equal(exhausted.reason, "attempt_budget_exhausted");

  const firstFallback = await firstProcess.finalizeRejected(job.insertId, exhausted.reason, 55);
  assert.deepEqual(firstFallback, { status: "done_static_fallback", refunded: true });
  const repeatedFallback = await secondProcess.finalizeRejected(job.insertId, exhausted.reason, 55);
  assert.deepEqual(repeatedFallback, { status: "done_static_fallback", refunded: false });

  const [[user]] = await pool.query("SELECT credits FROM users WHERE phone = '+15555550123'");
  const [[finalJob]] = await pool.query("SELECT status, rig_attempt_count, rig_refunded_at, recovery_lease_owner FROM generation_jobs WHERE id = ?", [job.insertId]);
  const [[session]] = await pool.query("SELECT status FROM create_pipeline_sessions WHERE id = 'session-33'");
  assert.equal(user.credits, 155);
  const [[refundLedger]] = await pool.query(
    "SELECT COUNT(*) AS c FROM credit_transactions WHERE idempotency_key = ?",
    [`generation-job:${job.insertId}:rig:refund`],
  );
  assert.equal(Number(refundLedger.c), 1);
  assert.equal(finalJob.status, "done_static_fallback");
  assert.equal(finalJob.rig_attempt_count, 2);
  assert.ok(finalJob.rig_refunded_at);
  assert.equal(finalJob.recovery_lease_owner, null);
  assert.equal(session.status, "complete");
});

test("a stale provider job with no model refunds the complete reservation once", {
  skip: available ? false : "Local MySQL is not available.",
}, async () => {
  const phone = "+15555550124";
  await pool.query("INSERT INTO users (phone, credits, is_admin) VALUES (?, 20, 0)", [phone]);
  const [creation] = await pool.query("INSERT INTO creations (user_phone) VALUES (?)", [phone]);
  const [job] = await pool.query(
    "INSERT INTO generation_jobs (user_phone, creation_id, kind, status, operation_name, credits_reserved) VALUES (?, ?, 'model', 'running', 'tripo:stale', 80)",
    [phone, creation.insertId],
  );
  await pool.query(
    "INSERT INTO create_pipeline_sessions (id, user_phone, customization_state, status, build_job_id) VALUES ('session-stale', ?, ?, 'building', ?)",
    [phone, JSON.stringify({ rigging: { enabled: true, facial: false } }), job.insertId],
  );

  const firstProcess = new PipelineRigRecoveryStore(pool);
  const secondProcess = new PipelineRigRecoveryStore(pool);
  const first = await firstProcess.finalizeRejected(job.insertId, "provider_job_stale", 35);
  const repeated = await secondProcess.finalizeRejected(job.insertId, "provider_job_stale", 35);

  assert.deepEqual(first, { status: "failed", refunded: true });
  assert.deepEqual(repeated, { status: "failed", refunded: false });
  const [[user]] = await pool.query("SELECT credits FROM users WHERE phone = ?", [phone]);
  const [[finalJob]] = await pool.query(
    "SELECT status, generation_refunded_at, rig_refunded_at FROM generation_jobs WHERE id = ?",
    [job.insertId],
  );
  assert.equal(user.credits, 100);
  const [[refundLedger]] = await pool.query(
    "SELECT COUNT(*) AS c FROM credit_transactions WHERE idempotency_key = ?",
    [`generation-job:${job.insertId}:generation:refund`],
  );
  assert.equal(Number(refundLedger.c), 1);
  assert.equal(finalJob.status, "failed");
  assert.ok(finalJob.generation_refunded_at);
  assert.equal(finalJob.rig_refunded_at, null);
});
