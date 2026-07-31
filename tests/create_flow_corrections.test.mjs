import test from "node:test";
import assert from "node:assert";
import { 
  reservePipelineSessionForBuild,
  commitPipelineSessionBuild,
  markPipelineSessionRecoveryRequired,
  releasePipelineSessionReservation,
  getCreatePipelineSession
} from "../db.js";
import { getBuildProfileForSpecies, getSubjectClassForSpecies } from "../avatarPrompts.js";
import { isClassMismatch, classLabel } from "../server/imageTriage.js";

test("Species mapping preserves true species but routes to correct profile", async (t) => {
  assert.strictEqual(getSubjectClassForSpecies("cat"), "dog", "Cat should map to 'dog' (animal) for generic Tripo rigging");
  assert.strictEqual(getSubjectClassForSpecies("bird"), "dog", "Bird should map to 'dog' (animal) for generic Tripo rigging");
  assert.strictEqual(getSubjectClassForSpecies("human"), "human", "Human is preserved");
  assert.strictEqual(getSubjectClassForSpecies("object"), "object", "Object is preserved");

  assert.strictEqual(getBuildProfileForSpecies("cat"), "quadruped", "Cat gets quadruped profile");
  assert.strictEqual(getBuildProfileForSpecies("bird"), "winged", "Bird gets winged profile");
  assert.strictEqual(getBuildProfileForSpecies("reptile"), "reptile", "Reptile gets reptile profile");
  assert.strictEqual(getBuildProfileForSpecies("small_animal"), "small_animal", "Small animal gets specific profile");
  assert.strictEqual(getBuildProfileForSpecies("other"), "other", "Other gets fallback profile");
});

test("Triage preservation and matching", async (t) => {
  assert.strictEqual(classLabel("cat"), "cat", "Cat label should be explicitly 'cat'");
  assert.strictEqual(classLabel("small_animal"), "small animal", "Labels are formatted");
  
  const mismatch1 = isClassMismatch({ subjectClass: "dog", classConfidence: 0.9 }, "cat", 0.8);
  assert.strictEqual(mismatch1, true, "If triage detects dog but user picked cat, it is a mismatch (needs explicit override)");

  const mismatch2 = isClassMismatch({ subjectClass: "cat", classConfidence: 0.9 }, "cat", 0.8);
  assert.strictEqual(mismatch2, false, "Match succeeds without converting cat to dog internally");
});

class MockConnection {
  constructor() {
    this.queries = [];
    this.released = false;
  }
  async query(sql, params) {
    this.queries.push({ sql, params });
    const sqlLower = sql.toLowerCase();
    if (sqlLower.includes('start transaction') || sqlLower.includes('commit') || sqlLower.includes('rollback')) {
      return [];
    }
    
    // Stub for session locking
    if (sqlLower.includes('select * from create_pipeline_sessions')) {
      if (params[1] === "user_ref_ready") {
        return [[{ 
          id: params[0], 
          user_phone: "user_ref_ready", 
          status: "reference_ready", 
          idempotency_key: null 
        }]];
      }
      if (params[1] === "user_build_starting_match") {
        return [[{ 
          id: params[0], 
          user_phone: "user_build_starting_match", 
          status: "build_starting", 
          idempotency_key: "idem_match",
          credits_reserved: 20,
          credit_debit_correlation_id: "pipeline-test-debit",
        }]];
      }
      if (params[1] === "user_build_starting_mismatch") {
        return [[{ 
          id: params[0], 
          user_phone: "user_build_starting_mismatch", 
          status: "build_starting", 
          idempotency_key: "old_key" 
        }]];
      }
      if (params[1] === "user_recovery") {
        return [[{ 
          id: params[0], 
          user_phone: "user_recovery", 
          status: "build_starting", 
          idempotency_key: "idem_recovery" 
        }]];
      }
      if (params[1] === "user_commit_fail") {
        return [[{ 
          id: params[0], 
          user_phone: "user_commit_fail", 
          status: "build_starting", 
          idempotency_key: "idem_commit" 
        }]];
      }
      return [[]]; // not found
    }

    // Stub for user locking
    if (sqlLower.includes('from users') && sqlLower.includes('for update')) {
      return [[{ phone: params[0], credits: 100, is_admin: 0 }]];
    }

    if (sqlLower.includes('from credit_transactions') && sqlLower.includes('idempotency_key')) {
      if (params[0] === "pipeline-test-debit") {
        return [[{
          user_phone: "user_build_starting_match",
          delta: -20,
          reason: "create_pipeline_model",
        }]];
      }
      return [[]];
    }
    
    if (sqlLower.includes('update users set credits')) {
      return [{ affectedRows: 1 }];
    }
    if (sqlLower.includes('insert into credit_transactions')) {
      return [{ affectedRows: 1, insertId: 1 }];
    }
    if (sqlLower.includes('update create_pipeline_sessions set status = \'build_starting\'')) {
      return [{ affectedRows: 1 }];
    }
    if (sqlLower.includes('update create_pipeline_sessions set status = \'reference_ready\'')) {
      return [{ affectedRows: 1 }];
    }
    if (sqlLower.includes('update create_pipeline_sessions set status = \'recovery_required\'')) {
      return [{ affectedRows: 1 }];
    }
    
    // Stub for creations insert
    if (sqlLower.includes('insert into creations')) {
      if (params[0] === "user_commit_fail") {
        throw new Error("Simulated DB failure");
      }
      return [{ insertId: 999 }];
    }
    // Stub for generation_jobs insert
    if (sqlLower.includes('insert into generation_jobs')) {
      return [{ insertId: 1000 }];
    }
    
    return [[]];
  }
  release() {
    this.released = true;
  }
}

class MockPool {
  constructor() {
    this.queries = [];
  }
  async getConnection() {
    this.lastConn = new MockConnection();
    return this.lastConn;
  }
  async query(sql, params) {
    this.queries.push({ sql, params });
    const sqlLower = sql.toLowerCase();
    if (sqlLower.includes('update create_pipeline_sessions set status = \'recovery_required\'')) {
      return [{ affectedRows: 1 }];
    }
    return [[]];
  }
}

import { setPool } from "../db.js";

test("State machine transactions: successful flow", async (t) => {
  const pool = new MockPool();
  setPool(pool);

  // Test successful reservation
  const res = await reservePipelineSessionForBuild("sess_1", "user_ref_ready", "idem_1", 20);
  assert.strictEqual(res.success, true, "Reservation should succeed");
  
  // Verify deduct queries
  const conn = pool.lastConn;
  const debitLedgerQ = conn.queries.find(q => q.sql.includes('INSERT INTO credit_transactions') && q.params[1] === -20);
  assert.ok(debitLedgerQ, "The debit and its durable ledger evidence should be committed together");
});

test("Idempotency rules", async (t) => {
  const pool = new MockPool();
  setPool(pool);

  // Same key returns alreadyReservedOrBuilding
  const resMatch = await reservePipelineSessionForBuild("sess_2", "user_build_starting_match", "idem_match", 20);
  assert.strictEqual(resMatch.success, true);
  assert.strictEqual(resMatch.alreadyReservedOrBuilding, true);

  // Different key returns conflict
  const resConflict = await reservePipelineSessionForBuild("sess_3", "user_build_starting_mismatch", "idem_mismatch", 20);
  assert.strictEqual(resConflict.success, false, "Should reject conflicting reservation");
});

test("Provider failure refunds once", async (t) => {
  const pool = new MockPool();
  setPool(pool);

  const res = await releasePipelineSessionReservation("sess_4", "user_build_starting_match", 20);
  assert.strictEqual(res.success, true, "Refund succeeds for build_starting");
  
  // Verify it updates to reference_ready
  const conn = pool.lastConn;
  const statusQ = conn.queries.find(q => /UPDATE create_pipeline_sessions\s+SET status = 'reference_ready'/s.test(q.sql));
  assert.ok(statusQ, "Should set status back to reference_ready");
});

test("DB finalization failure enters recovery_required and persists handle", async (t) => {
  const pool = new MockPool();
  setPool(pool);

  // commitPipelineSessionBuild fails on user_commit_fail
  const res = await commitPipelineSessionBuild("sess_5", "user_commit_fail", {}, {});
  assert.strictEqual(res.success, false);

  await markPipelineSessionRecoveryRequired("sess_5", "user_commit_fail", "tripo_handle_xyz");
  const recoveryQ = pool.queries.find(q => q.sql.includes('recovery_required'));
  assert.ok(recoveryQ, "Should mark recovery_required");
  assert.strictEqual(recoveryQ.params[0], "tripo_handle_xyz", "Should save the provider handle");
});
