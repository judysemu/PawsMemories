import { test } from "node:test";
import assert from "node:assert";
import { NodeIO, Document } from "@gltf-transform/core";

const { mergeIdleWalk } = await import("../server/pet-generation/animationMerge.js");

const io = new NodeIO();

/**
 * Build a minimal skinned-style GLB: two named bones and one animation with a
 * single channel. `clipName` is what the clip is called in the source; the
 * merger overwrites it to idle/walk, so it should not matter.
 */
async function makeRiggedGlb(clipName, targetBoneName, path) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const spine = doc.createNode("spine");
  const leg = doc.createNode("front_leg.L");
  doc.createScene().addChild(spine).addChild(leg);
  const byName = { spine, "front_leg.L": leg };

  const input = doc.createAccessor().setType("SCALAR")
    .setArray(new Float32Array([0, 0.5, 1])).setBuffer(buffer);
  const outArr = path === "rotation"
    ? new Float32Array([0, 0, 0, 1, 0, 0.1, 0, 0.99, 0, 0, 0, 1]) // 3× VEC4
    : new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0, 0]);            // 3× VEC3
  const output = doc.createAccessor().setType(path === "rotation" ? "VEC4" : "VEC3")
    .setArray(outArr).setBuffer(buffer);
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
  const channel = doc.createAnimationChannel().setTargetNode(byName[targetBoneName]).setTargetPath(path).setSampler(sampler);
  doc.createAnimation(clipName).addSampler(sampler).addChannel(channel);

  return Buffer.from(await io.writeBinary(doc));
}

test("mergeIdleWalk produces one GLB with idle + walk on the base rig, no node duplication", async () => {
  const idleGlb = await makeRiggedGlb("some_idle_preset", "spine", "translation");
  const walkGlb = await makeRiggedGlb("tripo_walk_v2", "front_leg.L", "rotation");

  const merged = await mergeIdleWalk(idleGlb, walkGlb);
  const doc = await io.readBinary(new Uint8Array(merged));
  const root = doc.getRoot();

  const names = root.listAnimations().map((a) => a.getName()).sort();
  assert.deepStrictEqual(names, ["idle", "walk"], "exactly idle + walk clips");

  // No skeleton duplication: still the original two nodes.
  assert.strictEqual(root.listNodes().length, 2, "node count unchanged (no duplicate rig)");

  // The walk clip must target the base rig's own leg node.
  const walk = root.listAnimations().find((a) => a.getName() === "walk");
  const tgt = walk.listChannels()[0].getTargetNode();
  assert.strictEqual(tgt.getName(), "front_leg.L");
  assert.strictEqual(walk.listChannels()[0].getTargetPath(), "rotation");
});

test("merged output satisfies the validator's idle/walk clip gates", async () => {
  const { validatePetGlb } = await import("../server/pet-generation/validation.js");
  const idleGlb = await makeRiggedGlb("idleish", "spine", "translation");
  const walkGlb = await makeRiggedGlb("walkish", "front_leg.L", "rotation");
  const merged = await mergeIdleWalk(idleGlb, walkGlb);

  const report = validatePetGlb(merged, {});
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.passed]));
  assert.strictEqual(byId.idle_clip_exists, true, "idle_clip_exists passes");
  assert.strictEqual(byId.walk_clip_exists, true, "walk_clip_exists passes");
  assert.ok(!report.reasonCodes.includes("ANIM_RETARGET"), "no ANIM_RETARGET reason");
});

test("empty source animation is rejected, not silently accepted", async () => {
  const idleGlb = await makeRiggedGlb("idle", "spine", "translation");
  const empty = Buffer.from(await io.writeBinary(new Document())); // no animations
  await assert.rejects(() => mergeIdleWalk(idleGlb, empty));
});
