# Gap Register — G2

**Date:** 2026-07-27 · **Status:** G2 gate PASSED (8/8 gate tests, tsc clean, isolation 11/11 intact)

## Verified this phase

| Check | Result |
|---|---|
| `npx tsx --test tests/g2_provider_interface.test.mjs` | **8/8 pass** |
| `npx tsc --noEmit` | **exit 0, zero errors repo-wide** |
| `npx tsx --test tests/spatial_tripo_isolation.test.mjs` | **11/11 pass, untouched** |

Raw captures: `docs/audits/evidence/g2-gate-test.txt`, `docs/audits/evidence/g2-typecheck-and-isolation.txt`.

The boundary is proven, not asserted: test 6 walks the returned object graph recursively and fails on any key matching `/url/i` or any `https?://` string value, at any depth, for **both** the stub and the real adapter wrapping a fake whose `poll()` deliberately returns `https://api.tripo3d.ai/fake/output.glb`. The URL is consumed inside `fetchArtifacts` (`fake.calls.download > 0`) and never surfaces.

## Open items

| # | Item | Status | Owner phase |
|---|---|---|---|
| 1 | `ProviderJobStore` has only `InMemoryJobStore` — job state dies on restart, no multi-instance support | **G3 ENTRY GATE**; interface seam exists so the adapter needs no change | G3 |
| 2 | Inbound Stripe replay defence unproven under concurrency — `stripeAdapter` idempotency protects outbound calls, not inbound event replay | OPEN, needs live-DB test + `stripe_event_ledger` | G3 |
| 3 | Appendix A accumulator review (`adjustmentAccumulator` vs `cumulativeIndex`) | **still owed** — inferred twice, never read from source (`gent-scoring.ts`, 691 lines, in-repo) | G3 |
| 4 | `salti_margin` column type | **RESOLVED** → `DECIMAL(6,3) NULL` (signed, numerically compared; `VARCHAR(20)` rejected) | — |
| 5 | Operator role vs. existing `is_admin` bypass in `reviewJob` (`service.ts:872–875`) | **G6 blocker** — admin bypass already exists and must not accidentally satisfy mandatory operator approval | G6 |
| 6 | `three_quarter` view collected but dropped by the Tripo adapter | Path 1 limitation, recorded in `types.ts` and metadata (`threeQuarterViewConsumed: false`); disclose in UI | G4 / G12 |
| 7 | G0.5 "Adapt" test rows matched by filename only, never by reading test bodies | confirm before planning against them | G3+ |
| 8 | Schema version differs by branch (35 on `c03d963`, 36 on `phase/bo-4-spatial-generator`) | verify before writing migration 37 | G3 |
| 9 | `npm test` full-suite baseline not re-captured this phase | pre-existing failures are environment gaps per `BO_4_THERMAL_CASCADE.md` §15; unrelated to G2 | G8 |

## Scope explicitly excluded

`computeAdvisoryLikeness` appeared in a prior G2 attempt's test. Likeness is not in G2's scope, and not in G5's validator list either. Not carried forward.
