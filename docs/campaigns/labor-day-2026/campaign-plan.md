# Pawsome3D Labor Day campaign plan

## Shared controls

- Flight: September 4–13, 2026; end at 11:59 PM Mountain Time.
- Location: United States, presence only.
- Language: English.
- Network: Google Search only at launch; Search Partners and Display expansion off.
- Initial bid strategy: Maximize clicks while purchase-value tracking is unavailable. Move to Maximize conversion value only after purchase values are verified in Google Ads.
- Provisional budget: $15/day per campaign, campaigns paused. This is a planning value, not an authorized spend limit.
- Brand: `Pawsome3D` exactly; destination domain `https://pawsome3d.com`.
- Shared negative themes: free download, template, tattoo, veterinary, jobs, wholesale, coloring page, clip art.
- Ad schedule: 6:00 AM–11:00 PM in the account time zone for the first three days; expand only if conversion evidence supports it.

## Campaign 1 — P3D | Labor Day | 3D Models | US | 2026

Goal: qualified traffic and account creation for the photo-to-3D model journey, with purchase as the eventual primary conversion.

- Landing page: `https://pawsome3d.com/sign-up?utm_source=google&utm_medium=cpc&utm_campaign=labor_day_3d_2026&utm_content=rsa_3d_models`
- Honest Labor Day offer: create a free account and confirm the email address to unlock one free pet image.
- Product story: turn a pet photo into a custom 3D model; 3D model printing is available through Pawsome3D's Stripe checkout.
- Ad group: Custom Pet 3D Models.
- Primary conversion after instrumentation: completed paid Pawsome3D checkout with dynamic USD value.
- Secondary conversions: account created, email verified, and 3D model creation started.
- Launch targets, not industry benchmarks: CTR at least 5%; signup rate at least 15% of ad clicks; purchase rate at least 3% of ad clicks; purchase ROAS at least 2.0. Pause a keyword after 30 clicks without a signup.

## Campaign 2 — P3D | Labor Day | PawPrint Shop | US | 2026

Goal: Shopify sales of select PawPrint-ready products.

- Landing page: `https://pawsome3d.com/store?utm_source=google&utm_medium=cpc&utm_campaign=labor_day_pawprints_2026&utm_content=rsa_pawprint_shop`
- Offer: 30% off the five eligible products with code `LABORDAY30`; first 100 redemptions; one use per customer; ends September 13 at 11:59 PM Mountain Time.
- Product story: create a PawPrint portrait and place it on an eligible pillow, stocking, tree skirt, or ornament.
- Ad group: PawPrint Gifts.
- Primary conversion after instrumentation: Shopify purchase with dynamic USD value.
- Secondary conversions: account created, email verified, Shopify product click, and begin checkout.
- Launch targets, not industry benchmarks: CTR at least 5%; purchase rate at least 3% of ad clicks; CPA at most $10 on the lower-priced pillow and at most $15 on the other eligible products; purchase ROAS at least 2.0. Pause a keyword after 30 clicks without a purchase or assisted conversion.

## Margin guardrails

The margin file uses `(price - unit cost) / price`. It excludes shipping, fulfillment adjustments, payment fees, returns, tax, and advertising. The five-product discount preserves estimated gross margin from 49.2% to 73.8% before those costs. The Shopify 3D Printed Model is excluded because its unit cost is missing; the digital PawPrint and model prices are credit-based and do not yet have an auditable per-order cost record.

## Conversion implementation gate

Do not activate conversion bidding until all of the following are confirmed:

1. Create separate Google Ads conversion actions for Pawsome3D purchase and Shopify purchase; make purchase primary and pass transaction ID, currency, and value.
2. Add secondary conversion actions for signup and email verification. Keep page views out of the primary goal.
3. Install the Google tag on Pawsome3D and connect Shopify using its supported Google sales-channel/tag integration. Test each purchase once without double-counting.
4. Enable enhanced conversions only after consent and data-handling checks pass.
5. Verify the UTM values survive navigation and appear in the existing first-party traffic report.
6. Import Drive assets only after the owner reconnects Drive and explicitly identifies the approved files.

## Launch gates

- Google Ads customer ID and optional manager ID confirmed.
- Google Ads API/OAuth configuration available privately; no secret pasted into documentation or chat.
- Owner approves a daily or total spend limit.
- Policy and spelling preview approved.
- Every landing page returns 200 on desktop and mobile.
- `LABORDAY30` applies to the exact five products and refuses a 101st redemption.
- Search ads remain paused until Google Ads conversion diagnostics show no unverified or duplicate purchase tags.
