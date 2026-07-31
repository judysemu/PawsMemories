# Full Codebase Audit and Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review every tracked file in the PawsMemories repository, reproduce and repair every actionable defect found, verify the integrated product locally and live, and publish one Markdown report containing review coverage, bugs, evidence, and applied fixes.

**Architecture:** Treat `git ls-files` at the starting commit as the authoritative review manifest. Partition text source into non-overlapping product domains for independent read-only review, classify binary/generated assets separately, then reproduce each candidate finding before changing code. Every behavior fix follows red-green TDD, is integrated on `main`, passes the strongest available local gates, and is verified against the deployed Hostinger build when it affects production.

**Tech Stack:** TypeScript, React, Express, Node.js 24.18, MySQL, Node test runner, Vite, Python/Blender worker code, Hostinger Web Apps, Chrome-based production testing.

## Global Constraints

- Preserve the user's existing untracked `docs/current/PRODUCTION_DEPLOYMENT_REVIEW_2026-07-31.md` unless this audit deliberately updates it.
- Use the current `main` checkout and record the exact starting and ending SHAs.
- Review all 934 tracked paths from the starting manifest; text/code/config is read line by line, while binary/generated artifacts are inventoried and validated by type, size, references, and repository policy.
- Never print or copy secret values from `.env`, Hostinger, browser storage, runtime headers, or logs.
- Use Node `24.18.0`; the repository engine is `>=24.15 <25`.
- Do not convert a real payment, Printful order, Slant3D order, message, email, or shipment into a test without explicit authorization.
- Do not weaken cost, authentication, tenant, storage, or provider safety controls merely to make tests pass.
- For each confirmed bug: record symptom, root cause, severity, affected file/lines, failing test or reproduction, applied fix, and verification evidence.

---

### Task 1: Freeze the authoritative review manifest

**Files:**
- Create: `docs/current/FULL_CODEBASE_AUDIT_2026-07-31.md`
- Read: every path returned by `git ls-files`

**Interfaces:**
- Consumes: starting Git `HEAD`, tracked-file list, current worktree status
- Produces: immutable starting SHA, file/line counts, domain partitions, excluded binary/generated classification

- [ ] **Step 1: Capture repository identity and dirty state**

Run `git rev-parse --show-toplevel`, `git rev-parse HEAD`, `git status --short --branch`, and `git ls-files`.

- [ ] **Step 2: Classify every tracked path**

Group paths into server/database, client/UI, model/worker/agent, tests/tooling/config, documentation/assets, and binary/generated artifacts. Ensure each tracked path belongs to exactly one group.

- [ ] **Step 3: Record coverage rules in the audit report**

Write the starting SHA, 934-file baseline, total line count, group counts, and binary/generated validation method before recording findings.

### Task 2: Review server, API, database, security, and fulfillment code

**Files:**
- Read: `server.ts`, `db.ts`, `server/**`, `migrations/**`, `scripts/**`
- Test: matching `tests/**/*.test.mjs` and contract tests

**Interfaces:**
- Consumes: Task 1 server/database file partition
- Produces: line-specific findings for request validation, authorization, quotas, idempotency, transactions, migrations, storage, provider boundaries, and error handling

- [ ] **Step 1: Read every assigned source file line by line**

Trace each public route through authentication, validation, database/provider side effects, response mapping, and cleanup.

- [ ] **Step 2: Run focused static and behavioral probes**

Use repository tests plus read-only production/database queries where required to distinguish real defects from stale code or expected guards.

- [ ] **Step 3: Return only evidence-backed candidate findings**

Each finding must name a concrete failure mode and exact file/line evidence; do not report style preferences as bugs.

### Task 3: Review client, UX, routing, accessibility, and billing presentation

**Files:**
- Read: `src/**`, `index.html`, `public/*.webmanifest`, public text/SEO files
- Test: client, shell, pricing, accessibility, and route contract tests

**Interfaces:**
- Consumes: Task 1 client file partition
- Produces: line-specific findings for navigation, stale state, loading/error handling, accessibility, credit/payment copy, route behavior, and production rendering

- [ ] **Step 1: Read every assigned client file line by line**

Trace the principal Create, Pawprints, Fur Bin, Print Shop, Profile, auth, and checkout flows through their API calls and state transitions.

- [ ] **Step 2: Compare UI contracts with server behavior**

Confirm displayed prices, caps, retry/error copy, admin behavior, and fulfillment availability agree with authoritative backend rules.

- [ ] **Step 3: Exercise representative live routes after deployment**

Use the authenticated production UI for one real model workflow and non-mutating checks for payment/fulfillment surfaces.

### Task 4: Review model pipelines, Blender worker, agent code, and auxiliary services

**Files:**
- Read: `agent/**`, `blender-worker/**`, `x-dm-service/**`, `server/model-builds/**`, `server/reference-sessions/**`, `server/rig-pipeline/**`, `server/spatial-generator/**`
- Test: corresponding Node/Python/worker suites and contracts

**Interfaces:**
- Consumes: Task 1 model/worker partition
- Produces: line-specific findings for durable job state, retries, quota accounting, provider cost guards, worker authentication, model artifacts, and failure recovery

- [ ] **Step 1: Read every assigned source and test file line by line**

Trace source image/text through reference generation, approval, 3D build, validation, persistence, and optional rigging.

- [ ] **Step 2: Reproduce the recurring reference-limit defect**

Compare production rolling-attempt counts, effective caps, terminal states, and retry semantics. Identify why normal production usage stays blocked.

- [ ] **Step 3: Validate worker and recovery boundaries**

Confirm timed-out, failed, cancelled, and replayed jobs cannot remain active, double-charge, or bypass idempotency.

### Task 5: Review tests, configuration, CI, documentation, and repository hygiene

**Files:**
- Read: `tests/**`, `.github/**`, root configuration, package manifests/locks, `.env.example`, `docs/**`, tracked assets and fixtures

**Interfaces:**
- Consumes: Task 1 test/tooling/docs/assets partitions
- Produces: stale-test findings, missing coverage, unsafe defaults, dependency/build issues, documentation drift, and asset/reference integrity results

- [ ] **Step 1: Read all test and configuration files line by line**

Confirm tests assert current behavior, CI uses the supported Node version, scripts preserve secrets, and environment documentation matches runtime consumption.

- [ ] **Step 2: Validate generated and binary artifacts**

Check file signatures, sizes, duplicate hashes, references, and whether large/generated files are intentionally tracked.

- [ ] **Step 3: Run repository-wide static checks**

Run secret scanning, dependency/config validation, TypeScript checks, production build, and the full Node/Python test suites supported by the checkout.

### Task 6: Reproduce and repair confirmed bugs using TDD

**Files:**
- Modify: only files implicated by confirmed findings
- Test: nearest focused test file for each behavior

**Interfaces:**
- Consumes: confirmed findings from Tasks 2–5
- Produces: minimal tested fixes and an evidence row for every resolved or intentionally deferred defect

- [ ] **Step 1: Write one failing regression test per behavior**

Name the production mutation the test catches; assert a user-visible result or durable state, not source text or mock existence.

- [ ] **Step 2: Run each focused test and capture the expected RED result**

The test must fail because the defect still exists, not because of test syntax or missing setup.

- [ ] **Step 3: Implement the smallest root-cause fix**

Preserve authentication, cost controls, idempotency, and unrelated user work.

- [ ] **Step 4: Run focused GREEN checks and the affected subsystem suite**

Fix the implementation rather than weakening assertions when a valid regression remains red.

- [ ] **Step 5: Record the fix in the audit report**

Include affected lines, test names, before/after behavior, and any remaining operational prerequisite.

### Task 7: Integrate, deploy, and perform the actual live sweep

**Files:**
- Modify: `docs/current/FULL_CODEBASE_AUDIT_2026-07-31.md`
- Build: deployment archive from committed `HEAD`

**Interfaces:**
- Consumes: all reviewed and fixed domains
- Produces: pushed commit, verified Hostinger deployment, live model artifact, live route/log evidence, and final audit status

- [ ] **Step 1: Run integrated verification under Node 24.18**

Run focused tests, full test suite, TypeScript check, production build, archive verifier, and relevant Python/worker tests. Report every nonzero result.

- [ ] **Step 2: Commit and push the exact reviewed state**

Confirm local `HEAD`, `origin/main`, archive manifest, and checksum all match.

- [ ] **Step 3: Deploy the archive through Hostinger**

Wait for the deployment to finish, then verify `/version`, `/readyz`, runtime startup, database readiness, and fresh logs.

- [ ] **Step 4: Complete a real authenticated model run**

Start a new reference session, wait for the five views, approve the result, run the 3D build, verify the final GLB/model record, verify the correct PupCoin ledger behavior, and confirm the output appears in Fur Bin. A 429 or partially created session is a failed test, not a model run.

- [ ] **Step 5: Sweep production surfaces**

Verify public/SEO/PWA routes, auth boundaries, Create, Pawprints, Fur Bin, Print Shop, Profile, fulfillment readiness, object storage, security headers, browser console, failed network requests, and post-test Hostinger logs.

- [ ] **Step 6: Finalize the audit report**

For every finding, mark `FIXED`, `NOT REPRODUCED`, `DEFERRED` with a concrete blocker, or `ACCEPTED RISK`; include exact verification evidence and no unqualified completion claims.

### Task 8: Completion audit

**Files:**
- Read: the final tracked-file manifest, all diffs, test/build output, live production evidence, and `docs/current/FULL_CODEBASE_AUDIT_2026-07-31.md`

**Interfaces:**
- Consumes: Tasks 1–7
- Produces: requirement-by-requirement proof that the full repository review and repair objective is complete

- [ ] **Step 1: Reconcile coverage against all 934 starting paths**

No tracked text path may be unassigned or unreviewed; every binary/generated path must have an explicit validation result.

- [ ] **Step 2: Reconcile findings against fixes and verification**

Every reported bug must have current evidence and a final disposition; every applied fix must have red-green coverage and integrated verification.

- [ ] **Step 3: Re-run final proof commands**

Use fresh output for Git SHA alignment, tests, typecheck, build, live `/version`, live `/readyz`, completed model persistence, and clean post-run logs.

- [ ] **Step 4: Mark the persistent goal complete only if every requirement is proven**

If any tracked path, confirmed bug, required test, deployment boundary, or real model outcome lacks evidence, continue the goal rather than narrowing the definition of completion.
