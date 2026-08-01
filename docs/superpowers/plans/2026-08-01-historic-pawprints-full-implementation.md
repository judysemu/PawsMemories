# Historic Pawprints Full Implementation Action Plan

**Objective:** Replace every label-only Historic Pawprint entry with a complete customer workflow: researched art direction, owned preview art, photo-to-portrait generation, persistent FurBin output, digital delivery, and verified physical fulfillment for the five print templates.

## Definition of a real template

A Historic Pawprint is not complete until it has all of the following:

1. A reviewed visual brief with recorded sources and rights status.
2. A role-specific generation directive that preserves the uploaded pet's face, markings, anatomy, and species.
3. Owned source art and an optimized preview with dimensions and SHA-256 recorded in the catalog.
4. A real thumbnail in the picker instead of a colored placeholder block.
5. A server-side generation job that accepts the selected pet photo and selected role.
6. Credit reservation, idempotency, failure persistence, and exactly-once refund behavior.
7. A generated portrait saved as an asset and visible in FurBin even when later delivery fails.
8. Download and email delivery bound to the exact saved revision.
9. Mobile, accessibility, and failed-image behavior.
10. For physical templates: an exact Printful product/variant mapping, aspect and DPI validation, checkout, webhook, and fulfillment evidence.

## Production command language

Every role moves through these directives in order:

- `SEARCH` — collect public-domain or authoritative period references; record URLs, rights, visual facts, restricted marks, and uncertainties.
- `DIRECT` — turn the evidence into a pet-safe art-direction record: setting, wardrobe, props, pose, camera, lighting, palette, title-safe area, and forbidden elements.
- `CREATE` — generate owned reference artwork with `$artifact-template-historic-pawprint-portrait`, inspect it, revise defects, and export source plus web preview.
- `REGISTER` — add actual asset paths, hashes, dimensions, generation prompt, negative prompt, and availability to the catalog.
- `IMPLEMENT` — connect selection to the server generation job and persist every outcome.
- `ACCEPT` — run the complete digital flow; add physical fulfillment proof where applicable.

## Shared search directive

For each role, search authoritative museum, archive, library, government, or reputable historical-collection sources before general web images. Record at least two usable references for clothing and one for setting/props. Do not copy a living artist's composition, a modern entertainment costume, a trademarked team identity, or a photographed person's face. Historical people guide period and symbolism; the generated subject remains the customer's pet.

Required search record:

```ts
interface HistoricRoleResearch {
  roleId: string;
  sources: Array<{
    url: string;
    owner: string;
    title: string;
    rightsStatus: "public-domain" | "licensed" | "reference-only";
    supports: Array<"wardrobe" | "setting" | "prop" | "palette" | "period">;
  }>;
  allowedElements: string[];
  forbiddenElements: string[];
  uncertaintyNotes: string[];
  reviewedBy: string;
  reviewedAt: string;
}
```

## Shared creation directive

Use the retained four-image reference in `$artifact-template-historic-pawprint-portrait`. Supply the customer's uploaded photo as the identity reference and the role brief as the content instruction.

```text
CREATE a premium vertical 4:5 historical pet portrait. Preserve the uploaded pet's exact species, face shape, muzzle length, eye color, ear shape, coat length, coat pattern, markings, body proportions, and distinguishing features. The pet must remain unmistakably the same animal. Use natural animal anatomy, four plausible grounded paws when visible, and species-appropriate posture. Apply the role's researched wardrobe as pet-safe fitted costume pieces without hiding the face or changing anatomy. Build the researched period setting and props as an original composition. Use cinematic but believable light, print-safe contrast, and a calm forward-facing hero pose. Reserve uncluttered title-safe space in the upper 14 percent and message-safe space in the lower 12 percent. No human face, copied portrait composition, signature, watermark, logo, sponsor, team name, modern brand, random letters, extra limb, floating paw, malformed eye, fused costume, or embedded caption.
```

Required outputs per role:

- `public/collections/historic-pawprints/<role-id>-v1.png` — full-resolution owned source.
- `public/collections/historic-pawprints/<role-id>-v1.webp` — optimized picker preview.
- `public/collections/historic-pawprints/<role-id>-v1.json` — research, prompt, negative prompt, dimensions, hashes, provenance, and acceptance state.

## Role directives

### 1. The Composer — digital and physical

- `SEARCH`: late-Georgian chamber music rooms, formal menswear, keyboard instruments, manuscript stands, candle and window lighting.
- `DIRECT`: seated pet at three-quarter angle beside an original keyboard and blank musical manuscript; walnut, cream, muted blue, warm candlelight.
- `CREATE`: preserve the proven composer reference language but generate the customer's pet, not the orange reference cat.

### 2. The Naturalist — digital

- `SEARCH`: nineteenth-century natural-history studies, field coats, specimen cabinets, botanical notebooks, conservatories, magnifying lenses.
- `DIRECT`: alert pet beside an open sketchbook and magnifier, glasshouse beyond; moss, leather, parchment, soft morning light.
- `CREATE`: keep every specimen generic and ethical; no copied scientific plate or readable invented labels.

### 3. The Novelist — digital

- `SEARCH`: early nineteenth-century libraries, writing desks, quills, waistcoats, candlelit domestic interiors.
- `DIRECT`: thoughtful pet beside an unfinished blank manuscript at twilight; charcoal, amber, parchment, deep blue window light.
- `CREATE`: do not generate readable book titles, author signatures, or a named novelist's likeness.

### 4. The Lamplight Healer — digital

- `SEARCH`: late-Victorian care rooms, period lamps, practical capes and shawls, bedside tables, linen storage.
- `DIRECT`: calm pet keeping watch beside a warm lamp and folded linens; midnight blue, cream, copper, quiet moonlight.
- `CREATE`: convey care without medical procedures, distress, blood, modern devices, or false clinical authority.

### 5. Joan of Arc — digital and physical

- `SEARCH`: fifteenth-century French armor construction, textile banners, stone halls, manuscript illumination palettes; avoid movie costumes.
- `DIRECT`: brave pet in light polished ceremonial armor beside an original unmarked banner; silver, deep blue, warm stone, sunrise rim light.
- `CREATE`: no copied heraldry, religious guarantee, battle injury, weapon aimed at the viewer, or human facial features.

### 6. Cleopatra — digital and physical

- `SEARCH`: Ptolemaic-era jewelry, linen garments, palace architecture, lotus and papyrus motifs from museum collections; avoid film costumes.
- `DIRECT`: regal pet on a low palace dais with an original jeweled collar and papyrus-inspired décor; lapis, gold, cream, warm reflected sunlight.
- `CREATE`: maintain animal anatomy; no human wig, racial caricature, copied death mask, studio-logo costume, or readable hieroglyphic invention.

### 7. Santa — digital and physical

- `SEARCH`: pre-commercial Saint Nicholas and nineteenth-century winter gift-giver imagery, artisan workshops, wool garments, wooden toys.
- `DIRECT`: joyful pet gift-giver in an original red wool coat in a warm handmade workshop; cranberry, pine, cream, golden practical light.
- `CREATE`: no Coca-Cola styling, brand marks, copied film costume, branded toys, or text on packages.

### 8. The Chef — digital and physical

- `SEARCH`: historic European grand kitchens, copper cookware, chef jackets and neckerchiefs, pastry tables, hearth lighting.
- `DIRECT`: proud pet presenting a small pet-safe feast from behind a low preparation table; copper, cream, herb green, warm hearth light.
- `CREATE`: no dangerous food near the pet, open flame contact, brand labels, restaurant logos, or human hands.

### 9. The Rock Star — digital

- `SEARCH`: generalized 1970s–1980s concert lighting, original stagewear, unbranded instruments, analog stage equipment; exclude named performers.
- `DIRECT`: charismatic pet centered on an original stage with a fictional instrument motif; plum, electric teal, warm white spotlight, light haze.
- `CREATE`: no musician likeness, band logo, album art, signature costume, readable venue mark, or human body conversion.

### 10. The Moon Explorer — digital

- `SEARCH`: public NASA Apollo suit and lunar-module references, lunar geology, mission photography, public-use insignia rules.
- `DIRECT`: pet in an original pet-shaped exploration suit standing securely on a stylized lunar plain, Earth glow behind; white, graphite, muted gold.
- `CREATE`: no NASA meatball, mission patch, astronaut likeness, impossible exposed pet, floating paws, or false claim of official affiliation.

### 11. Harriet Tubman-inspired Courageous Guide — digital

- `SEARCH`: National Park Service and Library of Congress material on Harriet Tubman, nineteenth-century travel clothing, lanterns, night navigation, Maryland landscapes.
- `DIRECT`: steadfast pet guide on a moonlit safe path with a hooded lantern and north-star composition; indigo, earth brown, warm lantern gold.
- `CREATE`: title publicly as “The Courageous Guide”; do not reproduce Tubman's face, trivialize enslavement, show chains, or turn suffering into costume play.

### 12. Ada Lovelace-inspired Visionary — digital

- `SEARCH`: Science Museum and public-domain Analytical Engine diagrams, early Victorian study interiors, mathematical notes, period dress details.
- `DIRECT`: thoughtful pet beside an original brass calculating mechanism and abstract punched-card patterns; burgundy, brass, cream, cool window fill.
- `CREATE`: title publicly as “The Visionary”; no human likeness, copied portrait dress, readable fake equations, or claim that the pet is Ada Lovelace.

### 13. Abraham Lincoln-inspired Statespet — digital

- `SEARCH`: Library of Congress public-domain nineteenth-century offices, formal black coats, writing desks, civic documents, lamplight.
- `DIRECT`: tall, thoughtful pet posture in a lamplit civic office beside rolled blank papers; black, walnut, parchment, restrained warm light.
- `CREATE`: title publicly as “The Statespet”; no human face, stovepipe hat forced onto incompatible anatomy, copied photograph pose, seal, signature, or political endorsement.

### 14. Nelson Mandela-inspired Hopeful Leader — digital

- `SEARCH`: Nelson Mandela Foundation usage guidance, South African civic architecture and textiles, late twentieth-century formal wear, sunrise public spaces.
- `DIRECT`: hopeful pet in an original patterned formal jacket in a bright civic hall; warm earth colors, sky blue, sunrise gold.
- `CREATE`: title publicly as “The Hopeful Leader”; no human likeness, copied Madiba shirt pattern, party mark, flag misuse, quote, signature, or endorsement.

### 15. The Airborne Alley Cat — digital

- `SEARCH`: public-domain early aviation clothing, open-cockpit aircraft materials, leather helmets, goggles, airfield hangars; avoid named pilots and aircraft liveries.
- `DIRECT`: adventurous cat beside an original small open-cockpit aircraft in a dawn hangar; leather brown, cream, sky blue, sunrise edge light.
- `CREATE`: keep the cat safely grounded; no branded aircraft, military insignia, named-pilot likeness, propeller hazard, readable tail number, or flight-safety claim.

## Data and server implementation

### Catalog schema

Replace the current prompt-only `HistoricPawprintTemplate` with a production record:

```ts
interface HistoricPawprintTemplateV2 {
  id: string;
  displayName: string;
  publicTitle: string;
  availability: "draft" | "reviewed" | "live";
  digitalEnabled: boolean;
  physicalProductCodes: string[];
  previewAsset: { publicPath: string; sha256: string; width: number; height: number };
  generation: {
    promptTemplate: string;
    negativePrompt: string;
    aspectRatio: "4:5";
    identityReferenceRequired: true;
  };
  researchAssetPath: string;
  provenance: "owned-generated";
}
```

Only `availability: "live"` records appear in the customer picker. A role with no actual preview cannot silently fall back to a colored block.

### Generation endpoint

Implement `POST /api/pawprints/historic/generate` with:

```ts
type HistoricGenerateRequest = {
  templateId: string;
  sourceAssetId: string;
  petName?: string;
  idempotencyKey: string;
};
```

The server must authenticate the user, verify ownership of the source asset, validate a live template, reserve the exact configured credit price once, create the generation job before calling the provider, and persist provider request/response state. Success creates a new `historic-pawprint-source` asset in FurBin. Any provider or post-processing failure remains visible as a failed job with its source asset and context; refundable failures issue one ledger refund only.

### Rendering boundary

The existing canvas collage renderer may add the final title, message, and layout after the historical portrait source is generated. It must not pretend that a raw uploaded photo inside a generic colored layout is the historical transformation. The generated portrait asset becomes the selected photo revision passed into the existing save/email/print flow.

## Acceptance matrix

For each of the 15 digital templates, record:

- picker thumbnail loads from the owned asset path;
- source pet remains recognizable;
- correct role wardrobe, setting, and lighting appear;
- no forbidden marks, text, anatomy defects, or human likeness appear;
- job and asset persist on success and failure;
- credit debit/refund ledger is correct under retry and duplicate submission;
- output lands in FurBin;
- title/message render within safe zones;
- download and email use the exact saved revision;
- mobile layout and accessible names pass.

For Composer, Joan of Arc, Cleopatra, Santa, and Chef, also record:

- exact configured Printful product code and variant ID;
- 4:5 crop and required pixel dimensions;
- printable area proof image;
- checkout session metadata binding the saved Pawprint revision;
- Stripe webhook and Printful order evidence;
- customer-visible unavailable state when any fulfillment dependency is missing.

## Execution order

1. Add failing tests proving placeholder records cannot be live.
2. Create research JSON and owned preview art for the eleven missing roles.
3. Upgrade the catalog schema and picker to require real assets.
4. Implement the server generation job and FurBin persistence.
5. Connect the generated source asset to the existing collage editor.
6. Verify all 15 digital templates.
7. Configure and verify the five physical templates.
8. Update README, architecture, sitemap, and admin instructions.
9. Commit verified changes in reviewable checkpoints, then build the deployment archive from committed `main`.
