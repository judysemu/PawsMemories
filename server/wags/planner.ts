/**
 * Wardrobe Wags — Gemini box planner (W2)
 *
 * Generates a structured `plan_json` for a monthly Wags box using the pet
 * profile, current season, and prior delivery history to avoid repeating
 * the same items. The plan is stored as `pending_review`; nothing is
 * delivered until an admin explicitly approves the box.
 *
 * Control env vars:
 *   GEMINI_API_KEY         — required (shared with image generation)
 *   GEMINI_WAGS_MODEL      — optional override (default: gemini-3.1-flash-lite)
 */

import { GoogleGenAI } from "@google/genai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WagsPlanItem {
  slot: string;
  title: string;
  description: string;
  category: string;
  colors: string[];
  tags: string[];
  size_note?: string;
}

export interface WagsPlan {
  schema_version: "wags.plan.v1";
  box_month: string;           // "YYYY-MM"
  tier: "basic" | "plus";
  season: string;
  theme: string;
  theme_rationale: string;
  items: WagsPlanItem[];
}

export interface WagsPlannerInput {
  box_month: string;
  tier: "basic" | "plus";
  pet_species: "dog" | "cat";
  pet_breed: string | null;
  pet_name: string | null;
  previous_themes: string[];   // themes from prior boxes — avoid repeating
  previous_item_titles: string[]; // titles from prior boxes
}

// ---------------------------------------------------------------------------
// Season helper
// ---------------------------------------------------------------------------

function getSeason(month: number): string {
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "fall";
  return "winter";
}

function getHolidayHints(month: number): string {
  const hints: Record<number, string> = {
    1:  "New Year, winter cozy vibes",
    2:  "Valentine's Day, hearts and pinks",
    3:  "St. Patrick's Day, spring pastels",
    4:  "Easter, spring florals",
    5:  "Mother's Day, florals and warmth",
    6:  "Summer start, pride colors, beach",
    7:  "Fourth of July, red/white/blue, summer BBQ",
    8:  "Late summer, back-to-school, sunflowers",
    9:  "Fall harvest, Pumpkin Spice, earthy tones",
    10: "Halloween, spooky cute, orange/black",
    11: "Thanksgiving, warm harvest, gratitude",
    12: "Christmas/Hanukkah/Kwanzaa, winter holiday, festive",
  };
  return hints[month] ?? "seasonal";
}

// ---------------------------------------------------------------------------
// Slot definitions per tier
// ---------------------------------------------------------------------------

const BASIC_SLOTS = ["accessory", "seasonal", "minimodel", "pawprint"] as const;

const PLUS_EXTRA_SLOTS = [
  "accessory_2", "accessory_3",
  "sticker_1", "sticker_2", "sticker_3", "sticker_4", "sticker_5",
  "credit_pack", "video_gen", "restyle",
] as const;

const SLOT_DESCRIPTIONS: Record<string, string> = {
  accessory:   "A wearable pet accessory (collar, bow, bandana, hat, jacket, etc.) that fits the theme. Must be a mesh that attaches to the 3D model skeleton.",
  seasonal:    "A seasonal or holiday-themed collectible item (ornament, holiday figure, festive trinket). Digital only.",
  minimodel:   "A prefab mini-model — a small 3D object (companion animal, food item, toy, furniture piece) that complements the theme.",
  pawprint:    "A digital Pawprint artwork — a themed greeting card or art piece featuring the pet. Describe the style, colors, and any text.",
  accessory_2: "A second wearable accessory complementing the main accessory but distinct (different category — e.g. if accessory is a hat, this is a cape).",
  accessory_3: "A third wearable accessory — a small finishing touch (badge, pin, scarf, tail bow, etc.).",
  sticker_1:   "Purr Pack sticker 1: a fun, playful animal-themed digital sticker. Describe the art style and what it depicts.",
  sticker_2:   "Purr Pack sticker 2: a different fun animal sticker — distinct species or mood from sticker_1.",
  sticker_3:   "Purr Pack sticker 3: a reaction/emote-style animal sticker.",
  sticker_4:   "Purr Pack sticker 4: a seasonal or holiday animal sticker matching the month's theme.",
  sticker_5:   "Purr Pack sticker 5: a cute food/object sticker (pizza slice, taco, donut, etc.) in a pet/animal art style.",
  credit_pack: "20 credits added to the user's account. Use title '20-Credit Boost' and describe as a monthly credit top-up. No further customization needed.",
  video_gen:   "A premade video generation script — a short narrated video about a topic that changes monthly. Provide: a one-sentence script theme and a suggested narrator tone.",
  restyle:     "One free model restyle coupon — describe the style option to feature this month (e.g. 'Clay figurine', 'Vintage oil painting', 'Neon cyberpunk'). Optional — user only redeems if their model already exists.",
};

// ---------------------------------------------------------------------------
// Gemini planner
// ---------------------------------------------------------------------------

const PLAN_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    schema_version: { type: "STRING", enum: ["wags.plan.v1"] },
    box_month:      { type: "STRING" },
    tier:           { type: "STRING", enum: ["basic", "plus"] },
    season:         { type: "STRING" },
    theme:          { type: "STRING" },
    theme_rationale: { type: "STRING" },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          slot:        { type: "STRING" },
          title:       { type: "STRING" },
          description: { type: "STRING" },
          category:    { type: "STRING" },
          colors:      { type: "ARRAY", items: { type: "STRING" } },
          tags:        { type: "ARRAY", items: { type: "STRING" } },
          size_note:   { type: "STRING" },
        },
        required: ["slot", "title", "description", "category", "colors", "tags"],
      },
    },
  },
  required: ["schema_version", "box_month", "tier", "season", "theme", "theme_rationale", "items"],
} as const;

export async function planWagsBox(input: WagsPlannerInput): Promise<WagsPlan> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set — cannot plan Wags box.");

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { "User-Agent": "aistudio-build" } },
  });
  const model = process.env.GEMINI_WAGS_MODEL || "gemini-3.1-flash-lite";

  const monthNum = parseInt(input.box_month.split("-")[1] ?? "1", 10);
  const season = getSeason(monthNum);
  const holidayHints = getHolidayHints(monthNum);
  const slots = input.tier === "plus"
    ? [...BASIC_SLOTS, ...PLUS_EXTRA_SLOTS]
    : [...BASIC_SLOTS];

  const avoidThemes = input.previous_themes.length
    ? `\nAvoid these themes used in previous boxes: ${input.previous_themes.join(", ")}.`
    : "";
  const avoidTitles = input.previous_item_titles.length
    ? `\nAvoid these item titles already sent: ${input.previous_item_titles.slice(0, 20).join(", ")}.`
    : "";

  const slotList = slots.map((s) => `- ${s}: ${SLOT_DESCRIPTIONS[s] ?? s}`).join("\n");

  const systemInstruction = `\
You are a creative director for a monthly digital pet subscription box called Wardrobe Wags. \
You curate personalized, themed digital accessories and collectibles for ${input.pet_species}s. \
All items are digital — they appear on or alongside the pet's 3D model. \
Your boxes are charming, playful, and season-appropriate. \
Every box has a strong visual theme that ties all items together.`;

  const prompt = `\
Plan a Wardrobe Wags box for ${input.box_month}.

Pet: ${input.pet_species}${input.pet_breed ? ` — ${input.pet_breed}` : ""}${input.pet_name ? ` named ${input.pet_name}` : ""}
Tier: ${input.tier} (${slots.length} items)
Season: ${season}
Month theme inspiration: ${holidayHints}
${avoidThemes}${avoidTitles}

For each slot, generate an item:
${slotList}

Output a single JSON document matching the provided schema. \
The theme should be memorable (e.g. "Cozy Harvest Cabin", "Midnight Masquerade", "Tropical Pawradise"). \
All items must feel cohesive with the theme. \
For ${input.pet_species}s, make sure clothing/accessories are pet-appropriate in scale and style.`;

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: PLAN_RESPONSE_SCHEMA as object,
      temperature: 1.0,
    },
  });

  const text = (response.text ?? "").trim();
  if (!text) throw new Error("Gemini returned an empty Wags plan.");
  return JSON.parse(text) as WagsPlan;
}

// ---------------------------------------------------------------------------
// Helper: fetch prior box themes + titles for a subscription
// ---------------------------------------------------------------------------

export async function getPriorBoxHistory(
  subscriptionId: number,
  pool: any,
): Promise<{ previous_themes: string[]; previous_item_titles: string[] }> {
  const [rows]: any = await pool.query(
    `SELECT plan_json FROM wardrobe_wags_boxes
     WHERE subscription_id = ? AND status IN ('approved', 'delivered', 'delivered_flagged', 'reviewed_ok', 'reviewed_issue')
     ORDER BY box_month DESC LIMIT 6`,
    [subscriptionId],
  );
  const previous_themes: string[] = [];
  const previous_item_titles: string[] = [];
  for (const row of (rows ?? [])) {
    const plan: WagsPlan | null = typeof row.plan_json === "string"
      ? JSON.parse(row.plan_json)
      : row.plan_json;
    if (!plan) continue;
    if (plan.theme) previous_themes.push(plan.theme);
    for (const item of plan.items ?? []) {
      if (item.title) previous_item_titles.push(item.title);
    }
  }
  return { previous_themes, previous_item_titles };
}
