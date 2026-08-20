import crypto from "node:crypto";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { runMigrations } from "../server/migrations/runner.ts";
import { ModelBuildService, ModelBuildServiceError } from "../server/model-builds/service.ts";
import { FakeModelBuildProvider } from "../server/model-builds/provider.ts";
import { resetPrivateStorageClient } from "../storage.private.ts";
import { computeOrderedManifestHash } from "../server/reference-sessions/service.ts";

const MYSQL_HOST = process.env.MYSQL_TEST_HOST || "127.0.0.1";
const MYSQL_PORT = Number(process.env.MYSQL_TEST_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_TEST_USER || "root";
const MYSQL_PASSWORD = process.env.MYSQL_TEST_PASSWORD || "";
const TEST_DB = "paws_phase3_service_test_db";
const FAST_DURABILITY_RUNTIME = { sleep: async () => {}, random: () => 0 };

// Provider-agnostic: preflight honours whatever view set the injected provider
// declares. Named for the contract, not for a specific vendor.
class FrontOnlyFakeModelBuildProvider extends FakeModelBuildProvider {
  providerId = "fake_front_only";
  modelId = "test-front-only";
  requiredReferenceViewKinds = ["front"];
}

class NotReadyFakeModelBuildProvider extends FakeModelBuildProvider {
  async preflightForCharge() {
    throw new Error("worker unavailable");
  }
}

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

describe("Phase 3 ModelBuildService Integration Test Suite", {
  skip: mysqlAvailable ? false : "Local MySQL is not available.",
}, () => {
  let pool;
  let fakeProvider;
  let service;

  before(async () => {
    process.env.MODEL_BUILD_V3_ENABLED = "true";
    process.env.MEDIA_PRIVATE_BUCKET_NAME = "paws-private-test";
    process.env.MEDIA_BUCKET_NAME = "paws-public-test";
    process.env.MEDIA_BUCKET_URL = "http://localhost:9000";
    process.env.MEDIA_BUCKET_KEY = "testkey";
    process.env.MEDIA_BUCKET_SECRET = "testsecret";
    resetPrivateStorageClient();

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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone VARCHAR(64) NOT NULL UNIQUE,
        email VARCHAR(190) NULL,
        password_hash VARCHAR(255) NULL,
        full_name VARCHAR(190) NULL,
        credits INT NOT NULL DEFAULT 0,
        is_admin TINYINT(1) DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_phone VARCHAR(64) NOT NULL,
        delta INT NOT NULL,
        reason VARCHAR(80) NOT NULL,
        balance_after INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await runMigrations(pool);

    fakeProvider = new FakeModelBuildProvider();
    service = new ModelBuildService(fakeProvider, () => pool, FAST_DURABILITY_RUNTIME);
  });

  after(async () => {
    if (pool) await pool.end();
    const adminConn = await mysql.createConnection({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
    });
    await adminConn.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await adminConn.end();
  });

  async function createApprovedReferenceSession(ownerPhone, { frontOnly = false } = {}) {
    const conn = await pool.getConnection();
    try {
      // 1. Ensure user exists with credits
      await conn.query(
        `INSERT INTO users (phone, email, password_hash, full_name, credits)
         VALUES (?, 'test@test.com', 'hash', 'Test User', 100)
         ON DUPLICATE KEY UPDATE credits = 100`,
        [ownerPhone],
      );

      // 2. Create approved session
      const sessionUuid = crypto.randomUUID();
      const [sRes] = await conn.query(
        `INSERT INTO reference_sessions (session_uuid, owner_id, input_mode, subject_class, state)
         VALUES (?, ?, 'photo', 'dog', 'approved')`,
        [sessionUuid, ownerPhone],
      );

      // 3. Create approved attempt
      const [attRes] = await conn.query(
        `INSERT INTO reference_attempts (session_id, attempt_number, idempotency_key, provider, model, prompt_config_hash, state)
         VALUES (?, 1, UUID(), ?, 'm1', REPEAT('b', 64), 'ready')`,
        [sRes.insertId, frontOnly ? "uploaded_front" : "gemini"],
      );

      await conn.query("UPDATE reference_sessions SET approved_attempt_id = ? WHERE id = ?", [attRes.insertId, sRes.insertId]);

      // 4. Create the canonical provider view set (plus legacy advisory view).
      const kinds = frontOnly ? ["front"] : ["front", "left", "right", "rear", "front_three_quarter"];
      const manifestItems = [];
      for (const kind of kinds) {
        const [vAsset] = await conn.query(
          "INSERT INTO assets (asset_uuid, owner_id, asset_type) VALUES (UUID(), ?, 'reference_view')",
          [ownerPhone],
        );
        const [vVer] = await conn.query(
          `INSERT INTO asset_versions (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key)
           VALUES (?, 1, REPEAT('c', 64), 'image/png', 500, 'private', 'view.png')`,
          [vAsset.insertId],
        );
        await conn.query(
          `INSERT INTO reference_views (attempt_id, view_kind, asset_id, asset_version_id, width_px, height_px, is_synthesized)
           VALUES (?, ?, ?, ?, 1024, 1024, 0)`,
          [attRes.insertId, kind, vAsset.insertId, vVer.insertId],
        );
        const [assetRows] = await conn.query("SELECT asset_uuid FROM assets WHERE id = ?", [vAsset.insertId]);
        manifestItems.push({ viewKind: kind, assetUuid: assetRows[0].asset_uuid, sha256: "c".repeat(64) });
      }

      // 5. Create canonical pass report and exact approved manifest.
      const reportHash = "d".repeat(64);
      const [rAsset] = await conn.query(
        "INSERT INTO assets (asset_uuid, owner_id, asset_type) VALUES (UUID(), ?, 'reference_report')",
        [ownerPhone],
      );
      const [rVer] = await conn.query(
        `INSERT INTO asset_versions (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key)
         VALUES (?, 1, ?, 'application/json', 200, 'private', 'rep.json')`,
        [rAsset.insertId, reportHash],
      );
      await conn.query(
        `INSERT INTO reference_reports (attempt_id, report_asset_id, report_asset_version_id, status, report_hash)
         VALUES (?, ?, ?, 'pass', ?)`,
        [attRes.insertId, rAsset.insertId, rVer.insertId, reportHash],
      );

      const manifestHash = computeOrderedManifestHash(
        manifestItems,
        reportHash,
        frontOnly ? ["front"] : undefined,
      );
      const [mAsset] = await conn.query(
        "INSERT INTO assets (asset_uuid, owner_id, asset_type) VALUES (UUID(), ?, 'provider_manifest')",
        [ownerPhone],
      );
      const [mVer] = await conn.query(
        `INSERT INTO asset_versions (asset_id, version_number, sha256, mime_type, size_bytes, bucket, object_key, metadata)
         VALUES (?, 1, REPEAT('a', 64), 'application/json', 100, 'private', 'm.json', ?)`,
        [mAsset.insertId, JSON.stringify({ manifestHash })],
      );

      // 6. Create approval record
      await conn.query(
        `INSERT INTO reference_approvals (session_id, attempt_id, manifest_asset_id, manifest_asset_version_id, manifest_hash, approved_by_user)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [sRes.insertId, attRes.insertId, mAsset.insertId, mVer.insertId, manifestHash, ownerPhone],
      );

      return { sessionUuid, sessionId: sRes.insertId, attemptId: attRes.insertId };
    } finally {
      conn.release();
    }
  }

  it("should return valid quote for approved reference session", async () => {
    const owner = "+15553001";
    const { sessionUuid } = await createApprovedReferenceSession(owner);

    const quote = await service.getQuote(owner, sessionUuid);
    assert.equal(quote.referenceSessionUuid, sessionUuid);
    assert.equal(quote.quotedCredits, 45);
    assert.equal(quote.sufficientBalance, true);
    assert.equal(quote.preflightPassed, true);
    assert.equal(quote.preflightErrors.length, 0);
  });

  it("should accept a truthful front-only manifest for a front-only provider", async () => {
    const owner = "+15553011";
    const { sessionUuid } = await createApprovedReferenceSession(owner, { frontOnly: true });
    const frontOnlyService = new ModelBuildService(
      new FrontOnlyFakeModelBuildProvider(),
      () => pool,
      FAST_DURABILITY_RUNTIME,
    );

    const quote = await frontOnlyService.getQuote(owner, sessionUuid);
    assert.equal(quote.preflightPassed, true);
    assert.deepEqual(quote.preflightErrors, []);
  });

  it("should fail preflight for non-existent reference session", async () => {
    const owner = "+15553002";
    const quote = await service.getQuote(owner, "00000000-0000-0000-0000-000000000000");
    assert.equal(quote.preflightPassed, false);
    assert.ok(quote.preflightErrors.some(e => e.includes("not found")));
  });

  it("should make zero provider calls on validation and balance failures", async () => {
    fakeProvider.reset();
    await assert.rejects(
      service.startBuild("+15553002", {
        referenceSessionUuid: "00000000-0000-0000-0000-000000000000",
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
      }),
      (error) => error.code === "PREFLIGHT_FAILED",
    );
    assert.equal(fakeProvider.startCalls, 0);

    const owner = "+15553005";
    const { sessionUuid } = await createApprovedReferenceSession(owner);
    await pool.query("UPDATE users SET credits = 0 WHERE phone = ?", [owner]);
    await assert.rejects(
      service.startBuild(owner, {
        referenceSessionUuid: sessionUuid,
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      }),
      (error) => error.code === "PREFLIGHT_FAILED",
    );
    assert.equal(fakeProvider.startCalls, 0);
  });

  it("should not create a job or debit credits when provider readiness fails", async () => {
    const owner = "+15553012";
    const { sessionUuid } = await createApprovedReferenceSession(owner);
    const notReadyProvider = new NotReadyFakeModelBuildProvider();
    const notReadyService = new ModelBuildService(
      notReadyProvider,
      () => pool,
      FAST_DURABILITY_RUNTIME,
    );

    await assert.rejects(
      notReadyService.startBuild(owner, {
        referenceSessionUuid: sessionUuid,
        idempotencyKey: "77777777-7777-4777-8777-777777777777",
      }),
      (error) => error.code === "PREFLIGHT_FAILED",
    );

    const [userRows] = await pool.query("SELECT credits FROM users WHERE phone = ?", [owner]);
    const [jobs] = await pool.query("SELECT id FROM model_build_jobs WHERE owner_id = ?", [owner]);
    const [events] = await pool.query("SELECT id FROM model_build_credit_events WHERE owner_id = ?", [owner]);
    assert.equal(userRows[0].credits, 100);
    assert.equal(jobs.length, 0);
    assert.equal(events.length, 0);
    assert.equal(notReadyProvider.startCalls, 0);
  });

  it("should execute full build pipeline: start -> background process -> ready -> accept", async () => {
    const owner = "+15553003";
    const { sessionUuid } = await createApprovedReferenceSession(owner);
    fakeProvider.reset();

    const idempotencyKey = "22222222-2222-4222-8222-222222222222";
    const job = await service.startBuild(owner, {
      referenceSessionUuid: sessionUuid,
      idempotencyKey,
      requestedOutput: "glb",
    });

    assert.ok(job.jobUuid);
    assert.equal(job.quotedCredits, 45);
    assert.ok(["queued", "submitted", "processing"].includes(job.state));

    // Wait for background processing to complete
    let detail;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      detail = await service.getJobDetail(owner, job.jobUuid);
      if (detail.job.state === "ready" || detail.job.state === "failed_provider" || detail.job.state === "failed_validation") break;
    }

    if (detail.job.state !== "ready") {
      console.log("Job detail on failure:", JSON.stringify(detail, null, 2));
    }
    assert.equal(detail.job.state, "ready");
    assert.ok(detail.artifacts.length >= 2); // provider_glb + validated_glb
    assert.ok(detail.report);
    assert.equal(detail.report.status, "pass");

    // Accept the build
    const valGlb = detail.artifacts.find(a => a.role === "validated_glb");
    assert.ok(valGlb);

    const acceptedJob = await service.acceptBuild(owner, job.jobUuid, {
      artifactHash: valGlb.sha256,
      reportHash: detail.report.metricsHash,
    });

    assert.equal(acceptedJob.state, "accepted");
  });

  it("should deduct credits on start and refund on failure", async () => {
    const owner = "+15553004";
    const { sessionUuid } = await createApprovedReferenceSession(owner);

    fakeProvider.reset();
    fakeProvider.shouldFail = true; // Cause provider failure

    const job = await service.startBuild(owner, {
      referenceSessionUuid: sessionUuid,
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      requestedOutput: "glb",
    });

    // Wait for failure and refund
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      const j = await service.getJobPublic(owner, job.jobUuid);
      if (j.state === "failed_provider") break;
    }

    const failedJob = await service.getJobPublic(owner, job.jobUuid);
    assert.equal(failedJob.state, "failed_provider");

    // Verify balance was refunded back to 100
    const [userRows] = await pool.query("SELECT credits FROM users WHERE phone = ?", [owner]);
    assert.equal(userRows[0].credits, 100);
    const [events] = await pool.query(
      "SELECT event_type, delta FROM model_build_credit_events WHERE owner_id = ? ORDER BY id",
      [owner],
    );
    assert.deepEqual(events.map((event) => [event.event_type, event.delta]), [["charge", -45], ["refund", 45]]);
  });
});
