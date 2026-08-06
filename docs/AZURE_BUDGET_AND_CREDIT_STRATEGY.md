# Azure Credit Budget & Strategy

**Date:** 2026-08-05
**Grant:** $5,000 unlocked of $150,000 · **expires 2027-05-01**
**Program:** Microsoft for Startups Founders Hub (entry tier)

---

## 1. The number that governs everything

```
$5,000 ÷ 21 months (2026-08-05 → 2027-05-01)  =  ~$238 / month
```

That's the real budget. Not $5,000 — **$238 a month**, and unspent credit does not
roll over past May 2027. It is use-it-or-lose-it.

**Your current burn is ~$78/month for two VMs doing nothing. That is 33% of the
entire monthly budget going to idle machines.** Deallocating them is the
single highest-return action available and takes an hour.

---

## 2. What the planned stack actually costs

Rough monthly estimates for the migration target:

| Service | Config | ~$/month |
|---|---|---|
| Container Apps — core app | 1 vCPU / 2 GB, always on | 35–50 |
| Azure Database for MySQL | B2s burstable | 30–45 |
| Blob Storage | ~70 GB incl. model bundle | 3–5 |
| Container Registry | Basic | 5 |
| Front Door / CDN | Standard | 35 |
| **Azure AI Search** | **Basic tier** | **~75** |
| AI model tokens | gpt-4o + mini, low volume | 20–50 |
| Speech TTS | low volume | 10–15 |
| Log Analytics | minimal retention | 5 |
| **Total** | | **~220–285** |

**That lands at or slightly over budget.** It fits, but with no slack — which
means the idle VMs genuinely have to go, and a couple of choices need care.

### The two line items to watch

**Azure AI Search Basic is ~$75/month — a third of your budget.** I recommended it
last round and I still think it's the right service, but **start on the Free tier**
(3 indexes, 50 MB). For an asset library with no users yet that is plenty, and it
costs nothing. Move to Basic when the index outgrows it, not before.

**Front Door at ~$35/month is premature.** It matters when GibiWorld is shipping
GLBs to mobile AR clients at volume. With no users, Blob's built-in HTTPS is fine.
Defer it.

Dropping both gets you to **~$110–165/month**, which is comfortable and leaves
room for the AI token spend to grow as the orchestration layer does real work.

---

## 3. GPU: the classification path is now concrete

Founders Hub is exactly the program that controls GPU access, which changes my
earlier advice from "uncertain" to "actionable":

> To unlock GPU SKUs, the subscription must be tagged as a **GPU Startup**. If it
> isn't, submit a request via the Founders Hub portal or your program
> representative with the subscription ID and a short workload justification.

That is a different action from the quota requests that have been auto-rejected.
Those failed because the subscription class doesn't expose N-series at all. The
classification request changes the class. **Worth submitting — it costs an email.**

### But do the math before you count on it

Even if granted, the credit cannot afford a standing GPU:

| Option | Rate | Monthly if always on |
|---|---|---|
| Azure A100 (if granted) | ~$1.07–1.49/hr | **$770–1,070** |
| Your entire monthly budget | — | **$238** |

**A single always-on A100 costs 3–4× your whole monthly credit.** At $238/month you
could afford roughly 160 hours of A100 or 530 hours of L40S — and only by spending
nothing else.

So the conclusion from the connector work stands, and is now reinforced by the
budget rather than just by the quota block: **RunPod serverless at ~$0.07/pet is
the correct answer regardless of whether Azure ever grants GPU quota.** Azure GPU
would be a convenience, never the economic choice at this scale.

Spend the credit on the things that must run continuously — app, database,
storage, AI orchestration — and buy GPU by the second from whoever is cheapest.

---

## 4. Unlocking more credit

You're at the entry tier. The published progression:

| Tier | Credit | Gate |
|---|---|---|
| Entry (**you are here**) | ~$1k–5k | business verification, self-serve |
| Growth | ~$25k | **demonstrated credit usage** + traction (paying customers, MAU, accelerator, fundraising) |
| Scale | $150k | investor backing or significant revenue |

Two things worth noting:

**"Demonstrated active usage" is a gate you can actually pass.** Consuming the $5k
on real workloads is itself evidence for the tier bump. Leaving it unspent is the
worst outcome — you lose the credit *and* the argument for more.

**The remaining gates are business milestones, not technical ones.** Paying
customers move you to Growth. Which means the fastest route to $25k of Azure credit
is shipping the thing and selling it — the same work that's already the priority.

---

## 5. Recommended sequence

| # | Action | Effect |
|---|---|---|
| 1 | **Deallocate both idle VMs** | recovers ~33% of monthly budget, 1 hour |
| 2 | Submit the **GPU Startup classification** request via Founders Hub | costs an email; upside is real, don't wait on it |
| 3 | Build the core platform: Container Apps + MySQL + Blob | ~$70–100/month |
| 4 | Azure AI Search on **Free** tier | $0 |
| 5 | Run TRELLIS.2 on **RunPod**, billed per second | ~$0.07/pet, off-credit |
| 6 | Defer Front Door until GibiWorld actually ships assets | saves $35/month |
| 7 | Set an Azure **budget alert at $200/month** | catches drift before it eats the runway |

The framing that matters: **$238/month is enough to run the whole platform, and
nowhere near enough to run a GPU.** Build accordingly — Azure for everything that
runs continuously, rented GPU by the second for the one step that needs it.
