import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const modelStudio = await readFile(new URL("../src/components/PetModelStudio.tsx", import.meta.url), "utf8");
const furReels = await readFile(new URL("../src/components/AnimationStudio.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("model creation stays in one live dashboard and refreshes exact-version previews automatically", () => {
  assert.match(modelStudio, /<CreativeDashboard/);
  assert.match(modelStudio, /Live model viewer/);
  assert.match(modelStudio, /liveBuildAction\(view\)/);
  assert.match(modelStudio, /stages\/current\/preview/);
  assert.match(modelStudio, /autoRotate=\{false\}/);
  assert.match(modelStudio, /startInFlightRef\.current/);
  assert.match(modelStudio, /setAutoRefreshPaused\(true\)/);
  assert.match(modelStudio, /Check status again/);
  assert.doesNotMatch(modelStudio, /Check stage progress|Load secure 3D preview|Back to model builds|This stage is running/);
});

test("Fur Reels uses the same scroll-locked three-region dashboard language", () => {
  assert.match(furReels, /data-creative-dashboard="true"/);
  assert.match(furReels, /data-dashboard-region="left"/);
  assert.match(furReels, /data-dashboard-region="center"/);
  assert.match(furReels, /data-dashboard-region="right"/);
  assert.match(furReels, /h-\[calc\(100dvh-4rem\)\].*overflow-hidden/);
});

test("Fur Reels uses its standalone image icon in desktop and mobile navigation", () => {
  assert.ok(shell.match(/item\.imageSrc/g)?.length >= 2);
});
