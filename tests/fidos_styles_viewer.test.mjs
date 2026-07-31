import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Component was renamed PawlisherScreen -> FidosStylesScreen; this path was
// left stale and the suite had been failing on ENOENT ever since.
const source = await readFile(new URL("../src/components/FidosStylesScreen.tsx", import.meta.url), "utf8");

test("Fido's Styles viewer has no Edison bulb feature", () => {
  assert.doesNotMatch(source, /Edison bulb|Lightbulb|lightSettings|pawlisher_light/);
  assert.doesNotMatch(source, /sphereGeometry|cylinderGeometry/);
});

test("360 viewer uses shadow-only grounding without a solid turntable slab", () => {
  assert.match(source, /<ContactShadows\b/);
  assert.doesNotMatch(source, /circleGeometry|planeGeometry/);
  assert.match(source, /360 turntable/);
});

test("avatar project switching resets identity and autosave fails visibly on non-2xx", () => {
  assert.match(source, /setProjectId\(null\)/);
  assert.match(source, /setProjectLoadedAvatarId\(null\)/);
  assert.match(source, /projectLoadedAvatarId !== Number\(selectedId\)/);
  assert.match(source, /if \(!r\.ok\) throw new Error\(data\?\.error \|\| "Could not save project\."\)/);
  assert.match(source, /setSaveStatus\("Project load failed"\)/);
});

test("the fitted model is scaled before its final centering and grounding bounds", () => {
  const scaleIndex = source.indexOf("cloned.scale.setScalar");
  const scaledBoundsIndex = source.indexOf("const scaledBox = new THREE.Box3().setFromObject(cloned)");
  const groundIndex = source.indexOf("cloned.position.y -= scaledBox.min.y");
  assert.ok(scaleIndex >= 0 && scaledBoundsIndex > scaleIndex && groundIndex > scaledBoundsIndex);
});
