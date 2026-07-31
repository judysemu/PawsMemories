import assert from "node:assert/strict";
import test from "node:test";
import { MIGRATIONS, runMigrations, sha256 } from "../server/migrations/runner.ts";

const PUBLISHED_MIGRATION_CHECKSUMS = {
  16: "b90e1f3aaf0895654bb0622c718d15924f316481b655a6b38225b8baac0f7455",
  17: "79e4bf9eab7c028c26e099d4429473c89ae1d9536732e4d3f7275cbd5b4bd238",
  18: "e3a47f905cb6ce4a40345d8bc77c77467ca7f686996eaa3dd46106b9769c65f3",
  19: "052c07e3b78cf66d106bc9a6d741c991544b3d0c6720b930c4f477085c1cee7a",
  20: "de4d79fa5b2699c4d7745d72a3cf1e84ec709331ce3ca05168a616e04d90bf17",
  21: "22de0bd6f9cdfc23acbae245d0c1b8ce512687213b6faae3ecb67d71fbc2b9d1",
  22: "0b05fb4707dd28420d1a96f4211e9368673fd7c2a7b119914a43db0484b7983a",
  23: "f7215a74e6f4a07ade76564e207a9bddd84558428923b70a11b7f8e451b15bf9",
  24: "e5495d63563fe312bd7eb4b3e9c5a3e32d9937f6a9a1e0746ae9e8bc2b1ad5a5",
  25: "7bf1492cccacca9a3ff9054a6e91f3e4717d7f9789dfe7639355b6e27a95fdef",
  26: "5ff0f7c8b7814026aa0e59988cee1262e37edc67582e1fb9b25046d2f7442372",
  27: "e13d3c905453dac44c71309253294ea49b238541b33bcd56f356f4b3cc345a80",
  28: "6f904adcb0adc55ba55992b002ad3fd220c2a58783764ab09118efbabee12f8d",
  29: "101a432bb6bf477503ab1da9dc71c848361baeea0f3786191dfe2be353577168",
  30: "afd5a72969c4f03fb77bc776aba1f8e327aa15cb8b0a59ca78d43009e504deb6",
  32: "095fe7faf347472ca9de48dff32bd1f966659503bf3019d301f5ec6b4db10819",
  33: "30af84708ca8b3ec0cfe8c0984615d70210d257f489b741fe5a16806cf212657",
  34: "d6ec91c3b529d73f28a958ef312317629e7628443be9aa77a400b37e94f6b23a",
};

test("sha256 produces deterministic checksums", () => {
  const hash1 = sha256("SELECT 1;");
  const hash2 = sha256("  SELECT 1;  ");
  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
});

test("published migrations remain immutable", () => {
  for (const [versionText, expectedChecksum] of Object.entries(PUBLISHED_MIGRATION_CHECKSUMS)) {
    const migration = MIGRATIONS.find((entry) => entry.version === Number(versionText));
    assert.ok(migration, `published migration ${versionText} is missing`);
    const rawSql = migration.statements.map((statement) => statement.trim()).join(";\n");
    assert.equal(
      sha256(rawSql),
      expectedChecksum,
      `migration ${migration.version} was edited; add a new migration instead`,
    );
  }
});

test("model-build durability migration adds recovery and refund sweep evidence", () => {
  const migration = MIGRATIONS.find((entry) => entry.version === 40);
  assert.equal(migration?.name, "model_build_durability_recovery");
  const sql = migration.statements.join("\n");
  assert.match(sql, /submission_claimed_at/);
  assert.match(sql, /recovery_required_at/);
  assert.match(sql, /refund_pending_at/);
  assert.match(sql, /refund_attempts/);
});

test("runMigrations acquires dedicated connection, performs migration, and releases lock & connection in finally", async () => {
  const connectionQueries = [];
  const storedRows = [];
  let lockAcquired = false;
  let connectionReleased = false;

  const mockConnection = {
    async query(sql, params) {
      const sqlStr = String(sql).trim();
      connectionQueries.push(sqlStr);

      if (sqlStr.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) {
        return [[]];
      }
      if (sqlStr.includes("GET_LOCK")) {
        lockAcquired = true;
        return [[{ lock_acquired: 1 }]];
      }
      if (sqlStr.includes("RELEASE_LOCK")) {
        lockAcquired = false;
        return [[{ lock_released: 1 }]];
      }
      if (sqlStr.startsWith("SELECT version, name, checksum")) {
        return [storedRows];
      }
      if (sqlStr.startsWith("INSERT INTO schema_migrations")) {
        storedRows.push({
          version: params[0],
          name: params[1],
          checksum: params[2],
          applied_at: new Date(),
          duration_ms: params[3],
        });
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
    release() {
      connectionReleased = true;
    },
  };

  let poolGetConnectionCalled = false;
  const mockPool = {
    async getConnection() {
      poolGetConnectionCalled = true;
      return mockConnection;
    },
    async query() {
      throw new Error("Pool.query should not be called directly during migrations; use dedicated connection.");
    },
  };

  const testMigrations = [
    {
      version: 16,
      name: "test_migration_16",
      statements: ["CREATE TABLE test16 (id INT PRIMARY KEY);"],
    },
    {
      version: 17,
      name: "test_migration_17",
      statements: ["CREATE TABLE test17 (id INT PRIMARY KEY);"],
    },
  ];

  const result = await runMigrations(mockPool, testMigrations);

  assert.ok(poolGetConnectionCalled, "Must acquire connection via pool.getConnection()");
  assert.equal(result.applied, 2);
  assert.equal(storedRows.length, 2);
  assert.equal(storedRows[0].version, 16);
  assert.equal(storedRows[1].version, 17);
  assert.equal(lockAcquired, false, "Lock must be released after completion");
  assert.equal(connectionReleased, true, "Connection must be released after completion");

  // Second run: 0 migrations applied
  connectionReleased = false;
  const result2 = await runMigrations(mockPool, testMigrations);
  assert.equal(result2.applied, 0);
  assert.equal(connectionReleased, true, "Connection must be released on second run");
});

test("runMigrations releases lock and connection in finally when migration statement fails", async () => {
  let lockAcquired = false;
  let connectionReleased = false;

  const mockConnection = {
    async query(sql) {
      const sqlStr = String(sql).trim();
      if (sqlStr.includes("GET_LOCK")) {
        lockAcquired = true;
        return [[{ lock_acquired: 1 }]];
      }
      if (sqlStr.includes("RELEASE_LOCK")) {
        lockAcquired = false;
        return [[{ lock_released: 1 }]];
      }
      if (sqlStr.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) return [[]];
      if (sqlStr.startsWith("SELECT version, name, checksum")) return [[]];
      if (sqlStr.startsWith("FAIL_STATEMENT")) {
        throw new Error("Syntax error in DDL statement");
      }
      return [[]];
    },
    release() {
      connectionReleased = true;
    },
  };

  const mockPool = {
    async getConnection() {
      return mockConnection;
    },
  };

  const failingMigrations = [
    {
      version: 16,
      name: "failing_mig",
      statements: ["FAIL_STATEMENT"],
    },
  ];

  await assert.rejects(
    async () => {
      await runMigrations(mockPool, failingMigrations);
    },
    /Syntax error in DDL statement/,
  );

  assert.equal(lockAcquired, false, "Lock must be released in finally block on error");
  assert.equal(connectionReleased, true, "Connection must be released in finally block on error");
});

test("runMigrations rejects duplicate versions and duplicate names before connection/DDL", async () => {
  const mockPool = {
    async getConnection() {
      assert.fail("Should not acquire connection if migrations array is invalid");
    },
  };

  const duplicateVersions = [
    { version: 16, name: "mig_a", statements: ["SELECT 1"] },
    { version: 16, name: "mig_b", statements: ["SELECT 2"] },
  ];

  await assert.rejects(
    async () => {
      await runMigrations(mockPool, duplicateVersions);
    },
    /Duplicate migration version detected: 16/,
  );

  const duplicateNames = [
    { version: 16, name: "same_name", statements: ["SELECT 1"] },
    { version: 17, name: "same_name", statements: ["SELECT 2"] },
  ];

  await assert.rejects(
    async () => {
      await runMigrations(mockPool, duplicateNames);
    },
    /Duplicate migration name detected: same_name/,
  );
});

test("runMigrations detects checksum mismatch for modified applied migration", async () => {
  const storedRows = [
    {
      version: 16,
      name: "test_migration_16",
      checksum: sha256("ORIGINAL STATEMENT"),
      applied_at: new Date(),
      duration_ms: 10,
    },
  ];

  let lockAcquired = false;
  let connectionReleased = false;

  const mockConnection = {
    async query(sql) {
      const sqlStr = String(sql).trim();
      if (sqlStr.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) return [[]];
      if (sqlStr.includes("GET_LOCK")) {
        lockAcquired = true;
        return [[{ lock_acquired: 1 }]];
      }
      if (sqlStr.includes("RELEASE_LOCK")) {
        lockAcquired = false;
        return [[{ lock_released: 1 }]];
      }
      if (sqlStr.startsWith("SELECT version, name, checksum")) return [storedRows];
      return [[]];
    },
    release() {
      connectionReleased = true;
    },
  };

  const mockPool = {
    async getConnection() {
      return mockConnection;
    },
  };

  const tamperedMigrations = [
    {
      version: 16,
      name: "test_migration_16",
      statements: ["MODIFIED STATEMENT"],
    },
  ];

  await assert.rejects(
    async () => {
      await runMigrations(mockPool, tamperedMigrations);
    },
    /Migration checksum mismatch for version 16/,
  );

  assert.equal(lockAcquired, false, "Lock must be released on checksum mismatch");
  assert.equal(connectionReleased, true, "Connection must be released on checksum mismatch");
});
