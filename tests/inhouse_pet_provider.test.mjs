import assert from "node:assert/strict";
import { test } from "node:test";

process.env.PET_GLB_ENABLED = "true";

const { InHousePetGenerationAdapter } = await import("../server/pet-generation/inHouseAdapter.ts");
const { createProviderForSku } = await import("../server/pet-generation/factory.ts");
const { InMemoryJobStore, PetGenerationError } = await import("../server/pet-generation/provider.ts");
const { SkuRegistry, CUSTOM_RIGGED_PET_GLB_V1 } = await import("../server/pet-generation/skuRegistry.ts");

const references = {
  frontUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
  leftUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
  rightUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
  rearUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
  meshProfile: "hd",
  subjectProfile: "pet",
};

function validGlb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scenes: [{}], scene: 0 }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const bytes = Buffer.alloc(20 + padded.length);
  bytes.write("glTF", 0, "ascii");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(padded.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(bytes, 20);
  return bytes;
}

test("in-house paid adapter completes only the TRELLIS base boundary", async () => {
  const artifact = validGlb();
  const calls = { start: 0, poll: 0, download: 0 };
  const provider = {
    async start(input) {
      calls.start += 1;
      assert.equal(input.geometry.texture, true);
      assert.equal(input.geometry.pbr, true);
      return { providerTaskHandle: "trellis2:00000000-0000-4000-8000-000000000001", provider: "trellis2", model: "pinned" };
    },
    async poll() {
      calls.poll += 1;
      return { done: true, progress: 100, glbUrl: "trellis2-artifact:00000000-0000-4000-8000-000000000001" };
    },
    async download() {
      calls.download += 1;
      return artifact;
    },
  };
  const adapter = new InHousePetGenerationAdapter(provider, new InMemoryJobStore(), "pinned");
  const job = await adapter.createBaseJob(references);
  assert.equal((await adapter.getJob(job.id)).status, "completed");
  const result = await adapter.fetchArtifacts(job.id);
  assert.deepEqual(result.glb.data, artifact);
  assert.equal(result.metadata.providerId, "trellis2");
  assert.deepEqual(calls, { start: 1, poll: 1, download: 1 });
});

test("in-house paid adapter refuses unfinished stages without provider calls", async () => {
  let externalCalls = 0;
  const provider = {
    async start() { externalCalls += 1; throw new Error("not expected"); },
    async poll() { externalCalls += 1; throw new Error("not expected"); },
    async download() { externalCalls += 1; throw new Error("not expected"); },
  };
  const store = new InMemoryJobStore();
  await store.put({
    jobId: "00000000-0000-4000-8000-000000000002",
    providerId: "trellis2",
    providerVersion: "pinned",
    providerTaskHandle: "trellis2:00000000-0000-4000-8000-000000000001",
    model: "pinned",
    configHash: "0".repeat(64),
    cancelled: false,
    stage: "base",
    createdAt: Date.now(),
  });
  const adapter = new InHousePetGenerationAdapter(provider, store, "pinned");
  for (const operation of [
    () => adapter.createTextureJob("00000000-0000-4000-8000-000000000002", { quality: "standard" }),
    () => adapter.createRigCheckJob("00000000-0000-4000-8000-000000000002"),
    () => adapter.createRigJob("00000000-0000-4000-8000-000000000002", "pet"),
  ]) {
    await assert.rejects(operation, (error) => error instanceof PetGenerationError && error.code === "INHOUSE_STAGE_NOT_READY");
  }
  assert.equal(externalCalls, 0);
});

test("paid SKU factory selects TRELLIS and rejects Tripo in in-house-only mode", () => {
  const prior = { ...process.env };
  try {
    process.env.TRELLIS_WORKER_URL = "http://10.0.2.4:8000";
    process.env.TRELLIS_WORKER_SHARED_SECRET = "test-only-worker-secret";
    process.env.PAWS_3D_INHOUSE_ONLY = "true";

    const inHouseRegistry = new SkuRegistry();
    inHouseRegistry.register(CUSTOM_RIGGED_PET_GLB_V1, { providerId: "trellis2", providerVersion: "pinned" });
    assert.ok(createProviderForSku(CUSTOM_RIGGED_PET_GLB_V1, { registry: inHouseRegistry }) instanceof InHousePetGenerationAdapter);

    const externalRegistry = new SkuRegistry();
    externalRegistry.register(CUSTOM_RIGGED_PET_GLB_V1, { providerId: "tripo", providerVersion: "default" });
    assert.throws(
      () => createProviderForSku(CUSTOM_RIGGED_PET_GLB_V1, { registry: externalRegistry }),
      (error) => error instanceof PetGenerationError && error.code === "INHOUSE_PROVIDER_REQUIRED",
    );
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
  }
});
