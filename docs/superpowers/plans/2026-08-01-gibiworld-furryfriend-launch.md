# GibiWorld Cinematic and FurryFriend Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a truthful 30-second GibiWorld concept film, an accessible Pawsome3D homepage film hero, a dedicated FurryFriend GibiWorld page, and refreshed Pawprints presentation.

**Architecture:** A reusable React `GibiWorldHero` owns film playback and accessibility on Pawsome3D, while FurryFriend emits equivalent static HTML and progressive-enhancement controls from its existing generator. Owned media is copied into each site’s document root; no page depends on an expiring generation URL or cross-domain hotlink. GibiWorld is consistently labeled as a concept preview and does not alter accounts, entitlements, AR runtime behavior, or commerce.

**Tech Stack:** React 19, TypeScript 5.8, Tailwind CSS 4, static HTML/CSS/JavaScript, Node.js 24.18, Node test runner, ImageGen-created raster source frames, FFmpeg H.264/WebVTT media pipeline.

## Global Constraints

- Use Node `>=24.15 <25`; run commands with Node 24.18.
- Preserve the existing uncommitted changes in `furryfriend/content/articles.mjs` and `furryfriend/content/editorial-ledger.json`; do not revert or overwrite them.
- Every customer-facing GibiWorld surface must say **“GibiWorld concept preview”** and state that the playable experience is in development.
- Do not claim that purchasing a Pawprint, model, or keepsake grants GibiWorld access.
- Do not claim released AR, personalization, spatial anchoring, multiplayer, platform support, dates, player counts, or safety certification.
- The 30-second film must use one recognizable pet across all principal shots and remain understandable while muted.
- Primary media paths are `public/media/gibiworld/` and `furryfriend/public/assets/gibiworld/`; never ship provider-expiring URLs.
- Video sound starts only after user action. Respect reduced motion and provide a poster, captions, keyboard controls, and failed-media fallback.
- Build, push, ZIP, deployment, and live verification are separate release states.

---

## File Map

### Create

- `src/components/GibiWorldHero.tsx` — accessible Pawsome3D film hero and playback state.
- `tests/gibiworld_launch.test.mjs` — Pawsome3D copy, media, and accessibility contract.
- `scripts/build-gibiworld-cinematic.sh` — deterministic FFmpeg assembly of the approved frames, narration, music/effects mix, captions, poster, and web deliverables.
- `public/media/gibiworld/gibiworld-30s.mp4` — owned 30-second H.264 master for Pawsome3D.
- `public/media/gibiworld/gibiworld-30s.webm` — optional owned VP9 fallback when smaller than the MP4.
- `public/media/gibiworld/gibiworld-30s.vtt` — synchronized captions.
- `public/media/gibiworld/gibiworld-poster.webp` — desktop/mobile-safe poster.
- `public/media/gibiworld/frames/*.png` — six consistent-pet source frames.
- `public/media/gibiworld/audio/narration.wav` — final narration.
- `public/media/gibiworld/audio/score.wav` — licensed/original music and restrained effects mix stem.
- `furryfriend/public/assets/gibiworld/*` — copied web deliverables and Pawprints/GibiWorld images for FurryFriend’s independent document root.
- `furryfriend/content/gibiworld.mjs` — one source of truth for concept-page copy and metadata.
- `furryfriend/verify-gibiworld.mjs` — focused route, claims, media, sitemap, and accessibility verification.

### Modify

- `src/components/HomePage.tsx` — replace the current static hero visual with `GibiWorldHero`; refresh the Pawprints panel.
- `furryfriend/build.mjs` — add the homepage feature, `/gibiworld/`, sitemap entry, metadata, schema, and asset handling.
- `furryfriend/public/styles.css` — responsive film, concept-page, activity, and Pawprints feature styles.
- `furryfriend/public/site.js` — accessible play/pause, sound, replay, caption, failure, reduced-motion, and save-data behavior.
- `furryfriend/verify.mjs` — include GibiWorld in the full site verification contract.
- `furryfriend/README.md` — document the route, media, truthful concept boundary, build, and deploy paths.
- `README.md` — document the Pawsome3D hero media paths and static fallback behavior.

---

### Task 1: Lock the GibiWorld Content and Media Contracts

**Files:**
- Create: `tests/gibiworld_launch.test.mjs`
- Create: `furryfriend/content/gibiworld.mjs`
- Create: `furryfriend/verify-gibiworld.mjs`
- Modify: `furryfriend/verify.mjs`

**Interfaces:**
- Consumes: approved design in `docs/superpowers/specs/2026-08-01-gibiworld-furryfriend-launch-design.md`.
- Produces: `GIBIWORLD` object with `label`, `title`, `dek`, `developmentNote`, `journey`, `activities`, `personalization`, `safety`, `currentReality`, `cta`, `metaTitle`, and `metaDescription`; automated launch contracts used by all later tasks.

- [ ] **Step 1: Add a failing Pawsome3D launch contract**

Create `tests/gibiworld_launch.test.mjs` using `node:test`, `node:assert/strict`, and `fs`. Assert that:

```js
const home = fs.readFileSync("src/components/HomePage.tsx", "utf8");
const hero = fs.readFileSync("src/components/GibiWorldHero.tsx", "utf8");
assert.match(home, /<GibiWorldHero[\s\S]*onOpenCreate=\{onOpenCreate\}/);
assert.match(hero, /GibiWorld concept preview/);
assert.match(hero, /playable experience is in development/i);
assert.match(hero, /gibiworld-30s\.mp4/);
assert.match(hero, /gibiworld-30s\.vtt/);
assert.match(hero, /prefers-reduced-motion/);
assert.match(hero, /Save-Data/);
assert.match(hero, /Watch with sound/);
assert.match(hero, /Replay/);
assert.doesNotMatch(`${home}\n${hero}`, /available now|play now|included with purchase|guaranteed safe/i);
```

Also assert the MP4, VTT, poster, and six named frame files exist and are non-empty.

- [ ] **Step 2: Add a failing FurryFriend contract**

Create `furryfriend/verify-gibiworld.mjs`. Read `dist/gibiworld/index.html`, `dist/index.html`, and `dist/sitemap.xml`; assert one H1, canonical `https://furryfriend.cc/gibiworld/`, the visible concept/development labels, a valid JSON-LD block, film controls, poster fallback, Pawsome3D CTA, sitemap inclusion, and absence of the blocked claims in Global Constraints.

- [ ] **Step 3: Run both contracts and record the expected failure**

Run:

```bash
npx tsx --test tests/gibiworld_launch.test.mjs
npm --prefix furryfriend run build
node furryfriend/verify-gibiworld.mjs
```

Expected: FAIL because the component, route, and media do not exist.

- [ ] **Step 4: Create the content module**

Export a frozen `GIBIWORLD` object from `furryfriend/content/gibiworld.mjs`. Use the approved concept paragraph, the exact label “GibiWorld concept preview,” the sentence “The playable experience is in development,” the seven page sections in the design, and a CTA `{ label: "Create with Pawsome3D", href: "https://pawsome3d.com/create" }`. Keep all activity text in future-facing language such as “is envisioned to” and “the concept explores.”

- [ ] **Step 5: Wire the focused verifier into the full verifier**

Add `await import("./verify-gibiworld.mjs");` after the base build assertions in `furryfriend/verify.mjs` so `npm --prefix furryfriend run check` covers the new route.

- [ ] **Step 6: Commit the contract boundary**

```bash
git add tests/gibiworld_launch.test.mjs furryfriend/content/gibiworld.mjs furryfriend/verify-gibiworld.mjs furryfriend/verify.mjs
git commit -m "test: define GibiWorld launch contract"
```

### Task 2: Produce the Owned 30-Second Cinematic

**Files:**
- Create: `scripts/build-gibiworld-cinematic.sh`
- Create: `public/media/gibiworld/frames/photo-choice.png`
- Create: `public/media/gibiworld/frames/pawsome-build.png`
- Create: `public/media/gibiworld/frames/companion-reveal.png`
- Create: `public/media/gibiworld/frames/room-adventure.png`
- Create: `public/media/gibiworld/frames/sparkling-memory.png`
- Create: `public/media/gibiworld/frames/couch-reunion.png`
- Create: `public/media/gibiworld/audio/narration.wav`
- Create: `public/media/gibiworld/audio/score.wav`
- Create: `public/media/gibiworld/gibiworld-30s.vtt`
- Create: `public/media/gibiworld/gibiworld-30s.mp4`
- Create: `public/media/gibiworld/gibiworld-30s.webm`
- Create: `public/media/gibiworld/gibiworld-poster.webp`

**Interfaces:**
- Consumes: exact six-shot storyboard and narration from the approved spec.
- Produces: stable browser media files referenced by both sites.

- [ ] **Step 1: Generate one visual identity sheet**

Use the image-generation workflow to create a 16:9 identity reference: a small chestnut-and-cream spaniel mix with a cream blaze, left ear tipped darker than the right, amber eyes, teal collar, no text or logos. Require natural anatomy, four grounded paws, consistent markings, warm amber practical light, restrained teal accents, cinematic realism, and generous title-safe space. Inspect the full-resolution result before using it.

- [ ] **Step 2: Generate the six storyboard frames from the identity reference**

Generate each named frame at 16:9 using the same pet identity. The exact scenes are: phone photo selection; luminous photo-to-3D construction; finished pet facing camera; pet padding through a living room and peeking around a corner in a phone AR view; pet discovering a sparkling memory beside a gentle agility path; calm couch-side reunion. Reject frames with changed markings, extra limbs, floating feet, warped devices, embedded words, unsafe obstacles, or implausible shadows.

- [ ] **Step 3: Create narration and audio stems**

Record or synthesize the approved 70-word voiceover as a warm, calm narrator. Create an original/licensed music-and-effects stem with soft piano/pads, light paw steps, one interface chime, and a restrained sparkle motif. Do not use copyrighted commercial music or imitate a named living performer.

- [ ] **Step 4: Write exact captions**

Create `gibiworld-30s.vtt` with six cues matching 00:00–00:04, 00:04–00:09, 00:09–00:14, 00:14–00:22, 00:22–00:27, and 00:27–00:30. Use the approved narration verbatim and include `[soft music]` only when it adds meaning.

- [ ] **Step 5: Add deterministic FFmpeg assembly**

Write `scripts/build-gibiworld-cinematic.sh` with `set -euo pipefail`, an explicit `ffmpeg` availability check, 1920×1080 output, slow Ken Burns movement on each frame, 0.4-second crossfades within the 30-second timeline, narration-led audio mix, `-movflags +faststart`, H.264 `yuv420p`, AAC audio, a VP9 WebM output, and a WebP poster extracted near 00:12. The script must fail if `ffprobe` reports duration outside 29.8–30.2 seconds.

- [ ] **Step 6: Build and inspect the deliverables**

Run:

```bash
./scripts/build-gibiworld-cinematic.sh
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 public/media/gibiworld/gibiworld-30s.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,pix_fmt -of default=nw=1 public/media/gibiworld/gibiworld-30s.mp4
```

Expected: duration 29.8–30.2, width 1920, height 1080, pixel format `yuv420p`. Watch the full film with sound and captions; confirm identity, timing, legibility, audio balance, and the concept-preview end card.

- [ ] **Step 7: Commit the media package**

```bash
git add scripts/build-gibiworld-cinematic.sh public/media/gibiworld
git commit -m "feat: add GibiWorld concept cinematic"
```

### Task 3: Build the Accessible Pawsome3D Hero

**Files:**
- Create: `src/components/GibiWorldHero.tsx`
- Modify: `src/components/HomePage.tsx`
- Test: `tests/gibiworld_launch.test.mjs`

**Interfaces:**
- Consumes: `onOpenCreate: () => void` and `/media/gibiworld/` assets from Task 2.
- Produces: `GibiWorldHero({ onOpenCreate }: { onOpenCreate: () => void }): React.ReactElement`.

- [ ] **Step 1: Run the Pawsome3D contract to confirm the remaining failure**

Run `npx tsx --test tests/gibiworld_launch.test.mjs`.

Expected: FAIL because `GibiWorldHero.tsx` and its homepage integration are absent.

- [ ] **Step 2: Implement playback-state helpers**

In `GibiWorldHero.tsx`, maintain refs/state for `video`, `failed`, `soundEnabled`, and `showCaptions`. On mount, query `matchMedia("(prefers-reduced-motion: reduce)")` and `navigator.connection?.saveData`; autoplay muted only when both are false. Listen for preference changes and pause when reduced motion becomes active. Set `video.muted = false` and call `video.play()` only inside the “Watch with sound” click handler.

- [ ] **Step 3: Implement the accessible film surface**

Render MP4 and WebM sources, poster, `<track kind="captions" src="/media/gibiworld/gibiworld-30s.vtt" srcLang="en" label="English" />`, a static `<img>` fallback, visible “Watch with sound,” pause/play, replay, and captions buttons, `aria-live="polite"` playback status, and the exact concept/development labels. The primary button calls `onOpenCreate`; the secondary film control never navigates.

- [ ] **Step 4: Replace only the homepage hero**

Import `GibiWorldHero` into `HomePage.tsx` and replace the first hero `<section>` with `<GibiWorldHero onOpenCreate={onOpenCreate} />`. Keep the rest of the homepage, Famous Portraits, quick hits, pricing routes, and creation callbacks intact.

- [ ] **Step 5: Run focused checks**

```bash
npx tsx --test tests/gibiworld_launch.test.mjs tests/homepage_route_contract.test.mjs tests/release_corrections_ui.test.mjs tests/supporting_release_safety.test.mjs
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Commit the Pawsome3D hero**

```bash
git add src/components/GibiWorldHero.tsx src/components/HomePage.tsx tests/gibiworld_launch.test.mjs
git commit -m "feat: feature GibiWorld on Pawsome3D"
```

### Task 4: Launch the FurryFriend GibiWorld Page and Homepage Feature

**Files:**
- Modify: `furryfriend/build.mjs`
- Modify: `furryfriend/public/styles.css`
- Modify: `furryfriend/public/site.js`
- Create/modify: `furryfriend/public/assets/gibiworld/*`
- Test: `furryfriend/verify-gibiworld.mjs`

**Interfaces:**
- Consumes: `GIBIWORLD` from `furryfriend/content/gibiworld.mjs` and web media from Task 2.
- Produces: `/gibiworld/`, homepage feature, navigation/internal links, sitemap entry, and progressive film controls.

- [ ] **Step 1: Copy stable media into FurryFriend’s source root**

Copy the MP4, optional smaller WebM, VTT, poster, room-adventure, sparkling-memory, couch-reunion, and Pawprints image into `furryfriend/public/assets/gibiworld/`. Preserve filenames and verify byte-for-byte equality for shared deliverables with `shasum -a 256`.

- [ ] **Step 2: Add a reusable static film renderer**

In `furryfriend/build.mjs`, add `gibiWorldFilm({ compact = false } = {})` that returns a `<figure data-gibiworld-film>` containing the video sources, caption track, poster fallback, concept label, play/pause, watch-with-sound, replay, captions controls, and a `data-film-status` live region. All controls use `type="button"` and descriptive `aria-label`s.

- [ ] **Step 3: Build the GibiWorld route**

Import `GIBIWORLD`, add `buildGibiWorld()`, and emit `/gibiworld/`. Render the seven approved sections, image package, “what exists now” comparison, and the Pawsome3D CTA. Add `WebPage` JSON-LD with visible description and `isPartOf` FurryFriend; do not emit `VideoGame`, `SoftwareApplication`, availability, or offer schema.

- [ ] **Step 4: Add the homepage feature and discoverability**

Add a GibiWorld feature section after the homepage hero and before guide search. Link to `/gibiworld/`, add GibiWorld to navigation if it fits the existing mobile menu, add `/gibiworld/` to `indexable`, and update the build manifest with `gibiWorldConcept: true`.

- [ ] **Step 5: Implement progressive playback controls**

Extend `furryfriend/public/site.js` to initialize every `[data-gibiworld-film]`. Enforce the same reduced-motion/save-data behavior as the React hero; wire play/pause, user-initiated sound, replay, and captions; set a failed-media class and reveal the poster on `error`; update `aria-pressed`, button text, and the live status without trapping focus.

- [ ] **Step 6: Add responsive styling**

Extend `furryfriend/public/styles.css` with scoped `.gibiworld-*` rules for the cinematic frame, concept badge, controls, journey steps, activities, current-vs-concept split, and responsive images. At `max-width: 680px`, lead with copy/poster and keep controls at least 44px tall. Under reduced motion, suppress decorative transforms and hide autoplay-only affordances.

- [ ] **Step 7: Run FurryFriend checks**

```bash
npm --prefix furryfriend run check
```

Expected: PASS with `/gibiworld/` indexed and editorial previews still noindex until their own approval states change.

- [ ] **Step 8: Commit the concept page**

Stage only the GibiWorld files and the intended shared edits. Inspect `git diff --cached --name-status` before committing so the pre-existing article changes are included only if this task deliberately edits them.

```bash
git add furryfriend/build.mjs furryfriend/public/styles.css furryfriend/public/site.js furryfriend/public/assets/gibiworld furryfriend/content/gibiworld.mjs furryfriend/verify-gibiworld.mjs furryfriend/verify.mjs
git commit -m "feat: launch GibiWorld concept on FurryFriend"
```

### Task 5: Refresh Pawprints Copy and Imagery

**Files:**
- Modify: `src/components/HomePage.tsx`
- Modify: `src/components/PawprintsStudio.tsx`
- Modify: `furryfriend/content/articles.mjs`
- Modify: `furryfriend/content/editorial-ledger.json` only when a corresponding claim note changes.
- Create: `furryfriend/public/assets/gibiworld/pawprints-keepsake.webp`
- Test: `tests/gibiworld_launch.test.mjs`
- Test: `tests/historic_pawprints.test.mjs`
- Test: `furryfriend/verify-gibiworld.mjs`

**Interfaces:**
- Consumes: existing Historic Pawprints catalog and current physical Printful routing.
- Produces: clear portrait/keepsake copy with a qualified future GibiWorld connection; no commerce or entitlement behavior changes.

- [ ] **Step 1: Extend the failing contracts**

Assert that Pawsome3D copy includes “Historic Pawprints,” “digital portrait or physical keepsake,” and “could become part of a future GibiWorld companion,” plus an adjacent concept-development qualifier. Assert that FurryFriend’s relevant Pawprints guide contains the same truth boundary and the new owned image path. Assert absence of “transfers to GibiWorld,” “game-ready,” “included,” and “unlock.”

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
npx tsx --test tests/gibiworld_launch.test.mjs tests/historic_pawprints.test.mjs
npm --prefix furryfriend run check
```

Expected: FAIL on missing copy/image assertions.

- [ ] **Step 3: Update Pawsome3D Pawprints presentation**

Change the homepage Pawprints panel to lead with Historic Pawprints and the choice between digital portrait and physical keepsake. Update the Pawprints Studio introduction without changing template IDs, Printful products, pricing, save/send behavior, or fulfillment APIs. Phrase the GibiWorld relationship as future vision and place the development qualifier in the same visible block.

- [ ] **Step 4: Update FurryFriend Pawprints editorial content without losing user work**

Edit the existing relevant sections in `furryfriend/content/articles.mjs` in place. Keep the adoption article and every unrelated user-authored line. Update the corresponding editorial-ledger note only if the edited article’s claim gate changes; preserve its state, reviewer, approval time, and unrelated jobs.

- [ ] **Step 5: Generate and inspect the Pawprints image**

Create a warm editorial image showing a framed historical-style pet portrait beside a physical pet keepsake and phone preview, using the same chestnut-and-cream pet. No embedded words, provider marks, price labels, shipping boxes, or implied game UI. Save the optimized result as `pawprints-keepsake.webp` in both required public roots.

- [ ] **Step 6: Run focused checks**

```bash
npx tsx --test tests/gibiworld_launch.test.mjs tests/historic_pawprints.test.mjs tests/pawprints_manual_studio.test.mjs
npm --prefix furryfriend run check
```

Expected: PASS.

- [ ] **Step 7: Commit the Pawprints update**

```bash
git add src/components/HomePage.tsx src/components/PawprintsStudio.tsx tests/gibiworld_launch.test.mjs furryfriend/content/articles.mjs furryfriend/content/editorial-ledger.json furryfriend/public/assets/gibiworld/pawprints-keepsake.webp
git commit -m "feat: connect Historic Pawprints to GibiWorld vision"
```

### Task 6: Documentation and Focused Production Verification

**Files:**
- Modify: `README.md`
- Modify: `furryfriend/README.md`
- Modify: `docs/architecture/DEPLOYMENT_2_CUSTOMER_EXPERIENCE.md`

**Interfaces:**
- Consumes: finished media, routes, and controls.
- Produces: operator-facing asset, build, deployment, and truthful-product documentation.

- [ ] **Step 1: Document the exact media contract**

Add the stable asset paths, FFmpeg rebuild command, 29.8–30.2-second duration gate, caption path, poster fallback, and user-initiated audio rule to `README.md`.

- [ ] **Step 2: Document the FurryFriend route and boundary**

Update `furryfriend/README.md` with `/gibiworld/`, its sitemap/indexing behavior, independent copied media, the exact concept-preview boundary, and the current-vs-future claim rules. Update the route count language so it derives from verification rather than a hard-coded “four guides” statement.

- [ ] **Step 3: Update the customer-experience architecture**

Add GibiWorld as a concept-media surface and clarify that it does not create an entitlement or game-runtime dependency. Document Pawsome3D and FurryFriend as separate deployment roots.

- [ ] **Step 4: Run focused verification under Node 24.18**

```bash
npx tsx --test tests/gibiworld_launch.test.mjs tests/homepage_route_contract.test.mjs tests/release_corrections_ui.test.mjs tests/supporting_release_safety.test.mjs tests/historic_pawprints.test.mjs tests/pawprints_manual_studio.test.mjs
npm --prefix furryfriend run check
npm run lint
npm run build
git diff --check
```

Expected: all commands PASS. These are verification results, not a testing blocker policy or proof of live deployment.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md furryfriend/README.md docs/architecture/DEPLOYMENT_2_CUSTOMER_EXPERIENCE.md
git commit -m "docs: describe GibiWorld concept delivery"
```

### Task 7: Review, Push, Package, and Live Handoff

**Files:**
- Create: `docs/reviews/2026-08-01-gibiworld-release-review.md`
- Create locally: `pawsome3d-deploy.zip`
- Create locally: `furryfriend-deploy.zip`

**Interfaces:**
- Consumes: committed `main`, verified Pawsome3D build, and verified `furryfriend/dist`.
- Produces: exact SHAs, checksums, archives, pushed main, and a deployment/live-verification record.

- [ ] **Step 1: Review the complete committed diff**

Inspect every commit since `62aea99342d160995250f79035b73389abf7138f`, verify `git diff --check`, confirm no secret-like values entered media or HTML, and confirm the two formerly uncommitted FurryFriend files now contain only preserved user work plus the intentional Pawprints edits.

- [ ] **Step 2: Record the release evidence**

Create `docs/reviews/2026-08-01-gibiworld-release-review.md` with PASS/FAIL/BLOCKED rows for media, Pawsome3D hero, FurryFriend route, Pawprints, accessibility, production builds, push, ZIPs, Pawsome3D deployment, FurryFriend deployment, and live browser review. Do not mark deployment/live rows PASS without direct evidence.

- [ ] **Step 3: Commit the review and push main**

```bash
git add docs/reviews/2026-08-01-gibiworld-release-review.md
git commit -m "docs: record GibiWorld release review"
git push origin main
```

Expected: remote `main` advances to the exact local SHA.

- [ ] **Step 4: Build Pawsome3D from a clean committed checkout**

Use the repository’s `scripts/build-deploy-zip.sh` from a temporary clean clone at the pushed SHA under Node 24.18. Copy the resulting `pawsome3d-deploy.zip` to the workspace root, inspect its manifest, confirm no `.env`, credentials, source-map secrets, or user-only untracked files, and record `shasum -a 256` plus size.

- [ ] **Step 5: Build the FurryFriend archive from the same pushed SHA**

In the clean checkout, run `npm --prefix furryfriend run check`, then archive the contents of `furryfriend/dist/` so `index.html` is at the ZIP root. Save as `furryfriend-deploy.zip`, inspect entries, and record SHA-256 plus size.

- [ ] **Step 6: Deploy only through the available authorized Hostinger workflow**

Upload each archive to its matching document root, preserve each domain’s environment and routing configuration, activate the new release, and capture the deployed version or timestamp. If direct Hostinger control is unavailable, leave these rows BLOCKED with the exact archive paths and upload destinations rather than claiming deployment.

- [ ] **Step 7: Perform the live browser sweep**

On `https://pawsome3d.com/`, verify the film poster/playback, user-initiated sound, captions, replay, reduced-motion behavior, primary creation action, and no console/network failures. On `https://furryfriend.cc/` and `/gibiworld/`, verify direct navigation, responsive layout, all media, metadata/canonical, sitemap, Pawprints links, and clear concept labeling. Check fresh production logs after both sweeps when accessible.

- [ ] **Step 8: Update and commit the final evidence only if it changed**

Update the review with actual deployed versions, live results, and log findings. Commit and push the evidence update. Stop after the commit/push and report exact SHAs, archive paths, hashes, and any BLOCKED live step.

---

## Completion Definition

The work is complete only when the approved film and site changes are committed, pushed, packaged, and accurately reported. “Live” additionally requires direct production-page and asset verification on both domains. If Hostinger deployment cannot be performed with available authorized access, the implementation may be complete while deployment remains explicitly BLOCKED with a precise manual handoff.
