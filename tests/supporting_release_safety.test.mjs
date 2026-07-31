import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("B2 CORS repair merges one named rule under an optimistic revision guard", () => {
  const source = fs.readFileSync("scripts/set-b2-cors.mjs", "utf8");
  assert.match(source, /bucket\.corsRules\.filter/);
  assert.match(source, /ifRevisionIs: bucket\.revision/);
  assert.doesNotMatch(
    source,
    /body: JSON\.stringify\(\{ accountId, bucketId: bucket\.bucketId, corsRules \}\)/,
  );
});

test("Animator batch execution fails closed when only validation exists", () => {
  const source = fs.readFileSync("scripts/animator-batch.mjs", "utf8");
  assert.match(source, /dispatch is not implemented/);
  assert.match(source, /process\.exit\(2\)/);
  assert.doesNotMatch(source, /treating as --dry-run/);
});

test("object catalog and manifest cannot advertise absent GLBs", () => {
  const manifest = JSON.parse(
    fs.readFileSync("public/objects/manifest.json", "utf8"),
  );
  assert.deepEqual(manifest.assets, {});
  const catalog = fs.readFileSync("src/three/objects/catalog.ts", "utf8");
  assert.doesNotMatch(catalog, /glbUrl:\s*["']\/objects\//);
});

test("known landing and Animator surfaces do not advertise absent release media", () => {
  const hero = fs.readFileSync("src/components/HeroScroller.tsx", "utf8");
  const cats = fs.readFileSync(
    "src/components/landing/CatModelsPage.tsx",
    "utf8",
  );
  const clips = fs.readFileSync("server/animator/clips.ts", "utf8");
  const walkthrough = fs.readFileSync(
    "src/components/PawprintWalkthrough.tsx",
    "utf8",
  );
  for (const absent of [
    "/hero/appeal-reel.mp4",
    "/hero/appeal-reel.jpg",
    "/featured-models/tuxedo-cat.webp",
    "/featured-models/persian-cat.webp",
    "/featured-models/siamese-cat.webp",
    "/featured-models/ginger-tabby.webp",
    "/tour/birthday-pet.jpg",
    "quadruped_run_cc0.glb",
    "quadruped_sit_cc0.glb",
    "biped_dance_cc0.glb",
  ]) {
    assert.equal(
      `${hero}\n${cats}\n${clips}\n${walkthrough}`.includes(absent),
      false,
      absent,
    );
  }
  for (const relativePath of [
    "public/MAIN.jpg",
    "public/MAIN2.jpg",
    "public/MAIN4.jpg",
    "public/brand/furball3d.jpg",
    "public/featured-models/tuck.webp",
  ]) {
    assert.equal(fs.existsSync(relativePath), true, relativePath);
  }
});

test("README and Render blueprint do not point operators at absent documents", () => {
  const source = `${fs.readFileSync("README.md", "utf8")}\n${fs.readFileSync("render.yaml", "utf8")}`;
  for (const missing of [
    "AR_PET_SIM_SPEC.md",
    "AR_PET_SIM_HANDOFF.md",
    "AR_PET_SIM_HARDENING_PLAN_V2.md",
    "RANDY_AI_SPEC.md",
    "X_DM_REFINEMENT_SPEC.md",
    "DEPLOYMENT_NOTES.md",
  ])
    assert.doesNotMatch(source, new RegExp(missing.replaceAll(".", "\\.")));
});
