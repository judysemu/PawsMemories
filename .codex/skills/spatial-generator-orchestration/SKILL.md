---
name: spatial-generator-orchestration
description: Design, implement, review, or debug the durable in-house accessory and hard-surface generator that assigns Gemini to vision, GPT to declarative CAD planning, Gemma on the Pixel to spatial math, and Blender to construction. Use for state machines, provider boundaries, schemas, persistence, leases, idempotency, billing, corrections, and zero-Tripo isolation.
---

# Spatial Generator Orchestration

Read `INHOUSE_SPATIAL_GENERATOR_ARCHITECTURE.md` and load SPAT-001, SPAT-002,
SPAT-005, or SPAT-006 when touching their boundaries.

## Fixed Model Roles

- Gemini: reference observation and post-draft visual adherence.
- GPT: strict declarative construction plan and correction revision.
- Gemma on Pixel: normalized-to-millimeter math and derived calculations.
- Deterministic server code: independent math/safety validation.
- Blender on Render: draft/final geometry, renders, GLB/STL validation.
- Tripo: organic pet/human reconstruction only.

Do not substitute one model for another on failure. If a required role is
unavailable, fail with a stable retryable code before charging where possible.

## Implementation Order

1. Add strict bounded schemas and known-dimension fixtures.
2. Add migration 31 tables and locked repository transitions.
3. Add injectable provider interfaces and fakes.
4. Implement Gemini observation.
5. Implement GPT strict plan through the Responses API.
6. Submit/poll `spatial_math` through durable Hermes leases.
7. Recompute every Gemma value and bind it to the plan hash.
8. Compile and build a private draft through SPAT-006.
9. Run SPAT-005 automated and human review.
10. Finalize from accepted hashes; apply billing and lineage exactly once.

## State Rules

Use the architecture state machine exactly. Every transition must:

- lock the current job/attempt row
- verify owner and current state
- verify expected attempt/hash
- write the next state and append an audit event atomically
- avoid provider work inside a long database transaction

Provider submission uses reserve -> call -> persist handle. If the provider call
succeeds but persistence fails, enter `recovery_required`; never blindly refund and
resubmit.

## Contracts

- Reject unknown fields at every API/model/worker boundary.
- Bound strings, arrays, image count/size, coordinates, dimensions, primitive count,
  output tokens, response bytes, retries, and timeouts.
- Reference images are owned canonical private asset versions, not arbitrary URLs.
- An image request requires a physical scale anchor.
- Plan, math, compiled program, draft, report, review, and final artifacts each have
  immutable hashes.
- Correction attempt N+1 never overwrites attempt N.

## Provider Isolation

Adapters must be injectable. Tests must prove zero unintended calls on auth,
validation, ownership, balance, idempotency, stale-hash, and state failures.

The in-house accessory lane must assert zero calls to all Tripo start, poll, rig,
download, and mirror methods. The organic lane must remain explicit and tested.

## Billing

- Quote without provider calls.
- Reserve atomically with owner-scoped idempotency.
- Charge only after a reviewable draft exists, per approved pricing policy.
- Refund eligible failures exactly once using unique ledger correlation keys.
- Never trust client price, feature flag, admin status, or credit disposition.

## Recovery

- Provider and worker work requires a short lease and heartbeat.
- Reject stale, replaced, foreign, ambiguous, completed, and over-attempt work before
  external calls.
- Pixel unavailable, GPT refusal, invalid model schema, deterministic math mismatch,
  Blender failure, and visual failure use separate codes.
- Background recovery only scans bounded eligible rows and never invents ownership.

## Required Evidence

- State transition and concurrency tests against MySQL.
- Provider spies proving call isolation.
- Hash/idempotency/refund tests.
- Pixel lease and wrong-math fixtures.
- Draft/review/final lineage.
- Exact migration version/checksum, test totals, build, archive, and live hardware
  gates.

Keep `INHOUSE_SPATIAL_GENERATOR_ENABLED=false` until owner acceptance is recorded.
