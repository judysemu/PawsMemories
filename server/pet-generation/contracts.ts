import crypto from "node:crypto";
import { z } from "zod";
import { PET_GLB_STAGE_PRICES, petGlbTotalCost } from "../../src/pricing";
import type {
  MeshProfile,
  PetGlbOrderConfiguration,
  PetGlbStageKind,
  SubjectProfile,
} from "./types";

const httpsUrl = z.string().url().max(4096).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "Reference URLs must use HTTPS.");

export const MeshProfileSchema = z.enum(["hd", "smart_mesh"]);
export const SubjectProfileSchema = z.enum(["pet", "humanoid"]);
export const TextureQualitySchema = z.enum(["standard", "detailed"]);

export const CreatePetGlbOrderSchema = z.object({
  meshProfile: MeshProfileSchema,
  subjectProfile: SubjectProfileSchema,
  includeTexture: z.boolean(),
  includeRig: z.boolean(),
  textureQuality: TextureQualitySchema.default("standard"),
  styleDirection: z.string().trim().max(400).nullable().optional(),
  facialRig: z.literal(false).optional(),
}).strict();

export const ReferenceManifestSchema = z.object({
  frontUrl: httpsUrl,
  leftUrl: httpsUrl,
  rightUrl: httpsUrl,
  rearUrl: httpsUrl,
  threeQuarterUrl: httpsUrl,
}).strict();

export const StageKindSchema = z.enum(["reference", "base", "texture", "rig_check", "rig"]);

export const StageApprovalSchema = z.object({
  idempotencyKey: z.string().uuid(),
  attemptUuid: z.string().uuid(),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
  assetVersionId: z.number().int().positive().nullable(),
  reportSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
}).strict();

export const StageRejectionSchema = z.object({
  idempotencyKey: z.string().uuid(),
  attemptUuid: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const StageRetrySchema = z.object({
  idempotencyKey: z.string().uuid(),
  attemptUuid: z.string().uuid(),
}).strict();

export function canonicalHash(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(stableJson(value))
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export interface MeshProfilePolicy {
  profile: MeshProfile;
  modelVersion: string;
  faceLimit: number;
  maxTriangles: number;
  smartLowPoly: boolean;
  geometryQuality?: "standard" | "detailed";
}

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function meshProfilePolicy(profile: MeshProfile): MeshProfilePolicy {
  if (profile === "smart_mesh") {
    return {
      profile,
      modelVersion: process.env.TRIPO_SMARTMESH_MODEL_VERSION || "P1-20260311",
      faceLimit: boundedEnvInt("PET_GLB_SMARTMESH_FACE_LIMIT", 8_000, 48, 20_000),
      maxTriangles: boundedEnvInt("PET_GLB_SMARTMESH_MAX_TRIANGLES", 10_000, 500, 20_000),
      // P1 is inherently low-poly and rejects smart_low_poly.
      smartLowPoly: false,
    };
  }
  return {
    profile,
    modelVersion: process.env.TRIPO_HD_MODEL_VERSION || "v3.1-20260211",
    faceLimit: boundedEnvInt("PET_GLB_HD_FACE_LIMIT", 100_000, 1_000, 2_000_000),
    maxTriangles: boundedEnvInt("PET_GLB_HD_MAX_TRIANGLES", 150_000, 1_000, 2_000_000),
    smartLowPoly: false,
    geometryQuality: "standard",
  };
}

export function rigTypeForSubject(subject: SubjectProfile): "quadruped" | "biped" {
  return subject === "humanoid" ? "biped" : "quadruped";
}

export function stagePrice(stage: PetGlbStageKind): number {
  if (stage === "base") return PET_GLB_STAGE_PRICES.BASE;
  if (stage === "texture") return PET_GLB_STAGE_PRICES.TEXTURE;
  if (stage === "rig") return PET_GLB_STAGE_PRICES.RIG;
  return 0;
}

export function productQuote(config: PetGlbOrderConfiguration) {
  return {
    base: PET_GLB_STAGE_PRICES.BASE,
    texture: config.includeTexture ? PET_GLB_STAGE_PRICES.TEXTURE : 0,
    rig: config.includeRig ? PET_GLB_STAGE_PRICES.RIG : 0,
    total: petGlbTotalCost({ texture: config.includeTexture, rig: config.includeRig }),
  };
}

export const FACIAL_RIG_POLICY = Object.freeze({
  available: false,
  minimumSuccessRate: 0.75,
  minimumFixtureCount: 20,
  reason: "No validated production cohort meets the facial blendshape release threshold.",
});

export function rigGenerationAvailability(env: Record<string, string | undefined> = process.env) {
  // CUSTOM_RIGGED_PET_GLB_V1 has its own priced stage plus durable debit,
  // provider-handle, and refund evidence. PETSIM_RIG_* belongs to the legacy
  // pet simulator and must not silently close this body-rig product.
  const available = env.PET_GLB_BODY_RIG_ENABLED !== "false";
  return {
    available,
    requestCap: null,
    costCapMicroUsd: null,
    reason: available
      ? null
      : "Animation-ready body rigging is disabled by PET_GLB_BODY_RIG_ENABLED=false.",
  } as const;
}
