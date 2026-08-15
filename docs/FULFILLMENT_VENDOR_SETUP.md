# Fulfillment vendor setup — Shopify catalog and Slant 3D

PawPrint creation is digital-only. The application does not create PawPrint
print orders, Shopify products, or carts. Existing PawPrint Shopify order rows
remain available as read-only history and the signed webhook continues to
reconcile those legacy records.

## Shopify public catalog

Configure these production variables:

```bash
SHOPIFY_STORE_DOMAIN="pawprints-by-pawsome3d.myshopify.com"
SHOPIFY_CLIENT_ID="..."
SHOPIFY_CLIENT_SECRET="..."
SHOPIFY_API_VERSION="2026-07"
SHOPIFY_CATALOG_SYNC_SECRET="a-long-random-secret"
SHOPIFY_WEBHOOK_SECRET="..." # only for legacy order reconciliation
```

`SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` must come from the same catalog
app installation. Do not mix the Hostinger runtime pair with the separate
read-only external-routine app configured in `tools/shopify-app`. Both need only
the `read_products` scope. Define a product metafield
with namespace/key `custom.pawprint_personalizable` and boolean type. Set it to
true only on products that accept a customer PawPrint file; titles, tags, and
variant option names are not classification signals.

Run the first snapshot after deployment:

```bash
curl -X POST https://pawsome3d.com/api/admin/shopify/catalog-sync \
  -H "Authorization: Bearer $SHOPIFY_CATALOG_SYNC_SECRET"
```

The daily routine repeats that request at `0 12 * * *` UTC. A failed refresh
leaves the previous catalog live. The public catalog is `GET
/api/store/products`; an authenticated admin can inspect `GET
/api/store/sync-status` and `GET /api/admin/fulfillment/verify`.

## Slant 3D figurines

Slant 3D remains the physical fulfillment provider for 3D pet figurines:

```bash
SLANT3D_API_KEY="..."
SLANT3D_PLATFORM_ID="..."
SLANT3D_DEFAULT_FILAMENT_ID="..."
SLANT3D_API_BASE_URL="https://slant3dapi.com/v2/api"
```

The figurine Print Shop also requires Stripe, media storage, and the Blender
worker. The admin fulfillment verification route reports missing variable
names and non-mutating provider connectivity results.
