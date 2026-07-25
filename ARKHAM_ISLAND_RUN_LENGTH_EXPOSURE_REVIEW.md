# Arkham Island Temperature Cascade Review and Run-Length Exposure Architecture

**Review date:** 2026-07-24  
**Repository:** `PawsMemories`  
**Branch reviewed:** `phase/bo-4-spatial-generator`  
**Primary implementation reviewed:** `server/spatial-generator/`  
**Review scope:** code and local evidence only; no production database or Layer8 service was available

## Executive summary

The repository does not contain a literal subfolder named `arkham-island`. The Arkham-named files in this checkout are scene assets and environment manifests. The temperature-cascade implementation that matches the request is the in-house spatial-generator subproject in `server/spatial-generator/`, especially `gent-scoring.ts`, on the `phase/bo-4-spatial-generator` branch.

The spatial generator has a credible staged architecture:

```text
observe (agent)
  → plan (agent)
  → deterministic math
  → allowlisted Blender compilation/build
  → deterministic validation
  → verify (agent)
  → human review
  → final build
```

Only `observe`, `plan`, and `verify` are eligible temperature-cascade units. Deterministic math, compilation, geometry checks, billing, hashing, and state transitions must remain outside the exposure model.

A first-pass sustained-condition scorer already exists. It computes an effective temperature, classifies the output as `high_heat`, `cold_stress`, `favorable_growth`, or `neutral`, counts consecutive matching conditions, emits a one-time threshold event, accumulates an adjustment, and derives a route.

It is not production-integrated:

- Nothing imports or calls `scoreGenerativeStage`.
- No database column or table stores its state or reports.
- Provider contracts do not supply most required telemetry.
- The live pipeline continues to route solely from `SpatialVerifyOutput.automatedPass`.
- There are no scorer tests.

The surrounding spatial pipeline also has pre-existing end-to-end blockers: job creation does not create the first attempt, no worker/dispatcher in the repository calls the internal pipeline operations, the observe/plan/verify hash checks include the supplied hash field in the payload being hashed, and uploaded draft assets are not inserted into the spatial artifact table that verification queries. Those issues must be repaired before exposure-based routing can be meaningfully enabled.

The proposed run-length exposure model should be implemented as a **job-scoped, ordered, idempotent state machine**. One “hour” becomes one terminal `observe`, `plan`, or `verify` agent-stage execution. Non-agent stages are skipped and do not break a run. A different classified condition breaks the run. State must continue across correction attempts; otherwise the existing six-unit high-heat and favorable-growth thresholds cannot be reached because a normal attempt contains only three eligible stages.

The safest implementation is to separate:

1. a pure, deterministic exposure reducer;
2. an append-only stage-score ledger;
3. a job-level exposure snapshot updated transactionally;
4. stage-aware orchestration policy.

Do not place this state only in an attempt JSON blob.

## 1. Scope resolution

### 1.1 What was found

The repository contains Arkham scene material:

- `server/animator/environments/arkham-approach-road.json`
- `server/animator/environments/arkham-gymnasium.json`
- `server/animator/environments/arkham-infirmary.json`
- `server/animator/environments/arkham-security-ops.json`
- matching image assets under `data/`, `public/`, and `dist/`

Those files describe environments and do not implement the temperature cascade.

The cascade implementation is:

- `server/spatial-generator/gent-scoring.ts`
- live stage orchestration in `server/spatial-generator/service.ts`
- Layer8 agent calls in `server/spatial-generator/provider.ts`
- stage contracts in `server/spatial-generator/types.ts` and `schemas.ts`
- persistence in `server/spatial-generator/repository.ts`
- migration 31 in `server/migrations/runner.ts`
- HTTP entry points in `server/spatial-generator/routes.ts`

Local evidence is recorded in `phase-evidence/BO_4_THERMAL_CASCADE.md`.

### 1.2 Review limitation

The working tree already contained uncommitted spatial-generator changes. This review did not modify those changes. The only new artifact from this review is this Markdown document.

## 2. Existing architecture

### 2.1 Live pipeline

| Pipeline step | Implementation | Agent-generated? | Exposure-eligible? |
|---|---|---:|---:|
| Observe references | `observeReferences()` / `observeClient.observe()` | Yes | Yes |
| Plan model | `generatePlan()` / `planClient.plan()` | Yes | Yes |
| Resolve dimensions and positions | `DeterministicMathSolver.execute()` | No | No |
| Compile Blender program | `compileBlenderProgram()` | No | No |
| Build draft and renders | Blender worker | No | No |
| Validate artifact structure and bounds | `validateGlb()` / `validateMathAgainstGlb()` | No | No |
| Verify draft renders | `verifyDraft()` / `verifyClient.verify()` | Yes | Yes |
| Approve or request correction | `reviewJob()` | Human | No |
| Build final asset | Blender worker | No | No |

The separation between advisory model output and authoritative deterministic work is the strongest part of the design and should be preserved.

### 2.2 Job and attempt lifecycle

The job state machine is approximately:

```text
draft
  → observing
  → planning
  → awaiting_math_worker
  → validating_math
  → building_draft
  → verifying_draft
  → awaiting_human_review | correction_requested
  → finalizing
  → completed
```

Failures and cancellation are terminal alternatives.

Each correction creates a new attempt. The configured maximum is the original attempt plus three correction attempts. A complete job can therefore contain up to twelve normal eligible agent-stage units:

```text
attempt 1: observe, plan, verify
attempt 2: observe, plan, verify
attempt 3: observe, plan, verify
attempt 4: observe, plan, verify
```

That correction sequence is the natural run-length timeline.

### 2.3 Current GENT-style scorer

The scorer computes:

```text
weighted_sum =
    0.45 × sampling_temperature
  + 0.20 × uncertainty
  + 0.20 × evidence_divergence
  + 0.15 × schema_repair_ratio

effective_temperature = 30 × clamp(weighted_sum, 0, 1)
```

It then classifies the stage:

| Condition | Current rule |
|---|---|
| `high_heat` | effective temperature ≥ 28 |
| `cold_stress` | effective temperature ≤ 4 and improvement < 0.01 |
| `favorable_growth` | 16 ≤ effective temperature < 28, schema valid, and improvement ≥ 0.01 |
| `neutral` | everything else |

Current threshold effects:

| Sustained condition | Run length | Adjustment |
|---|---:|---:|
| High heat | 6 | -20 |
| Cold stress | 2 | -10 |
| Favorable growth | 6 | +20 |

The final score is:

```text
final_quality = clamp(base_evidence_quality + cumulative_adjustment, 0, 100)
```

Current score routes:

| Final score | Route |
|---:|---|
| ≥ 85 | `human_review` |
| 65–84.999… | `structured_correction` |
| < 65 | `reject_to_planning` |

## 3. Findings

Severity meanings:

- **P0:** unsafe to enable because core correctness or authority boundaries fail.
- **P1:** required before production use.
- **P2:** important hardening or maintainability work.
- **P3:** cleanup or future improvement.

### Finding 1 — P0: the scorer is not wired into the live pipeline

`gent-scoring.ts` exports `scoreGenerativeStage`, `createInitialEpisodeState`, and `validateGentReport`, but there are no callers anywhere else in the repository. The spatial-generator module index does not export it, and the service never invokes it after observe, plan, or verify.

**Impact:** the current game/job behavior is unchanged by all cascade thresholds and routes. The scorer is parallel dead code.

**Required change:** call the exposure service exactly once for every terminal eligible agent-stage execution and use its stage-aware decision before committing the next job/attempt state.

### Finding 2 — P0: six-unit thresholds are unreachable under the documented per-attempt state

The scorer comment says state is persisted in the attempt record. A normal attempt has only three eligible units: observe, plan, and verify. Therefore:

- high-heat threshold at six cannot fire;
- favorable-growth threshold at six cannot fire;
- only cold stress at two can fire.

No attempt column currently stores the state anyway.

**Impact:** two of the three sustained-condition policies cannot operate in the normal architecture.

**Required change:** scope run state to the job/cascade, not to one attempt. Continue it across correction attempts. Link every unit to its attempt for audit, but do not reset the exposure snapshot when a correction attempt begins.

### Finding 3 — P0: required telemetry does not exist in the live contracts

`GentStageResult` requires:

- sampling temperature;
- uncertainty;
- evidence divergence;
- schema repair ratio;
- base evidence quality score;
- objective improvement.

The current provider functions return only domain outputs. They do not return a model/config envelope or trace metadata. Some domain fields can contribute to deterministic derivations, but they are not equivalent:

- observe exposes feature confidence and scale uncertainty;
- verify exposes four quality scores and critical issues;
- plan exposes no confidence or uncertainty metrics;
- no stage reports sampling temperature;
- no repair loop records attempts or repaired fields;
- no comparable previous-stage baseline is defined.

**Impact:** integration would require invented or misleading values, invalidating the score.

**Required change:** introduce a trusted `AgentStageTelemetry` envelope populated by orchestration/provider infrastructure, not by arbitrary model prose.

### Finding 4 — P0: scoring updates are not idempotent or transactional

The live pipeline uses leases and state checks, so a stage can be retried after a worker crash or database failure. A naïve call to `scoreGenerativeStage` on each retry would increment the run twice.

The current scorer has no unit identity, monotonic sequence, optimistic version, or persistence transaction.

**Impact:** replayed work can manufacture a sustained condition or apply a threshold adjustment more than once.

**Required change:** assign a stable `unit_key` to each logical stage execution and enforce a unique database constraint. Insert the ledger row, update the snapshot, emit any threshold event, and transition the attempt in one transaction.

### Finding 5 — P1: the function described as deterministic contains nondeterminism

The scorer calls `crypto.randomUUID()` and `new Date().toISOString()` internally. Both values are included in the report hash.

**Impact:** replaying identical inputs and prior state produces a different report and hash. Reports cannot be independently reproduced from their stated inputs.

**Required change:** make the reducer pure. The caller must supply stable `unitKey`, `unitSequence`, `observedAt`, and episode identity, or derive episode identity deterministically. Hash canonical decision data; keep ingestion timestamps outside the decision hash.

### Finding 6 — P1: report validation is shallow and does not verify integrity

`validateGentReport` checks only selected top-level types. It does not strictly validate:

- stage;
- effective-temperature range;
- base-score range;
- cascade-adjustment bounds;
- the shape and values of `episodeState`;
- threshold-event values;
- agreement between condition, run length, event, and adjustment;
- report-hash recomputation.

**Impact:** a malformed or tampered report can pass validation before human approval.

**Required change:** use strict Zod schemas for configuration, telemetry, state, events, and reports, then recompute and compare the canonical report hash.

### Finding 7 — P1: input validation and normalization are incomplete

The scorer assumes most inputs are within documented ranges but does not enforce them. The final weighted sum is clamped, which can hide invalid inputs greater than one. `NaN` can propagate through the clamp and into effective temperature and hashes.

**Impact:** bad telemetry silently saturates or poisons the scoring state.

**Required change:** reject non-finite or out-of-range telemetry before reduction. Do not “repair” trusted telemetry by clamping individual inputs.

### Finding 8 — P1: routing is not stage-aware

The generic route `human_review` can be returned for an observe or plan unit, even though human review occurs only after a built draft has been verified. Conversely, the live service routes only on `parsedVerification.automatedPass` and ignores the cascade route.

**Impact:** directly applying the current route would conflict with the job state machine; ignoring it makes scoring advisory-only.

**Required change:** separate a score band from an orchestration decision. Use stage-aware mapping:

- observe/plan normally continue;
- a negative threshold may retry/correct the current stage or restart planning according to policy;
- only verify can move the job to human review;
- deterministic validation remains a mandatory independent gate.

### Finding 9 — P1: `objectiveImprovement` lacks a comparable baseline

The code accepts a required number from -1 to 1 but does not define how it is computed. Comparing plan quality to the preceding observe score would be dimensionally wrong. The first occurrence of each stage has no baseline.

**Impact:** cold stress and favorable growth can be classified from arbitrary deltas.

**Required change:** compare a stage only with the same stage in the previous attempt, using the same versioned quality function. Represent “no baseline” as `null`; improvement-dependent conditions are ineligible until a baseline exists.

### Finding 10 — P1: the cumulative adjustment has no explicit lifetime or bound

`adjustmentAccumulator` carries adjustments across condition changes and has no minimum, maximum, decay, or job-boundary rule. Repeated episodes can permanently cancel or compound.

**Impact:** a historical episode can dominate later high-quality stages; policy behavior is hard to explain.

**Required change:** specify that the accumulator is job-scoped, starts at zero, and is bounded. Recommended initial bounds are `[-40, +20]`, with at most one adjustment per episode and no decay in v1. Revisit bounds using shadow-mode data.

### Finding 11 — P1: threshold event semantics are not durably exactly-once

The code fires only when `newConsecutiveCount === threshold`. That prevents repeated firing in one in-memory run, but `lastCrossingEvent` is not actually consulted and there is no persistence uniqueness rule.

**Impact:** stale state or replay can reissue an event; a corrupted state that jumps past a threshold will never issue it.

**Required change:** track `crossed_thresholds` in state and enforce a database uniqueness constraint on `(job_id, episode_id, threshold_key)`. The reducer should treat a crossing as `previous_run_length < threshold && new_run_length >= threshold`.

### Finding 12 — P1: no scorer-specific tests exist

The focused spatial isolation suite passes, and TypeScript compilation passes, but neither exercises `gent-scoring.ts`.

**Impact:** threshold boundaries, reset behavior, retry idempotency, persistence, hash integrity, and routing integration are unverified.

**Required change:** add pure reducer tests, repository transaction tests, service integration tests, concurrency tests, and migration tests.

### Finding 13 — P2: threshold calibration is unsupported by data

The effective-temperature formula makes high heat extremely rare. At sampling temperature `1.0`, the other three weighted signals must average approximately `0.879` to reach 28. The favorable band is broad, while cold stress depends on an undefined improvement delta.

**Impact:** thresholds may almost never fire or may fire for the wrong reasons.

**Required change:** ship in shadow mode, record component distributions, and calibrate on real cascades before enabling route changes.

### Finding 14 — P2: hash canonicalization is underspecified

The system repeatedly uses `JSON.stringify` as “canonicalization.” It is stable for objects created in a consistent insertion order but is not a formal cross-runtime canonical JSON contract.

**Impact:** provider, server, and external audit tooling may disagree on hashes.

**Required change:** adopt one canonical JSON serializer and numeric precision rule. Include the algorithm/version in the report schema.

### Finding 15 — P2: current evidence overstates some implementation guarantees

The local BO-4 evidence describes the thermal cascade and durable behavior more completely than the code provides. In particular, the scorer is not live, scoring persistence is absent, and the isolation suite proves only provider isolation—not scorer behavior or end-to-end job completion.

**Impact:** reviewers may mistake design evidence for runtime evidence.

**Required change:** update evidence only after tests exercise the wired stage path and durable state.

### Finding 16 — P0: observe, plan, and verify use self-referential hash checks

The domain schemas include `observationHash`, `planHash`, and `reportHash`. The service parses each complete object, serializes the complete object including that hash field, hashes it, and then requires the supplied hash to equal the result.

That requires a cryptographic fixed point:

```text
supplied_hash = SHA256(payload_including_supplied_hash)
```

A normal provider cannot produce such a value. The observation, plan, and verification paths should therefore fail with `HASH_MISMATCH` even for otherwise valid output.

**Impact:** the live agent cascade cannot complete its agent stages.

**Required change:** define hashable payload schemas that omit the hash field. Compute the hash from the canonical payload, then attach it in an outer envelope. Apply the same rule consistently to stored-domain and exposure reports.

### Finding 17 — P0: a new job has no initial attempt and no visible dispatcher

`startJob()` creates the job and input rows, reserves credits, and logs `job_created`, but it does not call `createAttempt()` or set `current_attempt_id`. `observeAndPlan()` immediately requires a current attempt and otherwise throws `NO_ATTEMPT`.

The only current `createAttempt()` caller is the correction retry path. Repository-wide search also found no caller outside the service for:

- `observeAndPlan()`;
- `executeMath()`;
- `buildDraft()`;
- service `verifyDraft()`;
- `finalizeJob()`.

**Impact:** a newly accepted job remains in `draft`, has no attempt to process, and has no in-repository worker dispatch path.

**Required change:** create attempt 1 in the same transaction as the job, set it as current, and enqueue an outbox/worker task transactionally. Add an explicit state-based worker dispatcher with idempotent claims and tests for every handoff.

### Finding 18 — P0: uploaded draft artifacts are not linked to the attempt

The Blender adapter uploads the GLB and five renders through `SpatialStorage`, which registers canonical assets and returns asset/version IDs. It never calls `SpatialGeneratorRepository.createArtifact()`.

Later, `verifyDraft()` calls `getArtifactsByAttempt()` and requires six roles from `spatial_generation_artifacts`. Because no rows were inserted, verification should fail with `MISSING_ARTIFACT`.

**Impact:** even if observe, plan, math, and build succeed, verification cannot find the draft.

**Required change:** insert each spatial artifact row with role, canonical asset IDs, hash, size, and MIME type in a recoverable finalization transaction. Make upload recovery idempotent so a database failure after object upload does not duplicate external objects or assets.

### Finding 19 — P0: attempt repository and migration schemas disagree

`SpatialGeneratorRepository.createAttempt()` inserts `idempotency_key`, and `SpatialAttemptRecord` declares it. Migration 31 does not create an `idempotency_key` column on `spatial_generation_attempts`.

**Impact:** creating a correction attempt should fail at runtime with an unknown-column error on a database created from the current migration.

**Required change:** add the column and a suitable uniqueness constraint in a forward-only migration, then add a migration/repository contract test. Do not edit an already-applied migration in production environments.

### Finding 20 — P1: nullable attempt updates cannot reliably clear leases

`updateAttemptState()` accepts truthy optional values and uses checks such as `if (extra?.leaseOwner)`. Service callers pass `null` when they intend to clear lease fields, but the repository ignores those values. Similar truthy checks make it impossible to deliberately persist some empty/zero values.

**Impact:** leases can remain attached after a state advances, confusing stale-work recovery and later claims.

**Required change:** distinguish `undefined` (“do not update”) from `null` (“set SQL NULL”), type the update patch accordingly, and use `!== undefined` checks. Prefer guarded transition methods that include expected state and lease owner in the `UPDATE ... WHERE` clause and verify `affectedRows === 1`.

### Finding 21 — P1: job idempotency lookup leaks a database connection

`startJob()` passes `await this.pool.getConnection()` directly to `getJobByOwnerAndIdempotency()` and does not retain or release that connection.

**Impact:** repeated job creation requests can exhaust the connection pool.

**Required change:** perform the lookup with a scoped connection and `finally`, or move it into the main transaction. The unique job idempotency constraint must remain the final concurrency authority.

## 4. Target run-length exposure model

### 4.1 Semantic definition

A **run-length exposure** is the number of consecutive eligible agent-stage units classified into the same non-neutral condition.

One unit replaces one “hour” in a conventional sustained-exposure model.

```text
eligible unit = one terminal observe, plan, or verify stage execution
```

A terminal execution is counted when the provider returned a stage response and the orchestration layer has finalized its schema/repair telemetry. It may be schema-invalid. Transport failures, cancellations before response, deterministic steps, and human actions are not units.

### 4.2 Ordering and continuity

Units are ordered by a monotonically increasing `unit_sequence` within one job.

Continuity rules:

1. `observe`, `plan`, and `verify` participate.
2. Deterministic steps are skipped; they neither increment nor break a run.
3. The same classified non-neutral condition increments the run by one.
4. A different condition starts a new episode at run length one.
5. `neutral` ends the active episode and leaves run length zero.
6. A correction attempt does not reset job-level exposure state.
7. A new job starts from neutral with zero cumulative adjustment.
8. A terminal job freezes the state.
9. Replaying an existing `unit_key` returns its stored report and does not increment anything.
10. An out-of-order new unit is rejected or queued; it must never be applied speculatively.

Example:

| Sequence | Attempt | Stage | Condition | Run length | Effect |
|---:|---:|---|---|---:|---|
| 1 | 1 | observe | high heat | 1 | none |
| 2 | 1 | plan | high heat | 2 | none |
| 3 | 1 | verify | high heat | 3 | none |
| — | — | human correction | ineligible | 3 | unchanged |
| 4 | 2 | observe | high heat | 4 | none |
| 5 | 2 | plan | high heat | 5 | none |
| 6 | 2 | verify | high heat | 6 | apply -20 once |
| 7 | 3 | observe | neutral | 0 | close episode |

### 4.3 Classification inputs

Use a trusted envelope:

```typescript
type EligibleStage = "observe" | "plan" | "verify";

interface AgentStageTelemetryV2 {
  schemaVersion: "pawsome.agent-stage-telemetry.v2";
  configVersion: string;
  jobUuid: string;
  attemptNumber: number;
  stage: EligibleStage;
  unitKey: string;
  unitSequence: number;
  observedAt: string;

  provider: string;
  model: string;
  samplingTemperature: number; // [0, 1], from effective provider config

  schemaValid: boolean;        // computed by server validation
  repairAttempts: number;      // integer >= 0
  repairableFields: number;    // integer >= 0
  repairedFields: number;      // 0..repairableFields

  uncertainty: number;         // [0, 1], deterministic adapter
  evidenceDivergence: number;  // [0, 1], deterministic adapter
  baseEvidenceQuality: number; // [0, 100], deterministic adapter
  comparablePriorQuality: number | null;

  sourcePayloadHash: string;
}
```

Derived values:

```text
schema_repair_ratio =
  repairable_fields == 0
    ? (repair_attempts > 0 ? 1 : 0)
    : repaired_fields / repairable_fields

objective_improvement =
  comparable_prior_quality == null
    ? null
    : clamp((base_quality - comparable_prior_quality) / 100, -1, 1)
```

### 4.4 Stage telemetry adapters

All formulas must be versioned and deterministic.

#### Observe

Recommended v1 components:

```text
uncertainty =
  weighted mean of:
  - scaleEvidence.uncertainty
  - 1 - mean(feature.confidence)
  - occlusion burden normalized to configured cap

evidence_divergence =
  cross-view feature disagreement computed from feature view coverage

base_quality =
  100 × weighted mean of:
  - mean feature confidence
  - view coverage
  - 1 - scale uncertainty
  - 1 - occlusion burden
```

Do not let the model provide its own final quality score.

#### Plan

The current plan contract needs deterministic plan-quality metrics, for example:

- envelope compliance;
- primitive/constraint completeness;
- feature coverage against observation;
- unsupported-operation count;
- constraint contradiction count;
- normalized plan complexity;
- cross-reference coverage.

These should be computed server-side after schema parsing. If plan evidence divergence cannot be computed honestly, omit it from a stage-specific formula rather than inventing a value. This argues for versioned per-stage weights instead of one universal formula.

#### Verify

Recommended v1 components:

```text
base_quality =
  100 × weighted mean(
    silhouette,
    proportion,
    featurePresence,
    viewConsistency
  )

uncertainty =
  weighted mean of critical-issue confidence uncertainty
  plus any provider-level uncertainty

evidence_divergence =
  1 - viewConsistency
```

Deterministic artifact validation remains a separate hard gate. A favorable agent score can never override missing artifacts, invalid GLB structure, bounds mismatch, topology failure, or manufacturing failure.

### 4.5 Versioned configuration

Create `server/spatial-generator/exposure/config.ts`:

```typescript
interface ExposureConfigV2 {
  schemaVersion: "pawsome.run-length-exposure.v2";
  configVersion: string;
  weightsByStage: Record<EligibleStage, {
    samplingTemperature: number;
    uncertainty: number;
    evidenceDivergence: number;
    schemaRepairRatio: number;
  }>;
  conditions: {
    highHeatMin: number;
    coldStressMax: number;
    coldStressImprovementMax: number;
    favorableMin: number;
    favorableMaxExclusive: number;
    favorableImprovementMin: number;
  };
  thresholds: {
    highHeat: { runLength: number; adjustment: number };
    coldStress: { runLength: number; adjustment: number };
    favorableGrowth: { runLength: number; adjustment: number };
  };
  cumulativeAdjustment: { min: number; max: number };
  scoreBands: {
    humanReviewMin: number;
    structuredCorrectionMin: number;
  };
}
```

Initial values may preserve the current thresholds, but the configuration version must be stored with every unit and snapshot. A job should pin one configuration version at creation so a deployment cannot change its semantics mid-cascade.

### 4.6 Pure reducer

Create `server/spatial-generator/exposure/reducer.ts`.

```typescript
interface ExposureStateV2 {
  schemaVersion: "pawsome.run-length-exposure-state.v2";
  jobUuid: string;
  configVersion: string;
  lastUnitSequence: number;
  activeEpisodeId: string | null;
  condition: "high_heat" | "cold_stress" | "favorable_growth" | "neutral";
  runLength: number;
  crossedThresholds: string[];
  cumulativeAdjustment: number;
  version: number;
}

interface ExposureDecisionV2 {
  schemaVersion: "pawsome.run-length-exposure-report.v2";
  unitKey: string;
  unitSequence: number;
  stage: EligibleStage;
  effectiveTemperature: number;
  condition: ExposureStateV2["condition"];
  previousRunLength: number;
  runLength: number;
  thresholdEvents: ExposureThresholdEventV2[];
  adjustmentDelta: number;
  cumulativeAdjustment: number;
  baseEvidenceQuality: number;
  adjustedQuality: number;
  scoreBand: "review_ready" | "correction" | "reject";
  nextState: ExposureStateV2;
  inputHash: string;
  decisionHash: string;
}
```

Function contract:

```typescript
reduceExposure(
  previousState: Readonly<ExposureStateV2>,
  telemetry: Readonly<AgentStageTelemetryV2>,
  config: Readonly<ExposureConfigV2>
): ExposureDecisionV2
```

Properties:

- no I/O;
- no clock access;
- no UUID generation;
- no mutation of arguments;
- strict sequence check;
- strict version/config check;
- canonical numeric rounding;
- deterministic output for identical inputs;
- crossing detection uses `< threshold` to `>= threshold`;
- cumulative adjustment is bounded;
- one adjustment per episode/threshold key.

### 4.7 Episode identity

Derive an episode ID rather than generating it inside the reducer:

```text
episode_id = SHA256(job_uuid + ":" + first_unit_sequence + ":" + condition)
```

This is stable under replay and contains no sensitive payload.

### 4.8 Persistence model

Add a forward-only migration after the current spatial-generator migration.

#### `spatial_generation_exposure_state`

| Column | Type | Notes |
|---|---|---|
| `job_id` | BIGINT PK/FK | one current snapshot per job |
| `schema_version` | VARCHAR(64) | state schema |
| `config_version` | VARCHAR(64) | pinned job policy |
| `last_unit_sequence` | INT UNSIGNED | starts at 0 |
| `active_episode_id` | CHAR(64) NULL | deterministic episode hash |
| `condition` | ENUM | four current conditions |
| `run_length` | INT UNSIGNED | zero for neutral |
| `crossed_thresholds_json` | JSON | threshold latches |
| `cumulative_adjustment` | SMALLINT | bounded by config |
| `version` | BIGINT UNSIGNED | optimistic concurrency |
| `state_hash` | CHAR(64) | canonical state hash |
| `updated_at` | TIMESTAMP(3) | operational metadata |

#### `spatial_generation_stage_scores`

| Column | Type | Notes |
|---|---|---|
| `id` | BIGINT PK | ledger identity |
| `job_id` | BIGINT FK | job scope |
| `attempt_id` | BIGINT FK | audit lineage |
| `unit_key` | VARCHAR(160) | stable logical-stage key |
| `unit_sequence` | INT UNSIGNED | total order within job |
| `stage` | ENUM | observe/plan/verify |
| `schema_version` | VARCHAR(64) | report schema |
| `config_version` | VARCHAR(64) | policy used |
| `telemetry_json` | JSON | validated trusted envelope |
| `input_hash` | CHAR(64) | canonical telemetry hash |
| `effective_temperature` | DECIMAL(8,4) | rounded canonical value |
| `condition` | ENUM | classified condition |
| `episode_id` | CHAR(64) NULL | episode lineage |
| `run_length` | INT UNSIGNED | post-unit run length |
| `adjustment_delta` | SMALLINT | this unit only |
| `cumulative_adjustment` | SMALLINT | post-unit total |
| `base_quality` | DECIMAL(7,3) | 0–100 |
| `adjusted_quality` | DECIMAL(7,3) | 0–100 |
| `score_band` | ENUM | review_ready/correction/reject |
| `decision_json` | JSON | full report |
| `decision_hash` | CHAR(64) | canonical report hash |
| `created_at` | TIMESTAMP(3) | ingestion metadata |

Required constraints:

```text
UNIQUE(job_id, unit_key)
UNIQUE(job_id, unit_sequence)
UNIQUE(job_id, decision_hash)
INDEX(attempt_id, stage)
INDEX(job_id, condition, run_length)
```

#### Threshold events

Threshold events may remain in `spatial_generation_events`, but add a durable unique threshold key to prevent duplicate insertion. If altering the generic event table is undesirable, add:

```text
spatial_generation_exposure_events
UNIQUE(job_id, episode_id, threshold_key)
```

### 4.9 Unit keys and sequence allocation

Recommended logical key:

```text
{job_uuid}:{attempt_number}:{stage}:{stage_execution_number}
```

`stage_execution_number` is needed if the product intentionally retries a stage as a new exposure unit. A worker replay of the same logical execution reuses the same number and key.

Allocate `unit_sequence` under a row lock on the job exposure snapshot. Do not use “max + 1” without locking.

### 4.10 Transaction boundary

For each eligible stage:

```text
1. Invoke provider outside the database transaction.
2. Build trusted telemetry and domain parse result.
3. Begin transaction.
4. Lock attempt row and job exposure snapshot FOR UPDATE.
5. Confirm lease, expected attempt state, and config version.
6. Look up (job_id, unit_key).
   - if present and input hash matches: return stored decision;
   - if present and input hash differs: fail with IDEMPOTENCY_CONFLICT.
7. Validate next unit sequence.
8. Run pure reducer.
9. Insert stage-score ledger row.
10. Update exposure snapshot with optimistic version check.
11. Insert threshold event(s) with unique keys.
12. Persist domain output or failure telemetry.
13. Apply stage-aware job/attempt transition.
14. Commit.
```

If any step fails, none of the scoring state, event, domain output, or pipeline transition is committed.

### 4.11 Stage-aware orchestration policy

Keep two independent decisions:

1. **Hard gate:** schema, security, artifact, math, and geometry validity.
2. **Exposure policy:** quality band and sustained-condition event.

Recommended v1 mapping:

| Stage | Hard gate | Exposure result | Action |
|---|---|---|---|
| Observe | fail | any | fail/correct observation; persist exposure unit if provider returned |
| Observe | pass | no negative crossing | continue to plan |
| Observe | pass | negative crossing | structured observation correction or new attempt |
| Plan | fail | any | reject/correct plan |
| Plan | pass | no negative crossing | continue to math |
| Plan | pass | negative crossing | retry/reject to planning |
| Verify | fail deterministic checks | any | correction/failure; never human review |
| Verify | pass | `review_ready` and automated pass | awaiting human review |
| Verify | pass | `correction` | correction requested |
| Verify | pass | `reject` | reject to planning/new attempt |

A favorable-growth bonus may improve a quality band but must not bypass hard gates.

For the first rollout, negative threshold events should be **advisory in shadow mode**. After calibration, enable routing behind a separate feature flag.

### 4.12 Approval binding

The human-review attempt hash should include the latest exposure decision:

```text
attempt_hash = SHA256({
  observation_hash,
  plan_hash,
  math_hash,
  compiled_program_hash,
  automated_report_hash,
  latest_exposure_decision_hash,
  exposure_config_version
})
```

Before approval:

- strictly parse the stored decision;
- recompute its hash;
- confirm its job, attempt, unit, stage, config, and source payload hashes;
- confirm no later unit exists;
- confirm the score band is review-ready;
- independently confirm automated and deterministic verification gates.

## 5. Integration changes by file

### New files

```text
server/spatial-generator/exposure/config.ts
server/spatial-generator/exposure/schemas.ts
server/spatial-generator/exposure/types.ts
server/spatial-generator/exposure/adapters.ts
server/spatial-generator/exposure/reducer.ts
server/spatial-generator/exposure/service.ts
tests/spatial_exposure_reducer.test.mjs
tests/spatial_exposure_repository.test.mjs
tests/spatial_exposure_integration.test.mjs
```

### Existing files

#### `server/spatial-generator/provider.ts`

- Return or expose effective provider/model configuration.
- Capture sampling temperature from actual request configuration.
- Return provider trace metadata separately from domain output.
- Do not trust the model to declare schema validity or final quality.

#### `server/spatial-generator/schemas.ts`

- Add strict telemetry, exposure state, event, and decision schemas.
- Add finite/range constraints.
- Add nullable comparable-prior quality.
- Version all new contracts.

#### `server/spatial-generator/types.ts`

- Add public/internal exposure types.
- Add stored record shapes.
- Add `latestExposureDecisionHash` and `exposureConfigVersion` to internal attempt/job views as appropriate.

#### `server/spatial-generator/repository.ts`

- Create/get/lock exposure snapshot.
- Insert/get stage score by unit key.
- Allocate the next sequence under lock.
- Atomically update snapshot by expected version.
- Read previous comparable score by stage.
- Insert exactly-once threshold events.
- Parse MySQL JSON consistently; current code assumes a mix of parsed objects and JSON strings.

#### `server/spatial-generator/service.ts`

- Inject an `ExposureService` for testing.
- After every eligible provider stage, build telemetry and score it inside the persistence transaction.
- Use stage-aware routing.
- Include the latest decision hash/config version in the review binding.
- On replay, load the stored decision instead of incrementing the run.
- Keep deterministic phases ineligible.

#### `server/spatial-generator/index.ts`

- Export the exposure public contracts and service, not reducer internals unless tests need a direct import.

#### `server/migrations/runner.ts`

- Add the two exposure tables and exactly-once constraints in one forward-only migration.
- Initialize a neutral snapshot when a spatial job is created, or lazily under lock on its first eligible unit.

#### `server/spatial-generator/routes.ts`

- Do not expose raw telemetry by default.
- Add exposure summaries to admin job detail only if operationally needed.
- Preserve owner/admin authorization and rate limits.

#### `phase-evidence/BO_4_THERMAL_CASCADE.md`

- Replace design claims with commands and test results after the live integration exists.
- Document shadow-mode counts, duplicate-replay tests, and migration verification.

## 6. Implementation plan

### Phase -1 — Repair and prove the base cascade

Deliverables:

- compute agent-output hashes over payloads that exclude their hash field;
- create attempt 1 and set `current_attempt_id` during job creation;
- add a durable outbox/dispatcher for pipeline state handoffs;
- reconcile the attempt `idempotency_key` repository/migration contract;
- link uploaded canonical assets into `spatial_generation_artifacts`;
- make lease clearing and guarded transitions explicit;
- close the job-creation connection leak;
- add one end-to-end fake-provider/fake-worker job test.

Acceptance:

- a new job reaches `awaiting_human_review` using injected providers and worker;
- each state handoff is dispatched and claimed exactly once;
- provider output hashes validate without self-reference;
- verification reads all six attempt-linked draft artifacts;
- a correction attempt can be created on a migrated database;
- no connection or lease remains unintentionally held.

### Phase 0 — Freeze semantics and collect fixtures

Deliverables:

- approve job-scoped continuity across attempts;
- define whether a schema-invalid provider response counts as a terminal eligible unit;
- define stage-specific telemetry formulas;
- pin v2 configuration;
- capture representative observe, plan, and verify payload fixtures;
- define canonical JSON and numeric rounding.

Acceptance:

- every input field has a named authoritative source;
- first-stage baseline behavior is explicit;
- no formula relies on invented telemetry.

### Phase 1 — Build the pure model

Deliverables:

- strict types and schemas;
- versioned configuration;
- deterministic condition classifier;
- pure run-length reducer;
- stable episode IDs;
- canonical hashes;
- unit tests.

Acceptance:

- identical inputs produce byte-identical decisions;
- thresholds fire once at crossing;
- neutral and condition changes reset correctly;
- ineligible gaps do not affect state;
- accumulator bounds hold;
- invalid telemetry is rejected.

### Phase 2 — Add durable state and idempotency

Deliverables:

- migration;
- repository methods;
- row-lock/optimistic-version transaction;
- ledger and snapshot records;
- replay and conflict behavior;
- repository tests against MySQL-compatible fixtures.

Acceptance:

- concurrent duplicate submissions create one unit;
- replay returns the original decision;
- same unit key plus different input fails;
- threshold event is exactly-once;
- rollback leaves no partial state.

### Phase 3 — Instrument providers and adapters

Deliverables:

- provider trace envelope;
- observe/plan/verify adapters;
- comparable same-stage prior lookup;
- schema-repair accounting;
- adapter tests with fixtures.

Acceptance:

- telemetry matches actual provider configuration;
- quality and divergence are reproducible from stored inputs;
- no model-authored scalar is treated as authoritative without validation.

### Phase 4 — Wire all three live stages in shadow mode

Deliverables:

- exposure service injection;
- observe, plan, and verify hooks;
- job-scoped state across correction attempts;
- event logging;
- admin-only exposure summary;
- feature flags:
  - `SPATIAL_EXPOSURE_SCORING_ENABLED`
  - `SPATIAL_EXPOSURE_ROUTING_ENABLED`

Acceptance:

- scoring enabled/routing disabled changes no job route;
- every terminal eligible stage has exactly one ledger row;
- deterministic stages have none;
- six-unit runs span attempts correctly;
- worker replay does not increment.

### Phase 5 — Bind review and enable guarded routing

Deliverables:

- attempt-hash binding to latest exposure decision and config;
- strict report revalidation before approval;
- stage-aware routing;
- correction/reject reason codes;
- audit/event updates.

Acceptance:

- favorable scores cannot bypass hard gates;
- only verify can reach human review;
- stale or tampered exposure reports block approval;
- correction attempts preserve exposure continuity.

### Phase 6 — Calibrate and roll out

Deliverables:

- distribution dashboard by stage, model, and config version;
- counts of each condition and threshold crossing;
- counterfactual route comparison in shadow mode;
- false-positive review sample;
- finalized thresholds and rollback criteria.

Suggested rollout:

1. development fixtures;
2. test environment with synthetic sustained runs;
3. production shadow mode;
4. 5% routing enablement for admin-only jobs;
5. 25%, 50%, then 100% after review.

Rollback is immediate by disabling routing; continue shadow scoring if it is not causing load or persistence problems.

## 7. Test specification

### 7.1 Pure reducer table tests

At minimum:

- first high-heat unit starts at one;
- six consecutive high-heat units fire one -20 event;
- seventh high-heat unit does not fire again;
- high, high, neutral, high produces run length one;
- high, high, favorable starts favorable at one;
- deterministic gaps preserve run length;
- correction-attempt boundary preserves run length;
- cold stress fires at two;
- favorable growth fires at six;
- first stage with no baseline cannot classify improvement-dependent conditions;
- cumulative adjustment clamps at configured bounds;
- out-of-order sequence fails;
- config mismatch fails;
- `NaN`, infinity, negative ratios, and values over bounds fail;
- same input/state produces the same hash.

### 7.2 Persistence tests

- insert first unit and snapshot atomically;
- duplicate unit key/same hash returns stored row;
- duplicate unit key/different hash conflicts;
- duplicate sequence conflicts;
- concurrent sixth unit creates one event and one adjustment;
- transaction rollback removes ledger/event/snapshot changes;
- snapshot version conflict retries safely;
- state reconstruction from ledger equals stored snapshot.

### 7.3 Service integration tests

- observe completion writes one exposure unit before planning;
- plan completion writes the next unit;
- math/build writes no unit;
- verify completion writes the next unit;
- negative observe/plan crossing follows stage-aware policy;
- verify review-ready plus hard gates enters human review;
- verify review-ready plus hard-gate failure does not;
- retry/new attempt continues the job-level run;
- worker lease replay does not double count;
- provider timeout writes no unit;
- schema-invalid returned response follows the approved eligibility rule.

### 7.4 Security and integrity tests

- owner isolation for exposure summaries;
- non-admin cannot inspect raw telemetry;
- decision hash recomputation detects tampering;
- config version substitution is rejected;
- source payload hash mismatch is rejected;
- approval fails when a newer unit exists;
- threshold event payload excludes prompts, model prose, and secrets.

### 7.5 Migration tests

- migration applies to an existing populated schema;
- foreign keys and unique constraints exist;
- old jobs can lazily initialize neutral state;
- migration is forward-only and rerunnable through the project migration runner.

## 8. Observability

Record structured, non-sensitive metrics:

```text
spatial_exposure_units_total{stage, condition, config_version}
spatial_exposure_threshold_crossings_total{condition, config_version}
spatial_exposure_routes_total{stage, score_band, routing_enabled}
spatial_exposure_replays_total{result}
spatial_exposure_conflicts_total{type}
spatial_exposure_transaction_seconds
spatial_exposure_run_length{condition}
spatial_exposure_effective_temperature{stage}
```

Logs should include:

- job UUID;
- attempt number;
- unit key and sequence;
- stage;
- config version;
- input/decision hashes;
- condition and run length;
- adjustment delta;
- selected orchestration action.

Do not log raw prompts, provider credentials, signed URLs, reference images, or unredacted model output.

Alerts:

- duplicate/idempotency conflicts above baseline;
- sequence gaps;
- snapshot/ledger reconstruction mismatch;
- threshold crossing rate changes sharply after model/config deployment;
- routing-enabled correction rate exceeds the shadow-mode forecast;
- exposure transaction latency threatens worker leases.

## 9. Operational invariants

The implementation should continuously enforce:

1. One logical eligible stage execution produces at most one ledger row.
2. A ledger row belongs to exactly one job and attempt.
3. Unit sequences are contiguous within a job.
4. Snapshot state equals a fold of the ledger under the pinned config.
5. One episode/threshold key produces at most one event and adjustment.
6. Deterministic and human stages never increment run length.
7. A new attempt does not silently reset job-level exposure.
8. A terminal job cannot accept new units.
9. A favorable score cannot override deterministic failure.
10. Human approval binds the exact exposure report used for routing.

## 10. Risks and design choices

### Strict consecutive runs versus grace periods

The v1 model should use strict consecutive conditions: any different eligible condition breaks the run. This is easy to explain and test. If real data shows boundary jitter, add a separately versioned hysteresis or one-unit grace policy later; do not quietly reinterpret “consecutive.”

### Cross-stage comparability

Temperature condition can span observe, plan, and verify because it is normalized. Quality improvement cannot be compared across unlike stages. Improvement must be same-stage, previous-attempt only.

### Counting invalid schema responses

Counting a terminal but schema-invalid provider response is useful because repair stress is part of the temperature formula. It also requires scoring before the domain transition fails. This is a product decision that must be frozen in Phase 0. Transport failures should not count because no exposure reading exists.

### Model/config changes during a job

A job pins one exposure configuration. Prefer also pinning provider model versions for the attempt. If the model must change mid-job, either start a new exposure epoch explicitly or record the change and treat it as a run break. Silent mixing makes calibration unreliable.

### Accumulated bonuses

Positive adjustments create a risk of laundering weak evidence into a review-ready score. The recommended `+20` job cap and independent hard gates limit this, but shadow data should determine whether bonuses should affect routing at all. A safer first production policy is to record favorable-growth bonuses while allowing only negative adjustments to affect routes.

## 11. Definition of done

The run-length exposure model is complete only when:

- all three eligible live stages call it;
- state persists across correction attempts at job scope;
- provider telemetry is real and versioned;
- the reducer is deterministic and strictly validated;
- stage updates are atomic and idempotent;
- threshold events are exactly-once;
- stage-aware routes fit the existing job state machine;
- deterministic gates remain authoritative;
- approval binds and revalidates the exposure decision;
- reducer, repository, service, concurrency, integrity, and migration tests pass;
- shadow-mode evidence supports calibrated thresholds;
- operational flags can disable routing without disabling audit collection;
- local evidence accurately distinguishes tested behavior from design intent.

## 12. Verification performed during this review

The following checks were run against the current working tree:

| Check | Result |
|---|---|
| Repository-wide search for Arkham, temperature, cascade, GENT, and scorer callers | Completed |
| TypeScript compile (`npm run lint`, which runs `tsc --noEmit`) | Passed |
| Focused spatial-generator isolation suite | 11 passed, 0 failed |
| Manual six-unit high-heat sequence against current scorer | Threshold fired on unit 6; adjustment changed from 0 to -20; route changed from human review to structured correction |
| Search for scorer integration and persistence | No callers or persistence found |

These checks establish that the isolated scorer compiles and its basic in-memory threshold works. They do not establish live integration, durable idempotency, end-to-end job completion, production Layer8 behavior, or database migration correctness.
