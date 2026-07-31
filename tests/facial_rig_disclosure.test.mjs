import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(repoRoot, p), "utf8");

test("facial rigging is removed from every customer purchase surface", () => {
  const screen = read("src/components/create-flow/CreateCustomizeScreen.tsx");
  const studio = read("src/components/PetModelStudio.tsx");
  const pricing = read("src/pricing.ts");

  assert.doesNotMatch(screen, /type="checkbox"[\s\S]{0,400}Include facial rig/i);
  assert.match(screen, /unavailable and is not charged/i);
  assert.match(screen, /at least 75% success/i);
  assert.match(studio, /Facial blendshapes are separate from the body\/skeletal rig above and are not for sale/i);

  const catalogLine = pricing.split("\n").find((line) => line.includes("Facial Rig Add-on"));
  assert.ok(catalogLine);
  assert.match(catalogLine, /credits: null/);
  assert.match(catalogLine, /75%/);
});

test("cached facial selections cannot add cost or start the create-flow facial pass", () => {
  const pricing = read("src/pricing.ts");
  const recovery = read("server/pipeline-rig-recovery.ts");

  assert.doesNotMatch(
    pricing.slice(pricing.indexOf("export function createModelCost"), pricing.indexOf("export function avatarGenerationCost")),
    /FACIAL_RIG_ADDON/,
  );
  assert.match(recovery, /facial: false/);
  assert.match(recovery, /Normalize cached pre-policy selections/);
});

test("the unused viseme utility still refuses to fabricate mouth shapes", () => {
  const visemes = read("agent/graph/nodes/facialVisemes.ts");
  assert.match(visemes, /Never fabricate a mouth shape/i);
  assert.match(visemes, /available/);
});
