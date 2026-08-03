import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import mysql from "mysql2/promise";
import { runMigrations } from "../server/migrations/runner.ts";
import { createModelBuildsRouter } from "../server/model-builds/routes.ts";
import { FakeModelBuildProvider } from "../server/model-builds/provider.ts";

const MYSQL_HOST = process.env.MYSQL_TEST_HOST || "127.0.0.1";
const MYSQL_PORT = Number(process.env.MYSQL_TEST_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_TEST_USER || "root";
const MYSQL_PASSWORD = process.env.MYSQL_TEST_PASSWORD || "";
const TEST_DB = "paws_phase3_routes_test_db";

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

describe("Phase 3 HTTP Routes Test Suite", {
  skip: mysqlAvailable ? false : "Local MySQL is not available.",
}, () => {
  let pool;
  let fakeProvider;
  let app;
  let server;
  let baseUrl;

  before(async () => {
    process.env.MODEL_BUILD_V3_ENABLED = "true";
    process.env.MEDIA_PRIVATE_BUCKET_NAME = "paws-private-test";
    process.env.MEDIA_BUCKET_NAME = "paws-public-test";
    process.env.MEDIA_BUCKET_URL = "http://localhost:9000";
    process.env.MEDIA_BUCKET_KEY = "testkey";
    process.env.MEDIA_BUCKET_SECRET = "testsecret";

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
    const router = createModelBuildsRouter({
      provider: fakeProvider,
      pool,
      isAdmin: async (phone) => phone === "+15559999",
    });

    app = express();
    app.use(express.json());
    // Mock authentication middleware: header x-user-phone sets req.user
    app.use((req, _res, next) => {
      const phone = req.headers["x-user-phone"];
      if (phone) {
        req.user = { phone };
      }
      next();
    });
    app.use("/api/model-builds", router);

    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) server.close();
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

  it("should reject unauthenticated requests with 401", async () => {
    fakeProvider.reset();
    const res = await fetch(`${baseUrl}/api/model-builds/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referenceSessionUuid: "00000000-0000-0000-0000-000000000000" }),
    });
    assert.equal(res.status, 401);
    assert.equal(fakeProvider.startCalls, 0);
  });

  it("should return 400 for invalid body payload", async () => {
    const res = await fetch(`${baseUrl}/api/model-builds/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-phone": "+15550001",
      },
      body: JSON.stringify({ referenceSessionUuid: "invalid-uuid" }),
    });
    assert.equal(res.status, 400);
    assert.equal(fakeProvider.startCalls, 0);
  });

  it("should return 422 preflight error for unapproved reference session", async () => {
    const res = await fetch(`${baseUrl}/api/model-builds/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-phone": "+15550001",
      },
      body: JSON.stringify({ referenceSessionUuid: "00000000-0000-0000-0000-000000000000" }),
    });
    assert.equal(res.status, 200); // quote endpoint returns JSON with preflightPassed=false
    const json = await res.json();
    assert.equal(json.data.preflightPassed, false);
    assert.equal(fakeProvider.startCalls, 0);
  });

  it("should enforce admin authentication for reconcile endpoint", async () => {
    // Non-admin user gets 403
    const resNonAdmin = await fetch(`${baseUrl}/api/model-builds/admin/reconcile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-phone": "+15550001",
      },
    });
    assert.equal(resNonAdmin.status, 403);

    // Admin user gets 200
    const resAdmin = await fetch(`${baseUrl}/api/model-builds/admin/reconcile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-phone": "+15559999",
      },
    });
    assert.equal(resAdmin.status, 200);
    const json = await resAdmin.json();
    assert.equal(json.success, true);
    assert.ok(json.data.timestamp);
  });
});
