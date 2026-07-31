import { z } from "zod";
import {
  AssetVersionRefSchema,
  IsoDateTimeSchema,
  SealedPrintManifestSchema,
  SealedRenderManifestSchema,
  Sha256Schema,
  StationeryValidationReportSchema,
  TemplateVersionSpecSchema,
  TextLayoutMeasurementSchema,
} from "./contracts.ts";
import { ProviderEventSchema, ProviderOrderStateSchema, ProviderSubmissionSchema, ReconciliationDecisionSchema } from "./fulfillment.ts";
import { ProviderObservationSchema } from "./fulfillment.ts";

export const StationeryUuidParamSchema = z.object({ uuid: z.string().uuid() }).strict();
export const TemplateVersionParamSchema = z.object({
  templateUuid: z.string().uuid(),
  versionNumber: z.coerce.number().int().positive(),
}).strict();
export const ProviderParamSchema = z.object({ provider: z.enum(["printful", "slant3d"]) }).strict();

export const ShippingRecipientSchema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().email().max(320),
  address1: z.string().trim().min(1).max(200),
  address2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  stateCode: z.string().trim().max(32).optional(),
  countryCode: z.string().trim().regex(/^[A-Z]{2}$/),
  postalCode: z.string().trim().min(1).max(32),
}).strict();

export const TemplateVersionPublicSchema = z.object({
  spec: TemplateVersionSpecSchema,
  specHash: Sha256Schema,
  status: z.enum(["active", "retired"]),
}).strict();

export const ApiIdempotencyKeySchema = z.string()
  .trim()
  .min(8)
  .max(190)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const SlotInputSchema = z.discriminatedUnion("kind", [
  z.object({
    slotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    kind: z.literal("text"),
    content: z.string().max(20_000),
    measurement: TextLayoutMeasurementSchema,
  }).strict(),
  z.object({
    slotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    kind: z.literal("image"),
    source: AssetVersionRefSchema,
    cropMode: z.enum(["cover", "contain"]),
  }).strict(),
]);

export const CreateRenderJobRequestSchema = z.object({
  templateUuid: z.string().uuid(),
  templateVersionNumber: z.number().int().positive(),
  presetId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  idempotencyKey: ApiIdempotencyKeySchema,
  slotInputs: z.array(SlotInputSchema).max(100),
}).strict().superRefine((value, context) => {
  const slotIds = value.slotInputs.map((input) => input.slotId);
  if (new Set(slotIds).size !== slotIds.length) {
    context.addIssue({ code: "custom", path: ["slotInputs"], message: "slotInputs must contain each slot at most once." });
  }
  for (const input of value.slotInputs) {
    if (input.kind === "text" && (input.measurement.slotId !== input.slotId || input.measurement.content !== input.content)) {
      context.addIssue({ code: "custom", path: ["slotInputs"], message: "Text measurement must bind to the same slot and exact content." });
    }
  }
});

export const RenderJobStateSchema = z.enum(["queued", "dispatch_failed", "rendering", "ready", "failed"]);
export const RenderJobPublicSchema = z.object({
  jobUuid: z.string().uuid(),
  templateUuid: z.string().uuid(),
  templateVersionNumber: z.number().int().positive(),
  presetId: z.string().min(1).max(64),
  state: RenderJobStateSchema,
  requestHash: Sha256Schema,
  validationReport: StationeryValidationReportSchema,
  renderManifest: SealedRenderManifestSchema.nullable(),
  output: AssetVersionRefSchema.nullable(),
  failureCode: z.string().trim().min(1).max(120).nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict();

export const CompleteRenderJobRequestSchema = z.object({
  renderManifest: SealedRenderManifestSchema,
  validationReport: StationeryValidationReportSchema,
}).strict();

export const CreatePrintOrderRequestSchema = z.object({
  renderJobUuid: z.string().uuid(),
  provider: z.enum(["printful", "slant3d"]),
  providerSku: z.string().trim().min(1).max(160),
  placement: z.string().trim().min(1).max(120),
  quantity: z.number().int().positive().max(10_000),
  recipient: ShippingRecipientSchema,
  paidPaymentUuid: z.string().uuid(),
  idempotencyKey: ApiIdempotencyKeySchema,
}).strict();

export const SubmitPrintOrderRequestSchema = z.object({
  providerIdempotencyKey: z.string().regex(/^fulfillment-v1-[a-f0-9]{64}$/),
}).strict();

export const ProviderWebhookRequestSchema = z.object({
  localOrderUuid: z.string().uuid(),
  event: ProviderEventSchema,
}).strict();

export const WorkerAssetRegistrationSchema = z.object({
  ownerId: z.string().trim().min(1).max(190),
  assetType: z.literal("stationery_print_file"),
  mimeType: z.string().trim().min(1).max(120),
  sizeBytes: z.number().int().nonnegative(),
  sha256: Sha256Schema,
  bucket: z.literal("private"),
  objectKey: z.string().trim().min(1).max(512),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

export const WorkerUploadRequestSchema = z.object({
  ownerId: z.string().trim().min(1).max(190),
  jobUuid: z.string().uuid(),
  mimeType: z.string().trim().min(1).max(120),
}).strict();

export const ProviderSubmissionAcknowledgementSchema = z.object({
  providerOrderId: z.string().trim().min(1).max(200),
  state: z.enum(["submitted", "processing"]),
}).strict();

export const ProviderReconciliationObservationSchema = ProviderObservationSchema;

export const ReconcileOrderRequestSchema = z.object({
  reason: z.string().trim().min(1).max(300),
}).strict();

export const PaymentEvidenceSchema = z.object({
  paymentUuid: z.string().uuid(),
  ownerId: z.string().trim().min(1).max(64),
  state: z.enum(["pending", "paid", "failed", "refunded"]),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  confirmedAt: IsoDateTimeSchema.nullable(),
  evidenceHash: Sha256Schema,
}).strict();

export const PaymentEvidencePublicSchema = PaymentEvidenceSchema.omit({ ownerId: true }).strict();

export const PrintOrderPublicSchema = z.object({
  localOrderUuid: z.string().uuid(),
  renderJobUuid: z.string().uuid(),
  provider: z.enum(["printful", "slant3d"]),
  state: ProviderOrderStateSchema,
  providerOrderId: z.string().trim().min(1).max(200).nullable(),
  providerIdempotencyKey: z.string().regex(/^fulfillment-v1-[a-f0-9]{64}$/),
  printManifest: SealedPrintManifestSchema,
  paymentEvidence: PaymentEvidencePublicSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict();

export const ProviderEventResultSchema = z.object({
  order: PrintOrderPublicSchema,
  disposition: z.enum(["applied", "duplicate", "ignored_stale", "requires_reconciliation"]),
  reason: z.string().trim().min(1).max(300),
}).strict();

export const ReconciliationResultSchema = z.object({
  order: PrintOrderPublicSchema,
  decision: ReconciliationDecisionSchema,
}).strict();

export const RenderDispatchSchema = z.object({
  contractVersion: z.literal(1),
  jobUuid: z.string().uuid(),
  ownerId: z.string().trim().min(1).max(190),
  template: TemplateVersionSpecSchema,
  templateSpecHash: Sha256Schema,
  presetId: z.string().min(1).max(64),
  requestHash: Sha256Schema,
  slotInputs: z.array(SlotInputSchema).max(100),
  sourceUrls: z.record(z.string().uuid(), z.string().url()),
}).strict();

export type CreateRenderJobRequest = z.infer<typeof CreateRenderJobRequestSchema>;
export type RenderJobPublic = z.infer<typeof RenderJobPublicSchema>;
export type CompleteRenderJobRequest = z.infer<typeof CompleteRenderJobRequestSchema>;
export type CreatePrintOrderRequest = z.infer<typeof CreatePrintOrderRequestSchema>;
export type PrintOrderPublic = z.infer<typeof PrintOrderPublicSchema>;
export type PaymentEvidence = z.infer<typeof PaymentEvidenceSchema>;
export type RenderDispatch = z.infer<typeof RenderDispatchSchema>;
export type ProviderWebhookRequest = z.infer<typeof ProviderWebhookRequestSchema>;
export type ProviderEventResult = z.infer<typeof ProviderEventResultSchema>;
export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;
export type ProviderSubmissionSnapshot = z.infer<typeof ProviderSubmissionSchema>;
