# Pawsome3D Production Deployment Review — 2026-07-31

> **Historical deployment snapshot — superseded by the open full-codebase
> audit.** This document records what was verified for commit `227ccf1`, not the
> acceptance state of the current repair tree. The later 934-path audit found
> additional release-blocking defects; see
> `FULL_CODEBASE_AUDIT_2026-07-31.md` and
> `REMAINING_FIXES_2026-07-31.md`. Do not read the earlier “successful” verdict
> below as approval to deploy the current uncommitted work.

Baseline re-check at 2026-07-31 11:48 MDT: `/version` still reports exact commit
`227ccf1fe7ae3570963b7777aa13e4a3b5ea3da6`, build time
`2026-07-31T15:39:15.503Z`, and schema 39; `/readyz` is 200 with a healthy
database; `/robots.txt` and `/sitemap.xml` are 200. This proves only that the
old production build is live and ready. The repaired model, credit, historical
collection, and animation code is not deployed, and no successful live
reference-to-model-to-Fur-Bin run has occurred.

Current repair-tree admin gate: production startup now fails if `ADMIN_KEY`,
`ADMIN_EMAIL`, or `ADMIN_PASSWORD` is absent. Startup synchronizes the existing
email-addressed account with a hashed credential and both `is_admin=1` and
`is_operator=1`, then reads the row back to verify both roles. No credential
value is written to source, console output, or this report. Live login and
protected-route verification remain required after deployment.

Reviewed at 2026-07-31 09:51 MDT against `https://pawsome3d.com` and the active Hostinger runtime.

## Executive verdict

| Area | Result | Evidence |
|---|---|---|
| Deployment | **PASS** | Hostinger is serving commit `227ccf1fe7ae3570963b7777aa13e4a3b5ea3da6` from `main`. |
| Server startup | **PASS** | The fatal `PRINTFUL_STATIONERY_VARIANT_MAP` parsing loop is gone; the current runtime started cleanly and Hostinger reports zero errors. |
| Database readiness | **PASS** | `/readyz` is `ready`; the database is configured and healthy. |
| Public site and SEO routes | **PASS** | All 18 reviewed public, SEO, health, build, and fulfillment routes returned HTTP 200. |
| Printful product catalog | **PASS** | Four configured formats are exposed as available and orderable; no catalog blockers are reported. |
| Auth boundary | **PASS** | Protected user, admin, and order-list endpoints returned HTTP 401 without a bearer session. |
| Admin session | **PASS** | The existing production admin login remained authenticated and could open Profile, Create, Pawprints, Fur Bin, and Print Shop. |
| Pawprint creation and storage | **PASS** | A test Pawprint made from the repository's public sample image was rendered, uploaded, persisted, and appeared in Fur Bin; the saved WebP returned HTTP 200. |
| Customer PupCoin debit | **NOT VERIFIED** | The requested admin account is intentionally exempt from Pawprint debits. Balance remained 10,880 and no ledger debit was created. A non-admin account is required to test the real 75-PupCoin charge path. |
| 3D generation | **BLOCKED** | A text-to-model attempt failed closed before provider work or debit with `Reference generation has reached today's global safety limit.` |
| Real physical order | **NOT RUN** | No Printful or Slant3D order and no Stripe payment were created; those would be real external transactions. |

Overall: **the deployment repair is successful and the site is live**, but production is not fully green because customer 3D generation is currently blocked by the global daily safety cap and the customer debit path still needs a non-admin test.

## Root cause and repair

The mapping visible in both Hostinger configuration editors was valid JSON and retained these mappings:

| Product code | Printful variant ID |
|---|---:|
| `poster-8x10` | `4463` |
| `poster-12x16` | `1349` |
| `poster-18x24` | `1` |
| `canvas-12x16` | `5` |

A configuration-only redeploy reproduced the fatal startup error. This proved the problem was not the JSON shown in hPanel: Hostinger's runtime injection layer was delivering literal escaping around braces and quotes, while the Stationery V2 provider used strict `JSON.parse` only.

Commit `227ccf1` adds one narrow compatibility boundary:

1. Parse strict JSON first.
2. Only if that fails, remove literal backslashes immediately preceding `{`, `}`, or `"` and parse again.
3. Use the same parser for startup validation and order lookup.

The change does not broaden accepted product shapes, change credentials, or expose variant IDs through the public catalog API.

## Deployment evidence

- Branch: `main`
- Local `HEAD`: `227ccf1fe7ae3570963b7777aa13e4a3b5ea3da6`
- `origin/main`: `227ccf1fe7ae3570963b7777aa13e4a3b5ea3da6`
- Live `/version` commit: `227ccf1fe7ae3570963b7777aa13e4a3b5ea3da6`
- Live build time: `2026-07-31T15:39:15.503Z`
- Schema version: `39`
- Hostinger deployment: started 2026-07-31 09:41 MDT; current runtime started at 09:43:45 MDT
- Deployment archive: `pawsome3d-deploy.zip`
- Archive size: 11,140,749 bytes
- SHA-256: `3583bcf752e41151e3fc7d841ba471a7497275cd29609dbb3efa08a221eb4922`
- Archive validation: 65 required manifest files verified and no environment/credential files found

## Verification performed

### Local release checks

| Check | Result |
|---|---|
| Focused Stationery provider tests | **PASS** — 3/3, including a Hostinger-literal escaping regression test |
| TypeScript check | **PASS** — `tsc --noEmit` |
| Production build on Node 24.18 | **PASS** |
| Full repository test suite | **FAIL** — one unrelated existing shell-layout contract expects the old fixed desktop sidebar markup in `src/App.tsx` |

The full-suite failure is not in the deployed server repair, but it is still release debt and should be corrected rather than ignored.

### Live route sweep

The following returned HTTP 200 at the end of the review:

- `/`, `/sign-up`, `/pricing`, `/how-it-works`
- `/3d-pet-models`, `/dog-3d-models`, `/cat-3d-models`, `/pet-memorial-models`
- `/pet-professionals`, `/guides`
- `/healthz`, `/readyz`, `/version`
- `/api/fulfillment/readiness`, `/api/pawprints/print-products`
- `/robots.txt`, `/sitemap.xml`, `/site.webmanifest`

The PWA manifest is valid JSON at `/site.webmanifest` with the expected standalone start configuration. The home page supplies a title, description, canonical URL, and structured-data blocks.

### Runtime and fulfillment

- `/healthz`: `status=ok`
- `/readyz`: `status=ready`; database configured and healthy
- `/api/fulfillment/readiness`:
  - Slant3D model printing: available, no blockers
  - Printful Pawprint printing: available, four products, no blockers
- The authenticated Print Shop renders all four Pawprint formats and prices.
- The production log records successful object-storage upload for the QA Pawprint.
- Hostinger runtime: zero errors after the repaired deployment.
- A live vendor-authentication probe and real order lifecycle remain unverified because the admin-only probe is not exposed in the UI and extracting the session credential was deliberately avoided.

### Authenticated functional test

1. Confirmed the production admin profile and starting balance of 10,880 PupCoins.
2. Attempted text-to-model generation with texture disabled (45-PupCoin UI price).
3. The global daily reference-generation safety limit rejected the request before provider work or debit.
4. Created a digital Pawprint from `public/featured-models/tuck.jpg` with the title `Production QA 2026-07-31`.
5. Confirmed the finished artifact was uploaded, returned as WebP, and persisted as the newest Pawprint in Fur Bin.
6. Reopened Profile and confirmed the balance was still 10,880. Source review confirms admins intentionally bypass `pawprint_generation` deductions, so this is expected admin behavior rather than evidence that customer billing works.

No personal photo, recipient email, shipping address, payment, provider order, or secret value was used or recorded in this report.

## Findings requiring follow-up

### High — 3D creation is unavailable when the global safety limit is exhausted

The normal Create flow currently rejects new reference generation with the global safety-limit message. The failure is safe and does not debit the user, but it blocks the core paid model workflow. Confirm whether the daily cap was intentionally exhausted; if not, inspect the global budget state and its reset job.

### Medium — Customer credit deduction is not covered by this admin test

The UI advertises a 75-PupCoin Pawprint charge, but the production admin account bypasses that charge by design. Run one controlled non-admin creation to verify the debit, ledger entry, insufficient-balance response, and idempotent replay behavior.

### Medium — Production response headers need hardening

The home response includes only `Content-Security-Policy: upgrade-insecure-requests` at the edge and exposes `X-Powered-By: Express`. The observed response did not include HSTS, `X-Content-Type-Options`, `Referrer-Policy`, or `Permissions-Policy`. Verify whether Hostinger can preserve the application CSP and set the missing headers at the edge before changing application policy.

### Low — Hostinger log issue count is noisy

Hostinger displayed 27 issues and zero errors. The issues were repeated `Normalized Hostinger escaping in PAWPRINT_PRINT_PRODUCTS_JSON` warnings on catalog reads, not failed requests. Logging normalization once at startup would make real operational issues easier to see.

### Low — One repository-wide test is stale

`tests/shell_layout_contract.test.mjs` still expects the former fixed desktop sidebar markup. Update the contract to the current responsive shell so the full suite can return green.

### Low — Pawprint email copy is misleading

The UI says the email includes the `$75 PupCoins creation price`; the dollar symbol should not prefix a virtual-currency amount.

## Recommended next verification sequence

1. Restore 3D reference-generation capacity and repeat one 45-PupCoin model request.
2. Use a controlled non-admin customer account for one 75-PupCoin Pawprint, verifying balance and ledger before/after.
3. Run the admin fulfillment verification endpoint through an approved admin UI to confirm live Printful authentication and order-read access without creating an order.
4. If a real transaction is authorized, run one low-cost Printful checkout in test mode and verify webhook-to-order state transitions. Do not send a production order merely to prove configuration.

## Final state

- **Live:** yes
- **Exact deployed commit verified:** yes
- **Fatal Printful map startup error resolved:** yes
- **Printful catalog visible and orderable:** yes
- **Post-deployment Hostinger errors:** zero
- **Core paid 3D creation available:** no, blocked by global daily limit
- **Customer PupCoin debit proven:** no, admin bypass prevented a customer-path assertion
- **Real fulfillment transaction proven:** no, intentionally not created
