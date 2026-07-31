import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { runMigrations } from "../server/migrations/runner.ts";
import { ReferenceSessionService, ReferenceSessionError, computeOrderedManifestHash } from "../server/reference-sessions/service.ts";
import { FakeReferenceImageProvider } from "../server/reference-sessions/provider.ts";
import { ORDERED_VIEW_KINDS } from "../server/reference-sessions/types.ts";

const mysqlHost = process.env.MYSQL_TEST_HOST || "127.0.0.1";
const mysqlPort = Number(process.env.MYSQL_TEST_PORT || 3306);
const mysqlUser = process.env.MYSQL_TEST_USER || "root";
const mysqlPassword = process.env.MYSQL_TEST_PASSWORD || "";

class BlockingReferenceImageProvider {
  name = "blocking_fake";
  model = "blocking-reference-provider-v1";
  calls = 0;
  delegate = new FakeReferenceImageProvider();
  started;
  #markStarted;
  #release;
  #released;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
    this.#released = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  release() {
    this.#release();
  }

  async generateMultiview(input, inputMode) {
    this.calls += 1;
    this.#markStarted();
    await this.#released;
    return this.delegate.generateMultiview(input, inputMode);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function poolWithConnectionQueryHook(pool, beforeQuery) {
  return new Proxy(pool, {
    get(target, property) {
      if (property === "getConnection") {
        return async () => {
          const connection = await target.getConnection();
          return new Proxy(connection, {
            get(connectionTarget, connectionProperty) {
              if (connectionProperty === "query") {
                return async (sql, params) => {
                  await beforeQuery(String(sql));
                  return connectionTarget.query(sql, params);
                };
              }
              const value = Reflect.get(connectionTarget, connectionProperty, connectionTarget);
              return typeof value === "function" ? value.bind(connectionTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("Phase 2 Production Reference Session Service Suite", async (t) => {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: mysqlHost,
      port: mysqlPort,
      user: mysqlUser,
      password: mysqlPassword,
      connectTimeout: 2000,
    });
    await conn.ping();
    await conn.end();
  } catch {
    t.skip("Local test MySQL instance not running on 127.0.0.1:3306. Provision MySQL to run service tests.");
    return;
  }

  process.env.MULTIVIEW_APPROVAL_ENABLED = "true";
  process.env.MEDIA_BUCKET_NAME = "paws-public-test";
  process.env.MEDIA_PRIVATE_BUCKET_NAME = "paws-private-test";
  process.env.MEDIA_BUCKET_URL = "http://localhost:9000";
  process.env.MEDIA_BUCKET_KEY = "testkey";
  process.env.MEDIA_BUCKET_SECRET = "testsecret";
  process.env.REFERENCE_GENERATION_GLOBAL_DAILY_ATTEMPT_CAP = "100";
  process.env.REFERENCE_GENERATION_GLOBAL_MINUTE_ATTEMPT_CAP = "20";
  process.env.REFERENCE_GENERATION_GLOBAL_CONCURRENT_ATTEMPT_CAP = "5";

  const testDbName = `paws_test_refserv_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const adminConn = await mysql.createConnection({ host: mysqlHost, port: mysqlPort, user: mysqlUser, password: mysqlPassword });
  await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${testDbName}\``);
  await adminConn.end();

  const pool = mysql.createPool({ host: mysqlHost, port: mysqlPort, user: mysqlUser, password: mysqlPassword, database: testDbName, connectionLimit: 5 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      phone VARCHAR(32) PRIMARY KEY,
      password_hash VARCHAR(255) NULL,
      credits INT NOT NULL DEFAULT 0
    )
  `);
  await runMigrations(pool);

  const service = new ReferenceSessionService(new FakeReferenceImageProvider(), () => pool);

  t.after(async () => {
    delete process.env.MULTIVIEW_APPROVAL_ENABLED;
    delete process.env.REFERENCE_GENERATION_GLOBAL_DAILY_ATTEMPT_CAP;
    delete process.env.REFERENCE_GENERATION_GLOBAL_MINUTE_ATTEMPT_CAP;
    delete process.env.REFERENCE_GENERATION_GLOBAL_CONCURRENT_ATTEMPT_CAP;
    await pool.end();
    const cleanupConn = await mysql.createConnection({ host: mysqlHost, port: mysqlPort, user: mysqlUser, password: mysqlPassword });
    await cleanupConn.query(`DROP DATABASE IF EXISTS \`${testDbName}\``);
    await cleanupConn.end();
  });

  await t.test("1. createSession initializes session in draft state", async () => {
    const ownerId = "+15551113333";
    const session = await service.createSession(ownerId, {
      inputMode: "text",
      prompt: "A fluffy golden retriever puppy",
    });

    assert.ok(session.session_uuid);
    assert.equal(session.owner_id, ownerId);
    assert.equal(session.input_mode, "text");
    assert.equal(session.state, "draft");
    assert.equal(session.retry_count, 0);
  });

  await t.test("2. startOrRetryAttempt generates 5 canonical reference views and consistency report", async () => {
    const ownerId = "+15551113333";
    const session = await service.createSession(ownerId, {
      inputMode: "text",
      prompt: "A golden retriever puppy",
    });

    const idempotencyKey = "idem_key_1";
    const { session: updatedSession, attempt } = await service.startOrRetryAttempt(
      ownerId,
      session.session_uuid,
      idempotencyKey,
    );

    assert.equal(updatedSession.state, "ready");
    assert.equal(attempt.attempt_number, 1);
    assert.equal(attempt.state, "ready");

    const publicData = await service.getSessionPublic(session.session_uuid, ownerId, false);
    assert.equal(publicData.views.length, 5);
    const viewKinds = publicData.views.map((v) => v.viewKind);
    assert.deepEqual(viewKinds, ORDERED_VIEW_KINDS);

    assert.ok(publicData.report);
    assert.equal(publicData.report.status, "warn");
    assert.ok(publicData.manifestHash);
  });

  await t.test("3. Idempotent attempt call returns existing attempt without re-generation", async () => {
    const ownerId = "+15551113333";
    const session = await service.createSession(ownerId, { inputMode: "text", prompt: "A tabby cat" });
    const idempotencyKey = "idem_idempotent_test";

    const { attempt: att1 } = await service.startOrRetryAttempt(ownerId, session.session_uuid, idempotencyKey);
    const { attempt: att2 } = await service.startOrRetryAttempt(ownerId, session.session_uuid, idempotencyKey);

    assert.equal(att1.id, att2.id);
  });

  await t.test("3b. Concurrent idempotent starts invoke the provider only once", async () => {
    const ownerId = "+15551114444";
    const provider = new FakeReferenceImageProvider();
    const concurrentService = new ReferenceSessionService(provider, () => pool);
    const session = await concurrentService.createSession(ownerId, { inputMode: "text", prompt: "A beagle" });
    const [first, second] = await Promise.all([
      concurrentService.startOrRetryAttempt(ownerId, session.session_uuid, "same-concurrent-key"),
      concurrentService.startOrRetryAttempt(ownerId, session.session_uuid, "same-concurrent-key"),
    ]);
    assert.equal(first.attempt.id, second.attempt.id);
    assert.equal(provider.calls, 1);
  });

  await t.test("3c. New sessions are not blocked by another pet's attempt history", async () => {
    const ownerId = "+15551115555";
    const provider = new FakeReferenceImageProvider();
    const cappedService = new ReferenceSessionService(provider, () => pool);
    const first = await cappedService.createSession(ownerId, { inputMode: "text", prompt: "A terrier" });
    await cappedService.startOrRetryAttempt(ownerId, first.session_uuid, "daily-cap-first");
    assert.equal(provider.calls, 1);
    const replay = await cappedService.startOrRetryAttempt(ownerId, first.session_uuid, "daily-cap-first");
    assert.equal(replay.attempt.attempt_number, 1);
    assert.equal(provider.calls, 1);
    const [ownerAttemptRows] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM reference_attempts a
       INNER JOIN reference_sessions s ON s.id = a.session_id
       WHERE s.owner_id = ? AND a.started_at >= NOW() - INTERVAL 24 HOUR`,
      [ownerId],
    );
    assert.equal(Number(ownerAttemptRows[0].count), 1);

    const second = await cappedService.createSession(ownerId, { inputMode: "text", prompt: "A spaniel" });
    await cappedService.startOrRetryAttempt(ownerId, second.session_uuid, "daily-cap-second");
    assert.equal(provider.calls, 2);
  });

  await t.test("3d. Durable concurrency cap blocks a second provider invocation", async () => {
    const firstProvider = new BlockingReferenceImageProvider();
    const secondProvider = new FakeReferenceImageProvider();
    const firstService = new ReferenceSessionService(firstProvider, () => pool);
    const secondService = new ReferenceSessionService(secondProvider, () => pool);
    const first = await firstService.createSession("+15551116661", { inputMode: "text", prompt: "A poodle" });
    const second = await secondService.createSession("+15551116662", { inputMode: "text", prompt: "A corgi" });
    process.env.REFERENCE_GENERATION_GLOBAL_CONCURRENT_ATTEMPT_CAP = "1";
    const firstRun = firstService.startOrRetryAttempt("+15551116661", first.session_uuid, "concurrent-cap-first");
    await firstProvider.started;
    try {
      await assert.rejects(
        secondService.startOrRetryAttempt("+15551116662", second.session_uuid, "concurrent-cap-second"),
        (err) => err instanceof ReferenceSessionError && err.code === "CONCURRENT_ATTEMPT_CAP",
      );
      assert.equal(secondProvider.calls, 0);
    } finally {
      firstProvider.release();
      process.env.REFERENCE_GENERATION_GLOBAL_CONCURRENT_ATTEMPT_CAP = "5";
    }
    await firstRun;
  });

  await t.test("3e. Concurrent admission sees an attempt committed after its transaction snapshot", async () => {
    const firstProvider = new BlockingReferenceImageProvider();
    const secondProvider = new FakeReferenceImageProvider();
    const firstInsertReached = deferred();
    const releaseFirstInsert = deferred();
    const secondLockReached = deferred();
    let firstInsertBlocked = false;
    let secondLockObserved = false;

    const firstPool = poolWithConnectionQueryHook(pool, async (sql) => {
      if (!firstInsertBlocked && sql.includes("INSERT INTO reference_attempts")) {
        firstInsertBlocked = true;
        firstInsertReached.resolve();
        await releaseFirstInsert.promise;
      }
    });
    const secondPool = poolWithConnectionQueryHook(pool, async (sql) => {
      if (!secondLockObserved && sql.includes("SELECT GET_LOCK")) {
        secondLockObserved = true;
        secondLockReached.resolve();
      }
    });
    const firstService = new ReferenceSessionService(firstProvider, () => firstPool);
    const secondService = new ReferenceSessionService(secondProvider, () => secondPool);
    const first = await firstService.createSession("+15551117771", { inputMode: "text", prompt: "A dachshund" });
    const second = await secondService.createSession("+15551117772", { inputMode: "text", prompt: "A schnauzer" });

    process.env.REFERENCE_GENERATION_GLOBAL_CONCURRENT_ATTEMPT_CAP = "1";
    const firstRun = firstService.startOrRetryAttempt("+15551117771", first.session_uuid, "snapshot-first");
    await firstInsertReached.promise;
    const secondRun = secondService.startOrRetryAttempt("+15551117772", second.session_uuid, "snapshot-second");
    await secondLockReached.promise;
    releaseFirstInsert.resolve();

    try {
      await assert.rejects(
        secondRun,
        (err) => err instanceof ReferenceSessionError && err.code === "CONCURRENT_ATTEMPT_CAP",
      );
      assert.equal(secondProvider.calls, 0);
    } finally {
      firstProvider.release();
      process.env.REFERENCE_GENERATION_GLOBAL_CONCURRENT_ATTEMPT_CAP = "5";
      await firstRun;
      await secondRun.catch(() => {});
    }
  });

  await t.test("4. approveManifest approves session with matching 5-view manifest hash and enters terminal state", async () => {
    const ownerId = "+15551113333";
    const session = await service.createSession(ownerId, { inputMode: "text", prompt: "A husky dog" });
    await service.startOrRetryAttempt(ownerId, session.session_uuid, "idem_husky");

    const readyPublic = await service.getSessionPublic(session.session_uuid, ownerId, false);
    const validHash = readyPublic.manifestHash;

    // Approval with invalid hash must fail
    await assert.rejects(
      async () => {
        await service.approveManifest(ownerId, session.session_uuid, "0".repeat(64));
      },
      (err) => err instanceof ReferenceSessionError && err.code === "MANIFEST_HASH_MISMATCH",
    );

    // Approval with valid hash succeeds
    const approved = await service.approveManifest(ownerId, session.session_uuid, validHash);
    assert.equal(approved.state, "approved");
    assert.ok(approved.approvedAt);

    // Further attempts to retry or approve an approved session must fail
    await assert.rejects(
      async () => {
        await service.startOrRetryAttempt(ownerId, session.session_uuid, "idem_husky_retry");
      },
      (err) => err instanceof ReferenceSessionError && err.code === "SESSION_APPROVED",
    );

    const repeatedApproval = await service.approveManifest(ownerId, session.session_uuid, validHash);
    assert.equal(repeatedApproval.state, "approved");
  });

  await t.test("5. Retry attempt creates attempt #2 and preserves history", async () => {
    const ownerId = "+15551113333";
    const session = await service.createSession(ownerId, { inputMode: "text", prompt: "A corgi" });
    await service.startOrRetryAttempt(ownerId, session.session_uuid, "att1");

    const { attempt: att2 } = await service.startOrRetryAttempt(
      ownerId,
      session.session_uuid,
      "att2",
      "Adjust ear proportion",
    );

    assert.equal(att2.attempt_number, 2);
    assert.equal(att2.retry_notes, "Adjust ear proportion");
  });
});
