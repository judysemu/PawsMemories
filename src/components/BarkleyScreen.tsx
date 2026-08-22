/**
 * Barkley Presenter — 3D interactive stage component.
 *
 * Renders Barkley (biped presenter) on an interactive 3D stage with:
 * - Pawsome3D TerraPaw Material 3 warm design language (brown, cream, peach, glass)
 * - Smooth camera choreography per beat
 * - Full light & dark theme reactivity
 * - Mobile-first responsive layout (375px, 768px, 1440px)
 * - Accessible keyboard navigation & screen-reader live regions
 * - Respect for prefers-reduced-motion
 * - Interactive quiz and reveal overlays
 * - Educational callout cards with pipeline takeaways
 * - Fallback geometric figure if barkley.glb is not found
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import * as THREE from "three";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import {
  OrbitControls,
  Environment,
  ContactShadows,
} from "@react-three/drei";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  Award,
  Lightbulb,
  GraduationCap,
  X,
  Compass,
  CheckCircle2,
  ArrowRight,
  RotateCcw,
  Check,
} from "lucide-react";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  fetchBarkleyShow,
  createBarkleySession,
  advanceBeat,
  submitInteraction,
  replayBeat,
  endSession,
  fetchBarkleyStatus,
} from "../barkley/api";
import { BARKLEY_SHOW as CANONICAL_SHOW } from "../barkley/shows";
import type {
  BarkleyBeat,
  BarkleyShow,
  BarkleyState,
  BarkleyCameraFrame,
  BarkleyInteraction,
  BarkleyEduMeta,
  BarkleyInteractionResult,
} from "../barkley/types";

// ──────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────

const BARKLEY_GLB_PATH = "/barkley/barkley.glb";
const BEAT_TRANSITION_MS = 800;
const AUTO_ADVANCE_BUFFER_MS = 1500;
const QUIZ_TIMEOUT_MS = 15000;

// ──────────────────────────────────────────────────────────────────
// 3D Components (inside Canvas)
// ──────────────────────────────────────────────────────────────────

/**
 * Barkley character — loads the biped model from /barkley/barkley.glb
 * and plays animation clips addressed by name from gltf.animations.
 * Falls back gracefully to a styled puppy figurine if the model 404s.
 */
function BarkleyCharacter({
  clip,
  state,
  isDark,
}: {
  clip: string;
  state: BarkleyState;
  isDark: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionRef = useRef<THREE.AnimationAction | null>(null);
  const clipMapRef = useRef<Map<string, THREE.AnimationClip> | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let disposed = false;
    const loader = new GLTFLoader();

    const playClip = (name: string) => {
      if (!mixerRef.current || !clipMapRef.current) return;
      const clipData = clipMapRef.current.get(name);
      if (!clipData) return;

      if (actionRef.current) {
        actionRef.current.fadeOut(0.3);
      }

      const action = mixerRef.current.clipAction(clipData);
      action.reset();
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.fadeIn(0.3);
      action.play();
      actionRef.current = action;
    };

    loader.load(
      BARKLEY_GLB_PATH,
      (gltf) => {
        if (disposed) return;
        const cloned = SkeletonUtils.clone(gltf.scene) as THREE.Group;
        cloned.position.set(0, 0, 0);
        cloned.scale.setScalar(1);

        // Ensure all meshes cast/receive soft shadows
        cloned.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        if (groupRef.current) {
          groupRef.current.clear();
          groupRef.current.add(cloned);
        }

        const clipMap = new Map<string, THREE.AnimationClip>();
        for (const clipData of gltf.animations) {
          clipMap.set(clipData.name, clipData);
        }
        clipMapRef.current = clipMap;

        mixerRef.current = new THREE.AnimationMixer(cloned);
        setLoaded(true);
        playClip(clip);
      },
      undefined,
      () => {
        // Model not found — fallback placeholder mode
        if (!disposed) {
          setLoaded(false);
        }
      }
    );

    return () => {
      disposed = true;
      mixerRef.current?.stopAllAction();
    };
  }, []);

  // Switch clips when the beat changes
  useEffect(() => {
    if (mixerRef.current && clipMapRef.current) {
      const clipData = clipMapRef.current.get(clip);
      if (!clipData) return;

      if (actionRef.current) {
        actionRef.current.fadeOut(0.3);
      }
      const action = mixerRef.current.clipAction(clipData);
      action.reset();
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.fadeIn(0.3);
      action.play();
      actionRef.current = action;
    }
  }, [clip]);

  // Update mixer on every frame
  useFrame((_state, delta) => {
    mixerRef.current?.update(delta);
  });

  if (loaded) return <group ref={groupRef} />;

  // ── Warm fallback puppy figure (rendered if model GLB is missing) ─
  const bodyColor = isDark ? "#c4824d" : "#a86438";
  const chestColor = isDark ? "#fbe3d5" : "#fff1e6";
  const earColor = isDark ? "#8d4f29" : "#783c1c";
  const noseColor = "#2c160e";

  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      {/* Torso */}
      <mesh castShadow receiveShadow position={[0, 0.95, 0]}>
        <capsuleGeometry args={[0.18, 0.55, 12, 24]} />
        <meshStandardMaterial color={bodyColor} roughness={0.5} metalness={0.05} />
      </mesh>
      {/* Chest patch */}
      <mesh position={[0, 0.95, 0.12]} rotation={[0, 0, 0]}>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshStandardMaterial color={chestColor} roughness={0.6} />
      </mesh>
      {/* Head */}
      <mesh castShadow receiveShadow position={[0, 1.48, 0.05]}>
        <sphereGeometry args={[0.22, 24, 24]} />
        <meshStandardMaterial color={bodyColor} roughness={0.5} metalness={0.05} />
      </mesh>
      {/* Snout / Muzzle */}
      <mesh castShadow position={[0, 1.42, 0.22]}>
        <sphereGeometry args={[0.11, 16, 16]} />
        <meshStandardMaterial color={chestColor} roughness={0.5} />
      </mesh>
      {/* Nose */}
      <mesh position={[0, 1.46, 0.32]}>
        <sphereGeometry args={[0.035, 12, 12]} />
        <meshStandardMaterial color={noseColor} roughness={0.3} metalness={0.2} />
      </mesh>
      {/* Left Ear */}
      <mesh castShadow position={[-0.18, 1.56, -0.02]} rotation={[0.2, 0, -0.4]}>
        <capsuleGeometry args={[0.06, 0.22, 8, 12]} />
        <meshStandardMaterial color={earColor} roughness={0.6} />
      </mesh>
      {/* Right Ear */}
      <mesh castShadow position={[0.18, 1.56, -0.02]} rotation={[0.2, 0, 0.4]}>
        <capsuleGeometry args={[0.06, 0.22, 8, 12]} />
        <meshStandardMaterial color={earColor} roughness={0.6} />
      </mesh>
      {/* Eyes */}
      <mesh position={[-0.08, 1.53, 0.22]}>
        <sphereGeometry args={[0.028, 12, 12]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.1} />
      </mesh>
      <mesh position={[0.08, 1.53, 0.22]}>
        <sphereGeometry args={[0.028, 12, 12]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.1} />
      </mesh>
      {/* Left Arm */}
      <mesh castShadow position={[-0.24, 0.98, 0]} rotation={[0, 0, 0.2]}>
        <capsuleGeometry args={[0.065, 0.38, 8, 12]} />
        <meshStandardMaterial color={bodyColor} roughness={0.6} />
      </mesh>
      {/* Right Arm */}
      <mesh castShadow position={[0.24, 0.98, 0]} rotation={[0, 0, -0.2]}>
        <capsuleGeometry args={[0.065, 0.38, 8, 12]} />
        <meshStandardMaterial color={bodyColor} roughness={0.6} />
      </mesh>
      {/* Left Leg */}
      <mesh castShadow position={[-0.12, 0.32, 0]}>
        <capsuleGeometry args={[0.075, 0.42, 8, 12]} />
        <meshStandardMaterial color={earColor} roughness={0.7} />
      </mesh>
      {/* Right Leg */}
      <mesh castShadow position={[0.12, 0.32, 0]}>
        <capsuleGeometry args={[0.075, 0.42, 8, 12]} />
        <meshStandardMaterial color={earColor} roughness={0.7} />
      </mesh>
      {/* Collar with Gold Tag */}
      <mesh position={[0, 1.28, 0.03]} rotation={[-0.1, 0, 0]}>
        <torusGeometry args={[0.16, 0.028, 12, 24]} />
        <meshStandardMaterial color="#ba1a1a" roughness={0.4} />
      </mesh>
      <mesh position={[0, 1.22, 0.18]}>
        <cylinderGeometry args={[0.03, 0.03, 0.008, 16]} />
        <meshStandardMaterial color="#f2c960" metalness={0.8} roughness={0.2} />
      </mesh>
      {/* Billboard label */}
      <BillboardText
        text="🐾 Barkley"
        position={[0, 1.9, 0]}
        color={isDark ? "#ffdbd0" : "#442a22"}
        size={0.25}
      />
    </group>
  );
}

/**
 * Billboard text that always faces the camera.
 */
function BillboardText({
  text,
  position,
  color,
  size = 0.25,
}: {
  text: string;
  position: [number, number, number];
  color?: string;
  size?: number;
}) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ camera }) => {
    if (ref.current) ref.current.lookAt(camera.position);
  });

  const texture = useMemo(() => {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    canvas.width = 512;
    canvas.height = 128;
    ctx.clearRect(0, 0, 512, 128);
    ctx.font = "bold 48px 'Plus Jakarta Sans', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = color || "#442a22";
    ctx.fillText(text, 256, 75);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [text, color]);

  if (!texture) return null;

  return (
    <group ref={ref} position={position} scale={[size * 4, size, 1]}>
      <sprite position={[0, 0, 0]}>
        <spriteMaterial attach="material" map={texture} transparent depthWrite={false} />
      </sprite>
    </group>
  );
}

/**
 * Camera rig that smoothly transitions between beat camera positions.
 * Respects prefers-reduced-motion by snapping instantly when reduced motion is preferred.
 */
function BarkleyCamera({
  cameraFrame,
  isTransitioning,
  reducedMotion,
}: {
  cameraFrame: BarkleyCameraFrame;
  isTransitioning: boolean;
  reducedMotion: boolean;
}) {
  const { camera } = useThree();
  const prevPos = useRef(new THREE.Vector3(...cameraFrame.position));
  const targetPos = useRef(new THREE.Vector3(...cameraFrame.position));
  const prevTarget = useRef(new THREE.Vector3(...cameraFrame.target));
  const targetTarget = useRef(new THREE.Vector3(...cameraFrame.target));
  const transitionStart = useRef<number | null>(null);
  const transitionDuration = useRef(cameraFrame.transitionSeconds ?? 0.8);

  useEffect(() => {
    if (reducedMotion) {
      camera.position.set(...cameraFrame.position);
      camera.lookAt(...cameraFrame.target);
      prevPos.current.set(...cameraFrame.position);
      prevTarget.current.set(...cameraFrame.target);
      transitionStart.current = null;
      return;
    }

    prevPos.current.copy(camera.position);
    targetPos.current.set(...cameraFrame.position);
    targetTarget.current.set(...cameraFrame.target);
    transitionDuration.current = cameraFrame.transitionSeconds ?? 0.8;
    transitionStart.current = performance.now();
  }, [cameraFrame, camera, reducedMotion]);

  useFrame(() => {
    if ((camera as THREE.PerspectiveCamera).fov !== cameraFrame.fov) {
      (camera as THREE.PerspectiveCamera).fov = cameraFrame.fov;
      camera.updateProjectionMatrix();
    }

    if (reducedMotion) {
      camera.position.set(...cameraFrame.position);
      camera.lookAt(...cameraFrame.target);
      return;
    }

    if (transitionStart.current !== null) {
      const elapsed = (performance.now() - transitionStart.current) / 1000;
      const t = Math.min(elapsed / transitionDuration.current, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - t, 3);

      camera.position.lerpVectors(prevPos.current, targetPos.current, eased);
      const currentLook = new THREE.Vector3().lerpVectors(
        prevTarget.current,
        targetTarget.current,
        eased
      );
      camera.lookAt(currentLook);

      if (t >= 1) {
        transitionStart.current = null;
        prevPos.current.set(...cameraFrame.position);
        prevTarget.current.set(...cameraFrame.target);
      }
    } else if (!isTransitioning) {
      camera.lookAt(...cameraFrame.target);
    }
  });

  return null;
}

/**
 * Stage floor with warm TerraPaw Material 3 aesthetics for both light and dark mode.
 */
function BarkleyStage({ isDark }: { isDark: boolean }) {
  // Light mode: warm cream stone podium; Dark mode: rich roasted espresso wood
  const floorColor = isDark ? "#201a17" : "#ebe4da";
  const ringColor = isDark ? "#e7bdb1" : "#77574d";
  const gridPrimary = isDark ? "#352b27" : "#dfd5c8";
  const gridSecondary = isDark ? "#28201c" : "#e8dfd2";
  const spotLightColor = isDark ? "#ffeedd" : "#fff8f0";
  const fillLightColor = isDark ? "#e7bdb1" : "#fbf4ec";

  return (
    <>
      {/* Elevated circular podium */}
      <mesh position={[0, -0.02, 0]} receiveShadow>
        <cylinderGeometry args={[2.4, 2.6, 0.04, 64]} />
        <meshStandardMaterial color={floorColor} roughness={0.7} metalness={0.05} />
      </mesh>

      {/* Decorative accent ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <ringGeometry args={[1.35, 1.4, 64]} />
        <meshStandardMaterial
          color={ringColor}
          emissive={ringColor}
          emissiveIntensity={isDark ? 0.25 : 0.15}
          roughness={0.4}
        />
      </mesh>

      {/* Subtle concentric guide ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]}>
        <ringGeometry args={[2.1, 2.12, 64]} />
        <meshStandardMaterial color={gridPrimary} roughness={0.8} opacity={0.6} transparent />
      </mesh>

      {/* Subtle grid on the stage */}
      <gridHelper
        args={[5, 10, gridPrimary, gridSecondary]}
        position={[0, 0.006, 0]}
      />

      {/* Key spotlight on Barkley */}
      <spotLight
        position={[0, 4.5, 2.5]}
        angle={0.38}
        penumbra={0.7}
        intensity={isDark ? 2.8 : 2.2}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0001}
        color={spotLightColor}
      />

      {/* Warm fill light */}
      <pointLight position={[-2.5, 2.8, 1.5]} intensity={0.6} color={fillLightColor} />

      {/* Warm peach rim light */}
      <pointLight position={[2, 2.2, -1.8]} intensity={0.45} color="#ffd9ce" />

      {/* Soft ambient */}
      <ambientLight intensity={isDark ? 0.45 : 0.75} />
    </>
  );
}

// ──────────────────────────────────────────────────────────────────
// UI Overlay Components (Warm TerraPaw Design Tokens)
// ──────────────────────────────────────────────────────────────────

/**
 * Dialogue caption display — warm, legible speech card anchored near the bottom.
 */
function DialogueSubtitle({
  dialogue,
  beatTitle,
}: {
  dialogue?: string;
  beatTitle?: string;
}) {
  if (!dialogue) return null;

  return (
    <div
      role="region"
      aria-live="polite"
      aria-label="Barkley's dialogue"
      className="w-full max-w-2xl px-4 sm:px-6 pointer-events-auto"
    >
      <div className="glass-card rounded-2xl p-4 sm:p-5 border border-primary/20 shadow-xl relative overflow-hidden transition-all duration-300">
        {/* Subtle warm accent bar on left */}
        <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-primary via-primary-fixed to-primary" />

        <div className="flex items-center gap-2 mb-1.5 pl-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 dark:bg-primary/20 px-2.5 py-0.5 text-xs font-bold text-primary dark:text-primary-fixed-dim">
            <span className="text-xs">🐾</span> Barkley
          </span>
          {beatTitle && (
            <span className="text-[11px] font-medium text-on-surface-variant/80 truncate">
              • {beatTitle}
            </span>
          )}
        </div>

        <p className="text-on-surface text-sm sm:text-base leading-relaxed pl-2 font-medium">
          {dialogue}
        </p>
      </div>
    </div>
  );
}

/**
 * Educational callout card — presents pro-tips & pipeline concepts.
 */
function EduCard({ edu }: { edu?: BarkleyEduMeta }) {
  const [expanded, setExpanded] = useState(false);
  if (!edu) return null;

  const levelBadge = {
    beginner: {
      label: "Beginner Tip",
      badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20",
    },
    intermediate: {
      label: "Pipeline Concept",
      badge: "bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/20",
    },
    advanced: {
      label: "Technical Deep Dive",
      badge: "bg-primary/10 text-primary dark:text-primary-fixed-dim border-primary/20",
    },
  }[edu.level ?? "beginner"];

  return (
    <div className="w-full max-w-xs sm:max-w-sm pointer-events-auto">
      <div className="glass-card rounded-2xl border border-outline-variant/30 shadow-lg overflow-hidden transition-all duration-300">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-between gap-2 p-3 text-left hover:bg-surface-container/50 transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
          aria-expanded={expanded}
          aria-label={`Toggle educational takeaway for ${edu.topic}`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-primary/10 dark:bg-primary/20 flex items-center justify-center text-primary shrink-0">
              <Lightbulb size={16} />
            </div>
            <div className="min-w-0">
              <span className={`inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${levelBadge.badge}`}>
                {levelBadge.label}
              </span>
              <p className="text-xs font-bold text-on-surface truncate mt-0.5">
                {edu.topic.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
              </p>
            </div>
          </div>
          <ChevronRight
            size={16}
            className={`text-on-surface-variant transition-transform duration-200 shrink-0 ${
              expanded ? "rotate-90" : ""
            }`}
          />
        </button>

        {expanded && (
          <div className="px-4 pb-3.5 pt-1 border-t border-outline-variant/20 bg-surface-container-low/40">
            <p className="text-xs leading-relaxed text-on-surface-variant font-normal">
              {edu.takeaway}
            </p>
            {edu.resourceUrl && (
              <a
                href={edu.resourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2.5 inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
              >
                Read documentation <ArrowRight size={12} />
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Interactive quiz and reveal overlay.
 */
function QuizOverlay({
  interaction,
  onSubmit,
  beatId,
}: {
  interaction: BarkleyInteraction;
  onSubmit: (answer: unknown) => void;
  beatId: string;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [correct, setCorrect] = useState(false);
  const [timeoutState, setTimeoutState] = useState(false);

  // Generate quiz options from the prompt context
  const quizOptions = useMemo(() => {
    const prompt = interaction.prompt;
    if (prompt.includes("angle") || prompt.includes("photo") || prompt.includes("multi-view")) {
      return [
        "To save storage space on the server",
        "To capture depth, silhouettes, and true 3D proportions",
        "To make the final render look more artistic",
        "To bypass automated quality inspection",
      ];
    }
    if (prompt.includes("layer") || prompt.includes("tail") || prompt.includes("L1")) {
      return [
        "L0 — Base locomotion layer",
        "L1 — Secondary gesture & overlay layer",
        "L2 — Reactive emote & feedback layer",
        "All layers must be baked together permanently",
      ];
    }
    if (prompt.includes("L0") || prompt.includes("skeleton")) {
      return [
        "Locomotion and base posing (walk, sit, lie)",
        "Facial expressions and tongue movement",
        "Audio voice track synthesis",
        "Camera orbital tracking",
      ];
    }
    return [
      "Depth mapping and surface reconstruction",
      "Topology optimization and quad mesh remeshing",
      "Print validation and wall-thickness analysis",
      "All of the above in sequence",
    ];
  }, [interaction.prompt]);

  // Quiz timeout
  useEffect(() => {
    if (submitted || timeoutState) return;
    const timer = setTimeout(() => {
      setTimeoutState(true);
      onSubmit(interaction.correctAnswer ?? 1);
      setCorrect(true);
    }, QUIZ_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [submitted, timeoutState, onSubmit, interaction.correctAnswer]);

  const handleSelect = (index: number) => {
    if (submitted) return;
    setSelected(index);
    const isCorrect = index === (interaction.correctAnswer ?? 1);
    setSubmitted(true);
    setCorrect(isCorrect);
    onSubmit(index);
  };

  // Keyboard shortcut listener for quiz choices (1-4 or A-D)
  useEffect(() => {
    if (submitted || interaction.type !== "quiz") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (["1", "a", "A"].includes(e.key) && quizOptions[0]) handleSelect(0);
      if (["2", "b", "B"].includes(e.key) && quizOptions[1]) handleSelect(1);
      if (["3", "c", "C"].includes(e.key) && quizOptions[2]) handleSelect(2);
      if (["4", "d", "D"].includes(e.key) && quizOptions[3]) handleSelect(3);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [submitted, interaction.type, quizOptions]);

  // Reveal interaction
  if (interaction.type === "reveal") {
    return (
      <div className="w-full max-w-lg px-4 pointer-events-auto">
        <div className="glass-card rounded-2xl p-5 border border-primary/30 shadow-2xl text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary/10 dark:bg-primary/20 text-primary mb-3">
            <Sparkles size={20} />
          </div>
          <h3 className="text-base font-bold text-on-surface mb-3">
            {interaction.prompt}
          </h3>
          {submitted ? (
            <div className="p-3.5 rounded-xl bg-primary-fixed/30 dark:bg-primary-container/40 border border-primary/20 text-sm font-semibold text-on-surface">
              ✨ {interaction.revealContent || "Triple-check validation complete: Scale, Topology & Finish!"}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSubmitted(true);
                onSubmit(null);
              }}
              className="inline-flex items-center gap-2 rounded-2xl bg-primary px-6 py-3 text-sm font-black text-on-primary tactile-button shadow-lg hover:brightness-105 transition-all focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Sparkles size={16} />
              Tap to Reveal
            </button>
          )}
        </div>
      </div>
    );
  }

  // Click-hotspot interaction
  if (interaction.type === "click-hotspot") {
    return (
      <div className="w-full max-w-md px-4 pointer-events-auto">
        <button
          type="button"
          onClick={() => {
            setSubmitted(true);
            onSubmit(null);
          }}
          className="w-full glass-card hover:border-primary/50 rounded-2xl p-4 border border-outline-variant/40 shadow-xl flex items-center justify-center gap-3 text-on-surface font-bold text-sm transition-all tactile-button focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            🐾
          </span>
          {interaction.prompt}
        </button>
      </div>
    );
  }

  // Quiz type
  return (
    <div className="w-full max-w-lg px-4 pointer-events-auto">
      <div className="glass-card rounded-2xl p-5 sm:p-6 border border-primary/30 shadow-2xl">
        <div className="flex items-center gap-2.5 mb-4">
          <div className="w-9 h-9 rounded-xl bg-primary/10 dark:bg-primary/20 flex items-center justify-center text-primary shrink-0">
            <GraduationCap size={20} />
          </div>
          <div>
            <span className="text-[10px] font-black uppercase tracking-wider text-primary">
              Interactive Checkpoint
            </span>
            <h3 className="text-on-surface font-bold text-sm sm:text-base leading-snug">
              {interaction.prompt}
            </h3>
          </div>
        </div>

        <div className="space-y-2.5" role="radiogroup" aria-label={interaction.prompt}>
          {quizOptions.map((option, index) => {
            const letter = String.fromCharCode(65 + index);
            const isTarget = index === (interaction.correctAnswer ?? 1);
            const isUserChoice = index === selected;

            let cardStyle =
              "bg-surface-container-lowest/80 dark:bg-surface-container-low/80 border-outline-variant/40 text-on-surface hover:border-primary/60 hover:bg-primary-fixed/20 dark:hover:bg-primary-container/30";

            if (submitted) {
              if (isTarget) {
                cardStyle =
                  "bg-emerald-500/15 border-emerald-500/60 text-emerald-950 dark:text-emerald-200 font-semibold ring-1 ring-emerald-500/40";
              } else if (isUserChoice && !correct) {
                cardStyle =
                  "bg-error/10 border-error/50 text-error line-through opacity-80";
              } else {
                cardStyle = "opacity-50 border-outline-variant/20 text-on-surface-variant";
              }
            }

            return (
              <button
                key={index}
                type="button"
                role="radio"
                aria-checked={isUserChoice}
                onClick={() => handleSelect(index)}
                disabled={submitted}
                className={`w-full text-left px-3.5 py-3 rounded-xl border transition-all duration-200 text-xs sm:text-sm flex items-center justify-between gap-3 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none ${cardStyle}`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <span className="w-6 h-6 rounded-lg bg-surface-container-high dark:bg-surface-container-highest flex items-center justify-center text-xs font-bold text-on-surface shrink-0 shadow-sm">
                    {letter}
                  </span>
                  <span className="leading-snug">{option}</span>
                </span>
                {submitted && isTarget && (
                  <CheckCircle2 size={18} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
                )}
              </button>
            );
          })}
        </div>

        {submitted && (
          <div
            className={`mt-4 p-3 rounded-xl text-center text-xs sm:text-sm font-bold flex items-center justify-center gap-2 transition-all ${
              correct
                ? "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200 border border-emerald-500/30"
                : "bg-primary-fixed/30 text-on-primary-fixed border border-primary/20"
            }`}
          >
            {correct ? (
              <>
                <Check size={16} className="text-emerald-600" />
                Spot on! Barkley gives this a double tail wag!
              </>
            ) : (
              <>
                <span>💡</span>
                Good guess! The highlighted answer is how the pipeline works.
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Bottom control dock and progress bar.
 */
function BottomControlDock({
  progress,
  beatIndex,
  totalBeats,
  onPrev,
  onNext,
  isPlaying,
  onTogglePlay,
  onSelectBeat,
}: {
  progress: number;
  beatIndex: number;
  totalBeats: number;
  onPrev: () => void;
  onNext: () => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onSelectBeat?: (index: number) => void;
}) {
  return (
    <div className="w-full max-w-3xl px-4 pb-4 pt-2 pointer-events-auto">
      <div className="glass-card rounded-2xl px-4 py-3 sm:px-6 sm:py-3.5 border border-outline-variant/30 shadow-xl flex flex-col gap-2.5">
        {/* Top row: Beat tracker info & navigation buttons */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-black uppercase tracking-wider text-primary">
              Beat {beatIndex + 1}
            </span>
            <span className="text-xs text-on-surface-variant font-medium">
              of {totalBeats}
            </span>
          </div>

          {/* Playback Controls */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={onPrev}
              disabled={beatIndex === 0}
              title="Previous Beat (Left Arrow)"
              aria-label="Previous Beat"
              className="p-2 sm:p-2.5 rounded-xl text-on-surface hover:bg-surface-container-high/60 disabled:opacity-30 disabled:cursor-not-allowed transition-all focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            >
              <ChevronLeft size={18} />
            </button>

            <button
              type="button"
              onClick={onTogglePlay}
              title={isPlaying ? "Pause Tour (Spacebar)" : "Play Tour (Spacebar)"}
              aria-label={isPlaying ? "Pause tour" : "Play tour"}
              className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary text-on-primary shadow-md hover:brightness-105 active:scale-95 transition-all focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} className="translate-x-0.5" />}
            </button>

            <button
              type="button"
              onClick={onNext}
              disabled={beatIndex >= totalBeats - 1}
              title="Next Beat (Right Arrow)"
              aria-label="Next Beat"
              className="p-2 sm:p-2.5 rounded-xl text-on-surface hover:bg-surface-container-high/60 disabled:opacity-30 disabled:cursor-not-allowed transition-all focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>

        {/* Progress bar with segment ticks */}
        <div className="relative pt-1">
          <div
            className="h-2 bg-surface-container-highest dark:bg-surface-container-high rounded-full overflow-hidden"
            role="progressbar"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Tour progress"
          >
            <div
              className="h-full bg-gradient-to-r from-primary via-primary-container to-primary rounded-full transition-all duration-500 ease-out"
              style={{ width: `${Math.max(progress * 100, 3)}%` }}
            />
          </div>

          {/* Beat indicator ticks */}
          <div className="flex justify-between mt-2 px-0.5">
            {Array.from({ length: totalBeats }, (_, i) => {
              const isPast = i < beatIndex;
              const isCurrent = i === beatIndex;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onSelectBeat?.(i)}
                  title={`Jump to Beat ${i + 1}`}
                  aria-label={`Jump to Beat ${i + 1}`}
                  className={`h-2 rounded-full transition-all duration-300 focus-visible:ring-2 focus-visible:ring-primary ${
                    isCurrent
                      ? "w-4 bg-primary"
                      : isPast
                      ? "w-2 bg-primary/40"
                      : "w-2 bg-outline-variant/30"
                  }`}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Completion card celebrating completion of the 16 beats.
 */
function CompletionScreen({
  onRestart,
  onNavigate,
  quizScore,
}: {
  onRestart: () => void;
  onNavigate: (screen: string) => void;
  quizScore?: { correct: number; total: number };
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4 bg-surface/70 backdrop-blur-md z-40">
      <div className="glass-hero max-w-lg w-full p-6 sm:p-8 rounded-3xl text-center border border-primary/20 soft-glow-shadow">
        <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-3xl bg-primary/10 dark:bg-primary/20 flex items-center justify-center mx-auto mb-4 text-primary text-3xl sm:text-4xl shadow-inner">
          🐾
        </div>

        <span className="inline-block text-xs font-black uppercase tracking-[.2em] text-primary mb-1">
          Tour Complete
        </span>
        <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-on-surface mb-2">
          You're Ready to Build!
        </h2>
        <p className="text-on-surface-variant text-sm sm:text-base mb-6 leading-relaxed">
          Barkley has walked you through spatial reconstruction, multi-layer animations, and quality inspection. Now it's time to turn your own pet's photo into a custom keepsake.
        </p>

        {quizScore && quizScore.total > 0 && (
          <div className="mb-6 inline-flex items-center gap-2 rounded-2xl bg-primary/10 px-4 py-2 text-xs font-bold text-primary">
            <Award size={16} />
            Quiz Score: {quizScore.correct} of {quizScore.total} checkpoints mastered!
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            type="button"
            onClick={() => onNavigate("create")}
            className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-7 py-3.5 text-sm font-black text-on-primary tactile-button shadow-lg hover:brightness-105 transition-all focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Sparkles size={16} />
            Make My 3D Pet
            <ArrowRight size={16} />
          </button>
          <button
            type="button"
            onClick={onRestart}
            className="glass-button flex items-center justify-center gap-2 rounded-2xl px-6 py-3.5 text-sm font-bold text-on-surface hover:text-primary transition-all focus-visible:ring-2 focus-visible:ring-primary"
          >
            <RotateCcw size={16} />
            Replay Tour
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Main BarkleyScreen Component
// ──────────────────────────────────────────────────────────────────

export default function BarkleyScreen({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<{
    enabled: boolean;
    clips: { total: number; ready: number; missing: string[]; allReady: boolean };
    show: { id: string; name: string; beatCount: number };
  } | null>(null);
  const [showData, setShowData] = useState<BarkleyShow | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentBeat, setCurrentBeat] = useState<BarkleyBeat | null>(null);
  const [beatIndex, setBeatIndex] = useState(0);
  const [state, setState] = useState<BarkleyState>("loading");
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [interactions, setInteractions] = useState<BarkleyInteractionResult[]>([]);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [soundMuted, setSoundMuted] = useState(true);

  // Dynamic theme tracking (dark / light mode sync)
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === "undefined") return false;
    return document.documentElement.classList.contains("dark") || document.body.classList.contains("dark");
  });

  // Reduced motion preference
  const [reducedMotion, setReducedMotion] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  const [cameraFrame, setCameraFrame] = useState<BarkleyCameraFrame>({
    position: [0, 1.4, 3.5],
    target: [0, 1.0, 0],
    fov: 42,
  });

  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Listen for dark mode mutations on document.documentElement
  useEffect(() => {
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => {
      const isDarkMode =
        document.documentElement.classList.contains("dark") ||
        document.body.classList.contains("dark");
      setIsDark(isDarkMode);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleMotionChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    motionQuery.addEventListener("change", handleMotionChange);

    return () => {
      observer.disconnect();
      motionQuery.removeEventListener("change", handleMotionChange);
    };
  }, []);

  // Initialize session and show data
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const st = await fetchBarkleyStatus();
        if (cancelled) return;

        // If status returns and feature is active
        if (st && st.enabled && st.clips.allReady) {
          setStatus(st);
          const show = await fetchBarkleyShow();
          if (cancelled) return;

          if (show) {
            setShowData(show.show);
            const session = await createBarkleySession();
            if (cancelled) return;
            if (session) {
              setSessionId(session.sessionId);
            }
            const firstBeat = show.show.beats[0];
            if (firstBeat) {
              setCurrentBeat(firstBeat);
              setCameraFrame(firstBeat.camera);
              setState("playing");
              setIsPlaying(true);
              return;
            }
          }
        }

        // Graceful fallback for status reporting:
        // When running in preview / standalone or when clips/status report issues,
        // use canonical CANONICAL_SHOW so visitors can still experience the tour
        setStatus(
          st || {
            enabled: true,
            clips: { total: 30, ready: 30, missing: [], allReady: true },
            show: {
              id: CANONICAL_SHOW.id,
              name: CANONICAL_SHOW.name,
              beatCount: CANONICAL_SHOW.beats.length,
            },
          }
        );
        setShowData(CANONICAL_SHOW);
        const firstBeat = CANONICAL_SHOW.beats[0];
        if (firstBeat) {
          setCurrentBeat(firstBeat);
          setCameraFrame(firstBeat.camera);
          setState("playing");
          setIsPlaying(true);
        }
      } catch {
        if (!cancelled) {
          // Robust client-side fallback
          setShowData(CANONICAL_SHOW);
          const firstBeat = CANONICAL_SHOW.beats[0];
          if (firstBeat) {
            setCurrentBeat(firstBeat);
            setCameraFrame(firstBeat.camera);
            setState("playing");
            setIsPlaying(true);
          }
        }
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  // Forward beat navigation
  const handleNext = useCallback(async () => {
    const show = showData || CANONICAL_SHOW;
    const totalBeatsCount = show.beats.length;

    if (beatIndex >= totalBeatsCount - 1) {
      setState("complete");
      setProgress(1);
      return;
    }

    setIsTransitioning(true);
    const nextIdx = beatIndex + 1;
    const nextBeat = show.beats[nextIdx];

    if (sessionId) {
      advanceBeat(sessionId)
        .then((res) => {
          if (res) {
            if (res.beat) {
              setCurrentBeat(res.beat);
              setBeatIndex(res.beatIndex);
              setProgress(res.progress);
              setCameraFrame(res.beat.camera);
            } else if (res.state === "complete") {
              setState("complete");
              setProgress(1);
            }
          }
        })
        .catch(() => {});
    }

    if (nextBeat) {
      setCurrentBeat(nextBeat);
      setBeatIndex(nextIdx);
      setProgress((nextIdx + 1) / totalBeatsCount);
      setState("playing");
      setCameraFrame(nextBeat.camera);
    }

    setTimeout(() => setIsTransitioning(false), BEAT_TRANSITION_MS);
  }, [sessionId, beatIndex, showData]);

  // Backward beat navigation
  const handlePrev = useCallback(async () => {
    if (beatIndex <= 0) return;
    const show = showData || CANONICAL_SHOW;
    setIsTransitioning(true);

    const prevIdx = beatIndex - 1;
    const prevBeat = show.beats[prevIdx];

    if (sessionId && prevBeat) {
      replayBeat(sessionId, prevBeat.id)
        .then((res) => {
          if (res && res.beat) {
            setCurrentBeat(res.beat);
            setBeatIndex(res.beatIndex);
            setProgress((res.beatIndex + 1) / show.beats.length);
            setCameraFrame(res.beat.camera);
          }
        })
        .catch(() => {});
    }

    if (prevBeat) {
      setCurrentBeat(prevBeat);
      setBeatIndex(prevIdx);
      setProgress((prevIdx + 1) / show.beats.length);
      setCameraFrame(prevBeat.camera);
      setState("playing");
    }

    setTimeout(() => setIsTransitioning(false), BEAT_TRANSITION_MS);
  }, [sessionId, beatIndex, showData]);

  // Jump to specific beat
  const handleSelectBeat = useCallback(
    (targetIdx: number) => {
      const show = showData || CANONICAL_SHOW;
      if (targetIdx < 0 || targetIdx >= show.beats.length) return;
      setIsTransitioning(true);
      const targetBeat = show.beats[targetIdx];
      if (targetBeat) {
        setCurrentBeat(targetBeat);
        setBeatIndex(targetIdx);
        setProgress((targetIdx + 1) / show.beats.length);
        setCameraFrame(targetBeat.camera);
        setState("playing");
      }
      setTimeout(() => setIsTransitioning(false), BEAT_TRANSITION_MS);
    },
    [showData]
  );

  // Auto-advance timer per beat duration
  useEffect(() => {
    if (autoTimer.current) clearTimeout(autoTimer.current);
    if (
      !isPlaying ||
      state !== "playing" ||
      !currentBeat ||
      currentBeat.interactive?.type === "quiz"
    ) {
      return;
    }

    const durationSec = currentBeat.durationSeconds || 7;
    const holdTimeMs = Math.max(
      (durationSec - AUTO_ADVANCE_BUFFER_MS / 1000) * 1000,
      3000
    );

    autoTimer.current = setTimeout(() => {
      handleNext();
    }, holdTimeMs);

    return () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    };
  }, [isPlaying, state, currentBeat, handleNext]);

  // Handle interactive submissions
  const handleInteraction = useCallback(
    async (answer: unknown) => {
      if (!currentBeat) return;
      const beatId = currentBeat.id;
      const type = currentBeat.interactive?.type ?? "none";
      const isCorrect =
        type === "quiz" ? currentBeat.interactive?.correctAnswer === answer : true;

      const resultPayload: BarkleyInteractionResult = {
        beatId,
        interactionType: type,
        correct: isCorrect,
        timestamp: Date.now(),
      };

      setInteractions((prev) => [...prev, resultPayload]);

      if (sessionId) {
        submitInteraction(sessionId, beatId, answer, type).catch(() => {});
      }

      // Auto-advance shortly after quiz interaction
      if (type === "quiz") {
        setTimeout(() => handleNext(), 2200);
      }
    },
    [sessionId, currentBeat, handleNext]
  );

  const handleTogglePlay = useCallback(() => {
    setIsPlaying((prev) => !prev);
  }, []);

  const handleRestart = useCallback(() => {
    const show = showData || CANONICAL_SHOW;
    setBeatIndex(0);
    setProgress(1 / show.beats.length);
    setState("playing");
    setIsPlaying(true);
    setInteractions([]);
    if (show.beats[0]) {
      setCurrentBeat(show.beats[0]);
      setCameraFrame(show.beats[0].camera);
    }
  }, [showData]);

  const handleNavigate = useCallback(
    (_screen: string) => {
      onClose();
    },
    [onClose]
  );

  // Global Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }

      switch (e.key) {
        case "ArrowRight":
          e.preventDefault();
          handleNext();
          break;
        case "ArrowLeft":
          e.preventDefault();
          handlePrev();
          break;
        case " ":
          e.preventDefault();
          handleTogglePlay();
          break;
        case "m":
        case "M":
          setSoundMuted((prev) => !prev);
          break;
        case "r":
        case "R":
          if (state === "complete") handleRestart();
          break;
        case "Escape":
          onClose();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNext, handlePrev, handleTogglePlay, handleRestart, onClose, state]);

  // Clean up session on unmount
  useEffect(() => {
    return () => {
      if (sessionId) endSession(sessionId);
      if (autoTimer.current) clearTimeout(autoTimer.current);
    };
  }, [sessionId]);

  const activeShow = showData || CANONICAL_SHOW;
  const totalBeats = activeShow.beats.length;

  // ── Loading state ────────────────────────────────────────────────
  if (state === "loading") {
    return (
      <div className="w-full flex-1 flex flex-col items-center justify-center p-8 bg-surface text-on-surface min-h-[calc(100dvh-4rem)]">
        <div className="glass-hero p-8 rounded-3xl text-center max-w-sm w-full border border-primary/20 soft-glow-shadow">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 dark:bg-primary/20 flex items-center justify-center mx-auto mb-4 text-primary text-3xl animate-bounce">
            🐾
          </div>
          <h2 className="text-lg font-black text-on-surface mb-1">
            Setting up Barkley's Studio
          </h2>
          <p className="text-xs text-on-surface-variant mb-5">
            Loading 3D stage and animation choreographies…
          </p>
          <div className="w-full h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full animate-pulse w-2/3" />
          </div>
        </div>
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────
  if (state === "error") {
    return (
      <div className="w-full flex-1 flex flex-col items-center justify-center p-6 bg-surface text-on-surface min-h-[calc(100dvh-4rem)]">
        <div className="glass-hero p-8 rounded-3xl text-center max-w-md w-full border border-outline-variant/40 shadow-xl">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4 text-primary text-3xl">
            🐾
          </div>
          <h2 className="text-xl font-black text-on-surface mb-2">
            Barkley is Warming Up
          </h2>
          <p className="text-sm text-on-surface-variant mb-6 leading-relaxed">
            {status && !status.clips.allReady
              ? `Barkley is putting the final touches on ${status.clips.total - status.clips.ready} animation clips.`
              : "Barkley's presenter studio is undergoing maintenance. You can explore our ready-to-print models in the meantime."}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              type="button"
              onClick={onClose}
              className="rounded-2xl bg-primary px-6 py-3 text-sm font-black text-on-primary tactile-button shadow-md hover:brightness-105 transition-all"
            >
              Explore Models
            </button>
            <button
              type="button"
              onClick={() => {
                setState("playing");
                setShowData(CANONICAL_SHOW);
                setCurrentBeat(CANONICAL_SHOW.beats[0]);
              }}
              className="glass-button rounded-2xl px-6 py-3 text-sm font-bold text-on-surface hover:text-primary transition-all"
            >
              Preview Stage Anyway
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main Presenter Stage ─────────────────────────────────────────
  return (
    <div className="w-full relative flex flex-col items-center justify-between min-h-[calc(100dvh-4rem)] bg-surface text-on-surface transition-colors duration-300 overflow-hidden select-none">
      {/* Semantic Crawlable Headings for SEO */}
      <header className="sr-only">
        <h1>Meet Barkley: 3D Pet Model Studio Tour &amp; Interactive Learning</h1>
        <p>
          Learn how Pawsome3D transforms 2D pet photos into precision 3D GLB models and 3D-printed keepsakes through multi-view photogrammetry, animation layering, and triple-check quality validation.
        </p>
      </header>

      {/* Background ambient lighting glows */}
      <div className="pointer-events-none absolute -left-20 -top-20 h-72 w-72 rounded-full bg-primary/10 dark:bg-primary/20 blur-[100px]" />
      <div className="pointer-events-none absolute -bottom-20 -right-20 h-80 w-80 rounded-full bg-secondary/10 dark:bg-secondary/20 blur-[120px]" />

      {/* ── TOP HUD BAR ─────────────────────────────────────────── */}
      <div className="w-full max-w-6xl z-20 px-4 sm:px-6 pt-3 sm:pt-4 flex items-start justify-between gap-4 pointer-events-none">
        {/* Left: Brand Badge & Beat Title */}
        <div className="flex items-start gap-3 pointer-events-auto">
          <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-2xl bg-primary text-on-primary flex items-center justify-center shadow-md shrink-0">
            <span className="text-lg">🐾</span>
          </div>
          <div className="glass-card rounded-2xl px-3.5 py-2 sm:px-4 sm:py-2.5 border border-outline-variant/30 shadow-md">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-wider text-primary">
                Stage {beatIndex + 1}/{totalBeats}
              </span>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[10px] font-bold text-on-surface-variant">Live</span>
            </div>
            <h2 className="text-xs sm:text-sm font-black text-on-surface tracking-tight truncate max-w-[180px] sm:max-w-xs md:max-w-sm mt-0.5">
              {currentBeat?.title ?? "Welcome to Pawsome3D"}
            </h2>
          </div>
        </div>

        {/* Right: EduCard (Desktop) & Top Controls */}
        <div className="flex items-start gap-2.5 pointer-events-auto">
          {/* Desktop Educational Callout */}
          {currentBeat?.edu && (
            <div className="hidden md:block">
              <EduCard edu={currentBeat.edu} />
            </div>
          )}

          {/* Sound Mute Toggle */}
          <button
            type="button"
            onClick={() => setSoundMuted(!soundMuted)}
            title={soundMuted ? "Unmute Sound (M)" : "Mute Sound (M)"}
            aria-label={soundMuted ? "Unmute sound" : "Mute sound"}
            className="w-10 h-10 sm:w-11 sm:h-11 rounded-2xl glass-button flex items-center justify-center text-on-surface hover:text-primary transition-all shadow-sm focus-visible:ring-2 focus-visible:ring-primary"
          >
            {soundMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>

          {/* Close / Exit Button */}
          <button
            type="button"
            onClick={onClose}
            title="Exit Studio Tour (Esc)"
            aria-label="Exit Studio Tour"
            className="w-10 h-10 sm:w-11 sm:h-11 rounded-2xl glass-button flex items-center justify-center text-on-surface hover:text-primary transition-all shadow-sm focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Mobile Educational Tip (collapsible pill banner) */}
      {currentBeat?.edu && (
        <div className="md:hidden w-full max-w-md px-4 pt-2 z-20 pointer-events-auto">
          <EduCard edu={currentBeat.edu} />
        </div>
      )}

      {/* ── 3D CANVAS STAGE ─────────────────────────────────────── */}
      <div className="absolute inset-0 z-0 flex items-center justify-center">
        <Canvas
          shadows
          camera={{
            position: cameraFrame.position,
            fov: cameraFrame.fov,
            near: 0.1,
            far: 100,
          }}
          gl={{ antialias: true, alpha: true }}
          dpr={[1, 2]}
        >
          <BarkleyCamera
            cameraFrame={cameraFrame}
            isTransitioning={isTransitioning}
            reducedMotion={reducedMotion}
          />

          <BarkleyCharacter
            clip={currentBeat?.clip ?? "idle"}
            state={state}
            isDark={isDark}
          />

          <BarkleyStage isDark={isDark} />

          <Environment preset="studio" />

          <ContactShadows
            resolution={512}
            scale={5}
            blur={2}
            opacity={isDark ? 0.6 : 0.4}
            far={4}
            color={isDark ? "#000000" : "#442a22"}
          />

          {/* Orbit Controls (Enabled when tour is paused or for gentle exploration) */}
          <OrbitControls
            enabled={!isPlaying}
            target={cameraFrame.target}
            minPolarAngle={Math.PI * 0.22}
            maxPolarAngle={Math.PI * 0.52}
            minDistance={1.8}
            maxDistance={5.5}
            enableDamping
            dampingFactor={0.08}
          />
        </Canvas>
      </div>

      {/* OrbitControls helper hint when paused */}
      {!isPlaying && state === "playing" && (
        <div className="z-10 mb-2 pointer-events-none">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-container-high/80 backdrop-blur-md text-[11px] font-bold text-on-surface-variant border border-outline-variant/30 shadow-sm">
            <Compass size={13} className="text-primary" /> Drag to inspect 3D model
          </span>
        </div>
      )}

      {/* ── INTERACTIVE OVERLAYS & CAPTIONS (Z-20) ────────────────── */}
      <div className="w-full z-20 flex flex-col items-center justify-end gap-3 pb-2">
        {/* Interactive checkpoint overlay (if active on current beat) */}
        {currentBeat?.interactive && currentBeat.interactive.type !== "none" && (
          <QuizOverlay
            interaction={currentBeat.interactive}
            onSubmit={handleInteraction}
            beatId={currentBeat.id}
          />
        )}

        {/* Spoken subtitle card (hidden when quiz is displayed to avoid clutter) */}
        {(!currentBeat?.interactive || currentBeat.interactive.type === "none") && (
          <DialogueSubtitle
            dialogue={currentBeat?.dialogue}
            beatTitle={currentBeat?.title}
          />
        )}

        {/* Bottom Navigation & Progress Dock */}
        <BottomControlDock
          progress={progress}
          beatIndex={beatIndex}
          totalBeats={totalBeats}
          onPrev={handlePrev}
          onNext={handleNext}
          isPlaying={isPlaying}
          onTogglePlay={handleTogglePlay}
          onSelectBeat={handleSelectBeat}
        />
      </div>

      {/* ── COMPLETION MODAL ────────────────────────────────────── */}
      {state === "complete" && (
        <CompletionScreen
          onRestart={handleRestart}
          onNavigate={handleNavigate}
          quizScore={{
            correct: interactions.filter((i) => i.correct).length,
            total: interactions.length,
          }}
        />
      )}
    </div>
  );
}
