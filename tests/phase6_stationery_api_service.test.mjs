import test from "node:test";
import assert from "node:assert/strict";

import {
  CreateRenderJobRequestSchema,
  PrintOrderPublicSchema,
} from "../server/stationery-v2/apiContracts.ts";
import { sha256Canonical } from "../server/stationery-v2/canonical.ts";
import { createProviderSubmission } from "../server/stationery-v2/fulfillment.ts";
import { hashTemplateSpec, sealRenderManifest } from "../server/stationery-v2/manifests.ts";
import { StationeryV2Service } from "../server/stationery-v2/service.ts";

const OWNER = "u_phase6_owner";
const TEMPLATE_UUID = "11111111-1111-4111-8111-111111111111";
const BACKGROUND_UUID = "22222222-2222-4222-8222-222222222222";
const IMAGE_UUID = "33333333-3333-4333-8333-333333333333";
const OUTPUT_UUID = "44444444-4444-4444-8444-444444444444";
const PAYMENT_UUID = "55555555-5555-4555-8555-555555555555";
const HASHES = {
  background: "a".repeat(64),
  image: "b".repeat(64),
  output: "c".repeat(64),
  payment: "d".repeat(64),
};
const RECIPIENT = {
  name: "Test Customer",
  email: "customer@example.com",
  address1: "1 Test Street",
  city: "Denver",
  stateCode: "CO",
  countryCode: "US",
  postalCode: "80202",
};

function templateSpec() {
  return {
    schemaVersion: "stationery.template.v1",
    templateUuid: TEMPLATE_UUID,
    versionNumber: 1,
    topic: "Birthday",
    event: "Party",
    locale: "en-US",
    orientation: "portrait",
    trimIn: { width: 5, height: 7 },
    bleedIn: { top: 0.125, right: 0.125, bottom: 0.125, left: 0.125 },
    safeAreaIn: { top: 0.25, right: 0.25, bottom: 0.25, left: 0.25 },
    backgroundAsset: { assetUuid: BACKGROUND_UUID, versionNumber: 1, sha256: HASHES.background },
    backgroundCoverageIn: { x: -0.125, y: -0.125, width: 5.25, height: 7.25 },
    fontLicenses: [{ family: "Source Serif", licenseId: "OFL-1.1", commercialUse: true, embeddingAllowed: true }],
    slots: [
      { slotId: "message", kind: "text", boundsIn: { x: 0.5, y: 0.5, width: 4, height: 1 }, required: true, fontFamily: "Source Serif", minFontSizePt: 12, maxLines: 2 },
      { slotId: "portrait", kind: "image", boundsIn: { x: 0.5, y: 2, width: 4, height: 4 }, required: true, allowBleed: false },
    ],
    presets: [{
      presetId: "print-300",
      purpose: "print",
      format: "pdf",
      widthPx: 1575,
      heightPx: 2175,
      targetDpi: 300,
      includeBleed: true,
      minimumBleedIn: 0.125,
      colorProfile: "sRGB IEC61966-2.1",
    }],
    accessibilityLabel: "Birthday card with pet portrait",
  };
}

function renderRequest(idempotencyKey = "render-request-001") {
  return {
    templateUuid: TEMPLATE_UUID,
    templateVersionNumber: 1,
    presetId: "print-300",
    idempotencyKey,
    slotInputs: [
      {
        slotId: "message",
        kind: "text",
        content: "Happy birthday",
        measurement: {
          slotId: "message",
          content: "Happy birthday",
          measuredWidthPx: 400,
          measuredHeightPx: 100,
          boxWidthPx: 1200,
          boxHeightPx: 300,
          lineCount: 1,
          maxLines: 2,
          clippedGlyphCount: 0,
          measurementEngine: "fixture",
          measurementEngineVersion: "1.0.0",
        },
      },
      {
        slotId: "portrait",
        kind: "image",
        source: { assetUuid: IMAGE_UUID, versionNumber: 1, sha256: HASHES.image },
        cropMode: "cover",
      },
    ],
  };
}

class MemoryRepository {
  constructor(template) {
    this.template = { spec: template, specHash: hashTemplateSpec(template), status: "active" };
    this.assets = new Map([
      [`${BACKGROUND_UUID}:1`, { assetUuid: BACKGROUND_UUID, versionNumber: 1, sha256: HASHES.background, ownerId: "system", status: "active", commercialUseEligible: true }],
      [`${IMAGE_UUID}:1`, { assetUuid: IMAGE_UUID, versionNumber: 1, sha256: HASHES.image, ownerId: OWNER, status: "active", commercialUseEligible: true }],
      [`${OUTPUT_UUID}:1`, { assetUuid: OUTPUT_UUID, versionNumber: 1, sha256: HASHES.output, ownerId: OWNER, status: "active", commercialUseEligible: true }],
    ]);
    this.jobs = new Map();
    this.renderKeys = new Map();
    this.orders = new Map();
    this.orderKeys = new Map();
    this.submissions = new Map();
    this.claims = new Map();
    this.events = [];
    this.reconciliations = [];
    this.inTransaction = false;
  }

  async getTemplateVersion(uuid, version) {
    return uuid === TEMPLATE_UUID && version === 1 ? this.template : null;
  }

  async getAssetEvidence(uuid, version) {
    return this.assets.get(`${uuid}:${version}`) ?? null;
  }

  async createRenderJobIdempotent(input) {
    this.inTransaction = true;
    try {
      const existingUuid = this.renderKeys.get(`${input.ownerId}:${input.idempotencyKey}`);
      if (existingUuid) return { job: this.jobs.get(existingUuid), created: false };
      const job = {
        jobUuid: input.jobUuid,
        templateUuid: input.template.spec.templateUuid,
        templateVersionNumber: input.template.spec.versionNumber,
        presetId: input.request.presetId,
        state: "queued",
        requestHash: input.requestHash,
        validationReport: input.validationReport,
        renderManifest: null,
        output: null,
        failureCode: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        ownerId: input.ownerId,
        request: input.request,
        templateSpecHash: input.template.specHash,
      };
      this.jobs.set(job.jobUuid, job);
      this.renderKeys.set(`${input.ownerId}:${input.idempotencyKey}`, job.jobUuid);
      return { job, created: true };
    } finally {
      this.inTransaction = false;
    }
  }

  async getRenderJob(ownerId, uuid) {
    const job = this.jobs.get(uuid);
    return job?.ownerId === ownerId ? job : null;
  }

  async getRenderJobByIdempotency(ownerId, key) {
    const uuid = this.renderKeys.get(`${ownerId}:${key}`);
    return uuid ? this.jobs.get(uuid) : null;
  }

  async getRenderJobForCompletion(uuid) {
    return this.jobs.get(uuid) ?? null;
  }

  async recordRenderDispatchFailure(uuid, code, at) {
    const job = this.jobs.get(uuid);
    Object.assign(job, { state: "dispatch_failed", failureCode: code, updatedAt: at });
  }

  async recordRenderDispatched(uuid, at) {
    const job = this.jobs.get(uuid);
    Object.assign(job, { state: "rendering", failureCode: null, updatedAt: at });
  }

  async completeRenderJobImmutable(input) {
    const job = this.jobs.get(input.jobUuid);
    if (job.state === "ready" && job.renderManifest.manifestHash !== input.renderManifest.manifestHash) throw new Error("immutable");
    Object.assign(job, {
      state: "ready",
      renderManifest: input.renderManifest,
      output: input.renderManifest.output,
      validationReport: input.validationReport,
      failureCode: null,
      updatedAt: input.updatedAt,
    });
    return job;
  }

  async createFrozenPrintOrderIdempotent(input) {
    this.inTransaction = true;
    try {
      const key = `${input.ownerId}:${input.clientIdempotencyKey}`;
      const existingUuid = this.orderKeys.get(key);
      if (existingUuid) return { order: this.orders.get(existingUuid), created: false };
      const snapshot = createProviderSubmission({
        localOrderUuid: input.localOrderUuid,
        provider: input.manifest.provider,
        printManifestHash: input.manifest.manifestHash,
        paymentState: "paid",
        createdAt: input.createdAt,
      });
      const { ownerId: _ownerId, ...publicPayment } = input.paymentEvidence;
      const order = PrintOrderPublicSchema.parse({
        localOrderUuid: input.localOrderUuid,
        renderJobUuid: input.renderJobUuid,
        provider: input.manifest.provider,
        state: snapshot.state,
        providerOrderId: null,
        providerIdempotencyKey: snapshot.idempotencyKey,
        printManifest: input.manifest,
        paymentEvidence: publicPayment,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      });
      this.orders.set(order.localOrderUuid, order);
      this.orderKeys.set(key, order.localOrderUuid);
      this.submissions.set(order.localOrderUuid, snapshot);
      return { order, created: true };
    } finally {
      this.inTransaction = false;
    }
  }

  async getPrintOrder(ownerId, uuid) {
    const order = this.orders.get(uuid);
    return order && ownerId === OWNER ? order : null;
  }

  async getPrintOrderByIdempotency(ownerId, key) {
    const uuid = this.orderKeys.get(`${ownerId}:${key}`);
    return uuid ? this.orders.get(uuid) : null;
  }

  async getPrintOrderByUuid(uuid) {
    const order = this.orders.get(uuid);
    return order ? { ...order, ownerId: OWNER } : null;
  }

  async getByLocalOrderUuid(uuid) {
    return this.submissions.get(uuid) ?? null;
  }

  async withOrderLock(uuid, work) {
    assert.equal(this.inTransaction, false);
    this.inTransaction = true;
    try {
      const locked = {
        claimProviderEventId: async (provider, eventId, localOrderUuid) => {
          const key = `${provider}:${eventId}`;
          if (this.claims.has(key)) return this.claims.get(key) === localOrderUuid ? "existing" : "conflict";
          this.claims.set(key, localOrderUuid);
          return "inserted";
        },
        recordProviderEventEvidence: async (event) => { this.events.push(event); },
        insertIfAbsent: async (snapshot) => {
          if (this.submissions.has(uuid)) return "existing";
          this.submissions.set(uuid, snapshot);
          return "inserted";
        },
        getForUpdate: async () => this.submissions.get(uuid) ?? null,
        saveTransition: async (expectedUpdatedAt, snapshot) => {
          const current = this.submissions.get(uuid);
          if (!current || current.updatedAt !== expectedUpdatedAt) return "conflict";
          this.submissions.set(uuid, snapshot);
          const order = this.orders.get(uuid);
          this.orders.set(uuid, {
            ...order,
            state: snapshot.state,
            providerOrderId: snapshot.providerOrderId,
            providerIdempotencyKey: snapshot.idempotencyKey,
            updatedAt: snapshot.updatedAt,
          });
          return "saved";
        },
      };
      return await work(locked);
    } finally {
      this.inTransaction = false;
    }
  }

  async recordReconciliation(input) {
    this.reconciliations.push(input);
  }
}

function fixture(options = {}) {
  process.env.STATIONERY_V2_ENABLED = "true";
  const repository = new MemoryRepository(templateSpec());
  let tick = Date.parse("2026-07-22T12:00:00.000Z");
  const dispatched = [];
  const submissions = [];
  const provider = {
    provider: "printful",
    async submitFrozenManifest(input) {
      assert.equal(repository.inTransaction, false, "provider submission must run outside the order transaction");
      submissions.push(input);
      return { providerOrderId: "PF-100", state: "processing" };
    },
    async observe() {
      assert.equal(repository.inTransaction, false, "provider observation must run outside the order transaction");
      return { availability: "found", checkedAt: new Date(tick).toISOString(), providerOrderId: "PF-100", state: "fulfilled" };
    },
    async requestRefund() { throw new Error("not used"); },
  };
  const service = new StationeryV2Service({
    repository,
    renderDispatcher: {
      async dispatch(input) {
        assert.equal(repository.inTransaction, false, "render dispatch must run outside the job transaction");
        dispatched.push(input);
        if (options.dispatchFails) throw new Error("renderer unavailable");
      },
    },
    paymentEvidence: {
      async getPaymentEvidence(ownerId, paymentUuid) {
        if (ownerId !== OWNER || paymentUuid !== PAYMENT_UUID) return null;
        return {
          paymentUuid: PAYMENT_UUID,
          ownerId: OWNER,
          state: options.paymentState ?? "paid",
          amountMinor: 2500,
          currency: "USD",
          confirmedAt: (options.paymentState ?? "paid") === "paid" ? "2026-07-22T11:59:00.000Z" : null,
          evidenceHash: HASHES.payment,
        };
      },
    },
    frozenFileAccess: {
      async createProviderReadUrl() {
        assert.equal(repository.inTransaction, false);
        return "https://private-assets.example.test/signed/file.pdf";
      },
    },
    providers: { printful: provider },
    clock: { now: () => new Date(tick += 1000).toISOString() },
  });
  return { service, repository, dispatched, submissions };
}

async function readyRender(f) {
  const created = await f.service.createRenderJob(OWNER, renderRequest());
  const report = created.validationReport;
  const manifest = sealRenderManifest({
    schemaVersion: "stationery.render-manifest.v1",
    templateUuid: TEMPLATE_UUID,
    templateVersionNumber: 1,
    templateSpecHash: hashTemplateSpec(templateSpec()),
    presetId: "print-300",
    output: { assetUuid: OUTPUT_UUID, versionNumber: 1, sha256: HASHES.output },
    format: "pdf",
    widthPx: 1575,
    heightPx: 2175,
    dpi: 300,
    colorProfile: "sRGB IEC61966-2.1",
    renderer: { name: "fixture-renderer", version: "1.0.0" },
    sourceVersions: [
      { assetUuid: BACKGROUND_UUID, versionNumber: 1, sha256: HASHES.background },
      { assetUuid: IMAGE_UUID, versionNumber: 1, sha256: HASHES.image },
    ],
    fontFileHashes: [],
    validationReportHash: sha256Canonical(report),
    frozenAt: "2026-07-22T12:01:00.000Z",
  });
  return f.service.completeRenderJob(created.jobUuid, { renderManifest: manifest, validationReport: report });
}

test("Phase 6 API schemas reject unbound text measurements and unknown keys", () => {
  assert.throws(() => CreateRenderJobRequestSchema.parse({ ...renderRequest(), internalId: 7 }));
  const mismatched = structuredClone(renderRequest());
  mismatched.slotInputs[0].measurement.content = "different";
  assert.throws(() => CreateRenderJobRequestSchema.parse(mismatched));
});

test("Phase 6 render creation is idempotent and dispatches after persistence", async () => {
  const f = fixture();
  const first = await f.service.createRenderJob(OWNER, renderRequest());
  f.repository.template.status = "retired";
  const replay = await f.service.createRenderJob(OWNER, renderRequest());
  assert.equal(replay.jobUuid, first.jobUuid);
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0].ownerId, OWNER);
  assert.equal(typeof f.dispatched[0].sourceUrls[BACKGROUND_UUID], "string");

  const conflict = renderRequest();
  conflict.slotInputs[0].content = "Different request";
  conflict.slotInputs[0].measurement.content = "Different request";
  await assert.rejects(() => f.service.createRenderJob(OWNER, conflict), (error) => error.code === "IDEMPOTENCY_CONFLICT");
});

test("Phase 6 render dispatch failure remains durable for outbox retry", async () => {
  const f = fixture({ dispatchFails: true });
  const job = await f.service.createRenderJob(OWNER, renderRequest("render-dispatch-failure"));
  assert.equal(job.state, "dispatch_failed");
  assert.equal(job.failureCode, "RENDER_DISPATCH_FAILED");
  assert.equal(f.dispatched.length, 1);
});

test("Phase 6 completion binds immutable worker evidence and freezes paid print evidence", async () => {
  const f = fixture();
  const ready = await readyRender(f);
  assert.equal(ready.state, "ready");

  const order = await f.service.createPrintOrder(OWNER, {
    renderJobUuid: ready.jobUuid,
    provider: "printful",
    providerSku: "CARD-5X7",
    placement: "front",
    quantity: 25,
    recipient: RECIPIENT,
    paidPaymentUuid: PAYMENT_UUID,
    idempotencyKey: "print-request-001",
  });
  assert.equal(order.printManifest.frozenFile.sha256, HASHES.output);
  assert.equal(order.paymentEvidence.state, "paid");
  assert.equal("ownerId" in order.paymentEvidence, false);
  assert.equal("id" in order, false);
  assert.equal("objectKey" in order, false);

  f.repository.assets.delete(`${OUTPUT_UUID}:1`);
  const replay = await f.service.createPrintOrder(OWNER, {
    renderJobUuid: ready.jobUuid,
    provider: "printful",
    providerSku: "CARD-5X7",
    placement: "front",
    quantity: 25,
    recipient: RECIPIENT,
    paidPaymentUuid: PAYMENT_UUID,
    idempotencyKey: "print-request-001",
  });
  assert.equal(replay.localOrderUuid, order.localOrderUuid);
});

test("Phase 6 provider submission is payment-gated, outside transactions, and replay-safe", async () => {
  const f = fixture();
  const ready = await readyRender(f);
  const order = await f.service.createPrintOrder(OWNER, {
    renderJobUuid: ready.jobUuid,
    provider: "printful",
    providerSku: "CARD-5X7",
    placement: "front",
    quantity: 10,
    recipient: RECIPIENT,
    paidPaymentUuid: PAYMENT_UUID,
    idempotencyKey: "print-request-002",
  });
  await assert.rejects(
    () => f.service.submitPrintOrder(OWNER, order.localOrderUuid, { providerIdempotencyKey: `fulfillment-v1-${"0".repeat(64)}` }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );

  const submitted = await f.service.submitPrintOrder(OWNER, order.localOrderUuid, { providerIdempotencyKey: order.providerIdempotencyKey });
  assert.equal(submitted.state, "processing");
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].idempotencyKey, order.providerIdempotencyKey);

  const replay = await f.service.submitPrintOrder(OWNER, order.localOrderUuid, { providerIdempotencyKey: order.providerIdempotencyKey });
  assert.equal(replay.state, "processing");
  assert.equal(f.submissions.length, 1);

  const event = {
    localOrderUuid: order.localOrderUuid,
    event: { eventId: "printful-fulfilled-1", occurredAt: "2026-07-22T13:00:00.000Z", type: "provider_fulfilled", providerOrderId: "PF-100" },
  };
  const applied = await f.service.applyAuthenticatedProviderEvent("printful", event);
  const duplicate = await f.service.applyAuthenticatedProviderEvent("printful", event);
  assert.equal(applied.order.state, "fulfilled");
  assert.equal(duplicate.disposition, "duplicate");
  assert.equal(f.repository.events.filter((entry) => entry.event.eventId === "printful-fulfilled-1").length, 1);

  const secondOrder = await f.service.createPrintOrder(OWNER, {
    renderJobUuid: ready.jobUuid,
    provider: "printful",
    providerSku: "CARD-5X7",
    placement: "front",
    quantity: 1,
    recipient: RECIPIENT,
    paidPaymentUuid: PAYMENT_UUID,
    idempotencyKey: "print-request-replay-conflict",
  });
  await assert.rejects(
    () => f.service.applyAuthenticatedProviderEvent("printful", { ...event, localOrderUuid: secondOrder.localOrderUuid }),
    (error) => error.code === "PROVIDER_EVENT_CONFLICT",
  );
});

test("Phase 6 refuses to freeze print work without confirmed payment evidence", async () => {
  const f = fixture({ paymentState: "pending" });
  const ready = await readyRender(f);
  await assert.rejects(
    () => f.service.createPrintOrder(OWNER, {
      renderJobUuid: ready.jobUuid,
      provider: "printful",
      providerSku: "CARD-5X7",
      placement: "front",
      quantity: 10,
      recipient: RECIPIENT,
      paidPaymentUuid: PAYMENT_UUID,
      idempotencyKey: "print-request-unpaid",
    }),
    (error) => error.code === "PAYMENT_REQUIRED",
  );
  assert.equal(f.repository.orders.size, 0);
});

test("Phase 6 reconciliation adopts provider evidence without making claims before observation", async () => {
  const f = fixture();
  const ready = await readyRender(f);
  const order = await f.service.createPrintOrder(OWNER, {
    renderJobUuid: ready.jobUuid,
    provider: "printful",
    providerSku: "CARD-5X7",
    placement: "front",
    quantity: 10,
    recipient: RECIPIENT,
    paidPaymentUuid: PAYMENT_UUID,
    idempotencyKey: "print-request-003",
  });
  const submitted = await f.service.submitPrintOrder(OWNER, order.localOrderUuid, { providerIdempotencyKey: order.providerIdempotencyKey });
  assert.equal(submitted.state, "processing");
  const reconciled = await f.service.reconcilePrintOrder(OWNER, order.localOrderUuid, "repair missed webhook");
  assert.equal(reconciled.decision.action, "adopt_provider_state");
  assert.equal(reconciled.order.state, "fulfilled");
  assert.equal(f.repository.reconciliations.length, 1);
  assert.equal(f.repository.reconciliations[0].observation.state, "fulfilled");
});

test("Phase 6 remains fail-closed unless explicitly enabled", async () => {
  const f = fixture();
  delete process.env.STATIONERY_V2_ENABLED;
  await assert.rejects(() => f.service.createRenderJob(OWNER, renderRequest()), (error) => error.code === "FEATURE_DISABLED");
});
