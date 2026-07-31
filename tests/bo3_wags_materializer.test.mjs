import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSlotPrompt,
  isGenerativeSlot,
  isFuture3dSlot,
  materializeBoxAssets,
} from "../server/wags/materializer.ts";
import { deliverBox } from "../server/wags/delivery.ts";

// ---------------------------------------------------------------------------
// Fake pool: dispatches on SQL shape, records writes. No live MySQL.
// ---------------------------------------------------------------------------

function makeFakePool({ boxStatus = "approved", tier = "basic", items }) {
  const state = {
    boxStatus,
    items: items.map((item, index) => ({ id: index + 1, asset_status: null, asset_url: null, asset_error: null, ...item })),
    statusUpdates: [],
  };
  const pool = {
    async query(sql, params = []) {
      if (sql.includes("FROM wardrobe_wags_boxes b")) {
        return [[{
          id: params[0], status: state.boxStatus,
          plan_json: JSON.stringify({
            season: "autumn", theme: "Harvest Hounds", pet_name: "Biscuit", pet_breed: "Corgi",
            items: state.items.map((i) => ({ slot: i.slot, title: i.title, description: i.description, colors: ["rust orange"] })),
          }),
          species: "dog", tier,
        }]];
      }
      if (sql.includes("SELECT id, slot, title, description, asset_status")) {
        return [state.items.map((i) => ({ ...i }))];
      }
      if (sql.includes("SET asset_status = 'pending'")) {
        const row = state.items.find((i) => i.id === params[0]);
        if (row) { row.asset_status = "pending"; row.asset_error = null; }
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SET asset_status = 'generated'")) {
        const row = state.items.find((i) => i.id === params[1]);
        if (row) { row.asset_status = "generated"; row.asset_url = params[0]; row.asset_error = null; }
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SET asset_status = 'failed'")) {
        const row = state.items.find((i) => i.id === params[1]);
        if (row) { row.asset_status = "failed"; row.asset_error = params[0]; }
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("COUNT(*) AS n FROM wardrobe_wags_box_items")) {
        const n = state.items.filter((i) => ["pending", "failed"].includes(i.asset_status)).length;
        return [[{ n }]];
      }
      if (sql.includes("SET status = 'delivered'")) {
        state.statusUpdates.push("delivered");
        state.boxStatus = "delivered";
        return [{ affectedRows: 1 }];
      }
      throw new Error(`fake pool: unhandled SQL: ${sql.slice(0, 80)}`);
    },
  };
  return { pool, state };
}

// A real 2x2 PNG with genuine transparency (RGBA, one transparent pixel),
// generated once with sharp and inlined so the alpha gate runs for real.
import sharp from "sharp";
async function transparentPngDataUrl() {
  const buf = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 200, g: 80, b: 40, alpha: 0 } },
  }).png().toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}
async function opaquePngDataUrl() {
  const buf = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 80, b: 40 } },
  }).png().toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

const STICKER_ITEM = { slot: "sticker_1", title: "Leaf-Pile Zoomies", description: "Corgi mid-zoom" };
const SEASONAL_ITEM = { slot: "seasonal", title: "Witch Hat", description: "October collectible" };
const CREDIT_ITEM = { slot: "credit_pack", title: "20-Credit Boost", description: "Credits" };
const ACCESSORY_ITEM = { slot: "accessory", title: "Rust Bandana", description: "Wearable" };

// ---------------------------------------------------------------------------
// Slot taxonomy and prompts
// ---------------------------------------------------------------------------

test("slot taxonomy: 2D-generative vs future-3D vs entitlement slots", () => {
  for (const slot of ["sticker_1", "sticker_5", "seasonal", "pawprint"]) assert.equal(isGenerativeSlot(slot), true, slot);
  for (const slot of ["accessory", "accessory_2", "accessory_3", "minimodel"]) {
    assert.equal(isGenerativeSlot(slot), false, slot);
    assert.equal(isFuture3dSlot(slot), true, slot);
  }
  for (const slot of ["credit_pack", "video_gen", "restyle"]) {
    assert.equal(isGenerativeSlot(slot), false, slot);
    assert.equal(isFuture3dSlot(slot), false, slot);
  }
});

test("sticker prompts demand a transparent background and carry pet context", () => {
  const prompt = buildSlotPrompt(
    { slot: "sticker_2", title: "Snack Gremlin", description: "Corgi eyeing a treat", colors: ["gold"] },
    { species: "dog", breed: "Corgi", petName: "Biscuit", season: "autumn", theme: "Harvest Hounds" },
  );
  assert.match(prompt, /TRANSPARENT background/);
  assert.match(prompt, /Corgi named Biscuit/);
  assert.match(prompt, /gold/);
});

test("pawprint and seasonal prompts carry theme and season, no transparency demand", () => {
  const ctx = { species: "cat", breed: null, petName: null, season: "winter", theme: "Frost Whiskers" };
  const pawprint = buildSlotPrompt({ slot: "pawprint", title: "Snow Card", description: "Card art" }, ctx);
  assert.match(pawprint, /Frost Whiskers/);
  assert.match(pawprint, /a cat/);
  assert.doesNotMatch(pawprint, /TRANSPARENT/);
  const seasonal = buildSlotPrompt({ slot: "seasonal", title: "Icicle Crown", description: "Collectible" }, ctx);
  assert.match(seasonal, /winter seasonal art card/);
});

// ---------------------------------------------------------------------------
// Materialization behavior
// ---------------------------------------------------------------------------

test("materializes only generative slots, uploads assets, flips box delivered", async () => {
  const { pool, state } = makeFakePool({ items: [STICKER_ITEM, SEASONAL_ITEM, CREDIT_ITEM, ACCESSORY_ITEM] });
  const calls = { generate: 0, upload: 0 };
  const png = await transparentPngDataUrl();
  const result = await materializeBoxAssets(pool, {
    generateImage: async () => { calls.generate += 1; return png; },
    uploadImage: async () => { calls.upload += 1; return `https://cdn.example/asset-${calls.upload}.png`; },
  }, 7);

  assert.equal(result.generated, 2, "sticker + seasonal only");
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 2, "credit_pack and accessory untouched");
  assert.equal(calls.generate, 2, "no provider call for non-generative slots");
  assert.equal(result.delivered, true);
  assert.equal(state.boxStatus, "delivered");
  assert.equal(state.items.find((i) => i.slot === "sticker_1").asset_url, "https://cdn.example/asset-1.png");
  assert.equal(state.items.find((i) => i.slot === "credit_pack").asset_status, null);
});

test("a failed slot does not block others and holds the box out of delivered", async () => {
  const { pool, state } = makeFakePool({ items: [STICKER_ITEM, SEASONAL_ITEM] });
  const png = await transparentPngDataUrl();
  const result = await materializeBoxAssets(pool, {
    generateImage: async (prompt) => (prompt.includes("seasonal art card") ? null : png),
    uploadImage: async () => "https://cdn.example/ok.png",
  }, 7);

  assert.equal(result.generated, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.delivered, false, "box must not deliver with a missing paid slot");
  assert.equal(state.boxStatus, "approved");
  assert.equal(state.items.find((i) => i.slot === "seasonal").asset_status, "failed");
  assert.match(state.items.find((i) => i.slot === "seasonal").asset_error, /IMAGE_GENERATION_EMPTY/);
});

test("retry is idempotent: generated slots are skipped, only failed regenerate", async () => {
  const { pool, state } = makeFakePool({ items: [STICKER_ITEM, SEASONAL_ITEM] });
  state.items[0].asset_status = "generated";
  state.items[0].asset_url = "https://cdn.example/already.png";
  state.items[1].asset_status = "failed";

  const calls = { generate: 0 };
  const png = await transparentPngDataUrl();
  const result = await materializeBoxAssets(pool, {
    generateImage: async () => { calls.generate += 1; return png; },
    uploadImage: async () => "https://cdn.example/retry.png",
  }, 7);

  assert.equal(calls.generate, 1, "the generated sticker is never regenerated");
  assert.equal(result.generated, 1);
  assert.equal(result.delivered, true);
  assert.equal(state.items[0].asset_url, "https://cdn.example/already.png", "existing asset untouched");
});

test("an opaque sticker fails the real alpha gate and is marked failed", async () => {
  const { pool, state } = makeFakePool({ items: [STICKER_ITEM] });
  const opaque = await opaquePngDataUrl();
  let uploads = 0;
  const result = await materializeBoxAssets(pool, {
    generateImage: async () => opaque,
    uploadImage: async () => { uploads += 1; return "https://cdn.example/should-not-exist.png"; },
  }, 7);

  assert.equal(result.failed, 1);
  assert.equal(uploads, 0, "a failed gate must never upload");
  assert.match(state.items[0].asset_error, /STICKER_NO_ALPHA_CHANNEL|STICKER_ALPHA_OPAQUE/);
  assert.equal(state.boxStatus, "approved");
});

test("seasonal art is not subjected to the sticker alpha gate", async () => {
  const { pool, state } = makeFakePool({ items: [SEASONAL_ITEM] });
  const opaque = await opaquePngDataUrl();
  const result = await materializeBoxAssets(pool, {
    generateImage: async () => opaque,
    uploadImage: async () => "https://cdn.example/seasonal.png",
  }, 7);
  assert.equal(result.generated, 1);
  assert.equal(state.items[0].asset_status, "generated");
});

test("materializing an unapproved box is refused", async () => {
  const { pool } = makeFakePool({ boxStatus: "pending_review", items: [STICKER_ITEM] });
  await assert.rejects(
    () => materializeBoxAssets(pool, { generateImage: async () => null, uploadImage: async () => "" }, 7),
    /not approved/,
  );
});

test("Plus materialization fails closed before any partial seven-call image run", async () => {
  const plusItems = [
    SEASONAL_ITEM,
    { slot: "pawprint", title: "Harvest Card", description: "Pawprint art" },
    ...Array.from({ length: 5 }, (_, index) => ({
      slot: `sticker_${index + 1}`,
      title: `Sticker ${index + 1}`,
      description: "Transparent sticker",
    })),
  ];
  const { pool, state } = makeFakePool({ tier: "plus", items: plusItems });
  let generateCalls = 0;

  await assert.rejects(
    () => materializeBoxAssets(pool, {
      generateImage: async () => {
        generateCalls += 1;
        return null;
      },
      uploadImage: async () => "",
    }, 7),
    /WAGS_PLUS_IMAGE_BUDGET_ATOMICITY_REQUIRED/,
  );

  assert.equal(generateCalls, 0);
  assert.equal(state.items.every((item) => item.asset_status === null), true);
});

// ---------------------------------------------------------------------------
// deliverBox finalizeStatus option
// ---------------------------------------------------------------------------

function makeDeliveryPool() {
  const writes = [];
  return {
    writes,
    async query(sql, params = []) {
      writes.push({ sql, params });
      if (sql.includes("COUNT(*) AS n")) return [[{ n: 0 }]];
      if (sql.includes("SELECT DISTINCT")) return [[]];
      if (sql.startsWith("INSERT INTO wardrobe_wags_box_items")) return [{ insertId: writes.length }];
      return [{ affectedRows: 1 }];
    },
  };
}

const MINI_PLAN = {
  schema_version: "wags.plan.v1", box_month: "2026-08", tier: "basic", season: "summer",
  theme: "t", theme_rationale: "r",
  items: [
    { slot: "sticker_1", title: "S", description: "d", category: "c", colors: [], tags: [] },
    { slot: "credit_pack", title: "C", description: "d", category: "c", colors: [], tags: [] },
  ],
};

test("deliverBox with finalizeStatus:false creates items but never flips delivered", async () => {
  const pool = makeDeliveryPool();
  const result = await deliverBox(pool, { id: 9, user_phone: "+15550001111", plan_json: MINI_PLAN }, { finalizeStatus: false });
  assert.equal(result.itemsCreated, 2);
  assert.equal(pool.writes.some((w) => w.sql.includes("SET status = 'delivered'")), false);
  const stickerInsert = pool.writes.find((w) => w.sql.startsWith("INSERT INTO wardrobe_wags_box_items") && w.params[1] === "sticker_1");
  assert.equal(stickerInsert.params[8], "pending", "generative slot starts pending");
  const creditInsert = pool.writes.find((w) => w.sql.startsWith("INSERT INTO wardrobe_wags_box_items") && w.params[1] === "credit_pack");
  assert.equal(creditInsert.params[8], "none", "non-generative slot has no asset obligation");
});

test("deliverBox default behavior still flips delivered (back-compat)", async () => {
  const pool = makeDeliveryPool();
  await deliverBox(pool, { id: 9, user_phone: "+15550001111", plan_json: MINI_PLAN });
  assert.equal(pool.writes.some((w) => w.sql.includes("SET status = 'delivered'")), true);
});
