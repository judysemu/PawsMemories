# Pawsome3D Remaining Fixes and Deployment Gate — 2026-07-31

> Current release handoff. Detailed finding evidence remains in
> `FULL_CODEBASE_AUDIT_2026-07-31.md`; live results belong in
> `PRODUCTION_DEPLOYMENT_REVIEW_2026-07-31.md`.

## Current decision

**READY FOR COMMIT AND DEPLOYMENT VERIFICATION; NOT YET ACCEPTED LIVE.**

All deployment-blocking defects found in the 934-path review are either repaired
in the release tree or placed behind a server-owned default-off gate before paid,
provider, storage, or customer work. Acceptance still requires publishing one
exact commit, activating it on Hostinger, completing the real admin workflow, and
reviewing the resulting runtime/browser evidence.

## Completed code gates

- Full serial Node 24.18.0 suite: **1,387 total / 1,384 passed / 3 intentional
  skips / 0 failed**, including real MySQL concurrency and migrations through
  schema 44.
- TypeScript: **PASS**.
- Production build: **PASS**; client, 2.1 MB server bundle, and 79-file release
  manifest generated.
- Contract/security suites: **48/48 PASS**.
- IFC worker: **6/6 PASS** under Python 3.11 with pinned
  `ifcopenshell==0.8.5`.
- Dependency audit: **0 vulnerabilities**.
- Redacted source secret scan: **PASS**; ten heuristic alerts were reviewed as
  environment reads, request fields, configured client fields, or database
  columns, with no embedded credential. The committed-archive scan remains
  pending until the release archive is built from `HEAD`.

## Repairs now in the release tree

- The global reference-generation fallback is 100 rolling-24-hour attempts, with
  truthful 429 wording and failed provider attempts retained in the safety count.
- Credits, achievements, streaks, refunds, paid generation, Snapgen, Stripe credit
  packs, and Stationery payment evidence use server-owned prices and exact-once or
  transaction-locked state transitions.
- Model creation has durable provider submission/polling, cancellation, validation,
  refund recovery, rig-add-on handling, refresh recovery, and Fur Bin reopening.
- Printful variant-map parsing accepts valid JSON plus the narrow escaping produced
  by Hostinger hPanel. Stationery v2 remains disabled for this release; the active
  Pawprint Printful path uses separately payment-bound product configuration.
- The configured admin account is synchronized at startup from secret environment
  values and must have both `is_admin=1` and `is_operator=1`. Production refuses
  to start if `ADMIN_KEY`, `ADMIN_EMAIL`, or `ADMIN_PASSWORD` is missing.
- Password reset, age validation, session restoration, profile errors, camera
  cleanup, and phone-verification retirement are implemented and tested.
- Animator auth, tenant storage, URL boundaries, audio muxing, historical scene
  contracts, signature sound, result persistence, speed behavior, and exact-once
  refund paths are repaired. Absent downloadable clips are no longer advertised.
- Wags legacy recurring checkout returns 410 before Stripe. Existing list/cancel
  and delivery remain; delivery is transaction-serialized and materialization is
  protected by a connection-scoped advisory lock.
- Print uploads are authenticated, content-sniffed for GLB/glTF/OBJ/STL, decoded-
  size bounded, MIME checked, hourly limited, and daily quota counted.
- Missing cat, hero, object, weather-audio, and Animator clip URLs no longer produce
  intentional production 404s.
- The unsafe custom-product checkout is hidden and default-off before expensive or
  provider work.

## Intentionally disabled, not accepted product features

These are not Pawsome3D deployment blockers because their server gates precede all
work and the release does not advertise them as available:

- `INHOUSE_SPATIAL_GENERATOR_ENABLED=false`: outstanding spatial lease, print-STL,
  credit, heartbeat, and recovery findings remain open. The admin-only health route
  may be inspected, but the scheduler and job routes must remain off.
- `STATIONERY_V2_ENABLED=false`: the external v2 render worker still needs a true
  asynchronous durable worker lease/replay contract. Legacy Pawprint fulfillment
  is separate.
- `WAGS_V2_ENABLED=false`: the new subscription surface remains dark-launched.
  Unsafe legacy subscription creation is retired.
- `CUSTOMIZER_CHECKOUT_ENABLED=false`: the physical product customizer must not be
  enabled until payment-first preparation is implemented.
- Studio proxy remains default-off until the Python service enforces both injected
  owner and internal-secret headers.
- fal.ai PATINA PBR manifest remains empty until paid generation and visual QA are
  performed. Curated scalar materials remain the truthful runtime fallback.
- `x-dm-service` is a separate application and is not imported or started by the
  Pawsome3D web process. Its webhook/OAuth/deduplication findings remain separate
  deployment work.

## Remaining release blockers

1. Verify the final diff, commit on the dedicated branch, push the exact SHA,
   open the GitHub review, and confirm CI.
2. Build a secret-free Hostinger archive from committed `HEAD`; verify file list,
   checksum, exact SHA, and extraction/startup before upload.
3. In Hostinger, keep all default-off flags above false. Confirm the Printful map
   is parseable without revealing its value and confirm the active Pawprint product
   catalog/readiness variables are present.
4. Deploy the exact archive and verify `/version` reports the committed SHA,
   `/healthz` proves liveness, and `/readyz` proves database/storage/provider
   readiness. A cached homepage is not acceptance.
5. Use the configured admin credentials through the normal live login. Verify the
   account receives both administrator and operator access without exposing or
   changing the secret values.
6. Spend the admin account's existing credits on one real production journey:
   reference session → five generated views → approval → one paid model build
   → durable accepted model → page reload → model visible/openable in Fur Bin.
7. Inspect browser console/network and Hostinger runtime logs after the real run.
   Record the provider task, wallet debit/refund disposition, model state, durable
   artifact, Fur Bin result, and every 4xx/5xx without recording credentials or
   signed asset URLs.
8. Verify the live Pawprint design/save/download/email flow and the Printful
   readiness endpoint. Do not place a real merchandise order unless explicitly
   authorized; readiness and draft-order boundaries are sufficient for this
   release review.

## Separate furryfriend.cc delivery

The content brief is complete, but the site has not yet been built or deployed.
After Pawsome3D live acceptance, create the branded SEO site and article cascade
for pet memorials/keepsakes, photo-to-animated-3D education, unique pet gifts and
Send a Pawprint, and historical pet-avatar collections. Deployment must include
indexing metadata, sitemap/robots, direct article routes, mobile checks, and links
back to the relevant Pawsome3D customer flows.

## Acceptance rule

The release becomes **PASS** only after the exact published SHA is live, readiness
is green, the real admin-credit model journey persists through reload into Fur Bin,
and post-run logs/browser evidence contain no unexplained production error. Until
then the honest status is **code verified, live verification pending**.
