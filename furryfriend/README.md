# FurryFriend.cc

Static, pre-rendered editorial guide for `furryfriend.cc`, clearly presented as
“FurryFriend, a Pawsome3D guide.” It has no browser-side AI credentials, no
tracker, and no unauthenticated admin surface.

## Current implementation

- home, guides hub, About, Editorial Policy, Privacy, Terms, 404, robots, and
  sitemap;
- four answer-first editorial previews covering the required launch pillars;
- SALTI-style durable editorial ledger and product-truth gates;
- Article and Breadcrumb structured data matching visible content;
- responsive, keyboard-accessible design with reduced-motion support;
- generated social preview and reusable Pawsome3D brand imagery;
- zero runtime dependencies and a static `dist/` suitable for Hostinger.

The four guides remain `noindex` and excluded from the sitemap while their
ledger state is `human_review_required`. A future editorial desk must record a
named human reviewer and approval time before changing a job to `published`.

## Build

Use the Pawsome3D-supported Node 24 runtime and run `npm run build` from this
directory. Upload the contents of `dist/` to the `furryfriend.cc` document root
only after the editorial approvals and domain/TLS checks are complete.

## Intentionally not implemented yet

- public question submission and rate limiting;
- authenticated editorial desk and durable database records;
- AI model runner or automatic publishing;
- analytics or search-ranking claims;
- any prepaid Pawprint gift, released Animator, or purchasable historical
  collection claim.
