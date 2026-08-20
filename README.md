# Pawsome3D

Turn your pet photos into a living 3D avatar you can play with, dress up, and place in your room in AR — guided by Randy, an AI assistant. Pawsome3D is a full‑stack web app with email + password sign‑in, a credits system, AI image + Image‑to‑3D generation, a merch Store, a Community hub, and the option to order physical keepsakes.

Live site: https://pawsome3d.com  (formerly mypets.cc)

## Features

- **Tracked 3D models delivered to Fur Bin** — after the customer approves the generated reference set, the base GLB, optional texture, and optional body rig run through durable paid stages without another private-review stop. Every persisted version is registered in Fur Bin, including failed validation outcomes, so ownership and provider lineage remain traceable. Fur Bin asks “How is it?” with **Keep it** or **Toss it**; Toss sends the administrator the customer, order, job, asset, version, and hash context automatically.
- **One-photo model entry** — the builder accepts one genuine PNG, JPEG, or WebP source at any practical aspect ratio; additional angles are optional. Image bytes must match the declared file type. The generator creates the five approval views, and the customer must approve them (or deliberately enable auto-approval) before the paid base mesh begins.
- **Fur Bin showcase** — an enabled private model library and public-derivative showcase with immutable versions, measured capability badges, feedback, moderation, and rollback.
- **Scaled building lab** — calibrated text/image proposals, low-cost visual Shell and higher-cost IFC/BIM choices, and verification before and after construction. The durable v2 release path remains disabled until live worker/UI acceptance.
- **AR virtual pet (WebXR / ARCore)** — place your avatar on real surfaces on Android Chrome; plane + mesh detection, drift‑free `XRAnchor` placement, and footprint center‑of‑gravity grounding so the pet plants on its feet. iOS falls back to the 8th Wall engine. The implementation lives under `src/three/ar/`, `src/brain/`, and the guarded pet-simulator routes.
- **Store** — merch (3D prints, plush, accessories) with your Albums folded in as a tab.
- **Community** — local info (nearby parks, weather, pet‑recall news), a live pet inspiration board (dog.ceo + dogapi.dog) with user‑uploaded memories, and a coming‑soon roadmap.
- **Credits** — server‑backed ledger with earn/spend history, persisted daily bonus, per‑day‑capped share rewards, and Stripe credit‑pack purchases (webhook + redirect‑confirm double safety net).
- **Profile** — avatar thumbnail uploader + a personal photo library; photos uploaded in the avatar builder persist here automatically.
- **8-second AI Video Studio** — customer-facing guided AI video generation, not a manual timeline animator. Scripts specify the setting, characters, motion, four timed stage directions, lighting, filter, camera, native sound, and an optional short voice line with ElevenLabs preview.
- **Randy AI** — Gemini-powered pet guide with a server-owned action registry and constrained navigation responses.

## Current model-generator release

The current generator is documented by three source-of-truth files:

- `docs/current/MODEL_GENERATOR_REVIEW_2026-07-28.md`
- `docs/current/MODEL_GENERATOR_ARCHITECTURE_SNAPSHOT_2026-07-28.md`
- `docs/current/MODEL_GENERATOR_BUILD_PLAN_2026-07-28.md`

The product no longer presents a single opaque generation action. Order creation
is free; approving the exact reference set starts the paid base stage. Base,
texture, and body-rig results are immutable, separately validated, and separately
approved. Facial rigging is not sold because this provider path has not met the
documented 75% reliability threshold. “Humanoid intelligence” selects a humanoid
body-rig profile only; it does not claim to embed AI behavior inside a GLB.

## Tech stack

- **Frontend:** React 19 + Vite 6, Tailwind CSS 4, Lucide icons, Motion for animation
- **Backend:** Node 24.18 + Express 4 (single `server.ts`, bundled to `dist/server.cjs` with esbuild)
- **Auth:** Email + password with JWT session tokens (passwords hashed with scrypt)
- **Database:** MySQL (via `mysql2`) for the user store
- **AI / 3D:** Google Gemini for chat, Imagen for stills, Veo for video. **Tripo3D** for Image-to-3D mesh generation (replaced Meshy for higher quality and reliability). Blender 3D via dedicated `bpy` microservice with EEVEE PBR rendering and 24-frame cycles.
- **Payments:** Stripe Checkout for credit packs and configured physical fulfillment, with signed webhook verification
- **Notifications:** Optional email/SMS notifications for supported generation and fulfillment events
- **Hosting:** Hostinger for the main app. **Azure Container Apps** for the Blender microservice (`pawsome3d-blender-worker`, resource group `pawsome3d-blender-worker-prod`, East US).

## How it fits together

The Express server does double duty: it serves the built Vite frontend from `dist/` and exposes the JSON API under `/api`. Authentication is email + password: a user signs up, is then required to complete a profile, and receives a 30‑day JWT that gates the rest of the app.

### Auth & gating flow

1. `POST /api/auth/signup` — creates an account from an **email + password**. Email must be unique. Returns a 30‑day JWT. New users start with a **profile‑incomplete** record (and 0 credits).
2. `POST /api/auth/complete-profile` — required for every new user. Saves full name, a strictly validated birthdate, city, and pets to MySQL. It does not mint wallet credit.
3. `POST /api/auth/login` — email + password login for returning users; returns a JWT.
4. `GET /api/me` — restores the current user from a valid `Bearer` token.

Protected routes use the `requireAuth` middleware, which rejects any request without a valid session token. The frontend additionally blocks any user whose profile is incomplete from reaching the app, so the profile step is enforced for every new account.

### Database

Tables are created automatically on boot (`initDb()`). The `users` table:

| column | notes |
| --- | --- |
| `id` | auto‑increment primary key |
| `phone` | **internal opaque user key** (e.g. `u_3f9a…`), unique. Not a phone number — kept because `albums`, `creations`, `generation_jobs`, and `pets` foreign‑key to it. |
| `email` | unique — the login identifier (lower‑cased) |
| `password_hash` | scrypt salt:hash |
| `full_name`, `birthdate`, `city` | filled in at profile completion |
| `credits` | starts at 0, +50 on first profile completion |
| `treats` | daily streak reward count, used to feed pet avatars |
| `profile_complete` | `0` / `1` |
| `is_admin` | `0` / `1` |
| `created_at` | timestamp |

The `avatars` table:

| column | notes |
| --- | --- |
| `id` | auto‑increment primary key |
| `user_phone` | links to the owner's `phone` |
| `name` | custom name of the pet avatar |
| `image_url` | URL of the avatar image (preset or generated) |
| `food_level` | current food percentage (0-100, decays 5%/hr) |
| `water_level` | current water percentage (0-100, decays 5%/hr) |
| `last_fed` | timestamp of the last feeding action |
| `last_watered` | timestamp of the last watering action |
| `created_at` | timestamp |

> The legacy Twilio/phone verification flow has been removed. The `phone` column is now just a stable internal key per user.

Additional tables (all auto‑created on boot): `credit_transactions` (earn/spend ledger for the Profile history + Stripe idempotency), `community_memories` (Community board uploads), `user_photos` (Profile photo library + persisted avatar‑builder uploads), `placed_objects` (AR object placements). The `users` table also gains `profile_photo_url`, and `avatars` gains the generation‑pipeline columns (`model_url`, `sprite_sheet_url`, `rigged_model_url`, `clips_json`, `generation_status`, …).

### Memory Requests & Admin Fulfillment

Direct AI generation of photos and videos is restricted to **Admins**. Regular users must use the **Request a Memory** flow:
1. User submits a request (specifying photo or video, style tier, and instructions).
2. User pays upfront flat rates via **Stripe Checkout**.
3. Admin receives the pending request in the **Admin Dashboard**, and generates the photo/video using the premium AI tools.
4. Admin clicks "Fulfill", which clones the generated creation to the user's gallery and sends an automated **Twilio SMS** to notify the user.

## AI Pet Avatar & Tamagotchi System

Pawsome3D features an interactive, Tamagotchi-style pet avatar system with the following mechanics:

- **Multi-Agent 3D Avatar Stack**: Pet photos are converted to 3D meshes via **Tripo3D** (Image-to-3D), then processed by an autonomous multi-agent pipeline (built on LangGraph). The pipeline includes:
  - *Perceive*: Analyzes the uploaded photo to determine species, breed, body type, and proportions.
  - *Reason*: Formulates a step-by-step Blender build plan with breed-specific anatomy, facial rigging (jaw, ears, eyes), and 24-frame cycles.
  - *Act & Verify*: Generates and executes Blender Python (`bpy`) scripts iteratively, verifying geometry and bone hierarchies.
  - *Visual-Verify*: Uses Gemini Vision to compare the final 3D viewport render against the original photo, automatically recovering from anatomical anomalies.
- **Microservice Architecture**: Because the main app runs on Hostinger shared hosting, the generated `bpy` scripts are sent securely via HTTP to a dedicated Docker microservice (`blender-worker`) running on **Azure Container Apps**, which safely executes the render and returns the 3D Avatar.
- **Life-like Biological Economy**: Avatars track their **Food** and **Water** levels. Both levels decay naturally over time (5% per hour). Users must feed and water their pets to keep them healthy.
- **Daily Treats**: Claiming the daily login streak rewards users with virtual **Treats** in addition to credits. Treats can be fed to avatars for bonus food.
- **3D Playpen Yard**: Displays pets in a grassy yard featuring:
  - **3D Parallax Hover**: Moving your cursor tilts the yard dynamically in 3D space.
  - **Idle Roaming**: Pets hop, roam, and flip directions automatically.
  - **Action Drop Animations**: Feeding, watering, or giving a treat drops the item into the yard. The pet runs to it, eats it, displays happy emoji bursts, and then updates the database.
  - **Tired & Trick States**: Low-energy pets move slower and show sleepy `💤` bubbles. Tapping a pet makes it perform a spin or jump trick.

### Blender 5.1 Update & AI Safety Engine
The rendering engine has been upgraded to **Blender 5.1**. Due to significant API deprecations in recent Blender versions, an AI script safety post-processor (`sanitizeBlenderScript()`) acts as a safeguard. This protects the worker from crashing when the LLM hallucinating legacy properties:
- **EEVEE-Next Migrations:** Deprecated `use_contact_shadows` is stripped (EEVEE-Next relies on implicit raytracing).
- **Lighting Deprecations:** Legacy `PointLight.distance` falloffs are intercepted and swapped/commented in favor of `energy`.
- **Animation 2.0 / Slotted Actions:** Blender 4.3+ removed `Action.fcurves`. The agent prompt explicitly bans direct `.fcurves` access, and the safety net neutralizes any hallucinated attempts.

## AR Virtual Pet System

The AR mode is a full behavior simulation, not a static model placement. When a user opens an avatar's **Live 3D (beta)** view and taps **AR**, `ARPetStage` mounts an autonomous virtual pet:

- **Behavior brain** (`src/brain/`, framework‑agnostic pure TS): drives, hormones, considerations, a seeded‑RNG utility selector, a behavior tree, reinforcement learning (gesture‑driven weight changes with forgetting), pacing/unlocks, aging, and progression. Kept free of React/three/DOM imports so it can be ported to a native (Unity/C#) client.
- **AR stage** (`src/three/ar/`): WebXR primary path (Android/ARCore) with an 8th Wall iOS fallback, hit‑test reticle, real `XRAnchor` placement, contact shadows, head‑look‑at IK, light estimation, and depth occlusion. `ARPetStage.tsx` is the live entry point (replaced the older `ARScene.tsx`, which remains as a fallback).
- **Interaction**: pointer strokes become gesture reinforcement; a semantic camera scan builds a navmesh with per‑zone movement cost + behaviors; voice commands train recall; disc and agility trials award care points → credits.
- **Backend**: `POST /api/pets/classify` (Gemini vision), `GET/PATCH /api/pets/:id/state`, `POST /api/pets/:id/rig` (Tripo auto‑rig → Blender bake‑LOD → B2, behind `PETSIM_RIG_ENABLED`), `/commands`, `/buttons`, `/api/ar/semantic-scan`, `/api/trials/:type/result`.

Current release risks, decisions, and production acceptance evidence are tracked
in `docs/current/FULL_CODEBASE_AUDIT_2026-07-31.md` and
`docs/current/PRODUCTION_DEPLOYMENT_REVIEW_2026-07-31.md`.

## Barkley Presenter

Barkley is a 3D presenter that walks a viewer through a scripted "show" of
beats — dialogue, camera moves, quizzes and reveals — driven by
`src/barkley/shows.ts` and rendered by `src/components/BarkleyScreen.tsx`.
Gated behind `BARKLEY_PRESENTER`, which is off unless explicitly set to
`true`/`1`.

**The runtime loads exactly one asset: `public/barkley/barkley.glb`.** It keys
its clip map off `gltf.animations` by name. The other 30 files in
`public/barkley/` are build inputs, not runtime assets — if the merged file is
absent the loader's `onError` branch fires and the stage falls back to a
placeholder figure, with no error surfaced.

The rig is Tripo's auto-rig: 41 joints ending at `L_Hand`/`R_Hand` with **no
finger bones**. Clips needing finger articulation cannot be authored against
it at any keyframe. `gesture_count` and `gesture_thumbs_up` are therefore
served by substitute motions (a two-arm sweep and a bow); their descriptions in
`shows.ts` say what actually plays.

Build pipeline, in order:

```bash
# 1. author a clip on the Azure Blender worker (no local Blender needed)
npx tsx scripts/manual/author-barkley-clip.ts point_right --out /tmp/clips
node scripts/manual/render-clip-frames.mjs 0 24 34   # eyeball it; --head for a closeup

# 2. reduce whole-model exports to animation-only clip GLBs
npx tsx scripts/manual/strip-barkley-clips.ts /Users/robert/barkley-clips --out public/barkley

# 3. merge the clip GLBs into the single file the runtime loads
npx tsx scripts/manual/build-barkley-glb.ts
```

Step 3 is a node remap, not a retarget: every clip came off the same rig, so
animation channels rebind to the base model's node indices by bone name. It is
done at the glTF level rather than in Blender because the stripped clips have
no skins, and Blender's importer would rebuild them as Empties whose actions
can no longer bind to the armature.

Rotation signs on this rig were measured rather than assumed, and the results
are counterintuitive enough to be worth recording: `+72` on Z **lowers** the
right upper arm while `-72` lowers the left, `X+` swings **both** arms forward,
`Z=0` is the T-pose with the hand at shoulder height, and `Head` Y is the yaw
axis. See the comments in `author-barkley-clip.ts`.

> **Source clips live outside this repo.** `public/barkley/barkley.glb` is built
> from ~51 MB of Tripo whole-model exports in `/Users/robert/barkley-clips`,
> which is not version-controlled. The repo cannot rebuild the avatar from its
> own contents, so the merged GLB is committed deliberately rather than treated
> as build output. Back the source directory up with
> `npx tsx scripts/manual/backup-barkley-clips.ts` (writes to
> `backups/barkley-clips/` in the private B2 bucket).

## Project structure

```
server.ts          Express app: static hosting + /api routes + Stripe and Shopify webhooks
auth.ts            Email/password helpers, JWT sign/verify, requireAuth middleware
db.ts              MySQL pool, table init, user/account CRUD helpers
src/               React frontend (App, components, api client, types)
  components/      SignUp, Dashboard, Create, Pawprints, Animator, Fur Bin, ...
  brain/           Framework-agnostic pet behavior engine (drives, brain tick, reinforcement)
  three/ar/        AR stage + brain bridge (ARPetStage, IK, navmesh, voice, trials)
blender-worker/    Standalone Express + Docker microservice for running Blender scripts (+ bake_lod.py)
x-dm-service/      X DM conversation refinement service (Node 20 + Express + TypeScript)
scripts/           build-deploy-zip.sh (verified dist → Hostinger deploy zip)
  manual/          One-off operator tools: Barkley clip authoring/merge, catalog pulls
public/barkley/    barkley.glb (the only file the runtime loads) + 30 clip GLB inputs
dist/              Build output (vite assets + server.cjs)
.env.example       Documented environment variables
docs/AUTOMATIONS.md  Index of scheduled routines (agents) this repo depends
                     on but has no other pointer to — trigger IDs, schedules,
                     connectors, and each one's human-approval stage
```

Test runner is the built-in `node:test` via `tsx` (not Vitest): `npm test`, or scoped
`npm run test:brain`, `npm run test:pets`, `npm run test:ar`,
`npm run test:security`, `npm run test:contracts`, and `npm run test:coverage`.

## Famous Portraits, Historic Pawprints, and Fur Reels

The homepage Famous Portraits collection is driven by `shared/historicalPetCatalog.ts`. The public projection removes private sports-inspiration and jersey-verification sources before records reach customer UI. Sports portraits use generalized pet-athlete roles, fictional marks, and only source-verified jersey numbers; unavailable final art is labeled honestly instead of requesting a missing image.

**PawPrints v3** (`shared/pawprintCatalog2.ts`) is digital-only. Customers select one of three themed categories, upload photos (with an explicit confirmation instead of a hard failure for low-resolution files), and run a two-stage pipeline: one cached Gemini subject-art call per theme/photo set via `POST /api/pawprints/generate-subject`, followed by a deterministic client canvas composite (`renderPawprint()`). Save persists both the clean generated artwork and the composed design, and ownership-checked download routes expose each file independently. After completion the app opens the public `/store?pawprint=<id>` experience, where a runtime snapshot of active Shopify products links directly to Shopify. Personalizable products are classified only by the boolean `custom.pawprint_personalizable` metafield. Existing PawPrint Shopify order history and signed webhook reconciliation remain read-only for legacy records; new app-side PawPrint checkouts are retired. See `docs/AUTOMATIONS.md` for catalog refresh operations.

Fur Reels is the customer-facing eight-second AI video generator. It combines a persisted source portrait, one of thirteen directed scripts, four timed beats, lighting, camera, native sound, and an optional short voice line. It is not the manual Animator. Generated video jobs retain the existing account-scoped persistence and credit-refund boundaries.

## Environment variables

Set these in Hostinger (Website → Environment variables) for production, or in `.env.local` for local dev. See `.env.example` for the full list.

| key | purpose |
| --- | --- |
| `JWT_SECRET` | Secret for signing session tokens (long random string, ≥16 chars) |
| `ADMIN_KEY` | Internal row key for the seeded admin account (any short string, e.g. `admin`). Not secret. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Admin login credentials. Admins log in through the normal login screen. |
| `GEMINI_API_KEY` | Google Gemini / Imagen / Veo API access |
| `APP_URL` | Public site URL — `https://pawsome3d.com` (used for Stripe redirects) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe Checkout + webhook. Endpoint: `https://pawsome3d.com/api/stripe-webhook`, events `checkout.session.completed` + `checkout.session.async_payment_succeeded` |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | MySQL connection |
| `GOOGLE_MAPS_API_KEY_SERVER` | Server‑side key: Street View, Places (landmarks), Community nearby parks + weather. Enable Street View Static, Places, and Weather APIs. No HTTP‑referrer restriction (server calls). |
| `VITE_GOOGLE_MAPS_API_KEY_BROWSER` | Browser Maps/Places (HTTP‑referrer‑restricted to pawsome3d.com). Baked in at build time. |
| `MEDIA_BUCKET_NAME` / `MEDIA_BUCKET_URL` / `MEDIA_BUCKET_KEY` / `MEDIA_BUCKET_SECRET` | Object storage for generated media |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | Twilio SMS API for request fulfillment notifications |
| `TRIPO_API_KEY` | Tripo3D API key for reference views, 3D models, textures, body rigs, and animation tasks. Provider account limits remain authoritative. |
| `PETSIM_IMAGE_GENERATION_ENABLED` | Kill switch for shared Gemini/Imagen image-output calls; applies to admins too |
| `PETSIM_IMAGE_GENERATION_DAILY_CAP` / `PETSIM_IMAGE_GENERATION_GLOBAL_DAILY_CAP` | Database-backed actual provider-call caps; defaults `5` per user and `50` globally per database UTC day |
| `PETSIM_IMAGE_GENERATION_GLOBAL_MINUTE_CALL_CAP` | Database-backed shared provider-call cap; default `10` calls per 60-second window, leaving headroom below the observed 20 RPM Nano Banana Pro quota. The Flash reference path has its own independent cap. |
| `PETSIM_IMAGE_GENERATION_ESTIMATED_COST_MICRO_USD` / `PETSIM_IMAGE_GENERATION_GLOBAL_DAILY_COST_MICRO_USD` | Per-call cost reservation and aggregate daily stop for shared image output |
| `HEYGEN_API_KEY` / `HEYGEN_DEFAULT_VOICE_ID` | HeyGen API for talking avatar video generation |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_MODEL_ID` / `ELEVENLABS_DEFAULT_VOICE_ID` | Animator live voice preview; defaults are documented in `.env.example` |
| `RHUBARB_BIN` | Optional absolute path to the Rhubarb Linux executable; enables Tier B visemes and falls back to Tier A when absent |
| `BLENDER_WORKER_URL` | URL of the Azure Container Apps blender microservice (e.g. `https://pawsome3d-blender-worker.<env>.eastus.azurecontainerapps.io`) |
| `WORKER_SHARED_SECRET` | Secret key for blender-worker auth |
| `BARKLEY_PRESENTER` | Enables the Barkley presenter API and stage; off unless set to `true`/`1`. Requires `public/barkley/barkley.glb` in the deployed archive — with the flag on and the asset missing, the stage silently renders a placeholder. |
| `MODEL_BUILD_V3_ENABLED` / `RIG_PIPELINE_V4_ENABLED` | Default-off durable model and measured rig rollout flags |
| `FUR_BIN_V5_ENABLED` / `VITE_FUR_BIN_V5_ENABLED` | Fur Bin API and build-time UI flags; enabled for generated GLB delivery |
| `PET_GLB_BODY_RIG_ENABLED` | Emergency rollback switch for the paid Pet GLB body-rig stage; defaults on and is independent of legacy `PETSIM_RIG_*` caps |
| `MODEL_FEEDBACK_EMAIL` / `RESEND_API_KEY` / `MAIL_FROM` | Destination and sender configuration for Toss-it GLB feedback |
| `FAL_KEY` | fal.ai API key; shared by Fur Reels video generation (8s Veo 3.1 Fast, 15s Kling 3.0 Pro) and offline PBR material authoring |
| `STATIONERY_V2_ENABLED` | Enable only with the Stationery render worker, database, shipping-recipient UI, Printful/Slant3D credentials, variant map, and webhook secrets configured. The v2 path creates and submits provider orders, then reconciles signed callbacks. |
| `STATIONERY_RENDER_WORKER_URL` / `STATIONERY_RENDER_WORKER_SECRET` | HTTPS render-worker endpoint and HMAC secret for dispatch and trusted completion callbacks |
| `PRINTFUL_API_KEY` / `PRINTFUL_STORE_ID` / `PRINTFUL_STATIONERY_VARIANT_MAP` | Printful API credentials and JSON mapping from Stationery SKUs to numeric Printful variants |
| `SLANT3D_API_KEY` / `SLANT3D_PLATFORM_ID` / `SLANT3D_DEFAULT_FILAMENT_ID` | Slant3D API credentials and print material used by the Stationery adapter |
| `PRINTFUL_WEBHOOK_SECRET` / `SLANT3D_WEBHOOK_SECRET` | Provider callback HMAC secrets |
| `WAGS_V2_ENABLED` / `WAGS_STRIPE_WEBHOOK_SECRET` | Keep `false` until the separate Wags Stripe webhook and sandbox gate pass and one Plus box can reserve its seven image assets atomically. Plus materialization currently fails closed before the first provider call. |
| `BIM_V2_ENABLED` / `VITE_BIM_V2_ENABLED` | Keep both `false` until accepted-model, Shell-worker, IFC-worker, and browser gates pass |
| `INHOUSE_SPATIAL_GENERATOR_ENABLED` | Keep `false` until the Pixel/Hermes, Blender, attachment-source, and orchestrator readiness blockers are resolved. If enabled early, the release now fails closed before any spatial-job PupCoin reservation. Organic avatars still use Tripo. |
| `LAYER8_BASE_URL` | Base URL for Layer8 control plane (e.g., `https://layer8.pawsome.ai`) | |
| `LAYER8_TENANT_API_KEY` | Tenant API key for Layer8 spatial operations | |
| `LAYER8_SPATIAL_TIMEOUT_MS` | Optional timeout for Layer8 spatial calls (default 30000) | |
| `SHOPIFY_STORE_DOMAIN` / `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` / `SHOPIFY_API_VERSION` | Read-only Admin GraphQL access used to refresh the public `/store` runtime catalog snapshot. The ID and secret must be the matched pair for the Hostinger catalog app installed on that store; do not mix them with the separate read-only external-routine app in `tools/shopify-app`. |
| `SHOPIFY_CATALOG_SYNC_SECRET` | Long random Bearer token for the scheduled `POST /api/admin/shopify/catalog-sync` request. |
| `SHOPIFY_WEBHOOK_SECRET` | Signing secret from the `orders/paid` / `orders/cancelled` webhooks registered in Shopify Admin → Settings → Notifications, pointed at `POST /api/webhooks/shopify-orders`. Without it that route 401s every delivery rather than trusting an unsigned request. |
| `RUNTIME_LOG_API_KEY` | Shared secret for `GET /api/admin/runtime-log` — lets the scheduled "Pawsome3D Runtime Log Watch" routine read `logs/runtime-*.log` over plain HTTPS, since this host exposes no live runtime-log API of its own. See `docs/AUTOMATIONS.md`. |

> **Hostinger note:** set `DB_HOST` to `127.0.0.1`, not `localhost`. On Node 18+, `mysql2` resolves `localhost` to IPv6 (`::1`), which the Hostinger MySQL user grant does not cover — causing `Access denied … @'::1'`. Forcing IPv4 with `127.0.0.1` resolves it.

## Running locally

Prerequisites: Node.js 24.18 and a reachable MySQL database.

```bash
npm install          # install dependencies
# populate .env.local from .env.example
npm run dev          # start the Express + Vite dev server (tsx server.ts)
```

Other scripts:

```bash
npm run build        # vite build + bundle server.ts -> dist/server.cjs
npm start            # run the production bundle (node dist/server.cjs)
npm run lint         # type-check with tsc --noEmit
```

## Deployment

The pawsome3d.com Hostinger site is a **Node.js app deployed by manual zip upload** — it is **not** wired to auto‑deploy from GitHub. Pushing to `main` updates the repo but does **not** change the live site.

The deploy zip is **pre-built locally** under the pinned Node release. Hostinger installs the locked external runtime dependencies, runs the staged no-op build script, and launches the already verified `dist/server.cjs`; it does not recompile the application on its older Node 24 minor.

1. Commit your work (the zip archives `HEAD`, so uncommitted changes are excluded).
2. Build the zip under the pinned Node release: `bash scripts/build-deploy-zip.sh` → `pawsome3d-deploy.zip`. The script compiles the exact clean commit, verifies `dist/release-manifest.json`, and packages the built application with its locked runtime dependencies and Hostinger launcher.
3. In hPanel: **Websites → pawsome3d.com → Deployments → Settings and redeploy → Upload new files** → upload the zip → redeploy.
4. Hostinger runs `npm install && npm run build` (the build is a verified no-op), then starts root **`server.cjs`**, which loads **`dist/server.cjs`**. Tables auto‑create on boot via `initDb()`.

The server auto-detects prod by the presence of `dist/index.html`; if the build is skipped, `index.html` at the repo root is a Vite **dev** template (`/src/main.tsx`) and the page renders blank. Environment variables live in Hostinger's deployment config (Deployments → Settings), not in a committed file.

The latest production 3D-builder verification, including the exact credit boundary and unresolved rig/collar gates, is recorded in [`docs/current/PRODUCTION_3D_SWEEP_2026-07-30.md`](docs/current/PRODUCTION_3D_SWEEP_2026-07-30.md).
