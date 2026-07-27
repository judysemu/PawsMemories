import { test } from "node:test";
import assert from "node:assert";

const { PetGlbService } = await import("../server/pet-generation/service.js");
const { PetGenerationError } = await import("../server/pet-generation/provider.js");

/**
 * In-memory stand-in for a mysql2 pool + connection, holding one pet_glb_orders
 * row. Routes the exact SQL the repository issues (order lookup, guarded credit
 * charge, transactional state transition with FOR UPDATE + event insert) so the
 * credits-only payment path is exercised against the real state machine.
 */
function makeFakeDb(initial) {
  const row = {
    id: 1,
    order_uuid: "11111111-1111-1111-1111-111111111111",
    owner_phone: "+15550000001",
    sku: "CUSTOM_RIGGED_PET_GLB_V1",
    state: "awaiting_payment",
    reference_session_id: null,
    generation_job_id: null,
    asset_id: null,
    approved_version_id: null,
    credits_reserved: 15,
    credits_disposition: "reserved",
    delivered_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...initial,
  };

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, " ").trim().toUpperCase();

    if (s.startsWith("SELECT * FROM PET_GLB_ORDERS WHERE ORDER_UUID")) {
      return [row.order_uuid === params[0] ? [{ ...row }] : []];
    }
    if (s.startsWith("SELECT * FROM PET_GLB_ORDERS WHERE ID")) {
      return [row.id === params[0] ? [{ ...row }] : []];
    }
    if (s.includes("SET CREDITS_DISPOSITION = 'CHARGED'") && s.includes("= 'RESERVED'")) {
      if (row.id === params[0] && row.credits_disposition === "reserved") {
        row.credits_disposition = "charged";
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }
    if (s.startsWith("UPDATE PET_GLB_ORDERS SET STATE")) {
      const [to, id, from] = params;
      if (row.id === id && row.state === from) {
        row.state = to;
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }
    if (s.startsWith("INSERT INTO PET_GLB_ORDER_EVENTS")) {
      return [{ affectedRows: 1 }];
    }
    throw new Error("unexpected SQL in fake: " + s);
  }

  const conn = {
    query,
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };

  const pool = { query, getConnection: async () => conn };
  return { pool, row };
}

function makeService(db, { isAdmin = false } = {}) {
  return new PetGlbService({
    getPool: () => db.pool,
    isAdmin: async () => isAdmin,
    isOperator: async () => false,
    persistVersion: async () => ({ assetId: 1, versionId: 1 }),
    signDownload: async () => "unused",
  });
}

test("payWithCredits charges reserved credits and advances to awaiting_references", async () => {
  const db = makeFakeDb();
  const svc = makeService(db);
  const out = await svc.payWithCredits(db.row.order_uuid, "+15550000001");
  assert.equal(out.state, "awaiting_references");
  assert.equal(out.creditsDisposition, "charged");
  assert.equal(db.row.state, "awaiting_references");
  assert.equal(db.row.credits_disposition, "charged");
});

test("payWithCredits is idempotent once the order is already paid", async () => {
  const db = makeFakeDb();
  const svc = makeService(db);
  await svc.payWithCredits(db.row.order_uuid, "+15550000001");
  const again = await svc.payWithCredits(db.row.order_uuid, "+15550000001");
  assert.equal(again.state, "awaiting_references");
  assert.equal(again.creditsDisposition, "charged");
});

test("payWithCredits refuses a caller who does not own the order", async () => {
  const db = makeFakeDb();
  const svc = makeService(db);
  await assert.rejects(
    () => svc.payWithCredits(db.row.order_uuid, "+15559999999"),
    (e) => e instanceof PetGenerationError && e.code === "FORBIDDEN",
  );
  assert.equal(db.row.credits_disposition, "reserved"); // untouched
});

test("payWithCredits rejects an order that is not awaiting payment and not charged", async () => {
  const db = makeFakeDb({ state: "cancelled", credits_disposition: "reserved" });
  const svc = makeService(db);
  await assert.rejects(
    () => svc.payWithCredits(db.row.order_uuid, "+15550000001"),
    (e) => e instanceof PetGenerationError && e.code === "ILLEGAL_TRANSITION",
  );
});
