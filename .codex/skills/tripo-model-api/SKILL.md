---
name: tripo-model-api
description: Implement, review, or debug Pawsome3D's Tripo model-generation boundary. Use for image/text/multiview-to-model tasks, file upload or STS objects, task polling/streaming, model-version selection, rigging, ephemeral output mirroring, rate limits, billing/refunds, provider handles, and proving Tripo isolation from the in-house accessory generator.
---

# Tripo Model API

Read current official docs before changing request fields or model versions:

- https://platform.tripo3d.ai/docs/generation
- https://platform.tripo3d.ai/docs/task
- https://platform.tripo3d.ai/docs/schema
- https://platform.tripo3d.ai/docs/changelog
- https://platform.tripo3d.ai/docs/billing

The API is versioned and changes frequently. This skill defines integration rules,
not permanent model/pricing constants.

## Provider Boundary

Tripo remains the organic pet/human reconstruction provider. The in-house
accessory/hard-surface lane must make zero Tripo calls. Never silently switch lanes
after credits are reserved or after a job receives a provider handle.

## Current Task Pattern

- Create: `POST https://api.tripo3d.ai/v2/openapi/task` with Bearer API key.
- Poll: `GET /v2/openapi/task/:task_id` using the same API key that created it.
- Persist the returned task ID before polling.
- Handle `queued`, `running`, `success`, `failed`, and `banned` explicitly.
- Treat undocumented output fields as non-contractual.
- Mirror successful output into owned durable storage immediately; provider download
  links may expire.

## Inputs

- Prefer Tripo STS/object upload for private inputs when supported.
- Do not pass arbitrary user-controlled remote URLs without the repository's safe
  fetch and ownership controls.
- Image inputs support JPEG/PNG and provider size limits, but local decoding and
  stricter application limits must run first.
- Multiview order is exactly front, left, back, right. Front is required; official
  docs require at least two supplied views.
- `files` and multiview `original_task_id` are mutually exclusive.

## Model Selection

As of the current official docs, generation includes P1, v3.1, v3.0, v2.5, and
older versions with different topology/quality roles. Do not replace the configured
production model from a changelog alone. Evaluate known pet/human fixtures for
silhouette, texture, topology, riggability, download size, latency, and cost.

The official changelog reports animate-rig `v2.0-20250506` deprecated in favor of
`v2.5-20260210`. Audit configured rig versions before the next rigging deployment;
change only with fixture evidence and rollback support.

## Durable Execution

1. Validate owned canonical inputs and provider parameters.
2. Reserve credits atomically with an idempotency key.
3. Submit once and persist the handle in the same durable workflow.
4. If submission succeeds but persistence fails, enter `recovery_required`; do not
   refund and resubmit blindly.
5. Poll only through a valid lease; reject stale/replaced/completed work.
6. Mirror output, validate GLB, and register immutable lineage.
7. Refund exactly once on eligible pre-delivery failure.

## Errors And Limits

- Treat HTTP 429/provider code 2000 as retryable with bounded backoff and jitter.
- Treat task-not-found as terminal unless key mismatch or recovery evidence proves
  otherwise.
- Surface banned/content-policy states truthfully and without retry loops.
- Sanitize logs: task ID and status are allowed; API keys, input URLs, provider
  response bodies, and output signed URLs are not.

## Verification

- Polling uses the same key and the exact persisted handle.
- Output is mirrored before storing a durable model URL.
- GLB header, size, bounds, finite transforms, topology, and standard renders pass.
- Rigging/facial capability is measured after generation, never inferred from task
  success.
- Tests assert zero provider calls on validation/auth/balance/idempotency failures.
- In-house accessory tests assert zero calls to every Tripo function.

## Review Checklist

- [ ] Official docs/changelog checked and review date recorded.
- [ ] Model and rig versions are configurable, not scattered literals.
- [ ] Request fields match the selected model's supported parameters.
- [ ] Multiview order and minimum-view rules are enforced.
- [ ] Provider handles, leases, mirror, validation, and refunds are durable.
- [ ] Expiring output URLs never become canonical application URLs.
- [ ] Tripo and in-house generator roles remain explicit in UI, pricing, and logs.
