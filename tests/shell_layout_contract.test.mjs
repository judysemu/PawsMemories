import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("global shell keeps stable desktop dimensions", () => {
  assert.match(source, /h-16/);
  assert.match(source, /hidden w-56[^\n]+md:flex/);
  assert.match(source, /md:ml-56/);
  assert.match(source, /md:w-\[calc\(100%-14rem\)\]/);
  assert.match(source, /min-w-0/);
  assert.doesNotMatch(source, /md:ml-56 w-full/);
});

test("signed-out shell does not expose product navigation", () => {
  assert.match(source, /\{isAuthed && \(/);
  // The header icon row replaced the old TOP_PRIMARY_NAV centre nav. The
  // guarantee under test is unchanged — product destinations must not render
  // for signed-out visitors — so this asserts the gate wraps the new mechanism
  // rather than merely that the mechanism exists.
  assert.match(source, /SHELL_ICON_NAV\.map/);
  const gate = source.indexOf("{isAuthed && (");
  const iconNav = source.indexOf("SHELL_ICON_NAV.map");
  assert.ok(gate !== -1 && iconNav !== -1, "expected both the auth gate and the icon nav");
  assert.ok(gate < iconNav, "SHELL_ICON_NAV must render inside an isAuthed gate");
});

test("header shows exactly four stencil destinations", () => {
  // Guards the brief: one logo left, four icons right. If a fifth destination
  // is ever appended to SHELL_ICON_NAV, that is a design decision that should
  // fail here first rather than silently re-crowding the header.
  const nav = readFileSync(new URL("../src/shellNavigation.ts", import.meta.url), "utf8");
  const block = nav.match(/export const SHELL_ICON_NAV[^=]*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(block, "expected a SHELL_ICON_NAV array literal");
  const entries = block[1].match(/\{\s*\n?\s*id:/g) || block[1].match(/\{\s*id:/g) || [];
  assert.equal(entries.length, 4, `expected 4 shell icons, found ${entries.length}`);
});

test("mobile shell derives its column count from MOBILE_NAV", () => {
  // Was `grid-cols-5` hard-coded. That silently broke when MOBILE_NAV changed
  // length: six items (nav + Help) rendered into five columns and squeezed
  // every label. The grid now sizes itself, so this asserts the derivation is
  // present rather than pinning a magic number that has to be edited in lockstep.
  //
  // LIVE-1 follow-up: Help was moved to the profile overflow menu, so the bar
  // is now MOBILE_NAV.length columns with no trailing Help button.
  assert.match(source, /MOBILE_NAV\.map/);
  assert.match(
    source,
    /gridTemplateColumns:\s*`repeat\(\$\{MOBILE_NAV\.length\}/,
    "bottom bar column count must be derived from MOBILE_NAV.length"
  );
  assert.match(
    source,
    /Help was moved to the profile overflow menu/,
    "the rationale for removing the Help button should be documented in code"
  );
  assert.doesNotMatch(
    source,
    /gridTemplateColumns:\s*`repeat\(\$\{MOBILE_NAV\.length \+ 1\}/,
    "bottom bar must not add a +1 column for the removed Help button"
  );
  assert.doesNotMatch(
    source,
    /grid-cols-5[^"']*md:hidden|md:hidden[^"']*grid-cols-5/,
    "bottom bar must not re-introduce a hard-coded column count"
  );
  assert.match(source, /safe-area-inset-bottom/, "bottom navigation must respect phone safe areas");
  assert.doesNotMatch(source, /material-symbols-outlined/, "shell icons must not become raw words when an external icon font is unavailable");
});
