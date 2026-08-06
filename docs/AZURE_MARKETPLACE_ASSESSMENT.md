# Azure Marketplace Assessment — Pawsome3D / GibiWorld

**Date:** 2026-08-05
**Question:** are Marketplace apps (Unity Asset Manager, Designcenter X, others) worth using?

---

## 1. The finding that decides this

> **Azure Sponsorship credits do not pay for Marketplace purchases.**

Sponsorship credit covers **first-party Azure consumption services only**. Any
third-party or Marketplace-billed product is charged to the **payment method on
file**, regardless of how much grant balance is sitting there.

That inverts the premise of the question. You wanted to spend the $5,000 credit
"properly" — but every Marketplace app is the one category of Azure spend the
credit specifically will not touch. Buying Unity Asset Manager through Marketplace
doesn't use your credit; it opens a new bill.

**Rule of thumb going forward:** if it has a publisher name that isn't Microsoft,
your credit won't pay for it.

Provider state on the subscription (Marketplace ordering *is* enabled, so this is
a funding problem, not a technical one):

```
Microsoft.SaaS                 Registered
Microsoft.MarketplaceOrdering  Registered
Microsoft.Marketplace          NotRegistered
```

---

## 2. The two you named

### Unity Asset Manager — DAM · ❌ don't buy

**What it is:** Unity's cloud digital-asset-management product, deployable into a
private cloud on Azure. Smart tagging, metadata search, 3D optimisation for
mobile/desktop/XR, RBAC, Unity Editor + Pixyz integration.

On paper it looks tailor-made for GibiWorld: it's a Unity product and GibiWorld is
a Unity IL2CPP client. Two reasons it's still the wrong buy:

1. **Not covered by credits.** Third-party SaaS. Real money, on top of Unity seat
   licensing.
2. **You already built this.** `INHOUSE_SPATIAL_GENERATOR_ARCHITECTURE.md` records
   a canonical asset registry with asset identity, immutable versions, SHA-256
   hashes, lineage, source licence and entitlements. GibiWorld already has
   `pet_assets` and `pet_entitlements` tables. Adding a second DAM doesn't extend
   that — it **splits the source of truth**, and asset provenance is the one thing
   in your system that must have exactly one owner.

The genuinely useful piece — *searching* the asset library — is covered by
first-party Azure. See §4.

### Designcenter X — Siemens NX CAD · ❌ wrong tool

**What it is:** Siemens NX as SaaS. Solid/surface/facet modelling, assemblies,
drafting, CAM/CAE, photorealistic rendering. Enterprise engineering CAD.

Not covered by credits, priced for engineering firms, and aimed at a problem you
don't have. NX is for *authoring* precise mechanical geometry by hand. You need to
*generate* organic geometry from customer photographs. Those are opposite
problems.

Even for the BIM/structures side, your IfcOpenShell pipeline already parses IFC on
CPU. NX would be a heavyweight replacement for something that works.

---

## 3. Azure has exited AR entirely — this matters for GibiWorld

Worth knowing before you plan any Azure-hosted AR capability. All three Azure
mixed-reality services are **dead**:

| Service | Status |
|---|---|
| Azure Object Anchors | retired **2024-05-20** |
| Azure Spatial Anchors | retired **2024-11-20** |
| Azure Remote Rendering | retired **2025-09-30** — new accounts already blocked |

Azure Remote Rendering is the painful one. It streamed high-poly 3D from cloud
GPUs to thin devices — conceptually perfect for putting a full-fidelity TRELLIS.2
pet on a phone. It no longer exists, which reconfirms the LOD-ladder approach:
**decimate on the server, render locally on the device.**

Spatial Anchors retiring means GibiWorld's "safely anchored" promise has to come
from **ARCore Cloud Anchors / ARKit**, or **Niantic's Spatial SDK** — and note you
already have a `niantic-nsdk-unity-setup` skill available in this workspace, which
is a Unity-native path for exactly this.

---

## 4. What to use instead — first-party, credit-covered

These do the useful parts of what the Marketplace apps promised, and the
sponsorship credit actually pays for them:

| Need | First-party service | Why |
|---|---|---|
| **Asset search / "the DAM part"** | **Azure AI Search** | Vector + keyword search over your existing registry. Pairs directly with the `embed3small` deployment already live. This is the Unity Asset Manager value without a second source of truth. |
| Asset storage | Blob Storage | already provisioned |
| Global GLB delivery to Unity/AR clients | Azure Front Door / CDN | matters a lot for mobile AR download times |
| Container images | Azure Container Registry | needed anyway |
| **Moderation of uploaded pet photos** | **Azure AI Content Safety** | first-party, cheap, and you're accepting arbitrary customer uploads today with nothing in front of them |
| Orchestration / SEO / voice | already deployed | `gpt-4o`, `gpt-41-mini`, `embed3small`, Speech TTS |

**Azure AI Search is the one I'd actually add.** It's the single highest-value
first-party service you're not using, it's covered by credit, and it turns the
asset registry you already own into something searchable across both products.

---

## 5. Recommendation

**Buy nothing from Marketplace.** Not because the products are bad — Unity Asset
Manager is a good DAM — but because they're funded from the wrong pocket and, in
the DAM case, duplicate a system you already built and depend on.

Spend the credit on first-party consumption: Container Apps, MySQL Flexible
Server, Blob, AI Search, Front Door, Content Safety, and the AI model deployments
already live. That's where the $5,000 will actually go.

**Before anything else, confirm the credit balance in the portal.** It's still
unverified and it's the number that governs the entire migration plan.

One caveat on scope: I assessed the two products you named plus the first-party
alternatives. I did not exhaustively enumerate the Marketplace catalogue — but
given that *nothing* in it is credit-eligible, the search space for "useful things
the credit will pay for" is first-party only, and that list is above.

---

## Sources

- [Sponsorship coverage for Foundry models](https://learn.microsoft.com/en-us/startups/benefits/technical-benefits/azure-credits/foundry-model-sponsorship-coverage)
- [Applying Azure credits to third-party Marketplace charges](https://learn.microsoft.com/en-us/answers/questions/5774062/applying-azure-credits-to-third-party-marketplace)
- [Unity Asset Manager on Marketplace](https://marketplace.microsoft.com/en-us/product/saas/unitytechnologies1676389513587.unity-private-cloud?tab=overview)
- [Designcenter X on Marketplace](https://marketplace.microsoft.com/en-us/product/saas/siemensplmsoftware.siemensnxsaas?tab=overview)
- [Azure Spatial Anchors retirement](https://azure.microsoft.com/updates/azure-spatial-anchors-retirement/)
- [Azure Remote Rendering retirement](https://github.com/Azure/azure-remote-rendering)
