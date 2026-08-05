# GPU Worker Connector — Provider-Agnostic Egress-Only Runners

**Status:** Specification + attestation validator implemented. No runner deployed.
**Date:** 2026-08-05
**Supersedes:** the Azure-scoped connector sketch in `handoff.md`

---

## 1. Purpose

Let the Paws core accept **any** GPU runner, on **any** provider, that proves it is
the exact locked TRELLIS/Blender runtime — and refuse everything else.

The original proposal scoped this across *Azure GPU doors* (VM, VMSS, Batch, Azure
ML, Container Apps, AKS, Arc). Per `TRELLIS_AZURE_REVIEW_2026-08-05.md`, every one
of those doors reads `0/0` on this subscription because it is a **Sponsored**
subscription, which Microsoft excludes from GPU quota. Portability across six
locked doors opens none of them.

So the axis of portability changes: **not "which Azure surface", but "which
provider."** The core does not care where the GPU lives. It cares that the runner
can prove what it is.

| | Old scope | This spec |
|---|---|---|
| Portable across | Azure surfaces | **Any provider** |
| Unblocks today | nothing (all 0/0) | Modal, RunPod, Vast, Lambda, bare metal, local |
| Azure | the only target | *a* target, for when quota lands |

Nothing about the attestation contract is provider-specific. Azure remains
first-class the day a Pay-As-You-Go subscription exists.

---

## 2. Design

### 2.1 Inversion: pull, not push

Today the core pushes to the worker: `POST {workerUrl}/v1/jobs`. That requires the
worker to have a reachable address and an inbound port, which is why the current
design needs private VNets, NSGs, exact `/32` allowlists, and an Azure-shaped
network.

The connector inverts it. **Workers dial home. The core never dials out.**

```
      ┌──────────────────────────────┐
      │   PAWS CORE (orchestrator)   │   credits · jobs · assets
      │   public HTTPS, authenticated│   policy · final validation
      └──────────────┬───────────────┘
                     ▲  outbound HTTPS only (443)
        ┌────────────┼────────────┬─────────────┐
        │            │            │             │
   ┌────┴────┐  ┌────┴────┐  ┌────┴────┐  ┌────┴────┐
   │ Modal   │  │ RunPod  │  │ bare    │  │ Azure   │
   │ runner  │  │ runner  │  │ metal   │  │ (later) │
   └─────────┘  └─────────┘  └─────────┘  └─────────┘
```

Consequences, all good:

- **No inbound port on any GPU host.** Removes NSGs, public IPs, `/32` allowlists,
  and the entire SSRF surface from the GPU side.
- **Provider-neutral networking.** Every provider on earth permits outbound 443.
- **Workers are cattle.** Preemption/Spot reclaim is a lease expiry, not an outage.
- **Local development works identically** to production.

### 2.2 What stays in the core

Unchanged and non-negotiable: credit reservation and refund, job state machine,
asset registry and lineage, pricing, the approval flow, **and final artifact
validation.** A worker's own claim that its output is good is never sufficient —
the core re-validates the GLB it received.

---

## 3. Attestation contract

A runner is admitted only if **every** claim below is present and exactly matches
core-side policy. Any mismatch is a hard refusal, never a warning.

| Claim | Field | Rule |
|---|---|---|
| Container image digest | `imageDigest` | `sha256:<64 hex>`, exact match to runtime lock |
| Image reference | `imageRef` | exact match to runtime lock |
| Repository revision | `repositoryRevision` | 40-hex lowercase, exact match |
| TRELLIS source revision | `trellisSourceRevision` | 40-hex, exact match to model lock |
| TRELLIS model revision | `trellisModelRevision` | 40-hex, exact match |
| Model manifest hash | `modelManifestSha256` | 64-hex, exact match to model lock |
| Model bundle verified | `modelBundleVerified` | `true` |
| CUDA present | `cuda.available` | `true` |
| GPU VRAM | `cuda.totalVramBytes` | **≥ 24 GiB** (TRELLIS.2 floor) |
| Blender version | `blender.version` | exact match to pin |
| Blender revision | `blender.revision` | 40-hex, exact match |
| Blender bridge | `blender.bridgeConnected` | `true` |
| Strict in-house mode | `strictInHouseMode` | `true` |
| No external generator | `externalGeneratorsDisabled` | `true` |
| Network policy | `runtimeNetworkPolicy` | `"offline"` |
| Clock skew | `attestedAt` | within ±300s of core time |
| Nonce | `nonce` | matches the core-issued challenge; single use |
| Signature | `signature` | HMAC-SHA256 over the canonical payload |

### 3.1 Why a nonce and a signature

A shared secret alone proves the runner knows a password. It does not prove the
attestation is *fresh*. Without a nonce, a captured payload from a correctly-built
worker can be replayed by a differently-built one.

So enrollment is two-step: the core issues a single-use nonce, the runner signs the
full attestation **including that nonce** with the enrollment secret, and the core
verifies the HMAC in constant time and burns the nonce.

### 3.2 Provider identity is metadata, never trust

`provider`, `region`, and `instanceType` are recorded for cost attribution and
debugging. **They are never inputs to the admission decision.** A worker on a
laptop and a worker on an H100 in Azure are admitted by identical rules. This is
what makes the connector portable.

---

## 4. Protocol

All endpoints are core-side, HTTPS, authenticated. Worker → core only.

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/gpu-workers/challenge` | POST | Issue single-use nonce |
| `/v1/gpu-workers/enroll` | POST | Submit signed attestation → worker token + TTL |
| `/v1/gpu-workers/heartbeat` | POST | Liveness + current lease renewal |
| `/v1/gpu-workers/claim` | POST | Long-poll for one job; returns a lease |
| `/v1/gpu-workers/lease/{id}/progress` | POST | Progress 0–100 |
| `/v1/gpu-workers/lease/{id}/complete` | POST | Signed completion report + artifact hashes |
| `/v1/gpu-workers/lease/{id}/fail` | POST | Structured failure; releases lease |

### 4.1 Lease semantics — this is the part that matters

Every claimed job carries a **lease** with a hard expiry. The worker must renew via
heartbeat. If the lease expires — Spot reclaim, crash, network partition, provider
eviction — the core **returns the job to the queue** and the credit reservation
stays intact.

This is what makes Spot and preemptible instances safe, and it is the same
mechanism that makes scale-to-zero safe. The `TRELLIS_AZURE_REVIEW` flagged that
the Azure Container Apps design had to pin `minReplicas=1` precisely because
in-process job state plus SQLite could not survive a replica shutdown — that pin is
what turns a $0.07 job into a continuously billed A100.

> **Durable leased job ownership is the single highest-value component here.** It
> is what lets you use the cheapest compute on the market — Spot, preemptible,
> scale-to-zero — without risking a customer's paid job.

At-least-once delivery, idempotent completion keyed on `(jobId, attemptUuid)`.

### 4.2 Artifacts

Workers upload directly to private object storage using a **short-lived scoped
credential issued per lease**, then report content hashes. Artifact bytes never
transit the core. The core independently re-downloads and re-validates before any
customer-visible state changes.

---

## 5. Provider recommendations

TRELLIS.2 requires **≥24GB VRAM, Linux, CUDA 12.4**. That is the only hard
constraint. Note that 24GB is the documented floor and community reports show RTX
4090s occasionally OOM at it — treat 24GB as "works for dev", 48GB as "comfortable
for production".

### 5.1 Current market rates

| GPU | VRAM | Provider / mode | ~Rate | Notes |
|---|---|---|---|---|
| **L40S** | 48GB | on-demand, specialist hosts | **$0.39–0.48/hr** | best $/VRAM on the market |
| RTX 4090 | 24GB | RunPod **Community** | $0.34/hr | cheapest; at the OOM edge |
| RTX 4090 | 24GB | RunPod Secure | $0.69/hr | datacenter-backed |
| A100 80GB | 80GB | Vast.ai marketplace | $0.50–0.80/hr | cheap end = unverified hosts |
| A100 80GB | 80GB | Spheron on-demand | $1.07/hr | |
| A100 SXM | 80GB | RunPod Secure | $1.49/hr | |
| A100 | 80GB | **Modal serverless** | ~$2.50/hr | per-second, scale-to-zero |
| A100 | 80GB | RunPod Serverless | ~$2.72/hr | per-ms |
| H100 | 80GB | Modal serverless | ~$3.95/hr | fastest: 1024³ in ~17s |
| H100 | 80GB | RunPod Serverless | ~$4.55/hr | |

### 5.2 Cost per pet

At 1024³. Assume ~17s inference on H100, ~40s on L40S, plus post-processing and
cold start.

| Setup | Billed/job | **Cost per pet** |
|---|---|---|
| L40S dedicated @ $0.45/hr | ~90s | **~$0.011** |
| RunPod Community 4090 @ $0.34/hr | ~120s | **~$0.011** |
| Modal serverless H100 | ~60s | **~$0.066** |
| RunPod Serverless A100 | ~90s | **~$0.068** |
| **Azure ACA pinned A100** | — | **billed continuously** |

Dedicated is ~6× cheaper *per job* but bills while idle. A dedicated L40S at
$0.45/hr is **~$324/month**. Against Modal at ~$0.07/pet, the crossover is roughly
**4,600 pets/month (~150/day)**.

You are nowhere near that. **Serverless wins today by a wide margin.**

### 5.3 What I'd actually do

**Now — dev and the Phase 0 quality gate: RunPod Community, L40S or RTX 4090
on-demand pod.** ~$0.35–0.45/hr, started and stopped by hand. Running the 5-pet
quality gate costs **well under a dollar**. Best possible ratio of "real CUDA
TRELLIS output" to money and setup time. This is the fastest route to the live
inference that has never yet run.

**Production — Modal serverless.** Scale-to-zero, per-second billing, Python-native
(the TRELLIS CUDA build is fragile and Modal's image build model handles it best),
and cold start is manageable with weights baked into the image plus memory
snapshotting. ~$0.07/pet at your volume. **Recommended default.**

**At volume (>150/day) — dedicated L40S 48GB.** Best $/VRAM available. Revisit
only when the numbers say so.

**Vast.ai — experiments only, not production.** The headline A100 rates are real
but the cheap listings are unverified hosts. Fine for a one-off benchmark, wrong
for customer jobs. Notably, the lease model in §4.1 makes even this *safe* — a
vanished host is an expired lease and a requeued job — but "safe" is not "reliable".

**Azure — keep the target, don't wait for it.** Register it as a provider when a
real PAYG subscription exists. Nothing in this spec needs to change.

### 5.4 Why this ordering

Every option above is unblocked **today** and none requires a quota decision. The
connector's whole point is that the answer to "which provider" stops being an
architectural question and becomes a line in a config table.

---

## 6. Security properties

- **No inbound GPU port.** Outbound 443 only.
- **Replay-resistant enrollment.** Single-use nonce + HMAC over canonical payload.
- **Constant-time signature comparison.** No timing oracle on the secret.
- **Fail-closed.** Missing field = refusal. Unknown field = refusal. No defaults
  that admit.
- **Redaction.** Secrets, tokens and worker origins never enter logs or reports —
  preserved from the existing `trellis_provider` contract.
- **Core-side re-validation.** Worker completion reports are evidence, not
  authority.
- **Least privilege artifacts.** Per-lease, short-lived, scoped upload credentials.

---

## 7. Relationship to existing code

This extends rather than replaces. `preflightForCharge()` in
`server/model-builds/trellisProvider.ts` already verifies CUDA, model presence,
model load, bundle verification, model/source revisions, runtime repository
revision, and Blender readiness/version/revision — roughly 80% of §3.

`server/gpu-workers/attestation.ts` factors those rules into a **pure, provider-
agnostic validator** usable by both the existing push path and the new pull path.
It performs no I/O, which is what makes it exhaustively testable.

Implemented in this change:

- `docs/GPU_WORKER_CONNECTOR.md` — this document
- `server/gpu-workers/attestation.ts` — validator + policy loading + HMAC
- `tests/gpu_worker_attestation.test.mjs` — proves refusal on every violation

Deliberately **not** implemented yet: the HTTP endpoints, the durable queue and
lease store, and the worker-side agent. Those need the queue design settled first
(§4.1), and none of it should be built before the Phase 0 quality gate says
TRELLIS.2 is actually better on pets.

---

## 8. Next steps

| # | Step | Blocked by |
|---|---|---|
| 1 | **Phase 0 quality gate on RunPod Community** — 5 real pets, <$1 | nothing |
| 2 | Durable job queue + lease store (schema + repo) | nothing |
| 3 | Core HTTP endpoints from §4 | step 2 |
| 4 | Worker agent (claim/heartbeat/complete loop) | step 3 |
| 5 | Modal deployment of the runner | step 4 |
| 6 | Register Azure as a provider | a real PAYG subscription |

Step 1 requires none of the rest of this and should happen first.

---

## Sources

- [RunPod vs Vast.ai 2026](https://www.spheron.network/blog/runpod-vs-vastai-2026/)
- [Cheapest L40S cloud GPU prices](https://gpucloudprices.com/gpu/l40s/)
- [GPU cloud pricing comparison 2026](https://www.spheron.network/blog/gpu-cloud-pricing-comparison-2026/)
- [Cheapest cloud GPU providers](https://northflank.com/blog/cheapest-cloud-gpu-providers)
- [TRELLIS.2 requirements](https://huggingface.co/microsoft/TRELLIS.2-4B)
