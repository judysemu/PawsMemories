import { z } from "zod";

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const AssetVersionRefSchema = z.object({
  assetUuid: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  sha256: Sha256Schema,
}).strict();

const InchesSchema = z.number().finite().nonnegative().max(240);
const PositiveInchesSchema = z.number().finite().positive().max(240);

export const RectInSchema = z.object({
  x: z.number().finite().min(-240).max(240),
  y: z.number().finite().min(-240).max(240),
  width: PositiveInchesSchema,
  height: PositiveInchesSchema,
}).strict();

export const InsetsInSchema = z.object({
  top: InchesSchema,
  right: InchesSchema,
  bottom: InchesSchema,
  left: InchesSchema,
}).strict();

export const FontLicenseSchema = z.object({
  family: z.string().trim().min(1).max(120),
  licenseId: z.string().trim().min(1).max(160),
  commercialUse: z.boolean(),
  embeddingAllowed: z.boolean(),
  sourceUrl: z.string().url().optional(),
}).strict();

const SlotBase = {
  slotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  boundsIn: RectInSchema,
  required: z.boolean(),
};

export const TemplateSlotSchema = z.discriminatedUnion("kind", [
  z.object({
    ...SlotBase,
    kind: z.literal("text"),
    fontFamily: z.string().trim().min(1).max(120),
    minFontSizePt: z.number().finite().positive().max(300),
    maxLines: z.number().int().positive().max(100),
  }).strict(),
  z.object({
    ...SlotBase,
    kind: z.literal("image"),
    allowBleed: z.boolean(),
    requiredAspectRatio: z.number().finite().positive().max(100).optional(),
  }).strict(),
]);

export const OutputPresetSchema = z.object({
  presetId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  purpose: z.enum(["digital", "print"]),
  format: z.enum(["png", "jpeg", "pdf"]),
  widthPx: z.number().int().positive().max(200_000),
  heightPx: z.number().int().positive().max(200_000),
  targetDpi: z.number().int().min(72).max(2400),
  includeBleed: z.boolean(),
  minimumBleedIn: InchesSchema,
  colorProfile: z.string().trim().min(1).max(120),
}).strict();

export const TemplateVersionSpecSchema = z.object({
  schemaVersion: z.literal("stationery.template.v1"),
  templateUuid: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  topic: z.string().trim().min(1).max(120),
  event: z.string().trim().min(1).max(120).nullable(),
  locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
  orientation: z.enum(["portrait", "landscape", "square"]),
  trimIn: z.object({ width: PositiveInchesSchema, height: PositiveInchesSchema }).strict(),
  bleedIn: InsetsInSchema,
  safeAreaIn: InsetsInSchema,
  backgroundAsset: AssetVersionRefSchema,
  backgroundCoverageIn: RectInSchema,
  fontLicenses: z.array(FontLicenseSchema).max(40),
  slots: z.array(TemplateSlotSchema).max(100),
  presets: z.array(OutputPresetSchema).min(1).max(20),
  accessibilityLabel: z.string().trim().min(1).max(500),
}).strict().superRefine((value, context) => {
  for (const [field, values] of [
    ["slotId", value.slots.map((slot) => slot.slotId)],
    ["presetId", value.presets.map((preset) => preset.presetId)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: `${field} values must be unique` });
    }
  }
  const isSquare = Math.abs(value.trimIn.width - value.trimIn.height) < 0.000_001;
  if ((value.orientation === "portrait" && value.trimIn.width >= value.trimIn.height)
    || (value.orientation === "landscape" && value.trimIn.width <= value.trimIn.height)
    || (value.orientation === "square" && !isSquare)) {
    context.addIssue({ code: "custom", message: "Template orientation must match its trim dimensions." });
  }
});

export const TextLayoutMeasurementSchema = z.object({
  slotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  content: z.string().max(20_000),
  measuredWidthPx: z.number().finite().nonnegative(),
  measuredHeightPx: z.number().finite().nonnegative(),
  boxWidthPx: z.number().finite().positive(),
  boxHeightPx: z.number().finite().positive(),
  lineCount: z.number().int().nonnegative(),
  maxLines: z.number().int().positive(),
  clippedGlyphCount: z.number().int().nonnegative(),
  measurementEngine: z.string().trim().min(1).max(120),
  measurementEngineVersion: z.string().trim().min(1).max(80),
}).strict();

export const ValidationFindingSchema = z.object({
  ruleId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  severity: z.enum(["error", "warning"]),
  subject: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(500),
  measured: z.number().finite().optional(),
  required: z.number().finite().optional(),
  unit: z.string().trim().min(1).max(24).optional(),
}).strict();

export const StationeryValidationReportSchema = z.object({
  schemaVersion: z.literal("stationery.validation.v1"),
  templateUuid: z.string().uuid(),
  templateVersionNumber: z.number().int().positive(),
  findings: z.array(ValidationFindingSchema),
  overallPass: z.boolean(),
}).strict();

export const RenderManifestInputSchema = z.object({
  schemaVersion: z.literal("stationery.render-manifest.v1"),
  templateUuid: z.string().uuid(),
  templateVersionNumber: z.number().int().positive(),
  templateSpecHash: Sha256Schema,
  presetId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  output: AssetVersionRefSchema,
  format: z.enum(["png", "jpeg", "pdf"]),
  widthPx: z.number().int().positive().max(200_000),
  heightPx: z.number().int().positive().max(200_000),
  dpi: z.number().int().min(72).max(2400),
  colorProfile: z.string().trim().min(1).max(120),
  renderer: z.object({ name: z.string().trim().min(1).max(120), version: z.string().trim().min(1).max(80) }).strict(),
  sourceVersions: z.array(AssetVersionRefSchema).min(1).max(200),
  fontFileHashes: z.array(Sha256Schema).max(40),
  validationReportHash: Sha256Schema,
  frozenAt: IsoDateTimeSchema,
}).strict();

export const SealedRenderManifestSchema = RenderManifestInputSchema.extend({
  manifestHash: Sha256Schema,
}).strict();

export const PrintManifestInputSchema = z.object({
  schemaVersion: z.literal("stationery.print-manifest.v1"),
  localOrderUuid: z.string().uuid(),
  fulfillmentKind: z.enum(["stationery_print", "three_d_print"]),
  provider: z.enum(["printful", "slant3d"]),
  providerSku: z.string().trim().min(1).max(160),
  placement: z.string().trim().min(1).max(120),
  quantity: z.number().int().positive().max(10_000),
  recipient: z.object({
    name: z.string().trim().min(1).max(160),
    email: z.string().email().max(320),
    address1: z.string().trim().min(1).max(200),
    address2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(120),
    stateCode: z.string().trim().max(32).optional(),
    countryCode: z.string().trim().regex(/^[A-Z]{2}$/),
    postalCode: z.string().trim().min(1).max(32),
  }).strict(),
  frozenFile: AssetVersionRefSchema,
  renderManifestHash: Sha256Schema.nullable(),
  validationReportHash: Sha256Schema,
  paidPaymentUuid: z.string().uuid(),
  frozenAt: IsoDateTimeSchema,
}).strict();

export const SealedPrintManifestSchema = PrintManifestInputSchema.extend({
  manifestHash: Sha256Schema,
}).strict();

export type TemplateVersionSpec = z.infer<typeof TemplateVersionSpecSchema>;
export type TextLayoutMeasurement = z.infer<typeof TextLayoutMeasurementSchema>;
export type ValidationFinding = z.infer<typeof ValidationFindingSchema>;
export type StationeryValidationReport = z.infer<typeof StationeryValidationReportSchema>;
export type RenderManifestInput = z.infer<typeof RenderManifestInputSchema>;
export type SealedRenderManifest = z.infer<typeof SealedRenderManifestSchema>;
export type PrintManifestInput = z.infer<typeof PrintManifestInputSchema>;
export type SealedPrintManifest = z.infer<typeof SealedPrintManifestSchema>;
