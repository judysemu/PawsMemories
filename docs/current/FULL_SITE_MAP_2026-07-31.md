# Pawsome3D Full Site Map — 2026-07-31

## Public, indexable pages

- `/` — home
- `/3d-pet-models`, `/dog-3d-models`, `/cat-3d-models` — model landing pages
- `/pet-professionals`, `/glb-pet-models-guide` — professional and GLB guides
- `/denver`, `/philadelphia` — local landing pages
- `/guides` and `/guides/*` — guide hub and articles
- `/pricing`, `/how-it-works`, `/pet-memorial-models`
- `/create`, `/pawprints`, `/print-shop`
- `/product/:slug` — public product detail
- `/legal/privacy`, `/legal/terms`, `/legal/sms`

The canonical crawler list is `public/sitemap.xml`. Authenticated, administrative,
and API paths are intentionally excluded.

## Authentication and account

- `/sign-up`, `/profile`, `/store`, `/albums`, `/community`
- `/wags`, `/pet-health`, `/voice-test`

## Customer creation and assets

- `/create` — primary keepsake entry
- `/pet-glb` — tracked GLB generation and body rig
- `/fur-bin` — private generated-asset library, Keep/Toss feedback, downloads
- `/animator` — guided 8-second AI video generation with sound and voice preview
- `/pawprints`, `/fidos-styles`, `/print-shop`
- Retired `/create/*` bookmarks return to `/create`; `/creations` returns to `/fur-bin`.

## Administrative and internal surfaces

- `/admin/wags` — administrative Wags operations
- `/api/pet-glb/operator/*` — optional diagnostics and historical-order recovery;
  not a required customer release gate
- Internal animator source under `src/animator/` is not customer-routed.

## Production API groups

- `/api/auth/*`, `/api/me`, `/api/profile/*` — identity and profile
- `/api/creations/*`, `/api/albums/*`, `/api/community/*` — customer media
- `/api/reference-sessions/*` — tracked reference generation
- `/api/pet-glb/*` — paid model stages, rigging, recovery, download
- `/api/assets/*`, `/api/fur-bin/*` — canonical assets, feedback, versions, showcase
- `/api/create-video`, `/api/jobs/*`, `/api/animator/speech-preview` — AI video and voice
- `/api/pawprints/*`, `/api/print-*`, `/api/stripe-*` — keepsakes and payment
- `/api/wags*`, `/api/pets/*`, `/api/avatars/*` — Wags and pet experiences
- `/api/healthz`, `/readyz`, `/version` — operations and release provenance

## Primary customer flows

1. Photo → generated reference set → reference approval → base/texture/rig stages.
2. Every persisted GLB version → Fur Bin → **Keep it** or **Toss it**.
3. Toss → subject/message form → durable feedback record → administrator email
   with customer, order, provider job, asset UUID, version, and SHA-256.
4. Creation image → structured four-beat script → exactly 8-second AI video with
   native sound and optional short voice line.
