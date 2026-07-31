import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { resetPasswordWithToken } from "../db.ts";
import { isAtLeastAge, parseBirthdate } from "../server/accountValidation.ts";

class ResetConnection {
  constructor({ token = true, user = true } = {}) {
    this.token = token;
    this.user = user;
    this.commits = 0;
    this.rollbacks = 0;
    this.released = false;
    this.queries = [];
  }
  async beginTransaction() {}
  async commit() { this.commits += 1; }
  async rollback() { this.rollbacks += 1; }
  release() { this.released = true; }
  async query(sql, params) {
    this.queries.push({ sql, params });
    if (/SELECT id, user_phone[\s\S]+FOR UPDATE/.test(sql)) {
      return [this.token ? [{ id: 7, user_phone: "owner-1" }] : []];
    }
    if (/UPDATE password_resets SET used_at/.test(sql)) return [{ affectedRows: this.token ? 1 : 0 }];
    if (/UPDATE users SET password_hash/.test(sql)) return [{ affectedRows: this.user ? 1 : 0 }];
    throw new Error(`Unexpected query: ${sql}`);
  }
}

test("birthdate validation rejects malformed, impossible, future, and underage dates", () => {
  const now = new Date("2026-07-31T12:00:00Z");
  assert.deepEqual(parseBirthdate("2010-02-28"), { year: 2010, month: 2, day: 28 });
  for (const invalid of ["2010/02/28", "2010-02-30", "not-a-date", "2030-01-01"]) {
    assert.equal(isAtLeastAge(invalid, 13, now), false, invalid);
  }
  assert.equal(isAtLeastAge("2013-07-31", 13, now), true);
  assert.equal(isAtLeastAge("2013-08-01", 13, now), false);
});

test("password reset consumes the token and changes the password in one transaction", async () => {
  const connection = new ResetConnection();
  const result = await resetPasswordWithToken("token-hash", "password-hash", {
    getConnection: async () => connection,
  });
  assert.equal(result, true);
  assert.equal(connection.commits, 1);
  assert.equal(connection.rollbacks, 0);
  assert.equal(connection.released, true);
  assert.match(connection.queries[0].sql, /FOR UPDATE/);
  assert.deepEqual(connection.queries.at(-1).params, ["password-hash", "owner-1"]);
});

test("an invalid or consumed reset token never changes a password", async () => {
  const connection = new ResetConnection({ token: false });
  const result = await resetPasswordWithToken("missing", "password-hash", {
    getConnection: async () => connection,
  });
  assert.equal(result, false);
  assert.equal(connection.commits, 0);
  assert.equal(connection.rollbacks, 1);
  assert.equal(connection.queries.some(({ sql }) => /UPDATE users SET password_hash/.test(sql)), false);
});

test("unbounded phone verification is not exposed until a challenge and quotas exist", () => {
  const server = fs.readFileSync("server.ts", "utf8");
  const profile = fs.readFileSync("src/components/ProfileScreen.tsx", "utf8");
  assert.doesNotMatch(server, /app\.post\("\/api\/verify\/phone\/(?:start|check)"/);
  assert.doesNotMatch(profile, /\/api\/verify\/phone|Verify your phone number/);
});
