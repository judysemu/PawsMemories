import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  FAMOUS_PORTRAIT_CATALOG,
  FAMOUS_PORTRAIT_CATALOG_SCHEMA,
  publicFamousPortraitCatalog,
} from "../shared/historicalPetCatalog.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FORBIDDEN_PUBLIC_SPORTS_NAMES = /\b(?:Muhammad Ali|Simone Biles|Usain Bolt|Tom Brady|Roger Federer|Wayne Gretzky|Lionel Messi|Pel[eé]|Michael Phelps|Jim Thorpe|Tony Hawk|Shaun White|Stephen Curry|Patrick Mahomes|Peyton Manning|Deion Sanders|Babe Ruth|Shohei Ohtani|Joe Montana|Arnold Schwarzenegger|Serena Williams|Michael Jordan|Bulls)\b/i;

test("Famous Portraits satisfies every approved category minimum", () => {
  const catalog = FAMOUS_PORTRAIT_CATALOG_SCHEMA.parse(FAMOUS_PORTRAIT_CATALOG);
  const count = (category) => catalog.filter((item) => item.category === category).length;

  assert.ok(count("historic-women") >= 8);
  assert.ok(count("leaders") >= 10);
  assert.ok(count("sports-legends") >= 22);
  assert.ok(count("myth-holiday") >= 5);
  assert.ok(count("arts-adventure") >= 6);
  assert.equal(new Set(catalog.map((item) => item.id)).size, catalog.length);
});

test("public Sports Legends are generalized pet archetypes with safe branding", () => {
  const sports = publicFamousPortraitCatalog().filter((item) => item.category === "sports-legends");
  assert.ok(sports.length >= 22);

  for (const portrait of sports) {
    const publicJson = JSON.stringify(portrait);
    assert.doesNotMatch(publicJson, FORBIDDEN_PUBLIC_SPORTS_NAMES, portrait.id);
    assert.equal("inspirationSource" in portrait, false);
    assert.equal("numberSource" in portrait, false);
    assert.ok(portrait.fictionalMark || portrait.uniformNumber === null, portrait.id);
  }
});

test("retained sports numbers match the hand-verified launch mapping", () => {
  const sportsById = new Map(publicFamousPortraitCatalog()
    .filter((item) => item.category === "sports-legends")
    .map((item) => [item.id, item.uniformNumber]));

  assert.deepEqual(Object.fromEntries(sportsById), {
    "airborne-alley-cat": 23,
    "ring-champion": null,
    "gravity-defying-gymnast": null,
    "lightning-sprinter": null,
    "championship-quarterback": 12,
    "center-court-maestro": null,
    "ice-visionary": 99,
    "left-footed-playmaker": 10,
    "beautiful-game-legend": 10,
    "medal-lane-swimmer": null,
    "all-around-champion": null,
    "vert-ramp-pioneer": null,
    "flying-snowboarder": null,
    "long-range-sharpshooter": 30,
    "no-look-quarterback": 15,
    "field-general": 18,
    "two-way-showstopper": 21,
    "home-run-legend": 3,
    "two-way-baseball-phenom": 17,
    "cool-under-pressure-quarterback": 16,
    "golden-era-strongpet": null,
    "power-serve-champion": null,
  });
});

test("every available portrait asset exists and matches its declared hash", () => {
  for (const portrait of FAMOUS_PORTRAIT_CATALOG) {
    if (portrait.availability !== "available") continue;
    assert.ok(portrait.previewAsset, `${portrait.id} must declare a preview asset`);
    const absolute = path.join(ROOT, "public", portrait.previewAsset.publicPath.replace(/^\//, ""));
    assert.ok(fs.existsSync(absolute), absolute);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"), portrait.previewAsset.sha256);
  }
});
