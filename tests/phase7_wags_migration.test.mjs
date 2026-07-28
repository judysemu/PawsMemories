import test from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";

import { CURRENT_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "../server/migrations/runner.ts";

const MYSQL_CONFIG = {
  host: process.env.MYSQL_TEST_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_TEST_PORT || 3306),
  user: process.env.MYSQL_TEST_USER || "root",
  password: process.env.MYSQL_TEST_PASSWORD || "",
};
const TEST_DB = "paws_wags_v2_migration_test_db";

const IDS = {
  owner: "11111111-1111-4111-8111-111111111111",
  plan: "22222222-2222-4222-8222-222222222222",
  pack: "33333333-3333-4333-8333-333333333333",
  subscription: "44444444-4444-4444-8444-444444444444",
  lifecycle: "evt_wags_paid_001",
  payment: "55555555-5555-4555-8555-555555555555",
  period: "66666666-6666-4666-8666-666666666666",
  policy: "77777777-7777-4777-8777-777777777777",
  checkout: "88888888-8888-4888-8888-888888888888",
};

test("migration 28 contains the complete durable Wags v2 schema", () => {
  const migration = MIGRATIONS.find((item) => item.version === 28);
  assert.ok(migration);
  assert.ok(CURRENT_SCHEMA_VERSION >= 28, "Wags schema changes must remain in migration 28");
  const ddl = migration.statements.join("\n");

  for (const table of [
    "wags_owner_identities_v2",
    "wags_plan_versions_v2",
    "wags_pack_versions_v2",
    "wags_subscriptions_v2",
    "wags_lifecycle_events_v2",
    "wags_payment_coverage_v2",
    "wags_entitlement_periods_v2",
    "wags_incentive_policies_v2",
    "wags_deliveries_v2",
    "wags_grants_v2",
    "wags_checkout_sessions_v2",
    "wags_reconciliation_runs_v2",
  ]) {
    assert.match(ddl, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
  }

  assert.match(ddl, /ADD COLUMN idempotency_key VARCHAR\(190\) NULL/);
  assert.match(ddl, /UNIQUE KEY uniq_credit_transaction_idempotency \(idempotency_key\)/);
  assert.match(ddl, /UNIQUE KEY uniq_wags_checkout_owner_idempotency \(owner_identity_id, idempotency_key\)/);
  assert.match(ddl, /UNIQUE KEY uniq_wags_provider_event \(provider, provider_event_id\)/);
  assert.match(ddl, /UNIQUE KEY uniq_wags_delivery_identity \(delivery_identity\)/);
  assert.match(ddl, /UNIQUE KEY uniq_wags_grant_identity \(grant_identity\)/);
  assert.match(ddl, /UNIQUE KEY uniq_wags_credit_transaction \(credit_transaction_id\)/);
  assert.match(ddl, /FOREIGN KEY \(credit_transaction_id, owner_auth_subject\) REFERENCES credit_transactions\(id, user_phone\)/);
  assert.match(ddl, /FOREIGN KEY \(subscription_id, lifecycle_event_id\) REFERENCES wags_lifecycle_events_v2\(subscription_id, id\)/);
  assert.match(ddl, /FOREIGN KEY \(subscription_id, entitlement_period_id, period_key\) REFERENCES wags_entitlement_periods_v2\(subscription_id, id, period_key\)/);
  assert.match(ddl, /FOREIGN KEY \(delivery_id, owner_identity_id\) REFERENCES wags_deliveries_v2\(id, owner_identity_id\)/);
  assert.match(ddl, /delivery_kind = 'annual_incentive'.*term_starts_at < term_ends_at/s);
  assert.match(ddl, /state <> 'complete' OR \(provider_session_ref IS NOT NULL AND checkout_url IS NOT NULL AND expires_at IS NOT NULL\)/);
});

test("migration 28 clean install enforces Wags ownership and exactly-once ledgers", async (t) => {
  let pool;
  try {
    const admin = await mysql.createConnection(MYSQL_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    pool = mysql.createPool({ ...MYSQL_CONFIG, database: TEST_DB, connectionLimit: 4 });
    await pool.query(`CREATE TABLE users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(32) NOT NULL UNIQUE,
      email VARCHAR(190) NULL,
      password_hash VARCHAR(255) NULL,
      full_name VARCHAR(120) NULL,
      credits INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch {
    t.skip("MySQL server not available, skipping Wags migration integration test.");
    return;
  }

  t.after(async () => {
    await pool.end();
    const admin = await mysql.createConnection(MYSQL_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  await pool.query(
    "INSERT INTO users (phone, email, password_hash, full_name, credits) VALUES (?, ?, 'hash', 'Wags Tester', 0)",
    ["u_wags_test", "wags@example.test"],
  );
  const firstRun = await runMigrations(pool);
  assert.ok(firstRun.applied > 0);

  const [tables] = await pool.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'wags\\_%\\_v2'`,
  );
  const tableNames = new Set(tables.map((row) => row.TABLE_NAME));
  for (const table of [
    "wags_owner_identities_v2",
    "wags_plan_versions_v2",
    "wags_pack_versions_v2",
    "wags_subscriptions_v2",
    "wags_lifecycle_events_v2",
    "wags_payment_coverage_v2",
    "wags_entitlement_periods_v2",
    "wags_incentive_policies_v2",
    "wags_deliveries_v2",
    "wags_grants_v2",
    "wags_checkout_sessions_v2",
    "wags_reconciliation_runs_v2",
  ]) assert.ok(tableNames.has(table), `${table} must exist`);

  const [creditColumns] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'credit_transactions' AND COLUMN_NAME = 'idempotency_key'`,
  );
  assert.equal(creditColumns.length, 1);

  const [ownerResult] = await pool.query(
    "INSERT INTO wags_owner_identities_v2 (owner_uuid, auth_subject) VALUES (?, ?)",
    [IDS.owner, "u_wags_test"],
  );
  const ownerId = ownerResult.insertId;
  await assert.rejects(
    pool.query("INSERT INTO wags_owner_identities_v2 (owner_uuid, auth_subject) VALUES (UUID(), 'missing_user')"),
    (error) => error.code === "ER_NO_REFERENCED_ROW_2" || error.errno === 1452,
  );

  const [planResult] = await pool.query(
    `INSERT INTO wags_plan_versions_v2
      (plan_uuid, version_number, tier, cadence, provider_price_ref, plan_hash, plan_json, active, published_at)
     VALUES (?, 1, 'plus', 'annual_prepaid', 'price_wags_annual', REPEAT('a', 64), JSON_OBJECT('name', 'Annual Plus'), TRUE, '2025-12-01 00:00:00.000')`,
    [IDS.plan],
  );
  const [packResult] = await pool.query(
    `INSERT INTO wags_pack_versions_v2
      (pack_uuid, version_number, release_period, title, tier, pack_hash, pack_json, published_at)
     VALUES (?, 1, '2026-01', 'January Pack', 'plus', REPEAT('b', 64), JSON_OBJECT('items', JSON_ARRAY()), '2025-12-15 00:00:00.000')`,
    [IDS.pack],
  );
  const [subscriptionResult] = await pool.query(
    `INSERT INTO wags_subscriptions_v2
      (subscription_uuid, owner_identity_id, plan_version_id, cadence, status, provider_subscription_ref, service_starts_at, service_ends_at)
     VALUES (?, ?, ?, 'annual_prepaid', 'active', 'sub_wags_001', '2026-01-01 00:00:00.000', '2027-01-01 00:00:00.000')`,
    [IDS.subscription, ownerId, planResult.insertId],
  );
  const subscriptionId = subscriptionResult.insertId;
  const [eventResult] = await pool.query(
    `INSERT INTO wags_lifecycle_events_v2
      (subscription_id, source, provider_event_id, event_type, payload_hash, event_json, state, disposition, occurred_at, received_at, processed_at)
     VALUES (?, 'webhook', ?, 'payment_succeeded', REPEAT('c', 64), JSON_OBJECT('type', 'payment_succeeded'), 'processed', 'applied', '2026-01-01 00:00:00.000', '2026-01-01 00:00:01.000', '2026-01-01 00:00:02.000')`,
    [subscriptionId, IDS.lifecycle],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO wags_lifecycle_events_v2
        (subscription_id, source, provider_event_id, event_type, payload_hash, event_json, occurred_at, received_at)
       VALUES (?, 'webhook', ?, 'payment_failed', REPEAT('d', 64), JSON_OBJECT(), NOW(3), NOW(3))`,
      [subscriptionId, IDS.lifecycle],
    ),
    (error) => error.code === "ER_DUP_ENTRY" || error.errno === 1062,
  );

  const [paymentResult] = await pool.query(
    `INSERT INTO wags_payment_coverage_v2
      (payment_uuid, subscription_id, lifecycle_event_id, provider_payment_ref, status, covers_from, covers_until, amount_minor, currency)
     VALUES (?, ?, ?, 'in_wags_001', 'paid', '2026-01-01 00:00:00.000', '2027-01-01 00:00:00.000', 12000, 'USD')`,
    [IDS.payment, subscriptionId, eventResult.insertId],
  );
  const [periodResult] = await pool.query(
    `INSERT INTO wags_entitlement_periods_v2
      (period_uuid, subscription_id, period_key, starts_at, ends_at, payment_coverage_id, state)
     VALUES (?, ?, '2026-01', '2026-01-01 00:00:00.000', '2026-02-01 00:00:00.000', ?, 'paid')`,
    [IDS.period, subscriptionId, paymentResult.insertId],
  );
  const [policyResult] = await pool.query(
    `INSERT INTO wags_incentive_policies_v2
      (policy_uuid, version_number, incentive_sku, policy_json, policy_hash, active_from)
     VALUES (?, 1, 'WAGS_ANNUAL_2026', JSON_OBJECT('grants', JSON_ARRAY()), REPEAT('e', 64), '2026-01-01 00:00:00.000')`,
    [IDS.policy],
  );
  const [monthlyDelivery] = await pool.query(
    `INSERT INTO wags_deliveries_v2
      (delivery_identity, subscription_id, owner_identity_id, period_key, entitlement_period_id, pack_version_id, pack_hash, delivery_kind, state)
     VALUES (CONCAT('wags-delivery-v1-', REPEAT('1', 64)), ?, ?, '2026-01', ?, ?, REPEAT('b', 64), 'monthly_pack', 'complete')`,
    [subscriptionId, ownerId, periodResult.insertId, packResult.insertId],
  );
  await pool.query(
    `INSERT INTO wags_deliveries_v2
      (delivery_identity, subscription_id, owner_identity_id, policy_version_id, term_starts_at, term_ends_at, delivery_kind, state)
     VALUES (CONCAT('wags-delivery-v1-', REPEAT('2', 64)), ?, ?, ?, '2026-01-01 00:00:00.000', '2027-01-01 00:00:00.000', 'annual_incentive', 'complete')`,
    [subscriptionId, ownerId, policyResult.insertId],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO wags_deliveries_v2
        (delivery_identity, subscription_id, owner_identity_id, period_key, delivery_kind)
       VALUES (CONCAT('wags-delivery-v1-', REPEAT('3', 64)), ?, ?, '2026-01', 'annual_incentive')`,
      [subscriptionId, ownerId],
    ),
  );

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[user]] = await connection.query("SELECT credits FROM users WHERE phone = 'u_wags_test' FOR UPDATE");
    const nextBalance = user.credits + 25;
    const [creditResult] = await connection.query(
      `INSERT INTO credit_transactions (user_phone, delta, reason, balance_after, idempotency_key)
       VALUES ('u_wags_test', 25, 'wags-plus', ?, 'wags-grant-ledger-001')`,
      [nextBalance],
    );
    await connection.query("UPDATE users SET credits = ? WHERE phone = 'u_wags_test'", [nextBalance]);
    await connection.query(
      `INSERT INTO wags_grants_v2
        (grant_identity, delivery_id, owner_identity_id, owner_auth_subject, slot_key, disposition, deliverable_kind, deliverable_json, deliverable_hash, credit_amount, credit_ledger_key, credit_transaction_id)
       VALUES (CONCAT('wags-grant-v1-', REPEAT('4', 64)), ?, ?, 'u_wags_test', 'credits', 'primary', 'credits', JSON_OBJECT('amount', 25), REPEAT('f', 64), 25, 'wags-grant-ledger-001', ?)`,
      [monthlyDelivery.insertId, ownerId, creditResult.insertId],
    );
    await connection.commit();
  } finally {
    connection.release();
  }

  const replayConnection = await pool.getConnection();
  try {
    await replayConnection.beginTransaction();
    await assert.rejects(
      replayConnection.query(
        `INSERT INTO credit_transactions (user_phone, delta, reason, balance_after, idempotency_key)
         VALUES ('u_wags_test', 25, 'wags-plus', 50, 'wags-grant-ledger-001')`,
      ),
      (error) => error.code === "ER_DUP_ENTRY" || error.errno === 1062,
    );
    await replayConnection.rollback();
  } finally {
    replayConnection.release();
  }
  const [[balance]] = await pool.query("SELECT credits FROM users WHERE phone = 'u_wags_test'");
  assert.equal(balance.credits, 25);

  await pool.query(
    `INSERT INTO wags_checkout_sessions_v2
      (checkout_uuid, owner_identity_id, plan_version_id, idempotency_key, request_hash, request_json)
     VALUES (?, ?, ?, 'checkout-key-001', REPEAT('9', 64), JSON_OBJECT('cadence', 'annual_prepaid'))`,
    [IDS.checkout, ownerId, planResult.insertId],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO wags_checkout_sessions_v2
        (checkout_uuid, owner_identity_id, plan_version_id, idempotency_key, request_hash, request_json)
       VALUES (UUID(), ?, ?, 'checkout-key-001', REPEAT('8', 64), JSON_OBJECT())`,
      [ownerId, planResult.insertId],
    ),
    (error) => error.code === "ER_DUP_ENTRY" || error.errno === 1062,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO wags_checkout_sessions_v2
        (checkout_uuid, owner_identity_id, plan_version_id, idempotency_key, request_hash, request_json, state)
       VALUES (UUID(), ?, ?, 'checkout-key-002', REPEAT('7', 64), JSON_OBJECT(), 'complete')`,
      [ownerId, planResult.insertId],
    ),
  );

  const rerun = await runMigrations(pool);
  assert.equal(rerun.applied, 0);
});
