import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";

import { runMigrations } from "../server/migrations/runner.ts";
import { sealPrintManifest } from "../server/stationery-v2/manifests.ts";
import { createProviderSubmission } from "../server/stationery-v2/fulfillment.ts";
import { MySqlStationeryV2Repository } from "../server/stationery-v2/repository.ts";
import { initializeLegacyUsersTable } from "./helpers/mysqlTestDatabase.mjs";

const MYSQL_CONFIG = {
  host: process.env.MYSQL_TEST_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_TEST_PORT || 3306),
  user: process.env.MYSQL_TEST_USER || "root",
  password: process.env.MYSQL_TEST_PASSWORD || "",
};

test("stationery payment evidence is consumed by exactly one concurrent print order", async (t) => {
  const database = `paws_stationery_payment_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  let admin;
  let pool;
  try {
    admin = await mysql.createConnection(MYSQL_CONFIG);
    await admin.query(`CREATE DATABASE \`${database}\``);
    pool = mysql.createPool({ ...MYSQL_CONFIG, database, connectionLimit: 8 });
    await initializeLegacyUsersTable(pool);
    await runMigrations(pool);
  } catch {
    await admin?.end().catch(() => undefined);
    t.skip("Local MySQL is unavailable for stationery payment concurrency verification.");
    return;
  }

  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  });

  const ownerId = "stationery-owner";
  const templateUuid = crypto.randomUUID();
  const renderJobUuid = crypto.randomUUID();
  const paymentUuid = crypto.randomUUID();
  const now = "2026-07-31 12:00:00.000";
  const [templateResult] = await pool.query(
    `INSERT INTO stationery_template_versions
      (template_uuid, version_number, spec_json, spec_hash, status, created_at)
     VALUES (?, 1, '{}', ?, 'active', ?)`,
    [templateUuid, "a".repeat(64), now],
  );
  await pool.query(
    `INSERT INTO stationery_render_jobs
      (job_uuid, owner_id, template_version_id, preset_id, client_idempotency_key,
       request_hash, request_json, validation_report_json, state, created_at, updated_at)
     VALUES (?, ?, ?, 'print', 'render-payment-binding', ?, '{}', '{}', 'ready', ?, ?)`,
    [renderJobUuid, ownerId, templateResult.insertId, "b".repeat(64), now, now],
  );

  const paymentEvidence = {
    paymentUuid,
    ownerId,
    state: "paid",
    fulfillmentProvider: "printful",
    providerSku: "poster-8x10",
    unitAmountMinor: 2500,
    quantity: 1,
    amountMinor: 2500,
    currency: "USD",
    confirmedAt: "2026-07-31T12:00:00.000Z",
    evidenceHash: "c".repeat(64),
  };
  await pool.query(
    `INSERT INTO stationery_payment_evidence
      (payment_uuid, owner_id, state, fulfillment_provider, provider_sku,
       unit_amount_minor, quantity, amount_minor, currency, provider,
       provider_payment_ref, confirmed_at, evidence_hash, created_at, updated_at)
     VALUES (?, ?, 'paid', 'printful', 'poster-8x10', 2500, 1, 2500,
             'USD', 'stripe', 'pi_stationery_once', ?, ?, ?, ?)`,
    [paymentUuid, ownerId, now, paymentEvidence.evidenceHash, now, now],
  );

  const repository = new MySqlStationeryV2Repository(() => pool);
  function orderInput(idempotencyKey) {
    const localOrderUuid = crypto.randomUUID();
    const manifest = sealPrintManifest({
      schemaVersion: "stationery.print-manifest.v1",
      localOrderUuid,
      fulfillmentKind: "stationery_print",
      provider: "printful",
      providerSku: "poster-8x10",
      placement: "front",
      quantity: 1,
      recipient: {
        name: "Print Customer",
        email: "print@example.com",
        address1: "1 Test Street",
        city: "Denver",
        stateCode: "CO",
        countryCode: "US",
        postalCode: "80202",
      },
      frozenFile: { assetUuid: crypto.randomUUID(), versionNumber: 1, sha256: "d".repeat(64) },
      renderManifestHash: "e".repeat(64),
      validationReportHash: "f".repeat(64),
      paidPaymentUuid: paymentUuid,
      frozenAt: "2026-07-31T12:01:00.000Z",
    });
    const submission = createProviderSubmission({
      localOrderUuid,
      provider: "printful",
      printManifestHash: manifest.manifestHash,
      paymentState: "paid",
      createdAt: "2026-07-31T12:01:00.000Z",
    });
    return {
      localOrderUuid,
      ownerId,
      renderJobUuid,
      clientIdempotencyKey: idempotencyKey,
      requestHash: crypto.createHash("sha256").update(idempotencyKey).digest("hex"),
      manifest,
      paymentEvidence,
      providerIdempotencyKey: submission.idempotencyKey,
      createdAt: "2026-07-31T12:01:00.000Z",
    };
  }

  const outcomes = await Promise.allSettled([
    repository.createFrozenPrintOrderIdempotent(orderInput("concurrent-print-a")),
    repository.createFrozenPrintOrderIdempotent(orderInput("concurrent-print-b")),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejection = outcomes.find((outcome) => outcome.status === "rejected");
  assert.equal(rejection?.reason?.message, "PAYMENT_ALREADY_CONSUMED");

  const [[paymentRow], [orderCount]] = await Promise.all([
    pool.query("SELECT consumed_local_order_uuid FROM stationery_payment_evidence WHERE payment_uuid = ?", [paymentUuid]),
    pool.query("SELECT COUNT(*) AS count FROM stationery_print_manifests"),
  ]);
  assert.ok(paymentRow[0].consumed_local_order_uuid);
  assert.equal(Number(orderCount[0].count), 1);
});
