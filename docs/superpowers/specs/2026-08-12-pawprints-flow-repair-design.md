# Pawprints Flow Repair — Architectural Specification

**Date:** 2026-08-12
**Status:** Proposed — awaiting product decision on §6 before implementation
**Scope:** `Keepsake → Portrait → Photo → Finish` wizard (`src/components/PawprintsStudio.tsx`), `POST /api/pawprints/generate` (`server.ts`), and the template catalog (`shared/historicPawprintTemplates.ts`, `shared/historicalPetCatalog.ts`)

## 1. Problem statement

Customers report that the premade portrait template they choose in the **Portrait** step, and the design they see updating live in the **Finish** step's Live Preview, is not what actually gets saved, emailed, or printed. This is confirmed and reproducible for every title under the "Historic Pawprint" product line — roughly 130 of the ~140 titles in the catalog. It is not a display glitch or a caching bug; it is two structurally different rendering pipelines wired to the same UI, and the client-visible one is not the one that ships.

## 2. Root cause

**There are three different images involved in a Historic Pawprint purchase, and only the third is what the customer receives:**

1. **The premade template thumbnail** shown while picking a title in the Portrait step.
2. **The Live Preview** shown while editing in the Finish step.
3. **The delivered asset** — what's actually saved to Fur Bin, emailed, and sent to Printful.

(1) and (2) come from a client-side canvas compositor. (3) comes from a live, non-deterministic AI image-generation call that ignores almost everything the customer saw and edited. They were never reconciled.

### 2.1 What the Finish-step Live Preview actually renders

`PawprintsStudio.tsx:763-790` — a debounced `useEffect` that calls `renderPawprint()` on every edit to `variation`, `photos`, `title`, `message`, or `category`:

```
renderPawprint({ variation, photos, title, message, category, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, quality: 0.82 })
```

`renderPawprint()` (`PawprintsStudio.tsx:352-435`) is a **manual stationery compositor**: it fills a canvas with a flat category color palette (`CATEGORY_META`, line 126), crops the customer's *own uploaded photo* into one of 12 layout shapes (`VARIATIONS`, line 111, via `planPawprintCollage()` in `src/pawprints/collageEngine.ts`), and draws the edited title/message with `drawFittedTextBlock()`. **This is the same function for every category, including `historic_portraits`.** The customer's uploaded selfie of their pet — not the illustrated "Joan of Arc" / "Rock Star" / "Championship Boxer" scene they picked — is what's cropped into the preview.

The code comment directly above this effect (lines 753-762) states: *"This runs the identical renderPawprint pipeline... the full-resolution render stays exclusive to the paid Save."* That claim is false for AI-portrait categories — see 2.3.

### 2.2 What the premade template actually is

`shared/historicPawprintTemplates.ts` defines each of the ~140 titles as an `imagePromptTemplate` string (a text description of a scene: armor, stagewear, boxing robe, etc. — lines 17-36), not a static image asset the app can composite. A title is a **generation prompt**, not artwork.

Only the original 20 roles (`HISTORIC_ROLE_IDS`, line 52) have a real thumbnail at all, sliced from one shared contact sheet (`roleSheetStyle()`, `PawprintsStudio.tsx:520`, keyed by array position in `HISTORIC_ROLE_IDS`). The ~120 titles generated from `historicalPetCatalog.ts` (`ADDITIONAL_TEMPLATES`, `historicPawprintTemplates.ts:84-112`) mostly have **no thumbnail at all** in the picker grid — the "premade template" the customer taps often isn't a picture yet, just a name and a hidden prompt.

### 2.3 What Save actually submits and the server actually saves

`server.ts:3232-3270`, inside `POST /api/pawprints/generate`:

```
const isAiPortraitCategory =
  category === "historic_portraits" ||
  ["historic-women","leaders","sports-legends","myth-holiday","arts-adventure","halloween","landmarks"].includes(category);

if (isAiPortraitCategory) {
  // ...builds historicPrompt from template.imagePromptTemplate + identity photos...
  const generated = await generateImageWithFallback([...inlineParts, { text: historicPrompt }], ...);
  sourceBuffer = Buffer.from(generatedMatch[2], "base64");
} else {
  // Standard Pawprints: use req.body.renderedImage — the canvas composite from the client
  ...
}
```

For every category in that `isAiPortraitCategory` list — i.e. the entire Historic Pawprint line — the server **discards `req.body.renderedImage` entirely** (the thing Live Preview showed and the client spent CPU rendering at `save()`, `PawprintsStudio.tsx:921`) and instead makes a fresh Gemini/Nano-Banana call using only `template.imagePromptTemplate` and the raw pet photo(s). Two further consequences fall out of `historicPrompt`'s construction (`server.ts:3253-3259`):

- It never references `customName` or `customMessage`. The "Your Words" title/message the customer typed and watched get fitted into the Live Preview text block **never appears in the delivered image.**
- It never references `variation` (Classic/Split/Frame/Polaroid/etc.). The layout picker is a no-op for this entire product line.
- Being a live generative call, it is **not deterministic** — it won't reliably reproduce even its own prompt twice, let alone the manual composite the customer approved.

`tests/pawprints_manual_studio.test.mjs:21` and `tests/historic_pawprints.test.mjs:58` confirm this split is intentional at the API layer — there is no test anywhere asserting Live Preview matches the saved asset for AI-portrait categories, because today it structurally cannot.

### 2.4 Why "Standard Pawprints" don't have this bug

For everything *outside* the `isAiPortraitCategory` list (categories like `grieving_loss`, `new_puppy`, `holiday_birthday`, etc.), the server takes `req.body.renderedImage` directly — the exact bytes the client's `renderPawprint()` produced. Preview and Save are the same pipeline, so they agree. This is the one part of the system working as designed, and it's the reference behavior the fix should generalize.

## 3. Current architecture

```
Portrait step          Finish step (Live Preview)         Save (POST /api/pawprints/generate)
─────────────          ───────────────────────────         ────────────────────────────────────
title/prompt   ──┐      renderPawprint({photos, text,       if AI-portrait category:
picked from    ──┼──►     variation, category})               generateImageWithFallback(
catalog           │       = manual canvas composite             identity photos + imagePromptTemplate)
(often no         │       of the customer's OWN photo          → non-deterministic AI image
thumbnail)        │       + edited text, drawn over a          → ignores renderedImage, title,
                   │       flat color background                 message, variation entirely
                   └────────────────┐
                                     ▼                       else (Standard Pawprints):
                            customer believes this is         uses req.body.renderedImage
                            what they're buying               → matches what they saw ✔
```

Two independent render implementations exist for one wizard. They coincidentally agree for one branch of categories and structurally diverge for the other, larger branch, with no test or runtime check that would catch the divergence.

## 4. Target architecture

Collapse this into a single **two-stage pipeline** that both Live Preview and Save call identically, for every category:

```
Stage 1 — Subject Art               Stage 2 — Composite (existing renderPawprint(), unchanged)
────────────────────                ─────────────────────────────────────────────────────────
Standard categories:                 Takes Stage 1's output as the "photo" input.
  subject art = the customer's       Applies variation layout (Classic/Split/Frame/...),
  uploaded photo(s), unchanged.      category palette, gradient/frame treatment, and
                                      drawFittedTextBlock(title, message) — same for
AI-portrait categories:              every category.
  subject art = one cached
  Gemini/Nano-Banana generation,
  keyed by (template, photo-hash).
```

The defining property: **Stage 1 output is generated once and cached; Stage 2 is the only thing that re-runs on every keystroke.** Live Preview and Save both run Stage 1 → Stage 2 against the same cached Stage 1 result, so they are the same image by construction — there is no longer a code path where Save can diverge from what was previewed.

### 4.1 Sequencing in the wizard

1. **Portrait step** — customer picks a title. For AI-portrait categories, the picker shows either a real premade thumbnail (see §6.2) or a clearly labeled "style preview" — never claims to be the exact delivered art.
2. **Photo step** — customer supplies photo(s).
3. **On entering Finish** (not on every keystroke) — if the category is AI-portrait and no cached Stage 1 result exists for `(template.layoutId, hash(photos))`, fire **one** `generateImageWithFallback` call, show a generation-in-progress state, cache the result server-side keyed to the user+template+photo-hash.
4. **Within Finish**, editing title/message/variation re-runs only Stage 2 (`renderPawprint()`), instantly and for free, using the cached Stage 1 art as the photo input — identical mechanism to how Standard Pawprints already work.
5. **Save** persists whatever Stage 2 currently renders. If the cached Stage 1 art is still valid, no new AI call happens at Save time at all — Save becomes a cheap finalize step, not a second generation.

### 4.2 Why compositing text after generation, not inside the prompt

Baking `customName`/`customMessage` into the AI prompt (asking the model to render legible text) is unreliable — image models routinely garble typography. Keeping text as a Stage 2 canvas overlay (as Standard Pawprints already do) is deterministic, testable, and immediately fixes the "my message never shows up" complaint without depending on model text-rendering quality.

## 5. API / data changes

- **New (or repurposed) endpoint** for Stage 1: e.g. `POST /api/pawprints/generate-subject` — takes `layoutId`, `mode`, `photoBase64List`; returns a cached/generated subject-art image + a `subjectArtId`. This replaces the AI-generation branch currently inlined in `POST /api/pawprints/generate` (`server.ts:3236-3270`).
- **`POST /api/pawprints/generate` becomes uniform**: every category now takes `req.body.renderedImage` (the Stage 2 composite) the same way the `else` branch already does today (`server.ts:3271-3284`). The `isAiPortraitCategory` branch and its special-cased credit/validation logic can be deleted once Stage 1 is split out.
- **Caching table**: a small `pawprint_subject_art` (or reuse `pawprint_assets` with a `stage` column) keyed on `(user_phone, layout_id, photo_hash)` with the generated image URL, so re-entering Finish for the same template+photos doesn't re-trigger billed generation.
- **Credit timing moves earlier**: today, `reserveCredits()` happens at Save (`server.ts:3223`). Under this design, the AI call — the expensive part — happens at Stage 1 (entering Finish or an explicit "Generate" action), so credit reservation needs to move there. This is a product/pricing decision, not just engineering — flagged in §6.1.

## 6. Open decisions (need product sign-off before implementation)

### 6.1 Where does the 75-PupCoin charge happen?

Two options:
- **(a) Charge on Stage 1** ("Generate my art" costs PupCoins immediately after Photo step), and Finish/Save become free editing + finalize. Matches the new cost reality — the AI call is the expensive step — but changes the flow's spend point from what customers currently experience.
- **(b) Keep the charge at Save**, but make Stage 1 generation happen automatically and invisibly when they reach Finish, gated by a soft per-design rate limit (e.g. one free regeneration on template swap, explicit "Regenerate" button after that) to prevent generation-cost abuse from customers who never buy.

Recommendation: (b) preserves the current purchase psychology (see the design at the price only when committing) while still fixing the mismatch, provided the rate limit is tight enough to bound AI spend from abandoned carts.

### 6.2 Premade thumbnails for the ~120 catalog-derived titles

`roleSheetStyle()` only covers the original 20 roles. The other titles show blank tiles in the picker today. Recommend a one-time offline job that runs Stage 1 generation against a small set of representative stock pet photos for every catalog title and stores the result as `previewAsset` on `historicalPetCatalog.ts` entries — turning "blank tile with a name" into an actual premade-template thumbnail, and reusing the exact same Stage 1 code path so the thumbnail is honestly representative of what a customer's own photo will produce.

### 6.3 `coming-soon` catalog entries are currently offered for purchase

`historicalPetCatalog.ts` entries carry `availability: "available" | "coming-soon"`, but nothing in `db.ts`, `server.ts`, or `PawprintsStudio.tsx` filters on it (confirmed via `getPawprintTemplatesSync()` and the catalog build in `db.ts:3768-3805`). Customers can currently select and pay for titles the product considers not-yet-shippable. This should be filtered server-side in `getPawprintTemplatesSync()` regardless of which option is chosen above — it's a pure bug, not a design trade-off.

## 7. Testing plan

- New contract test: for every category, assert `renderPawprint()`'s output bytes at Save time are byte-identical (or hash-identical after the same lossy encode) to the last Live Preview render for the same inputs — this is the regression guard that would have caught the original bug.
- Extend `tests/historic_pawprints.test.mjs` to assert `customName`/`customMessage` appear in the final composited asset (verifiable once they're a Stage 2 text overlay rather than a prompt fragment).
- Extend `tests/pawprints_manual_studio.test.mjs` to assert Stage 1 is called at most once per `(template, photo-hash)` across a Finish-step editing session (proves caching prevents double-billing AI calls).
- Add a filter test asserting `coming-soon` catalog entries never appear in `GET /api/pawprints/templates`.

## 8. Rollout

1. Ship §6.3 filter fix alone first — it's a zero-risk, high-value bug fix independent of the rest of this spec.
2. Land Stage 1/Stage 2 split behind the existing category branch, with Stage 1 caching, without changing the credit-charge timing (keep current Save-time charge; just make Save reuse the cached Stage 1 art instead of regenerating) — this alone makes Save match Preview.
3. Once stable, revisit §6.1's charge-timing question and §6.2's thumbnail backfill as follow-on work.
