import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HISTORICAL_PET_BY_ID } from "../../shared/historicalPetCatalog.ts";
import { ANIMATOR_SOUND_BY_ID } from "../../shared/animatorSoundManifest.ts";
import { ANIMATION_SETS_V2 } from "../../src/animator/controller/animationSets.ts";
import { loadEnvironments } from "./environments.ts";

const SkeletonSchema = z.enum(["quadruped", "biped", "winged"]);
const Vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const WeatherSchema = z.enum(["clear", "rain", "snow", "fog", "overcast"]);

const SceneRoleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  requiredSkeleton: SkeletonSchema.optional(),
});

const SceneScriptV1EventSchema = z.discriminatedUnion("type", [
  z.object({ time: z.number().min(0), type: z.literal("camera"), value: z.object({ position: Vec3Schema, fov: z.number().min(20).max(100) }) }),
  z.object({ time: z.number().min(0), type: z.literal("light"), value: z.union([z.string().min(1), z.object({ preset: z.string().min(1), intensity: z.number().min(0).max(4).optional() })]) }),
  z.object({ time: z.number().min(0), type: z.literal("weather"), value: WeatherSchema }),
  z.object({ time: z.number().min(0), type: z.literal("clip"), roleId: z.string().min(1), value: z.string().min(1), blend: z.number().min(0).max(2).optional() }),
  z.object({ time: z.number().min(0), type: z.literal("sound"), value: z.string().min(1) }),
]);

export const SCENE_SCRIPT_V1_SCHEMA = z.object({
  schemaVersion: z.literal("1").optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  description: z.string().min(1),
  durationSeconds: z.number().min(8).max(10),
  recommendedEnvironment: z.string().optional(),
  roles: z.array(SceneRoleSchema).min(1),
  events: z.array(SceneScriptV1EventSchema).min(1),
}).superRefine((script, ctx) => {
  for (const [index, event] of script.events.entries()) {
    if (event.time > script.durationSeconds) {
      ctx.addIssue({ code: "custom", path: ["events", index, "time"], message: `Event at ${event.time}s exceeds ${script.durationSeconds}s duration` });
    }
  }
});

const CameraEventV2Schema = z.object({
  type: z.literal("camera"),
  startTime: z.number().min(0),
  position: Vec3Schema,
  target: Vec3Schema,
  fov: z.number().min(20).max(100),
});
const LightEventV2Schema = z.object({
  type: z.literal("light"),
  startTime: z.number().min(0),
  preset: z.enum(["morning", "afternoon", "evening", "night", "overcast"]),
  intensity: z.number().min(0).max(4),
});
const WeatherEventV2Schema = z.object({
  type: z.literal("weather"),
  startTime: z.number().min(0),
  weather: WeatherSchema,
});
const AnimationEventV2Schema = z.object({
  type: z.literal("clip"),
  startTime: z.number().min(0),
  roleId: z.string().min(1),
  clipId: z.string().min(1),
  blendSeconds: z.number().min(0).max(2),
});
const SoundEventV2Schema = z.object({
  type: z.literal("sound"),
  startTime: z.number().min(0),
  assetId: z.string().regex(/^[a-z0-9-]+$/),
  gain: z.number().min(0).max(1),
  stopTime: z.number().positive().optional(),
  fadeSeconds: z.number().min(0).max(2).optional(),
  loop: z.boolean(),
  category: z.enum(["music", "ambience", "foley", "voice"]),
});

export const SCENE_EVENT_V2_SCHEMA = z.discriminatedUnion("type", [
  CameraEventV2Schema,
  LightEventV2Schema,
  WeatherEventV2Schema,
  AnimationEventV2Schema,
  SoundEventV2Schema,
]);

export const SCENE_SCRIPT_V2_SCHEMA = z.object({
  schemaVersion: z.literal("2"),
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  category: z.literal("Historical Pet Stories"),
  description: z.string().min(1),
  collectionId: z.enum(["the-composer", "the-naturalist", "the-novelist", "the-lamplight-healer"]),
  durationSeconds: z.number().min(8).max(10),
  fps: z.number().int().min(12).max(60),
  requiredSkeleton: SkeletonSchema,
  requiredCapabilities: z.array(z.string().min(1)).min(1),
  environmentId: z.string().min(1),
  roleIds: z.array(z.string().min(1)).min(1),
  roles: z.array(SceneRoleSchema).min(1),
  events: z.array(SCENE_EVENT_V2_SCHEMA).min(1),
  fallbackPolicy: z.object({
    mode: z.enum(["reject", "visible-static-preview"]),
    message: z.string().min(1),
  }),
  assetManifestVersion: z.literal("1"),
}).superRefine((script, ctx) => {
  const roleIds = new Set(script.roleIds);
  if (new Set(script.roleIds).size !== script.roleIds.length) {
    ctx.addIssue({ code: "custom", path: ["roleIds"], message: "Role IDs must be unique" });
  }
  if (script.roles.length !== script.roleIds.length || script.roles.some((role) => !roleIds.has(role.id))) {
    ctx.addIssue({ code: "custom", path: ["roles"], message: "Roles must exactly match roleIds" });
  }
  let previous = -1;
  for (const [index, event] of script.events.entries()) {
    if (event.startTime < previous) ctx.addIssue({ code: "custom", path: ["events", index, "startTime"], message: "Events must be ordered by startTime" });
    previous = event.startTime;
    if (event.startTime > script.durationSeconds) ctx.addIssue({ code: "custom", path: ["events", index, "startTime"], message: "Event exceeds script duration" });
    if (event.type === "clip" && !roleIds.has(event.roleId)) ctx.addIssue({ code: "custom", path: ["events", index, "roleId"], message: "Animation event references an undeclared role" });
    if (event.type === "sound" && event.stopTime !== undefined && (event.stopTime <= event.startTime || event.stopTime > script.durationSeconds)) {
      ctx.addIssue({ code: "custom", path: ["events", index, "stopTime"], message: "Sound stopTime must be after startTime and within duration" });
    }
  }
});

export const SCENE_SCRIPT_SCHEMA = z.union([SCENE_SCRIPT_V1_SCHEMA, SCENE_SCRIPT_V2_SCHEMA]);
export type SceneScriptV1 = z.infer<typeof SCENE_SCRIPT_V1_SCHEMA>;
export type SceneScriptV2 = z.infer<typeof SCENE_SCRIPT_V2_SCHEMA>;
export type SceneScript = z.infer<typeof SCENE_SCRIPT_SCHEMA>;

export function parseSceneScript(raw: unknown): SceneScript {
  if (!raw || typeof raw !== "object") throw new Error("Scene script must be an object");
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (version === "2") return SCENE_SCRIPT_V2_SCHEMA.parse(raw);
  if (version === undefined || version === "1") return SCENE_SCRIPT_V1_SCHEMA.parse(raw);
  throw new Error(`Unsupported scene schema version: ${String(version)}`);
}

type StoryBeat = {
  id: string; name: string; category: string; description: string;
  skeleton: "quadruped" | "biped" | "winged"; environment: string;
  clips: readonly [string, string, string];
};

const STORY_BEATS: StoryBeat[] = [
  { id: "park-hello", name: "Park Hello", category: "Greetings", description: "A friendly outdoor introduction.", skeleton: "quadruped", environment: "generic-outdoor-park", clips: ["idle", "head_tilt", "tail_wave"] },
  { id: "fetch-burst", name: "Fetch Burst", category: "Play", description: "A playful ready-set-run moment.", skeleton: "quadruped", environment: "generic-outdoor-park", clips: ["play-bow", "run", "tail_wave"] },
  { id: "studio-portrait", name: "Studio Portrait", category: "Portrait", description: "A polished pet portrait sequence.", skeleton: "quadruped", environment: "generic-indoor-studio", clips: ["sit", "head_tilt", "paw_offer"] },
  { id: "cozy-rest", name: "Cozy Rest", category: "Memories", description: "A quiet, affectionate resting beat.", skeleton: "quadruped", environment: "generic-indoor-studio", clips: ["lie", "yawn", "idle"] },
  { id: "treat-time", name: "Treat Time", category: "Training", description: "An eager trick-and-reward sequence.", skeleton: "quadruped", environment: "generic-indoor-studio", clips: ["beg", "paw_offer", "tail_wave"] },
  { id: "silly-roll", name: "Silly Roll", category: "Comedy", description: "A playful roll with a proud finish.", skeleton: "quadruped", environment: "generic-outdoor-park", clips: ["play-bow", "roll_over", "shake"] },
  { id: "human-welcome", name: "Human Welcome", category: "Greetings", description: "A warm presenter welcome.", skeleton: "biped", environment: "generic-indoor-studio", clips: ["idle", "wave", "talk_gesture"] },
  { id: "human-point", name: "Show and Tell", category: "Presentation", description: "A presenter introduces something off-camera.", skeleton: "biped", environment: "generic-indoor-studio", clips: ["talk_gesture", "point", "clap"] },
  { id: "bird-arrival", name: "Bird Arrival", category: "Nature", description: "A graceful arrival and landing.", skeleton: "winged", environment: "generic-outdoor-park", clips: ["fly", "hover", "land"] },
  { id: "bird-greeting", name: "Winged Greeting", category: "Greetings", description: "A charming wing wave for the camera.", skeleton: "winged", environment: "generic-outdoor-park", clips: ["roost", "wing_wave", "preen"] },
  { id: "rainy-day", name: "Rainy Day", category: "Cinematic", description: "A reflective beat under changing weather.", skeleton: "quadruped", environment: "arkham-approach-road", clips: ["walk", "head_tilt", "run"] },
  { id: "hero-reveal", name: "Hero Reveal", category: "Cinematic", description: "A dramatic reveal with a confident finish.", skeleton: "quadruped", environment: "arkham-security-ops", clips: ["idle", "walk", "bark_speak"] },
];

const CAMERA_STYLES = [
  { id: "close", name: "Close-Up", start: [0, 1.2, 3.2], finish: [1.1, 1.0, 2.5], fov: 38 },
  { id: "wide", name: "Wide", start: [-2.4, 1.8, 5.8], finish: [2.1, 1.4, 4.3], fov: 52 },
  { id: "orbit", name: "Orbit", start: [2.8, 1.4, 4.5], finish: [-2.2, 1.6, 3.8], fov: 45 },
] as const;
const MOODS = [
  { id: "bright", name: "Bright", light: "morning", weather: "clear" },
  { id: "golden", name: "Golden", light: "evening", weather: "clear" },
  { id: "moody", name: "Moody", light: "overcast", weather: "overcast" },
] as const;

function buildGeneratedCatalog(): SceneScriptV1[] {
  const scripts: SceneScriptV1[] = [];
  for (const story of STORY_BEATS) for (const camera of CAMERA_STYLES) for (const mood of MOODS) {
    const durationSeconds = 8 + ((scripts.length + 1) % 3);
    scripts.push(SCENE_SCRIPT_V1_SCHEMA.parse({
      schemaVersion: "1", id: `${story.id}-${camera.id}-${mood.id}`, name: `${story.name} · ${camera.name} · ${mood.name}`,
      category: story.category, description: `${story.description} ${camera.name.toLowerCase()} camera with a ${mood.name.toLowerCase()} finish.`,
      durationSeconds, recommendedEnvironment: story.environment,
      roles: [{ id: "star", name: "Star", requiredSkeleton: story.skeleton }],
      events: [
        { time: 0, type: "camera", value: { position: camera.start, fov: camera.fov } },
        { time: 0, type: "light", value: mood.light },
        { time: 0, type: "weather", value: story.id === "rainy-day" ? "rain" : ["generic-outdoor-park", "arkham-approach-road"].includes(story.environment) ? mood.weather : "clear" },
        { time: 0, type: "clip", roleId: "star", value: story.clips[0], blend: 0.25 },
        { time: 3, type: "clip", roleId: "star", value: story.clips[1], blend: 0.35 },
        { time: 5.5, type: "camera", value: { position: camera.finish, fov: Math.max(32, camera.fov - 4) } },
        { time: 6, type: "clip", roleId: "star", value: story.clips[2], blend: 0.35 },
      ],
    }));
  }
  return scripts;
}

function historicalScript(input: Omit<SceneScriptV2, "schemaVersion" | "category" | "fps" | "requiredSkeleton" | "roleIds" | "roles" | "fallbackPolicy" | "assetManifestVersion">): SceneScriptV2 {
  return SCENE_SCRIPT_V2_SCHEMA.parse({
    schemaVersion: "2", category: "Historical Pet Stories", fps: 24, requiredSkeleton: "quadruped",
    roleIds: ["star"], roles: [{ id: "star", name: "Historical pet", requiredSkeleton: "quadruped" }],
    fallbackPolicy: { mode: "reject", message: "This story needs a compatible quadruped rig with every listed motion." },
    assetManifestVersion: "1", ...input,
  });
}

export const HISTORICAL_SCENE_SCRIPTS: SceneScriptV2[] = [
  historicalScript({
    id: "composer-overture", name: "The Composer · Overture", description: "A poised entrance, score inspection, and confident final flourish.", collectionId: "the-composer",
    durationSeconds: 9, environmentId: "generic-indoor-studio", requiredCapabilities: ["idle", "walk", "head_tilt", "paw_offer", "tail_wave"],
    events: [
      { type: "camera", startTime: 0, position: [-1.7, 1.25, 4.2], target: [0, 0.8, 0], fov: 46 },
      { type: "light", startTime: 0, preset: "evening", intensity: 1.15 }, { type: "weather", startTime: 0, weather: "clear" },
      { type: "clip", startTime: 0, roleId: "star", clipId: "walk", blendSeconds: 0.25 },
      { type: "sound", startTime: 0, assetId: "composer-chamber-motif", gain: 0.32, stopTime: 9, fadeSeconds: 0.6, loop: true, category: "music" },
      { type: "clip", startTime: 2.2, roleId: "star", clipId: "head_tilt", blendSeconds: 0.3 },
      { type: "camera", startTime: 4, position: [1.1, 1.05, 2.7], target: [0, 0.85, 0], fov: 38 },
      { type: "clip", startTime: 4.2, roleId: "star", clipId: "paw_offer", blendSeconds: 0.3 },
      { type: "clip", startTime: 6.7, roleId: "star", clipId: "tail_wave", blendSeconds: 0.3 },
      { type: "clip", startTime: 8.2, roleId: "star", clipId: "idle", blendSeconds: 0.4 },
    ],
  }),
  historicalScript({
    id: "naturalist-discovery", name: "The Naturalist · Discovery", description: "A woodland search resolves into a curious specimen discovery.", collectionId: "the-naturalist",
    durationSeconds: 10, environmentId: "generic-outdoor-park", requiredCapabilities: ["idle", "walk", "head_tilt", "paw_offer", "tail_wave"],
    events: [
      { type: "camera", startTime: 0, position: [2.3, 1.45, 5], target: [0, 0.7, 0], fov: 50 },
      { type: "light", startTime: 0, preset: "morning", intensity: 1.2 }, { type: "weather", startTime: 0, weather: "clear" },
      { type: "clip", startTime: 0, roleId: "star", clipId: "walk", blendSeconds: 0.25 },
      { type: "sound", startTime: 0, assetId: "naturalist-woodland-ambience", gain: 0.28, stopTime: 10, fadeSeconds: 0.8, loop: true, category: "ambience" },
      { type: "clip", startTime: 3, roleId: "star", clipId: "head_tilt", blendSeconds: 0.25 },
      { type: "camera", startTime: 4.6, position: [-1.2, 0.95, 2.5], target: [0, 0.65, 0], fov: 36 },
      { type: "clip", startTime: 5, roleId: "star", clipId: "paw_offer", blendSeconds: 0.35 },
      { type: "clip", startTime: 7.2, roleId: "star", clipId: "tail_wave", blendSeconds: 0.3 },
      { type: "clip", startTime: 9, roleId: "star", clipId: "idle", blendSeconds: 0.35 },
    ],
  }),
  historicalScript({
    id: "novelist-midnight-draft", name: "The Novelist · Midnight Draft", description: "A quiet writing session builds from reflection to a decisive final line.", collectionId: "the-novelist",
    durationSeconds: 8, environmentId: "generic-indoor-studio", requiredCapabilities: ["idle", "sit", "head_tilt", "paw_offer"],
    events: [
      { type: "camera", startTime: 0, position: [-1.1, 1.15, 3.1], target: [0, 0.72, 0], fov: 41 },
      { type: "light", startTime: 0, preset: "night", intensity: 0.85 }, { type: "weather", startTime: 0, weather: "clear" },
      { type: "clip", startTime: 0, roleId: "star", clipId: "sit", blendSeconds: 0.35 },
      { type: "sound", startTime: 0.4, assetId: "novelist-page-pen", gain: 0.38, fadeSeconds: 0.25, loop: false, category: "foley" },
      { type: "clip", startTime: 2.2, roleId: "star", clipId: "head_tilt", blendSeconds: 0.3 },
      { type: "camera", startTime: 3.7, position: [0.9, 0.95, 2.35], target: [0, 0.72, 0], fov: 35 },
      { type: "clip", startTime: 4, roleId: "star", clipId: "paw_offer", blendSeconds: 0.25 },
      { type: "clip", startTime: 6.5, roleId: "star", clipId: "idle", blendSeconds: 0.4 },
    ],
  }),
  historicalScript({
    id: "lamplight-healer-vigil", name: "The Lamplight Healer · Vigil", description: "A measured night-round ends with a reassuring bedside pause.", collectionId: "the-lamplight-healer",
    durationSeconds: 9, environmentId: "arkham-infirmary", requiredCapabilities: ["idle", "walk", "sit", "head_tilt", "paw_offer"],
    events: [
      { type: "camera", startTime: 0, position: [1.8, 1.4, 4.5], target: [0, 0.7, 0], fov: 48 },
      { type: "light", startTime: 0, preset: "night", intensity: 0.75 }, { type: "weather", startTime: 0, weather: "fog" },
      { type: "clip", startTime: 0, roleId: "star", clipId: "walk", blendSeconds: 0.3 },
      { type: "sound", startTime: 0.4, assetId: "healer-lamp-bell", gain: 0.3, fadeSeconds: 0.4, loop: false, category: "foley" },
      { type: "clip", startTime: 2.8, roleId: "star", clipId: "sit", blendSeconds: 0.4 },
      { type: "camera", startTime: 4.2, position: [-0.8, 1, 2.6], target: [0, 0.68, 0], fov: 36 },
      { type: "clip", startTime: 4.4, roleId: "star", clipId: "head_tilt", blendSeconds: 0.3 },
      { type: "clip", startTime: 6.3, roleId: "star", clipId: "paw_offer", blendSeconds: 0.3 },
      { type: "clip", startTime: 8.1, roleId: "star", clipId: "idle", blendSeconds: 0.4 },
    ],
  }),
];

export function validateSceneScriptReferences(scriptInput: unknown, repositoryRoot = process.cwd()): string[] {
  if (!scriptInput || typeof scriptInput !== "object" || (scriptInput as { schemaVersion?: unknown }).schemaVersion !== "2") {
    const legacy = SCENE_SCRIPT_V1_SCHEMA.safeParse(scriptInput);
    if (!legacy.success) return legacy.error.issues.map((issue) => `schema: ${issue.path.join(".")}: ${issue.message}`);
    const errors: string[] = [];
    const environment = legacy.data.recommendedEnvironment ? loadEnvironments().find((candidate) => candidate.id === legacy.data.recommendedEnvironment) : null;
    if (legacy.data.recommendedEnvironment && !environment) errors.push(`environment ${legacy.data.recommendedEnvironment} does not exist`);
    const roles = new Map(legacy.data.roles.map((role) => [role.id, role]));
    for (const event of legacy.data.events) {
      if (event.type === "clip") {
        const role = roles.get(event.roleId);
        if (!role) errors.push(`clip ${event.value} references missing role ${event.roleId}`);
        else if (!role.requiredSkeleton || !ANIMATION_SETS_V2[role.requiredSkeleton]?.expectedClips.includes(event.value)) errors.push(`clip ${event.value} is missing from ${role.requiredSkeleton || "undeclared skeleton"}`);
      }
      if (event.type === "weather" && environment && !environment.allowedWeather.includes(event.value)) errors.push(`weather ${event.value} is not allowed by environment ${environment.id}`);
      if (event.type === "sound" && !ANIMATOR_SOUND_BY_ID.has(event.value)) errors.push(`sound ${event.value} does not exist`);
    }
    return errors;
  }
  const parsed = SCENE_SCRIPT_V2_SCHEMA.safeParse(scriptInput);
  if (!parsed.success) return parsed.error.issues.map((issue) => {
    const rawEvents = scriptInput && typeof scriptInput === "object" && Array.isArray((scriptInput as { events?: unknown[] }).events) ? (scriptInput as { events: Array<{ type?: unknown }> }).events : [];
    const eventIndex = issue.path[0] === "events" && typeof issue.path[1] === "number" ? issue.path[1] : -1;
    const eventType = eventIndex >= 0 ? String(rawEvents[eventIndex]?.type || "event") : "";
    return `schema${eventType ? ` ${eventType}` : ""}: ${issue.path.join(".")}: ${issue.message}`;
  });
  const script = parsed.data;
  const errors: string[] = [];
  const collection = HISTORICAL_PET_BY_ID.get(script.collectionId);
  if (!collection) errors.push(`collection ${script.collectionId} does not exist`);
  else if (!collection.directorScriptIds.includes(script.id)) errors.push(`collection ${script.collectionId} does not reference script ${script.id}`);

  const environment = loadEnvironments().find((candidate) => candidate.id === script.environmentId);
  if (!environment) errors.push(`environment ${script.environmentId} does not exist`);
  const set = ANIMATION_SETS_V2[script.requiredSkeleton];
  if (!set) errors.push(`skeleton ${script.requiredSkeleton} has no AnimationSetV2`);
  const clips = new Set(set?.expectedClips || []);
  for (const capability of script.requiredCapabilities) if (!clips.has(capability)) errors.push(`required clip capability ${capability} is missing from ${script.requiredSkeleton}`);

  for (const event of script.events) {
    if (event.type === "clip" && !clips.has(event.clipId)) errors.push(`clip ${event.clipId} is missing from ${script.requiredSkeleton}`);
    if (event.type === "weather" && environment && !environment.allowedWeather.includes(event.weather)) errors.push(`weather ${event.weather} is not allowed by environment ${environment.id}`);
    if (event.type === "sound") {
      const asset = ANIMATOR_SOUND_BY_ID.get(event.assetId);
      if (!asset) errors.push(`sound ${event.assetId} does not exist`);
      else {
        if (asset.category !== event.category) errors.push(`sound ${event.assetId} category mismatch`);
        if (event.loop && !asset.loopSafe) errors.push(`sound ${event.assetId} is not loop-safe`);
        const assetPath = path.resolve(repositoryRoot, "public", asset.publicUrl.replace(/^\//, ""));
        if (!fs.existsSync(assetPath)) errors.push(`sound ${event.assetId} asset is missing on disk`);
      }
    }
  }
  return errors;
}

for (const script of HISTORICAL_SCENE_SCRIPTS) {
  const errors = validateSceneScriptReferences(script);
  if (errors.length > 0) throw new Error(`Invalid historical scene ${script.id}: ${errors.join("; ")}`);
}

export const PRESET_SCRIPTS: SceneScript[] = [...HISTORICAL_SCENE_SCRIPTS, ...buildGeneratedCatalog()];

for (const script of PRESET_SCRIPTS) {
  const errors = validateSceneScriptReferences(script);
  if (errors.length > 0) throw new Error(`Invalid enabled director scene ${script.id}: ${errors.join("; ")}`);
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

export function getDirectorScripts(seed = "default", limit = PRESET_SCRIPTS.length): SceneScript[] {
  const output = [...PRESET_SCRIPTS];
  let state = hashSeed(seed) || 1;
  for (let i = output.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output.slice(0, Math.max(1, Math.min(limit, output.length)));
}
