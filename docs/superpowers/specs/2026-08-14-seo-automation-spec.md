# SEO Automation — Shopify Store + pawsome3d.com

> Historical proposal. Catalog sync was superseded by the digital-only runtime
> snapshot in `docs/AUTOMATIONS.md`; no routine may edit `PRINT_PRODUCTS` or
> commit catalog changes. The effective replacement SEO sweep is Automation
> `6a80808fa688819188ea4a22a560fd06`, scheduled for 8:00am America/Denver every
> Monday and Wednesday. It screens the full Shopify catalog plus the app's
> repository and live metadata; this proposal remains only as design history.

**Date:** 2026-08-14
**Status:** Proposed — needs sign-off on §5 before either half is built/extended
**Scope:** the Shopify catalog SEO screening already running (extend it), plus a
new automation for pawsome3d.com's own on-page SEO (doesn't exist yet)

## 1. Executive summary

"SEO automation" means two different things for two different properties,
and they share no code today:

- **The Shopify store** already has a working, narrow SEO screener — Job B
  of the "Pawprints Shopify Catalog Sync" routine (`trig_01FWzpzCKkB1xnqtZVNeRua5`).
  It checks title tags, meta descriptions, image alt text, and handles, but
  **only** for the small set of products in `PRINT_PRODUCTS`
  (`shared/pawprintCatalog2.ts`) — one product as of this writing. Everything
  else the store sells is unscreened.
- **pawsome3d.com** has no SEO automation at all. Its SEO surface is real
  and non-trivial (per-route `<title>`/`<meta description>` for ~15-25
  marketing routes, a static sitemap, a robots.txt) but it's maintained by
  hand across **three separate files that must agree and currently don't**
  — confirmed by inspection, not assumed. That drift is the concrete bug
  this spec's second half exists to catch automatically.

## 2. Part A — Shopify store SEO automation (extend what's running)

### 2.1 What Job B already does

Reads every product in `PRINT_PRODUCTS`, calls `shopify_get_product` +
`shopify_product_metafields` for each, and for title tag / meta description
/ image alt text / handle, writes a plain-English explanation and a
concrete suggested replacement for anything missing or out of range. Folds
into the existing catalog-sync email, or sends its own if nothing else
changed. Read-only — never calls a Shopify write tool.

### 2.2 The gap

`PRINT_PRODUCTS` is deliberately a tiny, curated subset — only
photo-customizable products the Pawprints wizard actually sells. The rest
of the store (every other product, every collection, the store's own
pages, any blog articles) has zero SEO coverage from this or anything
else. Confirmed via `shopify_count_products` / `shopify_list_collections`
that these exist and are unscreened.

### 2.3 Proposed extension

Add a **Job C** to the same routine (same cadence, same connector, no new
infrastructure):

1. `shopify_list_products` (already called in Job A) — screen **every**
   active product's title tag / meta description / image alt text /
   handle, not just `PRINT_PRODUCTS`. Same plain-English-recommendation
   format as Job B, so the two are visually consistent in the email.
2. `shopify_list_collections` — same four checks, applied to collection
   title/description/handle.
3. **Duplicate detection**: flag any two products/collections whose
   effective title tag is identical or near-identical (a common, real SEO
   problem Job B's per-product loop can't see on its own since it never
   compares across products). Cheap to add — build the map once, check for
   collisions after the per-item loop.
4. Cap the email at a sane top-N (e.g. 25 issues) with a total count,
   rather than a possibly-huge wall of text once the whole catalog is in
   scope — Job B's current scope (~1 product) never needed this, catalog-wide
   will.

Everything else about Job B's design carries over unchanged: read-only,
plain-English + suggested fix per issue, silent when there's nothing to
report, human applies fixes by hand.

### 2.4 Explicitly out of scope for this extension

- Structured data / product schema markup validation — different problem,
  different tooling, not requested.
- Broken-link / redirect-chain / 404 crawling — would need an actual site
  crawl, not just Admin API reads; separate spec if wanted.
- Auto-applying any fix — stays a human action, matching the existing
  design and your earlier instruction that this is screening, not writing.

## 3. Part B — pawsome3d.com SEO automation (new)

### 3.1 Current state, as it actually is today

Three files carry SEO metadata for the app's public marketing routes, and
none of them is generated from another — each is hand-edited separately:

| File | What it is | Routes covered |
| --- | --- | --- |
| `src/seo.ts` | Client-side `Screen` → `{title, desc}` map, applied after JS runs (`upsertMeta`) | ~25 `Screen` enum entries, including authenticated app screens (Profile, Fur Bin, Albums, Animator, BIM, Community, Store, Voice Test) that aren't public marketing pages |
| `server/seoMeta.ts` | Server-side path → `{title, description}` map, string-replaces `dist/index.html`'s `<head>` before sending, so **crawlers and social scrapers that never run JS** see the right title/canonical/og:url | 15 path entries — its own top comment says outright: *"Keep the strings here in sync with `src/seo.ts`"* — a manual instruction, not an enforced invariant |
| `public/sitemap.xml` | Static XML, committed by hand | 25 URLs |

**Confirmed drift, not hypothetical:** `server/seoMeta.ts` has entries for
`/custom-dog-figurines` and `/marketplace` that **do not appear in
`public/sitemap.xml` at all** — pages with real, intentional meta tags that
Google's sitemap-based discovery never sees. This is exactly the kind of
gap that stays invisible until someone happens to eyeball all three files
side by side, which is what this automation replaces.

### 3.2 What's being proposed

A new routine, **"Pawsome3D App SEO Screen"** — repo-only, no live network
calls needed for the core check, so no environment network-access
configuration required (contrast with Runtime Log Watch, which needed
`pawsome3d.com` added to Custom network access — this one only reads the
cloned repo):

1. **Three-way consistency check** — parse `src/seo.ts`'s `PUBLIC_METADATA`,
   `server/seoMeta.ts`'s `PAGE_META`, and `public/sitemap.xml`'s `<loc>`
   entries. For every public marketing route (the intersection that should
   exist in all three — internal/authenticated `Screen` entries like
   Profile or Fur Bin are expected to be `src/seo.ts`-only and excluded from
   this comparison), flag:
   - present in `server/seoMeta.ts` but missing from `sitemap.xml` (today's
     confirmed bug — `/custom-dog-figurines`, `/marketplace`)
   - present in `sitemap.xml` but missing from `server/seoMeta.ts` (crawler
     would index a page with no real meta injection, falling back to the
     generic homepage title)
   - present in `src/seo.ts` as a public-facing `Screen` but with no
     corresponding path key in `server/seoMeta.ts` at all
   - title/description text that differs between `src/seo.ts` and
     `server/seoMeta.ts` for the same route (the exact drift the file's own
     comment warns against, currently unenforced)
2. **Length/quality checks**, same bar as the Shopify side for consistency:
   title 20-60 characters, description 70-160 characters, applied to every
   entry in `server/seoMeta.ts` (the one crawlers actually see).
3. **Live spot-check** (optional, needs network access added — see §5):
   `curl` a handful of public routes against the deployed
   `https://pawsome3d.com` and confirm the served `<title>`/`<meta
   description>`/`<link rel="canonical">` actually match what
   `server/seoMeta.ts` declares — catches "the code is right but the
   deployed build is stale" (a real, distinct failure mode from "the code
   is wrong").
4. **Reporting**: plain-English explanation + a concrete suggested fix per
   issue (same format as the Shopify jobs, for a consistent reading
   experience across every automation email), draft PR branch if a fix is
   confident and mechanical (e.g. "add this URL to sitemap.xml" is about as
   mechanical as it gets) — matching the Runtime Log Watch precedent of
   proposing on a `fix/*` branch rather than committing to `main` directly.
   Silent if nothing to report.

### 3.3 What this explicitly does not do

- Does not touch `Screen` enum entries for authenticated/app-only routes —
  those aren't crawled or socially shared, meta tags there are cosmetic at
  best.
- Does not generate new marketing copy or invent new landing pages — pure
  consistency + quality screening of what already exists.
- Does not touch Shopify — this half is entirely about the pawsome3d.com
  app; the two automations stay separate, each scoped to the property it
  actually understands.

## 4. Shared design principles (both halves)

Carried over from every automation built so far in this program, on
purpose — consistency across the whole automation portfolio matters more
than any one job being clever:

- Read-only / recommend-only. The only writes either automation makes are
  git commits to non-`main` branches for confidently-mechanical fixes
  (sitemap entries), never to Shopify, never to `main` directly.
- Plain-English explanation + concrete suggested fix per issue, not a bare
  pass/fail flag — the standard set by Job B's upgrade.
- Silent when there's nothing to report. No news, no noise, across every
  routine in this program so far.
- No new connectors, no new vendor accounts. Job C reuses Job A/B's
  existing `shopmcp-pawprints` connector; the App SEO Screen needs nothing
  beyond repo access unless §5's live spot-check is approved.

## 5. Open decisions (need your sign-off before building either half)

1. **Job C's cadence** — fold into the existing daily `0 12 * * *` run, or
   give it a slower cadence (weekly?) since a whole-catalog SEO screen is a
   heavier read than the current single-product one and changes less
   often than "is there a new customizable product." Recommend: same daily
   run, since Job A already needs the full product list and Job C can reuse
   that same `shopify_list_products` call rather than fetching it twice.
2. **App SEO Screen's live spot-check (§3.2.3)** — needs `pawsome3d.com`
   added to that routine's environment Custom network access, same change
   already made for Runtime Log Watch. Skip it and this becomes a
   pure static-file consistency check (still catches the confirmed
   sitemap gap), or include it and also catch stale-deploy drift. Your call.
3. **Sitemap fix mechanism** — should the App SEO Screen actually draft the
   `fix/*` branch adding missing URLs to `public/sitemap.xml` (mechanical,
   low-risk), or only report the gap in the email and leave editing the
   file to you? Recommend: draft it — it's about as safe as a fix gets, and
   matches the "propose on a branch, human merges" pattern already
   established.
4. **New routine vs. extending an existing one** — proposed as its own
   routine above since it has nothing to do with Shopify, but if you'd
   rather consolidate automations to keep the routine list short, it could
   instead be a third job on "Pawsome3D Runtime Log Watch" (same repo
   access, same "no live network needed unless spot-checking" profile).
   Recommend: separate routine — keeps each one's purpose and its
   `docs/AUTOMATIONS.md` entry legible at a glance, and failures in one
   don't block the other from running.
