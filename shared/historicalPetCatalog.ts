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
