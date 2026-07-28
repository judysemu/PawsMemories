# Gated Model Generator — Build Plan

Status: approved implementation sequence
Date: 2026-07-28

## Constraints

- Build the real customer generator; do not revive obsolete planning documents.
- No placeholders, simulated production successes, or smoke-test-only acceptance.
- Preserve authentication, private storage, canonical assets, and signed delivery.
- Keep organic pet/humanoid reconstruction on Tripo.
- Do not expose facial rigging until measured success is at least 75%.
- Run the entire repository test suite and full Node 24 production build at the
  end.

## Phase 0 — Documentation and cleanup

1. Record current Git baseline and recent implementation findings.
2. Create the authoritative review, architecture snapshot, and this build plan.
3. Create an exact deletion manifest for obsolete tracked documentation/reference
   material older than 2026-07-25.
4. Remove only the listed obsolete documents. Do not delete source, migrations,
   test fixtures, dependencies, worktrees, requirements files, skills, legal
   artifacts, or user media.

Exit: the repository has one current model-generator contract and no competing old
planning material in the removal set.

## Phase 1 — Contracts and pricing

1. Add bounded types for:
   - mesh profile: `hd | smart_mesh`;
   - subject profile: `pet | humanoid`;
   - texture selection and quality;
   - bounded style direction;
   - stage kind and stage state;
   - hash-bound approval payload.
2. Add server-authoritative stage prices:
   - base 45 PupCoins;
   - texture 8 PupCoins;
   - rig 35 PupCoins.
3. Remove facial add-on from the product quote and expose an unavailable capability
   record with the 0.75 release threshold.
4. Add validators for every request and reject unknown or unsupported options.

Tests:

- price composition;
- facial request rejected without charge/provider call;
- malformed profile/style/approval rejected.

## Phase 2 — Durable schema

1. Add migration 39:
   - new order configuration/current-stage/final-customer-version columns;
   - `pet_glb_stage_attempts`;
   - unique idempotency and stage-attempt constraints;
   - stage lookup indexes.
2. Extend `provider_generation_jobs` with stage kind and source local-job fields if
   needed.
3. Implement repository methods with row locks:
   - create configured uncharged order;
   - attach and hash references;
   - charge-and-queue a stage exactly once;
   - attach provider job;
   - persist artifact/report metadata;
   - approve/reject exact current attempt;
   - select the exact final customer-approved version.
4. Write wallet ledger rows in the same transaction as each charge/refund.

Tests:

- migration idempotency;
- duplicate approval/charge;
- concurrent same-key and different-key requests;
- insufficient balance;
- rollback and one-time refund.

## Phase 3 — Staged Tripo provider

1. Base operation:
   - upload canonical multiview inputs;
   - request `texture=false`, `pbr=false`;
   - apply HD or SmartMesh model version/face budget;
   - persist local job and provider task handle.
2. Texture operation:
   - consume the approved base provider task;
   - call `texture_model`;
   - include bounded style prompt and selected quality;
   - persist a new local job.
3. Rig readiness:
   - call `animate_prerigcheck`;
   - persist `riggable` and returned rig type;
   - block an incompatible selection before charging.
4. Rig:
   - call `animate_rig`;
   - use `v2.5-20260210`;
   - send `spec=tripo`;
   - send `rig_type=quadruped` or `biped`.
5. Remove automatic idle/walk chaining from this sale product. Animation is not
   part of the requested rig add-on.
6. Keep task handles/URLs internal and download through the hardened allowlist.

Tests:

- exact provider bodies for both mesh profiles and subject profiles;
- texture prompt goes only to texture;
- deprecated rig version absent;
- zero out-of-order provider calls;
- provider polling uses persisted handles.

## Phase 4 — Stage-specific canonical artifacts and validation

1. Add validation modes: base, texture, rig.
2. Parse and report actual triangle count for both profiles.
3. Enforce SmartMesh maximum 10,000 measured triangles.
4. Validate texture material/image evidence without requiring a skeleton.
5. Validate rig skin/joints/weights without requiring animation clips.
6. Persist every completed stage immediately to private storage and immutable
   `asset_versions`.
7. Save the validation report and its SHA-256 with the stage attempt.
8. Add owner-scoped signed stage preview.

Tests:

- valid blank base passes;
- textured but unrigged candidate passes texture;
- unrigged candidate cannot pass rig;
- over-budget SmartMesh blocks approval;
- wrong/stale hash or version blocks approval;
- cross-owner preview blocked.

## Phase 5 — Service and routes

1. Replace the automatic `/generate` behavior with explicit reference submission
   and gate actions.
2. Implement:
   - reference save/approve;
   - stage poll;
   - candidate preview;
   - stage approve/reject;
   - final operator queue/approval;
   - final signed download.
3. Keep legacy route errors explicit; do not silently auto-advance old orders.
4. Return a single order/stage view model so the browser renders server truth.
5. Make retries attempt-numbered and bounded.

Tests:

- complete state machine;
- no skipped gate;
- idempotent polling and approvals;
- final delivery is the exact final customer/operator-approved version.

## Phase 6 — Customer studio

1. Remove the fake auto/step toggle.
2. Add setup controls:
   - HD or SmartMesh;
   - Pet/animal or Humanoid character;
   - texture on/off and quality;
   - rig on/off;
   - style preset and optional bounded direction.
3. Do not render a facial checkbox.
4. Add reference cards with visible image previews and an exact “Approve
   references” action.
5. Add one gate panel at a time:
   - base candidate with measured triangles and price already charged;
   - texture candidate with style/quality;
   - rig candidate with measured skeleton/weight evidence.
6. Load the signed intermediate GLB into `PetModelViewer`.
7. Offer Approve and Request remake/correction. Disable approval when server
   validation blocks it.
8. Show a transparent price breakdown before order creation and before each add-on
   charge.
9. Keep customer language “PupCoins.”
10. Add a role-gated operator release panel that previews and approves only the
    exact final customer-approved version. Regular customers must not see it.

UI tests:

- controls map to request contract;
- no auto-advance copy;
- no facial purchase;
- SmartMesh budget visible;
- current gate cannot display a later-stage action.

## Phase 7 — Operator and delivery integrity

1. Operator approval reads only the final customer-approved version.
2. Bind approval to attempt UUID/version/hash/report hash.
3. Ensure delivery points to canonical private storage.
4. Ensure owner can re-request a signed URL without creating a second order or
   provider task.
5. Record product/profile/style/stage lineage in asset metadata.

Tests:

- arbitrary version injection rejected;
- duplicate operator event harmless;
- delivered hash equals approved stage hash;
- non-owner cannot download.

## Phase 8 — Full verification

Run only after implementation:

1. `npm run lint`
2. `npm run test`
3. `npm run test:contracts`
4. `npm run test:security`
5. `npm run test:ar`
6. `npm run test:ifc`
7. `npm run build`

This is a full automated verification, not a smoke test. No live purchase or
provider charge is required to make tests green; provider contract tests use
injected deterministic fakes while production code remains real.

Record exact totals, failures, Node/npm versions, and build artifact checksums in a
new verification record. Do not claim production success from local tests alone.
