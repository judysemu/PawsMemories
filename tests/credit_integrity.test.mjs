import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import express from "express";
import mysql from "mysql2/promise";
import request from "supertest";

import * as db from "../db.js";
import { runMigrations } from "../server/migrations/runner.ts";

const creditPurchases = await import("../server/creditPurchases.js").catch(() => ({}));

const INVALID_CREDIT_AMOUNTS = [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  2_147_483_648,
  Number.MAX_SAFE_INTEGER + 1,
];

function noSqlPool() {
  let queryCount = 0;
  return {
    get queryCount() {
      return queryCount;
    },
    async query() {
      queryCount += 1;
      throw new Error("invalid amounts must be rejected before SQL");
    },
    async end() {},
  };
}

class TransactionalCreditPool {
  constructor({ phone = "owner-1", balance = 25, failLedger = false } = {}) {
    this.users = new Map([[phone, balance]]);
    this.ledger = new Map();
    this.failLedger = failLedger;
    this.rollbackCount = 0;
    this.connectionCount = 0;
    this.walletUpdateCount = 0;
    this.ledgerInsertCount = 0;
    this.lockTail = Promise.resolve();
  }

  async acquireLock() {
    const previous = this.lockTail;
    let release;
    this.lockTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  async getConnection() {
    const pool = this;
    pool.connectionCount += 1;
    let releaseLock;
    let snapshot;

    return {
      async beginTransaction() {
        releaseLock = await pool.acquireLock();
        snapshot = {
          users: new Map(pool.users),
          ledger: new Map([...pool.ledger].map(([key, value]) => [key, { ...value }])),
        };
      },
      async query(sql, params = []) {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized.startsWith("SELECT credits FROM users")) {
          const balance = pool.users.get(params[0]);
          return [balance === undefined ? [] : [{ credits: balance }]];
        }
        if (normalized.includes("FROM credit_transactions") && normalized.includes("idempotency_key = ?")) {
          const row = pool.ledger.get(params[0]);
          return [row ? [{ ...row }] : []];
        }
        if (normalized.startsWith("UPDATE users SET credits = ?")) {
          pool.walletUpdateCount += 1;
          const [balance, phone] = params;
          if (!pool.users.has(phone)) return [{ affectedRows: 0 }];
          pool.users.set(phone, balance);
          return [{ affectedRows: 1 }];
        }
        if (normalized.startsWith("INSERT INTO credit_transactions")) {
          pool.ledgerInsertCount += 1;
          if (pool.failLedger) throw new Error("ledger unavailable");
          const [userPhone, delta, reason, balanceAfter, idempotencyKey] = params;
          if (pool.ledger.has(idempotencyKey)) {
            const error = new Error("duplicate idempotency key");
            error.code = "ER_DUP_ENTRY";
            throw error;
          }
          pool.ledger.set(idempotencyKey, {
            user_phone: userPhone,
            delta,
            reason,
            balance_after: balanceAfter,
            idempotency_key: idempotencyKey,
          });
          return [{ affectedRows: 1, insertId: pool.ledger.size }];
        }
        throw new Error(`Unexpected SQL: ${normalized}`);
      },
      async commit() {
        snapshot = undefined;
        releaseLock?.();
        releaseLock = undefined;
      },
      async rollback() {
        pool.rollbackCount += 1;
        if (snapshot) {
          pool.users = snapshot.users;
          pool.ledger = snapshot.ledger;
        }
        snapshot = undefined;
        releaseLock?.();
        releaseLock = undefined;
      },
      release() {
        releaseLock?.();
        releaseLock = undefined;
      },
    };
  }

  async query(sql, params = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.includes("FROM credit_transactions") && normalized.includes("idempotency_key = ?")) {
      const row = this.ledger.get(params[0]);
      return [row ? [{ ...row }] : []];
    }
    throw new Error(`Unexpected pool SQL: ${normalized}`);
  }

  async end() {}
}

test("deductCredits rejects every non-positive or non-safe-integer amount before SQL", async () => {
  const pool = noSqlPool();
  db.setPool(pool);

  for (const amount of INVALID_CREDIT_AMOUNTS) {
    assert.equal(await db.deductCredits("owner-1", amount, "test"), false, `amount ${String(amount)}`);
  }

  assert.equal(pool.queryCount, 0);
  await db.closePool();
});

test("addCredits rejects every non-positive or non-safe-integer amount before SQL", async () => {
  const pool = noSqlPool();
  db.setPool(pool);

  for (const amount of INVALID_CREDIT_AMOUNTS) {
    await assert.rejects(
      db.addCredits("owner-1", amount, "test"),
      /positive safe integer/i,
      `amount ${String(amount)}`,
    );
  }

  assert.equal(pool.queryCount, 0);
  await db.closePool();
});

test("addCredits reaches but never exceeds the signed MySQL INT wallet maximum", async () => {
  const maximum = 2_147_483_647;
  const exactMaximum = new TransactionalCreditPool({ balance: maximum - 100 });
  db.setPool(exactMaximum);
  await db.addCredits("owner-1", 100, "boundary", "credit:boundary:exact");
  assert.equal(exactMaximum.users.get("owner-1"), maximum);
  assert.equal(exactMaximum.walletUpdateCount, 1);
  assert.equal(exactMaximum.ledger.size, 1);
  await db.closePool();

  const overflow = new TransactionalCreditPool({ balance: maximum - 99 });
  db.setPool(overflow);
  await assert.rejects(
    db.addCredits("owner-1", 100, "boundary", "credit:boundary:overflow"),
    /maximum|range/i,
  );
  assert.equal(overflow.users.get("owner-1"), maximum - 99);
  assert.equal(overflow.walletUpdateCount, 0);
  assert.equal(overflow.ledger.size, 0);
  await db.closePool();
});

test("deductCredits updates the wallet and ledger atomically", async (t) => {
  const pool = new TransactionalCreditPool({ balance: 25 });
  db.setPool(pool);
  t.after(async () => db.closePool());

  assert.equal(await db.deductCredits("owner-1", 7, "test_spend"), true);
  assert.equal(pool.users.get("owner-1"), 18);
  assert.equal(pool.ledger.size, 1);
  const [ledgerRow] = [...pool.ledger.values()];
  assert.deepEqual(
    {
      user_phone: ledgerRow.user_phone,
      delta: ledgerRow.delta,
      reason: ledgerRow.reason,
      balance_after: ledgerRow.balance_after,
    },
    {
      user_phone: "owner-1",
      delta: -7,
      reason: "test_spend",
      balance_after: 18,
    },
  );
});

test("deductCredits rolls the wallet back when the ledger insert fails", async (t) => {
  const pool = new TransactionalCreditPool({ balance: 25, failLedger: true });
  db.setPool(pool);
  t.after(async () => db.closePool());

  await assert.rejects(db.deductCredits("owner-1", 7, "test_spend"), /ledger unavailable/);
  assert.equal(pool.users.get("owner-1"), 25);
  assert.equal(pool.ledger.size, 0);
  assert.equal(pool.rollbackCount, 1);
});

test("a debit correlation refunds its original owner and amount exactly once", async (t) => {
  const pool = new TransactionalCreditPool({ balance: 25 });
  db.setPool(pool);
  t.after(async () => db.closePool());

  const debitCorrelationId = await db.reserveCredits(
    "owner-1",
    7,
    "test_spend",
    "debit:test:refund-once",
  );
  assert.equal(debitCorrelationId, "debit:test:refund-once");
  assert.equal(pool.users.get("owner-1"), 18);

  const outcomes = await Promise.all([
    db.refundReservedCredits(debitCorrelationId),
    db.refundReservedCredits(debitCorrelationId),
  ]);
  assert.deepEqual(outcomes.sort(), [false, true]);
  assert.equal(pool.users.get("owner-1"), 25);
  assert.equal(pool.ledger.size, 2);
  const refundRows = [...pool.ledger.values()].filter((row) => row.delta > 0);
  assert.equal(refundRows.length, 1);
  assert.deepEqual(
    {
      user_phone: refundRows[0].user_phone,
      delta: refundRows[0].delta,
      reason: refundRows[0].reason,
      balance_after: refundRows[0].balance_after,
    },
    {
      user_phone: "owner-1",
      delta: 7,
      reason: "refund:test_spend",
      balance_after: 25,
    },
  );
});

test("refundReservedCredits rejects missing and non-debit evidence", async (t) => {
  const pool = new TransactionalCreditPool({ balance: 25 });
  pool.ledger.set("credit:not-a-debit", {
    user_phone: "owner-1",
    delta: 5,
    reason: "reward",
    balance_after: 25,
    idempotency_key: "credit:not-a-debit",
  });
  db.setPool(pool);
  t.after(async () => db.closePool());

  await assert.rejects(db.refundReservedCredits("debit:missing"), /evidence was not found/i);
  await assert.rejects(db.refundReservedCredits("credit:not-a-debit"), /not a debit/i);
  assert.equal(pool.users.get("owner-1"), 25);
  assert.equal(pool.ledger.size, 1);
});

test("concurrent purchased-credit grants apply one wallet mutation and one session ledger row", async (t) => {
  assert.equal(typeof db.grantPurchasedCredits, "function", "the atomic purchased-credit primitive must exist");
  const pool = new TransactionalCreditPool();
  db.setPool(pool);
  t.after(async () => db.closePool());

  const results = await Promise.all([
    db.grantPurchasedCredits("owner-1", 100, "cs_paid_1"),
    db.grantPurchasedCredits("owner-1", 100, "cs_paid_1"),
  ]);

  assert.deepEqual(results.map((result) => result.applied).sort(), [false, true]);
  assert.equal(pool.users.get("owner-1"), 125);
  assert.equal(pool.ledger.size, 1);
  assert.deepEqual(pool.ledger.get("cs_paid_1"), {
    user_phone: "owner-1",
    delta: 100,
    reason: "credit_purchase",
    balance_after: 125,
    idempotency_key: "cs_paid_1",
  });
});

test("purchased-credit ledger failure rolls back the wallet and ledger together", async (t) => {
  assert.equal(typeof db.grantPurchasedCredits, "function", "the atomic purchased-credit primitive must exist");
  const pool = new TransactionalCreditPool({ failLedger: true });
  db.setPool(pool);
  t.after(async () => db.closePool());

  await assert.rejects(
    db.grantPurchasedCredits("owner-1", 100, "cs_failed_1"),
    /ledger unavailable/,
  );

  assert.equal(pool.users.get("owner-1"), 25);
  assert.equal(pool.ledger.size, 0);
  assert.equal(pool.rollbackCount, 1);
});

test("purchased-credit grants enforce the signed MySQL INT wallet boundary exactly", async () => {
  const maximum = 2_147_483_647;
  assert.equal(db.MAX_CREDIT_BALANCE, maximum);

  const duplicateAtMaximum = new TransactionalCreditPool({ balance: maximum });
  duplicateAtMaximum.ledger.set("cs_existing_max", {
    user_phone: "owner-1",
    delta: 100,
    reason: "credit_purchase",
    balance_after: maximum,
    idempotency_key: "cs_existing_max",
  });
  db.setPool(duplicateAtMaximum);
  const duplicate = await db.grantPurchasedCredits("owner-1", 100, "cs_existing_max");
  assert.deepEqual(duplicate, { applied: false, balance: maximum });
  assert.equal(duplicateAtMaximum.walletUpdateCount, 0);
  assert.equal(duplicateAtMaximum.ledgerInsertCount, 0);
  await db.closePool();

  const exactMaximum = new TransactionalCreditPool({ balance: maximum - 100 });
  db.setPool(exactMaximum);
  const applied = await db.grantPurchasedCredits("owner-1", 100, "cs_exact_max");
  assert.deepEqual(applied, { applied: true, balance: maximum });
  assert.equal(exactMaximum.users.get("owner-1"), maximum);
  await db.closePool();

  const onePastMaximum = new TransactionalCreditPool({ balance: maximum - 99 });
  db.setPool(onePastMaximum);
  await assert.rejects(
    db.grantPurchasedCredits("owner-1", 100, "cs_overflow"),
    /maximum|range/i,
  );
  assert.equal(onePastMaximum.users.get("owner-1"), maximum - 99);
  assert.equal(onePastMaximum.walletUpdateCount, 0);
  assert.equal(onePastMaximum.ledgerInsertCount, 0);
  await db.closePool();

  const invalidCurrent = new TransactionalCreditPool({ balance: maximum + 1 });
  db.setPool(invalidCurrent);
  await assert.rejects(
    db.grantPurchasedCredits("owner-1", 1, "cs_invalid_current"),
    /wallet balance/i,
  );
  assert.equal(invalidCurrent.walletUpdateCount, 0);
  assert.equal(invalidCurrent.ledgerInsertCount, 0);
  await db.closePool();

  const invalidInput = new TransactionalCreditPool();
  db.setPool(invalidInput);
  await assert.rejects(
    db.grantPurchasedCredits("owner-1", maximum + 1, "cs_invalid_input"),
    /maximum|range/i,
  );
  assert.equal(invalidInput.connectionCount, 0);
  await db.closePool();
});

test("the legacy credit initializer declares the managed idempotency column and unique index", async () => {
  const dbSource = await readFile(new URL("../db.ts", import.meta.url), "utf8");
  const ddlStart = dbSource.indexOf("// Credit ledger: one row per credit change");
  const ddlEnd = dbSource.indexOf("await retireLegacyPawprintTokens", ddlStart);
  assert.notEqual(ddlStart, -1);
  assert.notEqual(ddlEnd, -1);
  const initializer = dbSource.slice(ddlStart, ddlEnd);

  assert.match(initializer, /idempotency_key\s+VARCHAR\(190\) NULL/);
  assert.match(initializer, /UNIQUE KEY uniq_credit_transaction_idempotency \(idempotency_key\)/);
  assert.match(dbSource, /await runMigrations\(getPool\(\)\)/);
});

function requirePurchaseExport(name) {
  assert.equal(typeof creditPurchases[name], "function", `${name} must be exported`);
  return creditPurchases[name];
}

function paidCreditSession(overrides = {}) {
  const { metadata: metadataOverrides = {}, ...sessionOverrides } = overrides;
  const baseMetadata = {
    type: "credit_purchase",
    userPhone: "owner-1",
    packId: "pack_100",
    creditsToAdd: "999999",
  };
  return {
    id: "cs_paid_pack_100",
    payment_status: "paid",
    mode: "payment",
    currency: "usd",
    amount_total: 1000,
    metadata: { ...baseMetadata, ...metadataOverrides },
    ...sessionOverrides,
  };
}

test("paid-session fulfillment derives credits from the server pack and ignores creditsToAdd metadata", async () => {
  const fulfillCreditPurchaseSession = requirePurchaseExport("fulfillCreditPurchaseSession");
  let wallet = 0;

  const result = await fulfillCreditPurchaseSession(
    paidCreditSession(),
    "owner-1",
    async (owner, amount, sessionId) => {
      assert.equal(owner, "owner-1");
      assert.equal(sessionId, "cs_paid_pack_100");
      wallet += amount;
      return { applied: true, balance: wallet };
    },
  );

  assert.equal(wallet, 100);
  assert.deepEqual(result, {
    applied: true,
    balance: 100,
    credits: 100,
    packId: "pack_100",
  });
});

test("paid-session fulfillment rejects wrong owner, pack, amount, currency, status, and coming-soon packs", async () => {
  const fulfillCreditPurchaseSession = requirePurchaseExport("fulfillCreditPurchaseSession");
  const cases = [
    ["owner", paidCreditSession(), "owner-2", /owner/i],
    ["pack", paidCreditSession({ metadata: { packId: "missing" } }), "owner-1", /pack/i],
    ["amount", paidCreditSession({ amount_total: 999 }), "owner-1", /amount/i],
    ["currency", paidCreditSession({ currency: "eur" }), "owner-1", /USD/i],
    ["payment", paidCreditSession({ payment_status: "unpaid" }), "owner-1", /paid/i],
    [
      "coming soon",
      paidCreditSession({
        amount_total: 2000,
        metadata: { packId: "bundle_marketplace_200" },
      }),
      "owner-1",
      /unavailable/i,
    ],
  ];

  for (const [label, session, expectedOwner, errorPattern] of cases) {
    let wallet = 0;
    await assert.rejects(
      fulfillCreditPurchaseSession(session, expectedOwner, async (_owner, amount) => {
        wallet += amount;
        return { applied: true, balance: wallet };
      }),
      errorPattern,
      label,
    );
    assert.equal(wallet, 0, `${label} must not grant credits`);
  }
});

test("production missing Stripe returns 503 and grants nothing instead of simulating a purchase", async (t) => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });
  const createCreditsSessionHandler = requirePurchaseExport("createCreditsSessionHandler");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { phone: "owner-1" };
    next();
  });
  app.post(
    "/api/create-credits-session",
    createCreditsSessionHandler({ stripe: null, appUrl: "https://app.example.test" }),
  );

  const response = await request(app)
    .post("/api/create-credits-session")
    .send({ packId: "pack_100" })
    .expect(503);

  assert.deepEqual(response.body, {
    success: false,
    error: "Credit purchases are temporarily unavailable.",
  });
});

test("live credit checkout preserves the hosted Stripe redirect response", async () => {
  const createCreditsSessionHandler = requirePurchaseExport("createCreditsSessionHandler");
  let checkoutInput;
  const stripe = {
    checkout: {
      sessions: {
        async create(input) {
          checkoutInput = input;
          return { url: "https://checkout.stripe.test/session" };
        },
      },
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { phone: "owner-1" };
    next();
  });
  app.post(
    "/api/create-credits-session",
    createCreditsSessionHandler({ stripe, appUrl: "https://app.example.test" }),
  );

  const response = await request(app)
    .post("/api/create-credits-session")
    .send({ packId: "pack_100" })
    .expect(200);

  assert.deepEqual(response.body, {
    success: true,
    url: "https://checkout.stripe.test/session",
    mode: "live_stripe",
  });
  assert.equal(checkoutInput.line_items[0].price_data.currency, "usd");
  assert.equal(checkoutInput.line_items[0].price_data.unit_amount, 1000);
  assert.deepEqual(checkoutInput.metadata, {
    type: "credit_purchase",
    userPhone: "owner-1",
    packId: "pack_100",
    creditsToAdd: "100",
  });
});

test("the retired album checkout always returns stable 410 JSON", async () => {
  const retiredAlbumCheckoutHandler = requirePurchaseExport("retiredAlbumCheckoutHandler");
  const app = express();
  app.use(express.json());
  app.post("/api/create-checkout-session", retiredAlbumCheckoutHandler);

  const response = await request(app)
    .post("/api/create-checkout-session")
    .send({ creditsDeducted: -5000, cashPaid: -1 })
    .expect(410);

  assert.deepEqual(response.body, {
    success: false,
    error: "Photo album checkout is no longer available.",
  });
});

test("album and unknown Stripe metadata are explicitly ignored as unsupported", () => {
  const ignoreUnsupportedCheckoutSession = requirePurchaseExport("ignoreUnsupportedCheckoutSession");
  const messages = [];

  assert.equal(
    ignoreUnsupportedCheckoutSession(
      { id: "cs_album", metadata: { type: "album_order", creditsDeducted: "-5000" } },
      (message) => messages.push(message),
    ),
    "retired_album",
  );
  assert.equal(
    ignoreUnsupportedCheckoutSession(
      { id: "cs_unknown", metadata: { type: "something_new" } },
      (message) => messages.push(message),
    ),
    "unknown",
  );
  assert.equal(messages.length, 2);
});

test("webhook and redirect wiring use atomic fulfillment and contain no legacy album mutation", async () => {
  const serverSource = await readFile(new URL("../server.ts", import.meta.url), "utf8");
  const webhookStart = serverSource.indexOf("const handleSuccessfulPayment");
  const webhookEnd = serverSource.indexOf("if (event.type ===", webhookStart);
  assert.notEqual(webhookStart, -1);
  assert.notEqual(webhookEnd, -1);
  const webhook = serverSource.slice(webhookStart, webhookEnd);

  assert.match(webhook, /fulfillCreditPurchaseSession/);
  assert.match(webhook, /ignoreUnsupportedCheckoutSession/);
  assert.doesNotMatch(webhook, /deductCredits\(/);
  assert.doesNotMatch(webhook, /saveOrder\(/);

  const confirmStart = serverSource.indexOf('app.get("/api/credits/confirm"');
  const confirmEnd = serverSource.indexOf("// Credit transaction history", confirmStart);
  const confirmRoute = serverSource.slice(confirmStart, confirmEnd);
  assert.match(confirmRoute, /fulfillCreditPurchaseSession/);
  assert.doesNotMatch(confirmRoute, /wasSessionCredited|addCredits\(/);
});

test("route code cannot restore credits from caller-supplied owner and amount values", async () => {
  const [dbSource, serverSource, animatorSource] = await Promise.all([
    readFile(new URL("../db.ts", import.meta.url), "utf8"),
    readFile(new URL("../server.ts", import.meta.url), "utf8"),
    readFile(new URL("../server/animator/routes.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(dbSource, /export async function restoreReservedGenerationCredits/);
  assert.doesNotMatch(dbSource, /export async function refundCredits\(phone:\s*string,\s*amount:/);
  assert.doesNotMatch(serverSource, /restoreReservedGenerationCredits|deductCredits\(/);
  assert.doesNotMatch(animatorSource, /restoreReservedGenerationCredits|deductCredits\(/);
  assert.match(serverSource, /refundReservedCredits\(creditReservationId\)/);
  assert.match(serverSource, /failGenerationJobAndRefundOnce/);
});

test("fresh and upgraded real-MySQL schemas converge and concurrent session grants apply once", async (t) => {
  const mysqlConfig = {
    host: process.env.MYSQL_TEST_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER || "root",
    password: process.env.MYSQL_TEST_PASSWORD || "",
  };
  assert.ok(
    ["127.0.0.1", "localhost", "::1"].includes(mysqlConfig.host),
    "credit integration tests may only use a local disposable MySQL service",
  );

  let availabilityProbe;
  try {
    availabilityProbe = await mysql.createConnection(mysqlConfig);
    await availabilityProbe.end();
  } catch {
    t.skip("Local disposable MySQL service is unavailable.");
    return;
  }

  const testDatabase = `paws_credit_integrity_${process.pid}`;
  const quotedDatabase = `\`${testDatabase}\``;
  const previousDbEnv = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_NAME: process.env.DB_NAME,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
  };
  let upgradedPool;
  let freshPool;

  const resetDatabase = async () => {
    const admin = await mysql.createConnection(mysqlConfig);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase}`);
      await admin.query(`CREATE DATABASE ${quotedDatabase}`);
    } finally {
      await admin.end();
    }
  };
  const creditSchema = async (pool) => {
    const [columns] = await pool.query(
      `SELECT COLUMN_TYPE, IS_NULLABLE
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'credit_transactions'
          AND COLUMN_NAME = 'idempotency_key'`,
    );
    const [indexes] = await pool.query(
      `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'credit_transactions'
          AND INDEX_NAME = 'uniq_credit_transaction_idempotency'`,
    );
    return { columns, indexes };
  };

  try {
    await resetDatabase();
    upgradedPool = mysql.createPool({ ...mysqlConfig, database: testDatabase, connectionLimit: 4 });
    await upgradedPool.query(`CREATE TABLE users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(32) NOT NULL UNIQUE,
      email VARCHAR(190) NULL,
      password_hash VARCHAR(255) NULL,
      full_name VARCHAR(120) NULL,
      credits INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await upgradedPool.query(`CREATE TABLE credit_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_phone VARCHAR(32) NOT NULL,
      delta INT NOT NULL,
      reason VARCHAR(80) NOT NULL,
      balance_after INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX (user_phone),
      INDEX (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await runMigrations(upgradedPool);
    const upgradedSchema = await creditSchema(upgradedPool);
    assert.deepEqual(upgradedSchema.columns, [{ COLUMN_TYPE: "varchar(190)", IS_NULLABLE: "YES" }]);
    assert.deepEqual(upgradedSchema.indexes, [{
      INDEX_NAME: "uniq_credit_transaction_idempotency",
      NON_UNIQUE: 0,
      COLUMN_NAME: "idempotency_key",
    }]);
    await upgradedPool.end();
    upgradedPool = undefined;

    await resetDatabase();
    freshPool = mysql.createPool({ ...mysqlConfig, database: testDatabase, connectionLimit: 4 });
    process.env.DB_HOST = mysqlConfig.host;
    process.env.DB_PORT = String(mysqlConfig.port);
    process.env.DB_NAME = testDatabase;
    process.env.DB_USER = mysqlConfig.user;
    process.env.DB_PASSWORD = mysqlConfig.password;
    db.setPool(freshPool);
    await db.initDb();

    const freshSchema = await creditSchema(freshPool);
    assert.deepEqual(freshSchema, upgradedSchema);

    await freshPool.query(
      "INSERT INTO users (phone, credits) VALUES (?, ?)",
      ["credit-owner", 25],
    );
    const results = await Promise.all([
      db.grantPurchasedCredits("credit-owner", 100, "cs_mysql_concurrent"),
      db.grantPurchasedCredits("credit-owner", 100, "cs_mysql_concurrent"),
    ]);
    assert.deepEqual(results.map((result) => result.applied).sort(), [false, true]);

    const [[wallet]] = await freshPool.query(
      "SELECT credits FROM users WHERE phone = ?",
      ["credit-owner"],
    );
    const [ledger] = await freshPool.query(
      `SELECT user_phone, delta, idempotency_key
         FROM credit_transactions
        WHERE idempotency_key = ?`,
      ["cs_mysql_concurrent"],
    );
    assert.equal(wallet.credits, 125);
    assert.deepEqual(ledger, [{
      user_phone: "credit-owner",
      delta: 100,
      idempotency_key: "cs_mysql_concurrent",
    }]);
  } finally {
    if (upgradedPool) await upgradedPool.end().catch(() => undefined);
    if (freshPool) {
      await db.closePool().catch(() => undefined);
      freshPool = undefined;
    }
    for (const [name, value] of Object.entries(previousDbEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const admin = await mysql.createConnection(mysqlConfig);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase}`);
    } finally {
      await admin.end();
    }
  }
});
