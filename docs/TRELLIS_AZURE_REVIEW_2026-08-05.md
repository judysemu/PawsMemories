# TRELLIS / Azure GPU — Full Review
**Date:** 2026-08-05
**Account:** rob@stelar.host · Subscription `f7318c8c…` · RG `Trellis` (eastus)
**Scope:** Root-cause the A100 block, review the uncommitted TRELLIS work, assess the proposed GPU Worker Connector

---

## 1. Root cause — found, and it is terminal on this subscription

> **The subscription is a Sponsored subscription. Microsoft does not grant GPU quota to sponsorship subscriptions. No amount of quota requests, region rotation, or alternative Azure GPU surfaces will change this.**

### The evidence

```
az account subscription show
  quotaId:              Sponsored_2016-01-01     ← the blocker
  locationPlacementId:  Public_2014-09-01
  spendingLimit:        Off
  state:                Enabled
```

Every GPU family, every region tested (eastus, eastus2, westus2, westus3,
southcentralus, northcentralus):

```
Standard NCADS_A100_v4 Family vCPUs      0/0
Standard NCadsH100v5 Family vCPUs        0/0
Standard NDASv4_A100 Family vCPUs        0/0
Standard NCASv3_T4 Family vCPUs          0/0
… all 28 N-series families              0/0
```

**The limit is `0`, not "used up."** Compare against the non-GPU control in the
same region and subscription:

```
Standard DSv3 Family vCPUs               0/65     ← CPU quota is healthy
Total Regional vCPUs                    12/65     ← 53 vCPUs free
Total Regional Low-priority vCPUs        0/3      ← Spot capped at 3
```

CPU quota is fine. GPU quota is structurally zero. This is a **subscription-class
policy**, not capacity and not a misconfiguration.

Note the Spot line too: **3 low-priority vCPUs total.** `Standard_NC24ads_A100_v4`
needs **24**. Even if GPU quota were granted, the Spot lane cannot fit one A100.

### Every other Azure door is also zero

The multi-surface strategy in the proposal was tested directly:

```
Microsoft.App / locations/eastus/usages
  SubscriptionDedicatedNCA100Gpus        0/0
  ManagedEnvironmentCount                0/0     ← cannot even create an environment
```

And the providers the strategy depends on are not registered:

```
Microsoft.App                     NotRegistered
Microsoft.Batch                   NotRegistered
Microsoft.ContainerService        NotRegistered
Microsoft.MachineLearningServices NotRegistered
```

Registering them will not help — quota is assigned by subscription class, and
Azure ML GPU families start at zero by design on top of that.

### There is no alternative subscription

```
az account list --all
Name                  State
Azure subscription 1  Enabled      ← exactly one
```

The handoff ledger references "Alternative 1" and "Alternative 2" subscriptions
and records two `AADSTS50020` failures trying to reach them. Those subscriptions
are **not accessible from this account** — they are cached discovery records
against organizational tenants that this identity cannot sign into. Two failed
attempts already; a third will fail identically.

### Corroboration

Microsoft's own support forums are unambiguous — sponsorship, Founders Hub, and
startup-benefit subscriptions are excluded from GPU quota, and requests are
auto-rejected with generic messaging. See
[Repeated GPU Quota Rejection for Azure Sponsorship Startup Subscription](https://learn.microsoft.com/en-au/answers/questions/5793131/repeated-gpu-quota-rejection-for-azure-sponsorship)
and [How to get GPU access on Azure startup subscriptions](https://learn.microsoft.com/en-us/answers/questions/5584200/how-to-get-gpu-access-on-azure-startup-subscriptio).

### The only two things that can unblock Azure

1. **A true Pay-As-You-Go subscription with a real payment method**, created
   independently of the sponsorship enrolment. Then request N-series quota
   normally. This works and is well-documented.
2. **A "GPU Startup" classification** applied to the sponsorship via Microsoft
   for Startups Founders Hub. This is a request to a program manager, not a
   self-service quota ticket. Outcome uncertain, timeline unbounded.

The existing handoff's next action — one Microsoft for Startups Program Support
case — is a reasonable **parallel** track. It must not be the critical path.

---

## 2. Assessment of the egress-only GPU Worker Connector proposal

**The architecture is right. The scoping is wrong.**

### What's right

Inverting to outbound-only pull workers is genuinely good design and I'd endorse
it independent of Azure:

- No public inbound port on the GPU host — removes a whole attack surface
- Core keeps credits, jobs, assets, policy and final validation
- Workers become replaceable cattle
- Attestation-gated enrolment (image digest, git revision, model manifest hash,
  CUDA presence, Blender revision, strict in-house mode, GLB hash) is exactly the
  right acceptance boundary, and the existing `preflightForCharge()` already
  implements most of it

### What's wrong

> The proposal makes the worker contract portable across **Azure GPU doors**.
> Every Azure GPU door on this subscription is **0/0**.

Making a contract portable across six locked doors does not open any of them.
The design "breaks the current deadlock" only if some Azure surface has quota —
and none does, for the reason in §1.

### The reframe that makes it correct

The connector's value is **portability across compute providers, not across
Azure surfaces.** If the core accepts any runner that proves it is the locked
TRELLIS/Blender runtime, then it should equally accept:

- Modal / RunPod / fal / Lambda (serverless GPU, available today, no quota process)
- A rented bare-metal 4090/A100
- A future Azure VM/Batch/AML/ACA runner, if quota ever lands
- A local workstation GPU for development

The attestation contract does not care where the GPU lives. **Written that way,
the connector stops being a way to keep waiting for Azure and becomes the way to
stop waiting for Azure** — while preserving Azure as a first-class target for the
day quota arrives.

That is a one-line change to the spec's framing and a significant change to what
it unblocks. I'd build it, and I'd point it at Modal first.

### One cost finding that should change the plan regardless

The handoff records that the Container Apps design is fixed at
`minReplicas=1, maxReplicas=1`, and explicitly warns it "must not be called
scale-to-zero," because in-process jobs and SQLite recovery are unsafe across
replica shutdown.

**That means a continuously allocated, continuously billed A100.** At market
rates that is roughly **$2,500–5,000/month** for a service generating a handful
of pets a day.

Compare the serverless estimate from `TRELLIS2_IMPLEMENTATION_PLAN.md`:
**~$0.07–0.10 per model.**

At your volume the Azure design as currently drawn is worse by orders of
magnitude — and the reason is architectural, not vendor-specific: **in-process
job state plus SQLite makes scale-to-zero unsafe.** A durable external queue with
restart-safe leased job ownership (already named in the handoff as a
prerequisite) is what makes *any* serverless GPU host viable, Azure or not.

**That queue is the highest-value piece of infrastructure in this whole effort.**
It should be built before, not after, the next GPU procurement attempt.

---

## 3. Code review — the uncommitted work

**Verdict: high quality. Keep it. Commit it.**

26 modified files, 18 untracked, ~936 insertions on `main`, uncommitted since
checkpoint `3fd008e`.

**Test status: 48/48 passing** across `trellis_provider`, `trellis_model_lock`,
`inhouse_external_generation_boundary`, `inhouse_e2e_harness`, and all four
`infra/azure/tests` suites — after the one fix in §3.2.

### 3.1 What's genuinely good

**`trellisProvider.ts` — the attestation gate.** `preflightForCharge()` now
verifies CUDA, model presence, model load, **model bundle verification**, exact
model revision, exact source revision, runtime repository revision, Blender
readiness, bridge connection, Blender version and Blender revision — each with a
distinct error code, and each failing closed. This is already ~80% of the
worker-attestation contract the connector proposal asks for. **The proposal
should extend this, not replace it.**

Preflight is also correctly re-invoked immediately before `start()` and
`startFinalization()`, so a worker can't drift between the readiness check and
the charge.

**`wiring.ts` — two real bug fixes:**

- `loadRigProfileJoints()` previously read a non-existent `bonemap.json` and
  **returned `[]` on failure**, silently degrading rig coverage to UNMEASURED.
  It now reads the pinned `quadruped.dog.medium.json` profile and throws
  `RIG_PROFILE_UNAVAILABLE`. Correct — this is the same class of defect as the
  Tripo PBR flag: a silent fallback masking a missing input.
- `signDurableReferenceManifest()` binds references to exact
  `asset://{uuid}/versions/{n}` and verifies owner and lineage before signing.
  Closes a real gap where reference provenance wasn't pinned.

**The E2E harness** (`scripts/run-inhouse-e2e.mjs`, 476 lines) is honest work: it
proves the loopback path, asserts nine private calls / zero external calls,
verifies secret and worker-origin redaction, and fails closed on a revision
outside the committed lock. The handoff correctly labels it "executable contract
proof with a simulated private worker, **not live CUDA/TRELLIS model evidence.**"
That distinction is stated plainly and repeatedly — good discipline.

### 3.2 The one failure, and why I changed the test not the script

`infra/azure/tests/gpu-runtime-artifacts.test.mjs` asserted the restore script
contained a jq format check:

```js
assert.match(script, /\.sha256 \| test\("\^\[a-f0-9\]\{64\}\$"\)/);
```

The script no longer does that. It does something **stronger**: the locked hash
is shape-validated in bash (`^[a-f0-9]{64}$`, plus `^sha256:[a-f0-9]{64}$` for
the image id) and then the manifest is checked by **exact equality**
(`.sha256 == $sha256`) along with imageRef, buildRevision, repositoryRevision,
archive name, byte count and image id. Then the downloaded archive's real byte
count and real sha256 are verified, and after `docker load` the actual image id
from `docker image inspect` is compared to the locked value.

A well-formed but wrong hash passes a format test and fails an equality test.
**The implementation is better than the assertion.** I updated the test to assert
the actual, stronger property and left a comment explaining why the weaker
assertion must not be restored.

I want to be explicit that this is the *opposite* of what I did to the Tripo test
yesterday. There, the test encoded a live bug and the code was wrong. Here the
test encoded a superseded implementation and the code is right. I verified the
security property holds by reading the script before touching the test.

### 3.3 Nits worth fixing before commit

**Check ordering in `preflightForCharge()`.** `!response.ok` moved from the first
condition to the last. The body of a non-200 response is now parsed and evaluated
against every attestation gate before HTTP status is considered. In practice a
500 body lacks those fields so it throws `TRELLIS_WORKER_NOT_READY`, and the final
check does catch it — but status should be validated before trusting the body.
Low severity, easy fix.

**Ledger-to-outcome ratio.** `handoff.md` gained ~166 lines of PASS/FAIL entries
in this session. The audit discipline is real and valuable, but the ledger now
substantially exceeds the code, and it records a great deal of local
compile/syntax validation as "PASS" against a goal — live TRELLIS inference — that
has still never run once. Compile-clean Bicep for an environment that cannot be
created is not progress toward the goal. Worth recalibrating what gets a ledger
entry.

### 3.4 Recommendation

Commit this work now, on a branch. It is green, it is coherent, and leaving ~936
lines uncommitted on `main` across two sessions is its own risk — especially given
the earlier note that `git stash pop` is broken on this FUSE mount.

---

## 4. What I'd do next, in order

| # | Action | Why |
|---|---|---|
| 1 | **Commit the uncommitted work** to `feat/inhouse-trellis-attestation` | 48/48 green, protects ~936 lines |
| 2 | **Stop all Azure GPU quota activity** | Root cause is subscription class; further requests are auto-rejected. Zero expected value. |
| 3 | **Create a real Pay-As-You-Go subscription** with a payment method, or **request GPU Startup classification** via Founders Hub | The only two things that can unblock Azure |
| 4 | **Rescope the connector spec to be provider-agnostic**, not Azure-surface-agnostic | Turns it from waiting-on-Azure into not-waiting-on-Azure |
| 5 | **Build the durable job queue + leased ownership** | Prerequisite for scale-to-zero anywhere; the pinned-replica A100 design costs orders of magnitude more than serverless |
| 6 | **Stand up one Modal worker** against the connector contract | Proves live TRELLIS inference this week instead of pending a quota decision |
| 7 | Keep Azure as a registered target for when quota lands | The attestation contract already supports it |

The single most useful sentence in this review: **the connector is a good idea
pointed at the wrong problem.** Point it at any GPU anywhere, and you get real
inference in days instead of waiting on a quota decision that the subscription
class has already predetermined.

---

## Sources

- [Azure Sponsorship GPU quota rejection](https://learn.microsoft.com/en-au/answers/questions/5793131/repeated-gpu-quota-rejection-for-azure-sponsorship)
- [GPU access on Azure startup subscriptions](https://learn.microsoft.com/en-us/answers/questions/5584200/how-to-get-gpu-access-on-azure-startup-subscriptio)
- [Creating a subscription that can access GPU compute](https://learn.microsoft.com/en-ie/answers/questions/5841293/creating-a-subscription-that-can-access-gpu-comput)
- [Container Apps serverless GPU overview](https://learn.microsoft.com/en-us/azure/container-apps/gpu-serverless-overview)
- [Azure ML quota management](https://learn.microsoft.com/en-us/azure/machine-learning/how-to-manage-quotas?view=azureml-api-2)
