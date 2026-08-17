/**
 * Pawprints v2 catalog.
 *
 * Digital-only PawPrint theme catalog. Shopify merchandise is synced into the
 * runtime store snapshot and deliberately does not shape this creation flow.
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

// ─── PawPrints v3 teaching layer ────────────────────────────────────────────
// The studio's job is not only to produce a portrait but to teach the customer
// how to drive the model. Every prompt screen shows two samples: the first is
// broken into labelled sections with a one-line reason for each, the second is
// shown whole so they can see a finished prompt read naturally.

export interface PromptSection {
  id: string;
  /** Short label shown on the chip, e.g. "Scene". */
  label: string;
  /** The actual prompt fragment this section contributes. */
  text: string;
  /** Plain-language reason this section earns its place. No jargon. */
  explanation: string;
}

export interface AnnotatedSamplePrompt {
  id: string;
  title: string;
  sections: PromptSection[];
}

/** Sample 1 — dissected. Each section is explained beneath it in the UI. */
export const ANNOTATED_SAMPLE_PROMPT: AnnotatedSamplePrompt = {
  id: "eiffel-birthday",
  title: "A birthday card from Paris",
  sections: [
    {
      id: "scene",
      label: "Scene",
      text: "On the observation deck of the Eiffel Tower at golden hour",
      explanation: "Where it happens. Real landmarks work well — the model knows them.",
    },
    {
      id: "subject",
      label: "Subject",
      text: "my corgi Tuck and our family of four, all smiling",
      explanation: "Who is in it. Your uploaded photos keep everyone's real face and markings.",
    },
    {
      id: "personal",
      label: "Personal text",
      text: '"Happy Birthday, Grandma!"',
      explanation: "Optional caption printed onto the card or frame.",
    },
    {
      id: "mood",
      label: "Mood",
      text: "warm, joyful, a little silly",
      explanation: "Sets the colours and expressions. One or two adjectives is plenty.",
    },
    {
      id: "composition",
      label: "Composition",
      text: "postcard style, with room for text along the bottom",
      explanation: "How it is framed, and where your caption can sit.",
    },
  ],
};

/** Sample 2 — shown whole, so a finished prompt reads as one sentence. */
export const PLAIN_SAMPLE_PROMPT =
  "Salem the cat as a Renaissance duchess in an oil-painting style, gentle and regal, soft window light, framed portrait with space for a short message.";

/** Joins an annotated sample back into the single prompt it represents. */
export function composeSamplePrompt(sample: AnnotatedSamplePrompt): string {
  return sample.sections.map((section) => section.text).join(", ") + ".";
}

export interface IdeaChip {
  id: string;
  label: string;
  emoji: string;
  /** Seeded into the prompt box as editable text, never locked. */
  seed: string;
}

/** Starting points for customers who freeze at an empty box. */
export const IDEA_CHIPS: IdeaChip[] = [
  {
    id: "famous_location",
    label: "Famous locations",
    emoji: "🗼",
    seed: "My pet and me at the Eiffel Tower at golden hour, warm and joyful, postcard style",
  },
  {
    id: "historical_figure",
    label: "Historical figure",
    emoji: "👑",
    seed: "My pet as a Renaissance duchess in an oil-painting style, regal and gentle, framed portrait",
  },
  {
    id: "occupation",
    label: "Occupation costume",
    emoji: "🚒",
    seed: "My pet in a firefighter's coat and helmet beside a gleaming engine, brave and cheerful",
  },
  {
    id: "holiday",
    label: "Holiday theme",
    emoji: "🎄",
    seed: "My pet by a decorated tree with warm string lights and a cosy fireplace glow, festive and snug",
  },
];

export interface OccasionPreset {
  id: string;
  label: string;
  emoji: string;
  /** Prefilled caption the customer can edit or clear. */
  defaultText: string;
}

/** Occasions for the optional printed caption. */
export const OCCASION_PRESETS: OccasionPreset[] = [
  { id: "birthday", label: "Birthday", emoji: "🎂", defaultText: "Happy Birthday!" },
  { id: "framed", label: "Framed photo", emoji: "🖼", defaultText: "" },
  { id: "holiday", label: "Holiday card", emoji: "🎄", defaultText: "Happy Holidays!" },
  { id: "congrats", label: "Congratulations", emoji: "🎉", defaultText: "Congratulations!" },
  { id: "get_well", label: "Get well", emoji: "💐", defaultText: "Get well soon!" },
  { id: "missing_you", label: "Missing you", emoji: "💌", defaultText: "Missing you." },
];

/** Server-side and client-side cap for the printed caption. */
export const PERSONAL_TEXT_MAX_LENGTH = 120;
