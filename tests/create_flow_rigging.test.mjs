import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { CREDIT_PRICES, createModelCost, riggingAddonCost } from "../src/pricing.ts";

// Body rigging remains optional. Facial rigging is fail-closed until its
// measured release cohort reaches 75%.

test("pricing invariant: base + rig add-on equals the published Rigged 3D Avatar price", () => {
  assert.equal(CREDIT_PRICES.STATIC_3D_PHOTO + CREDIT_PRICES.RIG_ADDON, CREDIT_PRICES.RIGGED_3D_AVATAR);
});

test("createModelCost never charges the removed facial option", () => {
  assert.equal(createModelCost(undefined), 45);
  assert.equal(createModelCost({ enabled: false, facial: false }), 45);
  assert.equal(createModelCost({ enabled: true, facial: false }), 80);
  assert.equal(createModelCost({ enabled: true, facial: true }), 80);
  assert.equal(createModelCost({ enabled: false, facial: true }), 45);
});

test("riggingAddonCost is exactly the refundable portion on static fallback", () => {
  assert.equal(riggingAddonCost(undefined), 0);
  assert.equal(riggingAddonCost({ enabled: true, facial: false }), 35);
  assert.equal(riggingAddonCost({ enabled: true, facial: true }), 35);
});

test("customize screen offers body rigging and removes facial purchase", () => {
  const src = fs.readFileSync("src/components/create-flow/CreateCustomizeScreen.tsx", "utf8");
  assert.match(src, /Rig this model for animation/);
  assert.match(src, /CREDIT_PRICES\.RIG_ADDON/);
  assert.doesNotMatch(src, /Include facial rig/);
  assert.doesNotMatch(src, /CREDIT_PRICES\.FACIAL_RIG_ADDON/);
  assert.match(src, /facial: false/);
  assert.match(src, /at least 75% success/);
  // Selection lands in customizationState (covered by the validation MD5 hash)
  assert.match(src, /rigging\s*\n?\s*\}/);
});

test("checkout screen and approve endpoint use the same authoritative price function", () => {
  const checkout = fs.readFileSync("src/components/create-flow/CreateCheckoutScreen.tsx", "utf8");
  assert.match(checkout, /createModelCost\(state\.customizationState\?\.rigging\)/);
  const server = fs.readFileSync("server.ts", "utf8");
  assert.match(server, /const MODEL_COST = createModelCost\(session\.customization_state\?\.rigging/);
});

test("static model is stored before the rig stage in both poll paths", () => {
  const server = fs.readFileSync("server.ts", "utf8");
  const occurrences = server.split("runCreatePipelineRigStage(").length - 1;
  assert.ok(occurrences >= 3, "rig stage must be defined once and invoked from both Meshy poll branches");
  assert.match(server, /Static model is ALWAYS stored first/);
});

test("rig failure falls back to static and refunds only the add-on", () => {
  const server = fs.readFileSync("server.ts", "utf8");
  const recovery = fs.readFileSync("server/pipeline-rig-recovery.ts", "utf8");
  assert.match(server, /done_static_fallback/);
  assert.match(server, /riggingAddonCost\(pipelineRiggingSelection\(context\)\)/);
  assert.match(server, /finalizeRejected\(/);
  assert.match(recovery, /status === "done_static_fallback"/);
  assert.match(recovery, /Math\.min\(Math\.max\(0, Math\.trunc\(refundAmount\)\), context\.creditsReserved\)/);
  assert.match(recovery, /rig_refunded_at = CASE/);
});

test("provider failure without a static model refunds the full reservation idempotently", () => {
  const recovery = fs.readFileSync("server/pipeline-rig-recovery.ts", "utf8");
  assert.match(recovery, /status === "failed"[\s\S]{0,120}context\.creditsReserved/);
  assert.match(recovery, /generation_refunded_at = CASE/);
});

test("rig stage is gated by physics_validate quality checks", () => {
  const server = fs.readFileSync("server.ts", "utf8");
  assert.match(server, /executeBlenderTool\("physics_validate"/);
  assert.match(server, /profile: petAnalysis\.bodyType/);
});

test("job status enum supports the rig lifecycle", () => {
  const db = fs.readFileSync("db.ts", "utf8");
  assert.match(db, /'queued','running','rigging','validating','done','done_static_fallback','failed'/);
  assert.match(db, /rigged_model_url/);
  assert.match(db, /rig_report/);
});

test("legacy pipeline capability remains inert behind the fail-closed selection", () => {
  const orchestrator = fs.readFileSync("agent/graph/orchestrator.ts", "utf8");
  assert.match(orchestrator, /options\?: \{ facialVisemes\?: boolean \}/);
  const finalize = fs.readFileSync("agent/graph/nodes/finalize.ts", "utf8");
  assert.match(finalize, /state\.facialVisemes !== false/);
  const act = fs.readFileSync("agent/graph/nodes/act.ts", "utf8");
  assert.match(act, /state\.facialVisemes !== false/);
  const server = fs.readFileSync("server.ts", "utf8");
  assert.match(server, /facialVisemes: !!rigging\.facial/);
  const recovery = fs.readFileSync("server/pipeline-rig-recovery.ts", "utf8");
  assert.match(recovery, /return \{ enabled: selection\.enabled === true, facial: false \}/);
  // Legacy avatar path keeps visemes on by default (no options argument)
  const types = fs.readFileSync("agent/graph/nodes/types.ts", "utf8");
  assert.match(types, /options\?\.facialVisemes !== false/);
});
