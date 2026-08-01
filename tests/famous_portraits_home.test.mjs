import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import FamousPortraits, { portraitsForCategory } from "../src/components/FamousPortraits.tsx";

test("Famous Portraits renders an accessible, pet-owner friendly collection browser", () => {
  const html = renderToStaticMarkup(React.createElement(FamousPortraits, { onOpenPawprints() {} }));

  assert.match(html, /Famous Portraits/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /Historic Women/);
  assert.match(html, /Presidents &amp; World Leaders/);
  assert.match(html, /Sports Legends/);
  assert.match(html, /The Composer/);
  assert.match(html, /Make my pet famous/);
});

test("category selection exposes only the requested portrait group", () => {
  const sports = portraitsForCategory("sports-legends");
  assert.equal(sports.length, 22);
  assert.ok(sports.every((portrait) => portrait.category === "sports-legends"));
  assert.ok(sports.some((portrait) => portrait.displayName === "Airborne Alley Cat"));
});

test("the homepage mounts Famous Portraits in place of Featured Models", () => {
  const source = fs.readFileSync("src/components/HomePage.tsx", "utf8");
  assert.match(source, /<FamousPortraits onOpenPawprints=\{onOpenPawprints\}/);
  assert.doesNotMatch(source, />Featured Models</);
});
