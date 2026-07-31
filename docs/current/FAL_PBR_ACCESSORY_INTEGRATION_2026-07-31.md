# fal.ai PBR Accessory Integration — 2026-07-31

## Decision

Use fal.ai PATINA for the closed, authored collar/accessory material library.
Do **not** add a fal retexture pass to customer pets or Animator inputs yet.
Pawsome3D's 3D generation request already asks for PBR output, while the fal
retexture contract does not itself prove that an existing armature, skin
weights, morph targets, animation clips, UVs, and pet identity survive the
round trip.

The accessory path uses `fal-ai/patina/material` to generate exactly four
seamless 1024px PNG maps: base color, normal, roughness, and metalness. The
browser never calls fal.ai. Generated maps must first pass the server-side
download, media, dimension, host, and hash gates, then become local reviewed
assets under `public/wardrobe/materials`.

## Implemented locally

- `@fal-ai/client` is a pinned runtime dependency.
- Fifteen closed material profiles cover every base and Wags wardrobe item.
- Prompts and seeds are bounded and deterministic; prompt expansion is off.
- The API key is read only from `FAL_KEY` in the server-side authoring process.
- Paid generation requires `FAL_PBR_AUTHORING_ENABLED=1` plus an explicit
  `--material` or `--all` selection.
- Provider submission is never automatically retried because a failed response
  can still represent an accepted paid request.
- Provider output must include exactly one of each required map from an exact
  `fal.media` host over HTTPS.
- Download redirects, private DNS results, non-PNG data, oversized files,
  malformed images, and wrong dimensions fail closed.
- Generated assets are installed atomically and recorded in a local manifest
  with SHA-256 hashes.
- The browser accepts only complete local manifest paths and falls back to the
  curated scalar material if a PBR map is absent or fails to load.
- fal is not a customer runtime dependency and no secret is added to a Vite or
  browser environment variable.

## Current evidence

- Full Node 24.18 suite: **1,309 total; 1,306 passed; 3 intentional skips; 0
  failed**.
- fal/PBR focused tests: **9/9 passed**.
- TypeScript: **PASS**.
- Production build and release manifest: **PASS**.
- `git diff --check`: **PASS**.
- Dependency audit after adding `@fal-ai/client`: **0 vulnerabilities**.
- The authoring command exits nonzero before any provider call while the
  explicit paid switch is disabled.

## Not yet performed

`FAL_KEY` is not configured in this workspace, so no paid fal request was made
and the shipped PBR manifest intentionally has zero generated entries. The
current wardrobe therefore uses the improved deterministic fallback material
values. Before claiming fal-authored PBR accessories are live:

1. Configure `FAL_KEY` in the controlled authoring environment only.
2. Enable one explicit paid authoring run.
3. Generate the selected catalog materials with `npm run wardrobe:pbr --
   --material <id>`.
4. Visually inspect seams, scale, normals, roughness, and metalness on every
   supported accessory under neutral and HDR lighting.
5. Commit the four map files and updated hash manifest.
6. Re-run the full build and browser/network sweep, then deploy the exact SHA.

The procedural accessory geometry is still a placeholder. PBR improves its
surface response, but authored UV-mapped, bone-attached GLB accessories remain
the quality gate for a final production wardrobe.

## Official API basis checked

- PATINA Text to Material: `https://fal.ai/models/fal-ai/patina/material/api`
- Meshy Retexture: `https://fal.ai/models/fal-ai/meshy/v5/retexture/api`
