import { FAMOUS_PORTRAIT_BY_ID } from "./historicalPetCatalog.ts";

export interface HistoricPawprintTemplate {
  category: string;
  layoutId: string;
  name: string;
  tone: string;
  sampleCopy: string[];
  fieldSchema: Array<{ key: string; type: "text" | "image" | "name" | "message"; label: string; maxLength?: number }>;
  imagePromptTemplate: string;
  sourceUrl: string;
  sourceLicense: "owned-generated";
  sourceName: string;
}

const HISTORIC_ROLES = [
  ["joan-of-arc", "Joan of Arc", "ceremonial medieval armor and an original unmarked banner in a softly lit stone hall"],
  ["cleopatra", "Cleopatra", "an original jeweled collar in a warm Ptolemaic-inspired palace"],
  ["courageous-guide", "The Courageous Guide", "a hooded lantern beneath a north-star night sky on a safe woodland path"],
  ["the-visionary", "The Visionary", "an original brass calculating engine in an early Victorian study"],
  ["the-composer", "The Composer", "a Georgian chamber music room beside a keyboard and blank manuscript"],
  ["the-statespet", "The Statespet", "a thoughtful nineteenth-century lamplit civic office with blank papers"],
  ["hopeful-leader", "The Hopeful Leader", "an original patterned formal jacket in a bright sunrise civic hall"],
  ["peaceful-guide", "The Peaceful Guide", "a simple woven shawl in a quiet sunlit courtyard"],
  ["mountain-guide", "The Mountain Guide", "an ancient desert mountain setting beside two blank stone tablets"],
  ["santa", "The Winter Gift-Giver", "an original red wool coat in a warm artisan toy workshop"],
  ["the-moon-explorer", "Moon Explorer", "an original pet-shaped lunar exploration suit on a stylized moon plain"],
  ["the-chef", "Grand Chef", "a pet-safe feast in a copper grand kitchen"],
  ["the-rock-star", "Rock Star", "original unbranded stagewear and an instrument under plum and teal concert lights"],
  ["snow-guardian", "Snow Guardian", "a friendly winter guardian in snowy mountains, with the pet face fully visible"],
  ["forest-legend", "Forest Legend", "a gentle shaggy woodland adventurer in a misty old-growth forest"],
  ["championship-boxer", "Championship Boxer", "a red vintage boxing robe in a heroic arena portrait"],
  ["the-gymnast", "The Gymnast", "a pet-safe red, white, and blue performance outfit beneath arena spotlights"],
  ["purrs-23", "PURRS 23", "a red basketball uniform reading only PURRS with the number 23"],
  ["gridiron-12", "Gridiron 12", "an original navy and silver football uniform with the number 12"],
  ["tennis-champion", "Tennis Champion", "an elegant original white tennis outfit on a grass court"],
] as const;

/**
 * PP-2/PP-3: the allowlisted role ids, in the exact order they appear in the
 * 5-across x 4-down contact sheet at
 * `/collections/historic-pawprints/historic-pawprints-20-v1.webp`.
 *
 * The UI slices that one sheet into per-role thumbnails by index, so this order
 * is load-bearing — adding or reordering a role here without regenerating the
 * sheet will show customers the wrong picture for a title.
 *
 * Documented counts should be derived from `HISTORIC_ROLE_IDS.length`, never
 * hard-coded (the README previously claimed fifteen roles while this array held
 * twenty).
 */
export const HISTORIC_ROLE_IDS: string[] = HISTORIC_ROLES.map(([id]) => id);
export const HISTORIC_ROLE_SHEET_COLUMNS = 5;
export const HISTORIC_ROLE_SHEET_ROWS = 4;

export const HISTORIC_PHYSICAL_TEMPLATE_IDS = [
  "the-composer",
  "joan-of-arc",
  "cleopatra",
  "santa",
  "the-chef",
] as const;

export const HISTORIC_DIGITAL_TEMPLATES: HistoricPawprintTemplate[] = HISTORIC_ROLES.map(([id, displayName, scene]) => {
  const portrait = FAMOUS_PORTRAIT_BY_ID.get(id);
  return {
    category: "historic_portraits",
    layoutId: id,
    name: displayName,
    tone: /boxer|gymnast|purrs|gridiron|tennis/i.test(id) ? "triumphant" : "cinematic",
    sampleCopy: [`${displayName}, starring my best friend.`, "A little legend with a very big story."],
    fieldSchema: [
      { key: "petPhoto", type: "image", label: "Pet Photo" },
      { key: "petName", type: "name", label: "Pet Name", maxLength: 60 },
      { key: "message", type: "message", label: "Keepsake Message", maxLength: 220 },
    ],
    imagePromptTemplate: `${portrait?.prompt || `Create an original historical pet portrait featuring ${scene}.`} Compose the result as premium vertical 4:5 keepsake art. Preserve the pet's exact face, coat markings, eye color, ear shape, muzzle, anatomy, species, and proportions. Use natural grounded paws when visible. No human likeness, logos, signatures, sponsors, random text, extra limbs, or copied film costumes.`,
    sourceUrl: "/collections/historic-pawprints/historic-pawprints-20-v1.webp",
    sourceLicense: "owned-generated",
    sourceName: "Pawsome3D Historic Pawprints 20-scene collection",
  };
});

// Generate templates for the new portrait catalog items (halloween, landmarks)
const ADDITIONAL_TEMPLATES: HistoricPawprintTemplate[] = [];
for (const portrait of FAMOUS_PORTRAIT_BY_ID.values()) {
  if (HISTORIC_ROLES.some(([id]) => id === portrait.id)) continue;
  
  const isDuo = portrait.id.startsWith("duo-") || portrait.category === "landmarks";
  
  let promptExtension = ` Preserve the pet's exact face, coat markings, eye color, ear shape, muzzle, anatomy, species, and proportions. Use natural grounded paws when visible. No human likeness, logos, signatures, sponsors, random text, extra limbs, or copied film costumes.`;
  if (isDuo) {
    promptExtension = ` Preserve the exact faces of BOTH the human owner (or second pet) and the primary pet, accurately reflecting their relationship and physical traits based on the inputs. Make sure both subjects are naturally integrated into the scene side-by-side. No random text, extra limbs, or logos.`;
  }

  ADDITIONAL_TEMPLATES.push({
    category: portrait.category,
    layoutId: portrait.id,
    name: portrait.displayName,
    tone: "cinematic",
    sampleCopy: [`${portrait.displayName}, starring us.`, "A legend with a big story."],
    fieldSchema: [
      { key: "petPhoto", type: "image", label: isDuo ? "Owner & Pet Photo(s)" : "Pet Photo" },
      { key: "petName", type: "name", label: isDuo ? "Names" : "Pet Name", maxLength: 60 },
      { key: "message", type: "message", label: "Keepsake Message", maxLength: 220 },
    ],
    imagePromptTemplate: `${portrait.prompt} Compose the result as premium vertical 4:5 keepsake art.${promptExtension}`,
    sourceUrl: portrait.previewAsset?.publicPath || "/collections/historic-pawprints/historic-pawprints-20-v1.webp",
    sourceLicense: "owned-generated",
    sourceName: "Pawsome3D Extended Portrait Collection",
  });
}

export const ALL_DIGITAL_TEMPLATES = [...HISTORIC_DIGITAL_TEMPLATES, ...ADDITIONAL_TEMPLATES];

const PHYSICAL_IDS = new Set<string>(HISTORIC_PHYSICAL_TEMPLATE_IDS);

export function historicTemplatesForIntent(intent: "digital" | "digital-printed") {
  return intent === "digital"
    ? ALL_DIGITAL_TEMPLATES
    : ALL_DIGITAL_TEMPLATES.filter((template) => PHYSICAL_IDS.has(template.layoutId));
}
