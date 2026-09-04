# Pawsome3D Labor Day campaign plan

## Shared controls

- Flight: September 4–13, 2026; end at 11:59 PM Mountain Time.
- Location: United States, presence only.
- Language: English.
- Network: Google Search only at launch; Search Partners and Display expansion off.
- Initial bid strategy: Maximize clicks while purchase-value tracking is unavailable. Move to Maximize conversion value only after purchase values are verified in Google Ads.
- Approved combined average daily budget: $30/day, explicitly reconfirmed September 4. The CSV split is $15/day each, but the user-added live Performance Max campaign currently reports $14.80/day. Inspect all campaigns and prevent duplicate spend before allocating the remainder. Do not increase to $50/day.
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
- Planning targets, not forecasts or industry benchmarks: CTR at least 5%; signup rate at least 15% of ad clicks; purchase rate at least 3% of ad clicks. A profitable CPA/ROAS target for 3D purchases is not established until provider and fulfillment costs are audited. Review a keyword after 30 clicks without a signup; do not blindly optimize unverified conversion data.

## Campaign 2 — P3D | Labor Day | PawPrint Shop | US | 2026

Goal: Shopify sales of select PawPrint-ready products.

- Landing page: `https://pawsome3d.com/store?utm_source=google&utm_medium=cpc&utm_campaign=labor_day_pawprints_2026&utm_content=rsa_pawprint_shop`
- Offer: 30% off the five eligible products with code `LABORDAY30`; first 100 redemptions; one use per customer; ends September 13 at 11:59 PM Mountain Time.
- Product story: create a PawPrint portrait and place it on an eligible pillow cover, stocking, tree skirt, or ornament. The digital portrait's creation cost is separate unless the product page explicitly includes it.
- Ad group: PawPrint Gifts.
- Primary conversion after instrumentation: Shopify purchase with dynamic USD value.
- Secondary conversions: account created, email verified, Shopify product click, and begin checkout.
- Planning targets, not forecasts or industry benchmarks: CTR at least 5%; purchase rate at least 3% of ad clicks. Provisional CPA review caps: $4 pillow case, $10 stocking, $8 tree skirt/ornaments, subject to actual remaining costs. Review a keyword after 30 clicks without a purchase or assisted conversion. These are not configured automated bidding targets.

## Margin guardrails

The margin file uses `(price - unit cost) / price`. It excludes shipping, fulfillment adjustments, payment fees, returns, tax, and advertising. The five-product discount preserves estimated gross margin from 49.2% to 73.8% before those costs. The Shopify 3D Printed Model is excluded because its unit cost is missing; the digital PawPrint and model prices are credit-based and do not yet have an auditable per-order cost record.

Allowable CPA = sale revenue minus unit cost, payment fees, net shipping/fulfillment, returns reserve and desired profit. Break-even ROAS = sale revenue divided by contribution before ads. Before excluded costs, maximum break-even CPAs are $7.55 pillow case, $21.90 stocking, and $15.50 tree skirt/ornaments; corresponding ROAS floors are 1.528, 1.438, 2.032 and 1.354. Actual floors are higher. A 2.0 ROAS target loses money on the tree skirt even before excluded costs.

## Conversion implementation gate

Do not activate conversion bidding until all of the following are confirmed:

1. Create separate Google Ads conversion actions for Pawsome3D purchase and Shopify purchase; make purchase primary and pass transaction ID, currency, and value.
2. Add secondary conversion actions for signup and email verification. Keep page views out of the primary goal.
3. Install the Google tag on Pawsome3D and connect Shopify using its supported Google sales-channel/tag integration. Test each purchase once without double-counting.
4. Enable enhanced conversions only after consent and data-handling checks pass.
5. Verify the UTM values survive navigation and appear in the existing first-party traffic report.
6. Drive is connected and owner media are discoverable. Inspect actual images/video/audio and verify claims/rights before import; preserve the existing live asset group's 11 images, logo and two videos until reviewed.

## Launch gates

- Google Ads customer ID is confirmed: `340-191-5907`; publishing and $30/day total are authorized. Browser access is available; API credentials are not required if using the supported UI.
- Resolve the live Google Ads payment-method warning privately; spend authorization does not repair billing.
- Policy and spelling preview approved.
- Every landing page returns 200 on desktop and mobile.
- Read back the exact five products, 100-use cap, once-per-customer setting and dates; verify a valid checkout without deliberately consuming 100 redemptions.
- Search ads remain paused until Google Ads conversion diagnostics show no unverified or duplicate purchase tags.
