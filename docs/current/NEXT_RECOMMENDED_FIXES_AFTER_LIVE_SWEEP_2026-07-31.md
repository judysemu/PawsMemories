# Pawsome3D next recommended fixes after the live production sweep

Date: 2026-07-31 (America/Denver)
Production domain: `https://pawsome3d.com`
Deployed commit: `2d15391b982f8d070511e420f1f92c63fc90bd04`
Branch: `codex/pawsome3d-production-hardening`
Draft PR: `#20`
Deployment archive SHA-256: `05eb14844339357ba0ed9108c175f6b9fba8bcef26090a07a059c835a398a335`

## Executive verdict

**PARTIAL PASS — the core AI generation pipeline is live, but customer delivery is not ready for release.**

The production deployment is healthy and runs the exact expected commit. A new authenticated production order generated five reference views, charged 45 PupCoins, produced a private 98,114-triangle GLB through Tripo, charged another 8 PupCoins, and produced a textured GLB with one material, three textures, and three embedded images. The exact customer-approved asset reached the operator queue as version 207.

The operator release was deliberately not approved because the required secure 3D preview was blank and the browser reported a failed model fetch. Releasing an asset that could not be visually inspected would defeat the human quality gate. The order remains safely held in the operator queue.

## Live sweep results

| Area | Verdict | Evidence |
|---|---|---|
| Hostinger deployment | PASS | Deployment completed at 15:10 local time and `/version` reports the exact deployed commit above. |
| Liveness | PASS | `/healthz` returned HTTP 200. |
| Readiness | PASS | `/readyz` returned HTTP 200 with a configured, healthy database. |
| Public and SEO routes | PASS | All 25 sitemap URLs plus `robots.txt`, `sitemap.xml`, `healthz`, `readyz`, and `version` returned HTTP 200. |
| GitHub verification | PASS | Type Check, Unit & AR Tests, Security Scan, IFC Tests, Contract Tests, and Production Build passed on the deployed commit. |
| Runtime startup | PASS | Hostinger reports zero runtime errors. All eight animator environment presets loaded from the packaged `dist` tree, migrations reached schema 44, and static serving started. |
| Admin account | PASS | The configured account was synchronized at startup and the live UI identified it as Admin. The server-guarded Wags admin panel opened. No credential values are stored in source or this report. |
| Operator role | PASS | The Pet GLB operator release queue loaded and exposed the exact customer-approved version. |
| Reference safety limit | PASS | A brand-new attempt generated front, left, rear, right, and three-quarter views. No HTTP 429 or global-safety-limit message occurred. |
| Base 3D generation | PASS | Attempt 1 charged 45 PupCoins. Tripo completed successfully. Validation found one scene, one mesh, 98,114 measured triangles under the 150,000 HD limit, and embedded buffers. |
| Texture generation | PASS | Attempt 1 charged 8 PupCoins. The final GLB retained 98,114 triangles and contained one material, three textures, and three images. |
| Credit integrity | PASS | The live Admin balance moved from 10,880 to 10,827, exactly matching the 53 PupCoins approved in the test. |
| Secure customer preview | FAIL | The preview remained blank. `<model-viewer>` reported a failed fetch and had no usable loaded source after the error. |
| Secure operator preview | FAIL | Version 207 and its validation evidence loaded, but the operator's model preview did not render. The operator viewer also collapsed to zero height. |
| Operator release | BLOCKED BY DESIGN | The exact version was not released because it could not be visually inspected. |
| Fur Bin | PARTIAL | The live library loaded 28 existing models and its other stored outputs. The new order did not appear because the required operator release was withheld. |
| Printful catalog | PASS FOR CONFIGURATION | The Print Shop loaded all four configured Pawprint formats and prices. Hostinger JSON escaping was normalized without a startup failure. No paid order was placed. |
| Slant 3D print entry | PASS FOR CONFIGURATION | An existing model opened the print dialog with height, shipping fields, GLB download, and price/checkout controls. No shipping address or payment was submitted. |
| Pawprints | PASS FOR ENTRY | The production upload step loaded with the expected image constraints. A paid/rendered Pawprint was not created in this sweep. |
| Wardrobe Wags | PASS FOR ENTRY | The customer inbox and the Admin review panel both loaded. This account currently has no boxes. |
| Animator | NOT RELEASED | The public Animator route intentionally shows “Under Construction.” It is not a live customer feature despite the packaged historical scene and sound assets. |

## Recommended fixes, in priority order

### P0 — make private GLBs visibly inspectable before release

The customer and operator preview endpoints return a short-lived private asset capability, but the live `<model-viewer>` fetch fails. Existing public Backblaze models render in the same application, so the private-bucket delivery boundary is the leading suspect.

Recommended implementation:

1. Verify the private Backblaze bucket permits `GET`, `HEAD`, and required range requests from `https://pawsome3d.com`, including presigned query-string requests.
2. Prefer an authenticated same-origin streaming endpoint for private GLBs if reliable private-bucket CORS cannot be guaranteed. Preserve `Content-Type: model/gltf-binary`, byte ranges, bounded sizes, ownership checks, and short cache lifetimes.
3. Give `PetModelViewer` explicit `load` and `error` states. A signed URL existing is not proof that a model loaded.
4. Keep “Approve exact version & release” disabled until the exact GLB emits a successful viewer load event.
5. Add an end-to-end test that signs a real private fixture and proves both the customer and operator viewers load the exact hash-bound version.

Acceptance gate: version 207, or a new equivalent production fixture, renders in both review surfaces; the release button remains unavailable before the load event; no viewer fetch error appears.

### P0 — repair the operator preview layout

The operator `<model-viewer>` measured 240 pixels wide but zero pixels high. The component's inline `height: 100%` overrides the supplied fixed-height utility class when its parent has no explicit height.

Recommended implementation:

1. Put the operator viewer inside a fixed-height wrapper and let the custom element fill that wrapper.
2. Remove or conditionally apply the inline height that overrides `h-64` and other caller-provided sizes.
3. Add desktop and mobile visual tests for non-zero viewer dimensions.

Acceptance gate: the operator preview has non-zero dimensions before and after model load at supported breakpoints.

### P0 — register the released Pet GLB in Fur Bin atomically

The customer expectation says completed private models appear in Fur Bin. The new Pet GLB workflow reaches operator approval, while Fur Bin currently reads the legacy model library and a separate v5 registry. The release path must have one explicit, tested ownership handoff.

Recommended implementation:

1. On exact-version operator approval, idempotently register or update the owner's Fur Bin item in the same durable workflow.
2. Bind the item to the approved asset/version ID and recorded SHA-256; never substitute the newest version implicitly.
3. Make retries safe and prevent duplicate library cards.
4. Reload Fur Bin in an end-to-end test and open/download the exact released version.

Acceptance gate: an approved order appears once in Fur Bin after a fresh page load, and its viewer/download resolve to the operator-approved version and hash.

### P1 — add stale Pet GLB order recovery and visible refund evidence

The live Recent Model Orders list still contains an older “base generating” order. The new order completed correctly, but stale historical rows should not remain indefinitely ambiguous.

Recommended implementation:

1. Add a bounded Pet GLB stage lease/reaper that distinguishes a legitimately running provider job from an abandoned one.
2. Resume jobs only from durable provider handles; never resubmit an ambiguous create request.
3. Fail and refund exactly once when recovery is impossible, and show the refund correlation in the order UI.
4. Give Admin a safe “inspect recovery evidence” action rather than a blind retry.

### P1 — boot-test the exact deployment archive in CI

The first 15:03 deployment passed Hostinger's build step but failed at runtime because animator environment JSON and historical sound files were not available at the paths used by startup validation. The corrected build now packages eight environment presets and four sound files under `dist`.

Recommended implementation:

1. Extract the generated ZIP into a temporary directory in CI.
2. Start it with production-like environment validation and a test database.
3. Assert `/healthz`, `/readyz`, `/version`, `/`, and `/create` before accepting the artifact.
4. Fail if required runtime assets are absent even when the TypeScript bundle itself builds.

### P1 — make the model viewer a pinned application dependency

The live console warns that multiple Three.js instances are loaded from the external Model Viewer CDN. Bundle a reviewed, pinned Model Viewer version or otherwise guarantee one compatible Three.js runtime. This removes a third-party runtime dependency and makes production behavior reproducible.

### P1 — keep rig generation closed until it has a funded, tested production path

`PETSIM_RIG_GLOBAL_DAILY_CAP=0` blocks rig generation, not printing. That is currently consistent with Animator being under construction. Do not raise the cap merely to hide the message. Enable it only after provider budget, exact-once credit handling, rig validation, animation compatibility, and a real live run all pass.

### P1 — finish and explicitly release Animator

Historical scene definitions, environment presets, and sound assets are packaged, but customers still see an Under Construction screen. Before removing that gate, prove model loading, rig compatibility, scene playback, audio muxing, downloadable video integrity, and mobile fallback in production. Evaluate optional fal.ai PBR accessory textures only after the base private-model review gate is reliable.

### P2 — complete controlled fulfillment tests

The storefront and forms are live, but no production purchase was authorized during this sweep. Run one controlled Pawprint/Printful order and one controlled model/Slant order with an approved test recipient and payment method. Verify Stripe binding, webhook idempotency, provider order creation, tracking, refunds, and customer-visible status before marketing either path as fully proven.

## Printing blocker clarification

The listed `PETSIM_*` daily and global caps govern AI generation categories. They do not block Printful or Slant 3D fulfillment. The only directly relevant zero is `PETSIM_RIG_GLOBAL_DAILY_CAP=0`, which closes rig generation. The earlier startup blocker was malformed Hostinger escaping around `PRINTFUL_STATIONERY_VARIANT_MAP`; the deployed parser now handles the narrow Hostinger-escaped form, and the live Print Shop successfully loaded all four formats.

## Deliberately not performed

- The operator release was not approved without a working visual preview.
- No real shipping address, payment method, Stripe checkout, Printful order, or Slant 3D order was submitted.
- No stale production order was deleted or force-completed.
- No credentials, API keys, signed asset URLs, or secret environment values were copied into source control or this report.
- `furryfriend.cc` was deployed separately after this sweep. That static editorial deployment does not prove or change any Pawsome3D production status in this report.

## Resume point

Start with the private GLB preview and non-zero operator viewer height. Re-run the exact customer reference → base → texture → customer approval → operator visual inspection → operator release → Fur Bin reload chain. Do not claim end-to-end completion until the released asset is visibly inspectable and persists as the exact approved version.

## Local P1 execution evidence — 2026-07-31

This section records local code and artifact evidence only. It does not upgrade any DEPLOYED, LIVE, or END-TO-END status.

| P1 item | CODE | LOCAL | ARCHIVE | DEPLOYED | LIVE | END-TO-END | Evidence / remaining gate |
|---|---|---|---|---|---|---|---|
| Stale Pet GLB recovery | PASS | PASS | N/A | NOT RUN | NOT RUN | NOT RUN | Additive schema v45, bounded stale-current leases, durable-handle-only resume, redacted operator evidence, and immutable-debit refunds are implemented. Five real-MySQL recovery tests pass, including exclusive leases, exactly-once refunds, no refund after a concurrent stage transition, no blind provider create, and evidence persistence. |
| Exact deployment archive boot | PASS | PASS | PASS | NOT RUN | NOT RUN | NOT RUN | The clean `46a1dfa` ZIP was extracted, production dependencies were installed, packaged root `server.cjs` booted, `/healthz`, `/readyz`, `/version`, `/`, and `/create` passed, and missing-secret plus missing-sound boot failures were proven. The dedicated database reset is restricted to `paws_archive_smoke*`. |
| Pinned model viewer | PASS | PASS | PASS | NOT RUN | NOT RUN | NOT RUN | `@google/model-viewer@4.0.0` and application `three@0.169.0` are lockfile-pinned, the runtime CDN loader is removed, and the production build emits a local model-viewer chunk. Nested development/library Three.js versions remain visible in `npm ls`; no live runtime duplication claim is made. |
| Rig generation closed | PASS | PASS | N/A | NOT RUN | NOT RUN | NOT RUN | A zero rig request or cost cap reports unavailable in the product contract and rejects rig orders before charge/provider dispatch. Production limits were not raised. |
| Animator release candidate | PASS | PASS | PASS | NOT RUN | NOT RUN | NOT RUN | Admin can reach the existing release candidate while customers retain the Under Construction gate. Deterministic scene, audio, ffmpeg mux, ownership, and packaged-asset tests pass. A live browser export with audible output remains required before customer release. |

### Accepted local P1 checkpoint

- Commit: `4b1c783` (`fix: complete P1 production hardening`).
- Required runtime: Node `v24.18.0`.
- Typecheck: PASS.
- Focused recovery/rig/Animator tests: 37 passed, 0 failed, 0 skipped.
- Full suite: 1,399 tests; 1,396 passed, 0 failed, 3 repository-defined skips.
- Contract suite: 40 passed, 0 failed.
- Security suite: 8 passed, 0 failed.
- Production build: PASS; the viewer is bundled locally and no Model Viewer CDN reference is present.
- Clean archive commit: `46a1dfaa4db4fe11f016ed6b303eb20ab9db2929`.
- Clean archive: 21,047,312 bytes; SHA-256 `24d2d264bade2a39fbce0fe6f6fc0fc4dcbdafe1274026a20671c8eb6dac3b32`.
- Exact extracted-archive boot smoke: PASS under Node `v24.18.0`.

## Remaining P0 work

P1 is locally accepted, not deployed. The original P0 release boundary remains open: authenticated same-origin GLB streaming with range support, non-zero viewer layout and explicit load/error state, exact version/hash load-gated operator approval, and atomic idempotent Fur Bin registration. No production deployment or Pawsome3D end-to-end rerun was performed for commit `4b1c783`.

The updated copy/paste handoff is `docs/current/CODEX_REMAINING_P0_P1_HANDOFF_2026-07-31.md`.
