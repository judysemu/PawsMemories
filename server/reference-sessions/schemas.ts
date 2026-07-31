import { z } from "zod";

export const ViewKindSchema = z.enum([
  "front",
  "left",
  "right",
  "rear",
  "front_three_quarter",
]);

export const InputModeSchema = z.enum(["text", "photo"]);
export const ReportStatusSchema = z.enum(["pass", "warn", "fail"]);
export const ScaleConfidenceSchema = z.enum(["unknown", "declared", "calibrated"]);

export const CreateSessionSchema = z
  .object({
    inputMode: InputModeSchema,
    subjectClass: z.string().min(1).max(64).default("pet"),
    prompt: z.string().max(2000).optional().nullable(),
    sourceImageBase64: z.string().max(28_000_000).optional(),
    sourceMimeType: z.enum(["image/png", "image/jpeg", "image/webp"]).optional(),
    sourceImagesBase64: z.array(z.string().max(28_000_000)).max(4).optional(),
    sourceMimeTypes: z.array(z.enum(["image/png", "image/jpeg", "image/webp"])).max(4).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.inputMode === "text" && !value.prompt?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["prompt"], message: "A prompt is required for text input." });
    }
    const imageCount = value.sourceImagesBase64?.length || (value.sourceImageBase64 ? 1 : 0);
    const mimeCount = value.sourceMimeTypes?.length || (value.sourceMimeType ? 1 : 0);
    if (value.inputMode === "photo" && (imageCount < 1 || mimeCount < 1)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceImageBase64"], message: "A source image is required for photo input." });
    }
    if (value.sourceImagesBase64 && value.sourceMimeTypes && value.sourceImagesBase64.length !== value.sourceMimeTypes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceMimeTypes"], message: "Each source image must declare its MIME type." });
    }
    if ((value.sourceImagesBase64 || []).reduce((total, image) => total + image.length, 0) > 45_000_000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceImagesBase64"], message: "Reference photos are too large combined. Choose smaller images." });
    }
  });

export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

export const ReplaceSourcePhotoSchema = z
  .object({
    sessionUuid: z.string().uuid(),
    imageBufferBase64: z.string().min(1).max(28_000_000),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  })
  .strict();

export const StartAttemptSchema = z
  .object({
    sessionUuid: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(190),
  })
  .strict();

export const RetryAttemptSchema = z
  .object({
    sessionUuid: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(190),
    retryNotes: z.string().max(1000).optional().nullable(),
  })
  .strict();

export const ApproveManifestSchema = z
  .object({
    sessionUuid: z.string().uuid(),
    manifestHash: z.string().length(64).regex(/^[a-fA-F0-9]{64}$/),
  })
  .strict();

export const CancelSessionSchema = z.object({ sessionUuid: z.string().uuid() }).strict();

export const ConsistencyMetricItemSchema = z
  .object({
    name: z.string().min(1).max(100),
    status: ReportStatusSchema,
    score: z.number().min(0).max(1),
    details: z.string().max(500),
  })
  .strict();

export const ConsistencyReportPayloadSchema = z
  .object({
    status: ReportStatusSchema,
    scaleConfidence: ScaleConfidenceSchema,
    summaryNote: z.string().max(1000),
    metrics: z.array(ConsistencyMetricItemSchema),
    crossViewIdentityScore: z.number().min(0).max(1),
    cropSuitabilityScore: z.number().min(0).max(1),
  })
  .strict();

export type ConsistencyReportPayload = z.infer<typeof ConsistencyReportPayloadSchema>;
