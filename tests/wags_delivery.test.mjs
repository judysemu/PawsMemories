import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { matchWardrobeItem } from "../server/wags/delivery.ts";
import {
  WARDROBE_CATALOG,
  WAGS_EXCLUSIVE_CATALOG,
  FULL_WARDROBE_CATALOG,
} from "../src/wardrobe/catalog.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(repoRoot, p), "utf8");

/* ------------------------------------------------------------------ */
/* Catalog integrity                                                    */
/* ------------------------------------------------------------------ */

test("wags exclusives never collide with the base catalog", () => {
  const baseIds = new Set(WARDROBE_CATALOG.map((i) => i.id));
  for (const item of WAGS_EXCLUSIVE_CATALOG) {
    assert.ok(!baseIds.has(item.id), `${item.id} exists in both catalogs`);
    assert.match(
      item.id,
      /^wags-/,
      `${item.id} must carry the wags- prefix so grants are auditable`,
    );
  }
  assert.equal(
    new Set(FULL_WARDROBE_CATALOG.map((i) => i.id)).size,
    FULL_WARDROBE_CATALOG.length,
    "combined catalog must have unique ids",
  );
});

test("seed script stays in sync with the renderable catalog", () => {
  // A seeded listing that cannot render in the viewer would produce
  // undeliverable box items, so drift between the seed list and the catalog
  // must fail loudly here rather than surface as a broken unboxing.
  const seed = read("scripts/seed-wags-catalog.mjs");
  for (const item of FULL_WARDROBE_CATALOG) {
    assert.ok(
      seed.includes(`"${item.id}"`),
      `seed script is missing ${item.id}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Wardrobe matching                                                    */
/* ------------------------------------------------------------------ */

const planItem = (colors) => ({
  slot: "accessory",
  title: "Test Accessory",
  description: "d",
  category: "accessories",
  colors,
  tags: [],
});

test("matcher colour-matches against unowned exclusives", () => {
  // "midnight"/navy should pull the Midnight Collar over, say, the rose one.
  const picked = matchWardrobeItem(planItem(["midnight blue"]), new Set());
  assert.equal(picked, "wags-midnight-collar");
});

test("matcher never grants an owned item", () => {
  const owned = new Set(["wags-midnight-collar"]);
  const picked = matchWardrobeItem(planItem(["midnight blue"]), owned);
  assert.notEqual(picked, "wags-midnight-collar");
  assert.ok(picked, "an unowned alternative must be granted");
});

test("matcher returns null when the user owns everything", () => {
  const allOwned = new Set(WAGS_EXCLUSIVE_CATALOG.map((i) => i.id));
  assert.equal(matchWardrobeItem(planItem(["red"]), allOwned), null);
});

test("matcher is deterministic for unknown colours", () => {
  const a = matchWardrobeItem(planItem(["glorp"]), new Set());
  const b = matchWardrobeItem(planItem(["glorp"]), new Set());
  assert.equal(a, b);
});

/* ------------------------------------------------------------------ */
/* Delivery source contracts                                            */
/* ------------------------------------------------------------------ */

const deliverySource = read("server/wags/delivery.ts");

test("delivery is idempotency-gated before any grant", () => {
  assert.match(deliverySource, /beginTransaction\(\)/);
  assert.match(deliverySource, /FOR UPDATE/);
  const gateIdx = deliverySource.indexOf("alreadyDelivered: true");
  const creditIdx = deliverySource.indexOf("credits = credits +");
  assert.ok(gateIdx > -1 && creditIdx > -1);
  assert.ok(
    gateIdx < creditIdx,
    "the existing-items gate must run before the credit grant",
  );
});

test("legacy Wags checkout cannot create recurring billing", () => {
  const server = read("server.ts");
  const routeStart = server.indexOf('app.post("/api/wags/subscribe"');
  const retired = server.indexOf("LEGACY_WAGS_CHECKOUT_RETIRED", routeStart);
  const providerCall = server.indexOf(
    "stripe.subscriptions.create",
    routeStart,
  );
  assert.ok(routeStart > -1 && retired > routeStart);
  assert.ok(
    providerCall === -1 || retired < providerCall,
    "the route must return its retirement response before any provider call",
  );
});

test("Wags materialization uses a connection-scoped advisory lock", () => {
  const materializer = read("server/wags/materializer.ts");
  assert.match(materializer, /GET_LOCK\(\?, 0\)/);
  assert.match(materializer, /RELEASE_LOCK\(\?\)/);
  assert.match(materializer, /connection\.release\(\)/);
});

test("credits are granted after their recording row, never before", () => {
  const insertIdx = deliverySource.indexOf(
    "INSERT INTO wardrobe_wags_box_items",
  );
  const grantIdx = deliverySource.indexOf("UPDATE users SET credits");
  assert.ok(
    insertIdx > -1 && grantIdx > -1 && insertIdx < grantIdx,
    "crash between row and grant must under-grant (visible), never over-grant (silent)",
  );
});

test("wardrobe grants come only from the exclusive catalog", () => {
  assert.match(deliverySource, /WAGS_EXCLUSIVE_CATALOG/);
  assert.doesNotMatch(
    deliverySource,
    /from "\.\.\/\.\.\/src\/wardrobe\/catalog"[\s\S]*WARDROBE_CATALOG\b/,
    "granting from the free base catalog would deliver nothing of value",
  );
});

test("delivered Wags exclusives survive wardrobe load and are entitlement-gated on save", () => {
  const screen = read("src/components/FidosStylesScreen.tsx");
  const server = read("server.ts");
  assert.match(screen, /FULL_WARDROBE_CATALOG\.some/);
  assert.match(screen, /FULL_WARDROBE_CATALOG\.filter/);
  assert.match(server, /WAGS_EXCLUSIVE_ITEM_IDS/);
  assert.match(
    server,
    /getOwnedWardrobeItems\(getPool\(\), req\.user!\.phone\)/,
  );
  assert.match(server, /This Wags wardrobe item has not been delivered/);
});

/* ------------------------------------------------------------------ */
/* Server wiring + UI contracts                                         */
/* ------------------------------------------------------------------ */

test("approval delivers and user endpoints exist", () => {
  const server = read("server.ts");
  assert.match(
    server,
    /deliverBox\(getPool\(\)/,
    "approve must call deliverBox",
  );
  assert.match(server, /app\.get\("\/api\/wags\/boxes"/);
  assert.match(server, /app\.post\("\/api\/wags\/boxes\/:id\/open"/);
  assert.match(server, /app\.get\("\/api\/wags\/wardrobe"/);
  // The open endpoint must be scoped to the owner and one-shot.
  assert.match(
    server,
    /opened_at = CURRENT_TIMESTAMP\s+WHERE id = \? AND user_phone = \? AND opened_at IS NULL/,
  );
});

test("texturizer is visibly gated as digital-only", () => {
  const screen = read("src/components/FidosStylesScreen.tsx");
  assert.match(screen, /Digital only — textures/);
  assert.match(screen, /single-color/);
  // And no AI texture endpoint was added (T2 gated out by the print finding).
  const server = read("server.ts");
  assert.doesNotMatch(server, /api\/fidos\/texture|api\/texturize/);
});

test("wags inbox screen is wired into the app", () => {
  const app = read("src/App.tsx");
  assert.match(app, /Screen\.WAGS_INBOX[\s\S]{0,300}WagsInboxScreen/);
  const nav = read("src/shellNavigation.ts");
  assert.match(nav, /Screen\.WAGS_INBOX/);
});
