import { test } from "node:test";
import assert from "node:assert";

// Feature flag must be set BEFORE importing the factory — assertPetGlbEnabled()
// reads process.env at call time, but we set it here so every import path is safe.
process.env.PET_GLB_ENABLED = "true";

const { createProviderForSku, resetProviderFactoryForTests } = await import(
  "../server/pet-generation/factory.js"
);
const { SkuRegistry, registerDefaultSkus, CUSTOM_RIGGED_PET_GLB_V1 } = await import(
  "../server/pet-generation/skuRegistry.js"
);
const { StubPetGenerationProvider } = await import(
  "../server/pet-generation/stubProvider.js"
);
const { TripoPetGenerationAdapter } = await import(
  "../server/pet-generation/tripoAdapter.js"
);
const { InMemoryJobStore, PetGenerationError } = await import(
  "../server/pet-generation/provider.js"
);

const REFS = {
  frontUrl: "https://example.test/front.png",
  leftUrl: "https://example.test/left.png",
  rightUrl: "https://example.test/right.png",
  rearUrl: "https://example.test/rear.png",
  threeQuarterUrl: "https://example.test/tq.png",
};

/** Recursively fail on any key matching /url/i at any depth. */
function assertNoUrlAnywhere(value, path = "$") {
  if (value === null || value === undefined) return;
  if (Buffer.isBuffer(value)) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUrlAnywhere(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      assert.ok(
        !/url/i.test(k),
        `URL-shaped key leaked across the provider boundary at ${path}.${k}`,
      );
      assertNoUrlAnywhere(v, `${path}.${k}`);
    }
    return;
  }
  if (typeof value === "string") {
    assert.ok(
      !/^https?:\/\//i.test(value),
      `URL-shaped string leaked across the provider boundary at ${path}: ${value}`,
    );
  }
}

/** Minimal fake of the legacy three-method ModelBuildProvider port. */
function makeFakeModelBuildProvider(overrides = {}) {
  const calls = { start: 0, poll: 0, download: 0 };
  return {
    calls,
    async start(input, configHash) {
      calls.start++;
      calls.lastInput = input;
      calls.lastConfigHash = configHash;
      return { providerTaskHandle: "tripo-handle-abc123", provider: "tripo", model: "v2.5" };
    },
    async poll() {
      calls.poll++;
      return { done: true, glbUrl: "https://api.tripo3d.ai/fake/output.glb", progress: 100 };
    },
    async download() {
      calls.download++;
      return Buffer.from("glTF-fake-bytes");
    },
    ...overrides,
  };
}

test("G2 provider boundary", async (t) => {
  // ── 1 ────────────────────────────────────────────────────────────────────
  await t.test("SKU resolution is deterministic and logged", () => {
    const registry = new SkuRegistry();
    registerDefaultSkus(registry);

    const a = registry.resolve(CUSTOM_RIGGED_PET_GLB_V1);
    const b = registry.resolve(CUSTOM_RIGGED_PET_GLB_V1);
    assert.deepStrictEqual(a, b, "resolution must be deterministic");
    assert.strictEqual(a.providerId, "tripo");
    assert.ok(a.providerVersion, "providerVersion must be recorded");
  });

  // ── 2 ────────────────────────────────────────────────────────────────────
  await t.test("unknown SKU fails closed — even with the stub override on", () => {
    const registry = new SkuRegistry();
    registerDefaultSkus(registry);

    const prior = process.env.PET_GLB_USE_STUB;
    process.env.PET_GLB_USE_STUB = "true";
    try {
      assert.throws(
        () => createProviderForSku("NOT_A_REAL_SKU", { registry }),
        (err) => err instanceof PetGenerationError && err.code === "SKU_NOT_REGISTERED",
        "stub override must not mask an unregistered SKU",
      );
    } finally {
      if (prior === undefined) delete process.env.PET_GLB_USE_STUB;
      else process.env.PET_GLB_USE_STUB = prior;
    }
  });

  // ── 3 ────────────────────────────────────────────────────────────────────
  await t.test("CUSTOM_RIGGED_PET_GLB_V1 resolves to the approved Tripo adapter", () => {
    const registry = new SkuRegistry();
    registerDefaultSkus(registry);
    const provider = createProviderForSku(CUSTOM_RIGGED_PET_GLB_V1, { registry });
    assert.ok(
      provider instanceof TripoPetGenerationAdapter,
      "the paid SKU must resolve to the approved Tripo adapter under Path 1",
    );
  });

  // ── 4 ────────────────────────────────────────────────────────────────────
  await t.test("swapping the registry binding swaps the provider, no other change", () => {
    const registry = new SkuRegistry();
    registry.register(CUSTOM_RIGGED_PET_GLB_V1, {
      providerId: "not-implemented",
      providerVersion: "9",
    });
    assert.throws(
      () => createProviderForSku(CUSTOM_RIGGED_PET_GLB_V1, { registry }),
      (err) => err instanceof PetGenerationError && err.code === "UNSUPPORTED_PROVIDER",
      "binding is the only thing that decides the provider",
    );
  });

  // ── 5 ────────────────────────────────────────────────────────────────────
  await t.test("full downstream path runs against the URL-free stub", async () => {
    const stub = new StubPetGenerationProvider();
    const job = await stub.createJob(REFS);
    assert.ok(job.id, "job id issued");

    const polled = await stub.getJob(job.id);
    assert.strictEqual(polled.status, "completed");

    const artifacts = await stub.fetchArtifacts(job.id);
    assert.ok(Buffer.isBuffer(artifacts.glb.data), "artifacts carry bytes");
    assert.strictEqual(artifacts.glb.size, artifacts.glb.data.length);
    assert.match(artifacts.glb.sha256, /^[0-9a-f]{64}$/, "sha256 recorded");
    assert.ok(artifacts.glb.size > 0, "fixture GLB is non-empty");
  });

  // ── 6 ────────────────────────────────────────────────────────────────────
  await t.test("GenerationArtifacts exposes no URL, at any depth, from either provider", async () => {
    const stub = new StubPetGenerationProvider();
    const stubJob = await stub.createJob(REFS);
    assertNoUrlAnywhere(await stub.fetchArtifacts(stubJob.id), "stub.artifacts");
    assertNoUrlAnywhere(await stub.getJob(stubJob.id), "stub.job");

    // The real adapter wraps a provider whose poll() DOES return a Tripo URL.
    // That URL must be absorbed, never surfaced.
    const fake = makeFakeModelBuildProvider();
    const adapter = new TripoPetGenerationAdapter(fake, new InMemoryJobStore(), "v2.5");

    const job = await adapter.createJob(REFS);
    assertNoUrlAnywhere(job, "adapter.createJob");

    const polled = await adapter.getJob(job.id);
    assertNoUrlAnywhere(polled, "adapter.getJob");

    const artifacts = await adapter.fetchArtifacts(job.id);
    assertNoUrlAnywhere(artifacts, "adapter.fetchArtifacts");

    assert.ok(fake.calls.download > 0, "the URL was consumed inside the adapter");
    assert.ok(Buffer.isBuffer(artifacts.glb.data), "bytes crossed the boundary, not a URL");
    assert.ok(
      !("providerTaskHandle" in artifacts.metadata),
      "the provider task handle must not surface either",
    );
  });

  // ── 7 ────────────────────────────────────────────────────────────────────
  await t.test("cancelJob tombstones: record survives, late results discarded", async () => {
    const fake = makeFakeModelBuildProvider();
    const adapter = new TripoPetGenerationAdapter(fake, new InMemoryJobStore(), "v2.5");

    const job = await adapter.createJob(REFS);
    await adapter.cancelJob(job.id);

    const after = await adapter.getJob(job.id);
    assert.strictEqual(after.status, "cancelled", "must report cancelled, not failed");
    assert.strictEqual(after.id, job.id, "record survives — not 'not found'");

    const pollsBefore = fake.calls.poll;
    await adapter.getJob(job.id);
    assert.strictEqual(fake.calls.poll, pollsBefore, "a cancelled job is never re-polled");

    await assert.rejects(
      () => adapter.fetchArtifacts(job.id),
      (err) => err instanceof PetGenerationError && err.code === "JOB_CANCELLED",
      "late results are discarded",
    );

    // Stub honours the same contract.
    const stub = new StubPetGenerationProvider();
    const sJob = await stub.createJob(REFS);
    await stub.cancelJob(sJob.id);
    assert.strictEqual((await stub.getJob(sJob.id)).status, "cancelled");
    await assert.rejects(
      () => stub.fetchArtifacts(sJob.id),
      (err) => err.code === "JOB_CANCELLED",
    );
  });

  // ── 8 ────────────────────────────────────────────────────────────────────
  await t.test("feature flag defaults closed", () => {
    const registry = new SkuRegistry();
    registerDefaultSkus(registry);
    const prior = process.env.PET_GLB_ENABLED;
    delete process.env.PET_GLB_ENABLED;
    try {
      assert.throws(
        () => createProviderForSku(CUSTOM_RIGGED_PET_GLB_V1, { registry }),
        (err) => err.name === "PetGlbFeatureError",
        "PET_GLB_ENABLED must default off",
      );
    } finally {
      process.env.PET_GLB_ENABLED = prior;
    }
  });

  resetProviderFactoryForTests();
});
