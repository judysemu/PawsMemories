import assert from "node:assert/strict";
import { test } from "node:test";
import { avatarGenerationCost, bimModelCost, CREDIT_PACKS, CREDIT_PRICES, REUSE_DISCOUNT } from "../src/pricing.ts";

test("authoritative credit prices match the published catalog", () => {
  assert.equal(CREDIT_PRICES.PAWPRINT_DIGITAL, 40);
  assert.equal(CREDIT_PRICES.PAWPRINT_PRINT, 40);
  assert.equal(CREDIT_PRICES.PAWPRINT_CUSTOMIZE_ADDON, 25);
  assert.equal(CREDIT_PRICES.PAWPRINT_EMAIL, 10);
  assert.equal(CREDIT_PRICES.HD_IMAGE, 10);
  assert.equal(CREDIT_PRICES.ANIMATED_VIDEO, 100);
  assert.equal(CREDIT_PRICES.VOICE_CLONE, 100);
  assert.equal(CREDIT_PRICES.STORAGE_GB_MONTH, 4);
});

test("avatar pricing is fixed by product type", () => {
  assert.equal(avatarGenerationCost("dog", "image"), 80);
  assert.equal(avatarGenerationCost("human", "text"), 80);
  assert.equal(avatarGenerationCost("object", "text"), 40);
  assert.equal(avatarGenerationCost("object", "image"), 45);
});

test("pawprint reuse applies the published 20% discount", () => {
  assert.equal(REUSE_DISCOUNT, 0.2);
  assert.equal(Math.round(CREDIT_PRICES.PAWPRINT_DIGITAL * (1 - REUSE_DISCOUNT)), 32);
});

test("IFC BIM pricing is materially higher than a visual shell", () => {
  assert.equal(bimModelCost("shell"), 60);
  assert.equal(bimModelCost("ifc"), 300);
  assert.ok(bimModelCost("ifc") >= bimModelCost("shell") * 5);
});

test("credit packs match the published wallet packages", () => {
  assert.deepEqual(
    CREDIT_PACKS.filter((pack) => !pack.comingSoon).map(({ credits, price, bonusPercent }) => [credits, price, bonusPercent]),
    [[100, 10, 0], [275, 25, 10], [600, 50, 20], [1300, 100, 30], [3500, 250, 40]],
  );
});
