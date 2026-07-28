---
name: layer8-spatial-gateway
description: Extend or integrate robs46859-eng/layer8 as the secure multi-tenant AI control plane for PawsMemories spatial generation. Use for Gemini/GPT provider adapters, Hermes/Pixel math jobs, service-role routing, strict structured outputs, private image references, tenant scopes, rate limits, cache policy, circuit breakers, idempotency, audit, and spatial gateway tests.
---

# Layer8 Spatial Gateway

Read `INHOUSE_SPATIAL_GENERATOR_ARCHITECTURE.md` and the Layer8 repository's
`.codex/skills/android-ai-gateway-wiring/SKILL.md` and
`.codex/skills/ai-gateway-productization/SKILL.md` before editing either project.

## Intended Role

Use Layer8 as the spatial workflow's model control plane:

```text
PawsMemories server
  -> Layer8 spatial service operation
       -> Gemini: observe or verify
       -> OpenAI: create or revise a declarative plan
       -> Hermes provider adapter: enqueue Pixel/Gemma math
  <- strict, versioned JSON result

PawsMemories server -> Blender worker -> private GLB/STL/renders
```

Layer8 owns tenant API-key authentication, entitlement checks, model credentials,
rate limits, provider policy, normalized errors, circuit breakers, cost/usage audit,
and safe inference metadata. PawsMemories continues to own generation state,
credits, approval hashes, corrections, asset lineage, and Blender execution.

Do not send GLB, STL, IFC, texture archives, or other large binary artifacts through
the generic Layer8 inference endpoint. Pass short-lived private asset references or
bounded image payloads only when the selected provider requires them.

## Preserve Existing Strengths

The current Layer8 pipeline already provides the correct high-level sequence:
authentication, policy, rate limiting, before-plugins, cache lookup, provider
routing, cache write, after-plugins, audit, and normalized response. Extend that
pipeline instead of creating a second gateway inside PawsMemories.

Keep PostgreSQL and Redis tenant boundaries. Never use an unpartitioned cache key or
write provider secrets, prompts, image bytes, signed URLs, or model output bodies to
logs.

## Required Layer8 Upgrades

1. Add versioned service operations rather than accepting arbitrary model names:
   `spatial.observe.v1`, `spatial.plan.v1`, `spatial.math.v1`, and
   `spatial.verify.v1`.
2. Add strict request and result profiles with unknown fields rejected, bounded
   arrays/strings/numbers, schema version, request hash, and result hash.
3. Add private multimodal asset references with tenant ownership, MIME, size, hash,
   expiry, and purpose validation. Never fetch an arbitrary client URL.
4. Add durable asynchronous jobs for Pixel/Gemma work, including idempotency,
   accepted/running/completed/failed states, polling, cancellation, and expiry.
5. Route by service operation and policy, not a client-controlled `provider_hint`.
   Lock each operation to its approved provider role.
6. Add a Hermes provider adapter for `spatial.math.v1`. It submits the job, polls or
   receives completion, validates the result, and never falls back to GPT/Gemini.
7. Add Gemini adapters for observation and visual verification and an OpenAI
   Responses adapter for strict declarative plans.
8. Add tenant scopes and entitlements: `spatial:observe`, `spatial:plan`,
   `spatial:math`, and `spatial:verify`.
9. Add provider health, timeout, retry classification, circuit breaking, and
   per-operation concurrency. Retries must preserve one idempotency key.
10. Add privacy-aware cache policy. Disable caching for private image observation,
    visual verification, and correction requests by default. Any deterministic math
    cache must include tenant, operation, schema, plan hash, model digest, and policy
    version.

## Contract Shape

Extend Layer8's generic inference schema with a spatial envelope or dedicated route:

```json
{
  "operation": "spatial.plan.v1",
  "idempotency_key": "opaque-owner-scoped-key",
  "input_profile": "paws.accessory-plan-input.v1",
  "output_profile": "paws.accessory-plan.v1",
  "payload": {},
  "asset_refs": [],
  "metadata": {
    "paws_job_uuid": "uuid",
    "attempt": 1,
    "request_hash": "sha256"
  }
}
```

The client selects an operation, never a provider. Layer8 selects the pinned adapter
from server policy and returns a stable status/error envelope. PawsMemories validates
the returned profile again before persisting it.

## Layer8 Files To Extend

- `app/schemas/inference.py`: service operation, asset reference, strict output
  profile, async status, and bounded metadata contracts.
- `app/providers/base.py`: provider capabilities, operation support, timeout/error
  classes, and synchronous/asynchronous adapter contracts.
- `app/services/routing.py`: policy-controlled operation routing, health, circuit
  state, and forbidden-fallback enforcement.
- `app/core/pipeline.py`: entitlement checks, per-operation cache policy,
  idempotency, redaction, and correlated audit.
- `app/providers/`: Gemini Vision, OpenAI Responses, and Hermes/Pixel adapters.
- `app/api/`: spatial submission/status/cancel routes if the generic inference route
  cannot represent durable math jobs cleanly.
- migrations/config: tenant scopes, service policies, provider credentials, quotas,
  and job persistence.

Do not force asynchronous Hermes work into a synchronous provider protocol if that
causes request timeouts or duplicate jobs. A dedicated durable job contract is the
correct extension.

## PawsMemories Integration

- The browser calls only the authenticated PawsMemories API.
- The PawsMemories server calls Layer8 with a tenant API key and owner-scoped
  idempotency key.
- PawsMemories stores no new Gemini/OpenAI key after migration; Layer8 owns those
  credentials.
- PawsMemories still validates every response and independently recomputes all
  Gemma math.
- PawsMemories calls Blender directly with its separate worker secret.
- Layer8 audit IDs are stored on the Paws attempt but do not replace local audit,
  credit, or lineage records.

## Acceptance Tests

- Invalid tenant, missing scope, unknown operation, unknown field, and foreign asset
  reference fail before any provider call.
- Each operation invokes only its pinned provider adapter.
- `spatial.math.v1` fails closed when Hermes/Pixel is unavailable; no other model is
  called.
- Duplicate idempotency keys return the same job/result and never double-submit.
- Private image operations do not enter the shared cache.
- If deterministic math caching is enabled, two tenants cannot share entries.
- Timeouts and provider failures return stable retryability and billing disposition.
- Audit records contain hashes and usage but no secret, prompt, image, signed URL,
  or raw response.
- Provider circuit opening does not reroute to a forbidden role.
- PawsMemories tests prove Blender and Tripo calls remain outside Layer8 and obey
  their existing lane boundaries.

Implement behind disabled service policies and the Paws
`INHOUSE_SPATIAL_GENERATOR_ENABLED=false` flag. Promote one operation at a time only
after contract, isolation, security, and live-provider evidence passes.
