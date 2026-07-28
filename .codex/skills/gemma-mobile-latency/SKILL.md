---
name: gemma-mobile-latency
description: Measure and reduce Gemma spatial-math latency on a Pixel-class Android device without weakening schema or math validation. Use for model/quantization selection, Ollama-compatible settings, context and output budgets, warm loading, thermal controls, benchmarking, timeout selection, and diagnosing slow local inference.
---

# Gemma Mobile Latency

Apply with SPAT-001. The expected official Ollama model family is `gemma3:4b`,
approximately 4.3B parameters; a device UI may round or label it differently.
Inspect the actual installed model and digest before configuration.

Official references:

- https://ollama.com/library/gemma3
- https://docs.ollama.com/api/chat
- https://docs.ollama.com/capabilities/structured-outputs

## Measurement First

Benchmark the exact Pixel, runner, model, quantization, context, and prompt. Capture:

- model load duration
- prompt-evaluation tokens and duration
- generated tokens and duration
- cold and warm end-to-end latency
- tokens per second
- peak memory
- battery and thermal band
- schema-valid response rate

Run at least 10 warm fixtures plus 3 cold starts. Report p50, p95, and worst case.
Do not quote desktop/GPU benchmarks as Pixel evidence.

## Latency Controls

Use in this order:

1. Keep the model loaded during the enabled worker window using bounded `keep_alive`.
2. Use one concurrent inference. Parallel jobs increase memory pressure and thermal
   throttling.
3. Send text-only math payloads. Gemini handles images elsewhere.
4. Keep context near the actual need, initially 4K-8K, not the model maximum.
5. Remove prose and duplicated schema explanations; send compact normalized plans.
6. Cap output to the exact number of primitives plus bounded calculation lines.
7. Use temperature 0 and JSON-schema constrained output.
8. Prefer a measured 4-bit quantization that fits with headroom. Record the exact
   quantization; never infer it from the model name.
9. Prewarm after boot and after runner restart with a tiny schema fixture.
10. Stop accepting jobs during severe thermal throttling instead of producing
    unpredictable multi-minute latency.

Do not reduce schema strictness, omit plan hashes, drop calculation fields, or skip
deterministic verification to improve speed.

## Prompt Budget

- Include plan hash, envelope, minimum wall, primitive rows, and constraints only.
- Use stable short property names only if the shared versioned schema defines them.
- Never include source images, observation prose, GPT reasoning, user identity, or
  previous unrelated attempts.
- Keep calculation explanations short and machine-checkable.

## Timeout Policy

Set `OLLAMA_TIMEOUT_MS` and Hermes leases from measured p95 plus operational margin.
The initial architecture budget is 120 seconds inference and 180 seconds total math
stage, but measured Pixel evidence may require adjustment. Heartbeats must continue
through the full inference; the HTTP timeout must not outlive a lost lease.

## Model Selection

- Start with the installed Gemma 3 4B-class model.
- Compare quantizations only against the frozen math fixture set.
- A smaller/faster model is acceptable only if every arithmetic/schema/adversarial
  fixture still passes.
- A larger model is unacceptable when it causes memory pressure, instability, or
  thermal failure despite slightly better prose.
- The server remains the arithmetic authority, so prioritize schema reliability and
  bounded latency over explanatory quality.

## Failure Diagnosis

- Slow first job only: model cold-load; prewarm and extend keep-alive.
- Slow prompt evaluation: context too large or schema duplicated.
- Slow generation: output budget/prose too large or thermal throttling.
- Process killed: memory pressure or Android battery management.
- Valid JSON but wrong math: do not tune temperature upward; inspect prompt/schema
  and keep deterministic rejection.
- Random disconnects: fix worker supervision/network transition handling, not model
  parameters.

## Acceptance

Publish the benchmark matrix, chosen digest/quantization, p50/p95, valid-schema rate,
thermal behavior, and the reason for every changed timeout.
