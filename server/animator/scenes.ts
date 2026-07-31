import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { resolveWithinWorkspace } from "./paths.ts";

export const SceneActorSchema = z.object({
  id: z.string(), // matches AR stage node id
  sourceAvatarId: z.number().optional(),
  transform: z.object({
    position: z.tuple([z.number(), z.number(), z.number()]),
    rotation: z.tuple([z.number(), z.number(), z.number()]),
    scale: z.number(),
  }).optional(),
  selectedClip: z.string().optional(),
});

export const SceneEnvironmentSchema = z.object({
  presetId: z.string(), // "studio", "park", etc.
  lighting: z.object({
    timeOfDay: z.number(), // 0-24
    shadowIntensity: z.number(),
  }).optional(),
  weather: z.object({
    type: z.string(), // "clear", "rain", "snow"
    intensity: z.number(),
  }).optional(),
  background: z.object({
    bgId: z.string().optional(),
    imageUrl: z.string().optional(),
  }).optional()
});

export const SceneDescriptorSchema = z.object({
  id: z.string(),
  userPhone: z.string(),
  name: z.string().optional(),
  actors: z.array(SceneActorSchema),
  environment: SceneEnvironmentSchema.optional(),
  steps: z.array(z.any()).optional(), // from Phase 4 Sequence
  cameras: z.array(z.any()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SceneDescriptor = z.infer<typeof SceneDescriptorSchema>;

export function createScene(userPhone: string, partial: Partial<SceneDescriptor>): SceneDescriptor {
  const now = new Date().toISOString();
  // Scene identity is always server-generated; caller IDs can never select an
  // existing owner's filename or overwrite it.
  const id = uuidv4();
  
  const record: SceneDescriptor = {
    id,
    userPhone,
    name: partial.name || `Scene — ${new Date().toLocaleDateString()}`,
    actors: partial.actors || [],
    environment: partial.environment,
    steps: partial.steps || [],
    cameras: partial.cameras || [],
    createdAt: now,
    updatedAt: now,
  };

  SceneDescriptorSchema.parse(record);
  
  // ensure scenes directory exists
  const scenesDir = resolveWithinWorkspace("scenes");
  if (!fs.existsSync(scenesDir)) fs.mkdirSync(scenesDir, { recursive: true });

  const p = resolveWithinWorkspace(`scenes/${id}.json`);
  fs.writeFileSync(p, JSON.stringify(record, null, 2));
  
  return record;
}

export function getScene(id: string): SceneDescriptor {
  const p = resolveWithinWorkspace(`scenes/${id}.json`);
  if (!fs.existsSync(p)) {
    throw new Error("Scene not found");
  }
  const content = fs.readFileSync(p, "utf8");
  return JSON.parse(content) as SceneDescriptor;
}
