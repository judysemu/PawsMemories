import { z } from "zod";

export const AiVideoScriptSchema = z.object({
  templateId: z.string().trim().max(80).optional(),
  title: z.string().trim().min(1).max(120),
  genre: z.string().trim().min(1).max(120),
  setting: z.string().trim().min(3).max(800),
  characters: z.string().trim().min(3).max(800),
  motions: z.string().trim().min(3).max(800),
  /**
   * VG-3: previously a fixed 4-tuple, which combined with the templates'
   * hardcoded `0-2s:` / `2-4s:` / `4-6s:` / `6-8s:` prefixes handed Veo four
   * discrete timestamped events. Veo animates each as a self-contained
   * micro-action with hard boundaries, which is a large part of why output
   * felt choppy and segmented rather than continuous.
   *
   * Now 3-6 beats. Four still validates, so every existing template and any
   * client sending exactly four keeps working unchanged.
   */
  stageDirections: z.array(z.string().trim().min(3).max(500)).min(3).max(6),
  lighting: z.string().trim().min(3).max(500),
  filter: z.string().trim().min(3).max(500),
  camera: z.string().trim().min(3).max(500),
}).strict();

export type AiVideoScript = z.infer<typeof AiVideoScriptSchema>;

/**
 * VG-1: Veo exposes no dedicated camera-motion parameter — motion is driven
 * entirely by the prompt and constrained by the negative prompt. Leaving
 * negativePrompt empty meant nothing steered the model away from frozen,
 * stiff, jerky renders. See https://ai.google.dev/gemini-api/docs/veo
 */
export const VEO_MOTION_NEGATIVE_PROMPT = [
  "static pose",
  "frozen",
  "stiff",
  "rigid",
  "motionless",
  "jerky motion",
  "robotic movement",
  "low motion",
  "slideshow",
  "no camera movement",
  "flat lighting",
  "morphing",
  "distorted anatomy",
].join(", ");

/**
 * VG-4: every generation of a given template produced a byte-identical prompt,
 * and numberOfVideos is 1, so Veo converged on the same safe, low-motion
 * reading each time. These pools add prompt-level variance at zero cost.
 */
const OPENERS = [
  "The clip begins mid-action",
  "Movement is already underway as the clip starts",
  "A subtle idle motion is in progress at the start",
];
const CAMERA_NUANCES = [
  "with a gentle handheld drift",
  "with a slow organic parallax",
  "with a breathing micro-arc",
  "with a smooth motivated dolly",
];
const PACING = [
  "paced with a soft ease-in and a gentle settle",
  "paced with continuous flowing motion throughout",
  "paced with a slow build then a soft release",
];

function pick<T>(pool: readonly T[], random: () => number): T {
  return pool[Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)))];
}

/**
 * VG-3: strip a literal timestamp from a beat so it reads as a continuous
 * moment. "0-2s: the pet looks up" becomes "the pet looks up"; beats are then
 * joined with "; then " so Veo reads one flowing action rather than four cuts.
 */
export function stripBeatTimestamp(beat: string): string {
  return beat
    .replace(/^\s*\d+\s*[-–—]\s*\d+\s*s(?:ec(?:onds)?)?\s*[:.\-–—]\s*/i, "")
    .replace(/^\s*\d+\s*s(?:ec(?:onds)?)?\s*[:.\-–—]\s*/i, "")
    .replace(/^\s*(?:beat|shot)\s*\d+\s*[:.\-–—]\s*/i, "")
    .trim();
}

export function compileEightSecondPrompt(
  script: AiVideoScript,
  random: () => number = Math.random,
): string {
  const voice = "Audio: generate natural ambience, movement sounds, and restrained cinematic sound design; no spoken dialogue.";

  const beats = script.stageDirections.map(stripBeatTimestamp).filter(Boolean);

  // VG-2: the old prompt was terse and label-shaped ("Primary motions: ..."),
  // joined beats with a flat " | ", contained no cinematic motion verbs and no
  // secondary-motion direction, and closed on a constraint line that biased
  // the model toward stillness. Every line below asks for continuous, weighted
  // movement instead.
  return [
    `Create exactly one polished 8-second ${script.genre} pet video titled ${JSON.stringify(script.title)}.`,
    "Preserve the source pet's identity, face, coat pattern, colors, anatomy, and proportions in every frame, while keeping the animal alive and in motion — do not freeze or hold the pose unless a beat explicitly says 'hold'. Do not add or remove animals.",
    `Setting: ${script.setting}.`,
    `Characters: ${script.characters}.`,
    `Primary motion (make it fluid, with natural weight, follow-through, and ease-in/ease-out pacing): ${script.motions}.`,
    "Secondary motion: keep the environment and coat alive throughout — wind in the fur, breathing, drifting particles, ambient sway, and gentle parallax depth.",
    `Timed beats (flow continuously between beats, no hard cuts): ${beats.join("; then ")}.`,
    `Lighting: ${script.lighting}.`,
    `Color and filters: ${script.filter}.`,
    `Camera (one smooth, motivated move — never static unless 'locked' is explicitly requested): ${script.camera}, ${pick(CAMERA_NUANCES, random)}.`,
    `${pick(OPENERS, random)}, ${pick(PACING, random)}.`,
    voice,
    "Render lifelike, continuous motion with stable anatomy. No text overlays, no logos, no extra limbs, no identity drift, no frozen frames, no slideshow.",
  ].join("\n");
}
