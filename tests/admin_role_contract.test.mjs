import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { isUserOperator } from "../server/pet-generation/wiring.ts";

test("the configured admin account is seeded with both admin and operator roles", () => {
  const source = fs.readFileSync("db.ts", "utf8");
  assert.match(source, /Required admin configuration missing/);
  assert.match(source, /is_admin = 1, is_operator = 1, profile_complete = 1/);
  assert.match(source, /Admin\/operator role verification failed after credential sync/);
  assert.doesNotMatch(source, /ADMIN_PASSWORD\s*=\s*["'][^"']+["']/);
});

test("operator access remains a database role and does not silently fall back to admin", async () => {
  const operatorPool = { query: async () => [[{ is_operator: 1 }]] };
  const normalPool = { query: async () => [[{ is_operator: 0 }]] };
  assert.equal(await isUserOperator(() => operatorPool, "admin-key"), true);
  assert.equal(await isUserOperator(() => normalPool, "normal-key"), false);
});

test("the UI and server both guard admin Wags access", () => {
  const app = fs.readFileSync("src/App.tsx", "utf8");
  const server = fs.readFileSync("server.ts", "utf8");
  assert.match(app, /adminOnly: true/);
  assert.match(app, /userProfile\.isAdmin \?/);
  assert.match(server, /\/api\/admin\/wags/);
  assert.match(server, /isUserAdmin/);
});
