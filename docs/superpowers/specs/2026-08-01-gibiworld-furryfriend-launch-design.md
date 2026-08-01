# GibiWorld Cinematic and FurryFriend Launch Design

**Date:** 2026-08-01

**Status:** Approved design; implementation pending written plan

**Sites:** `pawsome3d.com` and `furryfriend.cc`

## Purpose

Introduce GibiWorld as a compelling future-facing extension of Pawsome3D: one favorite pet photo becomes a personal 3D companion that can eventually join an augmented-reality world. The launch package combines a 30-second cinematic, a Pawsome3D homepage hero treatment, a dedicated FurryFriend guide page, a FurryFriend homepage feature, and revised Pawprints messaging and imagery.

GibiWorld must be presented as a **concept preview** until a playable customer build and its production flows are verified. The experience may demonstrate the intended product vision, but it must not claim that AR play, personalization, spatial anchoring, training, multiplayer activities, or game progression are currently available.

## Approved Positioning

The core concept is:

> GibiWorld turns the world around you into a warm, wagging, whisker-twitching adventure. Bring your own Pawsome3D pet into AR or choose a handcrafted companion, then watch them pad across your floor, peek around real corners, learn kind new tricks, chase sparkling memories, and bound through agility courses that fit the space around you. Every walk can reveal a tiny story, every training session can deepen your bond, and every hello feels a little more personal as your companion grows to know your favorite games and rituals. From quiet couch-side cuddles to joyful outdoor challenges with friends, GibiWorld makes room in everyday life for a pet-sized bit of wonder—safely anchored, beautifully animated, and always happy to see you.

Public-facing uses of this language will be accompanied by a nearby label such as **“GibiWorld concept preview”** and a plain statement that the playable experience is in development.

## Scope

### Pawsome3D homepage

- Add a cinematic GibiWorld hero presentation using the approved 30-second film.
- Keep the primary Pawsome3D action clear: begin with a pet photo or explore the current creation flow.
- Provide explicit controls for “Watch with sound,” pause/play, replay, and captions.
- Use a still poster on constrained mobile connections and never require video playback to understand the offer or reach the primary action.
- Keep current Pawsome3D functionality and navigation intact outside the approved hero integration.

### FurryFriend homepage

- Add a prominent GibiWorld concept feature with a film still, short customer-centered explanation, and a link to `/gibiworld/`.
- Keep FurryFriend’s answer-first editorial framing and distinguish the concept from currently available Pawsome3D products.
- Extend primary navigation only if the final layout remains clear on narrow screens; otherwise link from the homepage feature and relevant guides.

### FurryFriend GibiWorld page

Create an indexable `/gibiworld/` page containing:

1. A concept-preview hero with the film or its accessible poster.
2. “From one photo to a companion” — the envisioned journey from a phone photo through Pawsome3D to GibiWorld.
3. “A world that fits around you” — corner peeking, room-scale play, memory discoveries, kind tricks, and agility activities.
4. “Made personal” — a carefully qualified description of future rituals, favorite games, and companion growth.
5. “Designed for everyday spaces” — the intended principles of safe anchoring, understandable boundaries, and calm controls, without making an unverified safety certification claim.
6. “What exists now” — a clear split between current Pawsome3D creation/keepsake experiences and the GibiWorld concept in development.
7. A relevant Pawsome3D call to action that does not imply purchase grants game access.

The page will receive its own title, description, canonical URL, social image, structured data matching visible claims, sitemap entry, and internal links.

### Pawprints editorial update

- Refresh FurryFriend Pawprints language around portraits, memories, Historic Pawprints, and physical keepsakes.
- Explain the envisioned path from a meaningful portrait or personal pet model to a future GibiWorld companion without saying the assets already transfer into a playable game.
- Replace generic or stale imagery with purpose-built visuals that match the updated copy.
- Preserve existing product-truth gates for pricing, fulfillment, materials, delivery timing, likeness, and availability.

### Exclusions

- No playable GibiWorld runtime, AR engine, headset integration, multiplayer system, account entitlement, or game purchase flow.
- No presenter, talking-head avatar, or HeyGen presenter video.
- No claim that buying a Pawprint, model, or keepsake unlocks GibiWorld.
- No automatic publication of unrelated editorial drafts.
- No deployment claim based only on a build, Git push, or archive creation.

## 30-Second Cinematic

### Format and narrative

The film is a warm, cinematic product-concept story, not a screen-recording tutorial. It blends recognizable Pawsome3D process moments with clearly imaginative GibiWorld scenes. One distinctive pet remains visually consistent from the source photograph through the 3D companion and AR scenes.

| Time | Picture | Voiceover |
| --- | --- | --- |
| 0–4s | A pet owner chooses one favorite photo on a phone. The room is quiet and warmly lit. | “Every unforgettable companion begins with one favorite photo.” |
| 4–9s | The image enters Pawsome3D. Luminous particles establish the pet’s shape, coat, face, and eyes. | “Pawsome3D turns that memory into a companion made to feel unmistakably yours.” |
| 9–14s | The finished 3D pet faces the viewer, then transitions naturally into a phone or tablet AR view. | “Then GibiWorld brings them into the space around you.” |
| 14–22s | The pet pads across a living room, peeks around a real corner, offers a paw, and discovers a sparkling memory. | “Watch them explore, learn kind new tricks, and discover tiny stories hidden in everyday places.” |
| 22–27s | A room-scale agility moment resolves into a calm couch-side reunion. | “Every game deepens the bond—and every hello becomes more personal.” |
| 27–30s | Pawsome3D and GibiWorld end card with concept-preview label and action. | “From one photo to a pet-sized world of wonder. Meet GibiWorld.” |

### Direction

- Visual language: cinematic realism with a gentle storybook quality; warm amber practical light balanced by restrained teal accents.
- Camera: intimate phone-photo framing, deliberate macro details during creation, low pet-height tracking in AR, and a calm final push-in.
- Motion: physically believable pet movement; no frantic cuts, exaggerated morphing, floating feet, or uncanny facial motion.
- Transformation: particles and light reveal form progressively while preserving the pet’s identity and markings.
- Device framing: phone/tablet and future mixed-reality language; no dependency on a specific headset or unannounced hardware.
- Sound: warm narrator, restrained cinematic music, light paw steps, one soft interface chime, and a subtle sparkling-memory motif.
- Captions: edited captions available with the film; key meaning must remain understandable when muted.
- End card: “GibiWorld concept preview” must be legible and not buried in fine print.

### Delivery files

- Primary master: 1920×1080, 30 seconds, H.264 MP4, web-optimized with fast-start metadata.
- Optional browser fallback: VP9 WebM when it materially improves delivery size.
- Poster: 16:9 still optimized for desktop and a mobile-safe crop or dedicated vertical-safe poster.
- Captions: WebVTT synchronized to the final voiceover; open captions may also be used in social derivatives.
- Audio: normalized dialogue-led mix with no clipping and intelligible playback on phone speakers.
- Repository paths:
  - Pawsome3D: `public/media/gibiworld/`
  - FurryFriend source assets: `furryfriend/public/assets/gibiworld/`
- Production pages must reference owned, stable asset paths rather than expiring provider URLs.

## Image Package

Create a coherent set of original concept visuals featuring the same recognizable pet and art direction:

1. Favorite phone photo selection.
2. Pawsome3D photo-to-3D transformation.
3. Finished pet facing the viewer.
4. Pet entering a room-scale AR scene.
5. Sparkling-memory discovery and gentle play.
6. Couch-side closing scene.
7. Updated Pawprints portrait/keepsake imagery.

Generated raster assets must be checked for anatomy, identity consistency, device artifacts, accidental text, implausible shadows, and misleading product UI before use. UI text and logos will be applied in the site or compositing stage rather than entrusted to image generation.

## Interaction and Accessibility

- Autoplay, if used, starts muted and must respect reduced-motion and data-saving preferences.
- A visible pause/play control is required; sound cannot begin without a user action.
- Keyboard focus, focus visibility, and screen-reader labels must cover every video control and call to action.
- Captions are on-demand and the surrounding page contains an equivalent concise description.
- The hero retains a readable static state when video, JavaScript, or modern media formats fail.
- Mobile must prioritize copy, poster, and the primary action over background playback.
- Video and imagery receive explicit dimensions to avoid layout shifts; noncritical assets load lazily.

## Content and Search Requirements

- Use customer language: favorite photo, personal pet, companion, room, play, memory, and keepsake.
- Keep “AR” understandable in context and avoid unnecessary technical terms such as GLB, spatial mesh, or rigging on editorial surfaces.
- Add `/gibiworld/` to the generated sitemap and relevant internal navigation.
- Metadata and structured data must describe a concept preview, not a released game or software product.
- No fabricated testimonials, player counts, availability dates, platform support, safety guarantees, or search-ranking claims.
- Existing uncommitted FurryFriend adoption article and editorial-ledger work must remain intact and be integrated without rewriting its content unless separately requested.

## Implementation Boundaries

The implementation plan will separate work into independently reviewable units:

1. Final media script, shot assets, film assembly, captioning, compression, and visual QA.
2. Reusable accessible film component and Pawsome3D homepage integration.
3. FurryFriend GibiWorld route, metadata, structured data, sitemap, and homepage feature.
4. Pawprints copy and imagery update.
5. Focused verification, commit, push, archive creation, and deployment handoff.

The Pawsome3D and FurryFriend builds may share duplicated final media files when required by separate Hostinger document roots. They will not depend on cross-domain hotlinking for the primary hero asset.

## Verification and Release Evidence

Implementation verification will cover:

- Correct 30-second duration, playable media, audible mix, captions, poster, and stable local asset paths.
- Desktop and mobile hero behavior, including muted autoplay rules, manual sound, replay, reduced motion, keyboard operation, and failed-media fallback.
- FurryFriend `/gibiworld/`, homepage feature, Pawprints copy, metadata, structured data, sitemap, and internal links.
- Production builds under the repository-supported Node 24 runtime.
- Secret scan of generated archives and manifest/checksum recording.
- Preservation of the pre-existing uncommitted FurryFriend editorial changes.

Build success, a Git push, and ZIP creation are artifact evidence only. Live completion requires separate deployment evidence: the intended artifact is active on each domain, direct routes return the expected version, assets load from production, and the rendered pages and controls are checked in the live browser.

## Acceptance Criteria

- The 30-second cinematic communicates photo → Pawsome3D companion → GibiWorld concept without requiring narration.
- The same pet remains recognizable across all principal shots.
- Pawsome3D’s homepage has an elegant, accessible film hero with a clear current-product action.
- FurryFriend has an indexable `/gibiworld/` concept page, a homepage entry point, and updated Pawprints messaging and images.
- All public claims clearly distinguish current Pawsome3D functionality from the GibiWorld vision.
- No unrelated user work is discarded or bundled into a spec-only commit.
- Release status is reported separately as built, pushed, packaged, deployed, and live-verified.
