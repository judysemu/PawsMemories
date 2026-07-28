# Pawsome3D Deployment Panels and Environment Variables

Last verified against repository commit `3c29854328e4b539796b42cca9d1de458706e5c0` on 2026-07-23.

This is the deployment source of truth for the three current services:

1. Hostinger Node application — the public Pawsome3D website and API.
2. Render Docker worker — Blender, rigging, STL, physics, and IFC work.
3. Render Node worker — the optional X direct-message service.

## Secret-handling rule

Values written as `<KEEP EXISTING SECRET>` or `<REQUIRED SECRET>` must be entered
directly in the provider's secret/environment panel. Never commit their real values
to this file, `.env`, GitHub, a deployment ZIP, or a browser-visible `VITE_*`
variable.

Public service URLs, model names, feature flags, limits, and public provider IDs
are included where they are already known.

---

## 1. Hostinger Node application

### hPanel deployment settings

Open **Websites → pawsome3d.com → Node.js / Deployments → Settings** and use:

| Panel field | Value |
|---|---|
| Domain | `pawsome3d.com` |
| Application root | Root of the extracted `pawsome3d-deploy.zip` |
| Node.js version | Node `24.x`; use `24.15.0` or newer when Hostinger offers it |
| Package manager | `npm` 11 or newer |
| Install command | `npm install` (Hostinger may run this automatically) |
| Build command | `npm run build` |
| Start command | `npm start` |
| Startup file, if hPanel asks for one | `server.cjs` |
| Application mode | `production` |
| Port | Let Hostinger inject `PORT`; do not hardcode it unless hPanel requires one |
| Deployment package | `pawsome3d-deploy.zip` |

The Hostinger ZIP is prebuilt. Its `npm run build` command only verifies the
artifact and its `npm start` command runs the root `server.cjs` launcher. Do not
set the startup file to source `server.ts`.

The repository source package runs `dist/server.cjs`; the Hostinger ZIP wraps
that file with `server.cjs`. The hPanel startup file for the ZIP is therefore
**`server.cjs`**.

### Required core variables

These values are required for login, the database, model generation, saved media,
the Blender worker, and payments.

| Variable | Value to enter | Secret? | Purpose |
|---|---|---:|---|
| `NODE_ENV` | `production` | No | Production runtime |
| `APP_URL` | `https://pawsome3d.com` | No | Redirects, links, and callbacks |
| `DEPLOY_TARGET` | `main` | No | Main Pawsome3D experience |
| `DB_HOST` | `srv1544.hstgr.io` | No | Hostinger MySQL hostname supplied for this database |
| `DB_PORT` | `3306` | No | MySQL port |
| `DB_NAME` | `u876474286_pawsome3d_app` | No | MySQL database |
| `DB_USER` | `u876474286_robco_tech` | No | MySQL user |
| `DB_PASSWORD` | `<KEEP EXISTING SECRET>` | **Yes** | MySQL password |
| `JWT_SECRET` | `<KEEP EXISTING SECRET>` | **Yes** | Session token signing |
| `ADMIN_KEY` | `admin` | No | Internal admin row key |
| `ADMIN_EMAIL` | `robs46859@gmail.com` | No | Admin login email |
| `ADMIN_PASSWORD` | `<KEEP EXISTING SECRET>` | **Yes** | Admin login password |
| `GEMINI_API_KEY` | `<KEEP EXISTING SECRET>` | **Yes** | Image, text, classification, and planning |
| `TRIPO_API_KEY` | `<KEEP EXISTING SECRET>` | **Yes** | Image-to-3D generation |
| `MEDIA_BUCKET_NAME` | `pawsmemories-media` | No | Backblaze public/generated-media bucket |
| `MEDIA_BUCKET_URL` | `https://s3.us-east-005.backblazeb2.com` | No | Backblaze S3 endpoint |
| `MEDIA_BUCKET_KEY` | `<KEEP EXISTING SECRET>` | **Yes** | Backblaze key ID |
| `MEDIA_BUCKET_SECRET` | `<KEEP EXISTING SECRET>` | **Yes** | Backblaze application key |
| `MEDIA_PRIVATE_BUCKET_NAME` | `pawsmemories-private` | No | Paid/private GLB and STL bucket |
| `MEDIA_PRIVATE_BUCKET_KEY` | `<REQUIRED SECRET OR LEAVE BLANK TO REUSE MEDIA_BUCKET_KEY>` | **Yes** | Private bucket key |
| `MEDIA_PRIVATE_BUCKET_SECRET` | `<REQUIRED SECRET OR LEAVE BLANK TO REUSE MEDIA_BUCKET_SECRET>` | **Yes** | Private bucket secret |
| `MEDIA_SIGNED_URL_TTL_SECONDS` | `900` | No | Private download lifetime |
| `BLENDER_WORKER_URL` | `https://pawsmemories.onrender.com/render` | No | Render Blender worker |
| `WORKER_SHARED_SECRET` | `<KEEP EXISTING SECRET; MUST MATCH RENDER DOCKER>` | **Yes** | Authenticates worker calls |
| `BIM_WORKER_TIMEOUT_MS` | `180000` | No | Worker request timeout |
| `STRIPE_SECRET_KEY` | `<KEEP EXISTING LIVE SECRET>` | **Yes** | Stripe API |
| `STRIPE_WEBHOOK_SECRET` | `<KEEP EXISTING WEBHOOK SECRET>` | **Yes** | Verifies `/api/stripe-webhook` |
| `GOOGLE_MAPS_API_KEY_SERVER` | `<KEEP EXISTING SECRET>` | **Yes** | Server Places, Street View, and Weather calls |

Use the supplied remote database hostname above. Use `127.0.0.1` only if the
Hostinger database connection screen for this exact Node application explicitly
states that MySQL is local to the same host.

### Frontend build-time variables

`VITE_*` variables are compiled into the browser bundle. Changing them in
Hostinger after uploading a prebuilt ZIP does **not** change that ZIP.

| Variable | Value during the local release build |
|---|---|
| `VITE_GOOGLE_MAPS_API_KEY_BROWSER` | `<BROWSER-RESTRICTED GOOGLE MAPS KEY>` |
| `VITE_MULTIVIEW_APPROVAL_ENABLED` | `false` |
| `VITE_FUR_BIN_V5_ENABLED` | `false` |
| `VITE_BIM_V2_ENABLED` | `false` |

The browser Google key is not a server secret, but it must be restricted in
Google Cloud to `https://pawsome3d.com/*` and
`https://www.pawsome3d.com/*`, and only to the browser APIs it needs.

### Current AI and model settings

| Variable | Current/recommended value |
|---|---|
| `GEMINI_IMAGE_MODELS` | `gemini-3-pro-image,gemini-3.1-flash-image,gemini-3.1-flash-lite-image,gemini-2.5-flash-image` |
| `GEMINI_IMAGE_MODELS_DRAFT` | `gemini-3.1-flash-lite-image,gemini-3.1-flash-image` |
| `GEMINI_IMAGE_MODELS_STANDARD` | `gemini-3.1-flash-image,gemini-2.5-flash-image` |
| `GEMINI_IMAGE_MODELS_STUDIO` | `gemini-3-pro-image,gemini-3.1-flash-image` |
| `GEMINI_TEXT_MODEL` | `gemini-2.5-flash` |
| `GEMINI_TEXT_FALLBACK_MODEL` | `gemini-2.5-flash-lite` |
| `GEMINI_HERMES_MODEL` | `gemini-2.5-flash` |
| `GEMINI_WAGS_MODEL` | `gemini-2.5-flash` |
| `BIM_PROPOSAL_MODEL` | `gemini-2.5-flash` |
| `TRIPO_MODEL_VERSION` | `default` |
| `MODEL_CAP` | `5` |

`TRIPO_RIG_MODEL_VERSION` appeared in older configuration notes, but the current
code reads `TRIPO_MODEL_VERSION`. Do not rely on the older name.

### Current paid-operation controls

| Variable | Value |
|---|---|
| `PETSIM_PAID_APIS_ENABLED` | `true` |
| `PETSIM_CLASSIFY_ENABLED` | `true` |
| `PETSIM_SEMANTIC_SCAN_ENABLED` | `true` |
| `PETSIM_RIG_ENABLED` | `false` |
| `PETSIM_CLASSIFY_DAILY_CAP` | `25` |
| `PETSIM_RIG_DAILY_CAP` | `5` |
| `PETSIM_SEMANTIC_SCAN_DAILY_CAP` | `50` |
| `PETSIM_CLASSIFY_GLOBAL_DAILY_CAP` | `250` |
| `PETSIM_RIG_GLOBAL_DAILY_CAP` | `0` |
| `PETSIM_SEMANTIC_SCAN_GLOBAL_DAILY_CAP` | `500` |
| `PETSIM_CLASSIFY_ESTIMATED_COST_MICRO_USD` | `10000` |
| `PETSIM_RIG_ESTIMATED_COST_MICRO_USD` | `1000000` |
| `PETSIM_SEMANTIC_SCAN_ESTIMATED_COST_MICRO_USD` | `10000` |
| `PETSIM_CLASSIFY_GLOBAL_DAILY_COST_MICRO_USD` | `2500000` |
| `PETSIM_RIG_GLOBAL_DAILY_COST_MICRO_USD` | `0` |
| `PETSIM_SEMANTIC_SCAN_GLOBAL_DAILY_COST_MICRO_USD` | `5000000` |

### Physical fulfillment

#### Slant 3D — 3D-printed models

The Slant integration becomes available only when all three required IDs are set.

| Variable | Value |
|---|---|
| `SLANT3D_API_KEY` | `<REQUIRED SLANT SECRET>` |
| `SLANT3D_PLATFORM_ID` | `<REQUIRED SLANT PLATFORM ID>` |
| `SLANT3D_DEFAULT_FILAMENT_ID` | `<REQUIRED SLANT FILAMENT ID>` |
| `SLANT3D_API_BASE_URL` | `https://slant3dapi.com/v2/api` |
| `FULFILLMENT_MIN_MARGIN_CENTS` | `500` |
| `FULFILLMENT_MARKUP_PERCENT` | `80` |

No `SLANT3D_AUTH_URL` is read by the current application. Do not add one.

#### Printful — Pawprints stationery

Printful uses an API token. A store ID is needed only when the token can access
more than one store or Printful requires an explicit store context.

| Variable | Value |
|---|---|
| `PRINTFUL_API_KEY` | `<REQUIRED PRINTFUL PRIVATE TOKEN>` |
| `PRINTFUL_API_BASE_URL` | `https://api.printful.com` |
| `PRINTFUL_STORE_ID` | `<PRINTFUL STORE ID; OPTIONAL FOR A SINGLE-STORE TOKEN>` |
| `PRINTFUL_PAWPRINT_VARIANT_ID` | `<LEGACY SINGLE PRODUCT VARIANT ID>` |
| `PRINTFUL_PAWPRINT_TEMPLATE_ID` | `<LEGACY SINGLE PRODUCT TEMPLATE ID>` |
| `PAWPRINT_PRINT_PRODUCTS_JSON` | `<RECOMMENDED SERVER-OWNED PRODUCT ARRAY; EXAMPLE BELOW>` |

Example:

```text
[{"code":"poster-8x10","label":"8 × 10 Art Print","description":"Museum-quality matte poster","variantId":123,"templateId":456,"widthIn":8,"heightIn":10,"priceCents":2499}]
```

Replace `123` and `456` with the real Printful variant and template IDs. The
variant ID identifies the printable catalog size/product; the template ID
identifies the saved design template.

### Email, SMS, voice, and animator variables

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | `<REQUIRED SECRET IF EMAIL IS ENABLED>` |
| `MAIL_FROM` | `noreply@pawsome3d.com` |
| `PRINT_REQUEST_EMAIL` | `rob@stelar.host` |
| `SMS_PROVIDER` | `telnyx` |
| `SMS_FROM` | `+12154840960` |
| `TELNYX_API_KEY` | `<KEEP EXISTING SECRET>` |
| `TELNYX_MESSAGING_PROFILE_ID` | `40019f56-f72b-4ed9-a855-4d31a58a94eb` |
| `TELNYX_VERIFY_PROFILE_ID` | `4900019f-5c41-45cc-9ba1-d5b81be5089a` |
| `ELEVENLABS_API_KEY` | `<KEEP EXISTING SECRET>` |
| `ELEVENLABS_MODEL_ID` | `eleven_multilingual_v2` |
| `ELEVENLABS_DEFAULT_VOICE_ID` | `Myn1LuZgd2qPMOg9BNtC` |
| `HEYGEN_API_KEY` | `<KEEP EXISTING SECRET IF TALKING VIDEO IS ENABLED>` |
| `HEYGEN_DEFAULT_VOICE_ID` | `1601b13a4a8e4902a9e848da0c129bce` |
| `ANIMATOR_WORKER_ENABLED` | `true` |
| `ANIMATOR_WORKER_CONCURRENCY` | `1` |
| `ANIMATOR_STALE_MS` | `600000` |
| `VIDEO_JOB_STALE_MS` | `1200000` |
| `ANIMATOR_DATA_DIR` | `/home/u876474286/domains/pawsome3d.com/nodejs/data/animator` |
| `RHUBARB_BIN` | `/home/u876474286/tools/rhubarb/Rhubarb-Lip-Sync-1.14.0-Linux/rhubarb` |

The absolute `ANIMATOR_DATA_DIR` path must exist and be writable by the Node
application. If that Hostinger release path is not persistent on the current
plan, leave the variable unset and the app will use `./data/animator`.

The Rhubarb path is optional. If that executable is not installed at the exact
path, leave `RHUBARB_BIN` unset so the app can fall back cleanly.

The separate Python studio proxy uses `STUDIO_SERVICE_URL` and defaults to
`http://localhost:8001`. Leave it unset while that studio is disabled. If the
Python studio is deployed later, set it to that service's private HTTPS base URL
and configure its own `OPENAI_API_KEY` securely.

### Optional OpenAI-compatible model route

The in-process agent graph can use an OpenAI-compatible endpoint. It falls back
to Gemini when these are absent.

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | `<OPTIONAL PROVIDER SECRET>` |
| `OPENAI_BASE_URL` | `https://openrouter.ai/api/v1` |
| `OPENAI_HTTP_REFERER` | `https://pawsome3d.com` |
| `OPENAI_X_TITLE` | `Pawsome3D` |

### Hermes

Hermes is server-side only. The known relay URL is included, but the current
production-safe state is disabled.

| Variable | Current value |
|---|---|
| `HERMES_ENABLED` | `false` |
| `HERMES_EDGE_BRIDGE_URL` | `https://hermes.pawsome3d.com` |
| `HERMES_EDGE_PRODUCER_SECRET` | `<KEEP EXISTING SECRET>` |
| `HERMES_TIMEOUT_MS` | `10000` |

Only change `HERMES_ENABLED` to `true` after the bridge health check and
authenticated producer request both pass.

### Dark-launch feature flags

Keep these exact values for the current deployment:

| Variable | Value |
|---|---|
| `MULTIVIEW_APPROVAL_ENABLED` | `false` |
| `MODEL_BUILD_V3_ENABLED` | `false` |
| `RIG_PIPELINE_V4_ENABLED` | `false` |
| `FUR_BIN_V5_ENABLED` | `false` |
| `STATIONERY_V2_ENABLED` | `false` |
| `WAGS_V2_ENABLED` | `false` |
| `BIM_V2_ENABLED` | `false` |
| `TEXTURE_STYLIZE_ENABLED` | `false` |

Leave these associated secrets unset while their features remain disabled:

- `WAGS_STRIPE_WEBHOOK_SECRET`
- `STATIONERY_RENDER_WORKER_URL`
- `STATIONERY_RENDER_WORKER_SECRET`
- `PRINTFUL_WEBHOOK_SECRET`
- `SLANT3D_WEBHOOK_SECRET`

### Optional Hostinger tuning

These may be omitted unless tuning is needed:

| Variable | Default/recommended value |
|---|---|
| `DB_CONNECTION_LIMIT` | `10` |
| `DB_MAX_IDLE` | `10` |
| `DB_IDLE_TIMEOUT_MS` | `60000` |
| `DB_CONNECT_TIMEOUT_MS` | `10000` |
| `DB_KEEPALIVE_DELAY_MS` | `0` |
| `DB_QUEUE_LIMIT` | `0` |
| `PORT` | Hostinger-managed; application fallback is `3000` |
| `ALLOWED_ORIGINS` | Leave unset for same-origin |
| `APP_COMMIT_SHA` | Release commit, if the deployment process does not inject it |
| `APP_BUILD_TIME` | ISO-8601 release time, if not already in the manifest |
| `APP_BRANCH` | `main` |

### Variables not needed in Hostinger

- `AUTH_URL` — not read by this build.
- `DATABASE_URL` — not needed when the five `DB_*` variables are configured.
- `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, and `REDIS_URL` — not read by the
  current main application.
- `STUDIO_BLENDER_PATH`, `STUDIO_FFMPEG_PATH`, and `STUDIO_S3_BUCKET` — legacy
  names not read by the current main application.
- `HUGGINGFACE_SPACE`, `HUGGINGFACE_TOKEN`, `MESHY_API_KEY`, `OLLAMA_API_URL`,
  and `OLLAMA_MODEL` — legacy provider values not read by the current build.
- `PRIVATE_MEDIA_BUCKET_*` — obsolete name order. Use
  `MEDIA_PRIVATE_BUCKET_*`.
- Twilio variables — current SMS integration uses Telnyx.
- `X_DM_*` variables — belong only to the optional Render Node worker.
- `BLENDER_BRIDGE_*`, `BLENDER_BIN`, `IFC_*`, and
  `RIG_PIPELINE_SOURCE_HOSTS` — belong only to the Render Docker worker.

---

## 2. Render Docker worker — Blender/rigging/IFC

### Render panel settings

| Panel field | Value |
|---|---|
| Service name | `PawsMemories` |
| Service ID | `srv-d8mpjr8k1i2s7390v8h0` |
| Service type | Web Service → Docker |
| Public URL | `https://pawsmemories.onrender.com` |
| Repository | `robs46859-eng/PawsMemories` |
| Branch | `main` |
| Root directory / Docker build context | `blender-worker` |
| Dockerfile path | `./Dockerfile` |
| Docker command | Use Dockerfile `CMD`; do not override |
| Health-check path | `/health` |
| Auto deploy | On for `main`, or manual if release-gated |

The Dockerfile uses Node 20 and installs Blender 5.1.2. It starts
`node server.js` through `npm start`.

### Required Render Docker variables

| Variable | Value |
|---|---|
| `WORKER_SHARED_SECRET` | `<SAME EXACT SECRET AS HOSTINGER>` |
| `PORT` | `10000` |
| `IFC_MAX_CONCURRENT` | `1` |

### Recommended worker hardening

| Variable | Value |
|---|---|
| `RIG_PIPELINE_SOURCE_HOSTS` | `s3.us-east-005.backblazeb2.com` |
| `BLENDER_AUTOSTART_BRIDGE` | `true` |
| `BLENDER_BIN` | `/usr/bin/blender` |
| `BLENDER_BRIDGE_HOST` | `127.0.0.1` |
| `BLENDER_BRIDGE_PORT` | `9876` |
| `IFC_PYTHON` | `python3` |

`RIG_PIPELINE_SOURCE_HOSTS` must contain every exact hostname from which the
worker is allowed to download signed model sources. Use comma-separated
hostnames only—no scheme, path, or wildcard. Add another exact hostname if
private signed URLs are issued from a different Backblaze hostname.

Usually omit `BLENDER_BRIDGE_SCRIPT`; its code default is
`bridge/tcp_server.py` inside the container. Set it only when intentionally
overriding the packaged bridge.

### Docker worker variables not needed

The Docker worker does not need database, Stripe, Gemini, Tripo, Printful,
Slant, Telnyx, Resend, or Backblaze credentials. It receives authenticated,
bounded jobs from the Hostinger application.

---

## 3. Render Node worker — optional X-DM service

This is a separate service from the Blender Docker worker. Its known public
hostname is `https://pawsmemories-1.onrender.com`.

The safest current setting is to **suspend this service** because X-DM polling is
not part of the production website flow. If it remains online, keep polling off.

### Render panel settings if retained

| Panel field | Value |
|---|---|
| Service type | Web Service → Node |
| Repository | `robs46859-eng/PawsMemories` |
| Branch | `main` |
| Root directory | `x-dm-service` |
| Runtime | Node 20 or newer |
| Build command | `npm install && npm run build` |
| Start command | `npm start` |
| Health-check path | `/health` |
| Public URL | `https://pawsmemories-1.onrender.com` |

### Required X-DM variables if retained

The X-DM configuration loader refuses to start unless every required field below
is present, even when polling is disabled.

| Variable | Value |
|---|---|
| `X_CLIENT_ID` | `<X OAUTH CLIENT ID>` |
| `X_CLIENT_SECRET` | `<X OAUTH CLIENT SECRET>` |
| `X_CONSUMER_SECRET` | `<X CONSUMER SECRET>` |
| `X_BOT_USER_ID` | `<X BOT USER ID>` |
| `DB_HOST` | `srv1544.hstgr.io` |
| `DB_PORT` | `3306` |
| `DB_NAME` | `u876474286_pawsome3d_app` |
| `DB_USER` | `u876474286_robco_tech` |
| `DB_PASSWORD` | `<KEEP EXISTING SECRET>` |
| `BLENDER_WORKER_URL` | `https://pawsmemories.onrender.com` |
| `WORKER_SHARED_SECRET` | `<SAME EXACT SECRET AS HOSTINGER AND DOCKER WORKER>` |
| `LLM_API_KEY` | `<OPENROUTER OR COMPATIBLE LLM SECRET>` |
| `LLM_MODEL` | `<EXPLICIT PROVIDER MODEL NAME>` |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` |
| `MEDIA_BUCKET_NAME` | `pawsmemories-media` |
| `MEDIA_BUCKET_URL` | `https://s3.us-east-005.backblazeb2.com` |
| `MEDIA_BUCKET_KEY` | `<KEEP EXISTING SECRET>` |
| `MEDIA_BUCKET_SECRET` | `<KEEP EXISTING SECRET>` |
| `X_DM_POLLING_ENABLED` | `false` |
| `PORT` | Let Render inject it; fallback is `3001` |

### Optional X-DM variables

| Variable | Default/value |
|---|---|
| `X_BOT_ACCESS_TOKEN` | `<OPTIONAL SECRET>` |
| `X_BOT_REFRESH_TOKEN` | `<OPTIONAL SECRET>` |
| `X_WEBHOOK_URL` | `https://pawsmemories-1.onrender.com` or the exact registered callback base |
| `X_BEARER_TOKEN` | `<OPTIONAL APP-ONLY BEARER TOKEN>` |
| `X_CONSUMER_KEY` | `<OPTIONAL OAUTH 1.0A CONSUMER KEY>` |
| `X_ACCESS_TOKEN` | `<OPTIONAL OAUTH 1.0A USER TOKEN>` |
| `X_ACCESS_TOKEN_SECRET` | `<OPTIONAL OAUTH 1.0A USER TOKEN SECRET>` |
| `DM_DAILY_SEND_CAP` | `400` |
| `HARVEST_MAX_POSTS_PER_RUN` | `300` |

Do not copy the X-DM variables into Hostinger or the Blender worker.

---

## 4. Shared-value matrix

Only one value must be byte-for-byte identical across all active services:

| Variable | Hostinger | Render Docker | Render Node X-DM |
|---|---:|---:|---:|
| `WORKER_SHARED_SECRET` | Required | Required | Required only if X-DM retained |

Database and media variables are shared by Hostinger and X-DM only. The Docker
worker must not receive those credentials.

---

## 5. Restart and verification

Changing any server-side variable requires restarting or redeploying that service.
Uploading files alone does not guarantee an existing Node process has reloaded its
environment.

After deployment:

1. Deploy the Render Docker worker and wait for `Live`.
2. Confirm `https://pawsmemories.onrender.com/health` succeeds.
3. Deploy the Hostinger ZIP and restart/redeploy the Node application.
4. Confirm `https://pawsome3d.com/readyz` reports ready.
5. Confirm `https://pawsome3d.com/version` reports the intended commit and schema.
6. Confirm the Hostinger and Render Docker `WORKER_SHARED_SECRET` values match.
7. Suspend the X-DM service, or confirm its logs show
   `X_DM_POLLING_ENABLED=false` and no repeated authorization failures.
8. Verify the Stripe endpoint is
   `https://pawsome3d.com/api/stripe-webhook` and its signing secret matches
   `STRIPE_WEBHOOK_SECRET`.

## 6. Deployment ZIP currently associated with this reference

| Item | Value |
|---|---|
| File | `pawsome3d-deploy.zip` |
| Commit | `3c29854328e4b539796b42cca9d1de458706e5c0` |
| SHA-256 | `5101416650516e4f8106614ee856b9e53835dc3b0aba5df233cff75ce79a9966` |
| Expected schema | `30` |
