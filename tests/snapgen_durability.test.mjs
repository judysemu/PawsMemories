import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import test from "node:test";

import { runMigrations } from "../server/migrations/runner.ts";
import {
  SnapgenPurchaseError,
  assertSnapgenProductionConfiguration,
  claimSnapgenPoll,
  claimSnapgenSubmission,
  persistSnapgenProviderHandle,
  reserveSnapgenOrder,
  snapgenSha256,
} from "../server/snapgenStore.ts";
import { initializeLegacyUsersTable } from "./helpers/mysqlTestDatabase.mjs";

const MYSQL_CONFIG = {
  host: process.env.MYSQL_TEST_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_TEST_PORT || 3306),
  user: process.env.MYSQL_TEST_USER || "root",
  password: process.env.MYSQL_TEST_PASSWORD || "",
};
const TEST_DB = "paws_snapgen_durability_test_db";

function purchaseRow(token, overrides = {}) {
  return {
    owner: "snap-owner",
    product: "snapgen_model_basic",
    price: 299,
    currency: "USD",
    ...overrides,
    token,
  };
}

async function insertPurchase(pool, input) {
  await pool.query(
    `INSERT INTO sg_purchases
      (user_key, platform, product_id, purchase_token, purchase_token_sha256, price_cents, currency)
     VALUES (?, 'play', ?, ?, ?, ?, ?)`,
    [input.owner, input.product, input.token, snapgenSha256(input.token), input.price, input.currency],
  );
}

test("Snapgen token and order state is atomic and replay-safe on real MySQL", async (t) => {
  let pool;
  try {
    const admin = await mysql.createConnection(MYSQL_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    pool = mysql.createPool({ ...MYSQL_CONFIG, database: TEST_DB, connectionLimit: 12 });
    await initializeLegacyUsersTable(pool);
    await pool.query(`CREATE TABLE sg_tiers (
      code VARCHAR(24) PRIMARY KEY, name VARCHAR(64) NOT NULL, price_cents INT NOT NULL,
      face_limit INT NOT NULL DEFAULT 10000, pbr TINYINT(1) NOT NULL DEFAULT 0,
      rig TINYINT(1) NOT NULL DEFAULT 0, texture_res VARCHAR(8) NOT NULL DEFAULT '1K',
      sort_order INT NOT NULL DEFAULT 0, active TINYINT(1) NOT NULL DEFAULT 1
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE sg_categories (
      code VARCHAR(24) PRIMARY KEY, name VARCHAR(64) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0, active TINYINT(1) NOT NULL DEFAULT 1
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE sg_orders (
      id INT AUTO_INCREMENT PRIMARY KEY, user_key VARCHAR(32) NOT NULL,
      tier_code VARCHAR(24) NOT NULL, category_code VARCHAR(24) NOT NULL,
      status ENUM('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
      tripo_op VARCHAR(128) NULL, source_image_url TEXT NULL, options_json JSON NULL,
      purchase_token VARCHAR(512) NULL, price_cents INT NOT NULL,
      is_remake TINYINT(1) NOT NULL DEFAULT 0, original_order_id INT NULL,
      model_url TEXT NULL, progress INT NOT NULL DEFAULT 0, error TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE sg_purchases (
      id INT AUTO_INCREMENT PRIMARY KEY, user_key VARCHAR(32) NOT NULL,
      platform ENUM('play','appstore','dev') NOT NULL DEFAULT 'play',
      product_id VARCHAR(128) NOT NULL, purchase_token VARCHAR(512) NOT NULL,
      price_cents INT NOT NULL DEFAULT 0, consumed TINYINT(1) NOT NULL DEFAULT 0,
      raw_json JSON NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_sg_purchase_token (purchase_token(191))
    ) ENGINE=InnoDB`);
    await pool.query(
      `INSERT INTO sg_orders
        (user_key, tier_code, category_code, status, purchase_token, price_cents)
       VALUES
        ('legacy-owner', 'basic', 'pets', 'pending', 'legacy-duplicate-token', 299),
        ('legacy-owner', 'basic', 'pets', 'pending', 'legacy-duplicate-token', 299)`,
    );
    await runMigrations(pool);
  } catch (error) {
    assert.fail(`Real MySQL Snapgen test must run: ${error instanceof Error ? error.message : error}`);
  }
  t.after(async () => {
    await pool.end();
    const admin = await mysql.createConnection(MYSQL_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  await t.test("legacy duplicate order tokens are quarantined before the unique hash is added", async () => {
    const [rows] = await pool.query(
      `SELECT purchase_token_sha256, status, error_code
         FROM sg_orders WHERE user_key='legacy-owner' ORDER BY id`,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.purchase_token_sha256 === snapgenSha256("legacy-duplicate-token")).length, 1);
    assert.deepEqual(
      [rows[1].purchase_token_sha256, rows[1].status, rows[1].error_code],
      [null, "recovery_required", "DUPLICATE_LEGACY_TOKEN"],
    );
  });

  await t.test("eight concurrent consumers converge on one durable order", async () => {
    const token = "rc-token-concurrent";
    await insertPurchase(pool, purchaseRow(token));
    const input = {
      ownerId: "snap-owner",
      tierCode: "basic",
      categoryCode: "pets",
      purchaseToken: token,
      requestHash: "a".repeat(64),
      optionsJson: "{}",
      isRemake: false,
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => reserveSnapgenOrder(pool, input)));
    assert.equal(results.filter((result) => !result.replay).length, 1);
    assert.equal(new Set(results.map((result) => result.orderId)).size, 1);
    const [[purchase]] = await pool.query("SELECT consumed, consumed_order_id FROM sg_purchases WHERE purchase_token_sha256=?", [snapgenSha256(token)]);
    const [[orders]] = await pool.query("SELECT COUNT(*) AS c FROM sg_orders WHERE purchase_token_sha256=?", [snapgenSha256(token)]);
    assert.equal(Number(purchase.consumed), 1);
    assert.equal(Number(purchase.consumed_order_id), results[0].orderId);
    assert.equal(Number(orders.c), 1);

    await assert.rejects(
      () => reserveSnapgenOrder(pool, { ...input, requestHash: "b".repeat(64) }),
      (error) => error instanceof SnapgenPurchaseError && error.code === "ORDER_REPLAY_MISMATCH",
    );
  });

  await t.test("wrong amount or currency produces no order and no consumed token", async () => {
    for (const [token, overrides] of [
      ["rc-token-price", { price: 1 }],
      ["rc-token-currency", { currency: "CAD" }],
    ]) {
      await insertPurchase(pool, purchaseRow(token, overrides));
      await assert.rejects(
        () => reserveSnapgenOrder(pool, {
          ownerId: "snap-owner",
          tierCode: "basic",
          categoryCode: "pets",
          purchaseToken: token,
          requestHash: snapgenSha256(`request:${token}`),
          optionsJson: "{}",
          isRemake: false,
        }),
        (error) => error instanceof SnapgenPurchaseError && error.code === "PURCHASE_MISMATCH",
      );
      const [[purchase]] = await pool.query("SELECT consumed, consumed_order_id FROM sg_purchases WHERE purchase_token_sha256=?", [snapgenSha256(token)]);
      const [[orders]] = await pool.query("SELECT COUNT(*) AS c FROM sg_orders WHERE purchase_token_sha256=?", [snapgenSha256(token)]);
      assert.deepEqual([Number(purchase.consumed), purchase.consumed_order_id, Number(orders.c)], [0, null, 0]);
    }
  });

  await t.test("order insert failure rolls token consumption back", async () => {
    const token = "rc-token-rollback";
    await insertPurchase(pool, purchaseRow(token));
    await assert.rejects(() => reserveSnapgenOrder(pool, {
      ownerId: "snap-owner",
      tierCode: "basic",
      categoryCode: "pets",
      purchaseToken: token,
      requestHash: "c".repeat(64),
      optionsJson: "{not-json",
      isRemake: false,
    }));
    const [[purchase]] = await pool.query("SELECT consumed, consumed_order_id FROM sg_purchases WHERE purchase_token_sha256=?", [snapgenSha256(token)]);
    const [[orders]] = await pool.query("SELECT COUNT(*) AS c FROM sg_orders WHERE purchase_token_sha256=?", [snapgenSha256(token)]);
    assert.deepEqual([Number(purchase.consumed), purchase.consumed_order_id, Number(orders.c)], [0, null, 0]);
  });

  await t.test("submission and polling are compare-and-set leased", async () => {
    const token = "rc-token-state";
    await insertPurchase(pool, purchaseRow(token));
    const reserved = await reserveSnapgenOrder(pool, {
      ownerId: "snap-owner",
      tierCode: "basic",
      categoryCode: "pets",
      purchaseToken: token,
      requestHash: "d".repeat(64),
      optionsJson: "{}",
      isRemake: false,
    });
    const claims = await Promise.all(Array.from({ length: 8 }, () =>
      claimSnapgenSubmission(pool, reserved.orderId, "snap-owner")));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await persistSnapgenProviderHandle(pool, reserved.orderId, "snap-owner", "tripo:task-1", "https://owned.test/source.png"), true);
    assert.equal(await persistSnapgenProviderHandle(pool, reserved.orderId, "snap-owner", "tripo:task-2", "https://owned.test/source.png"), false);

    const pollClaims = await Promise.all(Array.from({ length: 8 }, () =>
      claimSnapgenPoll(pool, reserved.orderId, "snap-owner")));
    assert.equal(pollClaims.filter((claim) => claim?.claimed).length, 1);
    const [[order]] = await pool.query("SELECT status, tripo_op, poll_lease_owner FROM sg_orders WHERE id=?", [reserved.orderId]);
    assert.equal(order.status, "processing");
    assert.equal(order.tripo_op, "tripo:task-1");
    assert.ok(order.poll_lease_owner);
  });
});

test("Snapgen purchase bypass fails closed in production", () => {
  assert.throws(
    () => assertSnapgenProductionConfiguration({ NODE_ENV: "production", SNAPGEN_SKIP_PURCHASE_VERIFY: "1" }),
    /must not be enabled in production/,
  );
  assert.doesNotThrow(() => assertSnapgenProductionConfiguration({ NODE_ENV: "test", SNAPGEN_SKIP_PURCHASE_VERIFY: "1" }));
});

test("Snapgen route mirrors provider GLB before marking the order complete", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../server/snapgen.ts", import.meta.url), "utf8"));
  const mirrorAt = source.indexOf("uploadBinaryFromUrl(poll.glbUrl");
  const completeAt = source.indexOf("SET status='completed'", mirrorAt);
  assert.ok(mirrorAt > 0 && completeAt > mirrorAt);
  assert.doesNotMatch(source, /model_url\s*=\s*\?[^;]+\[poll\.glbUrl/);
});
