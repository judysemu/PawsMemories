import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";

process.env.TRIPO_API_KEY = "test-key";
const { startRig, startRetarget, pollTripoTask, selectTripoGlbUrl, isTripoInsufficientCredit, TripoError } = await import("../tripo.ts");

let captured;
const realFetch = global.fetch;

beforeEach(() => {
  captured = null;
});
afterEach(() => {
  global.fetch = realFetch;
});

function mockTask(taskId = "rig123") {
  global.fetch = async (url, opts) => {
    captured = { url: String(url), body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ data: { task_id: taskId } }) };
  };
}

test("startRig posts the confirmed animate_rig body and strips tripo: prefix", async () => {
  mockTask();
  const handle = await startRig("tripo:genABC");
  assert.equal(handle, "tripo:rig123");
  assert.match(captured.url, /\/task$/);
  assert.equal(captured.body.type, "animate_rig");
  assert.equal(captured.body.original_model_task_id, "genABC"); // prefix stripped
  assert.equal(captured.body.out_format, "glb");
  assert.equal(captured.body.spec, "tripo");
  assert.ok(captured.body.model_version, "sends a model_version");
});

test("startRig accepts a raw task id (no prefix)", async () => {
  mockTask();
  await startRig("genXYZ");
  assert.equal(captured.body.original_model_task_id, "genXYZ");
});

test("startRetarget requests a preset animation via animate_retarget", async () => {
  mockTask("rt1");
  const handle = await startRetarget("tripo:genABC", "preset:walk");
  assert.equal(handle, "tripo:rt1");
  assert.equal(captured.body.type, "animate_retarget");
  assert.equal(captured.body.animation, "preset:walk");
});

test("pollTripoTask returns glbUrl on success", async () => {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { status: "success", output: { model: "https://cdn/rigged.glb" } } }),
  });
  const r = await pollTripoTask("tripo:rig123");
  assert.equal(r.done, true);
  assert.equal(r.glbUrl, "https://cdn/rigged.glb");
});

test("texture-bearing PBR output wins over an untextured generic model URL", () => {
  assert.equal(selectTripoGlbUrl({
    model: "https://cdn/base.glb",
    pbr_model: "https://cdn/textured-pbr.glb",
    base_model: "https://cdn/textured-base.glb",
  }), "https://cdn/textured-pbr.glb");
});

test("pollTripoTask reports failure status", async () => {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { status: "failed" } }),
  });
  const r = await pollTripoTask("tripo:rig123");
  assert.equal(r.done, true);
  assert.ok(r.error);
});

test("isTripoInsufficientCredit detects Tripo 403 / 2010 error", () => {
  const creditErr = new TripoError(403, 2010, "insufficient balance", "Tripo task failed (403): insufficient balance");
  assert.equal(isTripoInsufficientCredit(creditErr), true);

  const genericErr = new Error("Some other error message");
  assert.equal(isTripoInsufficientCredit(genericErr), false);

  const fallbackErr = new Error("You don't have enough credit...");
  assert.equal(isTripoInsufficientCredit(fallbackErr), true);
});
