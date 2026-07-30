# Fulfillment vendor setup — Printful & Slant 3D

Two vendors produce the physical goods:

| Surface | Vendor | What ships |
|---|---|---|
| Pawprints | **Printful** | Poster / canvas art prints |
| 3D models | **Slant 3D** | Printed pet figurines |

Both were fully coded already. The only thing that gates them is configuration.
This document is the checklist for making each one go live on Hostinger.

---

## The failure you are most likely hitting

**A valid `PRINTFUL_API_KEY` on its own is not enough.** Printful ordering
requires *two* independent things:

1. API credentials (`PRINTFUL_API_KEY`), and
2. a **product catalog** — the specific Printful variant IDs you sell.

If the catalog is empty, `getPawprintPrintProducts()` returns `[]`,
`pawprintProductCount` is `0`, and `buildFulfillmentReadiness()` reports
`available: false`. Before this change the Pawprints studio then hid the entire
physical-print section, which is why it looked like "nothing is connected to
Printful" even with a working key.

Your `.env` currently sets `PRINTFUL_STORE_ID` but **no
`PAWPRINT_PRINT_PRODUCTS_JSON` and no `PRINTFUL_PAWPRINT_VARIANT_ID`** — that is
almost certainly the whole problem.

---

## Printful (Pawprints)

### Required variables

```bash
PRINTFUL_API_KEY="..."                 # Printful dashboard → Settings → Developers → API token
PRINTFUL_STORE_ID="..."                # optional if the token is already store-scoped
PRINTFUL_API_BASE_URL="https://api.printful.com"
PRINTFUL_WEBHOOK_SECRET="..."          # for production status callbacks

# The catalog. This is the one that is missing.
PAWPRINT_PRINT_PRODUCTS_JSON='[...]'
```

### Getting your variant IDs

A "variant" is a specific size/material combination — an 8×10 matte poster is a
different variant from a 12×16 matte poster.

1. Sign in to Printful and open **Product Catalog**.
2. Pick the product you want to sell (e.g. *Enhanced Matte Paper Poster*).
3. Each size is a separate variant. Get its numeric ID either from
   `GET https://api.printful.com/products/{product_id}` with your API token, or
   from the admin **Printful Product Customizer** screen already built into this
   app (`MarketplaceAdminScreen` → *Printful Customizer*), which lists products
   and variants and auto-fills the print-file spec.
4. Build the JSON array. `code`, `label`, `variantId`, `widthIn` and `heightIn`
   are mandatory; a row missing any of them is silently dropped.

```json
[
  {
    "code": "poster-8x10",
    "label": "8 × 10 Art Print",
    "description": "Museum-quality matte poster",
    "variantId": 1349,
    "templateId": 0,
    "widthIn": 8,
    "heightIn": 10,
    "priceCents": 2499
  },
  {
    "code": "poster-12x16",
    "label": "12 × 16 Art Print",
    "description": "Museum-quality matte poster",
    "variantId": 1350,
    "widthIn": 12,
    "heightIn": 16,
    "priceCents": 3499
  }
]
```

> The variant IDs above are placeholders. **Look yours up** — an incorrect
> variant ID produces a real order for the wrong product at your expense.

Set it as a single-line environment variable in Hostinger (mind the quoting —
the value contains double quotes, so wrap it in single quotes).

### Why IDs are server-side only

`publicPawprintPrintProducts()` strips `variantId` and `templateId` before the
browser ever sees the list, and `requirePawprintPrintProduct(code)` re-resolves
the code server-side at order time. A crafted request therefore cannot select an
arbitrary Printful variant or alter fulfillment pricing.

---

## Slant 3D (figurines)

### Required variables

```bash
SLANT3D_API_KEY="..."
SLANT3D_PLATFORM_ID="..."
SLANT3D_DEFAULT_FILAMENT_ID="..."
SLANT3D_API_BASE_URL="https://slant3dapi.com/v2/api"
SLANT3D_WEBHOOK_SECRET="..."
```

All three of key / platform / filament must be present — `slant3dConfigured()`
requires the full set, so a partial configuration reads as "not configured".

- **Platform ID**: from your Slant 3D dashboard; verified against
  `GET /platforms/{id}`.
- **Filament ID**: from `GET /filaments`. Verification also checks the filament
  is still `available`, so a discontinued colour will fail the gate rather than
  fail at order time.

### Additional dependencies

Figurine printing also needs the model pipeline, because it converts GLB → STL
before quoting:

```bash
BLENDER_WORKER_URL="https://<your-render-worker>"
WORKER_SHARED_SECRET="..."             # must match the value on the worker
```

---

## Shared dependencies (both vendors)

Neither vendor can take an order without these:

```bash
STRIPE_SECRET_KEY="..."
STRIPE_WEBHOOK_SECRET="..."

MEDIA_BUCKET_NAME="..."
MEDIA_BUCKET_URL="..."
MEDIA_BUCKET_KEY="..."
MEDIA_BUCKET_SECRET="..."
```

Stripe matters twice over: the vendor only receives a **draft** order up front,
and it is promoted to production only after the Stripe webhook confirms payment.
Without `STRIPE_WEBHOOK_SECRET` orders will sit in `awaiting_payment` forever.

---

## Verifying a deployment

### 1. Public readiness (no auth)

```bash
curl https://<your-domain>/api/fulfillment/readiness
```

```json
{
  "modelPrinting":    { "provider": "slant3d",  "available": false, "blockers": ["slant3d_credentials"] },
  "pawprintPrinting": { "provider": "printful", "available": false, "productCount": 0,
                        "blockers": ["pawprint_print_products"] }
}
```

`blockers` names the missing dependency — that is the fastest way to see what is
actually wrong. It never contains secret values.

### 2. Live vendor check (admin only)

```bash
curl -H "Authorization: Bearer <admin-token>" \
     https://<your-domain>/api/admin/fulfillment/verify
```

This makes **non-mutating** calls to both vendors and reports per-check
`ready`, `missingEnv`, and `error`. Use it to tell these three apart:

| Symptom | Meaning |
|---|---|
| `missingEnv: ["PRINTFUL_API_KEY"]` | Variable never set on Hostinger |
| `error: "Printful returned 401"` | Key set but rejected — regenerate it |
| `productCount: 0` | Key fine, **catalog missing** — the common case |

### 3. Confirm the storefront

Visit `/print-shop`. Both vendor sections render always. Each carries either a
green *Shipping now* or amber *Coming soon* badge, so you can confirm what a
customer sees without reading any logs.

---

## What a customer sees before you finish

Deliberately, options are **shown and disabled** rather than hidden:

- `/print-shop` lists every print format and the figurine size control, with a
  "being switched on shortly" notice.
- The Pawprints studio shows the physical-print block with real formats, greyed
  out, after a design is saved.

Showcase formats carry no `variantId` and are flagged `orderable: false`. They
cannot be turned into a real order — `requirePawprintPrintProduct()` rejects any
code with no server-owned variant, so the disabled UI is backed by a server-side
guarantee rather than by the button state alone.
