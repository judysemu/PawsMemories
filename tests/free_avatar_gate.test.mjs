import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from "../server/migrations/runner.ts";

const db = fs.readFileSync("db.ts", "utf8");
const server = fs.readFileSync("server.ts", "utf8");

test("migration 53 adds server-owned settings and the opt-in list", () => {
  assert.ok(CURRENT_SCHEMA_VERSION >= 53);
  const m = MIGRATIONS.find((e) => e.version === 53);
  assert.equal(m?.name, "free_avatar_gate_and_notify");
  const sql = m.statements.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS app_settings/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS gate_notify_optins/);
  // One opt-in per user per gate, so repeated taps cannot duplicate mail.
  assert.match(sql, /UNIQUE KEY uniq_gate_optin \(user_phone, gate\)/);
});

test("a closed or never-opened gate reads as closed", () => {
  const fn = db.slice(db.indexOf("export async function getAppSetting"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /return fallback/);
  assert.match(db, /getAppSetting\(FREE_AVATAR_GATE, "closed"\)/);
});

test("the gate is checked inside the claim, not before it", () => {
  const fn = db.slice(db.indexOf("export async function claimFreeAvatar"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /UPDATE users SET free_avatar_available = 0/);
  assert.match(body, /free_avatar_available = 1/);
  // The window is part of the same conditional UPDATE.
  assert.match(body, /setting_value FROM app_settings WHERE setting_key = \?\) = 'open'/);
  assert.match(body, /affectedRows === 1/);
});

test("opening a window re-arms opt-ins, and notified_at prevents duplicates within it", () => {
  assert.match(db, /export async function resetGateNotifications/);
  assert.match(db, /SET notified_at = NULL WHERE gate = \?/);
  assert.match(db, /o\.notified_at IS NULL/);
  const route = server.slice(server.indexOf('app.post("/api/admin/free-avatar/gate"'));
  const body = route.slice(0, route.indexOf('app.use("/api/pawprints/purchase"'));
  assert.ok(body.indexOf("resetGateNotifications") < body.indexOf("listPendingGateNotifications"));
  assert.match(body, /markGateNotified/);
});

test("only people who can still use the window are emailed", () => {
  const fn = db.slice(db.indexOf("export async function listPendingGateNotifications"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /u\.free_avatar_available = 1/);
  assert.match(body, /u\.email IS NOT NULL/);
});

test("closing the window notifies nobody", () => {
  const route = server.slice(server.indexOf('app.post("/api/admin/free-avatar/gate"'));
  const body = route.slice(0, route.indexOf('app.use("/api/pawprints/purchase"'));
  assert.match(body, /if \(action !== "open"\) return res\.json\(\{ success: true, open: false, notified: 0 \}\)/);
});

test("only an admin can move the gate", () => {
  const route = server.slice(server.indexOf('app.post("/api/admin/free-avatar/gate"'));
  const body = route.slice(0, route.indexOf('app.use("/api/pawprints/purchase"'));
  assert.match(body, /isUserAdmin/);
  assert.match(body, /status\(403\)/);
});

test("only successfully sent mail is marked notified", () => {
  const route = server.slice(server.indexOf('app.post("/api/admin/free-avatar/gate"'));
  const body = route.slice(0, route.indexOf('app.use("/api/pawprints/purchase"'));
  // A failed send must remain pending so it can be retried on the next open.
  assert.match(body, /if \(sent\) notified\.push/);
});
