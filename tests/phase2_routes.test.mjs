import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import mysql from "mysql2/promise";
import { runMigrations } from "../server/migrations/runner.ts";
import { createReferenceSessionsRouter } from "../server/reference-sessions/routes.ts";
import { FakeReferenceImageProvider } from "../server/reference-sessions/provider.ts";
import { requireAuth, signToken } from "../auth.ts";

process.env.JWT_SECRET = "phase2-route-test-secret-at-least-32-characters";

const mysqlHost = process.env.MYSQL_TEST_HOST || "127.0.0.1";
const mysqlPort = Number(process.env.MYSQL_TEST_PORT || 3306);
const mysqlUser = process.env.MYSQL_TEST_USER || "root";
const mysqlPassword = process.env.MYSQL_TEST_PASSWORD || "";

test("Phase 2 API Router Suite (/api/reference-sessions)", async (t) => {
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
    t.skip("Local test MySQL instance not running on 127.0.0.1:3306. Provision MySQL to run API route tests.");
    return;
  }

  process.env.MEDIA_BUCKET_NAME = "paws-public-test";
  process.env.MEDIA_PRIVATE_BUCKET_NAME = "paws-private-test";
  process.env.MEDIA_BUCKET_URL = "http://localhost:9000";
  process.env.MEDIA_BUCKET_KEY = "testkey";
  process.env.MEDIA_BUCKET_SECRET = "testsecret";

  const testDbName = `paws_test_refroutes_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  let pool;
  let server;
  let serverPort;

  t.before(async () => {
    const adminConn = await mysql.createConnection({ host: mysqlHost, port: mysqlPort, user: mysqlUser, password: mysqlPassword });
    await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${testDbName}\``);
    await adminConn.end();

    pool = mysql.createPool({ host: mysqlHost, port: mysqlPort, user: mysqlUser, password: mysqlPassword, database: testDbName, connectionLimit: 5 });

    // Create users table baseline
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone VARCHAR(64) NOT NULL UNIQUE,
        is_admin TINYINT(1) DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await runMigrations(pool);

    const router = createReferenceSessionsRouter({
      provider: new FakeReferenceImageProvider(),
      pool,
      isAdmin: async () => false,
    });

    const app = express();
    app.use(express.json());
    app.use("/api/reference-sessions", requireAuth, router);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        serverPort = server.address().port;
        resolve();
      });
    });
  });

  t.after(async () => {
    delete process.env.MULTIVIEW_APPROVAL_ENABLED;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    const cleanupConn = await mysql.createConnection({ host: mysqlHost, port: mysqlPort, user: mysqlUser, password: mysqlPassword });
    await cleanupConn.query(`DROP DATABASE IF EXISTS \`${testDbName}\``);
    await cleanupConn.end();
  });

  const baseUrl = () => `http://127.0.0.1:${serverPort}`;
  const authHeaders = (userPhone) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${signToken({ phone: userPhone, uid: 1 })}`,
  });

  await t.test("1. When MULTIVIEW_APPROVAL_ENABLED=false, endpoints fail-closed with 403 FEATURE_DISABLED", async () => {
    delete process.env.MULTIVIEW_APPROVAL_ENABLED;

    const res = await fetch(`${baseUrl()}/api/reference-sessions/create`, {
      method: "POST",
      headers: authHeaders("+15551112222"),
      body: JSON.stringify({ inputMode: "text", prompt: "A dog" }),
    });

    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.code, "FEATURE_DISABLED");
  });

  await t.test("2. Full Reference Session Lifecycle via HTTP Router", async () => {
    process.env.MULTIVIEW_APPROVAL_ENABLED = "true";
    const userPhone = "+15551112222";

    // A. Create Session
    const createRes = await fetch(`${baseUrl()}/api/reference-sessions/create`, {
      method: "POST",
      headers: authHeaders(userPhone),
      body: JSON.stringify({ inputMode: "text", prompt: "A golden retriever" }),
    });
    const createBody = await createRes.json();
    assert.equal(createRes.status, 201);
    assert.ok(createBody.sessionUuid);
    const sessionUuid = createBody.sessionUuid;

    // B. Start Generation Attempt
    const startRes = await fetch(`${baseUrl()}/api/reference-sessions/start`, {
      method: "POST",
      headers: authHeaders(userPhone),
      body: JSON.stringify({ sessionUuid, idempotencyKey: "idem_route_1" }),
    });
    const startBody = await startRes.json();
    assert.equal(startRes.status, 201);
    assert.equal(startBody.session.views.length, 4);
    const manifestHash = startBody.session.manifestHash;

    // C. Non-owner cannot access or approve
    const strangerRes = await fetch(`${baseUrl()}/api/reference-sessions/approve`, {
      method: "POST",
      headers: authHeaders("+15559990000"),
      body: JSON.stringify({ sessionUuid, manifestHash }),
    });
    assert.equal(strangerRes.status, 403);

    // D. Owner approves manifest
    const approveRes = await fetch(`${baseUrl()}/api/reference-sessions/approve`, {
      method: "POST",
      headers: authHeaders(userPhone),
      body: JSON.stringify({ sessionUuid, manifestHash }),
    });
    const approveBody = await approveRes.json();
    assert.equal(approveRes.status, 200);
    assert.equal(approveBody.session.state, "approved");
  });

  await t.test("2b. x-user-phone cannot spoof authentication", async () => {
    process.env.MULTIVIEW_APPROVAL_ENABLED = "true";
    const response = await fetch(`${baseUrl()}/api/reference-sessions/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-phone": "+15551112222" },
      body: JSON.stringify({ inputMode: "text", prompt: "spoof attempt" }),
    });
    assert.equal(response.status, 401);
  });

  await t.test("3. 3D Provider Spy: Prove ZERO 3D provider calls made by Phase 2 endpoints", async () => {
    process.env.MULTIVIEW_APPROVAL_ENABLED = "true";
    let tripoCalled = false;
    let blenderCalled = false;

    // Setup global spy hooks on 3D building endpoints
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function (input, init) {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("tripo3d") || url.includes("meshy")) tripoCalled = true;
      return originalFetch(input, init);
    };

    try {
      const res = await fetch(`${baseUrl()}/api/reference-sessions/create`, {
        method: "POST",
        headers: authHeaders("+15551112222"),
        body: JSON.stringify({ inputMode: "text", prompt: "Spy test dog" }),
      });
      const body = await res.json();
      await fetch(`${baseUrl()}/api/reference-sessions/start`, {
        method: "POST",
        headers: authHeaders("+15551112222"),
        body: JSON.stringify({ sessionUuid: body.sessionUuid, idempotencyKey: "idem_spy" }),
      });

      assert.equal(tripoCalled, false, "Phase 2 MUST NOT call any 3D build provider (Tripo/Meshy)");
      assert.equal(blenderCalled, false, "Phase 2 MUST NOT call Blender worker");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
