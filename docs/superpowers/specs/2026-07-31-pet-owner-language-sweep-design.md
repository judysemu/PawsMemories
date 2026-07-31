# Pet-owner language and error UI sweep

## Goal

Make the product feel written for pet owners first. Primary UI copy should
describe the pet outcome, while technical terms such as GLB, rigging, and
multiview remain available only where they help with SEO, downloads, or
advanced details.

## Scope

- Customer-facing signup, onboarding, dashboard, create flow, model screens,
  print/shop surfaces, loading states, empty states, and errors.
- Preserve routes, APIs, product names, SEO keywords, and data contracts.
- Do not change generation, billing, fulfillment, or entitlement behavior.

## Language rules

- Prefer “pet,” “keepsake,” “portrait,” “model,” “creation,” and “download.”
- Use outcome-led actions such as “Make my pet,” “Create a keepsake,” and
  “Download my pet.”
- Keep “GLB” in SEO/help/download copy, never as the primary promise or CTA.
- Replace creator/developer pipeline words in primary copy: “rigging,”
  “provider,” “pipeline,” “job,” “asset,” and “build.”
- Keep technical details in a secondary disclosure or supporting sentence.

## Error treatment

- Replace raw exception/developer text with a plain-language explanation.
- Use a consistent readable alert/card style rather than unstyled red text:
  clear heading, short explanation, next action, and optional support detail.
- Use accessible contrast and an icon/label so color is not the only signal.
- Preserve actionable HTTP/API error codes in logs and diagnostics, not in the
  primary customer message.
- Distinguish retryable problems (“Try again”) from missing input (“Add a
  photo”) and service delays (“We’re still preparing this”).

## Verification

- Repository-wide scan for developer-first customer copy and raw error
  rendering.
- Type-check and focused UI tests.
- Confirm technical SEO terms remain present in secondary/SEO copy.
- Check the production bundle after deployment for the updated copy.
