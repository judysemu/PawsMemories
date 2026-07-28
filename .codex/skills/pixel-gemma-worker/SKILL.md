---
name: pixel-gemma-worker
description: Build, secure, deploy, or debug the always-on Pixel worker that leases spatial_math jobs from the Hermes VPS and runs local Gemma. Use for Android/Termux foreground execution, outbound worker connections, leases, heartbeats, reconnects, worker health, token rotation, and fail-closed mobile availability.
---

# Pixel Gemma Worker

Read `INHOUSE_SPATIAL_GENERATOR_ARCHITECTURE.md` and SPAT-002 before editing.

## Role

The Pixel is the dedicated `spatial_math` inference worker. It does not run Gemini,
GPT, Blender, storage, billing, or public APIs. It opens an outbound authenticated
connection to Hermes; it is never directly exposed to Hostinger or the internet.

## Required Workflow

1. Verify the local inference endpoint is bound to loopback only.
2. Verify the installed model identity through the runner's model-inspection API;
   do not trust a UI label.
3. Connect to the Hermes WSS worker endpoint with a Pixel-specific Bearer token.
4. Advertise protocol version, `spatial_math.v1`, exact model, and concurrency 1.
5. Claim one leased job and validate its strict request schema.
6. Send a heartbeat every 15 seconds while inference runs.
7. Call local Gemma with temperature 0 and the complete JSON schema.
8. Parse and validate the result before transmission.
9. Complete using the same job ID and lease token, or release/fail with a stable
   sanitized code.
10. Reconnect with capped exponential backoff and jitter.

## Lease Rules

- Initial lease: 60 seconds.
- Heartbeat extends only the active matching lease.
- Hermes rejects expired, duplicate, replaced, foreign, and late lease results.
- One retry lease is allowed; the second worker failure closes the math stage.
- A disconnect must not cause GPT/Gemini fallback or a duplicate completion.

## Always-On Android Rules

- Use a foreground service or Termux session with `termux-wake-lock`.
- Disable battery optimization for the worker application.
- Start on boot using the app's boot receiver or Termux:Boot.
- Supervise inference and worker processes independently; restart with backoff.
- Prefer external power and Wi-Fi, but tolerate network changes and reconnect.
- Stop claiming work below the configured battery threshold or above the thermal
  threshold. Finish or safely release the current lease.
- Report last heartbeat, model loaded, active lease, battery band, and thermal band
  to Hermes health. Do not expose personal device details publicly.

Android cannot guarantee server availability. `MATH_WORKER_UNAVAILABLE` is a normal,
safe state and must remain retryable without charging the user.

## Security

- Separate Pixel worker token from Hermes producer and Blender secrets.
- Never send API keys, user identity, image data, signed URLs, or GPT reasoning to
  the Pixel.
- Never expose ADB, debug ports, or unauthenticated LAN inference.
- Redact prompts and model output bodies from logs; retain hashes/timings only.
- Rotate a compromised Pixel token without changing other service secrets.

## Required Tests

- Valid hello, claim, heartbeat, complete.
- Wrong capability/model/protocol rejected.
- Expired/replaced/foreign lease result rejected.
- Disconnect, reconnect, duplicate completion, and late result.
- Invalid Gemma JSON/schema rejected locally and by Hostinger.
- Worker stops claiming on thermal/battery guard.
- Pixel unavailable produces no fallback provider call and no charge.

## Exit Evidence

Record worker version, exact model identifier/quantization, measured cold/warm
latency, lease recovery traces, token redaction, and a successful known-math fixture.
