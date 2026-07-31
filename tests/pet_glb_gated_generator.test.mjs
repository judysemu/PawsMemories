import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

process.env.PET_GLB_ENABLED = "true";

const {
  CreatePetGlbOrderSchema,
  FACIAL_RIG_POLICY,
  meshProfilePolicy,
  rigGenerationAvailability,
  rigTypeForSubject,
  stagePrice,
} = await import("../server/pet-generation/contracts.ts");
const { TripoPetGenerationAdapter } = await import("../server/pet-generation/tripoAdapter.ts");
const { InMemoryJobStore } = await import("../server/pet-generation/provider.ts");
const { validatePetGlbStage } = await import("../server/pet-generation/validation.ts");
const { PetGlbStageRepository } = await import("../server/pet-generation/stageRepository.ts");
const { PET_GLB_STAGE_PRICES, petGlbTotalCost } = await import("../src/pricing.ts");
const { MIGRATIONS, CURRENT_SCHEMA_VERSION } = await import("../server/migrations/runner.ts");

const REFS = {
  frontUrl: "https://example.test/front.png",
  leftUrl: "https://example.test/left.png",
  rightUrl: "https://example.test/right.png",
  rearUrl: "https://example.test/rear.png",
  threeQuarterUrl: "https://example.test/three-quarter.png",
};

function jsonOnlyGlb(json) {
  const jsonBytes = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, ...json }));
  const padding = (4 - (jsonBytes.length % 4)) % 4;
  const chunk = Buffer.concat([jsonBytes, Buffer.alloc(padding, 0x20)]);
  const out = Buffer.alloc(12 + 8 + chunk.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(chunk.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  chunk.copy(out, 20);
  return out;
}

function modelGlb({ triangles = 12, texture = false, rig = false } = {}) {
  const primitive = {
    attributes: {
      POSITION: 0,
      ...(rig ? { JOINTS_0: 1, WEIGHTS_0: 2 } : {}),
    },
    indices: 3,
    ...(texture ? { material: 0 } : {}),
  };
  return jsonOnlyGlb({
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { mesh: 0, ...(rig ? { skin: 0 } : {}) },
      ...(rig ? [{ name: "root" }, { name: "spine" }] : []),
    ],
    meshes: [{ primitives: [primitive] }],
    accessors: [
      { count: triangles * 3, type: "VEC3", componentType: 5126 },
      { count: triangles * 3, type: "VEC4", componentType: 5123 },
      { count: triangles * 3, type: "VEC4", componentType: 5126 },
      { count: triangles * 3, type: "SCALAR", componentType: 5125 },
    ],
    ...(texture ? {
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ uri: "data:image/png;base64,AA==" }],
    } : {}),
    ...(rig ? { skins: [{ joints: [1, 2] }] } : {}),
  });
}

test("gated product contracts reject facial rigging but allow a body rig without texture", () => {
  assert.equal(CreatePetGlbOrderSchema.safeParse({
    meshProfile: "hd",
    subjectProfile: "pet",
    includeTexture: true,
    includeRig: true,
    textureQuality: "standard",
    facialRig: true,
  }).success, false);

  assert.equal(CreatePetGlbOrderSchema.safeParse({
    meshProfile: "hd",
    subjectProfile: "pet",
    includeTexture: false,
    includeRig: true,
    textureQuality: "standard",
    facialRig: false,
  }).success, true);

  assert.equal(FACIAL_RIG_POLICY.available, false);
  assert.equal(FACIAL_RIG_POLICY.minimumSuccessRate, 0.75);
});

test("prices are separated by stage and total is deterministic", () => {
  assert.equal(stagePrice("base"), PET_GLB_STAGE_PRICES.BASE);
  assert.equal(stagePrice("texture"), PET_GLB_STAGE_PRICES.TEXTURE);
  assert.equal(stagePrice("rig"), PET_GLB_STAGE_PRICES.RIG);
  assert.equal(stagePrice("reference"), 0);
  assert.equal(stagePrice("rig_check"), 0);
  assert.equal(
    petGlbTotalCost({ texture: true, rig: true }),
    PET_GLB_STAGE_PRICES.BASE + PET_GLB_STAGE_PRICES.TEXTURE + PET_GLB_STAGE_PRICES.RIG,
  );
  assert.equal(
    petGlbTotalCost({ texture: false, rig: true }),
    PET_GLB_STAGE_PRICES.BASE + PET_GLB_STAGE_PRICES.RIG,
  );
  assert.equal(petGlbTotalCost({ texture: false, rig: true }), 80);
});

test("SmartMesh and HD produce different real provider geometry contracts", async () => {
  const calls = [];
  const fake = {
    async start(input) {
      calls.push(input);
      return {
        providerTaskHandle: `tripo:base${calls.length}`,
        provider: "tripo",
        model: input.geometry.modelVersion,
      };
    },
    async poll() { return { done: false, progress: 1 }; },
    async download() { throw new Error("not used"); },
  };
  const adapter = new TripoPetGenerationAdapter(fake, new InMemoryJobStore(), "test", { animate: false });

  await adapter.createBaseJob({ ...REFS, meshProfile: "hd", subjectProfile: "pet" });
  await adapter.createBaseJob({ ...REFS, meshProfile: "smart_mesh", subjectProfile: "pet" });

  assert.equal(calls[0].geometry.texture, false);
  assert.equal(calls[0].geometry.pbr, false);
  assert.equal(calls[0].geometry.modelVersion, "v3.1-20260211");
  assert.equal(calls[0].geometry.faceLimit, 100_000);
  assert.equal(calls[1].geometry.modelVersion, "P1-20260311");
  assert.equal(calls[1].geometry.faceLimit, 8_000);
  assert.ok(calls[1].geometry.faceLimit < calls[0].geometry.faceLimit);
});

test("an untextured body rig is valid only when the order did not purchase texture", () => {
  const untexturedRig = modelGlb({ texture: false, rig: true });

  const noTextureOrder = validatePetGlbStage(untexturedRig, {
    stage: "rig",
    meshProfile: "hd",
    requireTexture: false,
  });
  assert.equal(noTextureOrder.operatorReady, true);
  assert.equal(noTextureOrder.reasonCodes.includes("TEXTURE_MISSING"), false);

  const texturedOrder = validatePetGlbStage(untexturedRig, {
    stage: "rig",
    meshProfile: "hd",
    requireTexture: true,
  });
  assert.equal(texturedOrder.operatorReady, false);
  assert.equal(texturedOrder.reasonCodes.includes("TEXTURE_MISSING"), true);
});

test("stage-aware validation accepts a blank base and adds texture/rig requirements later", () => {
  const base = modelGlb({ triangles: 8000 });
  const baseReport = validatePetGlbStage(base, { stage: "base", meshProfile: "smart_mesh" });
  assert.equal(baseReport.operatorReady, true);
  assert.equal(baseReport.triangleCount, 8000);
  assert.equal(baseReport.checks.some((check) => check.id === "texture_present"), false);

  const textureFailure = validatePetGlbStage(base, { stage: "texture", meshProfile: "smart_mesh" });
  assert.equal(textureFailure.operatorReady, false);
  assert.equal(textureFailure.checks.find((check) => check.id === "texture_present").passed, false);

  const textured = modelGlb({ triangles: 8000, texture: true });
  assert.equal(
    validatePetGlbStage(textured, { stage: "texture", meshProfile: "smart_mesh" }).operatorReady,
    true,
  );

  const rigged = modelGlb({ triangles: 8000, texture: true, rig: true });
  const rigReport = validatePetGlbStage(rigged, { stage: "rig", meshProfile: "smart_mesh" });
  assert.equal(rigReport.operatorReady, true);
  assert.equal(rigReport.checks.find((check) => check.id === "skin_weights_present").passed, true);
});

test("SmartMesh over-budget output is blocked by measured triangles", () => {
  const report = validatePetGlbStage(
    modelGlb({ triangles: meshProfilePolicy("smart_mesh").maxTriangles + 1 }),
    { stage: "base", meshProfile: "smart_mesh" },
  );
  assert.equal(report.operatorReady, false);
  assert.equal(report.checks.find((check) => check.id === "triangle_budget").passed, false);
  assert.ok(report.reasonCodes.includes("TRIANGLE_BUDGET_EXCEEDED"));
});

test("humanoid selection maps to a biped rig type without claiming embedded AI", () => {
  assert.equal(rigTypeForSubject("humanoid"), "biped");
  assert.equal(rigTypeForSubject("pet"), "quadruped");
  const studio = fs.readFileSync("src/components/PetModelStudio.tsx", "utf8");
  assert.match(studio, /AI behavior is not embedded in the GLB/);
  assert.doesNotMatch(studio, /Do it for me/);
  assert.doesNotMatch(studio, /facialRig:\s*true/);
});

test("model studio requires four source photos and generates approval views", () => {
  const studio = fs.readFileSync("src/components/PetModelStudio.tsx", "utf8");
  const routes = fs.readFileSync("server/pet-generation/routes.ts", "utf8");
  assert.match(studio, /createReferenceSession/);
  assert.match(studio, /startReferenceAttempt/);
  assert.match(studio, /Four angles required/);
  assert.doesNotMatch(studio, /Auto-approve the generated 360° views/);
  assert.doesNotMatch(studio, /REFERENCE_FIELDS\.every/);
  assert.match(routes, /requiredSourceUploads:\s*4/);
  assert.match(routes, /generatedForApproval:\s*\["front", "left", "right", "rear", "three_quarter"\]/);
});

test("migration 39 persists immutable customer stage attempts", () => {
  const migration = MIGRATIONS.find((entry) => entry.version === 39);
  assert.ok(migration);
  assert.equal(CURRENT_SCHEMA_VERSION, 45);
  const sql = migration.statements.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS pet_glb_stage_attempts/);
  assert.match(sql, /artifact_sha256 CHAR\(64\)/);
  assert.match(sql, /validation_report_sha256 CHAR\(64\)/);
  assert.match(sql, /uniq_pet_glb_stage_charge_key/);
  assert.match(sql, /final_customer_version_id/);
  assert.match(sql, /fk_pet_glb_stage_asset_version/);
  assert.match(sql, /fk_pet_glb_order_current_stage/);
  assert.match(sql, /fk_pet_glb_order_final_customer_version/);
});

test("migration 45 adds redacted, idempotent recovery evidence", () => {
  const migration = MIGRATIONS.find((entry) => entry.version === 45);
  assert.ok(migration);
  assert.equal(migration.name, "pet_glb_recovery_evidence");
  const sql = migration.statements.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS pet_glb_recovery_evidence/);
  assert.match(sql, /uniq_pet_glb_recovery_decision/);
  assert.match(fs.readFileSync("server/pet-generation/routes.ts", "utf8"), /recovery-evidence/);
});

test("stale recovery repository exposes bounded evidence and stale-current queries", () => {
  const source = fs.readFileSync("server/pet-generation/stageRepository.ts", "utf8");
  assert.match(source, /listStaleCurrentAttempts/);
  assert.match(source, /listRecoveryEvidence/);
  assert.match(source, /ON DUPLICATE KEY UPDATE/);
});

test("completed-stage persistence has a single durable poll winner", async () => {
  let state = "processing";
  const fakePool = {
    async query(sql) {
      assert.match(sql, /state = 'persisting'/);
      if (state === "processing") {
        state = "persisting";
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    },
  };
  const repository = new PetGlbStageRepository(() => fakePool);

  const [first, second] = await Promise.all([
    repository.claimCompletion(10, 20),
    repository.claimCompletion(10, 20),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
});

test("provider and persisted-artifact recovery paths are implemented, not documented placeholders", () => {
  const repository = fs.readFileSync("server/pet-generation/stageRepository.ts", "utf8");
  const service = fs.readFileSync("server/pet-generation/service.ts", "utf8");
  assert.match(repository, /markRecoveryRequired/);
  assert.match(repository, /markPersistedRecovery/);
  assert.match(repository, /recoverPersistedModelStage/);
  assert.match(service, /resumeProviderRecovery/);
  assert.match(service, /startedJobId/);
});

test("an operator can inspect and release the exact customer-approved version from the real studio", () => {
  const service = fs.readFileSync("server/pet-generation/service.ts", "utf8");
  const routes = fs.readFileSync("server/pet-generation/routes.ts", "utf8");
  const studio = fs.readFileSync("src/components/PetModelStudio.tsx", "utf8");
  assert.match(service, /operatorPreview/);
  assert.match(service, /order\.finalCustomerVersionId/);
  assert.match(routes, /operator\/orders\/:orderUuid\/preview/);
  assert.match(studio, /Operator release queue/);
  assert.match(studio, /Approve exact version & release/);
});

test("the primary signed-in Create route opens the gated studio and retires wizard sub-routes", () => {
  const source = fs.readFileSync("src/App.tsx", "utf8");
  assert.match(source, /normalized\.startsWith\("\/create\/"\)\) return Screen\.CREATE/);
  assert.match(
    source,
    /currentScreen === Screen\.CREATE[\s\S]*?isAuthed[\s\S]*?<PetModelStudio \/>[\s\S]*?: <CreateScreen/,
  );
});

test("PETSIM_RIG_GLOBAL_DAILY_CAP=0 makes rig generation unavailable before charge and provider dispatch", () => {
  const envWithCap0 = { ...process.env, PETSIM_RIG_GLOBAL_DAILY_CAP: "0" };
  const availability = rigGenerationAvailability(envWithCap0);
  assert.equal(availability.available, false);
  assert.equal(availability.requestCap, 0);
  assert.match(availability.reason, /temporarily closed/);
});
