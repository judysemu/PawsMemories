import { FAMOUS_PORTRAIT_BY_ID } from "./historicalPetCatalog.ts";

export interface HistoricPawprintTemplate {
  category: "historic_portraits";
  layoutId: string;
  name: string;
  tone: string;
  sampleCopy: string[];
  fieldSchema: Array<{ key: string; type: "text" | "image" | "name" | "message"; label: string; maxLength?: number }>;
  imagePromptTemplate: string;
}

const DIGITAL_ROLE_IDS = [
  "the-composer",
  "the-naturalist",
  "the-novelist",
  "the-lamplight-healer",
  "joan-of-arc",
  "cleopatra",
  "santa",
  "the-chef",
  "the-rock-star",
  "the-moon-explorer",
  "harriet-tubman",
  "ada-lovelace",
  "abraham-lincoln",
  "nelson-mandela",
  "airborne-alley-cat",
] as const;

export const HISTORIC_PHYSICAL_TEMPLATE_IDS = [
  "the-composer",
  "joan-of-arc",
  "cleopatra",
  "santa",
  "the-chef",
] as const;

export const HISTORIC_DIGITAL_TEMPLATES: HistoricPawprintTemplate[] = DIGITAL_ROLE_IDS.map((id) => {
  const portrait = FAMOUS_PORTRAIT_BY_ID.get(id);
  if (!portrait) throw new Error(`Historic Pawprint role ${id} is missing from Famous Portraits.`);
  return {
    category: "historic_portraits",
    layoutId: portrait.id,
    name: portrait.displayName,
    tone: portrait.category === "sports-legends" ? "triumphant" : "cinematic",
    sampleCopy: [`${portrait.displayName}, starring my best friend.`, "A little legend with a very big story."],
    fieldSchema: [
      { key: "petPhoto", type: "image", label: "Pet Photo" },
      { key: "petName", type: "name", label: "Pet Name", maxLength: 60 },
      { key: "message", type: "message", label: "Keepsake Message", maxLength: 220 },
    ],
    imagePromptTemplate: `${portrait.prompt} Compose the result as premium 4:5 keepsake art with room for a short title and message.`,
  };
});

const PHYSICAL_IDS = new Set<string>(HISTORIC_PHYSICAL_TEMPLATE_IDS);

export function historicTemplatesForIntent(intent: "digital" | "digital-printed") {
  return intent === "digital"
    ? HISTORIC_DIGITAL_TEMPLATES
    : HISTORIC_DIGITAL_TEMPLATES.filter((template) => PHYSICAL_IDS.has(template.layoutId));
}
