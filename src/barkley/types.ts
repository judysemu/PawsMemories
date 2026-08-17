/**
 * Barkley Presenter — data contracts and types.
 *
 * Barkley is an interactive, educational presenter who guides users through
 * Pawsome3D features. He lives on a 3D stage, speaks with lip-sync, and
 * reacts to user interaction through predefined animation beats.
 *
 * Asset blocker: 30 rendered biped clips. Code is complete; ships when clips arrive.
 */

// ──────────────────────────────────────────────────────────────────
// Beat types — the atomic unit of Barkley's performance
// ──────────────────────────────────────────────────────────────────

/**
 * A "beat" is a self-contained moment in Barkley's show: a specific animation
 * clip, optional dialogue, camera framing, and interactive payload.
 */
export interface BarkleyBeat {
  /** Unique identifier, e.g. "welcome", "spatial-p3-scale". */
  id: string;
  /** Human-readable title for UI cards. */
  title: string;
  /** Short description shown as subtitle or tooltip. */
  description: string;
  /** The animation clip name Barkley plays for this beat. */
  clip: string;
  /** Optional spoken dialogue (drives lip-sync + viseme track). */
  dialogue?: string;
  /** Language code for TTS, defaults to "en". */
  language?: string;
  /** Camera framing for this beat. */
  camera: BarkleyCameraFrame;
  /** Duration of this beat in seconds (how long it holds before advancing). */
  durationSeconds: number;
  /** Whether this beat has an interactive element the user can click. */
  interactive?: BarkleyInteraction;
  /** Educational metadata — what concept this beat teaches. */
  edu?: BarkleyEduMeta;
  /** Optional background environment override. */
  environment?: string;
  /** Ordering weight within the show. */
  order: number;
}

// ──────────────────────────────────────────────────────────────────
// Camera framing
// ──────────────────────────────────────────────────────────────────

export interface BarkleyCameraFrame {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** Smooth transition duration from previous camera position. */
  transitionSeconds?: number;
}

// ──────────────────────────────────────────────────────────────────
// Interactions
// ──────────────────────────────────────────────────────────────────

export type BarkleyInteractionType =
  | "reveal"
  | "quiz"
  | "click-hotspot"
  | "drag"
  | "none";

export interface BarkleyInteraction {
  type: BarkleyInteractionType;
  /** What the user sees as the call-to-action. */
  prompt: string;
  /** For quiz interactions: the correct answer index. */
  correctAnswer?: number;
  /** For reveal interactions: what to show after click. */
  revealContent?: string;
  /** Optional: navigation action on success. */
  onSuccess?: { screen: string; params?: Record<string, unknown> };
}

// ──────────────────────────────────────────────────────────────────
// Educational metadata
// ──────────────────────────────────────────────────────────────────

export interface BarkleyEduMeta {
  /** High-level topic, e.g. "spatial-scale", "pawprints", "bim". */
  topic: string;
  /** One-sentence takeaway the user should remember. */
  takeaway: string;
  /** Optional: link to a deeper resource. */
  resourceUrl?: string;
  /** Difficulty: beginner, intermediate, advanced. */
  level: "beginner" | "intermediate" | "advanced";
}

// ──────────────────────────────────────────────────────────────────
// Show (sequence of beats)
// ──────────────────────────────────────────────────────────────────

export interface BarkleyShow {
  id: string;
  name: string;
  description: string;
  /** Array of beats in performance order. */
  beats: BarkleyBeat[];
  /** Total estimated duration. */
  totalDurationSeconds: number;
  /** Feature flag key that gates this show. */
  featureFlag: string;
}

// ──────────────────────────────────────────────────────────────────
// Clip manifest — the 30 clips Barkley needs
// ──────────────────────────────────────────────────────────────────

/**
 * The canonical list of 30 rendered clips required for Barkley.
 * Each entry defines the clip name, the Blender primitive/pose it represents,
 * and which beats consume it.
 */
export interface BarkleyClipSpec {
  clipName: string;
  description: string;
  /** Which beats reference this clip. */
  usedBy: string[];
  /** Blender keyframe range (start, end frames). */
  frameRange: [number, number];
  /** Required bone poses (for rig validation). */
  keyPoses: BarkleyKeyPose[];
  /** Whether the clip loops. */
  loops: boolean;
}

export interface BarkleyKeyPose {
  frame: number;
  bone: string;
  /** Rotation in Euler degrees [x, y, z]. */
  rotation: [number, number, number];
  /** Optional translation [x, y, z] in meters. */
  translation?: [number, number, number];
}

// ──────────────────────────────────────────────────────────────────
// Presenter state (client-side runtime)
// ──────────────────────────────────────────────────────────────────

export type BarkleyState =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "interacting"
  | "speaking"
  | "complete"
  | "error";

export interface BarkleyPresenterState {
  state: BarkleyState;
  currentBeatIndex: number;
  currentBeat: BarkleyBeat | null;
  show: BarkleyShow | null;
  progress: number; // 0..1
  userInteractions: BarkleyInteractionResult[];
  error?: string;
}

export interface BarkleyInteractionResult {
  beatId: string;
  interactionType: BarkleyInteractionType;
  correct: boolean;
  timestamp: number;
}

// ──────────────────────────────────────────────────────────────────
// Feature flag
// ──────────────────────────────────────────────────────────────────

export const BARKLEY_PRESENTER_FLAG = "BARKLEY_PRESENTER";
export const BARKLEY_SHOW_ID = "pawsome3d-intro";
