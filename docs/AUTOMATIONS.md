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
- **Connectors:** `shopmcp-pawprints` (Shopify), Gmail
- **What it does:**
  - **Job A** — diffs the live Shopify catalog against `PRINT_PRODUCTS` in
    `shared/pawprintCatalog2.ts`, drafts entries for genuinely
    photo-customizable new products, commits straight to `main` flagged
    "needs review."
  - **Job B** — screens every catalogued product's live SEO metadata (title
    tag, meta description, image alt text, handle) and writes plain-English
    recommendations with concrete suggested fixes. Read-only against
    Shopify — it never writes a metafield itself.
  - Silent if nothing to report ("no news, no noise").
- **Human-in-the-loop stage:** Hostinger is manual-deploy-only (not wired to
  auto-deploy from GitHub), so a Job A commit landing on `main` never reaches
  production on its own. **The redeploy decision is the approval gate** —
  review the email, then redeploy (or don't) via hPanel or
  `hosting_deployJsApplication`.

## Order-status reconciliation (webhook, not a routine)

- **Route:** `POST /api/webhooks/shopify-orders` (`server.ts`)
- **Registered in:** Shopify Admin → Settings → Notifications → Webhooks —
  `orders/paid` and `orders/cancelled`, both pointed at
  `https://pawsome3d.com/api/webhooks/shopify-orders`. One-time manual setup;
  no ShopMCP tool manages webhook subscriptions.
- **Secret:** `SHOPIFY_WEBHOOK_SECRET` (see `.env.example`)
- **What it does:** matches the incoming order to a `pawprint_shopify_orders`
  row via the reference stamped into the order's note at checkout
  (`server/shopify.ts`'s `createPawprintCheckout` /
  `extractPawprintOrderReference`), then updates `status` to `paid` or
  `cancelled` and stamps `shopify_order_id` / `paid_at`. This is plain
  signature-verified webhook code, not an agent — deterministic state sync
  doesn't need one.
- **Verification:** `scripts/verify-shopify-checkout.mjs --complete` drives
  a real, zero-cost test order end to end and confirms the status flips.

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

## Deploy

Deploys are never automatic from any of the above. Build + verify happens
via `scripts/build-deploy-zip.sh`; pushing the result live is always a
deliberate human action (hPanel upload, or interactively invoking
`hosting_deployJsApplication`).
