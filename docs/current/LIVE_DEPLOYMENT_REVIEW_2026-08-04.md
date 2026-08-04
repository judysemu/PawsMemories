# Pawsome3D — Live Deployment Review

**Site:** https://pawsome3d.com
**Reviewed:** 2026-08-04
**Live build:** commit `2ec6057d7fbf7ace704ff205ca3a23d4bd384188` · branch `main` · built `2026-08-04T16:13:38Z` · schema `49`
**Method:** authenticated browser session (Chrome), real DOM/network/console inspection, live API calls, responsive testing at 1440 / 820 / 390 px.

> **Scope honesty.** This is a *live* review — every finding below was observed in the running production app, not inferred from source. Two things were **not** done: no paid generation was executed end to end (see [Not Yet Verified](#not-yet-verified)), and colour-contrast ratios were assessed visually rather than with a sampling tool.

---

## 1. Deployment Verification

The release shipped correctly. This is worth stating plainly because the previous session's fixes changed a fail-open feature gate, and a bad env var would have silently removed a paid product.

| Check | Result |
|---|---|
| `/version` | `2ec6057` · main · schema 49 — matches the packaged zip exactly |
| `/readyz` | `status: ready`, database healthy, latency **1 ms** |
| `/healthz` | `ok` |
| Migration 49 (`avatars.resume_attempts`) | Applied — live schema reports 49 |
| `PET_GLB_BODY_RIG_ENABLED` | **Correctly set to `true`** — `/api/pet-glb/product` returns `rigGeneration.available: true` |
| Static assets | All 200, no 404s, no mixed content |
| Console errors on load | **None** |

**The MG-4 deployment risk did not materialise.** The fail-closed change I shipped could have silently disabled the 35-PupCoin body-rig add-on; the env var is set correctly and the product is live. `facialRig` remains correctly closed with its documented reason.

### Shipped fixes confirmed working in production

| Fix | Status | Evidence |
|---|---|---|
| **PP-1** live preview | ✅ Working | Real render — actual serif typography, palette, fitted text block, photo — updates on edit with debounce. Verified by retyping the title and watching it re-wrap to two lines. |
| **PP-2** role grid | ✅ Working | Searchable grid, 4 category chips, per-role thumbnails sliced from the contact sheet. **Slicing maths verified correct** — Joan of Arc = armoured cat, Cleopatra = jewelled pug, Composer = basset at piano, all match their labels. "See all 20 titles" reveals the rest. |
| **PP-6** stepper | ✅ Working | `1 Keepsake · 2 Portrait · 3 Photo · 4 Finish`, with checkmarks on completed steps. |
| **PP-7** sticky Save | ✅ Working | CTA pinned on narrow viewports. |
| **VG-3** de-timestamped beats | ✅ Working | Live template beats contain no `0-2s:` prefixes. |
| **VG-6** motion-forward copy | ✅ Working | "Describe continuous, lifelike motion…", "avoid static shots". |
| **PP-16** shim removal | ✅ Working | App loads `PawprintsStudio` directly. |

---

## 2. Issues Found

Severity: **P1** = costs money, blocks a user, or hides a paid product · **P2** = real friction or standards violation · **P3** = polish.

### LIVE-1 (P1) — Fur Reels is unreachable from mobile navigation

**File:** `src/shellNavigation.ts:81`

The mobile bottom bar renders **Home · Pawprints · Fur Bin · Wags · Help**. Fur Reels — a 100-PupCoin product — is absent, and so is the 3D build flow.

```ts
export const MOBILE_NAV = SIDEBAR_NAV.filter(
  (item) => item.screen !== Screen.PROFILE
         && item.screen !== Screen.VOICE_TEST
         && item.screen !== Screen.ANIMATOR   // ← Fur Reels
);
```

The stated rule for this filter is "drop destinations that already have a one-tap route from the header." That holds for Profile and Voice Test — both are in `SHELL_ICON_NAV`. It does **not** hold for `ANIMATOR`: `SHELL_ICON_NAV` is `[Create, Voice Test, Pawprints, Profile]`. Fur Reels has no other mobile entry point.

The strongest evidence this was accidental: the bottom-bar renderer in `App.tsx:1147` still carries a dedicated branch for it —

```tsx
onClick={() => item.screen === Screen.ANIMATOR ? openAnimationStudio() : setCurrentScreen(item.screen)}
```

— which was dead code for as long as the filter excluded it.

**✅ Fixed live.** `Screen.ANIMATOR` removed from the filter.
**Trade-off to decide:** the bar now renders 6 columns instead of 5 (~65 px each at 390 px), so labels truncate harder. The grid is computed from `MOBILE_NAV.length + 1` so it cannot overflow, but I'd recommend moving **Help** into the profile overflow menu and returning the bar to 5 slots — a paid module outranks a help link for primary navigation. That change needs a check that Help is reachable from the overflow first, so I left it for you.

---

### LIVE-2 (P1) — `POST /api/streak/claim` returns HTTP 400 on every page load

**File:** `server.ts:3615`

The client fires this once per page load. On every visit after the first each day the server answered:

```
POST /api/streak/claim → 400  {"success":false,"error":"Streak already claimed today"}
```

Already having claimed today is the expected, benign, idempotent outcome — not a malformed request. Returning 4xx for it means every normal session logs a client fault, which pollutes error monitoring and trains you to ignore real 400s.

**✅ Fixed live.** Now returns 200 with `{success: true, alreadyClaimed: true, message, user}`. The client can branch on `alreadyClaimed`.

> **Follow-up needed:** confirm no client code treats a non-2xx from this endpoint as the "already claimed" signal. A grep showed no such dependency, but this endpoint is fire-and-forget so behaviour is easy to miss.

---

### LIVE-3 (P1) — "PUPCOINS 88" reads as a wallet balance but is a price

**File:** `src/components/PetModelStudio.tsx:777`

The Create workspace header shows four stat tiles: `STAGE · OVERALL PROGRESS · PUPCOINS 88 · SAVED BUILDS 0`.

**88 is not the customer's balance — it is the cost of the configured build** (base 45 + texture 8 + rig 35). The signed-in account used for this review holds **10,005 PupCoins**. A tile labelled "PupCoins" sitting beside "Saved builds" reads unmistakably as a wallet, so a customer can look at a healthy balance and conclude it has collapsed to 88 — or, worse, that they cannot afford the thing they are configuring.

**✅ Fixed live.** Relabelled to **"This build costs · 88 PupCoins"**, switching to **"Reserved for this build"** once an order exists, with the unit rendered inline so the number can never be read bare.

**Still recommended:** show the actual balance somewhere in this workspace. Right now the Create module never displays what the customer has, only what things cost.

---

### LIVE-4 (P2) — Fur Reels lives at `/animator`; `/fur-reels` silently lands on the homepage

Navigating to `https://pawsome3d.com/fur-reels` — the obvious guessable URL for a product called "Fur Reels" — returns **200 with the homepage**, sidebar highlighting "Home". No redirect, no 404.

Two problems compound here:

1. **Naming drift.** The module is branded "Fur Reels" everywhere in the UI and its `<title>` is "Fur Reels - AI Pet Videos", but the route is the legacy `/animator`. Shared links, docs, and support replies will use the brand name and land people on the wrong page.
2. **Soft 404s app-wide.** *Every* unknown path returns 200 with the app shell — `/this-route-does-not-exist` included. Search engines index junk URLs, and users get no signal they mistyped.

**Recommended (not applied — needs a routing decision):** add `/fur-reels` as the canonical path with a 301 from `/animator`, and return a real 404 status for unmatched routes.

---

### LIVE-5 (P2) — Nested `<main>` landmarks in Pawprints

**File:** `src/components/PawprintsStudio.tsx` (4 sites)

All four wizard steps rendered `<main>` **inside** App's own `<main>`. A page may have only one main landmark (WCAG 1.3.1); a screen-reader user jumping "to main" landed ambiguously.

**✅ Fixed live.** All four converted to `<div>`. App's `<main>` remains the single landmark.

---

### LIVE-6 (P2) — No skip link

A keyboard or screen-reader user had to tab through the header plus every sidebar destination on **every route change** before reaching content. WCAG 2.4.1 (Bypass Blocks).

**✅ Fixed live.** Added a visually-hidden "Skip to main content" link that appears on focus, targeting `#main-content` on App's `<main>` (`tabIndex={-1}` so it accepts programmatic focus).

---

### LIVE-7 (P2) — Touch targets below 44 × 44 px

WCAG 2.5.5. Measured live on the homepage — 22 controls under the threshold. Worst offenders:

| Control | Size |
|---|---|
| Carousel pagination dots (×4) | **8 × 8 px** |
| `DOG` / `CAT` toggles | 44 × 23 px |
| `SIT` / `WAVE` / `SPIN` / `TREAT` | 63 × 31 px |
| Logo / home button | 36 × 36 px |
| Sidebar destinations | 199 × 40 px |

The 8 px dots are the serious one — effectively untappable on a phone. The standard fix is to keep the *visual* dot small and wrap it in a 44 px transparent hit area (the same pattern I applied to the walkthrough step dots in PP-14).

---

### LIVE-8 (P2) — Tablet (768–1023 px) wastes a quarter of the viewport

At 820 px the 224 px sidebar stays fixed, leaving ~596 px of content. On the Create module this pushes the live model viewer — the entire point of the screen — completely below the fold; you see only the photo picker. Stat labels truncate ("OVERALL PROGRE…"). Fur Reels renders a nested scroll container inside the page scroll, giving two scrollbars.

**Recommended:** collapse the sidebar to an icon rail (~72 px) between `md` and `lg`, or switch to the mobile bottom bar below 1024 px.

---

### LIVE-9 (P3) — Randy chat bubble overlaps content

The 56 × 56 px floating companion sits at the bottom-right on every screen and overlays real content — at 390 px it covers part of the second Pawprints card, and `document.elementFromPoint` at its centre returns the preview `CANVAS` beneath it. It also sits directly above the mobile tab bar, crowding an already tight zone.

**Recommended:** offset it above the bottom bar on small screens, and let it collapse to a slim tab after first interaction.

---

### LIVE-10 (P3) — "Upload or choose a photo" offers no way to *choose*

Both the Pawprints photo step and the Create workspace say "Upload **or choose** a photo", but the only affordance is a file picker. Users with existing creations in their Fur Bin cannot reuse them — a real friction point given the app's whole premise is that you already have pet images in it.

---

### LIVE-11 (P3) — Post-upload CTA falls below the fold

On the Pawprints photo step, adding a photo inserts a thumbnail grid that pushes **Continue** off-screen with no scroll cue. I hit this myself during review — my first click landed on the thumbnail instead. Same sticky-CTA treatment as PP-7 would fix it.

---

### LIVE-12 (P3) — Copy/schema drift in Fur Reels

VG-3 relaxed the beat schema from a fixed 4-tuple to 3–6 beats, but the UI still promised **"Four timed stage directions"** and *"Exactly 8 seconds · four directed beats"*.

**✅ Fixed live.** Now "Stage directions, in order" and "directed beats that flow together".

---

### LIVE-13 (P3) — Empty `alt` on a meaningful image

`fur-reels-icon.png` ships `alt=""`. Correct for pure decoration; wrong if it's the module's identifying mark next to a text label — but here it *is* paired with the visible text "Fur Reels", so `alt=""` is arguably right. Flagging for a deliberate decision rather than an accident.

---

## 3. Accessibility Audit (WCAG 2.1 AA)

### Passing

- **Semantics** — no unlabeled interactive controls anywhere on the landing page (53 checked); every button resolves an accessible name.
- **Images** — no missing `alt` attributes.
- **Headings** — clean single `h1`, logical `h2`/`h3` nesting, no skipped levels.
- **Language** — `lang="en-US"` set.
- **Reduced motion** — `prefers-reduced-motion` media queries present in the stylesheet.
- **Focus visibility** — `:focus-visible` rules present.
- **Landmarks** — `main`, `nav`, `header` present (see LIVE-5 for the nesting defect).
- **Zoom/viewport** — `width=device-width, initial-scale=1.0` with no `maximum-scale` lock.
- **Mobile layout** — sidebar collapses cleanly to a bottom bar; stepper wraps well.

### Failing / needs work

| Criterion | Issue | Ref |
|---|---|---|
| 2.4.1 Bypass Blocks | No skip link | LIVE-6 ✅ fixed |
| 1.3.1 Info & Relationships | Nested `main` landmarks | LIVE-5 ✅ fixed |
| 2.5.5 Target Size | 22 controls under 44 px; dots at 8 px | LIVE-7 |
| 1.4.10 Reflow | Tablet range wastes viewport; double scrollbars | LIVE-8 |
| — | No `<footer>` landmark anywhere | — |

**Not tested:** colour contrast ratios (needs a sampling pass — the warm cream-on-cream palette is the risk area), and a real screen-reader run (VoiceOver/NVDA). Both are worth doing before any accessibility claim is made publicly.

### SEO / meta — strong

Canonical URLs, Open Graph with `summary_large_image`, per-route titles and descriptions, and **3 JSON-LD blocks** on the homepage. The one weakness is the soft-404 behaviour in LIVE-4.

---

## 4. Module-by-Module Flow Improvements

### 4.1 Create — Build your pet in 3D

Current flow: photo → model finish → colour → build journey (360° views → base mesh → texture → rig readiness → rig → Fur Bin).

1. **Show the balance, not just the price.** The workspace displays what the build costs but never what the customer has. Add "You have 10,005 PupCoins" beside the cost so the affordability question is answered without leaving.
2. **Make the Build Journey explain itself.** Six stage names sit inert before a build starts. Give each a one-line plain-English description and a typical duration — "Texture · adds your pet's real markings · ~4 min". Customers are about to spend 88 coins on a process they cannot picture.
3. **Set a time expectation before the spend, not after.** A Tripo build can legitimately run 20 minutes (that's why MG-2 raised the ceiling). Say so on the build button, or the first slow build reads as a hang.
4. **Let people reuse existing photos.** See LIVE-10 — the Fur Bin already holds their images.
5. **Surface the rig decision earlier.** The 35-coin rig is the single biggest line item; it's currently a checkbox deep in the config. Show a two-option comparison ("Still model 53 · Animation-ready 88") up front.

### 4.2 Pawprints

The live preview and role grid landed well; these are the next friction points.

1. **Sticky Continue on the photo step** (LIVE-11) — the CTA is currently below the fold immediately after upload.
2. **Preview and variations compete for the same screen.** The live preview is large and pushes the 12 variation tiles below the fold. Consider a split where picking a variation updates the preview in place, without scrolling.
3. **Reuse Fur Bin photos** (LIVE-10).
4. **Let people save a draft.** The wizard holds everything in component state — a refresh loses the design. Persisting to `localStorage` would cost little and prevent real loss.
5. **Show the print size against the design.** Physical buyers pick a format from a dropdown with no visual of how the 4:5 canvas maps onto it.

### 4.3 Fur Reels

1. **Fix the mobile entry point** (LIVE-1) — currently the module cannot be reached on a phone at all.
2. **Rename the route to `/fur-reels`** (LIVE-4).
3. **Remove the dead-end empty state.** "Create a pet portrait first, then return here to animate it" is a wall with no action on it. Put a "Create a portrait" button directly in that panel.
4. **Show what the money buys before spending 100 coins.** There is no example output anywhere in the module. A single looping 8-second sample per template would do more for conversion than any copy change.
5. **The step numbering starts at 3.** The right column opens with "3. Add sound…" then "4. Frame and generate", while steps 1–2 are unnumbered fields in the middle column. Number all of it or none of it.

### 4.4 Fur Bin (library)

1. **Make it the hub the other modules link into** — it is the natural source for "choose an existing photo" in both Create and Pawprints.
2. **Add filter/sort by type** (model / reel / pawprint) — the modules produce three different artefact types into one bin.
3. **Show provenance on each item** — which module made it, when, and what it cost, so the spend history is legible.
4. **Offer re-download of the GLB** without re-entering the build flow.
5. **Add empty-state guidance** pointing at the three creation modules.

### 4.5 Global shell / navigation

1. **Reconcile the two navigations.** The header icons (Create, Voice Test, Pawprints, Profile) and the sidebar (Home, Pawprints, Fur Reels, Fur Bin, Wags) overlap on Pawprints and disagree everywhere else. One model, consistently applied, would remove the guesswork about where a module lives.
2. **"Voice Test" is a developer surface in primary navigation.** It occupies one of four header slots that a paid module could use.
3. **Tablet icon rail** (LIVE-8).
4. **Real 404 page** (LIVE-4).
5. **Add a footer** with legal, support, and pricing links — there is no `<footer>` landmark on any page.

---

## 5. Live Fixes Applied

All six are committed on `main` locally, `tsc --noEmit` clean. **They are not yet deployed** — they need a rebuilt zip.

| # | Fix | File |
|---|---|---|
| LIVE-1 | Restore Fur Reels to mobile nav | `src/shellNavigation.ts` |
| LIVE-2 | `streak/claim` 400 → 200 `alreadyClaimed` | `server.ts` |
| LIVE-3 | Relabel build-cost tile | `src/components/PetModelStudio.tsx` |
| LIVE-5 | Remove nested `<main>` landmarks | `src/components/PawprintsStudio.tsx` |
| LIVE-6 | Add skip-to-content link | `src/App.tsx` |
| LIVE-12 | Fur Reels copy matches 3–6 beat schema | `src/components/AnimationStudio.tsx` |

Deliberately **not** applied — each needs a decision from you rather than a mechanical change: LIVE-4 (routing/301 strategy), LIVE-7 (touch-target restyle), LIVE-8 (tablet breakpoint design), LIVE-9/10/11 (product decisions).

---

## Not Yet Verified

Stated plainly so nothing here is mistaken for a clean bill of health:

- **No paid generation was run end to end.** The 3D build (88 coins, ~20 min) and Fur Reels (100 coins) pipelines were verified only as far as their gates, pricing, and configuration APIs. The MG-1/2/3 durability fixes — recovery sweeps, the 20-minute poll ceiling, the lease heartbeat — are therefore still **unproven against a live provider run**. This is the single biggest remaining gap.
- **MG-11** (rig chained off a texture task) is unexercised live; it only triggers when a customer buys texture *and* rig on the same order.
- **Colour contrast** not measured.
- **No real screen-reader pass.**
- **Print/Printful order path** not exercised — no order was submitted.

---

## Recommended Order of Work

**Now (before next deploy):** ship the six applied fixes — LIVE-1 in particular restores a paid module to mobile users.

**This week:** LIVE-4 routing and real 404s · LIVE-7 touch targets · a live paid generation to prove the MG durability fixes.

**Next:** LIVE-8 tablet layout · module flow improvements in §4 · contrast and screen-reader audit.
