import { z } from "zod";

export const AiVideoScriptSchema = z.object({
  templateId: z.string().trim().max(80).optional(),
  title: z.string().trim().min(1).max(120),
  genre: z.string().trim().min(1).max(120),
  setting: z.string().trim().min(3).max(800),
  characters: z.string().trim().min(3).max(800),
  motions: z.string().trim().min(3).max(800),
  stageDirections: z.tuple([
    z.string().trim().min(3).max(500),
    z.string().trim().min(3).max(500),
    z.string().trim().min(3).max(500),
    z.string().trim().min(3).max(500),
  ]),
  lighting: z.string().trim().min(3).max(500),
  filter: z.string().trim().min(3).max(500),
  camera: z.string().trim().min(3).max(500),
  voiceText: z.string().trim().max(160).optional().default(""),
}).strict();

export type AiVideoScript = z.infer<typeof AiVideoScriptSchema>;

export function compileEightSecondPrompt(script: AiVideoScript): string {
  const voice = script.voiceText
    ? `Audio and voice: generate natural scene sound and have the main character speak this exact short line clearly once: ${JSON.stringify(script.voiceText)}.`
    : "Audio: generate natural ambience, movement sounds, and restrained cinematic sound design; no spoken dialogue.";
  return [
    `Create exactly one polished 8-second ${script.genre} pet video titled ${JSON.stringify(script.title)}.`,
    "Preserve the source pet's identity, face, coat pattern, colors, anatomy, and proportions in every frame. Do not add or remove animals.",
    `Setting: ${script.setting}.`,
    `Characters: ${script.characters}.`,
    `Primary motions: ${script.motions}.`,
    `Stage directions: ${script.stageDirections.join(" | ")}.`,
    `Lighting: ${script.lighting}.`,
    `Color and filters: ${script.filter}.`,
    `Camera: ${script.camera}.`,
    voice,
    "Use coherent motion, stable anatomy, no text overlays, no logos, no extra limbs, and no identity drift.",
  ].join("\n");
}
