# Azure Migration + AI Orchestration — Feasibility and Plan

**Date:** 2026-08-05
**Subscription:** `f7318c8c…` (Sponsored) · RG `Trellis` · eastus
**Basis:** live inspection of model catalogue and quota, not documentation

---

## 1. The headline

**Yes — you can run almost the entire pipeline on Azure without a GPU. Two things
cannot come, and you need to know which before you commit.**

The critical discovery: **AI model inference quota is a completely separate
system from GPU VM quota.** Your GPU quota is 0/0 everywhere because the
subscription is Sponsored. But your AI model quota is **not** zero:

```
Tokens Per Minute (thousands) - gpt-4o              0 / 150      ✅
Tokens Per Minute (thousands) - GPT-4o-mini         0 / 450      ✅
Tokens Per Minute (thousands) - GPT-4-Turbo         0 / 80       ✅
Tokens Per Minute (thousands) - text-embedding-3-small 0 / 1000  ✅
Capacity Unit - Dalle                               0 / 2        ✅
Thousand Tokens Per Minute - o4-mini - GlobalStandard 0 / 100    ✅
```

You already have an `AIServices` account provisioned — `modelmaker` in the
`Trellis` RG, endpoint `https://modelmaker.cognitiveservices.azure.com/`, SKU S0
— with **zero models deployed**. The door is open and nobody has walked through
it.

---

## 2. The catch: GlobalStandard is zeroed, Standard is not

Same sponsorship pattern as the GPUs, one level down:

| Deployment type | Status |
|---|---|
| **Standard** (regional) | ✅ **granted** — gpt-4o 150k, gpt-4o-mini 450k, gpt-4-turbo 80k |
| **GlobalStandard** (shared pool) | ❌ **0 across the board** |

```
gpt-4o - GlobalStandard              0 / 0    ❌
gpt-4o-mini - GlobalStandard         0 / 0    ❌
o3 - GlobalStandard                  0 / 0    ❌
4.1 - GlobalStandard                 0 / 0    ❌
text-embedding-3-large               0 / 0    ❌
```

**This matters enormously, because most of the newest models are
GlobalStandard-only.** Every `gpt-5.x` variant except one, and the entire
`MAI-Image` family, list *only* GlobalStandard as an available SKU. If the SKU is
GlobalStandard-only and your GlobalStandard quota is zero, the model cannot be
deployed at all.

**The one exception worth trying: `gpt-5.1` (2025-11-13) lists `Standard` among
its SKUs.** That is the newest model that has any chance of deploying here, and
testing it is a five-minute job that should happen before any architecture is
committed.

---

## 3. Capability matrix — verified, not assumed

| Capability | On Azure? | How |
|---|---|---|
| **App hosting** | ✅ | Container Apps or App Service (CPU) |
| **Database** | ✅ | Azure Database for MySQL Flexible Server |
| **Object storage** | ✅ | Blob — storage account already exists |
| **AI orchestration / agents** | ✅ **DEPLOYED + TESTED** | `gpt-4o` 2024-11-20, Standard, 50k TPM. Live inference confirmed. |
| **Bulk classification** | ✅ **DEPLOYED** | `gpt-4.1-mini` 2025-04-14, Standard, 100k TPM |
| **SEO + semantic search** | ✅ **DEPLOYED + TESTED** | `text-embedding-3-small`, 100k TPM, 1536 dims confirmed |
| **Text-to-speech (voice)** | ✅ **TESTED** | Azure AI Speech neural voices — separate quota system, **does not consume model quota**. Generated real audio with `en-US-AvaMultilingualNeural`. |
| **Speech-to-text** | ⚠️ | `whisper` deployment not yet confirmed — retry |
| **Image generation (Pawprints)** | ❌ **BLOCKED** | See §3.1 — I was wrong about this |
| **Rigging + animation** | ✅ | Blender is CPU-capable; `blender-worker` already exists |
| **BIM / structural 3D** | ✅ | IfcOpenShell is pure CPU — see §4 |
| **Mesh post-processing, LODs, GLB export** | ✅ | CPU |
| — | — | — |
| **Image→3D (TRELLIS.2)** | ❌ | Needs ≥24GB VRAM. **→ RunPod** |
| **Video generation (Fur Reels)** | ❌ | See below |
| **Newest GPT-5.x / MAI-Image** | ❌ | GlobalStandard-only, quota 0 |

### 3.1 Correction — image generation is blocked, not available

An earlier draft of this document said DALL-E was available because the quota
table shows `Capacity Unit - Dalle  0 / 2`. **That was wrong and I proved it wrong
by trying to deploy it.**

```
dall-e-3 3.0        → ServiceModelDeprecated (retired 2026-03-04)
MAI-Image-2.5-Flash → InsufficientQuota (limit 0, GlobalStandard)
```

The only image models offered in eastus are the `MAI-Image` family, all
GlobalStandard-only, all quota 0. The stale `Capacity Unit - Dalle` line refers to
a model that no longer exists.

**Pawprints image generation cannot run on Azure on this subscription.** It stays
wherever it is today.

The general lesson, and it applies to everything in this document: a non-zero line
in the quota table is not proof. **Deploy it and see.** That is the only check
that means anything, and it costs nothing to run.

### Video — the one that will disappoint you

I checked four regions. `sora-2` exists in **eastus2** and **swedencentral**, but:

- it is **GlobalStandard-only**, and
- there is **no Sora quota line at all** in eastus2 — not zero, *absent*

Same shape as the GPU block. **Video generation cannot move to Azure on this
subscription.** Fur Reels stays on Google Veo, which is fine — it already works
there, and the video-generator bug we still haven't diagnosed is unrelated to
hosting.

---

## 4. Yes, a BIM worker can build structures — and you already wrote it

`FULL_FEATURE_BREAKDOWN.md` records a shipped BIM builder using **IfcOpenShell**
for IFC parsing. IfcOpenShell, Blender, and CSG/mesh operations are **all pure
CPU**. None of it ever needed a GPU.

So structural/architectural 3D generation runs on Azure today at Container Apps
prices. It is genuinely the *easiest* thing on your list to stand up, because it
has no GPU dependency and the code exists.

Worth being precise about the difference, because they're often conflated:

- **BIM/structures** = parametric, deterministic geometry from rules and IFC data
  → CPU, solved
- **Organic subjects (pets)** = learned generative model from photographs
  → GPU, blocked, goes to RunPod

The `imagetoasset` JPG-ortho→CSG work fits the first category. Note the standing
caveat from that project: **its STEP exporter produces invalid output and must
never be treated as authoritative.**

---

## 5. Migrate or start fresh?

You asked. **Start fresh on infrastructure, migrate only the data that is
expensive to recreate.**

**Start fresh:** VMs, networking, app hosting, and the database *schema*. The
current MySQL database is inherited from mypets.cc and carries schema debt you'd
be paying to move. With no real users, there is nothing to preserve that's worth
the migration risk.

**Migrate deliberately:**
- The **18.4 GB TRELLIS model bundle** (37 files, already hash-verified in Azure
  Blob) — expensive to re-download, already validated, already in the right cloud
- Generated GLBs and the asset registry (identity, versions, SHA-256, lineage)
- Avatar library owned by the admin account
- Backblaze bucket contents → Azure Blob

**Do not migrate:** the two current VMs. `pawstrellis-gibi-01` is empty and
`pawstrellis-core-01` is a build workbench. Both should be deallocated rather
than carried forward — see the previous review.

---

## 6. Target architecture

```
┌─────────────────────────────────────────────────────────┐
│                    AZURE (eastus)                        │
│                                                          │
│  Container Apps ── PawsMemories core (Node/TS)          │
│         │           credits · jobs · assets · policy     │
│         │                                                │
│         ├── Azure Database for MySQL (Flexible)          │
│         ├── Blob Storage (assets + model bundle)         │
│         ├── Key Vault (secrets)                          │
│         │                                                │
│         ├── AI Foundry `modelmaker`                      │
│         │     gpt-4o          orchestration, SEO         │
│         │     gpt-4o-mini     high-volume classification │
│         │     text-embed-3-sm semantic search            │
│         │     dall-e          Pawprints imagery          │
│         │     whisper         transcription              │
│         │     AI Speech       neural TTS voices          │
│         │                                                │
│         ├── Container Apps job ── Blender worker (CPU)   │
│         │     rigging · animation · LODs · GLB export    │
│         │                                                │
│         └── Container Apps job ── BIM worker (CPU)       │
│               IfcOpenShell · structural geometry         │
└───────────────────────┬─────────────────────────────────┘
                        │ GPU Worker Connector (egress-only,
                        │ attested — already built & pushed)
                        ▼
                ┌───────────────┐        ┌──────────────┐
                │ RunPod        │        │ Google Veo   │
                │ TRELLIS.2 4B  │        │ Fur Reels    │
                │ image→3D+PBR  │        │ video        │
                └───────────────┘        └──────────────┘
```

**The connector committed in `0d86991` is exactly what makes this work.** The
core does not care that the GPU is on RunPod — it attests the runtime and admits
it. Azure gets the other 90% of the system and the credits get spent on things
Azure will actually sell you.

---

## 7. AI orchestration layer

What you asked for — an AI workflow that takes over generation — maps cleanly
onto what's available:

| Job | Deployment | Status |
|---|---|---|
| Pipeline orchestration, stage decisions | `gpt-4o` (50k TPM) | ✅ live |
| Bulk classification, tagging, moderation | `gpt-41-mini` (100k TPM) | ✅ live |
| SEO content + keyword clustering | `gpt-4o` + `embed3small` | ✅ live |
| Semantic search over the asset library | `embed3small` (1536 dims) | ✅ live |
| Voice lines for Fur Reels | AI Speech neural TTS | ✅ tested, no model quota |
| Transcription | `whisper` | ⚠️ retry deployment |
| Pawprints imagery | — | ❌ blocked, stays off Azure |
| Fur Reels video | — | ❌ blocked, stays on Google Veo |

Note `gpt-4o-mini` 2024-07-18 is **deprecated** and refuses deployment; use
`gpt-4.1-mini` 2025-04-14, which carries a Standard SKU and runs to 2027.

Sequencing, retries and human approval gates should live in **your** job state
machine — the one that already owns credits and refunds — not in a model.
Treat the models as workers the orchestrator calls, exactly like the GPU worker.

---

## 8. Plan

### Phase A — Prove the AI layer ✅ **DONE 2026-08-05**
1. ✅ `gpt-4o` Standard 50k TPM deployed; live inference returned a real completion
2. ✅ `gpt-5.1` Standard **refused** — quota 0. Not usable.
3. ✅ `gpt-4.1-mini` Standard 100k TPM deployed (`gpt-4o-mini` is deprecated)
4. ✅ `text-embedding-3-small` deployed; 1536-dim vector returned
5. ✅ AI Speech neural TTS generated real MP3 audio
6. ❌ Image models refused — deprecated or quota 0
7. ⚠️ `whisper` deployment not confirmed — retry
8. ⬜ **Confirm the sponsorship credit balance in the portal** — still outstanding,
   and it is the one number that decides whether this whole plan is funded

**Gate passed.** The AI layer is real and working on Azure today.

### Phase B — Stop the bleeding (1 hour)
6. Deallocate `pawstrellis-gibi-01` and `pawstrellis-core-01`
7. Keep storage, Key Vault, and the model bundle

### Phase C — Core platform (2–3 days)
8. Azure Database for MySQL Flexible Server; apply schema fresh
9. Container Apps environment + core app; secrets from Key Vault via managed identity
10. Migrate Backblaze → Blob; repoint the asset registry
11. Custom domain + TLS; cut `pawsome3d.com` over from Hostinger

### Phase D — Workers (2–3 days)
12. Blender worker as a Container Apps job (CPU)
13. BIM worker as a Container Apps job (CPU)
14. AI orchestration service wired to `modelmaker`

### Phase E — GPU (parallel, independent)
15. RunPod TRELLIS.2 runner against the connector contract
16. **Phase 0 quality gate on 5 real pets** — still the gate on everything 3D

### Phase F — Keep off Azure
- Fur Reels video → Google Veo
- Pawprints fulfilment → Shopify

---

## 9. Honest scope note

This is **1–2 weeks of focused work**, not a single session. Phases A and B are
genuinely quick and high-value and should happen first — Phase A because it
either validates or invalidates the entire plan for a few dollars, and Phase B
because you're paying ~$75/month for two machines doing nothing.

Everything downstream of Phase A depends on whether `gpt-4o` Standard actually
deploys. **Do not build the orchestration layer before that check passes.**
