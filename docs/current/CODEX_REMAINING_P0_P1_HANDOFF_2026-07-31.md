# Copy/paste prompt — finish remaining P0 work after accepted P1

You are the lead production engineer in
`/Users/robert/Desktop/claude7126/PawsMemories`.

Continue from branch `codex/pawsome3d-production-hardening`. P1 was reviewed and
accepted locally in commit `4b1c783` under Node `v24.18.0`; do not reimplement it.
Preserve all existing work and the separate `furryfriend/` site. Make narrow,
evidence-backed repairs without changing pricing, production caps, or customer
entitlements. Do not print or request secrets.

## Evidence already accepted

- Typecheck and production build passed.
- Focused recovery/rig/Animator suite: 37 passed, 0 failed, 0 skipped.
- Full suite: 1,399 tests; 1,396 passed, 0 failed, 3 expected skips.
- Contracts: 40 passed. Security: 8 passed.
- Real MySQL proved exclusive recovery leases, exactly-once refunds tied to the
  immutable debit, no refund after a concurrent stage transition, durable-handle
  polling without a provider create call, and redacted evidence persistence.
- Customers remain gated from Animator; Admin can exercise the local release
  candidate. This is not live production proof.

## Finish P0

1. Replace private signed-B2 preview consumption with an authenticated,
   same-origin GLB streaming boundary. Enforce ownership/operator authorization,
   exact asset version and SHA-256, `GET`, `HEAD`, one byte range, bounded size,
   correct `model/gltf-binary`/length/range headers, and no private object URL or
   credential leakage.
2. In `PetModelViewer`, remove the zero-height override, guarantee a non-zero
   desktop/mobile wrapper, and add explicit loading, loaded, and error states.
3. Fetch protected GLBs with the authenticated client, create and revoke a local
   Blob URL, and verify response version/hash headers before rendering.
4. Keep operator release disabled until the exact current version emits a
   successful viewer load. Submit and server-verify version ID plus artifact
   SHA-256. Stale or mismatched approval must fail closed.
5. Atomically and idempotently register the exact released asset/version/hash in
   the owner's Fur Bin. Concurrent retries must produce one card, and a fresh
   query must resolve the same version and hash.
6. Add authorization, range, UI layout/load/error, stale-approval, exact-hash,
   real-MySQL concurrency, fresh Fur Bin, and printing-regression tests.
7. Re-run the proportional Node 24 gates: affected tests, typecheck, full suite,
   contracts, security, production build, and exact clean archive smoke. Record
   all normal skips honestly; do not weaken a real failure.
8. Update
   `docs/current/NEXT_RECOMMENDED_FIXES_AFTER_LIVE_SWEEP_2026-07-31.md` with a
   PASS/FAIL/BLOCKED matrix separating CODE, LOCAL, ARCHIVE, DEPLOYED, LIVE, and
   END-TO-END. Commit P0 separately. Do not deploy unless explicitly instructed.

## Remaining live acceptance

After a separately authorized deployment, verify the exact deployed SHA,
`/healthz`, `/readyz`, `/version`, runtime logs, customer and operator rendering
of the exact private GLB, load-gated release, one-card Fur Bin registration after
a fresh session, and a real downloadable exact-version asset. Never infer these
from a local test, build, ZIP, commit, push, or cached homepage.
