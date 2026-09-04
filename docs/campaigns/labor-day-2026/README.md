# Pawsome3D Labor Day 2026 campaign package

Prepared on September 4, 2026 for the September 4–13 Labor Day promotion.

## Launch status

| Component | Status | Notes |
| --- | --- | --- |
| Shopify discount `LABORDAY30` | Live | 30% off the five listed products, first 100 redemptions, once per customer, ends September 13 at 11:59 PM Mountain Time. |
| Pawsome3D store banner and sale pricing | Ready for Hostinger deployment | The site change is in this repository and is covered by tests. |
| Campaign 1: 3D Models | Paused draft | Google Ads credentials, customer ID, conversion IDs, and an approved spend limit are not present. |
| Campaign 2: PawPrint Shop | Paused draft | Google Ads credentials, customer ID, conversion IDs, and an approved spend limit are not present. |
| Google Drive creative | Blocked | The Drive connection returned `USER_NOT_LOGGED_IN`; no Drive files were downloaded or represented as approved. |

## Files

- `campaign-plan.md`: campaign strategy, offers, landing pages, settings, measurement, and launch gates.
- `responsive-search-ads.csv`: two responsive search ads, with 15 headlines and four descriptions each.
- `keywords.csv`: phrase/exact keywords and shared negatives.
- `campaigns.csv`: paused campaign settings with provisional budgets.
- `product-margins.csv`: the auditable Shopify margin calculation for the discounted products.
- `creative-asset-manifest.csv`: available local candidates and the missing Drive deliverables.

Google Ads Editor can map these columns during CSV import. Leave both campaigns paused until conversion actions, Google tag/Shopify purchase tracking, Drive creatives, and the spend limit have been verified.
