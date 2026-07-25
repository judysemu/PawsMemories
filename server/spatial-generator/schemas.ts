import { z } from "zod";

// ─── Create Job Request ──────────────────────────────────────────────────────
export const CreateSpatialJobSchema = z.object({
  idempotencyKey: z.string().min(16).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  subjectKind: z.enum(["accessory", "hard_surface"]),
  targetUse: z.enum(["digital", "attachment", "print"]),
  prompt: z.string().min(3).max(2000),
  targetEnvelopeMm: z.object({
    x: z.number().positive().finite().max(5000),
    y: z.number().positive().finite().max(5000),
    z: z.number().positive().finite().max(5000),
  }),
  referenceAssetVersionIds: z.array(z.number().int().positive()).min(0).max(4),
  scaleAnchor: z
    .object({
      axis: z.enum(["x", "y", "z"]),
      millimeters: z.number().positive().finite(),
      label: z.string().min(1).max(64),
    })
    .nullable()
    .optional(),
  attachment: z
    .object({
      targetAssetVersionId: z.number().int().positive(),
      clearanceMm: z.number().nonnegative().finite().max(100),
    })
    .nullable()
    .optional(),
}).strict();

export type CreateSpatialJobInput = z.infer<typeof CreateSpatialJobSchema>;

// ─── Quote / Preflight Request ───────────────────────────────────────────────
export const QuoteSpatialJobSchema = z.object({
  subjectKind: z.enum(["accessory", "hard_surface"]),
  targetUse: z.enum(["digital", "attachment", "print"]),
  targetEnvelopeMm: z.object({
    x: z.number().positive().finite().max(5000),
    y: z.number().positive().finite().max(5000),
    z: z.number().positive().finite().max(5000),
  }),
  referenceAssetVersionIds: z.array(z.number().int().positive()).min(0).max(4),
  scaleAnchor: z
    .object({
      axis: z.enum(["x", "y", "z"]),
      millimeters: z.number().positive().finite(),
      label: z.string().min(1).max(64),
    })
    .nullable()
    .optional(),
  attachment: z
    .object({
      targetAssetVersionId: z.number().int().positive(),
      clearanceMm: z.number().nonnegative().finite().max(100),
    })
    .nullable()
    .optional(),
}).strict();

export type QuoteSpatialJobInput = z.infer<typeof QuoteSpatialJobSchema>;

// ─── Correction Retry Request ────────────────────────────────────────────────
export const RetrySpatialJobSchema = z.object({
  idempotencyKey: z.string().uuid(),
  correctionTags: z
    .array(
      z.enum([
        "proportions",
        "missing_feature",
        "wrong_placement",
        "wrong_thickness",
        "wrong_color_material",
        "attachment_fit",
        "other",
      ]),
    )
    .min(1)
    .max(3),
  correctionComment: z.string().max(500).optional(),
}).strict();

export type RetrySpatialJobInput = z.infer<typeof RetrySpatialJobSchema>;

// ─── Review / Approval Request ───────────────────────────────────────────────
export const ReviewSpatialJobSchema = z.object({
  attemptHash: z.string().regex(/^[a-f0-9]{64}$/i, "Must be a SHA-256 hex string"),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/i, "Must be a SHA-256 hex string"),
  decision: z.enum(["approve", "request_correction"]),
  correctionTags: z
    .array(
      z.enum([
        "proportions",
        "missing_feature",
        "wrong_placement",
        "wrong_thickness",
        "wrong_color_material",
        "attachment_fit",
        "other",
      ]),
    )
    .default([]),
  comment: z.string().max(500).optional(),
}).strict();

export type ReviewSpatialJobInput = z.infer<typeof ReviewSpatialJobSchema>;

// ─── Cancellation Request ────────────────────────────────────────────────────
export const CancelSpatialJobSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict();

export type CancelSpatialJobInput = z.infer<typeof CancelSpatialJobSchema>;

// ─── Deterministic Math Schemas (server-side validation) ─────────────────────
export const NormalizedPrimitiveSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(["box", "cylinder", "uv_sphere", "cone", "torus", "capsule"]),
  role: z.enum(["additive", "subtractive"]),
  normalizedSize: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    z: z.number().min(0).max(1),
  }),
  normalizedPosition: z.object({
    x: z.number().min(-0.5).max(0.5),
    y: z.number().min(-0.5).max(0.5),
    z: z.number().min(-0.5).max(0.5),
  }),
  rotationDeg: z.object({
    x: z.number().min(-360).max(360),
    y: z.number().min(-360).max(360),
    z: z.number().min(-360).max(360),
  }),
  symmetryAxis: z.enum(["x", "y", "z"]).optional(),
  bevel: z
    .object({
      width: z.number().positive().max(100),
      segments: z.number().int().positive().max(32),
    })
    .optional(),
  curveSweep: z
    .object({
      controlPoints: z.array(z.array(z.number()).length(3)).min(2).max(16),
      segments: z.number().int().positive().max(128),
    })
    .optional(),
  array: z
    .object({
      count: z.number().int().positive().max(64),
      spacing: z.number().positive().max(1000),
      axis: z.enum(["x", "y", "z"]),
    })
    .optional(),
  constraints: z.object({
    minimumWallMm: z.number().positive().max(100),
    clearanceMm: z.number().nonnegative().max(100).optional(),
  }),
  materialIntent: z
    .object({
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      roughness: z.number().min(0).max(1).optional(),
      metalness: z.number().min(0).max(1).optional(),
    })
    .optional(),
}).strict();

export type NormalizedPrimitive = z.infer<typeof NormalizedPrimitiveSchema>;

export const SpatialPlanSchema = z.object({
  planHash: z.string().regex(/^[a-f0-9]{64}$/i),
  targetEnvelopeMm: z.object({
    x: z.number().positive().finite().max(5000),
    y: z.number().positive().finite().max(5000),
    z: z.number().positive().finite().max(5000),
  }),
  primitives: z.array(NormalizedPrimitiveSchema).min(1).max(40),
  manufacturingIntent: z.enum(["digital", "attachment", "print"]).optional(),
}).strict();

export type SpatialPlan = z.infer<typeof SpatialPlanSchema>;

export const SpatialMathInputSchema = z.object({
  schemaVersion: z.literal("pawsome.spatial-math-request.v1"),
  planHash: z.string().regex(/^[a-f0-9]{64}$/i),
  envelopeMm: z.object({
    x: z.number().positive().finite().max(5000),
    y: z.number().positive().finite().max(5000),
    z: z.number().positive().finite().max(5000),
  }),
  minimumWallMm: z.number().positive().max(100),
  primitives: z.array(NormalizedPrimitiveSchema).min(1).max(40),
  constraints: z.array(z.object({
    minimumWallMm: z.number().positive().max(100),
    clearanceMm: z.number().nonnegative().max(100).optional(),
  })).min(1).max(40),
}).strict();

export type SpatialMathInput = z.infer<typeof SpatialMathInputSchema>;

export const SpatialMathOutputSchema = z.object({
  schemaVersion: z.literal("pawsome.spatial-math.v1"),
  planHash: z.string().regex(/^[a-f0-9]{64}$/i),
  units: z.literal("mm"),
  resolvedPrimitives: z.array(z.object({
    id: z.string().min(1).max(64),
    dimensionsMm: z.object({
      x: z.number().finite().min(0.1).max(5000),
      y: z.number().finite().min(0.1).max(5000),
      z: z.number().finite().min(0.1).max(5000),
    }),
    positionMm: z.object({
      x: z.number().finite().min(-5000).max(5000),
      y: z.number().finite().min(-5000).max(5000),
      z: z.number().finite().min(-5000).max(5000),
    }),
    rotationDeg: z.object({
      x: z.number().finite().min(-360).max(360),
      y: z.number().finite().min(-360).max(360),
      z: z.number().finite().min(-360).max(360),
    }),
  })).min(1).max(40),
  derived: z.object({
    boundsMinMm: z.object({
      x: z.number().finite().min(-5000).max(5000),
      y: z.number().finite().min(-5000).max(5000),
      z: z.number().finite().min(-5000).max(5000),
    }),
    boundsMaxMm: z.object({
      x: z.number().finite().min(-5000).max(5000),
      y: z.number().finite().min(-5000).max(5000),
      z: z.number().finite().min(-5000).max(5000),
    }),
    estimatedVolumeMm3: z.number().nonnegative().finite(),
  }),
  calculations: z.array(z.string().max(500)).min(1).max(40),
}).strict();

export type SpatialMathOutput = z.infer<typeof SpatialMathOutputSchema>;

// ─── Observation / Plan / Verify schemas (for Layer8 contract validation) ──────
export const SpatialObserveOutputSchema = z.object({
  subjectClass: z.string().min(1).max(128),
  summary: z.string().max(2000),
  viewCount: z.number().int().min(1).max(4),
  viewLabels: z.array(z.string().max(64)).min(1).max(4),
  features: z.array(z.object({
    name: z.string().max(128),
    confidence: z.number().min(0).max(1),
    normalizedBounds: z.object({
      min: z.array(z.number()).length(3),
      max: z.array(z.number()).length(3),
    }),
    viewIndices: z.array(z.number().int().min(0).max(3)).min(1).max(4),
  })).max(50),
  scaleEvidence: z.object({
    hasAnchor: z.boolean(),
    uncertainty: z.number().min(0).max(1),
  }),
  occlusions: z.array(z.object({
    region: z.string().max(128),
    description: z.string().max(500),
  })).max(20),
  observationHash: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();

export type SpatialObserveOutput = z.infer<typeof SpatialObserveOutputSchema>;

export const SpatialVerifyOutputSchema = z.object({
  scores: z.object({
    silhouette: z.number().min(0).max(1),
    proportion: z.number().min(0).max(1),
    featurePresence: z.number().min(0).max(1),
    viewConsistency: z.number().min(0).max(1),
  }),
  criticalIssues: z.array(z.object({
    code: z.string().max(64),
    view: z.string().max(64),
    confidence: z.number().min(0).max(1),
    detail: z.string().max(500),
  })).max(20),
  automatedPass: z.boolean(),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();

export type SpatialVerifyOutput = z.infer<typeof SpatialVerifyOutputSchema>;