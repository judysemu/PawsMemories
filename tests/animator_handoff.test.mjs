import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("Animator entry points hand off GLB URLs instead of avatar database ids", () => {
  // Phase 6 (IMPLEMENTATION_SPEC §8.6): the rebuilt Fido's Styles workspace no
  // longer links the animator at all — its onGoToAnimator prop was removed.
  // AvatarDashboard remains an animator entry point and must still hand off a
  // GLB URL rather than a database id.
  const pawlisher = fs.readFileSync("src/components/FidosStylesScreen.tsx", "utf8");
  const models = fs.readFileSync("src/components/AvatarDashboard.tsx", "utf8");
  assert.doesNotMatch(pawlisher, /onGoToAnimator/,
    "Fido's Styles must not expose animator navigation while the studio is gated");
  assert.match(models, /onGoToAnimator\?\.\(glbUrl\)/);
  assert.doesNotMatch(models, /onGoToAnimator\?\.\(String\(avatar\.id\)\)/);
});

test("Scene controller wrapper is memoized so initial asset loading cannot loop", () => {
  const source = fs.readFileSync("src/animator/controller/useSceneController.ts", "utf8");
  assert.match(source, /const wrappedController = useMemo/);
});

test("Animator source is preserved while Fur Reels remains the customer generator", () => {
  const builder = fs.readFileSync("src/animator/components/AnimatorScreen.tsx", "utf8");
  const videoCreator = fs.readFileSync("src/components/AnimationStudio.tsx", "utf8");
  assert.match(builder, /3D Animation Builder/);
  assert.match(builder, /Timeline[\s\S]*Dope Sheet[\s\S]*X-Sheet/);
  assert.match(builder, /workspaceTool/);
  assert.match(builder, /MousePointer2[\s\S]*Move3D[\s\S]*Bone/);
  assert.match(builder, /onOpenVideoCreator/);
  assert.match(videoCreator, /Fur Reels/);
  assert.match(videoCreator, /guided video generation/i);
});

test("Fur Reels is customer-routable without exposing the manual Animator", () => {
  const app = fs.readFileSync("src/App.tsx", "utf8");
  assert.match(app, /const openAnimationStudio = \(\) => \{/);
  const animatorBlock = app.match(/currentScreen === Screen\.ANIMATOR[\s\S]*?Safety net/)?.[0] || "";
  assert.match(animatorBlock, /<AnimationStudio/);
  assert.doesNotMatch(animatorBlock, /AnimatorScreen|UnderConstructionLock|userProfile\.isAdmin/);
  // Phase 6: Fido's Styles is UNLOCKED — PAWLISHER renders the real workspace.
  assert.match(app, /currentScreen === Screen\.PAWLISHER[\s\S]{0,400}FidosStylesScreen/);
  assert.doesNotMatch(app, /featureName="Fido's Styles"/,
    "Fido's Styles must no longer be wrapped in UnderConstructionLock");
});

test("RD-4: gated animator/lip-sync backends stay intact (gating must never become deletion)", () => {
  // Client speech stack
  for (const file of [
    "src/animator/speech/liveSpeech.ts",
    "src/animator/speech/speak.ts",
    "src/animator/components/AnimatorScreen.tsx",
  ]) {
    assert.ok(fs.existsSync(file), `${file} must exist while the Animation Studio is gated`);
  }
  // Server lip-sync + animator router remain mounted and functional
  const lipsync = fs.readFileSync("server/animator/lipsync.ts", "utf8");
  assert.match(lipsync, /postProcessVisemeTrack/);
  const routes = fs.readFileSync("server/animator/routes.ts", "utf8");
  assert.match(routes, /animatorRouter\.post\("\/animator\/lipsync"/);
  assert.match(routes, /animatorRouter\.post\("\/rig"/);
  const server = fs.readFileSync("server.ts", "utf8");
  assert.match(server, /animatorRouter/);
  // Build-time viseme pipeline preserved for the facial rig add-on
  const visemes = fs.readFileSync("agent/graph/nodes/facialVisemes.ts", "utf8");
  assert.match(visemes, /viseme_/);
});
