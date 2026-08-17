import { BarkleyClipSpec, BarkleyShow, BarkleyBeat } from "./types";

/**
 * The 30 rendered clips Barkley needs.
 *
 * All clips use the `biped` skeleton. They are organized by category:
 * locomotion, gestures, presenter-actions, emotes, and interactive-reactions.
 *
 * Each clip is an 8–10 second loop-ready animation exported from Blender at 30 fps.
 * Render pipeline: `blender-worker/render_barkley.py --clip <name> --output public/barkley/`
 */
export const BARKLEY_CLIPS: BarkleyClipSpec[] = [
  // ── Locomotion (4 clips) ──────────────────────────────────────
  {
    clipName: "idle",
    description: "Neutral standing idle with subtle breathing and weight shift.",
    usedBy: ["welcome", "transition", "goodbye"],
    frameRange: [0, 120],
    keyPoses: [],
    loops: true,
  },
  {
    clipName: "walk_forward",
    description: "Confident walk toward camera, slows to a stop.",
    usedBy: ["entrance"],
    frameRange: [0, 150],
    keyPoses: [
      { frame: 0, bone: "root", rotation: [0, 0, 0] },
      { frame: 60, bone: "left_leg", rotation: [30, 0, 0] },
      { frame: 120, bone: "root", rotation: [0, 0, 0], translation: [0, 0, -1.5] },
    ],
    loops: false,
  },
  {
    clipName: "turn_left",
    description: "Pivots 90 degrees left, presents toward off-camera area.",
    usedBy: ["spatial-overview"],
    frameRange: [0, 90],
    keyPoses: [
      { frame: 0, bone: "spine", rotation: [0, 0, 0] },
      { frame: 45, bone: "spine", rotation: [0, 45, 0] },
      { frame: 90, bone: "spine", rotation: [0, 90, 0] },
    ],
    loops: false,
  },
  {
    clipName: "turn_right",
    description: "Pivots 90 degrees right, mirrors turn_left.",
    usedBy: ["pawprints-intro"],
    frameRange: [0, 90],
    keyPoses: [
      { frame: 0, bone: "spine", rotation: [0, 0, 0] },
      { frame: 45, bone: "spine", rotation: [0, -45, 0] },
      { frame: 90, bone: "spine", rotation: [0, -90, 0] },
    ],
    loops: false,
  },

  // ── Gestures (10 clips) ────────────────────────────────────────
  {
    clipName: "point_right",
    description: "Points right arm toward off-screen content area.",
    usedBy: ["spatial-overview", "pawprints-intro"],
    frameRange: [0, 60],
    keyPoses: [
      { frame: 0, bone: "right_arm", rotation: [0, 0, 0] },
      { frame: 30, bone: "right_arm", rotation: [-90, 0, -45] },
    ],
    loops: false,
  },
  {
    clipName: "point_left",
    description: "Points left arm toward off-screen content area.",
    usedBy: ["bim-intro"],
    frameRange: [0, 60],
    keyPoses: [
      { frame: 0, bone: "left_arm", rotation: [0, 0, 0] },
      { frame: 30, bone: "left_arm", rotation: [-90, 0, 45] },
    ],
    loops: false,
  },
  {
    clipName: "open_arms",
    description: "Spreads both arms wide in a welcoming gesture.",
    usedBy: ["welcome"],
    frameRange: [0, 90],
    keyPoses: [
      { frame: 0, bone: "left_arm", rotation: [0, 0, 0] },
      { frame: 45, bone: "left_arm", rotation: [0, 0, -70] },
      { frame: 45, bone: "right_arm", rotation: [0, 0, 70] },
    ],
    loops: false,
  },
  {
    clipName: "hands_together",
    description: "Brings palms together as if holding an invisible sphere.",
    usedBy: ["spatial-p1", "spatial-p3-scale"],
    frameRange: [0, 90],
    keyPoses: [
      { frame: 0, bone: "left_arm", rotation: [0, 0, 0] },
      { frame: 45, bone: "left_arm", rotation: [-60, 30, -30] },
      { frame: 45, bone: "right_arm", rotation: [-60, 30, 30] },
    ],
    loops: false,
  },
  {
    clipName: "think",
    description: "Touches chin thoughtfully, tilts head.",
    usedBy: ["quiz-accuracy", "quiz-layer"],
    frameRange: [0, 90],
    keyPoses: [
      { frame: 30, bone: "right_hand", rotation: [0, 0, 0] },
      { frame: 30, bone: "head", rotation: [5, 0, 10] },
    ],
    loops: false,
  },
  {
    clipName: "gesture_up",
    description: "Points upward with right index finger, like 'aha!' moment.",
    usedBy: ["spatial-p5-review", "goodbye"],
    frameRange: [0, 60],
    keyPoses: [
      { frame: 0, bone: "right_arm", rotation: [0, 0, 0] },
      { frame: 30, bone: "right_arm", rotation: [-170, 0, -20] },
    ],
    loops: false,
  },
  {
    clipName: "gesture_count",
    description: "Holds up fingers counting 1, 2, 3.",
    usedBy: ["three-phases"],
    frameRange: [0, 120],
    keyPoses: [
      { frame: 0, bone: "right_hand", rotation: [0, 0, 0] },
      { frame: 40, bone: "right_hand", rotation: [0, 0, -30] },
      { frame: 80, bone: "right_hand", rotation: [0, 0, -30] },
    ],
    loops: false,
  },
  {
    clipName: "gesture_shrug",
    description: "Raises shoulders and palms in a friendly shrug.",
    usedBy: ["transition"],
    frameRange: [0, 60],
    keyPoses: [
      { frame: 30, bone: "left_shoulder", rotation: [0, 0, -30] },
      { frame: 30, bone: "right_shoulder", rotation: [0, 0, 30] },
    ],
    loops: false,
  },
  {
    clipName: "gesture_thumbs_up",
    description: "Gives enthusiastic double thumbs-up.",
    usedBy: ["success", "goodbye"],
    frameRange: [0, 60],
    keyPoses: [
      { frame: 30, bone: "right_hand", rotation: [90, 0, 0] },
      { frame: 30, bone: "left_hand", rotation: [90, 0, 0] },
    ],
    loops: false,
  },
  {
    clipName: "gesture_present",
    description: "Sweeps right arm outward in a 'ta-da' present gesture.",
    usedBy: ["reveal-accuracy", "reveal-scale", "reveal-review"],
    frameRange: [0, 90],
    keyPoses: [
      { frame: 0, bone: "right_arm", rotation: [-60, 30, 0] },
      { frame: 45, bone: "right_arm", rotation: [-80, 0, 60] },
    ],
    loops: false,
  },

  // ── Presenter actions (8 clips) ────────────────────────────────
  {
    clipName: "talk_normal",
    description: "Conversational hand gestures while speaking, neutral pose.",
    usedBy: ["welcome", "spatial-overview", "pawprints-intro"],
    frameRange: [0, 180],
    keyPoses: [],
    loops: true,
  },
  {
    clipName: "talk_emphasize",
    description: "Strong hand gestures with forward lean for emphasis.",
    usedBy: ["spatial-p3-scale", "spatial-p5-review"],
    frameRange: [0, 180],
    keyPoses: [],
    loops: true,
  },
  {
    clipName: "talk_explain",
    description: "Slow, deliberate hand motions like explaining a diagram.",
    usedBy: ["spatial-p1", "three-phases"],
    frameRange: [0, 180],
    keyPoses: [],
    loops: true,
  },
  {
    clipName: "laugh",
    description: "Genuine laugh, head tilts back, hands on belly.",
    usedBy: ["fun-moment"],
    frameRange: [0, 90],
    keyPoses: [
      { frame: 45, bone: "head", rotation: [-15, 0, 0] },
      { frame: 45, bone: "spine", rotation: [-5, 0, 0] },
    ],
    loops: false,
  },
  {
    clipName: "nod_yes",
    description: "Enthusiastic nodding affirmation.",
    usedBy: ["quiz-correct", "success"],
    frameRange: [0, 60],
    keyPoses: [
      { frame: 15, bone: "head", rotation: [15, 0, 0] },
      { frame: 45, bone: "head", rotation: [15, 0, 0] },
    ],
    loops: false,
  },
  {
    clipName: "shake_head",
    description: "Gentle head shake in a playful way.",
    usedBy: ["quiz-incorrect"],
    frameRange: [0, 60],
    keyPoses: [
      { frame: 15, bone: "head", rotation: [0, 0, 15] },
      { frame: 45, bone: "head", rotation: [0, 0, -15] },
    ],
    loops: false,
  },
  {
    clipName: "wave_hello",
    description: "Big friendly wave with right hand.",
    usedBy: ["welcome"],
    frameRange: [0, 90],
    keyPoses: [
      { frame: 45, bone: "right_arm", rotation: [-120, 0, -30] },
    ],
    loops: false,
  },
  {
    clipName: "wave_bye",
    description: "Fading wave goodbye with both hands.",
    usedBy: ["goodbye"],
    frameRange: [0, 90],
    keyPoses: [
      { frame: 45, bone: "right_arm", rotation: [-120, 0, -30] },
      { frame: 70, bone: "right_arm", rotation: [-100, 0, -20] },
    ],
    loops: false,
  },

  // ── Emotes (4 clips) ──────────────────────────────────────────
  {
    clipName: "excited_jump",
    description: "Small excited jump with arms raised.",
    usedBy: ["success", "spatial-p5-review"],
    frameRange: [0, 60],
    keyPoses: [
      { frame: 30, bone: "root", rotation: [0, 0, 0], translation: [0, 0.3, 0] },
      { frame: 30, bone: "left_arm", rotation: [-140, 0, -20] },
      { frame: 30, bone: "right_arm", rotation: [-140, 0, 20] },
    ],
    loops: false,
  },
  {
    clipName: "curious_lean",
    description: "Leans forward with interest, one hand on chin.",
    usedBy: ["quiz-accuracy", "quiz-layer"],
    frameRange: [0, 90],
    keyPoses: [
      { frame: 45, bone: "spine", rotation: [15, 0, 0] },
      { frame: 45, bone: "head", rotation: [5, 0, 10] },
    ],
    loops: false,
  },
  {
    clipName: "surprised",
    description: "Hands fly to cheeks, eyes widen.",
    usedBy: ["reveal-accuracy", "reveal-scale"],
    frameRange: [0, 60],
    keyPoses: [
      { frame: 30, bone: "left_hand", rotation: [0, 0, 0] },
      { frame: 30, bone: "right_hand", rotation: [0, 0, 0] },
    ],
    loops: false,
  },
  {
    clipName: "clap",
    description: "Proud applause with both hands.",
    usedBy: ["success"],
    frameRange: [0, 90],
    keyPoses: [
      { frame: 45, bone: "left_hand", rotation: [0, 0, 0] },
      { frame: 45, bone: "right_hand", rotation: [0, 0, 0] },
    ],
    loops: false,
  },

  // ── Interactive reactions (4 clips) ────────────────────────────
  {
    clipName: "react_click",
    description: "React to user clicking something: surprised then approving.",
    usedBy: ["click-hotspot-1", "click-hotspot-2"],
    frameRange: [0, 90],
    keyPoses: [
      { frame: 30, bone: "head", rotation: [0, 0, 20] },
      { frame: 70, bone: "head", rotation: [5, 0, 0] },
    ],
    loops: false,
  },
  {
    clipName: "react_drag",
    description: "Watch something being dragged: follows with eyes, impressed nod.",
    usedBy: ["drag-demo"],
    frameRange: [0, 120],
    keyPoses: [],
    loops: false,
  },
  {
    clipName: "react_quiz_yes",
    description: "Excited celebration on correct quiz answer.",
    usedBy: ["quiz-correct"],
    frameRange: [0, 90],
    keyPoses: [],
    loops: false,
  },
  {
    clipName: "react_quiz_no",
    description: "Encouraging 'not yet' on wrong quiz answer.",
    usedBy: ["quiz-incorrect"],
    frameRange: [0, 90],
    keyPoses: [],
    loops: false,
  },
];

// ──────────────────────────────────────────────────────────────────
// Validate clip count
// ──────────────────────────────────────────────────────────────────

if (BARKLEY_CLIPS.length !== 30) {
  throw new Error(`Barkley clip manifest has ${BARKLEY_CLIPS.length} clips, expected 30`);
}

/** Build a map of clip name → spec for quick lookups. */
export const BARKLEY_CLIP_MAP = new Map(
  BARKLEY_CLIPS.map((c) => [c.clipName, c])
);

// ──────────────────────────────────────────────────────────────────
// Show definition — the canonical Barkley intro experience
// ──────────────────────────────────────────────────────────────────

const BEATS: BarkleyBeat[] = [
  {
    id: "welcome",
    title: "Welcome to Pawsome3D!",
    description: "Barkley introduces himself and the platform.",
    clip: "wave_hello",
    dialogue: "Hey there! I'm Barkley, your guide to Pawsome3D. Let me show you how we turn pet photos into stunning 3D models.",
    camera: {
      position: [0, 1.4, 3.5],
      target: [0, 1.0, 0],
      fov: 42,
      transitionSeconds: 1.0,
    },
    durationSeconds: 8,
    edu: {
      topic: "platform-intro",
      takeaway: "Pawsome3D converts pet photos to 3D avatars using AI-powered spatial generation.",
      level: "beginner",
    },
    order: 0,
  },
  {
    id: "spatial-overview",
    title: "How It Works: The Spatial Pipeline",
    description: "The three-phase generation process at a glance.",
    clip: "point_right",
    dialogue: "Every model goes through three phases: observation, planning, and building. Let me walk you through them.",
    camera: {
      position: [1.2, 1.3, 3.0],
      target: [0, 0.9, 0],
      fov: 45,
      transitionSeconds: 0.8,
    },
    durationSeconds: 8,
    interactive: {
      type: "click-hotspot",
      prompt: "Tap to see the pipeline diagram",
      revealContent: "Three phases: Observe → Plan → Build",
    },
    edu: {
      topic: "spatial-pipeline",
      takeaway: "Three-phase pipeline ensures accuracy: observation captures dimensions, planning resolves math, building creates the model.",
      level: "beginner",
    },
    order: 1,
  },
  {
    id: "spatial-p1",
    title: "Phase 1: Observation & Scale",
    description: "How Barkley measures your pet from photos.",
    clip: "talk_explain",
    dialogue: "Phase one is all about understanding your pet's proportions. We use multiple photos to build a 3D understanding of scale, stance, and features.",
    camera: {
      position: [-0.5, 1.2, 2.8],
      target: [0, 1.0, 0],
      fov: 40,
      transitionSeconds: 0.6,
    },
    durationSeconds: 10,
    edu: {
      topic: "spatial-p1",
      takeaway: "Observation phase uses photo analysis to determine your pet's real-world measurements before any 3D work begins.",
      level: "beginner",
    },
    order: 2,
  },
  {
    id: "quiz-accuracy",
    title: "Quick Check: Observation Accuracy",
    description: "A quick quiz to test understanding.",
    clip: "think",
    dialogue: "Quick question: why do we need at least two photos from different angles?",
    camera: {
      position: [0, 1.3, 2.5],
      target: [0, 1.1, 0],
      fov: 38,
      transitionSeconds: 0.5,
    },
    durationSeconds: 12,
    interactive: {
      type: "quiz",
      prompt: "Why do we need multiple angles?",
      correctAnswer: 1,
    },
    edu: {
      topic: "spatial-accuracy",
      takeaway: "Multiple angles provide depth information that a single photo cannot capture — essential for accurate 3D reconstruction.",
      level: "intermediate",
    },
    order: 3,
  },
  {
    id: "reveal-accuracy",
    title: "The Answer Revealed",
    description: "Barkley reveals the answer with a visual demo.",
    clip: "gesture_present",
    dialogue: "Exactly! Two angles give us depth. Think of it like your two eyes — that's how you judge distance!",
    camera: {
      position: [0.3, 1.1, 2.6],
      target: [0, 1.0, 0],
      fov: 36,
      transitionSeconds: 0.5,
    },
    durationSeconds: 8,
    edu: {
      topic: "spatial-accuracy",
      takeaway: "Stereo vision — two viewpoints — is the foundation of depth perception in both humans and our AI pipeline.",
      level: "beginner",
    },
    order: 4,
  },
  {
    id: "spatial-p3-scale",
    title: "Phase 2: Scale & Dimensions",
    description: "Understanding how we handle real-world measurements.",
    clip: "talk_emphasize",
    dialogue: "Phase two is where the math happens. We translate those observations into exact millimeter-scale dimensions. Every paw, every ear is measured precisely.",
    camera: {
      position: [-0.8, 1.2, 3.0],
      target: [0, 0.95, 0],
      fov: 44,
      transitionSeconds: 0.7,
    },
    durationSeconds: 10,
    interactive: {
      type: "reveal",
      prompt: "See the tolerance spec",
      revealContent: "0.05mm tolerance on critical dimensions",
    },
    edu: {
      topic: "spatial-p3-scale",
      takeaway: "The math resolver enforces 0.05mm tolerance — your pet's 3D model matches their real-world proportions within a fraction of a millimeter.",
      level: "intermediate",
    },
    order: 5,
  },
  {
    id: "reveal-scale",
    title: "Real-World Scale Matters",
    description: "Why precision matters for physical products.",
    clip: "surprised",
    dialogue: "That precision matters because we don't just make digital models — we create physical accessories too. A collar needs to fit the actual neck, not an approximation.",
    camera: {
      position: [0.5, 1.15, 2.7],
      target: [0, 1.0, 0],
      fov: 38,
      transitionSeconds: 0.5,
    },
    durationSeconds: 8,
    edu: {
      topic: "spatial-physical",
      takeaway: "Sub-millimeter accuracy enables physical products like custom collars and accessories that actually fit.",
      level: "intermediate",
    },
    order: 6,
  },
  {
    id: "pawprints-intro",
    title: "Pawprints: Your Creative Studio",
    description: "Introducing the Pawprints feature.",
    clip: "turn_right",
    dialogue: "Now let me show you Pawprints — your creative studio. Here you can customize prompts, add personal touches, and generate unique keepsakes.",
    camera: {
      position: [1.5, 1.3, 3.2],
      target: [0.5, 1.0, 0],
      fov: 48,
      transitionSeconds: 0.8,
    },
    durationSeconds: 8,
    edu: {
      topic: "pawprints",
      takeaway: "Pawprints is the user-facing creative studio for customizing and generating pet keepsakes.",
      level: "beginner",
    },
    order: 7,
  },
  {
    id: "three-phases",
    title: "Three Layers of Animation",
    description: "Understanding the animation system.",
    clip: "gesture_count",
    dialogue: "Did you know our animator uses three layers? Base locomotion, overlay gestures, and reactive emotes — all blending together seamlessly.",
    camera: {
      position: [-0.3, 1.25, 3.0],
      target: [0, 1.0, 0],
      fov: 42,
      transitionSeconds: 0.6,
    },
    durationSeconds: 10,
    interactive: {
      type: "quiz",
      prompt: "Which layer handles tail wags and head tilts?",
      correctAnswer: 1,
    },
    edu: {
      topic: "animation-layers",
      takeaway: "Three animation layers: L0 for locomotion and poses, L1 for overlays like gestures, L2+ for reactive emotes.",
      level: "intermediate",
    },
    order: 8,
  },
  {
    id: "quiz-layer",
    title: "Quiz: Animation Layers",
    description: "Test your understanding of the animation system.",
    clip: "curious_lean",
    dialogue: "Remember, L0 is the foundation — walking, sitting, lying down. L1 overlays are the personality — tail wags, head tilts, barks.",
    camera: {
      position: [0, 1.2, 2.6],
      target: [0, 1.05, 0],
      fov: 38,
      transitionSeconds: 0.5,
    },
    durationSeconds: 8,
    interactive: {
      type: "quiz",
      prompt: "What does L0 handle?",
      correctAnswer: 0,
    },
    edu: {
      topic: "animation-l0",
      takeaway: "L0 handles locomotion (walk, run, sit) and exclusive poses. L1 adds personality overlays.",
      level: "intermediate",
    },
    order: 9,
  },
  {
    id: "quiz-correct",
    title: "Great Job!",
    description: "Barkley celebrates the correct answer.",
    clip: "nod_yes",
    dialogue: "You've got it! You're learning fast.",
    camera: {
      position: [0, 1.3, 2.4],
      target: [0, 1.1, 0],
      fov: 36,
      transitionSeconds: 0.4,
    },
    durationSeconds: 5,
    order: 10,
  },
  {
    id: "bim-intro",
    title: "Building with Precision",
    description: "How the BIM pipeline works.",
    clip: "point_left",
    dialogue: "For professional users, our BIM pipeline ensures every generated model is production-ready. Clean topology, proper UVs, and LOD optimization built right in.",
    camera: {
      position: [-1.5, 1.35, 3.2],
      target: [-0.3, 1.0, 0],
      fov: 46,
      transitionSeconds: 0.7,
    },
    durationSeconds: 8,
    edu: {
      topic: "bim-pipeline",
      takeaway: "BIM pipeline produces production-ready assets with clean topology, proper UVs, and automatic LOD generation.",
      level: "advanced",
    },
    order: 11,
  },
  {
    id: "spatial-p5-review",
    title: "Phase 3: Review & Approval",
    description: "The human-in-the-loop quality gate.",
    clip: "talk_emphasize",
    dialogue: "Before any model is finalized, it goes through our review system. You can inspect it from every angle, and if something isn't quite right, we iterate until it's perfect.",
    camera: {
      position: [0.3, 1.2, 2.8],
      target: [0, 0.95, 0],
      fov: 40,
      transitionSeconds: 0.6,
    },
    durationSeconds: 10,
    interactive: {
      type: "reveal",
      prompt: "See the review criteria",
      revealContent: "Scale check, topology validation, visual inspection",
    },
    edu: {
      topic: "spatial-p5-review",
      takeaway: "Every model undergoes automated validation (scale, topology) plus human review before delivery.",
      level: "intermediate",
    },
    order: 12,
  },
  {
    id: "reveal-review",
    title: "Triple-Check Quality",
    description: "Three levels of validation before delivery.",
    clip: "gesture_present",
    dialogue: "Three checks: automated scale validation, topology analysis, and your personal visual review. We never deliver something we wouldn't keep on our own shelf.",
    camera: {
      position: [0, 1.15, 2.6],
      target: [0, 1.0, 0],
      fov: 38,
      transitionSeconds: 0.5,
    },
    durationSeconds: 8,
    edu: {
      topic: "quality-assurance",
      takeaway: "Triple validation — automated scale, topology, and human review — ensures every model meets our quality bar.",
      level: "beginner",
    },
    order: 13,
  },
  {
    id: "success",
    title: "You're Ready!",
    description: "Barkley celebrates the user's new knowledge.",
    clip: "clap",
    dialogue: "You now know the fundamentals! You're ready to create your first 3D pet model. Let's get started!",
    camera: {
      position: [0, 1.35, 2.5],
      target: [0, 1.1, 0],
      fov: 36,
      transitionSeconds: 0.5,
    },
    durationSeconds: 6,
    order: 14,
  },
  {
    id: "goodbye",
    title: "See You Soon!",
    description: "Barkley signs off with a wave.",
    clip: "wave_bye",
    dialogue: "I'm here whenever you need me. Visit me at /barkley anytime. Now go create something amazing!",
    camera: {
      position: [0, 1.4, 3.5],
      target: [0, 1.0, 0],
      fov: 44,
      transitionSeconds: 0.8,
    },
    durationSeconds: 7,
    order: 15,
  },
];

// Sort beats by order before exporting
BEATS.sort((a, b) => a.order - b.order);

export const BARKLEY_SHOW: BarkleyShow = {
  id: "pawsome3d-intro",
  name: "Welcome to Pawsome3D",
  description: "Barkley guides you through the platform — from spatial generation to Pawprints to animation layers.",
  beats: BEATS,
  totalDurationSeconds: BEATS.reduce((sum, b) => sum + b.durationSeconds, 0),
  featureFlag: "BARKLEY_PRESENTER",
};
