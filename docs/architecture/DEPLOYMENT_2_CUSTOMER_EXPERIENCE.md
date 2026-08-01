# Deployment 2 Customer Experience Architecture

## Scope

Deployment 2 introduces three connected customer surfaces: Famous Portraits, Historic Pawprints, and Fur Reels. The release uses existing account, media, credit, Stripe, Printful, voice, and AI-video boundaries rather than creating parallel payment or persistence systems.

## Catalog boundary

`shared/historicalPetCatalog.ts` owns the schema-validated Famous Portraits catalog. Each record declares its customer display name, category, art direction, accessibility text, palette, availability, and optional versioned asset. Sports records additionally carry private inspiration and jersey-number source fields.

`publicFamousPortraitCatalog()` removes both private source fields. Customer-facing code consumes that projection exclusively. Sports display names are fictional archetypes; visible marks are fictional; league, team, sponsor, signature, and athlete names are not public catalog data. A sports number is rejected by schema validation unless it has a verification source.

Available portrait assets must exist at their declared `public/collections/historical-pets` path and match their SHA-256. Planned portraits use `coming-soon` and render a code-native art card rather than a broken image or purchase claim.

## Historic Pawprints boundary

`shared/historicPawprintTemplates.ts` derives fifteen allowlisted digital templates from Famous Portraits. It exposes a separate five-item allowlist for physical products. `db.ts` adds these templates to the existing `/api/pawprints/templates` response and the generation route validates the selected category and layout against that server catalog.

The browser still submits `productCode` to the Printful order route. `server/pawprintProducts.ts` resolves that code to server-owned variant, template, dimensions, and price data. Historic template selection does not permit client-provided provider IDs or pricing.

## Fur Reels boundary

`src/components/AnimationStudio.tsx` is the Fur Reels customer dashboard. Its three desktop panels contain owned uploads, visible directing controls, and voice/frame/result controls. Mobile returns to normal document scrolling.

`src/aiVideoScripts.ts` contains thirteen complete eight-second scripts. Each script has one setting, explicit identity protection, primary motion, four two-second directions, lighting, color treatment, and one continuous camera direction. The optional voice line is bounded to 160 characters and previewed through the configured authenticated voice service.

Generation continues through the existing `createVideo` API. The server normalizes aspect ratio, validates the full script, compiles a provider prompt, reserves credits, creates a tracked job, and persists the script and provider operation. Once the durable job owns the reservation, worker completion or failure owns the final asset or exactly-once refund decision.

Uploading from Fur Reels saves the bounded image to the signed-in account photo library. The UI states that the customer must create a portrait from that photo before it becomes an animatable creation; it does not pretend a raw upload is already a video-ready asset.

## Customer route map

- `/` — homepage with Famous Portraits.
- `/pawprints` — Historic Pawprints digital or physical entry.
- Authenticated `Screen.ANIMATOR` — Fur Reels.
- Authenticated Fur Bin — saved portraits, Pawprints, and completed videos.

The manual 3D Animator source remains preserved but is not exposed as the Fur Reels customer tool.
