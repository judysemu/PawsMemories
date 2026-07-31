import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import test from "node:test";

import { runMigrations } from "../server/migrations/runner.ts";
import {
  failGenerationJobAndRefundOnce,
  markGenerationJobDoneOnce,
  sweepPendingGenerationRefunds,
} from "../server/generationRefunds.ts";
import {
  applyWalletDebitOnce,
  refundWalletDebitOnce,
} from "../server/wallet.ts";
import { initializeLegacyUsersTable } from "./helpers/mysqlTestDatabase.mjs";

const MYSQL_CONFIG = {
  host: process.env.MYSQL_TEST_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_TEST_PORT || 3306),
  user: process.env.MYSQL_TEST_USER || "root",
  password: process.env.MYSQL_TEST_PASSWORD || "",
};
const TEST_DB = "paws_generation_refunds_test_db";

test("generation-job refunds are terminal, exact-once, and retryable on real MySQL", async (t) => {
  let pool;
  try {
    const admin = await mysql.createConnection(MYSQL_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    pool = mysql.createPool({ ...MYSQL_CONFIG, database: TEST_DB, connectionLimit: 16 });
    await initializeLegacyUsersTable(pool);
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
      rig_refunded_at DATETIME(3) NULL,
      generation_refunded_at DATETIME(3) NULL
    ) ENGINE=InnoDB`);
    await runMigrations(pool);
  } catch (error) {
    assert.fail(`Real MySQL generation-refund test must run: ${error instanceof Error ? error.message : error}`);
  }

  t.after(async () => {
    await pool.end();
    const admin = await mysql.createConnection(MYSQL_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  await pool.query(
    `INSERT INTO users (phone, email, password_hash, full_name, credits) VALUES
      ('paid-owner', 'paid@test', 'x', 'Paid', 10),
      ('admin-owner', 'admin@test', 'x', 'Admin', 10),
      ('done-owner', 'done@test', 'x', 'Done', 10),
      ('pending-owner', 'pending@test', 'x', 'Pending', 10),
      ('linked-owner', 'linked@test', 'x', 'Linked', 100)`,
  );

  await t.test("HTTP and background failure races refund one immutable job amount", async () => {
    const [inserted] = await pool.query(
      "INSERT INTO generation_jobs (user_phone, kind, status, credits_reserved) VALUES ('paid-owner','video','running',40)",
    );
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      failGenerationJobAndRefundOnce(pool, inserted.insertId, `poller-${index}`)));
    assert.equal(outcomes.filter((outcome) => outcome.refundApplied).length, 1);
    assert.ok(outcomes.every((outcome) => outcome.status === "failed"));
    const [[user]] = await pool.query("SELECT credits FROM users WHERE phone='paid-owner'");
    const [[job]] = await pool.query("SELECT status, generation_refunded_at, generation_refund_pending_at FROM generation_jobs WHERE id=?", [inserted.insertId]);
    const [[ledger]] = await pool.query("SELECT COUNT(*) AS c, MIN(delta) AS delta FROM credit_transactions WHERE idempotency_key=?", [`generation-job:${inserted.insertId}:generation:refund`]);
    assert.equal(Number(user.credits), 50);
    assert.equal(job.status, "failed");
    assert.ok(job.generation_refunded_at);
    assert.equal(job.generation_refund_pending_at, null);
    assert.deepEqual([Number(ledger.c), Number(ledger.delta)], [1, 40]);
  });

  await t.test("a completed job cannot be stale-failed or refunded", async () => {
    const [inserted] = await pool.query(
      "INSERT INTO generation_jobs (user_phone, kind, status, credits_reserved) VALUES ('done-owner','model','running',55)",
    );
    const settled = await Promise.all([
      markGenerationJobDoneOnce(pool, inserted.insertId),
      markGenerationJobDoneOnce(pool, inserted.insertId),
    ]);
    assert.equal(settled.filter((value) => value).length, 1);
    const failed = await failGenerationJobAndRefundOnce(pool, inserted.insertId, "stale provider failure");
    assert.deepEqual([failed.status, failed.refundApplied], ["done", false]);
    const [[user]] = await pool.query("SELECT credits FROM users WHERE phone='done-owner'");
    const [[ledger]] = await pool.query("SELECT COUNT(*) AS c FROM credit_transactions WHERE idempotency_key=?", [`generation-job:${inserted.insertId}:generation:refund`]);
    assert.deepEqual([Number(user.credits), Number(ledger.c)], [10, 0]);
  });

  await t.test("zero-cost jobs reach failed without minting credits", async () => {
    const [inserted] = await pool.query(
      "INSERT INTO generation_jobs (user_phone, kind, status, credits_reserved) VALUES ('admin-owner','video','queued',0)",
    );
    const result = await failGenerationJobAndRefundOnce(pool, inserted.insertId, "admin provider failure");
    assert.deepEqual([result.status, result.refundApplied, result.refundPending], ["failed", false, false]);
    const [[user]] = await pool.query("SELECT credits FROM users WHERE phone='admin-owner'");
    const [[ledger]] = await pool.query("SELECT COUNT(*) AS c FROM credit_transactions WHERE user_phone='admin-owner'");
    assert.deepEqual([Number(user.credits), Number(ledger.c)], [10, 0]);
  });

  await t.test("pending refunds are swept to the same ledger correlation", async () => {
    const [inserted] = await pool.query(
      "INSERT INTO generation_jobs (user_phone, kind, status, credits_reserved, generation_refund_pending_at) VALUES ('pending-owner','model','failed',35,NOW(3))",
    );
    const swept = await sweepPendingGenerationRefunds(pool, 10);
    assert.equal(swept.applied, 1);
    const [[user]] = await pool.query("SELECT credits FROM users WHERE phone='pending-owner'");
    const [[job]] = await pool.query("SELECT generation_refunded_at, generation_refund_pending_at, generation_refund_attempts FROM generation_jobs WHERE id=?", [inserted.insertId]);
    assert.equal(Number(user.credits), 45);
    assert.ok(job.generation_refunded_at);
    assert.equal(job.generation_refund_pending_at, null);
    assert.equal(Number(job.generation_refund_attempts), 1);
  });

  await t.test("pre-job and job failure paths converge on the linked debit", async () => {
    const debitCorrelationId = "debit:linked-generation-test";
    const debit = await applyWalletDebitOnce(pool, {
      ownerId: "linked-owner",
      correlationId: debitCorrelationId,
      amount: 40,
      reason: "animated_video",
    });
    assert.equal(debit.applied, true);
    const [inserted] = await pool.query(
      `INSERT INTO generation_jobs
        (user_phone, kind, status, credits_reserved, credit_debit_correlation_id)
       VALUES ('linked-owner','video','running',40,?)`,
      [debitCorrelationId],
    );
    await Promise.all([
      refundWalletDebitOnce(pool, debitCorrelationId),
      failGenerationJobAndRefundOnce(pool, inserted.insertId, "provider failed"),
    ]);
    const [[user]] = await pool.query("SELECT credits FROM users WHERE phone='linked-owner'");
    const [[job]] = await pool.query("SELECT status, generation_refunded_at FROM generation_jobs WHERE id=?", [inserted.insertId]);
    const [[refundLedger]] = await pool.query(
      "SELECT COUNT(*) AS c, SUM(delta) AS total FROM credit_transactions WHERE user_phone='linked-owner' AND delta > 0",
    );
    assert.deepEqual([Number(user.credits), job.status, Number(refundLedger.c), Number(refundLedger.total)], [100, "failed", 1, 40]);
    assert.ok(job.generation_refunded_at);
  });

});
