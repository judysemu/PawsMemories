import { test } from "node:test";
import assert from "node:assert";

const { MySqlProviderJobStore, PROVIDER_GENERATION_JOBS_DDL } = await import(
  "../server/pet-generation/jobStore.js"
);
const { TripoPetGenerationAdapter } = await import(
  "../server/pet-generation/tripoAdapter.js"
);
const { PetGenerationError } = await import("../server/pet-generation/provider.js");

/**
 * Minimal in-process stand-in for a mysql2 pool. Executes the store's real SQL
 * shape decisions (INSERT ... ON DUPLICATE KEY, GREATEST for the monotonic
 * cancel flag) against a Map, and records every statement so we can assert on
 * what the store actually sends.
 */
function makeFakePool() {
  const rows = new Map();
  const statements = [];
  return {
    statements,
    rows,
    async query(sql, params = []) {
      statements.push(sql.replace(/\s+/g, " ").trim());
      const s = sql.toUpperCase();

      if (s.includes("INSERT INTO PROVIDER_GENERATION_JOBS")) {
        const [job_id, order_id, provider_id, provider_version, provider_task_handle,
               model, config_hash, cancelled, glb_url] = params;
        // ON DUPLICATE KEY UPDATE job_id = job_id  => existing row untouched
        if (!rows.has(job_id)) {
          rows.set(job_id, {
            job_id, order_id, provider_id, provider_version, provider_task_handle,
            model, config_hash, cancelled, glb_url, created_ms: Date.now(),
          });
        }
        return [{ affectedRows: 1 }];
      }

      if (s.startsWith("SELECT")) {
        const row = rows.get(params[0]);
        return [row ? [row] : []];
      }

      if (s.startsWith("UPDATE")) {
        const jobId = params[params.length - 1];
        const row = rows.get(jobId);
        if (!row) return [{ affectedRows: 0 }];
        let i = 0;
        if (sql.includes("cancelled = GREATEST")) {
          row.cancelled = Math.max(row.cancelled, params[i++]); // monotonic
        }
        if (sql.includes("glb_url = ?")) row.glb_url = params[i++];
        if (sql.includes("order_id = ?")) row.order_id = params[i++];
        return [{ affectedRows: 1 }];
      }

      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

function makeFakeModelBuildProvider() {
  const calls = { start: 0, poll: 0, download: 0 };
  return {
    calls,
    async start() {
      calls.start++;
      return { providerTaskHandle: "tripo-handle-xyz", provider: "tripo", model: "v2.5" };
    },
    async poll() {
      calls.poll++;
      return { done: true, glbUrl: "https://api.tripo3d.ai/fake/out.glb", progress: 100 };
    },
    async download() {
      calls.download++;
      return Buffer.from("glTF-bytes");
    },
  };
}

const REFS = {
  frontUrl: "https://example.test/f.png",
  leftUrl: "https://example.test/l.png",
  rightUrl: "https://example.test/r.png",
  rearUrl: "https://example.test/b.png",
  threeQuarterUrl: "https://example.test/tq.png",
};

const RECORD = {
  jobId: "11111111-1111-4111-8111-111111111111",
  providerId: "tripo",
  providerVersion: "v2.5",
  providerTaskHandle: "handle-1",
  model: "m",
  configHash: "c".repeat(64),
  cancelled: false,
  createdAt: Date.now(),
};

test("G3 durable ProviderJobStore", async (t) => {
  await t.test("round-trips a record", async () => {
    const pool = makeFakePool();
    const store = new MySqlProviderJobStore(() => pool);

    await store.put(RECORD);
    const got = await store.get(RECORD.jobId);

    assert.strictEqual(got.jobId, RECORD.jobId);
    assert.strictEqual(got.providerId, "tripo");
    assert.strictEqual(got.providerTaskHandle, "handle-1");
    assert.strictEqual(got.cancelled, false, "boolean is decoded from TINYINT");
    assert.strictEqual(typeof got.createdAt, "number");
  });

  await t.test("unknown job returns undefined, not a throw", async () => {
    const store = new MySqlProviderJobStore(() => makeFakePool());
    assert.strictEqual(await store.get("no-such-job"), undefined);
  });

  await t.test("put is retry-safe and never clobbers resolved state", async () => {
    const pool = makeFakePool();
    const store = new MySqlProviderJobStore(() => pool);

    await store.put(RECORD);
    await store.update(RECORD.jobId, { glbUrl: "https://cdn.test/a.glb", cancelled: true });
    await store.put(RECORD); // retry of createJob

    const got = await store.get(RECORD.jobId);
    assert.strictEqual(got.cancelled, true, "retry must not resurrect a cancelled job");
    assert.strictEqual(got.glbUrl, "https://cdn.test/a.glb", "retry must not drop the resolved URL");
  });

  await t.test("cancellation is monotonic — a late writer cannot un-cancel", async () => {
    const pool = makeFakePool();
    const store = new MySqlProviderJobStore(() => pool);

    await store.put(RECORD);
    await store.update(RECORD.jobId, { cancelled: true });
    await store.update(RECORD.jobId, { cancelled: false }); // late/stale writer

    assert.strictEqual((await store.get(RECORD.jobId)).cancelled, true);
    assert.ok(
      pool.statements.some((s) => s.includes("cancelled = GREATEST")),
      "monotonicity must be enforced in SQL, not only in JS",
    );
  });

  await t.test("update on a missing job throws JOB_NOT_FOUND", async () => {
    const store = new MySqlProviderJobStore(() => makeFakePool());
    await assert.rejects(
      () => store.update("missing", { cancelled: true }),
      (err) => err instanceof PetGenerationError && err.code === "JOB_NOT_FOUND",
    );
  });

  await t.test("no-op update issues no SQL", async () => {
    const pool = makeFakePool();
    const store = new MySqlProviderJobStore(() => pool);
    await store.put(RECORD);
    const before = pool.statements.length;
    await store.update(RECORD.jobId, {});
    assert.strictEqual(pool.statements.length, before, "empty patch must not hit the DB");
  });

  await t.test("adapter works against the durable store with no adapter change", async () => {
    const pool = makeFakePool();
    const store = new MySqlProviderJobStore(() => pool);
    const fake = makeFakeModelBuildProvider();
    const adapter = new TripoPetGenerationAdapter(fake, store, "v2.5");

    const job = await adapter.createJob(REFS);
    assert.ok(job.id);

    const polled = await adapter.getJob(job.id);
    assert.strictEqual(polled.status, "completed");

    const artifacts = await adapter.fetchArtifacts(job.id);
    assert.ok(Buffer.isBuffer(artifacts.glb.data));
    assert.ok(fake.calls.download > 0);

    // The URL is persisted internally...
    assert.ok(pool.rows.get(job.id).glb_url, "glb_url persisted in the store");
    // ...and still never crosses the boundary.
    assert.ok(!JSON.stringify(polled).match(/https?:\/\//), "getJob leaks no URL");
    assert.ok(
      !JSON.stringify(artifacts.metadata).match(/https?:\/\//),
      "metadata leaks no URL",
    );
  });

  await t.test("tombstone survives in the durable store", async () => {
    const pool = makeFakePool();
    const store = new MySqlProviderJobStore(() => pool);
    const adapter = new TripoPetGenerationAdapter(
      makeFakeModelBuildProvider(),
      store,
      "v2.5",
    );

    const job = await adapter.createJob(REFS);
    await adapter.cancelJob(job.id);

    assert.strictEqual((await adapter.getJob(job.id)).status, "cancelled");
    assert.strictEqual(pool.rows.get(job.id).cancelled, 1, "persisted, not just in memory");

    await assert.rejects(
      () => adapter.fetchArtifacts(job.id),
      (err) => err.code === "JOB_CANCELLED",
    );
  });

  await t.test("DDL is idempotent and indexed", () => {
    assert.match(PROVIDER_GENERATION_JOBS_DDL, /CREATE TABLE IF NOT EXISTS/);
    assert.match(PROVIDER_GENERATION_JOBS_DDL, /job_id CHAR\(36\) NOT NULL PRIMARY KEY/);
    assert.match(PROVIDER_GENERATION_JOBS_DDL, /idx_pgj_order/);
    assert.match(PROVIDER_GENERATION_JOBS_DDL, /idx_pgj_handle/);
  });
});
