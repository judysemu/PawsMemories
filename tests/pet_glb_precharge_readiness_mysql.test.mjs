import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import mysql from "mysql2/promise";

import { MIGRATIONS, runMigrations } from "../server/migrations/runner.ts";
import { MySqlProviderJobStore } from "../server/pet-generation/jobStore.ts";
import { PetGlbOrderRepository } from "../server/pet-generation/orderRepository.ts";
import { PetGenerationError } from "../server/pet-generation/provider.ts";
import { PetGlbService } from "../server/pet-generation/service.ts";
import { TripoPetGenerationAdapter } from "../server/pet-generation/tripoAdapter.ts";

const MYSQL_CONFIG = {
  host: process.env.MYSQL_TEST_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_TEST_PORT || 3306),
  user: process.env.MYSQL_TEST_USER || "root",
  password: process.env.MYSQL_TEST_PASSWORD || "",
};
const TEST_DB = "paws_pet_glb_precharge_readiness_test";
const HASH = "a".repeat(64);
const BASE_CONFIGURATION = {
  meshProfile: "hd",
  subjectProfile: "pet",
  includeTexture: false,
  includeRig: false,
  textureQuality: "standard",
  styleDirection: null,
};
const TRELLIS_REFERENCE = { frontUrl: "https://references.test/front.png" };
const TRIPO_REFERENCE = {
  frontUrl: "https://references.test/front.png",
  leftUrl: "https://references.test/left.png",
  rightUrl: "https://references.test/right.png",
  rearUrl: "https://references.test/rear.png",
};

let available = false;
let pool;
let orders;

before(async () => {
  try {
    const admin = await mysql.createConnection({ ...MYSQL_CONFIG, connectTimeout: 2_000 });
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    pool = mysql.createPool({ ...MYSQL_CONFIG, database: TEST_DB, connectionLimit: 8 });
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
    orders = new PetGlbOrderRepository(() => pool);
    available = true;
  } catch {
    available = false;
  }
});

after(async () => {
  if (!pool) return;
  await pool.end();
  const admin = await mysql.createConnection(MYSQL_CONFIG);
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await admin.end();
});

function selectProduct(t, providerId, rigEnabled = false) {
  const prior = {
    provider: process.env.PAWS_3D_PROVIDER,
    inHouseOnly: process.env.PAWS_3D_INHOUSE_ONLY,
    external: process.env.PAWS_3D_EXTERNAL_PROVIDER_IDS,
    rig: process.env.PET_GLB_BODY_RIG_ENABLED,
  };
  process.env.PAWS_3D_PROVIDER = providerId;
  process.env.PAWS_3D_INHOUSE_ONLY = providerId === "trellis2" ? "true" : "false";
  process.env.PAWS_3D_EXTERNAL_PROVIDER_IDS = "tripo,fal";
  process.env.PET_GLB_BODY_RIG_ENABLED = rigEnabled ? "true" : "false";
  t.after(() => {
    for (const [key, value] of Object.entries({
      PAWS_3D_PROVIDER: prior.provider,
      PAWS_3D_INHOUSE_ONLY: prior.inHouseOnly,
      PAWS_3D_EXTERNAL_PROVIDER_IDS: prior.external,
      PET_GLB_BODY_RIG_ENABLED: prior.rig,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function providerHarness({ failPreflight = null, failSubmission = null } = {}) {
  const calls = { preflight: [], submissions: [], events: [] };
  return {
    calls,
    provider: {
      async preflightForCharge(stage) {
        calls.preflight.push(stage);
        calls.events.push(`preflight:${stage}`);
        if (failPreflight) throw new PetGenerationError(failPreflight, "readiness blocked");
      },
      async createJob(input) { return this.createBaseJob(input); },
      async createBaseJob() {
        calls.submissions.push("base");
        calls.events.push("submit:base");
        if (failSubmission) throw new PetGenerationError(failSubmission, "submission blocked");
        return { id: crypto.randomUUID(), status: "pending" };
      },
      async createTextureJob() {
        calls.submissions.push("texture");
        calls.events.push("submit:texture");
        return { id: crypto.randomUUID(), status: "pending" };
      },
      async createRigCheckJob() {
        calls.submissions.push("rig_check");
        calls.events.push("submit:rig_check");
        return { id: crypto.randomUUID(), status: "pending" };
      },
      async createRigJob() {
        calls.submissions.push("rig");
        calls.events.push("submit:rig");
        return { id: crypto.randomUUID(), status: "pending" };
      },
      async getJob(id) { return { id, status: "processing" }; },
      async cancelJob() {},
      async fetchArtifacts() { throw new Error("not used"); },
    },
  };
}

function serviceWith(provider, extra = {}) {
  let factoryCalls = 0;
  const service = new PetGlbService({
    getPool: () => pool,
    async isAdmin() { return false; },
    async persistVersion() { throw new Error("not used"); },
    async signDownload() { throw new Error("not used"); },
    providerFactory() {
      factoryCalls += 1;
      return provider;
    },
    ...extra,
  });
  return { service, factoryCalls: () => factoryCalls };
}

async function createUser(phone, credits = 200) {
  await pool.query("INSERT INTO users (phone, credits) VALUES (?, ?)", [phone, credits]);
}

async function createReferenceApproval(service, phone, manifest = TRELLIS_REFERENCE, configuration = BASE_CONFIGURATION) {
  const created = await service.createConfiguredOrder(phone, configuration);
  const submitted = await service.submitReferenceManifest(created.order.orderUuid, phone, manifest);
  const current = submitted.currentStage;
  assert.equal(current.stage, "reference");
  return {
    order: submitted.order,
    current,
    approval: {
      idempotencyKey: crypto.randomUUID(),
      attemptUuid: current.attemptUuid,
      artifactSha256: current.artifactSha256,
      assetVersionId: null,
      reportSha256: null,
      approvalHash: HASH,
    },
  };
}

async function moneyAndAttempts(phone, orderId) {
  const [[user]] = await pool.query("SELECT credits FROM users WHERE phone = ?", [phone]);
  const [[ledger]] = await pool.query(
    "SELECT COUNT(*) AS count FROM credit_transactions WHERE user_phone = ?",
    [phone],
  );
  const [[attempts]] = await pool.query(
    "SELECT COUNT(*) AS count FROM pet_glb_stage_attempts WHERE order_id = ?",
    [orderId],
  );
  return {
    credits: Number(user.credits),
    ledger: Number(ledger.count),
    attempts: Number(attempts.count),
  };
}

test("real MySQL: TRELLIS or Blender preflight failure leaves approval entirely uncharged", async (t) => {
  if (!available) return t.skip("MySQL not available");
  selectProduct(t, "trellis2");
  for (const [index, code] of ["TRELLIS_WORKER_NOT_READY", "BLENDER_WORKER_NOT_READY"].entries()) {
    const phone = `+1555111000${index}`;
    await createUser(phone);
    const harness = providerHarness({ failPreflight: code });
    const wired = serviceWith(harness.provider);
    const setup = await createReferenceApproval(wired.service, phone);

    await assert.rejects(
      wired.service.approveCustomerStage(setup.order.orderUuid, phone, setup.approval),
      (error) => error instanceof PetGenerationError && error.code === code,
    );

    assert.deepEqual(await moneyAndAttempts(phone, setup.order.id), {
      credits: 200,
      ledger: 0,
      attempts: 1,
    });
    assert.deepEqual(harness.calls.preflight, ["base"]);
    assert.deepEqual(harness.calls.submissions, []);
    assert.equal(wired.factoryCalls(), 1);
    const current = await wired.service.stageRepository.findCurrent(setup.order.id);
    assert.equal(current.state, "awaiting_customer_approval");
  }
});

test("real MySQL: retry readiness failure creates no retry attempt and no debit", async (t) => {
  if (!available) return t.skip("MySQL not available");
  selectProduct(t, "trellis2");
  const phone = "+15551110100";
  await createUser(phone);
  const order = await orders.createConfigured(phone, "CUSTOM_RIGGED_PET_GLB_V1", BASE_CONFIGURATION);
  const attemptUuid = crypto.randomUUID();
  const [insert] = await pool.query(
    `INSERT INTO pet_glb_stage_attempts
       (attempt_uuid, order_id, stage, attempt_number, state, input_hash,
        price_credits, credits_disposition, rejection_reason)
     VALUES (?, ?, 'base', 1, 'rejected', ?, 45, 'refunded', 'customer correction')`,
    [attemptUuid, order.id, HASH],
  );
  await pool.query(
    "UPDATE pet_glb_orders SET current_stage='base', current_stage_attempt_id=?, state='stage_rejected' WHERE id=?",
    [insert.insertId, order.id],
  );
  const harness = providerHarness({ failPreflight: "BLENDER_WORKER_NOT_READY" });
  const wired = serviceWith(harness.provider);

  await assert.rejects(
    wired.service.retryCustomerStage(order.orderUuid, phone, {
      attemptUuid,
      idempotencyKey: crypto.randomUUID(),
    }),
    (error) => error instanceof PetGenerationError && error.code === "BLENDER_WORKER_NOT_READY",
  );
  assert.deepEqual(await moneyAndAttempts(phone, order.id), { credits: 200, ledger: 0, attempts: 1 });
  assert.deepEqual(harness.calls.preflight, ["base"]);
  assert.deepEqual(harness.calls.submissions, []);
});

test("real MySQL: automatic rig purchase cannot debit when aggregate readiness fails", async (t) => {
  if (!available) return t.skip("MySQL not available");
  selectProduct(t, "trellis2", true);
  const phone = "+15551110200";
  await createUser(phone);
  const order = await orders.createConfigured(phone, "CUSTOM_RIGGED_PET_GLB_V1", {
    ...BASE_CONFIGURATION,
    includeRig: true,
  });
  const [base] = await pool.query(
    `INSERT INTO pet_glb_stage_attempts
       (attempt_uuid, order_id, stage, attempt_number, state, input_hash,
        artifact_sha256, price_credits, credits_disposition)
     VALUES (?, ?, 'base', 1, 'approved', ?, ?, 45, 'charged')`,
    [crypto.randomUUID(), order.id, HASH, HASH],
  );
  const [rigCheck] = await pool.query(
    `INSERT INTO pet_glb_stage_attempts
       (attempt_uuid, order_id, stage, attempt_number, state, input_hash,
        source_attempt_id, artifact_sha256, capability_report_json,
        price_credits, credits_disposition)
     VALUES (?, ?, 'rig_check', 1, 'awaiting_customer_approval', ?, ?, ?, ?, 0, 'none')`,
    [
      crypto.randomUUID(),
      order.id,
      HASH,
      base.insertId,
      HASH,
      JSON.stringify({ riggable: true, rigType: "quadruped" }),
    ],
  );
  await pool.query(
    "UPDATE pet_glb_orders SET current_stage='rig_check', current_stage_attempt_id=?, state='awaiting_rig_purchase' WHERE id=?",
    [rigCheck.insertId, order.id],
  );
  const harness = providerHarness({ failPreflight: "BLENDER_WORKER_NOT_READY" });
  const wired = serviceWith(harness.provider);

  await assert.rejects(
    wired.service.pollCustomerStage(order.orderUuid, phone, "rig_check"),
    (error) => error instanceof PetGenerationError && error.code === "BLENDER_WORKER_NOT_READY",
  );
  assert.deepEqual(await moneyAndAttempts(phone, order.id), { credits: 200, ledger: 0, attempts: 2 });
  assert.deepEqual(harness.calls.preflight, ["rig"]);
  assert.deepEqual(harness.calls.submissions, []);
  assert.equal((await wired.service.stageRepository.findCurrent(order.id)).state, "awaiting_customer_approval");
});

test("real MySQL: a post-debit readiness race is refunded before any submission", async (t) => {
  if (!available) return t.skip("MySQL not available");
  selectProduct(t, "trellis2");
  const phone = "+15551110300";
  await createUser(phone);
  let checks = 0;
  const harness = providerHarness();
  harness.provider.preflightForCharge = async (stage) => {
    harness.calls.preflight.push(stage);
    checks += 1;
    if (checks === 2) throw new PetGenerationError("BLENDER_WORKER_NOT_READY", "readiness changed");
  };
  const wired = serviceWith(harness.provider);
  const setup = await createReferenceApproval(wired.service, phone);

  await assert.rejects(
    wired.service.approveCustomerStage(setup.order.orderUuid, phone, setup.approval),
    (error) => error instanceof PetGenerationError && error.code === "BLENDER_WORKER_NOT_READY",
  );
  const [[user]] = await pool.query("SELECT credits FROM users WHERE phone=?", [phone]);
  const [ledger] = await pool.query(
    "SELECT delta FROM credit_transactions WHERE user_phone=? ORDER BY id",
    [phone],
  );
  assert.equal(Number(user.credits), 200);
  assert.deepEqual(ledger.map(({ delta }) => Number(delta)), [-45, 45]);
  assert.deepEqual(harness.calls.preflight, ["base", "base"]);
  assert.deepEqual(harness.calls.submissions, []);
  const current = await wired.service.stageRepository.findCurrent(setup.order.id);
  assert.equal(current.state, "failed");
  assert.equal(current.creditsDisposition, "refunded");
});

test("real MySQL: zero-credit rig capability submission still fails closed on fresh readiness", async (t) => {
  if (!available) return t.skip("MySQL not available");
  selectProduct(t, "trellis2", true);
  const phone = "+15551110350";
  await createUser(phone);
  const order = await orders.createConfigured(phone, "CUSTOM_RIGGED_PET_GLB_V1", {
    ...BASE_CONFIGURATION,
    includeRig: true,
  });
  const sourceJobId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO provider_generation_jobs
       (job_id, provider_id, provider_version, provider_task_handle, model, config_hash, cancelled)
     VALUES (?, 'trellis2', 'test', ?, 'test', ?, 0)`,
    [sourceJobId, `trellis2:${sourceJobId}`, HASH],
  );
  const attemptUuid = crypto.randomUUID();
  const [base] = await pool.query(
    `INSERT INTO pet_glb_stage_attempts
       (attempt_uuid, order_id, stage, attempt_number, state, input_hash,
        provider_job_id, artifact_sha256, price_credits, credits_disposition)
     VALUES (?, ?, 'base', 1, 'awaiting_customer_approval', ?, ?, ?, 45, 'charged')`,
    [attemptUuid, order.id, HASH, sourceJobId, HASH],
  );
  await pool.query(
    "UPDATE pet_glb_orders SET current_stage='base', current_stage_attempt_id=?, state='awaiting_base_approval' WHERE id=?",
    [base.insertId, order.id],
  );
  const harness = providerHarness({ failPreflight: "BLENDER_WORKER_NOT_READY" });
  const wired = serviceWith(harness.provider);

  await assert.rejects(
    wired.service.approveCustomerStage(order.orderUuid, phone, {
      idempotencyKey: crypto.randomUUID(),
      attemptUuid,
      artifactSha256: HASH,
      assetVersionId: null,
      reportSha256: null,
      approvalHash: HASH,
    }),
    (error) => error instanceof PetGenerationError && error.code === "BLENDER_WORKER_NOT_READY",
  );
  assert.deepEqual(await moneyAndAttempts(phone, order.id), { credits: 200, ledger: 0, attempts: 2 });
  assert.deepEqual(harness.calls.preflight, ["rig_check"]);
  assert.deepEqual(harness.calls.submissions, []);
  const current = await wired.service.stageRepository.findCurrent(order.id);
  assert.equal(current.stage, "rig_check");
  assert.equal(current.state, "failed");
  assert.equal(current.priceCredits, 0);
  assert.equal(current.creditsDisposition, "none");
});

test("real MySQL: Tripo retains its normal charged submission behavior", async (t) => {
  if (!available) return t.skip("MySQL not available");
  selectProduct(t, "tripo");
  const phone = "+15551110400";
  await createUser(phone);
  const calls = { starts: 0, preflight: [] };
  const modelProvider = {
    async start() {
      calls.starts += 1;
      return { providerTaskHandle: "tripo:test-task", provider: "tripo", model: "test-model" };
    },
    async poll() { return { done: false, progress: 1 }; },
    async download() { throw new Error("not used"); },
  };
  const tripo = new TripoPetGenerationAdapter(
    modelProvider,
    new MySqlProviderJobStore(() => pool),
    "test",
  );
  const ordinaryPreflight = tripo.preflightForCharge.bind(tripo);
  tripo.preflightForCharge = async (stage) => {
    calls.preflight.push(stage);
    await ordinaryPreflight(stage);
  };
  const wired = serviceWith(tripo);
  const setup = await createReferenceApproval(wired.service, phone, TRIPO_REFERENCE);
  const view = await wired.service.approveCustomerStage(setup.order.orderUuid, phone, setup.approval);

  assert.equal(view.currentStage.stage, "base");
  assert.equal(view.currentStage.state, "processing");
  assert.equal(calls.starts, 1);
  assert.deepEqual(calls.preflight, ["base", "base"]);
  assert.equal(wired.factoryCalls(), 1, "preflighted provider instance must be reused");
  assert.deepEqual(await moneyAndAttempts(phone, setup.order.id), { credits: 155, ledger: 1, attempts: 2 });
});

test("real MySQL: provider submission remains bound to the persisted asset version", async (t) => {
  if (!available) return t.skip("MySQL not available");
  selectProduct(t, "trellis2");
  const phone = "+15551110500";
  await createUser(phone);
  const sessionUuid = crypto.randomUUID();
  const [session] = await pool.query(
    `INSERT INTO reference_sessions
       (session_uuid, owner_id, input_mode, subject_class, state)
     VALUES (?, ?, 'photo', 'pet', 'approved')`,
    [sessionUuid, phone],
  );
  const assetUuidV1 = crypto.randomUUID();
  const durableV1 = { frontUrl: `asset://${assetUuidV1}/versions/1` };
  let currentSessionVersion = 1;
  const resolveCalls = [];
  const harness = providerHarness();
  harness.provider.createBaseJob = async (input) => {
    harness.calls.submissions.push("base");
    harness.calls.events.push("submit:base");
    assert.equal(input.frontUrl, "https://signed.test/exact-version-1.png");
    assert.notEqual(input.frontUrl, `https://signed.test/session-version-${currentSessionVersion}.png`);
    const jobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO provider_generation_jobs
         (job_id, provider_id, provider_version, provider_task_handle, model, config_hash, cancelled)
       VALUES (?, 'trellis2', 'test', ?, 'test', ?, 0)`,
      [jobId, `trellis2:${jobId}`, HASH],
    );
    return { id: jobId, status: "pending" };
  };
  const wired = serviceWith(harness.provider, {
    async resolveReferenceSession(input) {
      resolveCalls.push(input);
      if (input.durableManifest) {
        harness.calls.events.push("resolve:exact-version");
        assert.deepEqual(input.durableManifest, durableV1);
        return {
          sessionId: Number(session.insertId),
          sessionUuid,
          sourceAttemptCount: 2,
          signedManifest: { frontUrl: "https://signed.test/exact-version-1.png" },
          durableManifest: input.durableManifest,
        };
      }
      harness.calls.events.push("resolve:initial-session");
      return {
        sessionId: Number(session.insertId),
        sessionUuid,
        sourceAttemptCount: 1,
        signedManifest: { frontUrl: "https://signed.test/session-version-1.png" },
        durableManifest: durableV1,
      };
    },
  });
  const created = await wired.service.createConfiguredOrder(phone, BASE_CONFIGURATION);
  const submitted = await wired.service.submitReferenceManifest(
    created.order.orderUuid,
    phone,
    { frontUrl: "https://signed.test/session-version-1.png" },
    sessionUuid,
  );
  currentSessionVersion = 2;
  const current = submitted.currentStage;
  await wired.service.approveCustomerStage(created.order.orderUuid, phone, {
    idempotencyKey: crypto.randomUUID(),
    attemptUuid: current.attemptUuid,
    artifactSha256: current.artifactSha256,
    assetVersionId: null,
    reportSha256: null,
    approvalHash: HASH,
  });

  const stored = await orders.findByUuid(created.order.orderUuid);
  assert.deepEqual(stored.referenceManifest, durableV1);
  assert.equal(resolveCalls.some((call) => call.durableManifest?.frontUrl === durableV1.frontUrl), true);
  assert.deepEqual(harness.calls.preflight, ["base", "base"]);
  assert.deepEqual(harness.calls.submissions, ["base"]);
  const chargeProof = harness.calls.events.indexOf("preflight:base");
  const submission = harness.calls.events.indexOf("submit:base");
  assert.deepEqual(harness.calls.events.slice(chargeProof, submission + 1), [
    "preflight:base",
    "resolve:exact-version",
    "preflight:base",
    "submit:base",
  ]);
});
