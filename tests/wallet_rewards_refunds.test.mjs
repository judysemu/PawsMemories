import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import test from "node:test";

import { runMigrations } from "../server/migrations/runner.ts";
import { applyWalletClaimOnce } from "../server/wallet.ts";
import {
  RewardClaimError,
  claimAchievementReward,
  claimDailyStreakReward,
} from "../server/rewards.ts";
import { setPool } from "../db.ts";
import {
  approveRefundReview,
  denyRefundReview,
  markRefundForManualReview,
  resolveRefundReview,
} from "../server/refunds.ts";
import { initializeLegacyUsersTable } from "./helpers/mysqlTestDatabase.mjs";

const MYSQL_CONFIG = {
  host: process.env.MYSQL_TEST_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_TEST_PORT || 3306),
  user: process.env.MYSQL_TEST_USER || "root",
  password: process.env.MYSQL_TEST_PASSWORD || "",
};
const TEST_DB = "paws_wallet_rewards_test_db";

test("wallet rewards are atomic, server-owned, and replay-safe on real MySQL", async (t) => {
  let pool;
  try {
    const admin = await mysql.createConnection(MYSQL_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    pool = mysql.createPool({ ...MYSQL_CONFIG, database: TEST_DB, connectionLimit: 8 });
    setPool(pool);
    await initializeLegacyUsersTable(pool);
    await runMigrations(pool);
  } catch (error) {
    assert.fail(`Real MySQL reward test must run: ${error instanceof Error ? error.message : error}`);
  }

  t.after(async () => {
    await pool.end();
    const admin = await mysql.createConnection(MYSQL_CONFIG);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  await pool.query("ALTER TABLE users ADD COLUMN profile_complete TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN daily_streak INT NOT NULL DEFAULT 0, ADD COLUMN last_streak_claim DATE NULL, ADD COLUMN treats INT NOT NULL DEFAULT 0, ADD COLUMN achievements_json TEXT NULL");
  await pool.query("CREATE TABLE creations (id INT AUTO_INCREMENT PRIMARY KEY, user_phone VARCHAR(190) NOT NULL)");
  await pool.query(`CREATE TABLE refund_reviews (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_phone VARCHAR(190) NOT NULL,
    cost_credits INT NOT NULL,
    match_score INT NOT NULL,
    reason_code VARCHAR(32) NULL,
    feedback_text TEXT NULL,
    outcome VARCHAR(32) NOT NULL DEFAULT 'pending',
    recommended_credits INT NOT NULL DEFAULT 0,
    refunded INT NOT NULL DEFAULT 0,
    approved_by VARCHAR(190) NULL,
    resolved_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await pool.query(
    `INSERT INTO users (phone, email, password_hash, full_name, credits, profile_complete) VALUES
      ('owner-a', 'a@test', 'x', 'A', 100, 1),
      ('owner-b', 'b@test', 'x', 'B', 50, 0),
      ('owner-c', 'c@test', 'x', 'C', 10, 0),
      ('owner-d', 'd@test', 'x', 'D', 25, 0)`,
  );
  await pool.query("INSERT INTO creations (user_phone) VALUES ('owner-a')");

  await t.test("concurrent achievement claims grant the allowlisted amount once", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      claimAchievementReward(pool, "owner-a", "creation")));
    assert.equal(results.filter((result) => result.applied).length, 1);
    const [users] = await pool.query("SELECT credits, achievements_json FROM users WHERE phone = 'owner-a'");
    assert.equal(Number(users[0].credits), 120);
    assert.deepEqual(JSON.parse(users[0].achievements_json), ["creation"]);
    const [ledger] = await pool.query("SELECT delta, reason FROM credit_transactions WHERE user_phone = 'owner-a'");
    assert.deepEqual(ledger.map((row) => [Number(row.delta), row.reason]), [[20, "achievement_creation"]]);
  });

  await t.test("unknown and DB-ineligible achievements cannot change the wallet", async () => {
    await assert.rejects(
      () => claimAchievementReward(pool, "owner-b", "made_up"),
      (error) => error instanceof RewardClaimError && error.code === "UNKNOWN_ACHIEVEMENT",
    );
    await assert.rejects(
      () => claimAchievementReward(pool, "owner-b", "pioneer"),
      (error) => error instanceof RewardClaimError && error.code === "NOT_ELIGIBLE",
    );
    const [users] = await pool.query("SELECT credits FROM users WHERE phone = 'owner-b'");
    assert.equal(Number(users[0].credits), 50);
  });

  await t.test("concurrent streak claims atomically update streak, treat, wallet, and ledger once", async () => {
    await pool.query("UPDATE users SET daily_streak = 2, last_streak_claim = '2026-07-30', treats = 0 WHERE phone = 'owner-b'");
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () =>
      claimDailyStreakReward(pool, "owner-b", "2026-07-31")));
    assert.equal(settled.filter((result) => result.status === "fulfilled" && result.value.applied).length, 1);
    const [users] = await pool.query("SELECT credits, daily_streak, last_streak_claim, treats FROM users WHERE phone = 'owner-b'");
    const claimedDate = users[0].last_streak_claim instanceof Date
      ? users[0].last_streak_claim.toISOString().slice(0, 10)
      : String(users[0].last_streak_claim).slice(0, 10);
    assert.deepEqual(
      [Number(users[0].credits), Number(users[0].daily_streak), claimedDate, Number(users[0].treats)],
      [70, 3, "2026-07-31", 1],
    );
    const [ledger] = await pool.query("SELECT COUNT(*) AS c FROM credit_transactions WHERE user_phone = 'owner-b' AND reason = 'daily_bonus_streak_bundle'");
    assert.equal(Number(ledger[0].c), 1);
  });

  await t.test("domain mutation failure rolls back wallet and ledger together", async () => {
    await assert.rejects(() => applyWalletClaimOnce(pool, {
      ownerId: "owner-b",
      correlationId: "test:rollback:owner-b",
      resolve: async () => ({
        delta: 10,
        reason: "test_rollback",
        mutate: async () => { throw new Error("forced domain failure"); },
      }),
    }), /forced domain failure/);
    const [users] = await pool.query("SELECT credits FROM users WHERE phone = 'owner-b'");
    assert.equal(Number(users[0].credits), 70);
    const [ledger] = await pool.query("SELECT COUNT(*) AS c FROM credit_transactions WHERE idempotency_key = 'test:rollback:owner-b'");
    assert.equal(Number(ledger[0].c), 0);
  });

  await t.test("concurrent automatic refund resolutions grant the immutable cost once", async () => {
    const [inserted] = await pool.query(
      "INSERT INTO refund_reviews (user_phone, cost_credits, match_score) VALUES ('owner-c', 40, 20)",
    );
    const results = await Promise.all(Array.from({ length: 8 }, () => resolveRefundReview({
      reviewId: inserted.insertId,
      phone: "owner-c",
      reason: "a_style",
      feedbackText: "style mismatch",
    })));
    assert.equal(results.filter((result) => result?.status === "approved").length, 8);
    const [[user]] = await pool.query("SELECT credits FROM users WHERE phone = 'owner-c'");
    const [[review]] = await pool.query("SELECT outcome, refunded, approved_by FROM refund_reviews WHERE id = ?", [inserted.insertId]);
    const [[ledger]] = await pool.query("SELECT COUNT(*) AS c FROM credit_transactions WHERE idempotency_key = ?", [`refund-review:${inserted.insertId}`]);
    assert.equal(Number(user.credits), 50);
    assert.deepEqual([review.outcome, Number(review.refunded), review.approved_by], ["approved", 40, "auto"]);
    assert.equal(Number(ledger.c), 1);
  });

  await t.test("concurrent admin approvals pay once and a deny race cannot create split state", async () => {
    const [adminReview] = await pool.query(
      "INSERT INTO refund_reviews (user_phone, cost_credits, match_score, reason_code, outcome, recommended_credits) VALUES ('owner-b', 30, 60, 'e_other', 'manual_review', 30)",
    );
    const approvals = await Promise.all(Array.from({ length: 8 }, () =>
      approveRefundReview(adminReview.insertId, "admin-owner")));
    assert.equal(approvals.filter((result) => result === "approved").length, 1);
    const [[adminUser]] = await pool.query("SELECT credits FROM users WHERE phone = 'owner-b'");
    const [[adminLedger]] = await pool.query("SELECT COUNT(*) AS c FROM credit_transactions WHERE idempotency_key = ?", [`refund-review:${adminReview.insertId}`]);
    assert.equal(Number(adminUser.credits), 100);
    assert.equal(Number(adminLedger.c), 1);

    const [raceReview] = await pool.query(
      "INSERT INTO refund_reviews (user_phone, cost_credits, match_score, reason_code, outcome, recommended_credits) VALUES ('owner-d', 25, 40, 'e_other', 'manual_review', 25)",
    );
    await Promise.all([
      approveRefundReview(raceReview.insertId, "admin-approve"),
      denyRefundReview(raceReview.insertId, "admin-deny"),
    ]);
    const [[raceUser]] = await pool.query("SELECT credits FROM users WHERE phone = 'owner-d'");
    const [[raceState]] = await pool.query("SELECT outcome, refunded FROM refund_reviews WHERE id = ?", [raceReview.insertId]);
    const [[raceLedger]] = await pool.query("SELECT COUNT(*) AS c FROM credit_transactions WHERE idempotency_key = ?", [`refund-review:${raceReview.insertId}`]);
    if (raceState.outcome === "approved") {
      assert.deepEqual([Number(raceUser.credits), Number(raceState.refunded), Number(raceLedger.c)], [50, 25, 1]);
    } else {
      assert.deepEqual([raceState.outcome, Number(raceUser.credits), Number(raceState.refunded), Number(raceLedger.c)], ["denied", 25, 0, 0]);
    }
  });

  await t.test("manual-review and auto-resolution race has exactly one durable disposition", async () => {
    const [inserted] = await pool.query(
      "INSERT INTO refund_reviews (user_phone, cost_credits, match_score) VALUES ('owner-c', 20, 10)",
    );
    await Promise.all([
      markRefundForManualReview(inserted.insertId, "owner-c", "please inspect"),
      resolveRefundReview({ reviewId: inserted.insertId, phone: "owner-c", reason: "b_anatomy", feedbackText: null }),
    ]);
    const [[review]] = await pool.query("SELECT reason_code, outcome, refunded FROM refund_reviews WHERE id = ?", [inserted.insertId]);
    const [[ledger]] = await pool.query("SELECT COUNT(*) AS c FROM credit_transactions WHERE idempotency_key = ?", [`refund-review:${inserted.insertId}`]);
    assert.ok(["e_other", "b_anatomy"].includes(review.reason_code));
    assert.ok(["manual_review", "approved"].includes(review.outcome));
    assert.equal(Number(ledger.c), review.outcome === "approved" ? 1 : 0);
    assert.equal(Number(review.refunded), review.outcome === "approved" ? 20 : 0);
  });
});
