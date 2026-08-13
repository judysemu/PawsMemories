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
 * shopifyProductId / shopifyVariantId below are placeholders — run
 * listShopifyProducts() (server/shopify.ts) once the Admin API token is set
 * and replace REPLACE_WITH_SHOPIFY_PRODUCT_ID / REPLACE_WITH_SHOPIFY_VARIANT_ID
 * with the real IDs for each matching product in gibi's store. Entries stay
 * inert until PAWPRINTS_SHOPIFY_ENABLED="true" (see server.ts:3304), so having
 * placeholder IDs here does not expose a broken checkout in the meantime.
 * Each product's categories intentionally differ to reflect that a mug's
 * best-fit themes are not a canvas print's best-fit themes.
 */
export const PRINT_PRODUCTS: PawprintPrintProduct[] = [
  {
    shopifyProductId: "REPLACE_WITH_SHOPIFY_PRODUCT_ID_CANVAS",
    shopifyVariantId: "REPLACE_WITH_SHOPIFY_VARIANT_ID_CANVAS",
    title: "Canvas / Framed Print",
    description: "A ready-to-hang canvas or framed wall print of your pet's Pawprint.",
    categories: [
      {
        id: "memorial_keepsake",
        label: "Memorial & Keepsake",
        options: [
          { id: "loving_memory", label: "In Loving Memory", premadeScript: "A gentle, dignified memorial portrait of the pet(s) in the reference photos — soft warm light, a subtle heavenly or garden backdrop, peaceful and comforting mood, suitable for a keepsake wall print." },
          { id: "rainbow_bridge", label: "Rainbow Bridge", premadeScript: "A tender scene of the pet(s) in the reference photos at the Rainbow Bridge — soft pastel sky, gentle light, comforting and hopeful mood." },
          { id: "forever_loved", label: "Forever Loved", premadeScript: "A timeless, elegant portrait of the pet(s) in the reference photos — classic studio-style lighting, simple neutral backdrop, warm and dignified mood suited for a lasting keepsake." },
        ],
      },
      {
        id: "classic_portrait",
        label: "Classic Portrait",
        options: [
          { id: "studio_portrait", label: "Studio Portrait", premadeScript: "A polished studio portrait of the pet(s) in the reference photos — clean neutral backdrop, soft directional lighting, confident and classic pose." },
          { id: "outdoor_adventure", label: "Outdoor Adventure", premadeScript: "An adventurous outdoor scene featuring the pet(s) in the reference photos — natural trail, park, or beach setting, bright natural light, joyful energetic mood." },
        ],
      },
    ],
  },
  {
    shopifyProductId: "REPLACE_WITH_SHOPIFY_PRODUCT_ID_POSTER",
    shopifyVariantId: "REPLACE_WITH_SHOPIFY_VARIANT_ID_POSTER",
    title: "Poster (Unframed)",
    description: "An affordable unframed art print, ready to display or frame yourself.",
    categories: [
      {
        id: "playful_poster",
        label: "Playful & Fun",
        options: [
          { id: "action_pose", label: "Action Pose", premadeScript: "A dynamic, high-energy action shot of the pet(s) in the reference photos — mid-run or mid-jump, bright bold colors, playful poster-style composition." },
          { id: "pop_art", label: "Pop Art Style", premadeScript: "A bold pop-art style illustration of the pet(s) in the reference photos — vibrant saturated colors, graphic poster composition, fun and eye-catching." },
          { id: "comic_hero", label: "Comic Hero", premadeScript: "A comic-book hero style poster of the pet(s) in the reference photos — bold outlines, dynamic action pose, vivid comic-panel color palette." },
        ],
      },
      {
        id: "seasonal_poster",
        label: "Seasonal",
        options: [
          { id: "summer_poster", label: "Summer", premadeScript: "A bright summer poster scene for the pet(s) in the reference photos — sunshine, beach or backyard setting, playful carefree mood." },
          { id: "winter_poster", label: "Winter", premadeScript: "A cozy winter poster scene for the pet(s) in the reference photos — soft snowfall, warm color accents, cheerful wintertime mood." },
        ],
      },
    ],
  },
  {
    shopifyProductId: "REPLACE_WITH_SHOPIFY_PRODUCT_ID_MUG",
    shopifyVariantId: "REPLACE_WITH_SHOPIFY_VARIANT_ID_MUG",
    title: "Mug",
    description: "A daily-use ceramic mug printed with your pet's Pawprint design.",
    categories: [
      {
        id: "everyday_fun",
        label: "Everyday & Fun",
        options: [
          { id: "good_morning", label: "Good Morning", premadeScript: "A cheerful, cozy 'good morning' style scene for the pet(s) in the reference photos — warm kitchen or sunrise light, relaxed happy mood, simple and clean composition suited for a mug print." },
          { id: "coffee_buddy", label: "Coffee Buddy", premadeScript: "A charming, simple illustration of the pet(s) in the reference photos in a relaxed coffee-time setting — warm cozy tones, clean mug-friendly composition." },
          { id: "silly_face", label: "Silly & Goofy", premadeScript: "A lighthearted, goofy candid-style shot of the pet(s) in the reference photos — playful expression, bright cheerful colors, fun simple composition." },
        ],
      },
    ],
  },
  {
    shopifyProductId: "REPLACE_WITH_SHOPIFY_PRODUCT_ID_BLANKET",
    shopifyVariantId: "REPLACE_WITH_SHOPIFY_VARIANT_ID_BLANKET",
    title: "Blanket",
    description: "A soft, cozy throw blanket featuring your pet's Pawprint design.",
    categories: [
      {
        id: "cozy_comfort",
        label: "Cozy & Comfort",
        options: [
          { id: "curled_up", label: "Curled Up & Cozy", premadeScript: "A soft, comforting scene of the pet(s) in the reference photos curled up and relaxed — warm blanket or cushion setting, gentle indoor light, peaceful cozy mood." },
          { id: "sweet_dreams", label: "Sweet Dreams", premadeScript: "A dreamy, gentle sleeping scene of the pet(s) in the reference photos — soft moonlit or starlit tones, calm and tender mood, suited for a comforting keepsake." },
        ],
      },
      {
        id: "memorial_comfort",
        label: "In Loving Memory",
        options: [
          { id: "always_with_us", label: "Always With Us", premadeScript: "A warm, comforting memorial scene of the pet(s) in the reference photos — soft golden light, gentle peaceful backdrop, tender and reassuring mood suited for a sympathy keepsake blanket." },
        ],
      },
    ],
  },
];

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
