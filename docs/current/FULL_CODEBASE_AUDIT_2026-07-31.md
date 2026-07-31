# Pawsome3D Full Codebase Audit — 2026-07-31

> Status: **IN PROGRESS**. This report is not a completion claim. Findings are added only after reproduction and remain open until the listed verification succeeds.

## Audit baseline

- Repository: `/Users/robert/Desktop/claude7126/PawsMemories`
- Starting branch: `main`
- Starting commit: `227ccf1fe7ae3570963b7777aa13e4a3b5ea3da6`
- Starting tracked paths: 934
- Starting worktree exception preserved: untracked `docs/current/PRODUCTION_DEPLOYMENT_REVIEW_2026-07-31.md`
- Supported runtime: Node 24.18.0

## Review coverage manifest

| Partition | Tracked paths | Reported line count | Review status |
|---|---:|---:|---|
| Server/API/database | 160 | 40,689 | Reviewed at immutable baseline |
| Client/UI | 209 | 44,697 | Reviewed at immutable baseline |
| Model/worker/agent services | 164 | 45,471 | Reviewed at immutable baseline |
| Tests | 211 | 26,398 | Reviewed at immutable baseline |
| Tooling/configuration | 82 | 18,197 | Reviewed at immutable baseline |
| Documentation | 31 | 4,671 | Reviewed at immutable baseline |
| Assets/fixtures | 77 | 94,422 | Structurally reviewed at immutable baseline |
| **Total** | **934** | **274,545** | **Review complete; repairs and release verification in progress** |

The line count is the mechanical `wc -l` result across tracked files and therefore includes meaningless newline counts inside some binary assets. Completion requires every tracked path to have exactly one review disposition. Text source/configuration is read line by line; binary/generated paths are checked for signature, integrity, size, duplicates, references, and repository appropriateness.

## Findings and fixes

### AUD-001 — Reference generation globally unavailable after ordinary accumulated use

- Severity: **Critical**
- Status: **FIXED LOCALLY — independently reviewed; integrated/live verification pending**
- Production symptom: `POST /api/reference-sessions/start` returns HTTP 429 with `Reference generation has reached today's global safety limit.`
- Affected code: `server/reference-sessions/service.ts`
- Reproduction evidence at 2026-07-31 22:07 database time:
  - Rolling 24-hour attempts: 29
  - Ready: 26
  - Failed: 3
  - Generating: 0
  - Effective production fallback cap when the environment variable is absent: 20
- Root cause established so far:
  - The guard counts every `reference_attempts` row started during the prior 24 hours, including terminal ready and failed attempts.
  - The configured production environment did not expose `REFERENCE_GENERATION_GLOBAL_DAILY_ATTEMPT_CAP`, so the hard-coded fallback of 20 applied to durable historical attempts.
  - The documented `REFERENCE_GENERATION_USER_DAILY_ATTEMPT_CAP` is not enforced by the current service, allowing one account or QA session series to consume the shared pool.
  - A denied 429 creates no model and must not be reported as a successful model test.
- Fix applied:
  - Production fallback raised from 20 to 100, while retaining the hard accepted
    maximum of 200 and the unchanged minute/concurrent spend guards.
  - The durable rolling query continues to count every started attempt,
    including failures where provider spend may already have occurred.
  - The unused user-cap documentation claim was removed; the service now
    exposes a pure budget resolver for behavior-focused testing.
  - The customer message now says `rolling 24-hour`; the existing
    `DAILY_ATTEMPT_CAP` code and HTTP 429 mapping remain unchanged.
- Verification: focused regression 1/1, affected reference suites 36/36,
  TypeScript and diff checks passed. A fresh independent reviewer returned
  **PASS** with no material findings.
- Remaining acceptance: a real authenticated reference set and downstream 3D
  model must complete on the exact deployed commit and appear in Fur Bin.

Operational mitigation applied during the audit: Hostinger now has
`REFERENCE_GENERATION_GLOBAL_DAILY_ATTEMPT_CAP=100`. Hostinger restarted the
application after the configuration change, and the replacement process reached
clean application startup with zero Hostinger errors. This raises the global
rolling allowance above the 29 attempts already recorded; it is only the live
configuration half of the repair and is not evidence that a model completed.

### AUD-002 — Shell layout contract pinned a retired desktop width

- Severity: **Low (test reliability)**
- Status: **FIXED LOCALLY — independently reviewed; integrated rerun pending**
- Affected file: `tests/shell_layout_contract.test.mjs`
- Reproduction: the full Node suite failed because the test required the former
  `w-64` / `md:ml-64` / `16rem` shell even though the reviewed UI consistently
  uses `w-56` / `md:ml-56` / `14rem`.
- Fix: align the layout regression test with the actual 14-rem desktop sidebar.
- Focused verification: 4 passed, 0 failed. A long-running full-suite process had
  loaded the old module before the edit and therefore repeated the old failure;
  a fresh integrated suite remains required.

### AUD-003 — Unused development tooling kept 14 dependency vulnerabilities installed

- Severity: **High (supply-chain exposure)**
- Status: **FIXED LOCALLY — independently reviewed; integrated rerun pending**
- Affected files: `package.json`, `package-lock.json`,
  `scripts/animator-doctor.mjs`
- Reproduction: `npm audit --audit-level=moderate` reported 14 vulnerabilities
  (1 moderate, 13 high). The remaining vulnerable chain was reachable only from
  the unused `@react-three/eslint-plugin` and from `@gltf-transform/cli`, which
  the application never invokes; it imports the maintained
  `@gltf-transform/core`, `extensions`, and `functions` libraries directly.
- Fix: remove the two unused direct packages and keep the runtime library import
  probe. Do not use `npm audit fix --force`.
- Focused verification: `npm audit --audit-level=moderate` reports zero
  vulnerabilities and signature verification passed. The dead `execSync`
  fallback was removed and the worker probe now uses bounded built-in `fetch`.
  Missing/unreachable/non-2xx workers are explicit optional warnings. The
  corrected package passed 16/16 focused tests and independent re-review.

### AUD-004 — Public Blender worker exposed arbitrary Python execution

- Severity: **Critical**
- Status: **FIXED LOCALLY — independently reviewed; deployment pending**
- Affected files: `blender-worker/server.js`,
  `blender-worker/bridge/tcp_server.py`, `blender-worker/Dockerfile`,
  `tests/blender_worker_auth.test.mjs`
- Reproduction:
  - The raw JSON-RPC bridge bound `0.0.0.0:9876`, was published by the
    container, accepted no credential, and passed request text to Python
    `exec()` with builtins.
  - `/render`, `/rig-model`, `/bake-clips`, `/bake-sprites`, and
    `/jobs/:jobId` were reachable without `x-worker-secret`; the first two
    execute caller-supplied Python.
  - The behavioral regression test initially observed HTTP 400 from an
    unauthenticated `/render` request instead of the required HTTP 401.
- Fix:
  - Authenticate every non-health HTTP path before the 100 MB JSON parser and
    fail closed when the configured secret is absent.
  - Bind the raw bridge to loopback by default, with only an explicit private
    network override, and stop publishing port 9876 from the container.
- Focused verification: the new integration test is green, 4 passed / 0 failed,
  covering unauthenticated rejection, authenticated routing, public health, and
  container/bridge exposure policy. The HTTP comparison now uses equal-length
  buffers and `crypto.timingSafeEqual`; the corrected combined package passed
  16/16 focused tests and independent re-review.

### AUD-005 — Shipped UI advertises assets that return production 404s

- Severity: **High (visible broken product surfaces)**
- Status: **Fixed locally**. Missing cat, hero, Animator clip, weather-audio, and
  object URLs are no longer advertised. Shipped imagery, embedded model clips,
  manifest-backed signature sound, and procedural owned fallbacks are used instead.
- Affected files include `src/components/landing/CatModelsPage.tsx`,
  `src/components/HeroScroller.tsx`, `server/animator/clips.ts`,
  `src/animator/scenes/sound/SoundSystem.tsx`, and
  `src/three/objects/catalog.ts`.
- Reproduction: source/reference reconciliation found missing public assets; live
  production returned HTTP 404 for representative cat catalog art, the hero
  reel, an advertised animation clip, weather audio, and an object GLB. Some
  components intentionally fall back, but the cat landing cards render broken
  images and the animator API advertises clips that cannot be downloaded.
- Required fix acceptance: no production UI/API should advertise a missing
  asset, and the post-deployment browser/network sweep must contain no resulting
  404s.

### AUD-006 through AUD-020 — Model, spatial, Studio, and X-DM durability/security defects

The 164-file model/worker audit completed at the immutable starting SHA and
confirmed the following additional defects. Exact fixes and final verification
will be added as they are implemented:

| ID | Severity | Confirmed defect | Status |
|---|---|---|---|
| AUD-006 | High | Studio trusts caller-supplied user/credit identity, lacks proxy authentication, and does not owner-scope production reads/mutations. | Fixed locally at the Node boundary; the proxy is default-off, JWT-gated, injects server-authenticated owner identity plus a 32-byte internal secret, and strips the browser credential; 2/2 focused security tests PASS. The Python worker must enforce those injected headers before enablement |
| AUD-007 | High | Cancelling a submitted model build can be overwritten by the original provider-start worker, producing a refunded free build. | Fixed locally; corrected re-review PASS |
| AUD-008 | High | Provider acceptance is not durably reconcilable across a crash/DB failure; provider config idempotency is not used. | Fixed locally with locked lease recheck and explicit ambiguous-create quarantine; corrected re-review PASS |
| AUD-009 | High | Model polling hardcodes 500 ms × 120 instead of the declared 5 s × 120 contract, timing out near 60 seconds rather than ten minutes. | Fixed locally with ten-minute pacing and active-state recovery; corrected re-review PASS |
| AUD-010 | High | A refund failure after model-build failure is logged but has no durable retry/reconciler. | Fixed locally with durable refund sweep and current-attempt billing; corrected re-review PASS |
| AUD-011 | High | Spatial scheduler leasing is process-local and does not atomically claim work across instances. | Open behind a fail-closed release gate; `INHOUSE_SPATIAL_GENERATOR_ENABLED` remains false and the scheduler does not start |
| AUD-012 | High | Spatial stage lease nulls are silently omitted, pausing successive stages until the ten-minute lease expires. | Open behind the same disabled/admin-only spatial gate; no production customer or credit path is exposed |
| AUD-013 | High | Spatial `target_use=print` always reaches finalization without an STL and therefore always fails after paid work. | Open behind the same disabled/admin-only spatial gate; print use cannot be submitted in this release |
| AUD-014 | High | Spatial credit reservation checks balance outside the debit transaction and can overdraw under concurrency. | Open behind the same disabled/admin-only spatial gate; the scheduler and job routes fail closed |
| AUD-015 | High | Rig heartbeat database errors are treated as retained ownership; a stale worker may persist after another worker recovers the lease. | Open behind the same disabled/admin-only spatial gate |
| AUD-016 | High | X webhooks return HTTP 200 before durable receipt; a crash/DB outage can permanently lose an acknowledged event. | Open in the separate `x-dm-service`; it is not imported, started, or deployed by the Pawsome web process |
| AUD-017 | High | Public X OAuth bootstrap can replace the configured bot credentials without operator authentication or bot-user verification. | Open in the separate, non-deployed `x-dm-service` |
| AUD-018 | Medium | Replacing a reference source preserves exhausted retry allowance, so the replacement cannot be generated. | Fixed locally; schema 41 real-MySQL history/reset proof PASS |
| AUD-019 | Medium | Concurrent duplicate X deliveries ignore the insert winner and may emit duplicate replies; the daily cap is also a non-atomic read/write. | Open in the separate, non-deployed `x-dm-service` |
| AUD-020 | Medium | Spatial stale recovery discards the durable stage and restarts advanced attempts from observation. | Open behind the disabled/admin-only spatial gate |

### AUD-021 through AUD-045 — Client routing, state, and workflow defects

The 209-file client audit also completed at the immutable starting SHA. All
findings below were traced through the corresponding UI and API contract; they
remain pending until a focused regression test and fix are recorded:

| ID | Severity | Confirmed defect | Status |
|---|---|---|---|
| AUD-021 | High | Signed-out public deep links are discarded because URL resolution/history synchronization run only after authenticated session restoration. | Fixed locally; initial public path resolution and signed-out public history synchronization PASS |
| AUD-022 | High | Any transient `/api/me` network/5xx failure becomes `null` and permanently clears a valid session token. | Fixed locally; only authoritative 401/403 clears the token and transient failures preserve it |
| AUD-023 | High | Animator voiceover upload uses unauthenticated `fetch`, then expects `filename` although the server returns `url`. | Fixed locally; recording upload and voiceover requests send auth and consume the server `recordingId` contract |
| AUD-024 | High | Paid/in-progress Pet GLB orders disappear after refresh; only approved/delivered orders can be reopened. | Fixed locally; all owner order states reopen with truthful state labels |
| AUD-025 | High | Wags-exclusive wardrobe IDs are offered but dropped/declined by the base-only persistence path. | Fixed locally; the full catalog is rendered and exclusive items are persisted only after server-side ownership verification |
| AUD-026 | High | Fido's Styles retains the prior avatar project across avatar changes and ignores non-2xx autosave failures. | Fixed locally; avatar changes reset project/settings, stale loads are discarded, and load/save failures are visible |
| AUD-027 | High | Pawprint design mutations do not invalidate the saved artifact, so Send/Print can use an older design. | Fixed locally; every visual mutation invalidates the saved creation and in-flight saves are revision checked before enabling Send/Print |
| AUD-028 | High | Feature-flagged V3 checkout charges/promises a rig but static-model acceptance never starts the rig job. | Fixed locally in the primary Create pipeline; the server-authoritative quote reserves the rig add-on, durable static-model completion prepares and starts the leased rig path, and rejected rig work delivers the static model while refunding only the add-on; 29/29 focused model/recovery/security tests PASS |
| AUD-029 | High | Photo/video request UI calls `/api/photo-requests` routes that are not registered, while list helpers hide the 404 as an empty result. | Fixed locally by retiring the unbacked customer/admin surfaces from imports and routing; old bookmarks and Randy actions now open Pawprints, while the legacy source remains preserved for a future fully backed implementation |
| AUD-030 | Medium | Returning accounts with incomplete profiles are routed to Dashboard and cannot resume onboarding consistently. | Fixed locally; valid incomplete sessions resume the profile step with server-returned fields and retain the token |
| AUD-031 | Medium | Fur Bin V5 hard-limits results to 40 and has no pagination/load-more path despite returning a total. | Fixed locally; normalized page/limit controls and clamping PASS |
| AUD-032 | Medium | Concurrent Fur Bin filter requests can commit out of order and show results that do not match active filters. | Fixed locally; latest-request/unmount gate and reversed-deferred test PASS |
| AUD-033 | Medium | Pet GLB finished-print height is shown as checkout input but is never sent or persisted. | Fixed locally by removing the disconnected control; exact height is selected only in Print Shop, whose checkout sends and persists `targetHeightMm` |
| AUD-034 | Medium | Pet GLB keeps one global download URL, so opening a different recent order can expose the previous order's link. | Fixed locally; exact order/version/request binding PASS |
| AUD-035 | Medium | Create validation depends on and rewrites the same unstable context state, scheduling another validation every 1.5 seconds indefinitely. | Fixed locally; meaningful-input fingerprint and truthful pre-build checks PASS |
| AUD-036 | Medium | Rig progress depends on recreated context actions and can poll immediately at network-response speed. | Fixed locally; sequential post-settlement 2.5-second polling PASS |
| AUD-037 | Medium | Checkout's `Get More PupCoins` recovery button has an empty click handler. | Fixed locally; Store navigation preserves Create state |
| AUD-038 | Medium | Legacy reference retry always switches to multiview instead of preserving the original generation branch. | Fixed locally; retry/automatic-start branches and source-replacement recovery PASS |
| AUD-039 | Medium | Legacy Fur Bin hides every creation-model once any canonical model exists instead of deduplicating matching source identities. | Fixed locally; stable source type + creation ID deduplication PASS |
| AUD-040 | Medium | Credit Store renders `null` prices for unavailable services as `Free`. | Fixed locally; null is labeled Unavailable and zero-credit inclusions are labeled Included |
| AUD-041 | Medium | Profile save ignores non-2xx responses and exceptions, providing no failure state. | Fixed locally; non-2xx/network failures render an alert and successful persistence renders status |
| AUD-042 | Medium | Print Shop converts model-library request failures to an empty library message instead of a retryable error. | Fixed locally; failures are distinct from an empty library and expose a bounded retry |
| AUD-043 | Medium | Request/Edit Memory camera streams are stopped only by explicit UI actions, not component unmount. | Fixed locally; both preserved components stop every stream track on replacement/unmount |
| AUD-044 | Medium | GLB prop centering/grounding offsets are computed before non-unit scaling, allowing props to float or sink. | Fixed locally; scaled world bounds are recomputed before final centering and ground offset |
| AUD-045 | Medium | Animator global playback speed is not applied to clips selected after the speed change. | Fixed locally; controller stores the global multiplier and applies it to later selected, added, masked, and locomotion actions |

### AUD-046 through AUD-063 — Server, payment, credit, and trust-boundary defects

The 160-file server/API/database audit completed at the immutable starting SHA
and confirmed the following defects:

| ID | Severity | Confirmed defect | Status |
|---|---|---|---|
| AUD-046 | Critical | Legacy checkout accepts client price and signed credit delta; a paid session with a negative deduction can mint credits. | Fixed locally; independently reviewed PASS; integrated/deployment gate pending |
| AUD-047 | Critical | Achievement, share, trial, daily, and streak reward paths accept untrusted identities/results or race outside atomic claim records, enabling repeated credit minting. | Fixed locally; server-evidenced allowlist, atomic wallet/domain claims, unverifiable share/trial rewards disabled, real-MySQL concurrency PASS |
| AUD-048 | High | Stripe credit fulfillment is check-then-act; webhook and browser confirmation can both credit because wallet/ledger/idempotency are not one transaction. | Fixed locally; real-MySQL concurrency test and independent review PASS; integrated/deployment gate pending |
| AUD-049 | High | HTTP and background generation pollers can both transition/refund one failed job because terminal state and refund lack compare-and-set/idempotency. | Fixed locally; immutable debit identity is carried into jobs, terminal success/failure is compare-and-set, exact-once/refund-pending recovery and real-MySQL HTTP/background races PASS; integrated/deployment gate pending |
| AUD-050 | High | Refund-review auto/admin resolution credits before atomically claiming the review, allowing double payout. | Fixed locally; auto/admin/manual/deny races and rollback proven on real MySQL; integrated/deployment gate pending |
| AUD-051 | High | Snapgen tokens are SELECT-then-UPDATE reusable under concurrency and can be consumed before any durable external-work record exists. | Fixed locally; paid evidence/order consumption is atomic, provider submission/finalization is leased and recovery-safe, owned GLB mirroring and real-MySQL concurrency PASS; integrated/deployment gate pending |
| AUD-052 | High | `/api/download` uses a bypassable URL-prefix allow check, follows redirects, and buffers without size/timeout/ownership bounds. | Fixed locally; exact owner lookup, exact configured origin, HTTPS-only/no redirects, timeout, MIME and streaming size bounds PASS; integrated/deployment gate pending |
| AUD-053 | High | Stationery v2 can reuse one confirmed payment record for unlimited or underpriced SKU/quantity orders. | Fixed locally; exact provider/SKU/unit/quantity/total/currency/owner binding plus transactional one-time consumption and real-MySQL concurrency PASS; integrated/deployment gate pending |
| AUD-054 | High | Animator `/lipsync` aliases bypass auth and the whole tenant data directory is publicly mounted as static files. | Fixed locally; all aliases share the scoped auth guard and tenant artifacts use explicit owner-checked routes; 65/65 focused auth/network/Animator tests PASS; integrated/deployment gate pending |
| AUD-055 | High | Animator asset import accepts arbitrary URLs and buffers them; scene creation accepts caller IDs that can overwrite another owner's file. | Fixed locally; upload-only bounded import and server-generated scene IDs PASS; integrated/deployment gate pending |
| AUD-056 | High | Customizer checkout fetched an arbitrary source URL and performed resource-heavy work before payment/ownership validation. | Fixed for this release by exact-owner/bounded source validation plus a default-off `CUSTOMIZER_CHECKOUT_ENABLED` gate before database, image, storage, Printful, or Stripe work; disabled products are not advertised |
| AUD-057 | High | Phone verification lacks cost quotas/binding and treats any successful provider response as verified. | Fixed locally by retiring the nonessential UI and routes; no production SMS can be triggered until a stored account/number challenge, quotas, and exact verified-status contract are implemented |
| AUD-058 | High | Legacy Wags subscription creation did not verify pet ownership or persist durable idempotency before creating recurring billing. | Fixed locally: the unused legacy checkout now returns `410` before any provider call; existing list/cancel/delivery routes remain, while new checkout is reserved for Wags v2 |
| AUD-059 | Medium | Wags delivery/materialization used check-then-act work that allowed concurrent duplicate items, generation, or credit grants. | Fixed locally: box delivery is serialized by a row lock inside one transaction, and materialization is serialized by a connection-scoped MySQL advisory lock that releases on process/connection failure |
| AUD-060 | Medium | Password-reset token consumption is SELECT-then-unconditional-UPDATE and is separate from the password change. | Fixed locally; token row lock, conditional one-time consumption, and password replacement now commit or roll back in one transaction |
| AUD-061 | Medium | Age gate uses `Math.abs` and weak date parsing, allowing future and invalid birthdates. | Fixed locally; strict ISO calendar parsing rejects impossible/future dates and exact birthday arithmetic enforces age 13 |
| AUD-062 | High in production misconfiguration | Missing Stripe immediately grants repeatable free credits; production does not fail readiness or return unavailable. | Fixed locally; independently reviewed PASS; integrated/deployment gate pending |
| AUD-063 | Medium | Authenticated print upload trusted MIME and lacked magic-byte validation, route quota, and explicit rate limiting. | Fixed locally; GLB/glTF/OBJ/STL structures are content-validated under a 25 MB decoded limit, MIME mismatches fail, and both hourly and atomic daily user caps precede storage upload |

### AUD-064 through AUD-073 — Tooling, worker, asset, and evidence defects

The supporting-path audit completed its immutable-source review. The four
mutually exclusive manifests reconcile exactly as 209 client + 164 model/worker
+ 160 server-core + 401 supporting = 934 paths, with zero duplicate assignment.
The controller separately reviewed the one excluded example-environment file.
The following defects were confirmed:

| ID | Severity | Confirmed defect | Status |
|---|---|---|---|
| AUD-064 | High | `scripts/set-b2-cors.mjs` reads existing bucket CORS rules but replaces the full rule set with one download rule and has no revision guard, so a repair can silently destroy upload/origin policy. | Fixed locally; the named download rule is merged with all unrelated rules and `ifRevisionIs` rejects concurrent bucket changes |
| AUD-065 | Critical | `scripts/slant3d-setup.mjs` prints the newly created webhook secret verbatim, leaking it to terminal, CI, or agent logs. | Fixed locally; issued secrets are never interpolated into output and operators receive rotation guidance |
| AUD-066 | Critical | `scripts/p0-evidence-collect.sh` copies raw `.env` into a non-ignored docs path before redaction; interruption can leave deploy secrets on disk ready to be committed. | Fixed locally; raw environment copying removed and only explicit non-secret PETSIM guard keys may be exported |
| AUD-067 | High | The P0 evidence script writes `Result: PASS` without starting/calling the app and declares a missing operator runbook verified, so it fabricates release evidence. | Fixed locally; script requires a live origin/token and real runbook, performs a bounded HTTP check, and exits nonzero unless the disabled endpoint contract is observed |
| AUD-068 | High | Eight object GLBs are active in `public/objects/manifest.json` and the Three.js catalog but absent from the tree, producing deterministic 404s. This is a concrete subset of AUD-005. | Fixed locally; absent URLs and manifest entries were removed and the procedural owned fallbacks render without network 404s |
| AUD-069 | Medium | `scripts/animator-batch.mjs` exits zero for a non-dry-run manifest while dispatching no work. | Fixed locally; validation succeeds only with `--dry-run`, while execution without a dispatcher exits 2 |
| AUD-070 | Medium | `scripts/animator-doctor.mjs` masked failed worker probes with `|| true`, printing a green reachable/all-pass result for an unreachable worker. | Fixed locally; independently reviewed |
| AUD-071 | High | The stationery worker performs render/upload/register synchronously before returning its nominal 202 and has no `jobUuid` replay guard, so a retry can duplicate expensive output work. | Open behind `STATIONERY_V2_ENABLED=false`; the v2 production factory, worker, and routes are not constructed in this release. Legacy Pawprint fulfillment is a separate payment-bound path |
| AUD-072 | Medium | BIM baseline tests return success when both asserted documents are absent and retain an obsolete manual `260 tests passing` assertion. | Fixed locally; both required evidence documents now exist and absence fails; the numeric placeholder was replaced with executable script-contract assertions |
| AUD-073 | Low | `render.yaml` and README point to seven absent deployment/architecture documents instead of tracked sources of truth. | Fixed locally; references now target tracked implementation paths, current audit/review documents, and the README deployment section |
| AUD-074 | Critical when copied into an environment file | `.env.example` defines `JWT_SECRET` twice; the first value is a known testing secret. `dotenv` preserves the first duplicate by default, so copying the example can leave production sessions signed with a public key. | Fixed locally; the public testing value was removed and a source regression requires one placeholder only |
| AUD-075 | High | Tripo success/error logging includes the provider's expiring signed GLB URL or serialized output payload, leaking downloadable private model URLs into runtime logs. | Fixed locally; independent review confirmed redaction |
| AUD-076 | High | Tripo `banned`, `expired`, and `unknown` terminal states are treated as still running, while task-not-found polling errors are retried until a generic timeout instead of surfacing the actual terminal condition. | Fixed locally including bounded safe start throttling; corrected re-review PASS |

### AUD-077 through AUD-079 — Advertised offer and outcome mismatches

The FurryFriend editorial requirement triggered a product-claim trace back to
the already-reviewed home-scroller, Pawprints, and animation paths. That trace
confirmed three additional release-blocking trust defects:

| ID | Severity | Confirmed defect | Status |
|---|---|---|---|
| AUD-077 | High | The home card advertises a recipient “45% off their 3D model” offer and a sender credit, but Send a Pawprint only emails an already-created image and normal creation price; no prepaid purchase, gift entitlement, discount, or reward is implemented. | Fixed locally by removing the discount/reward/licensing claims; the card now describes only the implemented photo-plus-words design, download, and email behavior |
| AUD-078 | High | The “limited” pre-1900 collection advertises collectible models and hard-coded merch prices, but renders only role glyphs and routes every item to generic Pawprints; no collection-specific assets, offers, availability, or destinations back the claim. | Fixed locally as a truthful owned four-portrait preview with no price, SKU, scarcity, or purchase claim; live product offer remains unclaimed |
| AUD-079 | High | The one-photo animation card guarantees a hyper-real video with specific ear, head, and fur motion, but those characteristics are not acceptance-gated and the Animation Studio/provider path is not yet live-verified in this release. | Copy constrained locally to a preview/Create handoff; real live provider/storage proof remains required before enabling Animator |

### AUD-080 through AUD-083 — Animation audio and catalog integrity defects

The requested historical-character video collection exposed three additional
release blockers in the existing Animator implementation. These are not visual
polish issues: they affect server security, playback correctness, and whether a
listed scene can be rendered at all.

| ID | Severity | Confirmed defect | Status |
|---|---|---|---|
| AUD-080 | Critical | `server/animator/audioMux.ts` passes caller-derived video, audio, and output paths through one interpolated shell command using `child_process.exec`; quotes, substitutions, or shell metacharacters can escape the intended FFmpeg arguments. It also lacks owned-path validation, source/count/volume bounds, timeout/abort handling, and output audio-stream verification. | Fixed locally with argument-vector execution, owned-path/media bounds, timeout, and ffprobe output verification; independent security review and live storage/provider proof pending |
| AUD-081 | High | `SoundSystem.tsx` hard-codes weather audio files that are absent from the shipped tree, starts playback immediately without an explicit ready/unlocked state, and does not retain/stop/disconnect one-shot cue audio when the cue changes or the component unmounts. Scene changes can therefore produce 404s, stale overlapping cues, and misleading sound state. | Fixed locally for the four signature stories with hash-manifested owned audio, explicit unlock/mute/readiness, and lifecycle cleanup; additional weather audio remains disabled |
| AUD-082 | High | The 108-script catalog is generated by multiplying 12 stories by camera/mood variants, while its tests only count IDs, timing, and event types. Neither the schema nor tests resolve clip, environment, or sound references against the shipped asset manifests, so a script can pass CI while every named action or cue is unavailable in production. | Fixed locally with a versioned V2 capability schema and full collection/clip/environment/sound referential validation |
| AUD-083 | High | Animator voiceover jobs are polled by two incompatible paths. The request poller treats an Animator job as a normal creation video and can call `setCreationVideoUrl` with its intentionally null `creation_id`; the background poller alone performs the mux, but it neither mirrors/persists a result URL nor returns that output to the client. A race can fail, refund, or mark the job done without a downloadable voiced video. | Fixed locally with observational HTTP polling, one leased background finalizer, owner-scoped verified result metadata, durable mirror-before-done, and exact-once refund; staging proof pending |

### AUD-084 through AUD-085 — Independent model-durability review deltas

The first Task 6C implementation passed 74 focused tests, real MySQL,
TypeScript, and the full repository suite, but the independent review rejected
it after direct race/state probes exposed two additional failures:

| ID | Severity | Confirmed defect | Status |
|---|---|---|---|
| AUD-084 | High | Public billing hydration treats any historical refund on a job as current. After attempt 1 is refunded and attempt 2 is charged, attempt 2 can report `billingDisposition: refunded`; the old refund can also hide attempt 2's pending refund. | Fixed locally; corrected re-review PASS |
| AUD-085 | High | Recovery only selects non-null expired leases and omits `validating`, while workers unconditionally release their lease. Unleased `processing`/`downloading` jobs and any crash during validation can remain charged but permanently invisible to recovery. | Fixed locally; corrected re-review PASS |

### AUD-086 — PBR accessory truth and provider boundary

| ID | Severity | Confirmed defect | Status |
|---|---|---|---|
| AUD-086 | Medium | The wardrobe uses procedural geometry and flat scalar materials, so adding a remote “PBR” label or passing rigged Animator pets through a retexture model would overstate quality and could damage animation data. | Optional fal.ai PATINA authoring boundary implemented locally for the closed accessory catalog with validated, hash-manifested local maps and truthful fallbacks. No maps generated because `FAL_KEY` is not configured; rigged-avatar retexture is prohibited pending preservation evidence. |

## Verification ledger

| Gate | Current result | Evidence |
|---|---|---|
| Latest integrated full Node suite | **PASS** | 1,387 total; 1,384 passed; 3 intentional skips; 0 failed under Node 24.18.0 |
| TypeScript | **PASS** | `npm run lint` under Node 24.18.0 |
| Production build | **PASS** | Vite, 2.1 MB server bundle, and 79-file release manifest completed under Node 24.18.0 |
| Python/IFC/worker suites | **PASS** | IFC worker 6/6 under Python 3.11 with pinned `ifcopenshell==0.8.5`; contracts 40/40 and security 8/8 |
| Security/dependency scan | **PASS for source tree** | npm audit 0 vulnerabilities; redacted source secret scan found no embedded credential after manual review of ten heuristic alerts; committed archive will be scanned separately |
| Live exact commit | Pending after fixes | `/version` |
| Live readiness | Pending after fixes | `/readyz` |
| Real model workflow | **NOT YET RUN** | Must complete reference generation, model build, persistence, and Fur Bin verification |
| Post-run production logs | Pending | Hostinger runtime logs after the real workflow |

## Final disposition

Not yet available. This audit remains open until the 934-path coverage reconciliation, confirmed fixes, integrated test/build gates, exact deployment, real model outcome, and live production sweep are complete.
