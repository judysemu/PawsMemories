# Deployment 2 Famous Portraits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Famous Portraits, Historic Pawprints, and the Fur Reels customer experience as the first production release.

**Architecture:** A shared, schema-validated portrait catalog is the single source of truth for homepage browsing and Historic Pawprints selection. Customer-visible sports records use only generalized archetypes and fictional marks, while private provenance retains source verification. Fur Reels remains the existing durable eight-second video workflow but receives the approved navigation, directing guidance, scripts, and dashboard layout.

**Tech Stack:** React 19, TypeScript, Zod, Tailwind CSS, Node test runner, Vite, existing Stripe/Printful and AI-video APIs.

## Execution status

- Catalog: implemented in commit `5ba6980`.
- Homepage: implemented in commit `40d137d`.
- Historic Pawprints: implemented in commit `f84fe59`.
- Fur Reels: implemented in commit `aeec53f`.
- Release verification: Deployment 2 focused suites and TypeScript pass under Node 24.18; the production build completes. The repository-wide run reached 891 passes before being stopped in a long real-MySQL section with baseline migration failures caused by missing `generation_jobs` parent tables in isolated fixtures.

## Global Constraints

- Deployment 2 ships before the functional model hotfix.
- Preserve the existing server-owned Stripe and Printful configuration boundary.
- Do not expose athlete, team, league, sponsor, or signature names in public sports content.
- Use fictional sports marks such as `PURRS`; retain jersey numbers only when source-verified.
- Sports without stable jersey numbers receive no invented number.
- Use real, versioned asset paths with dimensions, SHA-256, provenance, alt text, and availability.
- Keep customer language understandable without 3D or animation expertise.
- Use Node 24.18 for verification and packaging.

---

### Task 1: Schema-validated Famous Portraits catalog

**Files:**
- Modify: `shared/historicalPetCatalog.ts`
- Create: `tests/famous_portraits_catalog.test.mjs`

**Interfaces:**
- Consumes: existing `HistoricalAssetSchema` asset integrity contract.
- Produces: `FAMOUS_PORTRAIT_CATEGORIES`, `FAMOUS_PORTRAIT_CATALOG`, `FAMOUS_PORTRAIT_BY_ID`, `FamousPortraitRecord`, and `publicFamousPortraitCatalog()`.

- [ ] **Step 1: Write the failing catalog contract test**

```js
test("Famous Portraits contains the approved category minimums", () => {
  assert.ok(byCategory("historic-women").length >= 8);
  assert.ok(byCategory("leaders").length >= 10);
  assert.ok(byCategory("sports-legends").length >= 22);
});

test("public sports records contain fictional branding and no protected names", () => {
  for (const portrait of publicFamousPortraitCatalog().filter((item) => item.category === "sports-legends")) {
    assert.doesNotMatch(JSON.stringify(portrait), FORBIDDEN_PUBLIC_SPORTS_NAMES);
    assert.ok(portrait.fictionalMark || portrait.uniformNumber === null);
  }
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the exports do not exist**

Run: `PATH=/Users/robert/.nvm/versions/node/v24.18.0/bin:$PATH npm exec -- tsx --test tests/famous_portraits_catalog.test.mjs`

Expected: FAIL because `FAMOUS_PORTRAIT_CATALOG` and `publicFamousPortraitCatalog` are not exported.

- [ ] **Step 3: Implement the typed catalog and public projection**

```ts
export const FamousPortraitCategorySchema = z.enum([
  "historic-women", "leaders", "sports-legends", "myth-holiday", "arts-adventure",
]);

export function publicFamousPortraitCatalog() {
  return FAMOUS_PORTRAIT_CATALOG.map(({ inspirationSource: _source, numberSource: _numberSource, ...publicRecord }) => publicRecord);
}
```

Records without finished owned imagery use a versioned collection placeholder asset and `availability: "coming-soon"`; no route claims they are purchasable until their final hashed asset is present.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `PATH=/Users/robert/.nvm/versions/node/v24.18.0/bin:$PATH npm exec -- tsx --test tests/famous_portraits_catalog.test.mjs`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit the catalog unit**

```bash
git add shared/historicalPetCatalog.ts tests/famous_portraits_catalog.test.mjs
git commit -m "feat: add famous portraits catalog"
```

### Task 2: Famous Portraits homepage experience

**Files:**
- Modify: `src/components/HeroScroller.tsx`
- Modify: `src/components/HomePage.tsx`
- Create: `src/components/FamousPortraits.tsx`
- Create: `tests/famous_portraits_home.test.mjs`

**Interfaces:**
- Consumes: `publicFamousPortraitCatalog()` and `FamousPortraitRecord` from Task 1.
- Produces: `FamousPortraits({ onOpenPawprints })` with accessible category tabs and cards.

- [ ] **Step 1: Write the failing homepage behavior test**

```js
test("homepage replaces Featured Models with Famous Portraits", () => {
  assert.match(home, /<FamousPortraits/);
  assert.doesNotMatch(home, />Featured Models</);
  assert.match(portraits, /role="tablist"/);
  assert.match(portraits, /Historic Women/);
  assert.match(portraits, /Sports Legends/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails on the missing component**

Run: `PATH=/Users/robert/.nvm/versions/node/v24.18.0/bin:$PATH npm exec -- tsx --test tests/famous_portraits_home.test.mjs`

Expected: FAIL because `FamousPortraits.tsx` and its homepage mount do not exist.

- [ ] **Step 3: Add the responsive collection component and route actions to Pawprints**

```tsx
<section aria-labelledby="famous-portraits-title">
  <div role="tablist" aria-label="Famous Portrait categories">...</div>
  <div aria-live="polite">{visiblePortraits.map(renderPortraitCard)}</div>
</section>
```

Finished records display their owned preview; coming-soon records display an honest art-directed placeholder card with no broken image request. Every action calls `onOpenPawprints()`.

- [ ] **Step 4: Run the focused homepage and historical tests**

Run: `PATH=/Users/robert/.nvm/versions/node/v24.18.0/bin:$PATH npm exec -- tsx --test tests/famous_portraits_home.test.mjs tests/historical_animation_sound.test.mjs`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit the homepage unit**

```bash
git add src/components/FamousPortraits.tsx src/components/HomePage.tsx src/components/HeroScroller.tsx tests/famous_portraits_home.test.mjs
git commit -m "feat: launch famous portraits homepage"
```

### Task 3: Historic Pawprints entry and allowlisted templates

**Files:**
- Modify: `src/components/PawprintsStudio.tsx`
- Modify: `server/pawprintProducts.ts`
- Create: `shared/historicPawprintTemplates.ts`
- Create: `tests/historic_pawprints.test.mjs`

**Interfaces:**
- Consumes: the public catalog from Task 1 and existing `/api/pawprints/printful-order` contract.
- Produces: `HISTORIC_DIGITAL_TEMPLATES`, `HISTORIC_PHYSICAL_TEMPLATE_IDS`, and two customer entry choices.

- [ ] **Step 1: Write the failing Historic Pawprints contract test**

```js
test("Pawprints begins with the two approved historic products", () => {
  assert.match(studio, /Historic Pawprint Pet Digital/);
  assert.match(studio, /Pawprint Pet Physical/);
  assert.doesNotMatch(studio, />Digital Only</);
  assert.doesNotMatch(studio, />Digital \+ Printed</);
});

test("physical templates remain server allowlisted", () => {
  assert.deepEqual(HISTORIC_PHYSICAL_TEMPLATE_IDS, [
    "the-composer", "joan-of-arc", "cleopatra", "santa", "the-chef",
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify it fails on the old entry copy and missing template exports**

Run: `PATH=/Users/robert/.nvm/versions/node/v24.18.0/bin:$PATH npm exec -- tsx --test tests/historic_pawprints.test.mjs`

Expected: FAIL on the old Digital Only entry and missing template module.

- [ ] **Step 3: Implement the historic entry, template filtering, and safe physical selection**

```ts
export const HISTORIC_PHYSICAL_TEMPLATE_IDS = [
  "the-composer", "joan-of-arc", "cleopatra", "santa", "the-chef",
] as const;
```

The client sends only the existing `productCode`; configured variant IDs and prices remain server-owned. A coming-soon digital portrait is visibly disabled and cannot enter rendering or checkout.

- [ ] **Step 4: Run Pawprints, Printful, and fulfillment focused tests**

Run: `PATH=/Users/robert/.nvm/versions/node/v24.18.0/bin:$PATH npm exec -- tsx --test tests/historic_pawprints.test.mjs tests/printful_fulfillment.test.mjs tests/pawprints_manual_studio.test.mjs`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit the Historic Pawprints unit**

```bash
git add shared/historicPawprintTemplates.ts src/components/PawprintsStudio.tsx server/pawprintProducts.ts tests/historic_pawprints.test.mjs
git commit -m "feat: add historic pawprints choices"
```

### Task 4: Fur Reels navigation, scripts, and first-viewport dashboard

**Files:**
- Modify: `src/shellNavigation.ts`
- Modify: `src/seo.ts`
- Modify: `server/seoMeta.ts`
- Modify: `src/aiVideoScripts.ts`
- Modify: `src/components/AnimationStudio.tsx`
- Create: `tests/fur_reels_experience.test.mjs`

**Interfaces:**
- Consumes: existing `createVideo`, `pollJob`, and `createVoicePreview` APIs.
- Produces: customer-visible Fur Reels navigation, thirteen or more eight-second templates, upload/recent-image panel, persistent directing guidance, and tracked results copy.

- [ ] **Step 1: Write the failing Fur Reels experience test**

```js
test("customer video generation is branded Fur Reels", () => {
  assert.match(shell, /label: "Fur Reels"/);
  assert.doesNotMatch(shell, /label: "AI Video"/);
  assert.match(studio, />Fur Reels</);
  assert.match(studio, /What works best/);
  assert.match(studio, /Upload another photo/);
});

test("the customer script catalog includes the five approved additions", () => {
  for (const id of ["moonlight-maestro", "joans-banner", "santas-workshop-surprise", "cleopatras-golden-entrance", "rock-star-encore"]) {
    assert.ok(AI_VIDEO_SCRIPTS.some((script) => script.id === id));
  }
});
```

- [ ] **Step 2: Run the focused test and verify it fails on old branding and missing scripts**

Run: `PATH=/Users/robert/.nvm/versions/node/v24.18.0/bin:$PATH npm exec -- tsx --test tests/fur_reels_experience.test.mjs`

Expected: FAIL on `AI Video`, the missing guide, and missing template IDs.

- [ ] **Step 3: Implement Fur Reels without changing provider persistence semantics**

```tsx
<main className="lg:h-[calc(100dvh-var(--shell-height))] lg:overflow-hidden">
  <div className="lg:grid lg:h-full lg:grid-cols-[.8fr_1.35fr_.9fr]">
    <section className="lg:overflow-y-auto">Your uploads</section>
    <section className="lg:overflow-y-auto">Direct your reel</section>
    <aside className="lg:overflow-y-auto">Voice, frame, and result</aside>
  </div>
</main>
```

The upload action uses the repository's existing bounded image-upload path. Completed output copy states that reels are saved to the account; failed tracked jobs retain the current server refund and persistence behavior.

- [ ] **Step 4: Run Fur Reels, navigation, video contract, and animator handoff tests**

Run: `PATH=/Users/robert/.nvm/versions/node/v24.18.0/bin:$PATH npm exec -- tsx --test tests/fur_reels_experience.test.mjs tests/shell_navigation.test.mjs tests/video_creation_contract.test.mjs tests/animator_handoff.test.mjs`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit the Fur Reels unit**

```bash
git add src/shellNavigation.ts src/seo.ts server/seoMeta.ts src/aiVideoScripts.ts src/components/AnimationStudio.tsx tests/fur_reels_experience.test.mjs
git commit -m "feat: launch fur reels experience"
```

### Task 5: Deployment 2 release verification and documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md` if present, otherwise modify the repository's canonical architecture document found with `rg --files docs | rg -i 'architecture'`.
- Modify: `docs/superpowers/plans/2026-08-01-deployment-2-famous-portraits.md`

**Interfaces:**
- Consumes: completed Tasks 1 through 4.
- Produces: release documentation, verification evidence, and a committed Deployment 2 checkpoint.

- [ ] **Step 1: Document the customer flow and operational boundaries**

```markdown
Famous Portraits uses a public-safe projection of the shared catalog. Historic Pawprints preserves server-owned Printful product and Stripe checkout configuration. Fur Reels creates tracked eight-second AI-video jobs and stores completed results in the signed-in customer's creations.
```

- [ ] **Step 2: Run focused tests, type checking, and production build under Node 24.18**

Run: `PATH=/Users/robert/.nvm/versions/node/v24.18.0/bin:$PATH npm test`

Run: `PATH=/Users/robert/.nvm/versions/node/v24.18.0/bin:$PATH npm run lint`

Run: `PATH=/Users/robert/.nvm/versions/node/v24.18.0/bin:$PATH npm run build`

Expected: each command exits zero. Any failure is reported with its exact failing check; testing is evidence, not a fabricated deployment blocker.

- [ ] **Step 3: Inspect the production artifact for public-sports safety and real assets**

Run: `rg -n "BULLS|Jordan|Brady|Gretzky|Ohtani|Serena Williams" dist public/collections/historical-pets`

Expected: no customer-facing protected sports names or copied team mark; private source maps are excluded from production or do not expose private provenance fields.

- [ ] **Step 4: Record exact commit and archive evidence**

Run: `git rev-parse HEAD`

Run: `shasum -a 256 pawsome3d-deploy.zip`

Expected: one exact `main` SHA and one archive SHA-256 are recorded in the release handoff.

- [ ] **Step 5: Commit the release documentation**

```bash
git add README.md docs/ARCHITECTURE.md docs/superpowers/plans/2026-08-01-deployment-2-famous-portraits.md
git commit -m "docs: document deployment 2 release"
```
