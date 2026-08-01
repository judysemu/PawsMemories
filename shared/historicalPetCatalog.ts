import { z } from "zod";

const HistoricalAssetSchema = z.object({
  publicPath: z.string().regex(/^\/collections\/historical-pets\/[a-z0-9-]+-v\d+\.(?:webp|png)$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const HISTORICAL_PET_RECORD_SCHEMA = z.object({
  id: z.enum(["the-composer", "the-naturalist", "the-novelist", "the-lamplight-healer"]),
  displayName: z.string().min(1),
  fictionalRole: z.string().min(1),
  stylePeriod: z.string().min(1),
  species: z.enum(["cat", "dog"]),
  previewAsset: HistoricalAssetSchema,
  sourceAsset: HistoricalAssetSchema,
  assetVersion: z.literal("1"),
  provenance: z.literal("OpenAI imagegen, generated for Pawsome3D on 2026-07-31"),
  rightsStatus: z.literal("owned-generated"),
  altText: z.string().min(20),
  directorScriptIds: z.array(z.string().min(1)).min(1),
  availability: z.literal("preview"),
});

export const HISTORICAL_PET_CATALOG_SCHEMA = z.array(HISTORICAL_PET_RECORD_SCHEMA).length(4);
export type HistoricalPetRecord = z.infer<typeof HISTORICAL_PET_RECORD_SCHEMA>;

const provenance = "OpenAI imagegen, generated for Pawsome3D on 2026-07-31" as const;

export const HISTORICAL_PET_CATALOG: HistoricalPetRecord[] = HISTORICAL_PET_CATALOG_SCHEMA.parse([
  {
    id: "the-composer",
    displayName: "The Composer",
    fictionalRole: "A feline chamber composer preparing an original overture",
    stylePeriod: "late Georgian-inspired music room",
    species: "cat",
    previewAsset: { publicPath: "/collections/historical-pets/the-composer-v1.webp", sha256: "325f73e3a241af855c64faa5c51ee462ab651be3c4120357d4ece522ce2b2ee9", width: 900, height: 900 },
    sourceAsset: { publicPath: "/collections/historical-pets/the-composer-v1.png", sha256: "73530e3883063970974cd5882216af121031a68e9e4a9e517a3ab39def302541", width: 1254, height: 1254 },
    assetVersion: "1",
    provenance,
    rightsStatus: "owned-generated",
    altText: "An orange long-haired cat posed as an original chamber composer beside sheet music and a keyboard.",
    directorScriptIds: ["composer-overture"],
    availability: "preview",
  },
  {
    id: "the-naturalist",
    displayName: "The Naturalist",
    fictionalRole: "A canine field naturalist recording a woodland discovery",
    stylePeriod: "mid-Victorian-inspired natural history study",
    species: "dog",
    previewAsset: { publicPath: "/collections/historical-pets/the-naturalist-v1.webp", sha256: "fc7272c0f2281d3ab462f52d74da55a1f92fb4237c986337d941eabc7fb41387", width: 900, height: 900 },
    sourceAsset: { publicPath: "/collections/historical-pets/the-naturalist-v1.png", sha256: "53d2b40a2ec24b76a8d37828c87043c78c1337dd54091380a75bf10f03cf8de2", width: 1254, height: 1254 },
    assetVersion: "1",
    provenance,
    rightsStatus: "owned-generated",
    altText: "A beagle-like dog portrayed as an original field naturalist in a green coat among specimens and books.",
    directorScriptIds: ["naturalist-discovery"],
    availability: "preview",
  },
  {
    id: "the-novelist",
    displayName: "The Novelist",
    fictionalRole: "A feline novelist drafting a midnight chapter",
    stylePeriod: "early nineteenth-century-inspired candlelit library",
    species: "cat",
    previewAsset: { publicPath: "/collections/historical-pets/the-novelist-v1.webp", sha256: "e57d04207e4592ca439632905fa02bbe43a0ae03641d25f2f30077f891611fa5", width: 900, height: 900 },
    sourceAsset: { publicPath: "/collections/historical-pets/the-novelist-v1.png", sha256: "4bdf33c617add8b4dc8c14ab5fe34f12810bfa76a6afec3be4af1a389569ca4b", width: 1254, height: 1254 },
    assetVersion: "1",
    provenance,
    rightsStatus: "owned-generated",
    altText: "A black-and-white cat portrayed as an original novelist writing at a candlelit desk surrounded by books.",
    directorScriptIds: ["novelist-midnight-draft"],
    availability: "preview",
  },
  {
    id: "the-lamplight-healer",
    displayName: "The Lamplight Healer",
    fictionalRole: "A compassionate canine night healer keeping a quiet vigil",
    stylePeriod: "late Victorian-inspired lamplit care room",
    species: "dog",
    previewAsset: { publicPath: "/collections/historical-pets/the-lamplight-healer-v1.webp", sha256: "a8bf89f9b3489ed77af53c2d6ff63837ac46e265c18cf734e59560dcca57196c", width: 900, height: 900 },
    sourceAsset: { publicPath: "/collections/historical-pets/the-lamplight-healer-v1.png", sha256: "55e91d413c07b34c4de21f40745c1b7e9ab05f4a0c9c41896c40898c81457e96", width: 1254, height: 1254 },
    assetVersion: "1",
    provenance,
    rightsStatus: "owned-generated",
    altText: "A small spaniel portrayed as an original lamplight healer in a calm moonlit care room.",
    directorScriptIds: ["lamplight-healer-vigil"],
    availability: "preview",
  },
]);

export const HISTORICAL_PET_BY_ID = new Map(HISTORICAL_PET_CATALOG.map((entry) => [entry.id, entry]));

export const FAMOUS_PORTRAIT_CATEGORIES = [
  "historic-women",
  "leaders",
  "sports-legends",
  "myth-holiday",
  "arts-adventure",
] as const;

const FamousPortraitCategorySchema = z.enum(FAMOUS_PORTRAIT_CATEGORIES);

export const FAMOUS_PORTRAIT_RECORD_SCHEMA = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  displayName: z.string().min(1),
  category: FamousPortraitCategorySchema,
  fictionalRole: z.string().min(1),
  stylePeriod: z.string().min(1),
  species: z.enum(["cat", "dog", "either"]),
  prompt: z.string().min(20),
  altText: z.string().min(20),
  uniformNumber: z.number().int().min(0).max(99).nullable(),
  fictionalMark: z.string().min(1).nullable(),
  palette: z.tuple([z.string().regex(/^#[a-f0-9]{6}$/i), z.string().regex(/^#[a-f0-9]{6}$/i), z.string().regex(/^#[a-f0-9]{6}$/i)]),
  inspirationSource: z.string().url().nullable(),
  numberSource: z.string().url().nullable(),
  previewAsset: HistoricalAssetSchema.optional(),
  assetVersion: z.literal("1"),
  provenance: z.string().min(1),
  rightsStatus: z.enum(["owned-generated", "planned-original"]),
  directorScriptIds: z.array(z.string().min(1)),
  availability: z.enum(["available", "coming-soon"]),
}).superRefine((record, context) => {
  if (record.availability === "available" && !record.previewAsset) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Available portraits require a preview asset.", path: ["previewAsset"] });
  }
  if (record.category === "sports-legends" && record.uniformNumber !== null && !record.numberSource) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Sports jersey numbers require a verification source.", path: ["numberSource"] });
  }
});

export const FAMOUS_PORTRAIT_CATALOG_SCHEMA = z.array(FAMOUS_PORTRAIT_RECORD_SCHEMA).min(50);
export type FamousPortraitRecord = z.infer<typeof FAMOUS_PORTRAIT_RECORD_SCHEMA>;

type PlannedPortraitInput = Pick<FamousPortraitRecord,
  "id" | "displayName" | "category" | "fictionalRole" | "stylePeriod" | "species" | "altText"
> & Partial<Pick<FamousPortraitRecord,
  "uniformNumber" | "fictionalMark" | "palette" | "inspirationSource" | "numberSource" | "directorScriptIds"
>>;

function plannedPortrait(input: PlannedPortraitInput): FamousPortraitRecord {
  return {
    ...input,
    prompt: `Create an original, premium pet portrait for the ${input.displayName} role. Keep the pet's face, coat, anatomy, and identity recognizable; use no logos, signatures, sponsors, or copied human likeness.`,
    uniformNumber: input.uniformNumber ?? null,
    fictionalMark: input.fictionalMark ?? null,
    palette: input.palette ?? ["#2f243a", "#e8cfa8", "#9f6b4f"],
    inspirationSource: input.inspirationSource ?? null,
    numberSource: input.numberSource ?? null,
    assetVersion: "1",
    provenance: "Original Pawsome3D portrait art direction, approved 2026-08-01",
    rightsStatus: "planned-original",
    directorScriptIds: input.directorScriptIds ?? [],
    availability: "coming-soon",
  };
}

const availableHistoricalPortraits: FamousPortraitRecord[] = HISTORICAL_PET_CATALOG.map((entry) => ({
  id: entry.id,
  displayName: entry.displayName,
  category: "arts-adventure",
  fictionalRole: entry.fictionalRole,
  stylePeriod: entry.stylePeriod,
  species: entry.species,
  prompt: `Preserve the reviewed ${entry.displayName} composition as an unmistakable pet portrait.`,
  altText: entry.altText,
  uniformNumber: null,
  fictionalMark: null,
  palette: ["#2f243a", "#e8cfa8", "#9f6b4f"],
  inspirationSource: null,
  numberSource: null,
  previewAsset: entry.previewAsset,
  assetVersion: "1",
  provenance: entry.provenance,
  rightsStatus: "owned-generated",
  directorScriptIds: entry.directorScriptIds,
  availability: "available",
}));

const historicalWomen: FamousPortraitRecord[] = [
  ["joan-of-arc", "Joan of Arc", "A brave banner bearer in polished medieval armor", "fifteenth-century France", "A pet posed with a banner in polished medieval armor before a softly lit stone hall."],
  ["cleopatra", "Cleopatra", "A regal pet sovereign entering a golden palace", "Ptolemaic-inspired royal court", "A regal pet wearing an original jeweled collar in a warm golden palace interior."],
  ["harriet-tubman", "Harriet Tubman", "A courageous guide beneath a star-filled night sky", "nineteenth-century American journey", "A steadfast pet guide beneath a clear night sky with a lantern and distant safe path."],
  ["ada-lovelace", "Ada Lovelace", "A visionary mathematician beside an original brass calculating engine", "early Victorian scientific study", "A thoughtful pet at a writing desk beside an original brass calculating machine."],
  ["marie-curie", "Marie Curie", "A pioneering scientist in a softly glowing laboratory", "early twentieth-century laboratory", "A focused pet scientist in a period laboratory with glass instruments and a subtle blue glow."],
  ["amelia-earhart", "Amelia Earhart", "A fearless aviator ready for an open-sky journey", "1930s aviation field", "A confident pet aviator wearing an original leather flight cap beside a silver propeller plane."],
  ["frida-kahlo", "Frida Kahlo", "A bold studio artist surrounded by vivid flowers", "twentieth-century Mexican-inspired art studio", "A dignified pet artist seated in a colorful original studio composition surrounded by flowers."],
  ["queen-elizabeth-i", "Queen Elizabeth I", "A stately Renaissance sovereign in an original royal portrait", "Elizabethan-inspired court", "A stately pet in an original red-and-gold Renaissance court portrait with a lace collar."],
  ["sacagawea", "Sacagawea", "A knowledgeable trail guide overlooking a broad river valley", "early nineteenth-century North American expedition", "A capable pet guide overlooking a wide river valley with a field journal and trail pack."],
  ["sojourner-truth", "Sojourner Truth", "A commanding speaker standing in warm window light", "nineteenth-century American lecture hall", "A dignified pet speaker at a wooden lectern in a calm nineteenth-century hall."],
].map(([id, displayName, fictionalRole, stylePeriod, altText]) => plannedPortrait({ id, displayName, category: "historic-women", fictionalRole, stylePeriod, species: "either", altText }));

const leaders: FamousPortraitRecord[] = [
  ["moses", "Moses", "A respectful wilderness lawgiver holding unmarked stone tablets", "ancient Near Eastern-inspired wilderness"],
  ["mahatma-gandhi", "Mahatma Gandhi", "A peaceful civic leader in a quiet hand-spinning room", "early twentieth-century India-inspired setting"],
  ["george-washington", "George Washington", "A composed early American commander beside a campaign map", "late eighteenth-century American study"],
  ["abraham-lincoln", "Abraham Lincoln", "A thoughtful statespet in a lamplit office", "nineteenth-century American office"],
  ["theodore-roosevelt", "Theodore Roosevelt", "An energetic conservation-minded leader in a field camp", "early twentieth-century outdoor expedition"],
  ["franklin-d-roosevelt", "Franklin D. Roosevelt", "A steady wartime leader at a radio address", "1940s American study"],
  ["dwight-d-eisenhower", "Dwight D. Eisenhower", "A calm allied commander studying an original map", "1940s command room"],
  ["john-f-kennedy", "John F. Kennedy", "A forward-looking civic leader at a moon-program briefing", "early 1960s American office"],
  ["winston-churchill", "Winston Churchill", "A resolute wartime leader in a wood-paneled map room", "1940s British map room"],
  ["nelson-mandela", "Nelson Mandela", "A hopeful democratic leader in warm sunrise light", "late twentieth-century South African-inspired civic hall"],
  ["napoleon-bonaparte", "Napoleon Bonaparte", "A compact field commander before an original campaign map", "early nineteenth-century European field tent"],
  ["queen-victoria", "Queen Victoria", "A formal sovereign in a restrained royal study", "late Victorian royal study"],
].map(([id, displayName, fictionalRole, stylePeriod]) => plannedPortrait({
  id, displayName, category: "leaders", fictionalRole, stylePeriod, species: "either",
  altText: `A pet portrayed respectfully as ${fictionalRole.toLowerCase()} in a ${stylePeriod.toLowerCase()} setting.`,
}));

const NUMBER_SOURCES = {
  jordan23: "https://www.nba.com/bulls/history/rise-shine",
  brady12: "https://www.patriots.com/news/tom-brady-bio",
  gretzky99: "https://www.nhl.com/news/nhl-s-who-wore-it-best-jersey-numbers-99-81-316921746",
  football10: "https://www.fifa.com/es/tournaments/mens/worldcup/canadamexicousa2026/articles/argentina-y-la-numero-10-relato-de-una-historia-de-interminables-herederos",
  curry30: "https://www.nba.com/player/201939/stephen-curry/bio",
  mahomes15: "https://www.chiefs.com/team/players-roster/patrick-mahomes/",
  hallOfFame: "https://www.profootballhof.com/heroes-of-the-game/jersey-number/",
  ruth3: "https://www.mlb.com/player/babe-ruth-121578",
  ohtani17: "https://www.mlb.com/player/shohei-ohtani-660271",
} as const;

type SportsSeed = [
  id: string,
  displayName: string,
  fictionalRole: string,
  stylePeriod: string,
  uniformNumber: number | null,
  fictionalMark: string | null,
  inspirationSource: string,
  numberSource: string | null,
];

const sportsSeeds: SportsSeed[] = [
  ["airborne-alley-cat", "Airborne Alley Cat", "A soaring basketball pet at the rim", "arena spotlight", 23, "PURRS", "https://en.wikipedia.org/wiki/Michael_Jordan", NUMBER_SOURCES.jordan23],
  ["ring-champion", "Ring Champion", "A poised boxing pet between rounds", "classic boxing arena", null, "PAW POWER", "https://en.wikipedia.org/wiki/Muhammad_Ali", null],
  ["gravity-defying-gymnast", "Gravity-Defying Gymnast", "A powerful pet completing a clean airborne vault", "modern gymnastics arena", null, null, "https://en.wikipedia.org/wiki/Simone_Biles", null],
  ["lightning-sprinter", "Lightning Sprinter", "A fast pet exploding from the starting blocks", "night track stadium", null, null, "https://en.wikipedia.org/wiki/Usain_Bolt", null],
  ["championship-quarterback", "Championship Quarterback", "A focused pet reading the defense", "winter football stadium", 12, "HOUNDS", "https://en.wikipedia.org/wiki/Tom_Brady", NUMBER_SOURCES.brady12],
  ["center-court-maestro", "Center-Court Maestro", "A graceful pet preparing a one-handed return", "grass center court", null, null, "https://en.wikipedia.org/wiki/Roger_Federer", null],
  ["ice-visionary", "Ice Visionary", "A clever pet gliding into open ice", "bright hockey arena", 99, "ICE PAWS", "https://en.wikipedia.org/wiki/Wayne_Gretzky", NUMBER_SOURCES.gretzky99],
  ["left-footed-playmaker", "Left-Footed Playmaker", "A quick pet shaping a curling pass", "modern football stadium", 10, "WHISKERS", "https://en.wikipedia.org/wiki/Lionel_Messi", NUMBER_SOURCES.football10],
  ["beautiful-game-legend", "Beautiful-Game Legend", "A joyful pet controlling a vintage leather ball", "sunlit historic football pitch", 10, "TAILS", "https://en.wikipedia.org/wiki/Pel%C3%A9", NUMBER_SOURCES.football10],
  ["medal-lane-swimmer", "Medal-Lane Swimmer", "A streamlined pet racing beneath clear water", "competition swimming venue", null, null, "https://en.wikipedia.org/wiki/Michael_Phelps", null],
  ["all-around-champion", "All-Around Champion", "A versatile pet surrounded by classic sport equipment", "early twentieth-century field", null, null, "https://en.wikipedia.org/wiki/Jim_Thorpe", null],
  ["vert-ramp-pioneer", "Vert-Ramp Pioneer", "A fearless pet high above a wooden vert ramp", "sunset skate park", null, null, "https://en.wikipedia.org/wiki/Tony_Hawk", null],
  ["flying-snowboarder", "Flying Snowboarder", "A confident pet floating over a snowy halfpipe", "mountain halfpipe", null, null, "https://en.wikipedia.org/wiki/Shaun_White", null],
  ["long-range-sharpshooter", "Long-Range Sharpshooter", "A joyful pet releasing a deep basketball shot", "gold-lit basketball arena", 30, "PAWS", "https://en.wikipedia.org/wiki/Stephen_Curry", NUMBER_SOURCES.curry30],
  ["no-look-quarterback", "No-Look Quarterback", "A creative pet throwing across the field", "red-and-gold fictional football stadium", 15, "FETCH", "https://en.wikipedia.org/wiki/Patrick_Mahomes", NUMBER_SOURCES.mahomes15],
  ["field-general", "Field General", "A precise pet changing the play before the snap", "blue fictional football stadium", 18, "COLLARS", "https://en.wikipedia.org/wiki/Peyton_Manning", NUMBER_SOURCES.hallOfFame],
  ["two-way-showstopper", "Two-Way Showstopper", "A vibrant pet ready to return the ball", "bright fictional football stadium", 21, "PRIMES", "https://en.wikipedia.org/wiki/Deion_Sanders", NUMBER_SOURCES.hallOfFame],
  ["home-run-legend", "Home-Run Legend", "A sturdy pet following a towering home run", "vintage baseball park", 3, "BARKS", "https://en.wikipedia.org/wiki/Babe_Ruth", NUMBER_SOURCES.ruth3],
  ["two-way-baseball-phenom", "Two-Way Baseball Phenom", "A dynamic pet combining pitching and hitting", "modern fictional baseball park", 17, "PAWS ANGELES", "https://en.wikipedia.org/wiki/Shohei_Ohtani", NUMBER_SOURCES.ohtani17],
  ["cool-under-pressure-quarterback", "Cool-Under-Pressure Quarterback", "A calm pet delivering a late-game pass", "red-and-sand fictional football stadium", 16, "GOLDEN PAWS", "https://en.wikipedia.org/wiki/Joe_Montana", NUMBER_SOURCES.hallOfFame],
  ["golden-era-strongpet", "Golden-Era Strongpet", "A determined pet posing in a classic strength studio", "1970s-inspired training studio", null, null, "https://en.wikipedia.org/wiki/Arnold_Schwarzenegger", null],
  ["power-serve-champion", "Power-Serve Champion", "A commanding pet launching a powerful tennis serve", "night tennis stadium", null, null, "https://en.wikipedia.org/wiki/Serena_Williams", null],
];

const sports: FamousPortraitRecord[] = sportsSeeds.map(([id, displayName, fictionalRole, stylePeriod, uniformNumber, fictionalMark, inspirationSource, numberSource]) => plannedPortrait({
  id, displayName, category: "sports-legends", fictionalRole, stylePeriod, species: "either",
  altText: `A pet portrayed as ${fictionalRole.toLowerCase()} in a logo-free ${stylePeriod.toLowerCase()} scene.`,
  uniformNumber, fictionalMark, inspirationSource, numberSource,
  palette: ["#b3262e", "#f7d36d", "#17243b"],
}));

const mythHoliday: FamousPortraitRecord[] = [
  ["santa", "Santa", "A warm workshop gift-giver", "original winter workshop"],
  ["the-elves", "The Elves", "A merry pair of pet toy makers", "original winter workshop"],
  ["the-abominable-snowman", "The Abominable Snowman", "A fluffy mountain guardian", "moonlit alpine pass"],
  ["bigfoot", "Bigfoot", "A shaggy woodland mystery", "misty evergreen forest"],
  ["the-snow-queen", "The Snow Queen", "A regal winter pet beneath an ice crown", "original frozen palace"],
].map(([id, displayName, fictionalRole, stylePeriod]) => plannedPortrait({
  id, displayName, category: "myth-holiday", fictionalRole, stylePeriod, species: "either",
  altText: `A playful pet portrayed as ${fictionalRole.toLowerCase()} in an ${stylePeriod.toLowerCase()} scene.`,
}));

const artsAdventure: FamousPortraitRecord[] = [
  ["the-moon-explorer", "The Moon Explorer", "A brave pet explorer standing on the moon", "retro-futurist lunar scene"],
  ["the-chef", "The Chef", "A proud pet chef presenting a tiny feast", "warm grand kitchen"],
  ["the-rock-star", "The Rock Star", "A charismatic pet taking the concert stage", "original arena concert"],
].map(([id, displayName, fictionalRole, stylePeriod]) => plannedPortrait({
  id, displayName, category: "arts-adventure", fictionalRole, stylePeriod, species: "either",
  altText: `A pet portrayed as ${fictionalRole.toLowerCase()} in a ${stylePeriod.toLowerCase()} setting.`,
}));

export const FAMOUS_PORTRAIT_CATALOG: FamousPortraitRecord[] = FAMOUS_PORTRAIT_CATALOG_SCHEMA.parse([
  ...availableHistoricalPortraits,
  ...historicalWomen,
  ...leaders,
  ...sports,
  ...mythHoliday,
  ...artsAdventure,
]);

export const FAMOUS_PORTRAIT_BY_ID = new Map(FAMOUS_PORTRAIT_CATALOG.map((entry) => [entry.id, entry]));

export function publicFamousPortraitCatalog() {
  return FAMOUS_PORTRAIT_CATALOG.map(({ inspirationSource: _inspirationSource, numberSource: _numberSource, ...publicRecord }) => publicRecord);
}
