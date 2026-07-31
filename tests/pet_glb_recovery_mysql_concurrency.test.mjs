import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mysql from "mysql2/promise";

import { MIGRATIONS, runMigrations } from "../server/migrations/runner.ts";
import { PetGlbStageRepository } from "../server/pet-generation/stageRepository.ts";
import { PetGlbOrderRepository } from "../server/pet-generation/orderRepository.ts";
import { PetGlbService } from "../server/pet-generation/service.ts";

const MYSQL_HOST = process.env.MYSQL_TEST_HOST || "127.0.0.1";
const MYSQL_PORT = Number(process.env.MYSQL_TEST_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_TEST_USER || "root";
const MYSQL_PASSWORD = process.env.MYSQL_TEST_PASSWORD || "";
const TEST_DB = "paws_pet_glb_recovery_concurrency_test";

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
let stages;
let orders;

before(async () => {
  if (!available) return;
  const admin = await mysql.createConnection({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
  await admin.end();

  pool = mysql.createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: TEST_DB,
    connectionLimit: 10,
  });

  await pool.query(`CREATE TABLE users (
    phone VARCHAR(32) PRIMARY KEY,
    credits INT NOT NULL DEFAULT 0,
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

  await runMigrations(pool, MIGRATIONS);
  stages = new PetGlbStageRepository(() => pool);
  orders = new PetGlbOrderRepository(() => pool);
});

after(async () => {
  if (!available || !pool) return;
  await pool.end();
  const admin = await mysql.createConnection({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await admin.end();
});

async function helperCreateAttempt(pool, orderId, opts) {
  const attemptUuid = opts.attemptUuid || `att-${Math.random().toString(36).slice(2, 10)}`;
  const stage = opts.stage || "base";
  const state = opts.state || "processing";
  const priceCredits = opts.priceCredits ?? 45;
  const creditsDisposition = opts.creditsDisposition || "charged";
  const chargeIdempotencyKey = opts.chargeIdempotencyKey || null;
  let providerJobId = null;
  const inputHash = opts.inputHash || "hash-default";

  if (opts.providerJobId) {
    providerJobId = opts.providerJobId;
    await pool.query(
      `INSERT INTO provider_generation_jobs
         (job_id, order_id, provider_id, provider_version, provider_task_handle)
       VALUES (?, ?, 'tripo', 'v2', ?)`,
      [providerJobId, orderId, providerJobId],
    );
  }

  const [insert] = await pool.query(
    `INSERT INTO pet_glb_stage_attempts
       (attempt_uuid, order_id, stage, attempt_number, state, input_hash,
        price_credits, credits_disposition, charge_idempotency_key, provider_job_id)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    [
      attemptUuid,
      orderId,
      stage,
      state,
      inputHash,
      priceCredits,
      creditsDisposition,
      chargeIdempotencyKey,
      providerJobId,
    ],
  );

  const attemptId = Number(insert.insertId);
  await pool.query(
    "UPDATE pet_glb_orders SET current_stage = ?, current_stage_attempt_id = ? WHERE id = ?",
    [stage, attemptId, orderId],
  );

  return { id: attemptId, attemptUuid, orderId, stage, state, priceCredits, creditsDisposition, providerJobId };
}

test("real-MySQL: concurrent recovery workers acquire exclusive lease for a stale attempt", async (t) => {
  if (!available) return t.skip("MySQL not available");

  const phone = "+15550001001";
  await pool.query("INSERT INTO users (phone, credits) VALUES (?, ?)", [phone, 100]);

  const order = await orders.createConfigured(phone, "PET_GLB_BASIC", {
    meshProfile: "hd",
    subjectProfile: "pet",
    includeTexture: true,
    includeRig: false,
    textureQuality: "standard",
    styleDirection: "realistic",
  });

  const attempt = await helperCreateAttempt(pool, order.id, {
    attemptUuid: "att-stale-lease-1",
    stage: "base",
    state: "processing",
    priceCredits: 45,
    creditsDisposition: "charged",
    inputHash: "hash-123",
  });

  // Make attempt stale by setting updated_at to 30 minutes ago
  await pool.query(
    "UPDATE pet_glb_stage_attempts SET updated_at = DATE_SUB(NOW(), INTERVAL 30 MINUTE) WHERE id = ?",
    [attempt.id],
  );

  // 5 workers attempt to claim the lease concurrently
  const workers = Array.from({ length: 5 }, (_, i) => `worker-${i + 1}`);
  const results = await Promise.all(
    workers.map((workerId) =>
      stages.claimRecoveryLease({
        orderId: order.id,
        attemptId: attempt.id,
        leaseOwner: workerId,
        staleMinutes: 10,
      }),
    ),
  );

  const claimed = results.filter(Boolean);
  assert.equal(claimed.length, 1, "Only one worker must successfully claim the lease");
  assert.ok(claimed[0]?.recoveryLeaseOwner, "Claimed attempt must have lease owner set");
});

test("real-MySQL: charged attempt without durable provider handle terminal refund is exactly once under concurrency", async (t) => {
  if (!available) return t.skip("MySQL not available");

  const phone = "+15550002002";
  const initialCredits = 100;
  const priceCredits = 45;
  const chargeCorrelation = "charge:order-test-debit-1";

  await pool.query("INSERT INTO users (phone, credits) VALUES (?, ?)", [phone, initialCredits - priceCredits]);

  // Record initial debit in credit_transactions
  await pool.query(
    `INSERT INTO credit_transactions (user_phone, delta, reason, balance_after, idempotency_key)
     VALUES (?, ?, ?, ?, ?)`,
    [phone, -priceCredits, "pet_glb_base", initialCredits - priceCredits, chargeCorrelation],
  );

  const order = await orders.createConfigured(phone, "PET_GLB_BASIC", {
    meshProfile: "hd",
    subjectProfile: "pet",
    includeTexture: false,
    includeRig: false,
    textureQuality: "standard",
    styleDirection: null,
  });

  const attempt = await helperCreateAttempt(pool, order.id, {
    attemptUuid: "att-no-handle-refund-1",
    stage: "base",
    state: "processing",
    priceCredits,
    creditsDisposition: "charged",
    chargeIdempotencyKey: chargeCorrelation,
    inputHash: "hash-456",
  });

  await pool.query(
    "UPDATE pet_glb_stage_attempts SET updated_at = DATE_SUB(NOW(), INTERVAL 20 MINUTE) WHERE id = ?",
    [attempt.id],
  );

  // Claim lease for worker-1
  const leaseOwner = "worker-1";
  const claimed = await stages.claimRecoveryLease({
    orderId: order.id,
    attemptId: attempt.id,
    leaseOwner,
    staleMinutes: 10,
  });
  assert.ok(claimed, "Lease claim must succeed");

  // Concurrently attempt terminal refund 5 times
  await Promise.all(
    Array.from({ length: 5 }, () =>
      stages.failAndRefund(order.id, attempt.id, phone, "STALE_STAGE_WITHOUT_PROVIDER_HANDLE", {
        expectedLeaseOwner: leaseOwner,
        recoveryReasonCode: "NO_DURABLE_PROVIDER_HANDLE",
        recoveryEvidence: { stage: "base", priorState: "processing", providerHandlePresent: false },
      }).catch((err) => ({ error: err.message })),
    ),
  );

  // Check user balance
  const [userRows] = await pool.query("SELECT credits FROM users WHERE phone = ?", [phone]);
  const finalCredits = Number(userRows[0].credits);
  assert.equal(finalCredits, initialCredits, "User credits must be refunded exactly once to 100");

  // Check refund ledger rows
  const [txRows] = await pool.query(
    "SELECT * FROM credit_transactions WHERE user_phone = ? AND delta > 0",
    [phone],
  );
  assert.equal(txRows.length, 1, "Exactly one refund ledger row must exist");
  assert.equal(Number(txRows[0].delta), priceCredits);
  assert.ok(
    txRows[0].idempotency_key.startsWith("wallet-debit-refund:"),
    "Refund idempotency key must be derived from immutable debit correlation",
  );
});

test("real-MySQL: recovery cannot refund an attempt that is no longer current", async (t) => {
  if (!available) return t.skip("MySQL not available");

  const phone = "+15550002502";
  const initialCredits = 100;
  const priceCredits = 45;
  const chargeCorrelation = "charge:order-transitioned-debit-1";

  await pool.query("INSERT INTO users (phone, credits) VALUES (?, ?)", [phone, initialCredits - priceCredits]);
  await pool.query(
    `INSERT INTO credit_transactions (user_phone, delta, reason, balance_after, idempotency_key)
     VALUES (?, ?, ?, ?, ?)`,
    [phone, -priceCredits, "pet_glb_base", initialCredits - priceCredits, chargeCorrelation],
  );

  const order = await orders.createConfigured(phone, "PET_GLB_BASIC", {
    meshProfile: "hd",
    subjectProfile: "pet",
    includeTexture: false,
    includeRig: false,
    textureQuality: "standard",
    styleDirection: null,
  });
  const attempt = await helperCreateAttempt(pool, order.id, {
    attemptUuid: "att-transitioned-no-refund-1",
    stage: "base",
    state: "processing",
    priceCredits,
    creditsDisposition: "charged",
    chargeIdempotencyKey: chargeCorrelation,
    inputHash: "hash-transitioned",
  });
  await pool.query(
    "UPDATE pet_glb_stage_attempts SET updated_at = DATE_SUB(NOW(), INTERVAL 20 MINUTE) WHERE id = ?",
    [attempt.id],
  );

  const leaseOwner = "worker-transitioned";
  assert.ok(await stages.claimRecoveryLease({
    orderId: order.id,
    attemptId: attempt.id,
    leaseOwner,
    staleMinutes: 10,
  }));
  await pool.query("UPDATE pet_glb_orders SET current_stage_attempt_id = NULL WHERE id = ?", [order.id]);

  await assert.rejects(
    stages.failAndRefund(order.id, attempt.id, phone, "STALE_STAGE_WITHOUT_PROVIDER_HANDLE", {
      expectedLeaseOwner: leaseOwner,
      recoveryReasonCode: "NO_DURABLE_PROVIDER_HANDLE",
    }),
    /no longer the order's current attempt/,
  );

  const [userRows] = await pool.query("SELECT credits FROM users WHERE phone = ?", [phone]);
  assert.equal(Number(userRows[0].credits), initialCredits - priceCredits, "superseded attempt must not be refunded");
  const [refundRows] = await pool.query(
    "SELECT id FROM credit_transactions WHERE user_phone = ? AND delta > 0",
    [phone],
  );
  assert.equal(refundRows.length, 0, "superseded attempt must not create a refund ledger row");
});

test("real-MySQL: durable provider handle is polled and resumed without provider create call", async (t) => {
  if (!available) return t.skip("MySQL not available");

  const phone = "+15550003003";
  await pool.query("INSERT INTO users (phone, credits) VALUES (?, ?)", [phone, 200]);

  const order = await orders.createConfigured(phone, "PET_GLB_BASIC", {
    meshProfile: "hd",
    subjectProfile: "pet",
    includeTexture: true,
    includeRig: false,
    textureQuality: "standard",
    styleDirection: null,
  });

  const attempt = await helperCreateAttempt(pool, order.id, {
    attemptUuid: "att-durable-handle-1",
    stage: "base",
    state: "processing",
    providerJobId: "tripo-durable-job-777",
    priceCredits: 45,
    creditsDisposition: "charged",
    inputHash: "hash-777",
  });

  await pool.query(
    "UPDATE pet_glb_stage_attempts SET updated_at = DATE_SUB(NOW(), INTERVAL 25 MINUTE) WHERE id = ?",
    [attempt.id],
  );

  let providerCreateCalled = false;
  let providerGetJobCalled = false;

  const mockProviderFactory = () => ({
    async createJob() {
      providerCreateCalled = true;
      throw new Error("createJob should NOT be called during recovery!");
    },
    async getJob(jobId) {
      providerGetJobCalled = true;
      assert.equal(jobId, "tripo-durable-job-777");
      return {
        id: jobId,
        status: "processing",
        progress: 50,
      };
    },
  });

  const service = new PetGlbService({
    getPool: () => pool,
    providerFactory: mockProviderFactory,
  });

  const sweepRes = await service.sweepStaleStages({ staleMinutes: 10, limit: 10 });
  assert.equal(sweepRes.inspected, 1);
  assert.equal(sweepRes.claimed, 1);
  assert.equal(sweepRes.active, 1);
  assert.equal(providerCreateCalled, false, "Provider create must NOT be called for recovery");
  assert.equal(providerGetJobCalled, true, "Provider getJob must be polled for active handle");

  // Check evidence table
  const evidenceList = await stages.listRecoveryEvidence(order.id);
  assert.equal(evidenceList.length, 1, "Recovery evidence record must exist");
  assert.equal(evidenceList[0].decision, "provider_active");
  assert.equal(evidenceList[0].reasonCode, "DURABLE_PROVIDER_ACTIVE");
  assert.equal(evidenceList[0].providerHandlePresent, true);
});

test("real-MySQL: recovery evidence is recorded without raw secrets or URLs", async (t) => {
  if (!available) return t.skip("MySQL not available");

  const phone = "+15550004004";
  await pool.query("INSERT INTO users (phone, credits) VALUES (?, ?)", [phone, 200]);

  const order = await orders.createConfigured(phone, "PET_GLB_BASIC", {
    meshProfile: "hd",
    subjectProfile: "pet",
    includeTexture: false,
    includeRig: false,
    textureQuality: "standard",
    styleDirection: null,
  });

  const attempt = await helperCreateAttempt(pool, order.id, {
    attemptUuid: "att-evidence-redact-1",
    stage: "base",
    state: "processing",
    priceCredits: 45,
    creditsDisposition: "charged",
    inputHash: "hash-888",
  });

  await stages.recordRecoveryEvidence({
    orderId: order.id,
    attemptId: attempt.id,
    decision: "terminal_refund",
    reasonCode: "NO_DURABLE_PROVIDER_HANDLE",
    providerHandlePresent: false,
    evidence: {
      stage: "base",
      priorState: "processing",
      sanitizedSummary: "Attempt timed out without durable provider task",
    },
  });

  const evidenceList = await stages.listRecoveryEvidence(order.id);
  assert.equal(evidenceList.length, 1);

  const evidenceStr = JSON.stringify(evidenceList[0]);
  assert.equal(evidenceStr.includes("http://"), false, "Evidence must not contain raw http URLs");
  assert.equal(evidenceStr.includes("https://"), false, "Evidence must not contain raw https URLs");
  assert.equal(evidenceStr.includes("secret"), false, "Evidence must not contain secret tokens");
  assert.equal(evidenceStr.includes("apiKey"), false, "Evidence must not contain API keys");
});
