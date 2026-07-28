---
name: model-asset-licensing
description: Design, implement, review, or debug licensing for generated GLB, STL, IFC, texture, animation, and printable model assets in PawsMemories or Layer8. Use for license grants, activation keys, signed offline certificates, asset-version/hash binding, personal/commercial/manufacturing rights, seats/devices, expiry, revocation, marketplace entitlements, downloads, and audit.
---

# Model Asset Licensing

Read the canonical asset registry, marketplace entitlement, legal terms, credit or
checkout flow, and `INHOUSE_SPATIAL_GENERATOR_ARCHITECTURE.md` before editing.

## Credential Separation

- A Layer8 tenant API key authorizes an application to call AI services.
- A model license authorizes a customer to use one or more immutable asset versions.
- A signed download URL authorizes one short-lived file transfer.
- An approval hash authorizes finalization of one generation attempt.

Never reuse one credential for another purpose.

## Authority And Binding

PawsMemories is authoritative for model licenses because it owns canonical assets,
marketplace orders, entitlements, and user identity. Layer8 may expose a reusable
license issuance/verification service later, but it must not become the source of
truth unless Paws license and entitlement records migrate transactionally.

Every grant must bind to:

- license UUID and public key ID
- owner or purchasing account ID
- canonical asset UUID and immutable version ID
- SHA-256 of every licensed file or an immutable manifest hash
- license policy/version and rights tier
- issue, start, expiry, and optional maintenance dates
- order/subscription/grant correlation ID
- status and revocation reason

Replacing a GLB or STL creates a new asset version. It never mutates the file under
an existing licensed hash.

## Recommended License Forms

Use an opaque online activation key and an Ed25519-signed license certificate:

1. Generate at least 256 bits with a cryptographically secure random source.
2. Display the activation key once. Store only a versioned HMAC or hash plus a
   server-side pepper, prefix, last four characters, and status.
3. Exchange the activation key for a short-lived session or signed certificate
   after account, entitlement, asset hash, device/seat, and revocation checks.
4. Sign offline certificates with a dedicated Ed25519 licensing key held in managed
   secret storage. Include `kid` for rotation and no unnecessary personal data.
5. Keep offline certificates short-lived when revocation matters. Publish or query a
   bounded revocation list for longer-lived certificates.

Do not encrypt or hide the public verification key. It is safe to distribute. The
private signing key never enters the browser, downloadable model, repository, build
archive, Pixel, Blender worker, or Layer8 provider payload.

## Rights Model

Define explicit, versioned rights rather than a single free-form `license` string:

- personal digital use
- personal physical prints
- commercial rendered media
- commercial physical manufacturing with quantity limit
- redistribution of the original model files
- derivative creation and derivative redistribution
- client/project seats or registered devices
- subscription validity and post-cancellation rights

Redistribution of editable source/model files should default to false. Commercial
rights must also respect every source image, font, texture, provider-output, and
third-party component license in the canonical lineage.

## Data And Endpoints

Add normalized license policies, grants, covered asset versions, activations,
signing keys, and revocations. Use append-only events for issuance, activation,
renewal, replacement, revocation, and verification failures.

Suggested authenticated endpoints:

- `POST /api/licenses/activate`
- `POST /api/licenses/deactivate`
- `GET /api/licenses`
- `GET /api/licenses/:licenseUuid/certificate`
- `POST /api/licenses/verify` for server-to-server verification only

Marketplace payment webhooks and subscription renewals grant licenses
idempotently. Checkout submission never grants rights before verified payment.

## Layer8 Option

Layer8 can productize licensing as a separate control-plane module with tenant
scopes such as `licenses:issue`, `licenses:verify`, and `licenses:revoke`. Keep it
outside `/v1/proxy/infer`; licensing is deterministic security/commerce logic, not
an LLM provider operation. Partition every grant, key, rate limit, and audit event
by tenant.

## Security And Product Limits

- Use constant-time secret comparison and rate-limit activation/verification.
- Enforce idempotency and database uniqueness on order/grant correlations.
- Never log full activation keys or certificates containing account identifiers.
- Do not embed reusable secrets inside GLB/STL metadata; files are inspectable.
- Optional watermarking or mesh fingerprinting is attribution evidence, not DRM.
- A license system can prove grants and control official downloads; it cannot make
  a downloaded 3D file impossible to copy.

## Acceptance Tests

- A grant covers only its exact asset version/manifest hash and rights tier.
- Modified, substituted, foreign-tenant, revoked, expired, and unknown files fail.
- Duplicate payment/subscription webhooks issue one grant.
- Personal licenses fail commercial/manufacturing authorization.
- Quantity, seat, device, and activation limits are enforced atomically.
- Private-key rotation verifies old certificates through their retained public key
  while new certificates use the new `kid`.
- Revocation behavior matches online and offline policy.
- Download URLs are short-lived and require an active entitlement/license.
- Existing canonical lineage and source-license restrictions cannot be bypassed by
  issuing a broader downstream license.
