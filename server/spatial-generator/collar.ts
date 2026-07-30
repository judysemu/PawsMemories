import { z } from "zod";

export const CollarSizeClassSchema = z.enum(["kitten_toy", "cat_mini", "medium_dog", "large_dog"]);

export const CollarBuildSchema = z.object({
  idempotencyKey: z.string().min(16).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  targetAssetVersionId: z.number().int().positive(),
  sizeClass: CollarSizeClassSchema,
  neckCircumferenceMm: z.number().finite().min(100).max(700),
  strapWidthMm: z.number().finite().min(8).max(38),
  clearanceMm: z.number().finite().min(5).max(15),
  strapThicknessMm: z.number().finite().min(2).max(8).default(3),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2563eb"),
  includeBuckle: z.boolean().default(true),
  includeDRing: z.boolean().default(true),
  targetUse: z.enum(["digital", "attachment", "print"]).default("attachment"),
}).strict().superRefine((value, context) => {
  const preset = COLLAR_SIZE_PRESETS[value.sizeClass];
  if (value.neckCircumferenceMm < preset.neckMinMm || value.neckCircumferenceMm > preset.neckMaxMm) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["neckCircumferenceMm"],
      message: `Neck circumference must be ${preset.neckMinMm}-${preset.neckMaxMm} mm for this size class.`,
    });
  }
  if (value.strapWidthMm < preset.strapMinMm || value.strapWidthMm > preset.strapMaxMm) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["strapWidthMm"],
      message: `Strap width must be ${preset.strapMinMm}-${preset.strapMaxMm} mm for this size class.`,
    });
  }
});

export type CollarBuildInput = z.infer<typeof CollarBuildSchema>;

export const COLLAR_SIZE_PRESETS = {
  kitten_toy: { label: "Kitten / Toy breed", neckMinMm: 150, neckMaxMm: 250, strapMinMm: 8, strapMaxMm: 10 },
  cat_mini: { label: "Adult cat / Mini dog", neckMinMm: 200, neckMaxMm: 330, strapMinMm: 10, strapMaxMm: 12 },
  medium_dog: { label: "Medium dog", neckMinMm: 300, neckMaxMm: 500, strapMinMm: 20, strapMaxMm: 25 },
  large_dog: { label: "Large dog", neckMinMm: 380, neckMaxMm: 600, strapMinMm: 25, strapMaxMm: 38 },
} as const;

export function collarSpatialJob(input: CollarBuildInput) {
  const innerCircumferenceMm = input.neckCircumferenceMm + (2 * Math.PI * input.clearanceMm);
  const innerDiameterMm = innerCircumferenceMm / Math.PI;
  const outerDiameterMm = innerDiameterMm + (2 * input.strapThicknessMm);
  const hardwareAllowanceMm = input.includeBuckle ? Math.max(18, input.strapWidthMm * 1.5) : 0;

  return {
    idempotencyKey: input.idempotencyKey,
    subjectKind: "accessory" as const,
    targetUse: input.targetUse,
    prompt: [
      "Build a deterministic adjustable pet collar centered on the target neck.",
      `Bare neck circumference ${input.neckCircumferenceMm.toFixed(1)} mm.`,
      `Radial fur and two-finger clearance ${input.clearanceMm.toFixed(1)} mm.`,
      `Strap width ${input.strapWidthMm.toFixed(1)} mm and thickness ${input.strapThicknessMm.toFixed(1)} mm.`,
      `Strap material color ${input.color}.`,
      input.includeBuckle
        ? "Add a rigid buckle as a separate component, hard-weighted 1.0 to the nearest upper-neck bone."
        : "No buckle.",
      input.includeDRing
        ? "Add a rigid D-ring as a separate component, hard-weighted 1.0 to the same upper-neck bone."
        : "No D-ring.",
      "Keep the strap deformable across upper-neck bones. Concentrate 60 percent of circumferential edge-loop density around the throat region.",
      "Do not use Tripo. Return only the allowlisted declarative spatial plan.",
    ].join(" "),
    targetEnvelopeMm: {
      x: outerDiameterMm + hardwareAllowanceMm,
      y: outerDiameterMm + hardwareAllowanceMm,
      z: input.strapWidthMm,
    },
    referenceAssetVersionIds: [],
    scaleAnchor: {
      axis: "x" as const,
      millimeters: input.neckCircumferenceMm,
      label: "measured bare neck circumference",
    },
    attachment: {
      targetAssetVersionId: input.targetAssetVersionId,
      clearanceMm: input.clearanceMm,
    },
  };
}
