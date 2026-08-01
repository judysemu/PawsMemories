import { test } from "node:test";
import assert from "node:assert";
import { NodeIO, Document } from "@gltf-transform/core";

const { TripoPetGenerationAdapter } = await import("../server/pet-generation/tripoAdapter.js");
const { InMemoryJobStore } = await import("../server/pet-generation/provider.js");

const io = new NodeIO();

async function makeRiggedGlb(clipName, bone, path) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const spine = doc.createNode("spine");
  const leg = doc.createNode("front_leg.L");
  doc.createScene().addChild(spine).addChild(leg);
  const byName = { spine, "front_leg.L": leg };
  const input = doc.createAccessor().setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buffer);
  const output = doc.createAccessor()
    .setType(path === "rotation" ? "VEC4" : "VEC3")
    .setArray(path === "rotation" ? new Float32Array([0, 0, 0, 1, 0, 0.1, 0, 0.99]) : new Float32Array([0, 0, 0, 0.1, 0, 0]))
    .setBuffer(buffer);
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
  const channel = doc.createAnimationChannel().setTargetNode(byName[bone]).setTargetPath(path).setSampler(sampler);
  doc.createAnimation(clipName).addSampler(sampler).addChannel(channel);
  return Buffer.from(await io.writeBinary(doc));
}

const REFS = { frontUrl: "f", leftUrl: "l", rightUrl: "r", rearUrl: "b", threeQuarterUrl: "q" };

function noUrlAnywhere(obj, path = "$") {
  if (obj == null) return;
  if (typeof obj === "string") {
    assert.ok(!/https?:\/\//i.test(obj), `URL leaked at ${path}: ${obj}`);
    return;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      assert.ok(!/url/i.test(k), `URL-shaped key leaked at ${path}.${k}`);
      noUrlAnywhere(v, `${path}.${k}`);
    }
  }
}

test("animated pipeline advances base→rig→idle→walk and merges idle+walk", async () => {
  const idleGlb = await makeRiggedGlb("tripo_idle", "spine", "translation");
  const walkGlb = await makeRiggedGlb("tripo_walk", "front_leg.L", "rotation");

  const fakeProvider = {
    async start() { return { providerTaskHandle: "tripo:base1", provider: "tripo", model: "v2.5" }; },
    async poll(h) { return { done: h === "tripo:base1", glbUrl: undefined, progress: 100 }; },
    async download(url) { return url.includes("idle") ? idleGlb : walkGlb; },
  };
  const fakeOps = {
    async startRig() { return "tripo:rig1"; },
    async startRetarget(_rig, anim) { return anim === "preset:idle" ? "tripo:idle1" : "tripo:walk1"; },
    async pollTask(h) {
      return { done: true, glbUrl: h === "tripo:idle1" ? "http://tripo/idle.glb" : h === "tripo:walk1" ? "http://tripo/walk.glb" : "http://tripo/rig.glb" };
    },
  };

  const adapter = new TripoPetGenerationAdapter(fakeProvider, new InMemoryJobStore(), "v2.5", {
    animate: true, animationOps: fakeOps,
  });

  const job = await adapter.createJob(REFS);
  assert.equal(job.status, "pending");

  // Drive the state machine; each call advances one stage.
  const seen = [];
  let last;
  for (let i = 0; i < 6; i++) {
    last = await adapter.getJob(job.id);
    noUrlAnywhere(last, "getJob");
    seen.push(`${last.status}:${last.progress ?? ""}`);
    if (last.status === "completed" || last.status === "failed") break;
  }
  assert.equal(last.status, "completed", `ended completed; saw ${seen.join(" -> ")}`);

  const artifacts = await adapter.fetchArtifacts(job.id);
  noUrlAnywhere(artifacts, "artifacts");
  assert.equal(artifacts.metadata.animated, true);
  assert.deepEqual(artifacts.metadata.animations, ["idle", "walk"]);

  const merged = io.readBinary(new Uint8Array(artifacts.glb.data));
  const names = (await merged).getRoot().listAnimations().map((a) => a.getName()).sort();
  assert.deepStrictEqual(names, ["idle", "walk"]);
});

test("a separately purchased staged rig continues through idle and walk without another approval", async () => {
  const idleGlb = await makeRiggedGlb("tripo_idle", "spine", "translation");
  const walkGlb = await makeRiggedGlb("tripo_walk", "front_leg.L", "rotation");
  const rigCalls = [];
  const fakeProvider = {
    async start() { return { providerTaskHandle: "tripo:textured-source", provider: "tripo", model: "v2.5" }; },
    async poll() { return { done: true, progress: 100 }; },
    async download(url) { return url.includes("idle") ? idleGlb : walkGlb; },
  };
  const fakeOps = {
    async startRig(handle, rigType) { rigCalls.push({ handle, rigType }); return "tripo:rig-stage"; },
    async startRetarget(_handle, animation) {
      return animation === "preset:idle" ? "tripo:idle-stage" : "tripo:walk-stage";
    },
    async pollTask(handle) {
      if (handle === "tripo:idle-stage") return { done: true, glbUrl: "http://tripo/idle.glb" };
      if (handle === "tripo:walk-stage") return { done: true, glbUrl: "http://tripo/walk.glb" };
      return { done: true, glbUrl: "http://tripo/rig.glb" };
    },
  };
  const adapter = new TripoPetGenerationAdapter(
    fakeProvider,
    new InMemoryJobStore(),
    "v2.5",
    { animate: false, animationOps: fakeOps },
  );
  const source = await adapter.createBaseJob(REFS);
  const rig = await adapter.createRigJob(source.id, "pet");
  assert.deepStrictEqual(rigCalls, [{ handle: "tripo:textured-source", rigType: "quadruped" }]);

  let status;
  for (let poll = 0; poll < 4; poll += 1) status = await adapter.getJob(rig.id);
  assert.equal(status.status, "completed");
  const artifacts = await adapter.fetchArtifacts(rig.id);
  assert.deepStrictEqual(artifacts.metadata.animations, ["idle", "walk"]);
  const merged = await io.readBinary(new Uint8Array(artifacts.glb.data));
  assert.deepStrictEqual(merged.getRoot().listAnimations().map((clip) => clip.getName()).sort(), ["idle", "walk"]);
});

test("a failed Tripo stage surfaces as a failed job, no leak", async () => {
  const fakeProvider = {
    async start() { return { providerTaskHandle: "tripo:base1", provider: "tripo", model: "v2.5" }; },
    async poll() { return { done: true }; },
    async download() { return Buffer.alloc(0); },
  };
  const fakeOps = {
    async startRig() { return "tripo:rig1"; },
    async startRetarget() { return "tripo:idle1"; },
    async pollTask(h) { return h === "tripo:rig1" ? { done: true, error: "RIG_FAILED" } : { done: true }; },
  };
  const adapter = new TripoPetGenerationAdapter(fakeProvider, new InMemoryJobStore(), "v2.5", { animate: true, animationOps: fakeOps });
  const job = await adapter.createJob(REFS);
  await adapter.getJob(job.id);            // base -> rig
  const r = await adapter.getJob(job.id);  // rig poll -> failed
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "PROVIDER_ERROR");
});
