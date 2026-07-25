# Pawsome3D

Turn your pet photos into a living 3D avatar you can play with, dress up, and place in your room in AR — guided by Randy, an AI assistant. Pawsome3D is a full‑stack web app with email + password sign‑in, a credits system, AI image + Image‑to‑3D generation, a merch Store, a Community hub, and the option to order physical keepsakes.

Live site: https://pawsome3d.com  (formerly mypets.cc)

## Features

- **3D pet avatars** — photos → a 3D avatar via Tripo3D, with a default-off authenticated Blender pipeline for measured body/facial rigging and fused accessory print derivatives.
- **Fur Bin showcase** — a default-off private model library and public-derivative showcase with immutable versions, measured capability badges, moderation, and rollback.
- **Scaled building lab** — calibrated text/image proposals, low-cost visual Shell and higher-cost IFC/BIM choices, and verification before and after construction. The durable v2 release path remains disabled until live worker/UI acceptance.
- **AR virtual pet (WebXR / ARCore)** — place your avatar on real surfaces on Android Chrome; plane + mesh detection, drift‑free `XRAnchor` placement, and footprint center‑of‑gravity grounding so the pet plants on its feet. iOS falls back to the 8th Wall engine. The AR view is driven by an autonomous **behavior brain** (drives, hormones, reinforcement) with voice‑command training, gesture reinforcement, semantic‑scan navigation, and disc/agility trials — see `AR_PET_SIM_SPEC.md`.
- **Store** — merch (3D prints, plush, accessories) with your Albums folded in as a tab.
- **Community** — local info (nearby parks, weather, pet‑recall news), a live pet inspiration board (dog.ceo + dogapi.dog) with user‑uploaded memories, and a coming‑soon roadmap.
- **Credits** — server‑backed ledger with earn/spend history, persisted daily bonus, per‑day‑capped share rewards, and Stripe credit‑pack purchases (webhook + redirect‑confirm double safety net).
- **Profile** — avatar thumbnail uploader + a personal photo library; photos uploaded in the avatar builder persist here automatically.
- **Animation Studio Tooling** — A multi-actor Three.js studio with layered animation, blend spaces, emote scheduling, Theatre camera control, project persistence, Director scripts, CC0 clip discovery, IK, recording, and live ElevenLabs/Rhubarb lip-sync preview. The current production baseline is Animator Phase 2; later rigging, LOD, frame-accurate sequencing, realtime ML, and agentic batch phases remain incomplete as documented in `PHASED_IMPLEMENTATION.md`.
- **Randy AI** — Gemini‑powered pet guide (spec for a 3D talking head in `RANDY_AI_SPEC.md`).

## Current release candidate

The schema 30 acceptance-correction release adds fail-closed full-body human
reference checks, durable create-pipeline recovery, authenticated Blender print
repair/validation, a visible real Voice Test, and a visible Scaled BIM preview.
Shop no longer routes the legacy marketplace or manual print-request panels;
physical manufacturing checkout remains in Create. Durable BIM and the other
Phase 2-9 dark-launch features remain disabled. Deploy the Render Blender worker
before installing the matching Hostinger archive because both sides of the worker
contract changed. Live-product debugging is deferred to the next release pass.

## Animator implementation status

The active phase definitions are in `PHASED_IMPLEMENTATION.md`; `handoff.md` records the audited next-agent state.

| Phase | Status | Current boundary |
|---|---|---|
| 0 Foundations | Complete | Contracts, availability guards, doctor, skills/personas |
| 1 Layered runtime | Complete | Layered mixer, masks, blend space, EmoteQueue, behavior bridge |
| 2 Lip-sync | Complete | Rhubarb Tier B, Tier A fallback, viseme player, live ElevenLabs preview, production UI |
| 3 Auto-rig | Partial foundation | Provider-free profile selection, bone masks, selective-rig planning, deterministic manifests, and corpus acceptance policy are tested; worker/Blender integration, production `/rig`, manual overrides, and the real acceptance corpus remain open |
| 4 Retargeting | Partial foundation | Existing clip/retarget paths do not satisfy the current plan's expanded library and QA exit gate |
| 5 Mesh processing | Scaffold | Tested Euler/LOD policy helpers are not wired into production geometry processing |
| 6 Sequencer/capture | Partial foundation | Theatre/capture modules exist; deterministic export, image sequence, audio lane, and `/bake` do not |
| 7 Realtime/ML | Scaffold | DSP primitives exist; live MFCC, ML rigging, reconstruction, and event classification do not |
| 8 Agentic batch | Scaffold | Manifest validation is dry-run-only; dispatch, retries, and aggregate QA are not implemented |

Older commits labeled “Phase 8/8.1 Animation Studio” use a previous numbering scheme. They provide Theatre/studio foundations but do not complete the current Phase 8 Agentic Operations scope. A phase is complete only when its production path and stated exit fixture pass, not when helper files or unit tests exist.

## Stabilization and AR hardening status

The active stabilization work is on `stabilize/ar-hardening-foundation`. P0, P1,
P2, and Animator Phase 3 remain **partial** until every exit gate in
`AR_PET_SIM_HARDENING_PLAN_V2.md` passes. Production rigging remains disabled by
default with `PETSIM_RIG_ENABLED=false`.

Current local evidence:

- 508/508 tests pass in the combined coverage run.
- Dedicated AR tests: 136/136; image-input security tests: 7/7; production-router
  contracts: 18/18; IFC worker tests: 5/5.
- Coverage baseline: 73.39% lines, 83.94% branches, and 72.45% functions.
- TypeScript, the production client/server build, dependency audit, and required
  Animator Doctor checks pass.
- Classify and semantic-scan routes reject malformed, mismatched, oversized, or
  structurally unsafe JPEG/PNG/WebP data before quota/provider calls.
- Rigging derives its provider task from the owned avatar and validates results before
  upload or persistence, but remains disabled pending the later hardening gates.

Remaining release gates include a green remote CI run, protected `main`, complete
production-app route coverage, trusted rate buckets, safe remote fetching, the
maximum-input memory profile, response-schema enforcement, and the real Animator
ten-mesh acceptance corpus. See `handoff.md`, `docs/P1_STATUS.md`, and
`docs/P2_IMPLEMENTATION_PLAN.md` for the exact evidence and blockers.

## Tech stack

- **Frontend:** React 19 + Vite 6, Tailwind CSS 4, Lucide icons, Motion for animation
- **Backend:** Node 24.18 + Express 4 (single `server.ts`, bundled to `dist/server.cjs` with esbuild)
- **Auth:** Email + password with JWT session tokens (passwords hashed with scrypt)
- **Database:** MySQL (via `mysql2`) for the user store
- **AI / 3D:** Google Gemini for chat, Imagen for stills, Veo for video. **Tripo3D** for Image-to-3D mesh generation (replaced Meshy for higher quality and reliability). Blender 3D via dedicated `bpy` microservice with EEVEE PBR rendering and 24-frame cycles.
- **Payments:** Stripe Checkout (memory requests, physical album orders, credit packs) with webhook verification
- **Notifications:** Twilio SMS for notifying users when their memory requests are fulfilled
- **Hosting:** Hostinger for main app. Render.com for the Blender microservice.

## How it fits together

The Express server does double duty: it serves the built Vite frontend from `dist/` and exposes the JSON API under `/api`. Authentication is email + password: a user signs up, is then required to complete a profile, and receives a 30‑day JWT that gates the rest of the app.

### Auth & gating flow

1. `POST /api/auth/signup` — creates an account from an **email + password**. Email must be unique. Returns a 30‑day JWT. New users start with a **profile‑incomplete** record (and 0 credits).
2. `POST /api/auth/complete-profile` — required for every new user. Saves full name, birthdate, city, and pets to MySQL, and grants **50 free credits** the first time the profile is completed.
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
- **Microservice Architecture**: Because the main app runs on Hostinger shared hosting, the generated `bpy` scripts are sent securely via HTTP to a dedicated Docker microservice (`blender-worker`) running on Render, which safely executes the render and returns the 3D Avatar.
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

Full spec: `AR_PET_SIM_SPEC.md`. Build status + decisions: `AR_PET_SIM_HANDOFF.md`.
Current hardening plan: `AR_PET_SIM_HARDENING_PLAN_V2.md`.

## Project structure

```
server.ts          Express app: static hosting + /api routes + Stripe webhook
auth.ts            Email/password helpers, JWT sign/verify, requireAuth middleware
db.ts              MySQL pool, table init, user/account CRUD helpers
src/               React frontend (App, components, api client, types)
  components/      SignUp, Dashboard, EditMemory, RequestMemory, AdminRequestPanel, ...
  brain/           Framework-agnostic pet behavior engine (drives, brain tick, reinforcement)
  three/ar/        AR stage + brain bridge (ARPetStage, IK, navmesh, voice, trials)
blender-worker/    Standalone Express + Docker microservice for running Blender scripts (+ bake_lod.py)
x-dm-service/      X DM conversation refinement service (Node 20 + Express + TypeScript) — see X_DM_REFINEMENT_SPEC.md
scripts/           build-deploy-zip.sh (verified dist → Hostinger deploy zip)
dist/              Build output (vite assets + server.cjs)
.env.example       Documented environment variables
```

Test runner is the built-in `node:test` via `tsx` (not Vitest): `npm test`, or scoped
`npm run test:brain`, `npm run test:pets`, `npm run test:ar`,
`npm run test:security`, `npm run test:contracts`, and `npm run test:coverage`.

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
| `TRIPO_API_KEY` | Tripo3D API key for Image-to-3D mesh generation (Primary 3D engine) |
| `HEYGEN_API_KEY` / `HEYGEN_DEFAULT_VOICE_ID` | HeyGen API for talking avatar video generation |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_MODEL_ID` / `ELEVENLABS_DEFAULT_VOICE_ID` | Animator live voice preview; defaults are documented in `.env.example` |
| `RHUBARB_BIN` | Optional absolute path to the Rhubarb Linux executable; enables Tier B visemes and falls back to Tier A when absent |
| `BLENDER_WORKER_URL` | URL to the separate blender microservice (e.g. `https://pawsmemories.onrender.com/render`) |
| `WORKER_SHARED_SECRET` | Secret key for blender-worker auth |
| `MODEL_BUILD_V3_ENABLED` / `RIG_PIPELINE_V4_ENABLED` | Default-off durable model and measured rig rollout flags |
| `FUR_BIN_V5_ENABLED` / `VITE_FUR_BIN_V5_ENABLED` | Default-off Fur Bin API and build-time UI flags |
| `STATIONERY_V2_ENABLED` | Keep `false`; provider shipping/sandbox gate is still open |
| `WAGS_V2_ENABLED` / `WAGS_STRIPE_WEBHOOK_SECRET` | Keep `false` until the separate Wags Stripe webhook and sandbox gate pass |
| `BIM_V2_ENABLED` / `VITE_BIM_V2_ENABLED` | Keep both `false` until accepted-model, Shell-worker, Render IFC, and browser gates pass |
| `INHOUSE_SPATIAL_GENERATOR_ENABLED` | Keep `false`; enables in-house accessory/hard-surface generator (Thermal Cascade: observe → plan → math → compile → draft → verify → approve → finalize). Replaces Tripo only for accessories, attachments, and printables. Organic avatars still use Tripo. | false |
| `LAYER8_BASE_URL` | Base URL for Layer8 control plane (e.g., `https://layer8.pawsome.ai`) | |
| `LAYER8_TENANT_API_KEY` | Tenant API key for Layer8 spatial operations | |
| `LAYER8_SPATIAL_TIMEOUT_MS` | Optional timeout for Layer8 spatial calls (default 30000) | |

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

The server auto‑detects prod by the presence of `dist/index.html`; if the build is skipped, `index.html` at the repo root is a Vite **dev** template (`/src/main.tsx`) and the page renders blank. Environment variables live in Hostinger's deployment config (Deployments → Settings), not in a committed file. For the full set of deploy gotchas — SPA catch-all masking `/api` 404s, the stale `.git/*.lock` workaround, three.js dedupe, CDN pins — see **`DEPLOYMENT_NOTES.md`**.
