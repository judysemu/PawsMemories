import test from "node:test";
import assert from "node:assert";
import * as THREE from "three";
import { createAnimationController } from "../src/animator/controller/createAnimationController.ts";

test("AnimationController - clip discovery", () => {
  const obj = new THREE.Object3D();
  const clip1 = new THREE.AnimationClip("walk", 2, []);
  const clip2 = new THREE.AnimationClip("run", 1.5, []);
  
  const ctrl = createAnimationController(obj, [clip1, clip2]);
  const clips = ctrl.listClips();
  
  assert.strictEqual(clips.length, 2);
  assert.strictEqual(clips[0].name, "walk");
  assert.strictEqual(clips[1].name, "run");
  assert.strictEqual(clips[0].duration, 2);
});

test("AnimationController - static model has empty clips", () => {
  const obj = new THREE.Object3D();
  const ctrl = createAnimationController(obj, []);
  assert.strictEqual(ctrl.listClips().length, 0);
});

test("AnimationController - selectClip, loop, speed, pause, seek, reset", () => {
  const obj = new THREE.Object3D();
  const clip1 = new THREE.AnimationClip("walk", 2, []);
  const ctrl = createAnimationController(obj, [clip1]);
  
  // selectClip
  ctrl.selectClip("walk");
  
  // setSpeed
  ctrl.setSpeed(1.5);
  // since we can't easily assert internal mixer state without reaching in, we just ensure it doesn't throw.
  
  // loop
  ctrl.setLoop(false);
  
  // play
  ctrl.play();
  
  // pause
  ctrl.pause();
  
  // seek clamps
  ctrl.seek(5);
  assert.strictEqual(ctrl.getCurrentTime(), 2); // clamped to duration
  
  ctrl.seek(-1);
  assert.strictEqual(ctrl.getCurrentTime(), 0); // clamped to 0
  
  ctrl.seek(1);
  assert.strictEqual(ctrl.getCurrentTime(), 1);
  
  // resetToBindPose
  ctrl.resetToBindPose();
});

test("AnimationController - global speed applies to clips selected or added later", () => {
  const obj = new THREE.Object3D();
  const walk = new THREE.AnimationClip("walk", 2, []);
  const ctrl = createAnimationController(obj, [walk]);

  ctrl.setSpeed(1.5);
  ctrl.selectClip("walk");
  assert.equal(ctrl.getClipAction("walk")?.timeScale, 1.5);

  const run = new THREE.AnimationClip("run", 1, []);
  ctrl.addClip(run);
  ctrl.selectClip("run");
  assert.equal(ctrl.getClipAction("run")?.timeScale, 1.5);
});
