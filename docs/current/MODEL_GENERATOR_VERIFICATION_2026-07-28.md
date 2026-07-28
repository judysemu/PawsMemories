# Gated Model Generator — Verification Record

Date: 2026-07-28
Branch: `codex/gated-model-generator`
Baseline: `4ee12d648344034707c71bacbcd5fdfab66cc0b2`

## Scope verified

- customer-controlled reference, blank-base, texture, and rig gates;
- separate server-authoritative charges for base, texture, and body rig stages;
- HD and SmartMesh provider contracts and measured triangle limits;
- pet/quadruped and humanoid/biped profiles;
- bounded style direction applied only to the texture stage;
- private canonical GLB persistence, signed previews, exact-version approvals,
  idempotency, refunds, and recovery;
- operator-only final-version inspection and release from the model-studio UI;
- facial-rig purchase removed and rejected until the measured success policy can
  satisfy the 75% release threshold.

## Runtime

- Node.js: `v24.18.0`
- npm: `11.16.0`
- IFC test runtime: Python 3.11 with repository-pinned
  `ifcopenshell==0.8.5` and `numpy==2.2.1`

## Automated results

| Gate | Result |
|---|---:|
| `npm run lint` | passed |
| Full serial `npm run test` | 1,163 passed; 0 failed; 3 intentional skips; 1,166 total |
| `npm run test:contracts` | 40 passed; 0 failed |
| `npm run test:security` | 8 passed; 0 failed |
| `npm run test:ar` | 139 passed; 0 failed |
| IFC worker suite under its declared Python 3.11 environment | 6 passed; 0 failed |
| `npm run build` | passed |
| `git diff --check` | passed |

The three full-suite skips are explicit environment/opt-in integrations, not
failed assertions. Tests that intentionally exercise missing object-storage
configuration log warnings while still proving their fail-closed behavior.

The local default `python3` is Python 3.14 and does not have the pinned
IfcOpenShell dependency. The IFC suite was therefore executed with the same
Python 3.11 major version declared in `.github/workflows/ci.yml`; no IFC test was
skipped or weakened.

## Production build

The Node 24 production build generated the Vite application, bundled Express
entry point, source map, and release manifest.

| Artifact | SHA-256 |
|---|---|
| `dist/server.cjs` | `61bd10b72a0632bcd6052224a52b82898bc3d187d8c260edc2e738665979b7d5` |
| `dist/release-manifest.json` | `00672e81a8a08af01ff266bbc9058ace87e2d62c4a74fafc24af85261aa8b244` |

Vite reports existing chunks above its advisory 500 kB threshold. This is a
performance warning, not a compilation or integrity failure.

## Acceptance boundary

This record proves local contracts, database migrations, concurrency behavior,
security boundaries, UI wiring, and production compilation. It does not claim a
live Tripo charge, a live customer purchase, or a production deployment. Those
require separately authorized production verification.
