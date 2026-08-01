import assert from "node:assert/strict";
import { test } from "node:test";
import { Screen } from "../src/types.ts";
import { MOBILE_NAV, SIDEBAR_NAV, TOP_PRIMARY_NAV, SHELL_ICON_NAV } from "../src/shellNavigation.ts";

test("top panel exposes Create, Voice Test, Pawprints, and the staged 3D Model studio", () => {
  assert.deepEqual(TOP_PRIMARY_NAV.map(({ screen }) => screen), [
    Screen.CREATE,
    Screen.VOICE_TEST,
    Screen.PAWPRINTS,
    Screen.PET_GLB,
  ]);
});

test("desktop sidebar exposes the approved Pawprints and Fur Reels studios", () => {
  // WAGS_INBOX is a content destination (like Fur Bin), not a creation studio.
  assert.deepEqual(SIDEBAR_NAV.map(({ screen }) => screen), [
    Screen.DASHBOARD,
    Screen.FURBIN,
    Screen.PAWPRINTS,
    Screen.ANIMATOR,
    Screen.WAGS_INBOX,
  ]);
  // MOBILE_NAV is NOT "sidebar + Profile". Profile and Voice Test both have a
  // permanent one-tap route in the header (SHELL_ICON_NAV), so repeating them
  // in the bottom bar spent two of five slots on duplicates — and with the Help
  // button the row rendered six items into a five-column grid.
  assert.deepEqual(MOBILE_NAV.map(({ screen }) => screen), [
    Screen.DASHBOARD,
    Screen.FURBIN,
    Screen.PAWPRINTS,
    Screen.WAGS_INBOX,
  ]);
  assert.ok(!SIDEBAR_NAV.some(({ screen }) => screen === Screen.MODELS || screen === Screen.PAWLISHER));
});

test("mobile bottom bar only duplicates the requested Pawprints destination", () => {
  // Pawprints is deliberately present in both the top and left/mobile panels.
  const headerScreens = new Set(SHELL_ICON_NAV.map(({ screen }) => screen));
  const duplicated = MOBILE_NAV.filter(({ screen }) => headerScreens.has(screen));
  assert.deepEqual(
    duplicated.map(({ id }) => id),
    ["pawprints"],
    "only the requested Pawprints tab may repeat a header destination"
  );
});

test("mobile bottom bar fits its grid alongside the Help button", () => {
  // App.tsx renders MOBILE_NAV plus a trailing Help button. Five total is the
  // most that stays legible at phone widths.
  assert.ok(
    MOBILE_NAV.length + 1 <= 5,
    `bottom bar would render ${MOBILE_NAV.length + 1} columns; 5 is the maximum`
  );
});

test("RD-1: no shell entry routes to a gated (UnderConstructionLock) screen", () => {
  // PAWLISHER removed from this set: Fido's Styles is unlocked (Phase 6) and
  // renders the real workspace, so a shell entry to it would no longer dead-end.
  const gated = new Set([Screen.MODELS]);
  for (const panel of [TOP_PRIMARY_NAV, SIDEBAR_NAV, MOBILE_NAV]) {
    assert.ok(!panel.some(({ screen }) => gated.has(screen)), "shell navigation must not dead-end into a lock screen");
  }
});

test("shell navigation has no duplicate ids or screens per panel", () => {
  for (const panel of [TOP_PRIMARY_NAV, SIDEBAR_NAV, MOBILE_NAV]) {
    assert.equal(new Set(panel.map(({ id }) => id)).size, panel.length);
    assert.equal(new Set(panel.map(({ screen }) => screen)).size, panel.length);
  }
});
