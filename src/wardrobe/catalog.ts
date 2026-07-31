export type WardrobeKind = "neck" | "head" | "body" | "back" | "face";

export interface WardrobeItem {
  id: string;
  name: string;
  kind: WardrobeKind;
  color: string;
  sourceUnits: "meter";
  conversionToMeters: 1;
  dimensionsMeters: [number, number, number];
  anchorMeters: [number, number, number];
  axes: "right-handed-y-up";
  sourceLibrary: string;
  sourceUrl: string;
  license: "CC0-1.0";
  geometry: "procedural-web-derivative";
  /** Closed authoring profile; generated maps are optional and locally served. */
  materialId: string;
}

const SOURCE_LIBRARY = "Quaternius Modular Character Outfits - Fantasy";
const SOURCE_URL = "https://quaternius.com/packs/modularcharacteroutfitsfantasy.html";

const item = (
  id: string,
  name: string,
  kind: WardrobeKind,
  color: string,
  dimensionsMeters: [number, number, number],
  anchorMeters: [number, number, number],
  materialId: string,
): WardrobeItem => ({
  id, name, kind, color, dimensionsMeters, anchorMeters, materialId,
  sourceUnits: "meter", conversionToMeters: 1, axes: "right-handed-y-up",
  sourceLibrary: SOURCE_LIBRARY, sourceUrl: SOURCE_URL, license: "CC0-1.0",
  geometry: "procedural-web-derivative",
});

/** Web-safe wardrobe derivatives; one Three.js unit is one meter. */
export const WARDROBE_CATALOG: WardrobeItem[] = [
  item("scarlet-collar", "Scarlet Collar", "neck", "#b4232f", [0.42, 0.06, 0.42], [0, 0.92, 0], "scarlet-leather"),
  item("forest-collar", "Forest Collar", "neck", "#276749", [0.42, 0.06, 0.42], [0, 0.92, 0], "forest-leather"),
  item("gold-bow", "Golden Bow Tie", "neck", "#d69e2e", [0.34, 0.18, 0.1], [0, 0.83, 0.2], "burnished-gold"),
  item("blue-bandana", "Blue Bandana", "neck", "#2b6cb0", [0.42, 0.3, 0.08], [0, 0.8, 0.18], "navy-textile"),
  item("ranger-cape", "Ranger Cape", "back", "#355e3b", [0.62, 0.72, 0.08], [0, 0.68, -0.22], "ranger-canvas"),
  item("royal-cape", "Royal Cape", "back", "#6b46c1", [0.62, 0.72, 0.08], [0, 0.68, -0.22], "royal-velvet"),
  item("party-hat", "Party Hat", "head", "#ed64a6", [0.3, 0.42, 0.3], [0, 1.42, 0], "bright-felt"),
  item("wizard-hat", "Wizard Hat", "head", "#44337a", [0.48, 0.58, 0.48], [0, 1.42, 0], "royal-velvet"),
  item("ranger-hood", "Ranger Hood", "head", "#2f855a", [0.46, 0.42, 0.4], [0, 1.25, 0], "ranger-canvas"),
  item("gold-crown", "Golden Crown", "head", "#d6ad29", [0.38, 0.3, 0.38], [0, 1.4, 0], "burnished-gold"),
  item("round-glasses", "Round Glasses", "face", "#2d3748", [0.42, 0.16, 0.04], [0, 1.2, 0.24], "optical-enamel"),
  item("heart-glasses", "Heart Glasses", "face", "#e53e3e", [0.46, 0.18, 0.04], [0, 1.2, 0.24], "optical-enamel"),
  item("adventure-vest", "Adventure Vest", "body", "#975a16", [0.58, 0.52, 0.34], [0, 0.68, 0], "ranger-canvas"),
  item("winter-vest", "Winter Vest", "body", "#3182ce", [0.6, 0.54, 0.36], [0, 0.68, 0], "navy-textile"),
  item("hero-medallion", "Hero Medallion", "neck", "#ecc94b", [0.18, 0.24, 0.05], [0, 0.78, 0.22], "burnished-gold"),
];

/**
 * Wardrobe Wags exclusive variants — delivered only through the monthly box
 * (W3 delivery grants; never in the free catalog). Same procedural geometry
 * pathway as the base catalog until real GLBs land, so every item here renders
 * in the viewer today. Seasonal recolors chosen to pair with planner themes.
 */
export const WAGS_EXCLUSIVE_CATALOG: WardrobeItem[] = [
  item("wags-rose-collar", "Rose Garden Collar", "neck", "#c2547e", [0.42, 0.06, 0.42], [0, 0.92, 0], "rose-leather"),
  item("wags-midnight-collar", "Midnight Collar", "neck", "#1a2340", [0.42, 0.06, 0.42], [0, 0.92, 0], "midnight-leather"),
  item("wags-copper-bow", "Copper Bow Tie", "neck", "#b26a3a", [0.34, 0.18, 0.1], [0, 0.83, 0.2], "copper-leather"),
  item("wags-sunset-bandana", "Sunset Bandana", "neck", "#d97742", [0.42, 0.3, 0.08], [0, 0.8, 0.18], "seasonal-cloth"),
  item("wags-frost-cape", "Frost Cape", "back", "#7fa8c9", [0.62, 0.72, 0.08], [0, 0.68, -0.22], "frosted-cloth"),
  item("wags-ember-cape", "Ember Cape", "back", "#9c3a1e", [0.62, 0.72, 0.08], [0, 0.68, -0.22], "ember-cloth"),
  item("wags-meadow-hat", "Meadow Party Hat", "head", "#5a9e4b", [0.3, 0.42, 0.3], [0, 1.42, 0], "bright-felt"),
  item("wags-star-hat", "Stargazer Hat", "head", "#2c2a5e", [0.48, 0.58, 0.48], [0, 1.42, 0], "royal-velvet"),
  item("wags-silver-crown", "Silver Crown", "head", "#b8bfc9", [0.38, 0.3, 0.38], [0, 1.4, 0], "antique-silver"),
  item("wags-amber-glasses", "Amber Glasses", "face", "#c98a2d", [0.42, 0.16, 0.04], [0, 1.2, 0.24], "optical-enamel"),
  item("wags-autumn-vest", "Autumn Vest", "body", "#8a5a2b", [0.58, 0.52, 0.34], [0, 0.68, 0], "copper-leather"),
  item("wags-spring-vest", "Spring Vest", "body", "#4c9e6e", [0.6, 0.54, 0.36], [0, 0.68, 0], "seasonal-cloth"),
];

export const WAGS_EXCLUSIVE_ITEM_IDS = new Set(WAGS_EXCLUSIVE_CATALOG.map(({ id }) => id));

/** Every renderable wardrobe item — base plus Wags exclusives. */
export const FULL_WARDROBE_CATALOG: WardrobeItem[] = [...WARDROBE_CATALOG, ...WAGS_EXCLUSIVE_CATALOG];
export const WARDROBE_ITEM_IDS = new Set(FULL_WARDROBE_CATALOG.map(({ id }) => id));
