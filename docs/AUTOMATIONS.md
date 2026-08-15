# Automations index

Scheduled/agent-driven work for this repo doesn't live in the codebase — it
runs as Claude scheduled routines (`RemoteTrigger` in a Claude Code session),
outside GitHub Actions and outside Hostinger. Nothing in `server.ts` or
`package.json` will tell you these exist, so this file is the pointer.
Every routine gets one entry here when it's created or changed.

## Pawprints Shopify Catalog Sync

- **Trigger ID:** `trig_01FWzpzCKkB1xnqtZVNeRua5`
- **Schedule:** `0 12 * * *` UTC (≈6am America/Denver on MDT; drifts to ≈5am
  once MST starts in November — left as-is by design, not a bug)
- **Repo/branch:** `judysemu/PawsMemories` @ `main`
- **Runtime credential:** `SHOPIFY_CATALOG_SYNC_SECRET`
- **What it does:**
  - Sends `POST /api/admin/shopify/catalog-sync` with
    `Authorization: Bearer $SHOPIFY_CATALOG_SYNC_SECRET`.
  - The server reads every active product through Shopify Admin GraphQL with
    cursor pagination and atomically replaces the runtime catalog snapshot.
  - A failed Shopify or database request records a failed run while the last
    good public snapshot remains live.
  - No source file, Git branch, product, collection, or metafield is changed.
  - Personalization is true only when Shopify's boolean
    `custom.pawprint_personalizable` metafield is explicitly true.
- **Verification:** an admin can inspect `GET /api/store/sync-status` and the
  public projection at `GET /api/store/products`.

## Order-status reconciliation (webhook, not a routine)

- **Route:** `POST /api/webhooks/shopify-orders` (`server.ts`)
- **Registered in:** Shopify Admin → Settings → Notifications → Webhooks —
  `orders/paid` and `orders/cancelled`, both pointed at
  `https://pawsome3d.com/api/webhooks/shopify-orders`. One-time manual setup;
  no ShopMCP tool manages webhook subscriptions.
- **Secret:** `SHOPIFY_WEBHOOK_SECRET` (see `.env.example`)
- **What it does:** reconciles only pre-existing `pawprint_shopify_orders`
  records whose legacy order note contains a `pawprint_order:<uuid>` reference,
  then updates status to `paid` or `cancelled`. Webhook IDs are stored to make
  redelivery idempotent. New app-side PawPrint checkout creation is retired.

## Pawsome3D Runtime Log Watch

- **Trigger ID:** `trig_018uQc66Z7YURb3uwQrxBqsE`
- **Schedule:** `0 13 * * *` UTC, daily
- **Connectors:** Gmail (no Hostinger connector — see below)
- **What it does:** reads `logs/runtime-YYYY-MM-DD.log` (written by
  `server/runtimeLog.ts`) via `GET /api/admin/runtime-log` on
  `pawsome3d.com` itself (plain `curl`, `X-Runtime-Log-Key` header — see
  `RUNTIME_LOG_API_KEY` in `.env.example`), summarizes new/notable error
  signatures. On a new signature, triages it — reads the code path the stack
  trace points at, drafts a root-cause writeup and a proposed fix on a new
  `fix/*` branch (never `main`) — and includes both in the email. Silent if
  nothing new.
- **Human-in-the-loop stage:** proposed fixes land on a branch, not `main` —
  reviewing and merging is a human decision, same as any other PR.
- **Why not the Hostinger connector, as originally designed:** verified by
  an actual test run (`RemoteTrigger action=run`, session
  `cse_01GvMn7MDAmVmsWT5wjgn4if`) — a scheduled routine's cloud environment
  only gets tools through *connectors* (OAuth-linked, e.g. Gmail,
  shopmcp-pawprints), not the *plugins* an interactive session has (Azure,
  Hostinger, Telegram, etc.). `enabled_plugins: ["hostinger"]` in the create
  call was silently ignored — there's no way to grant a routine
  plugin-backed tools. The app now serves its own log data over HTTPS
  instead, which sidesteps the distinction entirely.

## Pawsome3D + Shopify SEO Sweep

- **Automation ID:** `6a80808fa688819188ea4a22a560fd06`
- **Schedule:** 8:00am America/Denver every Monday and Wednesday
  (`RRULE:FREQ=WEEKLY;BYDAY=MO,WE`). The local-time schedule no longer drifts
  by an hour at daylight-saving boundaries.
- **Connectors:** GitHub (`judysemu/PawsMemories`) and Shopify
  (`Pawprints by Pawsome3D`).
- **Supersedes:** the ineffective SEO-only RemoteTrigger
  `trig_01DtQzq8Y2mPEqXmiBGKBtmT`. Retire that trigger after confirming the
  replacement's first successful run. Do not disable the separate daily
  Pawprints catalog pull `trig_01FWzpzCKkB1xnqtZVNeRua5`.
- **Spec:** `docs/superpowers/specs/2026-08-14-seo-automation-spec.md`
- **What it does:**
  - Screens every active Shopify product and collection, not a curated source
    list, for SEO title/description quality, handles, featured-image alt text,
    and duplicate or near-duplicate effective titles.
  - Cross-checks `src/seo.ts`, `server/seoMeta.ts`, `public/sitemap.xml`, and
    `public/robots.txt` for missing routes, mismatched metadata, length issues,
    and indexing mistakes.
  - Compares representative live `pawsome3d.com` metadata with `main`, reporting
    source drift separately from stale deployment.
  - Reports the 25 highest-priority actionable issues per property with total
    counts and concrete recommended corrections.
- **Write boundary:** read-only. It does not modify Shopify, create products,
  commit to `main`, or open checkout paths.

## Deploy

Deploys are never automatic from any of the above. Build + verify happens
via `scripts/build-deploy-zip.sh`; pushing the result live is always a
deliberate human action (hPanel upload, or interactively invoking
`hosting_deployJsApplication`).
