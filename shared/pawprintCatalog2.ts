/**
 * Pawprints v2 catalog.
 *
 * Replaces the old ~140-title Historic Pawprint catalog
 * (historicPawprintTemplates.ts / historicalPetCatalog.ts) and db.ts's
 * generic stationery-card catalog. A Pawprint is now either:
 *  - Digital: one of 3 fixed themed categories, each with a dropdown of
 *    sub-choices (DIGITAL_CATEGORIES), or
 *  - Print: a specific Shopify product, each carrying its OWN category set
 *    (PRINT_PRODUCTS) since different physical products suit different themes.
 *
 * Every category option carries a premadeScript — the prompt used when the
 * customer picks "No Custom Instructions" instead of writing their own.
 */

export interface PawprintCategoryOption {
  id: string;
  label: string;
  /** Prompt used on the No-Custom-Instructions path. Combined server-side
   *  with the standard identity-preservation boilerplate before being sent
   *  to image generation. */
  premadeScript: string;
}

export interface PawprintCategoryDef {
  id: string;
  label: string;
  options: PawprintCategoryOption[];
}

export interface PawprintPrintProduct {
  /** Populate with the real Shopify product/variant IDs once the store's
   *  Admin API credentials are configured (see server/shopify.ts). */
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  description: string;
  /** Each physical product offers its own theme menu — a mug's audience
   *  isn't a canvas print's audience, so these are not required to match
   *  DIGITAL_CATEGORIES. */
  categories: PawprintCategoryDef[];
}

/**
 * PROPOSED starter lists — edit freely. Each option's premadeScript is
 * deliberately short; identity-preservation and composition constraints are
 * appended server-side so every script stays consistent regardless of who
 * edits this file.
 */
export const DIGITAL_CATEGORIES: PawprintCategoryDef[] = [
  {
    id: "event_themed",
    label: "Event Themed",
    options: [
      { id: "birthday", label: "Birthday", premadeScript: "A joyful birthday celebration scene for the pet(s) in the reference photos — party hats, balloons, a small cake with a candle, warm confetti-lit background, the pet(s) as the clear center of attention." },
      { id: "graduation", label: "Graduation", premadeScript: "A proud graduation-day scene for the pet(s) in the reference photos — a mini graduation cap and diploma scroll, a sunny campus lawn or stage backdrop, celebratory and dignified." },
      { id: "wedding_engagement", label: "Wedding / Engagement", premadeScript: "An elegant wedding or engagement celebration scene for the pet(s) in the reference photos — a floral arch, soft romantic lighting, subtle ring or bouquet details nearby, formal but warm." },
      { id: "adoption_day", label: "Adoption / Gotcha Day", premadeScript: "A heartwarming adoption-day scene for the pet(s) in the reference photos — a cozy welcome-home doorway or living room, a small 'welcome home' banner, soft joyful lighting." },
      { id: "retirement", label: "Retirement Party", premadeScript: "A cheerful retirement-party scene for the pet(s) in the reference photos — a relaxed porch or garden setting, a 'congratulations' banner, warm golden-hour light." },
      { id: "baby_shower", label: "Baby Shower / Gender Reveal", premadeScript: "A gentle baby-shower or gender-reveal celebration scene for the pet(s) in the reference photos — pastel balloons and bunting, soft nursery-toned background, tender mood." },
      { id: "housewarming", label: "Housewarming", premadeScript: "A cozy housewarming scene for the pet(s) in the reference photos — moving boxes, a welcome mat, warm interior lighting, a sense of a fresh new home." },
      { id: "sports_celebration", label: "Sports Team Celebration", premadeScript: "An energetic sports-team celebration scene for the pet(s) in the reference photos — a pet-safe fan jersey or bandana in team colors, stadium-style lights, triumphant mood." },
    ],
  },
  {
    id: "seasonal_holiday",
    label: "Seasonal / Holiday Themed",
    options: [
      { id: "christmas", label: "Christmas", premadeScript: "A festive Christmas scene for the pet(s) in the reference photos — a decorated tree, warm string lights, a cozy fireplace glow, holiday cheer." },
      { id: "halloween", label: "Halloween", premadeScript: "A playful Halloween scene for the pet(s) in the reference photos — pumpkins, gentle autumn-night lighting, a friendly (not scary) spooky-season mood." },
      { id: "thanksgiving", label: "Thanksgiving", premadeScript: "A warm Thanksgiving-gathering scene for the pet(s) in the reference photos — a harvest table with autumn leaves and gourds, soft indoor light, grateful cozy mood." },
      { id: "easter", label: "Easter", premadeScript: "A bright spring Easter scene for the pet(s) in the reference photos — pastel eggs, budding flowers, soft morning light, cheerful mood." },
      { id: "fourth_of_july", label: "Fourth of July", premadeScript: "A patriotic Fourth of July scene for the pet(s) in the reference photos — a pet-safe red-white-and-blue bandana, distant fireworks in a dusk sky, festive summer mood." },
      { id: "new_years_eve", label: "New Year's Eve", premadeScript: "A sparkling New Year's Eve scene for the pet(s) in the reference photos — soft confetti, a festive party hat, city-lights-at-night backdrop, celebratory mood." },
      { id: "valentines_day", label: "Valentine's Day", premadeScript: "A sweet Valentine's Day scene for the pet(s) in the reference photos — soft pink and red tones, heart accents, warm affectionate mood." },
      { id: "summer", label: "Summer", premadeScript: "A bright summer scene for the pet(s) in the reference photos — sunshine, a beach or backyard sprinkler setting, playful carefree mood." },
      { id: "fall_autumn", label: "Fall / Autumn", premadeScript: "A cozy autumn scene for the pet(s) in the reference photos — falling leaves, warm amber tones, a sweater-weather mood." },
      { id: "winter_wonderland", label: "Winter Wonderland", premadeScript: "A magical winter-wonderland scene for the pet(s) in the reference photos — gentle falling snow, soft blue-white light, a peaceful snowy landscape." },
    ],
  },
  {
    id: "professional_commercial",
    label: "Professional / Commercial",
    options: [
      { id: "pet_business_marketing", label: "Pet Business Marketing", premadeScript: "A clean, professional marketing photo of the pet(s) in the reference photos, suited for a groomer, sitter, or trainer's promotional materials — bright even lighting, tidy neutral background, approachable and trustworthy mood." },
      { id: "veterinary_promo", label: "Veterinary Clinic Promo", premadeScript: "A reassuring, professional photo of the pet(s) in the reference photos suited for veterinary-clinic marketing — clean bright clinical-adjacent setting, healthy and content mood." },
      { id: "product_advertisement", label: "Pet Product Advertisement", premadeScript: "A polished commercial product-advertisement photo of the pet(s) in the reference photos — studio-quality lighting, clean simple background, the pet presented as the confident hero of the shot." },
      { id: "real_estate_listing", label: "Real Estate \"Pet-Friendly Home\" Listing", premadeScript: "A warm real-estate listing photo featuring the pet(s) in the reference photos inside an inviting, tidy home interior, conveying a welcoming pet-friendly household." },
      { id: "social_media_banner", label: "Social Media Banner", premadeScript: "A vibrant, wide-format social-media banner scene featuring the pet(s) in the reference photos — bold clean composition with open space for text overlay, eye-catching colors." },
      { id: "corporate_mascot", label: "Corporate / Team Mascot", premadeScript: "A confident, professional 'team mascot' style photo of the pet(s) in the reference photos — clean office- or brand-adjacent backdrop, friendly and approachable corporate mood." },
    ],
  },
];

/**
 * Placeholder — populate with real Shopify products once Admin API
 * credentials are configured (see server/shopify.ts, PAWPRINTS_SHOPIFY_ENABLED).
 * Each product's categories intentionally differ to reflect that a mug's
 * best-fit themes are not a canvas print's best-fit themes.
 */
export const PRINT_PRODUCTS: PawprintPrintProduct[] = [];

/**
 * Suggested prompt format shown on the custom-prompt screen, tuned toward
 * collageEngine.ts's "story" layout (one hero photo + a strip of supporting
 * photos + a bottom text overlay).
 */
export const STORY_PROMPT_TEMPLATE =
  `[Opening scene] with [pet name] as the hero — [what's happening in the main scene].
Supporting moments: [2-3 short beats, e.g. "sniffing the grass", "mid-zoomie", "napping in the sun"].
Mood: [warm / playful / adventurous / nostalgic]. Leave room at the bottom for a short caption.`;

export function findDigitalOption(categoryId: string, optionId: string): PawprintCategoryOption | undefined {
  const category = DIGITAL_CATEGORIES.find((entry) => entry.id === categoryId);
  return category?.options.find((option) => option.id === optionId);
}

export function findPrintProduct(shopifyProductId: string): PawprintPrintProduct | undefined {
  return PRINT_PRODUCTS.find((product) => product.shopifyProductId === shopifyProductId);
}

export function findPrintOption(shopifyProductId: string, categoryId: string, optionId: string): PawprintCategoryOption | undefined {
  const product = findPrintProduct(shopifyProductId);
  const category = product?.categories.find((entry) => entry.id === categoryId);
  return category?.options.find((option) => option.id === optionId);
}
