import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");
const app = read("src/App.tsx");
const store = read("src/components/Store.tsx");
const home = read("src/components/HomePage.tsx");
const voice = read("src/components/VoiceFlowTest.tsx");
const api = read("src/api.ts");
const bimPreview = read("src/components/BimPreviewScreen.tsx");
const shell = read("src/shellNavigation.ts");
const hero = read("src/components/HeroScroller.tsx");
const profile = read("src/components/ProfileScreen.tsx");
const printShop = read("src/components/PrintShopScreen.tsx");
const creditStore = read("src/components/CreditStore.tsx");
const randy = read("src/components/RandyChat.tsx");
const petModelStudio = read("src/components/PetModelStudio.tsx");
const requestMemory = read("src/components/RequestMemory.tsx");
const editMemory = read("src/components/EditMemory.tsx");

test("Shop cannot expose the retired print request or marketplace panels", () => {
  assert.doesNotMatch(store, /PrintRequestForm|Start a print request|onOpenMarketplace/);
  assert.doesNotMatch(home, /Explore the 3D Pet Marketplace|Browse Marketplace|MARKETPLACE_CATEGORIES/);
  assert.doesNotMatch(app, /MarketplaceScreen|MarketplaceAdminScreen/);
  assert.match(store, /legacy print-request and marketplace forms have been retired/i);
  assert.match(store, /automatic repair and manufacturing validation/i);
  assert.match(store, /onNavigate\(Screen\.CREATE\)/);
  assert.ok(fs.existsSync("src/components/PrintRequestForm.tsx"), "legacy source stays preserved outside the route");
  assert.ok(fs.existsSync("src/components/MarketplaceAdminScreen.tsx"), "admin source stays preserved outside the route");
});

test("unfinished paid request and discount claims are not customer-routable", () => {
  assert.doesNotMatch(app, /import RequestMemory|import AdminRequestPanel/);
  assert.match(app, /normalized === "\/request-memory"\) return Screen\.PAWPRINTS/);
  assert.match(randy, /REQUEST_MEMORY: Screen\.PAWPRINTS/);
  assert.doesNotMatch(hero, /45% OFF|45% off their 3D model|nearly half price/);
  assert.match(hero, /download it or email the finished keepsake/i);
});

test("customer-facing failures are explicit and retryable", () => {
  assert.match(creditStore, /item\.credits === null \? "Unavailable"/);
  assert.match(profile, /role=\{saveMessage\.kind === "error" \? "alert" : "status"\}/);
  assert.match(printShop, /Retry model library/);
  assert.match(printShop, /modelLibraryError/);
});

test("model print sizing is collected only by the checkout that persists it", () => {
  assert.doesNotMatch(petModelStudio, /setPrintHeight|Finished print height/);
  assert.match(petModelStudio, /choose the exact print size in Print Shop/i);
  assert.match(printShop, /targetHeightMm/);
});

test("preserved camera screens stop every media track on unmount", () => {
  for (const source of [requestMemory, editMemory]) {
    assert.match(source, /useEffect\(\(\) => \(\) => \{[\s\S]{0,120}getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  }
});

test("authenticated voice tester uses the real production endpoint with honest states", () => {
  assert.match(app, /Screen\.VOICE_TEST[\s\S]{0,250}VoiceFlowTest/);
  assert.match(api, /authedFetch\("\/api\/animator\/speech-preview"/);
  assert.match(voice, /CREDIT_PRICES\.AI_VOICE_30_SECONDS/);
  assert.match(voice, /"loading" \| "ready" \| "playing" \| "error"/);
  assert.match(voice, /configured ElevenLabs voice/);
  assert.match(voice, /Rhubarb returned/);
  assert.match(voice, /does not certify an individual model's facial rig/);
  assert.match(voice, /role=\{status === "error" \? "alert" : "status"\}/);
  assert.match(voice, /<audio[\s\S]*onTimeUpdate=\{syncShape\}/);
  assert.doesNotMatch(voice, /speechSynthesis|webkitSpeech|new AudioContext/);
});

test("BIM preview is preserved but removed from the Pawsome3D navigation", () => {
  assert.doesNotMatch(shell, /label: "Scaled BIM", screen: Screen\.BIM/);
  assert.match(app, /Screen\.BIM[\s\S]{0,250}BimPreviewScreen/);
  assert.match(bimPreview, /Preview only - unavailable/);
  assert.match(bimPreview, /No image or IFC uploads, credit charges, proposals, or model builds start from this page/);
  assert.doesNotMatch(bimPreview, /authedFetch|buildBim|importIfc|from ["']\.\/BimModelBuilder/);
  assert.ok(fs.existsSync("src/components/BimModelBuilder.tsx"), "builder source must remain preserved");
});

test("new release-correction screens preserve mobile edge spacing", () => {
  for (const source of [store, voice, bimPreview]) {
    assert.match(source, /px-4/);
    assert.match(source, /sm:px-6/);
  }
});
