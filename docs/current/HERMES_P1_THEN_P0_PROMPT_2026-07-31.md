# Hermes execution brief: finish P1, then P0

> Historical execution brief. Hermes stopped after the initial P1 implementation;
> Codex subsequently reviewed and locally accepted P1 in commit `4b1c783`. Use
> `CODEX_REMAINING_P0_P1_HANDOFF_2026-07-31.md` for the current remaining work.

You are Hermes running GPT-5.6 Luna Pro in the PawsMemories repository at `/Users/robert/Desktop/claude7126/PawsMemories`.

Your job is to implement and verify every P1 item first, commit that phase, then implement and verify every P0 item and commit that phase. This phase order is binding even though P0 is the more urgent severity label. Do not begin P0 implementation until the P1 gate below is green and committed. Continue autonomously through both phases; stop only for a genuine permission, secret, or external-service blocker that cannot be resolved from the repository.

## Ground truth and constraints

- Read the complete repository instructions (`AGENTS.md` and any applicable nested files) before editing.
- Read `docs/current/NEXT_RECOMMENDED_FIXES_AFTER_LIVE_SWEEP_2026-07-31.md` completely. It is the acceptance source for this job.
- Confirm the branch, `HEAD`, remotes, and worktree before editing. Expected starting branch is `codex/pawsome3d-production-hardening`; expected `HEAD` is `304807d`; the branch is one commit ahead of origin. Preserve all existing work, including this prompt file.
- The last production code build verified by the sweep was `2d15391b982f8d070511e420f1f92c63fc90bd04`. Do not confuse local code, a commit, a push, a deployment, liveness, readiness, or an end-to-end customer flow.
- Make narrow repairs in the existing architecture. Do not redesign the product, rewrite working flows, change pricing/credits, or weaken auth, tenant isolation, idempotency, validation, audit, or safety limits.
- Never print, copy, rotate, or commit secrets. Do not modify Hostinger or other production settings from this terminal task.
- Use Node 24.18.x (the project requires Node `>=24.15 <25`) and the repository package manager/lockfile. Never run `npm audit fix --force`.
- Do not spend time on a broad generic scan. Run the focused security, dependency, archive, and regression checks required to prove these changes.
- Never discard user changes, reset, force-push, amend an existing commit, or use destructive Git commands.
- Do not push or deploy. The requested terminal boundary is two verified local commits and an evidence-backed report update.
- Do not claim a browser, provider-credit, or production test was run unless you actually ran it and captured evidence. Paid-provider tests must use an existing explicitly authorized live-test harness and a bounded spend; otherwise use deterministic fakes and state the remaining live-deployment gate honestly.

## Phase 1: complete P1 first

Work in this order so the highest-integrity failure mode is repaired first.

### P1.1 Stale Pet GLB recovery and exactly-once refund

Inspect the existing Pet GLB generation state machine, repositories, migrations, provider task handles, credit ledger/refund path, API routes, admin/operator surfaces, and tests before changing anything.

Implement a bounded lease/reconciliation mechanism for stale generation stages that:

- distinguishes legitimately running work from abandoned work using durable persisted timestamps/state;
- resumes or polls only when a durable provider handle proves that the original provider task exists;
- never resubmits an ambiguous provider-create operation and therefore cannot create duplicate provider jobs or charges;
- terminally fails unrecoverable work and returns credits exactly once, tied to the original debit/order/generation identity;
- is safe under concurrent workers, retries, restarts, and repeated reconciliation;
- records enough redacted evidence to explain the decision and refund correlation;
- exposes a safe admin/operator inspection action or view of recovery evidence, not a blind retry button;
- uses the next additive immutable migration if schema changes are required; never edit a migration that may already be deployed.

Add focused tests for fresh-vs-stale work, durable-handle resume, missing/ambiguous handle, concurrent reapers, repeated reconciliation, exactly-once refund, no duplicate provider submission, authorization, and redaction. Use the repository's real-MySQL test pattern where persistence/locking semantics matter.

### P1.2 Exact deployment-archive boot test

Add a repeatable CI/release test that builds or stages the exact production archive layout, extracts it into a clean temporary directory, installs/uses only what that archive is supposed to contain, starts it in a production-like environment with an isolated test database, and asserts:

- `/healthz`, `/readyz`, `/version`, `/`, and `/create` behave as expected;
- the reported version matches the artifact commit/build metadata;
- packaged Animator sound/runtime assets and other required runtime files are present and loadable;
- boot fails loudly when a required environment value or packaged runtime asset is absent;
- no source-only path, undeclared global package, developer checkout, or cached build output is needed.

Wire this into the appropriate CI/release workflow without exposing secrets or making tests nondeterministic.

### P1.3 Pin the model viewer dependency

Replace the runtime CDN/dynamic dependency path with a reviewed, lockfile-pinned model-viewer dependency compatible with the application's Three.js stack. Remove duplicate or conflicting Three.js/model-viewer loading, preserve custom-element registration, and ensure production has no network-time dependency on an unpinned CDN script. Add tests that fail if the viewer dependency disappears from the built artifact or duplicate loading returns.

This item does not authorize weakening the private-model boundary. The private delivery and viewer safety behavior belongs to P0 after the P1 commit.

### P1.4 Keep rig generation safely closed

Preserve `PETSIM_RIG_GLOBAL_DAILY_CAP=0`. Do not raise or bypass it. Make the disabled state explicit and testable in the relevant capability/config response and UI so customers are not charged for a path production intentionally disallows. Do not change production environment variables.

### P1.5 Finish the Animator release candidate

Audit the existing Animator implementation and packaged assets; extend what is already present rather than replacing it. Complete a release candidate that proves, with automated tests plus a local browser test where available:

- a permitted pet model loads with an explicit success/error state;
- rig/animation availability is detected and communicated accurately;
- scene/timeline playback works and stale output cannot be mistaken for the current job;
- the packaged sound library loads without external CDN dependence;
- export produces a downloadable, non-empty playable video with the selected audio present and duration aligned within a documented tolerance;
- cancellation, retry, failure, and insufficient-capability states are honest and recoverable;
- a deterministic mobile fallback exists for unsupported capture/export combinations;
- auth, ownership, credits, and rate limits remain intact.

Do not add fal.ai PBR generation in this phase. The production sweep explicitly gates that optional enhancement on reliable private-model review, which is a P0 item. Keep the public Under Construction gate in place unless every release criterion is genuinely green; if it remains gated, document the exact remaining live-deployment proof instead of pretending it shipped.

### P1 gate and commit

Before committing P1:

1. Run all focused tests added or affected by P1.
2. Run the repository's full test, typecheck, production build, contract, migration, archive, and relevant security/dependency checks using Node 24.18.x.
3. Execute the extracted-archive production-like boot smoke and record the command and results.
4. Review the diff for secrets, accidental generated artifacts, unrelated rewrites, migration mistakes, and dependency drift.
5. Update `docs/current/NEXT_RECOMMENDED_FIXES_AFTER_LIVE_SWEEP_2026-07-31.md` with dated PASS/FAIL/BLOCKED evidence for each P1 item. Do not mark live production PASS from local evidence.

If and only if the gate is green, commit P1 with a clear message such as `fix: complete P1 production hardening`. Include this execution brief in that commit. Record the exact commit SHA, test counts, archive checksum/size if generated, and any external-only deployment proof still outstanding. Then begin P0.

## Phase 2: complete P0 after the P1 commit

### P0.1 Repair private GLB delivery and review

Fix the blank customer/operator private-model preview at the delivery boundary. Prefer a same-origin authenticated streaming endpoint unless the existing architecture proves a safer equivalent. It must:

- authorize the current user/operator and verify resource ownership/role before returning any bytes;
- bind the request to the intended pet, generation, version, and stored SHA-256 rather than accept an arbitrary URL/key;
- support the `GET`, `HEAD`, and byte `Range` behavior required by `<model-viewer>`;
- return correct `model/gltf-binary`, content length/range, bounded cache headers, and useful non-secret errors;
- avoid leaking durable private B2 URLs, credentials, or unrestricted signed links;
- preserve auditability and fail closed on metadata/hash/version mismatch.

Add an integration test using a real protected HTTP fixture that exercises the same headers, range behavior, authorization, and model-viewer fetch sequence. Deterministic storage fakes are acceptable locally only if the remaining real-B2 CORS/deployment check is explicitly left BLOCKED rather than reported as PASS.

### P0.2 Make viewer state and dimensions release-safe

Fix the operator viewer's zero-height layout using an explicit nonzero wrapper and remove the `height:100%` override that defeats the intended sizing. Add explicit loading, loaded, and error states. Both customer and operator surfaces must show a useful error instead of a blank frame.

The operator release/approval control must remain disabled until the exact target asset fires a successful viewer load event and its version/hash matches the pending review record. A stale earlier model, metadata-only success, or preview error must never enable release. Add desktop and mobile tests asserting nonzero dimensions plus load/error and stale-version behavior.

### P0.3 Make operator release and Fur Bin registration atomic and idempotent

On exact operator approval, atomically and idempotently register or update the released Pet GLB in the owner's Fur Bin using the approved version and SHA-256. Repeated approval/retry must not create duplicates. A failed registration must not falsely report release success; use the existing transaction/outbox pattern if external work prevents a single database transaction.

Test authorization, concurrency, retry, rollback/outbox recovery as applicable, exact version/hash binding, no duplicates, a fresh-session Fur Bin reload, and exact released-asset open/download behavior. Preserve Printful/Slant behavior and add a regression check that the release changes do not touch or reinterpret unrelated `PETSIM_*` caps as printing limits.

### P0 gate and commit

Before committing P0:

1. Run all focused P0 tests, including protected range delivery, viewer load/error/dimensions, exact version/hash approval, concurrency/idempotency, fresh Fur Bin reload, and print-path regression tests.
2. Re-run the complete Node 24.18.x verification set used for P1, including the exact extracted-archive boot smoke.
3. Review the complete two-phase diff for secrets, unrelated changes, authorization regressions, private asset exposure, credit/refund duplication, and migration safety.
4. Update the production-sweep Markdown with separate CODE, LOCAL, ARCHIVE, DEPLOYED, LIVE, and END-TO-END statuses. Only mark levels actually proven.

If and only if the gate is green, commit P0 separately with a clear message such as `fix: complete P0 private model release`. Do not squash or amend the P1 commit.

## Required final response

When both phases are complete, report:

- P1: PASS/FAIL/BLOCKED per sub-item with concise evidence;
- P0: PASS/FAIL/BLOCKED per sub-item with concise evidence;
- both exact commit SHAs and a concise file/migration summary;
- exact verification commands, test counts, build/archive boot result, archive checksum/size if applicable;
- whether the tree is clean and how far the branch is ahead of origin;
- every remaining deployment, Hostinger/B2, paid-provider, browser, or live-production proof that was not actually performed.

Do not push, deploy, or declare the production site fixed from local results. Stop after the two verified local commits and the report update.
