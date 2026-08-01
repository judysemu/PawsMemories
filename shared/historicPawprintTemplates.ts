import { FAMOUS_PORTRAIT_BY_ID } from "./historicalPetCatalog.ts";

export interface HistoricPawprintTemplate {
  category: "historic_portraits";
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

const PHYSICAL_IDS = new Set<string>(HISTORIC_PHYSICAL_TEMPLATE_IDS);

export function historicTemplatesForIntent(intent: "digital" | "digital-printed") {
  return intent === "digital"
    ? HISTORIC_DIGITAL_TEMPLATES
    : HISTORIC_DIGITAL_TEMPLATES.filter((template) => PHYSICAL_IDS.has(template.layoutId));
}
