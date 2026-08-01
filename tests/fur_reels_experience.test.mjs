import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { AI_VIDEO_SCRIPTS } from "../src/aiVideoScripts.ts";
import { SIDEBAR_NAV } from "../src/shellNavigation.ts";

test("customer video generation is branded Fur Reels", () => {
  const videoNav = SIDEBAR_NAV.find((item) => item.id === "animate");
  assert.equal(videoNav?.label, "Fur Reels");
  assert.equal(videoNav?.materialIcon, "movie_creation");
});

test("Fur Reels includes the five approved complete eight-second scripts", () => {
  const ids = new Set(AI_VIDEO_SCRIPTS.map((script) => script.id));
  for (const id of ["moonlight-maestro", "joans-banner", "santas-workshop-surprise", "cleopatras-golden-entrance", "rock-star-encore"]) {
    assert.ok(ids.has(id), id);
  }
  assert.ok(AI_VIDEO_SCRIPTS.length >= 13);
  for (const script of AI_VIDEO_SCRIPTS) {
    assert.equal(script.stageDirections.length, 4);
    assert.ok(script.setting.length > 20);
    assert.ok(script.motions.length > 20);
    assert.ok(script.lighting.length > 20);
    assert.ok(script.camera.length > 20);
  }
});

test("Fur Reels presents direction, uploads, voice, and persistence in one dashboard", () => {
  const studio = fs.readFileSync("src/components/AnimationStudio.tsx", "utf8");
  assert.match(studio, />Fur Reels</);
  assert.match(studio, /What works best/);
  assert.match(studio, /Upload another photo/);
  assert.match(studio, /Your finished Fur Reels are saved to your account/);
  assert.match(studio, /lg:overflow-hidden/);
  assert.match(studio, /lg:grid-cols-\[minmax\(220px,.72fr\)_minmax\(0,1.35fr\)_minmax\(280px,.9fr\)\]/);
});
