# Pawsome3D Pet-Owner Experience Release Design

**Date:** 2026-08-01  
**Release strategy:** Two production deployments on `main`  
**Audience:** Pet owners and gift buyers who should not need 3D, animation, or printing expertise

## Product principle

Pawsome3D must feel like a personal keepsake studio, not a technical asset-management application. Customer-facing screens use pet-owner language, immediate visual feedback, large touch targets, and one obvious next action. Terms such as GLB, UV, topology, triangle count, rigging, asset hashes, and provider identifiers remain available only under **Model details** or **Advanced options**.

The customer journey is:

1. Choose pet photos.
2. Watch the pet take shape.
3. Add coat and colors.
4. Optionally get the pet ready to move.
5. Find the finished pet in Fur Bin.
6. Download, animate, or order a keepsake.

## Deployment 1: Functional model hotfix

### 1. Restore the live model viewer

The current preview API succeeds, but the private Backblaze B2 GLB request fails in Chrome with `MissingAllowOriginHeader`. Apply the repository's revision-guarded, merge-preserving B2 CORS update for these production origins:

- `https://pawsome3d.com`
- `https://www.pawsome3d.com`

The viewer must never present a silent gray panel. Loading, success, and failure states are explicit. A failed load shows a friendly explanation, **Try again**, and **Download 3D file** when a secure download remains available.

The default model presentation is stationary and front-facing. Auto-rotation and animation autoplay remain off. Desktop users can drag and zoom. Mobile users first see a durable front-facing poster with an explicit **Explore in 3D** action so a page never creates unnecessary WebGL contexts.

### 2. Restore every past model in Fur Bin

Fur Bin v5 currently lists only canonical `fur_bin_items`; older generated models remain in legacy `creations` and `avatars` records. Add an idempotent reconciliation that:

- discovers every owned legacy model with a durable model URL;
- registers the model into canonical `assets` and `asset_versions` without changing the original file;
- creates or reactivates one owner-scoped `fur_bin_items` row;
- preserves creation date, pet name, breed, source type, and original image;
- records deterministic lineage and avoids duplicates across repeated runs;
- reports skipped, imported, duplicate, and failed rows without hiding partial failure.

Fur Bin remains the branded name, with the plain-language subtitle **Your pets and keepsakes**. Cards use a static poster, pet name, completion date, and simple actions. Technical capability badges move into details.

### 3. Replace the model-order thumbnail wall

The Create screen replaces recent-order thumbnails with a compact **Choose one of your pets** selector. Each option shows the pet name or a friendly fallback, creation date, and one state:

- Waiting for photos
- Creating your pet
- Adding coat and colors
- Getting ready to move
- Ready in Fur Bin
- Needs attention

Selecting a pet reveals the current result and these actions when applicable:

- **Adjust coat and colors**
- **Get ready for animation**
- **Explore in 3D**
- **Download 3D file**
- **Order a keepsake**

Base, Texture, and Rig remain visible only inside **Model details**, including measured validation evidence and billing disposition.

### 4. Make generation feel alive

Use an original, code-native sand-and-electric construction effect inspired by the supplied 8.44-second reference clip. Do not ship, copy, or redistribute the watermarked iStock footage.

The effect is lightweight CSS/canvas animation, respects reduced-motion preferences, and cycles through truthful stage messages:

- Gathering your pet's shape...
- Sculpting the little details...
- Adding their coat and markings...
- Getting them ready to move...
- Almost ready to meet you...

The messages derive from the persisted current stage; they do not simulate progress or claim a stage has started before it has.

### 5. Preserve texture and stage lineage

The verified production GLB `30557fd1387bb4f20c280487c6321a837f4874837e5f8170e2f92a4e7aa0d6f5` contains 7,623 triangles, UV coordinates, one material, and three embedded 2048 x 2048 textures. It is not repaired or regenerated. The storage/viewer delivery path is corrected.

For every new order, the canonical Fur Bin pointer advances only to the latest successfully validated purchased stage:

- base only when Texture and Rig were not selected;
- texture when Texture completed and Rig was not selected;
- rig when Rig completed, retaining texture evidence when Texture was purchased.

A later-stage failure never silently replaces a valid earlier model, and it never labels a base model as textured or animation-ready.

### 6. Add customer-owned GLB uploads

Place **Upload your own 3D model** under Advanced options. Accept owned GLB files only, using the existing bounded upload and canonical asset-validation patterns. Validate container structure, declared length, size, embedded dependencies, mesh presence, finite geometry, materials, texture evidence, and ownership metadata before registration.

An accepted upload appears in Fur Bin. Missing capabilities are described plainly: **Coat and colors not detected** or **Not ready for animation**. Uploading does not fabricate measured rig, facial, animation, or print-readiness claims.

### 7. Send one completion email

When the final selected stage is validated and its Fur Bin assignment commits, enqueue one idempotent completion notification. The subject is **Your pet is ready to meet you**. The message includes the pet name when known, a button to open Fur Bin, and plain-language next actions.

Email failure does not roll back a completed model. Delivery status is persisted for retry, and duplicate worker or webhook execution cannot send the same completion email twice.

### 8. Customer review behavior

The customer approves the generated reference images before paid model construction. Generated GLB stages do not pause for private customer review. Validated versions land automatically in Fur Bin, where **How is it? Keep it / Toss it** remains the feedback flow. Toss feedback preserves the model and automatically attaches the user, order, asset, version, provider job, and hash context to the admin message.

## Deployment 2: Famous Portraits, Historic Pawprints, and Fur Reels

### 1. Famous Portraits homepage feature

Replace **Featured Models** with **Famous Portraits** and route every portrait action into the Historic Pawprints experience. The four owned images generated on 2026-07-31 remain the lead collection:

- The Composer
- The Naturalist
- The Novelist
- The Lamplight Healer

Expand the owned catalog to fifteen roles with real repository paths, versioned images, dimensions, hashes, provenance, accessible alt text, and availability state:

- Joan of Arc
- Moses
- Gandhi
- Santa
- The Elves
- The Abominable Snowman
- Bigfoot
- The Moon Explorer
- The Chef
- The Rock Star
- Cleopatra

Portraits remain unmistakably pets. Religious and cultural figures use respectful composition and customer copy; comedy comes from the pet inhabiting the scene, not from degrading the represented tradition or person.

### 2. Historic Pawprints entry screen

Pawprints no longer begins with a generic upload prompt. It opens with two large choices:

- **Historic Pawprint Pet Digital** — create a downloadable or shareable portrait.
- **Pawprint Pet Physical** — create a printed keepsake using the existing Printful and Stripe fulfillment boundary.

The existing general digital and Printful browsing options are hidden from this customer path without deleting their backend compatibility.

Digital offers fifteen scripted portrait templates matching the Famous Portraits catalog. Physical offers five launch templates that share the exact print canvas and configured Printful product dimensions:

- The Composer
- Joan of Arc
- Cleopatra
- Santa
- The Chef

The physical flow continues to use server-owned Printful variant/template configuration and the existing Stripe webhook. Client input can select only an allowlisted template and product code; it cannot inject a Printful variant ID or retail price.

### 3. Fur Reels navigation and dashboard

Rename **AI Video** to **Fur Reels** everywhere and use a motion-picture camera icon. Fur Reels is an AI-directed eight-second video generator, never a manual animation editor.

Desktop uses a viewport-height, scroll-locked dashboard with independently scrollable panels:

- left: **Your pet photo**, current selection, recent uploads, and **Upload another photo**;
- center: story choice and all directing controls;
- right: voice line, frame choice, generation summary, and result.

Mobile uses the same order as stacked steps and retains normal page scrolling. Directing options are visible in the first desktop viewport without requiring page scrolling.

The unlabeled creation-thumbnail wall is removed. Every image has a pet name/date label or a friendly fallback, and the upload window supports adding another owned image without leaving Fur Reels.

### 4. Directing guidance and scripts

Show a persistent **What works best** guide beside the directing controls:

- one main pet and one clear action;
- slow, readable movement;
- four simple two-second beats;
- one continuous camera move;
- consistent setting and lighting;
- short spoken line that fits naturally inside eight seconds.

Warn against rapid cuts, crowd scenes, costume changes, collisions, tiny props, complex choreography, and instructions that change the pet's identity.

Retain the existing eight scripts and add five complete templates, bringing the customer generator to thirteen:

- Moonlight Maestro
- Joan's Banner
- Santa's Workshop Surprise
- Cleopatra's Golden Entrance
- Rock Star Encore

Every template specifies setting, characters, motion, four timed stage directions, lighting, color treatment, camera direction, native sound, and an optional short voice line.

### 5. Video persistence

The generator continues to register work before provider submission. Completed videos are mirrored into Pawsome3D-controlled durable media storage and linked to the owner's persisted creation record. Fur Reels shows **Your finished reels** with play, download, and make-another actions. A provider's expiring output URL is never the canonical customer URL.

The UI states plainly: **Your finished Fur Reels are saved to your account and appear here when you return.** Failed jobs retain their tracked job record, honest status, and exactly-once credit refund behavior.

## Shared error handling

Every customer-facing error answers three questions:

1. What happened in plain language?
2. Was the pet, payment, or credit balance preserved?
3. What can the customer do next?

Provider names, stack traces, HTTP codes, storage hostnames, signatures, and internal identifiers stay out of customer copy. The support detail view may include a short reference code that maps to server logs.

## Accessibility and responsive behavior

- Touch targets are at least 44 x 44 CSS pixels.
- Interactive controls have visible focus states and accessible names.
- Status changes use a polite live region.
- Color never carries status alone.
- Motion respects `prefers-reduced-motion`.
- Portrait and model posters include meaningful alt text.
- Desktop dashboard panels cannot trap keyboard focus or wheel scrolling.
- Mobile never mounts a grid of live WebGL viewers.

## Verification and release evidence

Verification supports release confidence but is not presented as a customer-facing blocker. Each deployment records:

- exact `main` commit;
- focused component and service checks for changed flows;
- production build result under Node 24.18;
- archive manifest and SHA-256;
- live desktop and mobile route checks;
- authenticated model-viewer fetch evidence;
- Fur Bin legacy reconciliation counts;
- one real textured-model display check;
- completion-email idempotency evidence;
- Stripe/Printful route preservation for Historic Pawprints;
- live Fur Reels persistence and return-visit check when provider credits permit.

Any unavailable paid-provider execution is reported separately from deployment readiness and is never disguised as a pass.
