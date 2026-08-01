import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const screen = read("src/components/FurBinScreen.tsx");
const experience = read("src/components/fur-bin-v5/FurBinV5Experience.tsx");
const client = read("src/components/fur-bin-v5/client.ts");
const types = read("src/components/fur-bin-v5/types.ts");
const styles = read("src/components/fur-bin-v5/furBinV5.css");

test("Fur Bin V5 is dark-launched without replacing the legacy false path", () => {
  assert.match(screen, /VITE_FUR_BIN_V5_ENABLED\s*!==\s*["']false["']/);
  assert.match(screen, /React\.lazy\(\(\)\s*=>\s*import\(["']\.\/fur-bin-v5["']\)\)/);
  assert.match(screen, /fetchModelLibrary\(\)/, "legacy library behavior must remain in the component");
  assert.match(screen, /fetchModelPrintOrders\(\)/, "legacy print-order behavior must remain in the component");
});

test("Fur Bin V5 exposes an injected API and never exposes internal storage or numeric authorization handles", () => {
  assert.match(experience, /api\?: FurBinV5Api/);
  assert.match(types, /versionNumber: number/);
  assert.doesNotMatch(`${client}\n${types}\n${experience}`, /targetVersionId|object_key|objectKey|storageKey|published_version_id|asset_id/);
  assert.doesNotMatch(experience, /hasRig\s*:/, "the client UI must not submit capability badge claims");
  assert.match(client, /\/api\/fur-bin\/items/);
  assert.match(client, /\/api\/fur-bin\/collections/);
  assert.match(client, /\/api\/fur-bin\/showcase/);
});

test("Fur Bin remains private and does not expose the public showcase workflow", () => {
  assert.match(experience, /private home for every 3D pet/);
  assert.doesNotMatch(experience, /Public showcase/);
  assert.doesNotMatch(experience, /Submit for moderation/);
  assert.doesNotMatch(experience, /Keep it|Toss it/);
});

test("responsive and accessible contracts include safe gutters, reduced motion, dialogs, and static fallback", () => {
  assert.match(styles, /max\(20px, env\(safe-area-inset-right\)\)/);
  assert.match(styles, /@media \(min-width: 640px\)/);
  assert.match(styles, /24px/);
  assert.match(styles, /safe-area-inset-bottom/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(experience, /role="dialog"/);
  assert.match(experience, /aria-modal="true"/);
  assert.match(experience, /event\.key === "Escape"/);
  assert.match(experience, /role="search"/);
  assert.match(experience, /PetModelViewer/);
  assert.match(experience, /coverUrl/);
});

test("library states and required product controls are present", () => {
  for (const contract of [
    "Opening your Fur Bin",
    "No creations match those filters",
    "Try again",
    "Version history",
    "Make current",
    "Refresh viewer",
    "Delete",
    "New collection",
    "Retry full build",
    "Send a message",
  ]) assert.match(experience, new RegExp(contract));
});
