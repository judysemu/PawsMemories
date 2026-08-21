/**
 * Barkley Presenter — server-side feature flag and types.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// Resolved from the working directory, not the module path. The server ships
// as a CJS esbuild bundle where import.meta.url is undefined and __dirname
// points into dist/, so neither locates the clips. Every other runtime asset
// lookup in this app (e.g. blender-worker/profiles) is cwd-relative for the
// same reason.
//
// Two layouts have to work. In development the clips are read from public/,
// which is also where the build pipeline writes them. In production the
// deployed archive contains only the build output, and server.ts serves static
// assets from <cwd>/dist — so the clips the browser fetches at /barkley/*.glb
// live at <cwd>/dist/barkley. Checking public/ alone reported all 30 clips
// missing in production while the browser was loading them successfully, and
// GET /api/barkley/show 503'd on a feature whose assets were actually present.
//
// dist/ is checked first so a stale public/ copy can never mask what is really
// being served.
/**
 * The directory the running server actually serves clips from.
 *
 * cwd is read per call rather than captured at module load: the value is only
 * meaningful at the moment it is used, and binding it at import time makes the
 * two layouts impossible to cover in a test.
 */
export function resolveClipDir(): string {
  const candidates = [
    path.join(process.cwd(), "dist", "barkley"),
    path.join(process.cwd(), "public", "barkley"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Nothing exists yet: report the layout this process would serve, so the
  // diagnostic names a real path rather than an empty string.
  return candidates[candidates.length - 1];
}

export type BarkleyState =
  | "idle" | "loading" | "playing" | "paused" | "interacting" | "speaking" | "complete" | "error";

export interface BarkleyInteractionResult {
  beatId: string;
  interactionType: string;
  correct: boolean;
  timestamp: number;
}

// ──────────────────────────────────────────────────────────────────
// Feature flag
// ──────────────────────────────────────────────────────────────────

export function isBarkleyPresenterEnabled(): boolean {
  const envVal = process.env.BARKLEY_PRESENTER;
  if (!envVal) return false;
  return envVal.trim().toLowerCase() === "true" || envVal.trim() === "1";
}

export class BarkleyFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BarkleyFeatureError";
  }
}

export function assertBarkleyEnabled(): void {
  if (!isBarkleyPresenterEnabled()) {
    throw new BarkleyFeatureError(
      "BARKLEY_PRESENTER is not set to true. The Barkley presenter is disabled."
    );
  }
}

// ──────────────────────────────────────────────────────────────────
// Zod schemas for API I/O
// ──────────────────────────────────────────────────────────────────

export const BarkleyBeatSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  clip: z.string(),
  dialogue: z.string().optional(),
  language: z.string().default("en"),
  camera: z.object({
    position: z.tuple([z.number(), z.number(), z.number()]),
    target: z.tuple([z.number(), z.number(), z.number()]),
    fov: z.number().min(20).max(100),
    transitionSeconds: z.number().optional(),
  }),
  durationSeconds: z.number().positive(),
  interactive: z.any().optional(), // BarkleyInteraction
  edu: z.any().optional(),        // BarkleyEduMeta
  environment: z.string().optional(),
  order: z.number().int().nonnegative(),
});

export const BarkleyShowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  beats: z.array(BarkleyBeatSchema),
  totalDurationSeconds: z.number().positive(),
  featureFlag: z.string(),
});

export const BarkleyClipManifestSchema = z.object({
  clipName: z.string(),
  description: z.string(),
  usedBy: z.array(z.string()),
  frameRange: z.tuple([z.number(), z.number()]),
  keyPoses: z.array(z.any()), // BarkleyKeyPose
  loops: z.boolean(),
});

// ──────────────────────────────────────────────────────────────────
// Presenter state tracking (in-memory per-session)
// ──────────────────────────────────────────────────────────────────

export interface BarkleySessionState {
  sessionId: string;
  showId: string;
  currentBeatIndex: number;
  state: BarkleyState;
  progress: number;
  interactions: BarkleyInteractionResult[];
  startedAt: number;
  lastActiveAt: number;
}

// Simple in-memory session store (replace with Redis for production scaling)
const sessions = new Map<string, BarkleySessionState>();

export function getBarkleySession(sessionId: string): BarkleySessionState | undefined {
  return sessions.get(sessionId);
}

export function createBarkleySession(sessionId: string, showId: string): BarkleySessionState {
  const session: BarkleySessionState = {
    sessionId,
    showId,
    currentBeatIndex: 0,
    state: "idle",
    progress: 0,
    interactions: [],
    startedAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  sessions.set(sessionId, session);
  return session;
}

export function updateBarkleySession(sessionId: string, updates: Partial<BarkleySessionState>): BarkleySessionState | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  Object.assign(session, updates, { lastActiveAt: Date.now() });
  return session;
}

export function deleteBarkleySession(sessionId: string): void {
  sessions.delete(sessionId);
}

// ──────────────────────────────────────────────────────────────────
// Clip validation
// ──────────────────────────────────────────────────────────────────

export function validateClipExists(clipName: string): boolean {
  // Import from client-side manifest at build time
  // In production, this would check the public/barkley/ directory
  const requiredClips = [
    "idle", "walk_forward", "turn_left", "turn_right",
    "point_right", "point_left", "open_arms", "hands_together", "think", "gesture_up",
    "gesture_count", "gesture_shrug", "gesture_thumbs_up", "gesture_present",
    "talk_normal", "talk_emphasize", "talk_explain", "laugh", "nod_yes", "shake_head",
    "wave_hello", "wave_bye",
    "excited_jump", "curious_lean", "surprised", "clap",
    "react_click", "react_drag", "react_quiz_yes", "react_quiz_no",
  ];
  return requiredClips.includes(clipName);
}

export function getMissingClips(): string[] {
  const requiredClips = [
    "idle", "walk_forward", "turn_left", "turn_right",
    "point_right", "point_left", "open_arms", "hands_together", "think", "gesture_up",
    "gesture_count", "gesture_shrug", "gesture_thumbs_up", "gesture_present",
    "talk_normal", "talk_emphasize", "talk_explain", "laugh", "nod_yes", "shake_head",
    "wave_hello", "wave_bye",
    "excited_jump", "curious_lean", "surprised", "clap",
    "react_click", "react_drag", "react_quiz_yes", "react_quiz_no",
  ];

  const clipDir = resolveClipDir();
  const availableClips = fs.existsSync(clipDir)
    ? fs.readdirSync(clipDir)
        .filter((f: string) => f.endsWith(".glb"))
        .map((f: string) => f.replace(".glb", ""))
    : [];

  return requiredClips.filter((clip: string) => !availableClips.includes(clip));
}
