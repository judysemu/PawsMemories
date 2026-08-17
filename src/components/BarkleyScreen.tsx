/**
 * Barkley Presenter — 3D interactive stage component.
 *
 * Renders Barkley (biped presenter) on a production-quality 3D stage with:
 * - Smooth camera choreography per beat
 * - Lip-sync driven dialogue
 * - Interactive quiz and reveal overlays
 * - Progress bar and beat navigation
 * - Educational callout cards
 *
 * Asset blocker: 30 rendered biped clips in public/barkley/*.glb
 * Falls back to a placeholder figure when clips are not yet available.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense } from "react";
import * as THREE from "three";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Environment, ContactShadows, useGLTF, Center } from "@react-three/drei";
import {
  Play, Pause, SkipForward, SkipBack, Volume2, VolumeX, RefreshCw,
  MessageCircle, Sparkles, ChevronRight, ChevronLeft, Award, Lightbulb,
  Mic, GraduationCap, X
} from "lucide-react";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { ANIMATOR_DEFAULTS } from "../animator/defaults";
import {
  fetchBarkleyShow,
  createBarkleySession,
  advanceBeat,
  submitInteraction,
  endSession,
  fetchBarkleyStatus,
} from "../barkley/api";
import type {
  BarkleyBeat, BarkleyShow, BarkleyState, BarkleyCameraFrame,
  BarkleyInteraction, BarkleyInteractionType, BarkleyEduMeta,
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
 * Barkley character — loads the biped model and plays animation clips.
 * Falls back to a styled placeholder when the model is not yet available.
 */
function BarkleyCharacter({
  clip,
  state,
}: {
  clip: string;
  state: BarkleyState;
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

      // Fade out previous
      if (actionRef.current) {
        actionRef.current.fadeOut(0.3);
      }

      // Play new clip
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
        if (groupRef.current) {
          groupRef.current.add(cloned);
        }

        // Build animation clip map
        const clipMap = new Map<string, THREE.AnimationClip>();
        for (const clipData of gltf.animations) {
          clipMap.set(clipData.name, clipData);
        }
        clipMapRef.current = clipMap;

        // Create animation mixer
        mixerRef.current = new THREE.AnimationMixer(cloned);

        setLoaded(true);
        playClip(clip);
      },
      undefined,
      () => {
        // Model not found — placeholder mode
        setLoaded(false);
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

  // Update mixer each frame
  useFrame((_state, delta) => {
    mixerRef.current?.update(delta);
  });

  if (loaded) return <group ref={groupRef} />;

  // ── Placeholder figure (rendered until clips arrive) ───────────
  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      {/* Body */}
      <mesh castShadow position={[0, 1.0, 0]}>
        <capsuleGeometry args={[0.15, 0.6, 8, 16]} />
        <meshStandardMaterial
          color="#6B8F71"
          roughness={0.6}
          metalness={0.1}
        />
      </mesh>
      {/* Head */}
      <mesh castShadow position={[0, 1.5, 0]}>
        <sphereGeometry args={[0.18, 16, 16]} />
        <meshStandardMaterial
          color="#7DA57B"
          roughness={0.5}
          metalness={0.1}
        />
      </mesh>
      {/* Left arm */}
      <mesh castShadow position={[-0.22, 1.05, 0]}>
        <capsuleGeometry args={[0.06, 0.35, 6, 8]} />
        <meshStandardMaterial color="#6B8F71" roughness={0.6} />
      </mesh>
      {/* Right arm */}
      <mesh castShadow position={[0.22, 1.05, 0]}>
        <capsuleGeometry args={[0.06, 0.35, 6, 8]} />
        <meshStandardMaterial color="#6B8F71" roughness={0.6} />
      </mesh>
      {/* Left leg */}
      <mesh castShadow position={[-0.1, 0.3, 0]}>
        <capsuleGeometry args={[0.07, 0.4, 6, 8]} />
        <meshStandardMaterial color="#5A7A5E" roughness={0.7} />
      </mesh>
      {/* Right leg */}
      <mesh castShadow position={[0.1, 0.3, 0]}>
        <capsuleGeometry args={[0.07, 0.4, 6, 8]} />
        <meshStandardMaterial color="#5A7A5E" roughness={0.7} />
      </mesh>
      {/* Eyes */}
      <mesh position={[-0.07, 1.53, 0.14]}>
        <sphereGeometry args={[0.025, 8, 8]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.3} />
      </mesh>
      <mesh position={[0.07, 1.53, 0.14]}>
        <sphereGeometry args={[0.025, 8, 8]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.3} />
      </mesh>
      {/* Nose */}
      <mesh position={[0, 1.48, 0.17]}>
        <sphereGeometry args={[0.03, 8, 8]} />
        <meshStandardMaterial color="#2D2D2D" roughness={0.4} />
      </mesh>
      {/* Label */}
      <BillboardText text="🐾 Barkley" position={[0, 1.85, 0]} color="#e8e0d4" size={0.25} />
    </group>
  );
}

/**
 * Billboard text that always faces the camera.
 */
function BillboardText({
  text, position, color, size,
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
  return (
    <group ref={ref} position={position}>
      {/* Using sprite for billboard effect */}
      <sprite position={[0, 0, 0]}>
        <spriteMaterial
          attach="material"
          map={useMemo(() => {
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            canvas.width = 512;
            canvas.height = 128;
            ctx.clearRect(0, 0, 512, 128);
            ctx.font = "bold 52px system-ui, -apple-system, sans-serif";
            ctx.textAlign = "center";
            ctx.fillStyle = color || "#ffffff";
            ctx.fillText(text, 256, 80);
            const tex = new THREE.CanvasTexture(canvas);
            tex.needsUpdate = true;
            return tex;
          }, [text, color])}
          transparent
          depthWrite={false}
        />
      </sprite>
    </group>
  );
}

/**
 * Camera rig that smoothly transitions between beat camera positions.
 */
function BarkleyCamera({
  cameraFrame,
  isTransitioning,
}: {
  cameraFrame: BarkleyCameraFrame;
  isTransitioning: boolean;
}) {
  const { camera } = useThree();
  const prevPos = useRef(new THREE.Vector3(...cameraFrame.position));
  const targetPos = useRef(new THREE.Vector3(...cameraFrame.position));
  const prevTarget = useRef(new THREE.Vector3(...cameraFrame.target));
  const targetTarget = useRef(new THREE.Vector3(...cameraFrame.target));
  const transitionStart = useRef<number | null>(null);
  const transitionDuration = useRef(cameraFrame.transitionSeconds ?? 0.8);

  // Update target when camera frame changes
  useEffect(() => {
    targetPos.current.set(...cameraFrame.position);
    targetTarget.current.set(...cameraFrame.target);
    transitionDuration.current = cameraFrame.transitionSeconds ?? 0.8;
    if (cameraFrame.position[0] !== prevPos.current.x ||
        cameraFrame.position[1] !== prevPos.current.y ||
        cameraFrame.position[2] !== prevPos.current.z) {
      transitionStart.current = performance.now();
    }
  }, [cameraFrame]);

  useFrame(() => {
    // Set FOV
    if ((camera as THREE.PerspectiveCamera).fov !== cameraFrame.fov) {
      (camera as THREE.PerspectiveCamera).fov = cameraFrame.fov;
      camera.updateProjectionMatrix();
    }

    // Smooth camera transition
    if (transitionStart.current !== null) {
      const elapsed = (performance.now() - transitionStart.current) / 1000;
      const t = Math.min(elapsed / transitionDuration.current, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - t, 3);

      camera.position.lerpVectors(prevPos.current, targetPos.current, eased);
      // We need to track camera's look target — OrbitControls handles this
      // For simplicity, we use lookAt on a moving target
    } else {
      camera.position.set(...cameraFrame.position);
    }

    // Keep camera looking at target
    if (!isTransitioning) {
      camera.lookAt(...cameraFrame.target);
    }
  });

  return null;
}

/**
 * Stage floor with subtle grid and spotlight.
 */
function BarkleyStage() {
  return (
    <>
      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <circleGeometry args={[3, 64]} />
        <meshStandardMaterial
          color="#1a1a2e"
          roughness={0.85}
          metalness={0.1}
        />
      </mesh>
      {/* Subtle ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <ringGeometry args={[1.2, 1.25, 64]} />
        <meshStandardMaterial
          color="#3D5A80"
          emissive="#3D5A80"
          emissiveIntensity={0.3}
          roughness={0.5}
        />
      </mesh>
      {/* Grid overlay */}
      <gridHelper args={[6, 12, "#2a2a3e", "#1e1e30"]} position={[0, 0.01, 0]} />
      {/* Spotlight on Barkley */}
      <spotLight
        position={[0, 5, 2]}
        angle={0.3}
        penumbra={0.8}
        intensity={2}
        castShadow
        color="#f0e6d3"
      />
      {/* Fill light */}
      <pointLight position={[-2, 3, 1]} intensity={0.5} color="#8aa0b5" />
      {/* Rim light */}
      <pointLight position={[2, 2, -1]} intensity={0.3} color="#e8a87c" />
      {/* Ambient */}
      <ambientLight intensity={0.25} />
      {/* Fog for depth */}
      <fogExp2 attach="fog" color="#0d0d1a" density={0.06} />
    </>
  );
}

// ──────────────────────────────────────────────────────────────────
// UI Overlay Components
// ──────────────────────────────────────────────────────────────────

/**
 * Dialogue subtitle display — cinematic subtitle treatment.
 */
function DialogueSubtitle({ dialogue }: { dialogue?: string }) {
  if (!dialogue) return null;
  return (
    <div className="absolute bottom-32 left-1/2 -translate-x-1/2 w-full max-w-2xl px-8 pointer-events-none">
      <div className="bg-black/60 backdrop-blur-sm rounded-xl px-6 py-4 border border-white/10">
        <p className="text-white/95 text-base md:text-lg leading-relaxed text-center font-light tracking-wide">
          {dialogue}
        </p>
      </div>
    </div>
  );
}

/**
 * Educational callout card — appears beside the dialogue.
 */
function EduCard({ edu }: { edu?: BarkleyEduMeta }) {
  const [show, setShow] = useState(false);
  if (!edu) return null;

  return (
    <div className="absolute top-24 right-4 md:right-8 w-72 pointer-events-auto">
      <button
        onClick={() => setShow(!show)}
        className="w-full flex items-center gap-2 bg-gradient-to-r from-amber-500/20 to-orange-500/20 backdrop-blur-sm rounded-lg px-4 py-2.5 border border-amber-500/30 text-amber-200 hover:from-amber-500/30 hover:to-orange-500/30 transition-all duration-300"
      >
        <Lightbulb size={16} />
        <span className="text-sm font-medium">{edu.level === "beginner" ? "💡 Key Takeaway" : edu.level === "intermediate" ? "📚 Learn More" : "🔬 Advanced"}</span>
      </button>
      {show && (
        <div className="mt-2 bg-black/80 backdrop-blur-md rounded-lg px-4 py-3 border border-amber-500/20">
          <p className="text-amber-100/90 text-sm leading-relaxed">{edu.takeaway}</p>
          {edu.resourceUrl && (
            <a href={edu.resourceUrl} target="_blank" rel="noopener noreferrer" className="text-amber-400 text-xs mt-2 inline-block hover:underline">
              Learn more →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Interactive quiz overlay.
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
  const [timeout, setTimeoutState] = useState(false);

  // Generate quiz options from the beat context
  const quizOptions = useMemo(() => {
    // Default quiz options based on the prompt
    const prompt = interaction.prompt;
    if (prompt.includes("angle")) {
      return [
        "To save storage space",
        "To capture depth and 3D shape",
        "To make the photo look artistic",
        "To reduce processing time",
      ];
    }
    if (prompt.includes("layer") || prompt.includes("tail")) {
      return [
        "L0 — Base locomotion layer",
        "L1 — Overlay gesture layer",
        "L2 — Reactive emote layer",
        "They happen simultaneously",
      ];
    }
    if (prompt.includes("L0")) {
      return [
        "Locomotion and poses (walk, sit, lie)",
        "Overlay gestures (tail wag, head tilt)",
        "Reactive emotes (bark, growl)",
        "Camera movements",
      ];
    }
    return [
      "Option A",
      "Option B",
      "Option C",
      "Option D",
    ];
  }, [interaction.prompt]);

  // Timeout
  useEffect(() => {
    if (submitted || timeout) return;
    const timer = setTimeout(() => {
      setTimeoutState(true);
      onSubmit(interaction.correctAnswer ?? 1);
      setCorrect(true);
    }, QUIZ_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [submitted, timeout]);

  const handleSelect = (index: number) => {
    if (submitted) return;
    setSelected(index);
    const isCorrect = index === (interaction.correctAnswer ?? 1);
    setSubmitted(true);
    setCorrect(isCorrect);
    onSubmit(index);
  };

  if (interaction.type === "reveal") {
    return (
      <div className="absolute bottom-32 left-1/2 -translate-x-1/2 pointer-events-auto">
        <button
          onClick={() => onSubmit(null)}
          className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white px-6 py-3 rounded-xl font-medium shadow-lg shadow-blue-500/25 transition-all duration-300 flex items-center gap-2"
        >
          <Sparkles size={18} />
          {interaction.prompt}
        </button>
      </div>
    );
  }

  if (interaction.type === "click-hotspot") {
    return (
      <div className="absolute bottom-32 left-1/2 -translate-x-1/2 pointer-events-auto">
        <button
          onClick={() => onSubmit(null)}
          className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white px-6 py-3 rounded-xl font-medium shadow-lg shadow-emerald-500/25 transition-all duration-300 flex items-center gap-2"
        >
          <MessageCircle size={18} />
          {interaction.prompt}
        </button>
      </div>
    );
  }

  // Quiz type
  return (
    <div className="absolute bottom-32 left-1/2 -translate-x-1/2 w-full max-w-lg px-4 pointer-events-auto">
      <div className="bg-black/80 backdrop-blur-md rounded-2xl p-6 border border-white/10 shadow-2xl">
        <div className="flex items-center gap-2 mb-4">
          <GraduationCap size={20} className="text-amber-400" />
          <h3 className="text-white font-semibold text-lg">{interaction.prompt}</h3>
        </div>
        <div className="space-y-2">
          {quizOptions.map((option, index) => {
            let bgClass = "bg-white/5 border-white/10 hover:bg-white/10";
            if (submitted) {
              if (index === (interaction.correctAnswer ?? 1)) {
                bgClass = "bg-emerald-500/20 border-emerald-500/50";
              } else if (index === selected && !correct) {
                bgClass = "bg-red-500/20 border-red-500/50";
              }
            }
            return (
              <button
                key={index}
                onClick={() => handleSelect(index)}
                disabled={submitted}
                className={`w-full text-left px-4 py-3 rounded-xl border transition-all duration-300 text-white/90 text-sm ${bgClass}`}
              >
                <span className="flex items-center gap-3">
                  <span className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-xs font-medium shrink-0">
                    {String.fromCharCode(65 + index)}
                  </span>
                  {option}
                </span>
              </button>
            );
          })}
        </div>
        {submitted && (
          <div className={`mt-4 p-3 rounded-lg text-center text-sm font-medium ${correct ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"}`}>
            {correct ? "🎉 Correct! Barkley is impressed!" : "🤔 Not quite — the right answer is highlighted above."}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Progress bar and beat counter.
 */
function ProgressBar({
  progress,
  beatIndex,
  totalBeats,
  onPrev,
  onNext,
  isPlaying,
  onTogglePlay,
}: {
  progress: number;
  beatIndex: number;
  totalBeats: number;
  onPrev: () => void;
  onNext: () => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
}) {
  return (
    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent pt-12 pb-4 px-4 md:px-8">
      {/* Beat counter */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-white/60 text-xs font-medium">
            Beat {beatIndex + 1} of {totalBeats}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onPrev}
            disabled={beatIndex === 0}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed text-white transition-all"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            onClick={onTogglePlay}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-all"
          >
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button
            onClick={onNext}
            disabled={beatIndex >= totalBeats - 1}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed text-white transition-all"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      {/* Progress bar */}
      <div className="h-1 bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-amber-400 to-orange-400 rounded-full transition-all duration-500 ease-out"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      {/* Beat markers */}
      <div className="flex justify-between mt-2">
        {Array.from({ length: totalBeats }, (_, i) => (
          <div
            key={i}
            className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
              i <= beatIndex ? "bg-amber-400" : "bg-white/20"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Beat title header.
 */
function BeatHeader({ beat }: { beat: BarkleyBeat | null }) {
  if (!beat) return null;
  return (
    <div className="absolute top-4 left-4 right-4 md:left-8 md:right-8">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-lg shadow-amber-500/20 shrink-0">
          <span className="text-lg">🐾</span>
        </div>
        <div>
          <h2 className="text-white font-semibold text-lg md:text-xl tracking-tight">
            {beat.title}
          </h2>
          <p className="text-white/60 text-sm mt-0.5">{beat.description}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * Completion screen.
 */
function CompletionScreen({
  onRestart,
  onNavigate,
}: {
  onRestart: () => void;
  onNavigate: (screen: string) => void;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm z-50">
      <div className="text-center max-w-md mx-4">
        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center mx-auto mb-6 shadow-2xl shadow-amber-500/30">
          <Award size={40} className="text-white" />
        </div>
        <h2 className="text-white text-3xl font-bold mb-2">Welcome to Pawsome3D!</h2>
        <p className="text-white/70 text-base mb-8 leading-relaxed">
          You've completed Barkley's introduction. You now understand the spatial pipeline,
          animation layers, and quality review process. Ready to create?
        </p>
        <div className="flex flex-col gap-3">
          <button
            onClick={() => onNavigate("create")}
            className="w-full bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-white font-semibold py-3.5 rounded-xl shadow-lg shadow-amber-500/25 transition-all duration-300"
          >
            Start Creating →
          </button>
          <button
            onClick={onRestart}
            className="w-full bg-white/10 hover:bg-white/15 text-white font-medium py-3 rounded-xl transition-all duration-300 flex items-center justify-center gap-2"
          >
            <RefreshCw size={16} />
            Replay Introduction
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Main Component
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
  const [interactions, setInteractions] = useState<any[]>([]);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [cameraFrame, setCameraFrame] = useState<BarkleyCameraFrame>({
    position: [0, 1.4, 3.5],
    target: [0, 1.0, 0],
    fov: 42,
  });
  const [soundMuted, setSoundMuted] = useState(true);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch status and show data
  useEffect(() => {
    let cancelled = false;
    async function init() {
      const st = await fetchBarkleyStatus();
      if (cancelled) return;
      if (!st || !st.enabled || !st.clips.allReady) {
        setStatus(st || { enabled: false, clips: { total: 30, ready: 0, missing: [], allReady: false }, show: { id: "", name: "", beatCount: 0 } });
        setState("error");
        return;
      }
      setStatus(st);

      const show = await fetchBarkleyShow();
      if (cancelled) return;
      if (!show) {
        setState("error");
        return;
      }
      setShowData(show.show);

      const session = await createBarkleySession();
      if (cancelled) return;
      if (!session) {
        setState("error");
        return;
      }
      setSessionId(session.sessionId);

      // Start with first beat
      const firstBeat = show.show.beats[0];
      if (firstBeat) {
        setCurrentBeat(firstBeat);
        setCameraFrame(firstBeat.camera);
        setState("playing");
        setIsPlaying(true);
      }
    }
    init();
    return () => { cancelled = true; };
  }, []);

  // Auto-advance timer
  useEffect(() => {
    if (autoTimer.current) clearTimeout(autoTimer.current);
    if (!isPlaying || state !== "playing" || !currentBeat || currentBeat.interactive?.type === "quiz") return;

    autoTimer.current = setTimeout(() => {
      handleNext();
    }, (currentBeat.durationSeconds - AUTO_ADVANCE_BUFFER_MS / 1000) * 1000);

    return () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    };
  }, [isPlaying, state, currentBeat]);

  const handleNext = useCallback(async () => {
    if (!sessionId) return;
    setIsTransitioning(true);
    const result = await advanceBeat(sessionId);
    if (!result) return;

    if (result.beat) {
      setCurrentBeat(result.beat);
      setBeatIndex(result.beatIndex);
      setProgress(result.progress);
      setState(result.state);
      setCameraFrame(result.beat.camera);
    } else {
      setState("complete");
      setProgress(1);
    }
    setTimeout(() => setIsTransitioning(false), BEAT_TRANSITION_MS);
  }, [sessionId]);

  const handlePrev = useCallback(async () => {
    if (!sessionId || beatIndex <= 0) return;
    setIsTransitioning(true);
    // Replay the previous beat
    const show = showData;
    if (show && show.beats[beatIndex - 1]) {
      const prevBeat = show.beats[beatIndex - 1];
      setCurrentBeat(prevBeat);
      setBeatIndex(beatIndex - 1);
      setProgress(beatIndex / show.beats.length);
      setCameraFrame(prevBeat.camera);
      setState("playing");
    }
    setTimeout(() => setIsTransitioning(false), BEAT_TRANSITION_MS);
  }, [sessionId, beatIndex, showData]);

  const handleInteraction = useCallback(async (answer: unknown) => {
    if (!sessionId || !currentBeat) return;
    const result = await submitInteraction(
      sessionId,
      currentBeat.id,
      answer,
      currentBeat.interactive?.type ?? "none"
    );
    if (result) {
      setInteractions((prev) => [...prev, result.interactionResult]);
      // Auto-advance after quiz interaction
      if (currentBeat.interactive?.type === "quiz") {
        setTimeout(() => handleNext(), 2000);
      }
    }
  }, [sessionId, currentBeat, handleNext]);

  const handleTogglePlay = useCallback(() => {
    setIsPlaying((prev) => !prev);
  }, []);

  const handleRestart = useCallback(() => {
    setBeatIndex(0);
    setProgress(0);
    setState("playing");
    setIsPlaying(true);
    if (showData?.beats[0]) {
      setCurrentBeat(showData.beats[0]);
      setCameraFrame(showData.beats[0].camera);
    }
  }, [showData]);

  const handleNavigate = useCallback((screen: string) => {
    onClose();
    // Navigation handled by parent
  }, [onClose]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (sessionId) endSession(sessionId);
      if (autoTimer.current) clearTimeout(autoTimer.current);
    };
  }, [sessionId]);

  // ── Error / loading states ───────────────────────────────────────
  if (state === "error") {
    return (
      <div className="fixed inset-0 bg-gradient-to-b from-[#0d0d1a] to-[#1a1a2e] flex items-center justify-center z-50">
        <div className="text-center max-w-md mx-4 px-4">
          <div className="w-20 h-20 rounded-full bg-white/10 flex items-center justify-center mx-auto mb-6">
            <span className="text-4xl">🐾</span>
          </div>
          <h2 className="text-white text-2xl font-bold mb-3">Barkley is Getting Ready</h2>
          {status && !status.clips.allReady ? (
            <>
              <p className="text-white/60 mb-4">
                Barkley needs {30 - status.clips.ready} more animation clips to come to life.
                {status.clips.missing.length > 0 && (
                  <span className="block mt-2 text-xs text-white/40">
                    Missing: {status.clips.missing.slice(0, 5).join(", ")}...
                  </span>
                )}
              </p>
            </>
          ) : (
            <p className="text-white/60 mb-4">
              Barkley's feature is currently disabled. Check back soon!
            </p>
          )}
          <button
            onClick={onClose}
            className="bg-white/10 hover:bg-white/15 text-white px-6 py-3 rounded-xl transition-all"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <div className="fixed inset-0 bg-gradient-to-b from-[#0d0d1a] to-[#1a1a2e] flex items-center justify-center z-50">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin mx-auto mb-4" />
          <p className="text-white/60 text-sm">Loading Barkley...</p>
        </div>
      </div>
    );
  }

  // ── Main render ──────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-gradient-to-b from-[#0d0d1a] to-[#1a1a2e] z-50">
      {/* 3D Canvas */}
      <Canvas
        shadows
        camera={{ position: cameraFrame.position, fov: cameraFrame.fov, near: 0.1, far: 100 }}
        gl={{ antialias: true, alpha: false }}
        dpr={[1, 2]}
      >
        {/* Background color */}
        <color attach="background" args={["#0d0d1a"]} />

        <BarkleyCamera cameraFrame={cameraFrame} isTransitioning={isTransitioning} />

        <BarkleyCharacter clip={currentBeat?.clip ?? "idle"} state={state} />

        <BarkleyStage />

        <Environment preset="studio" />

        <ContactShadows resolution={512} scale={6} blur={2.5} opacity={0.4} far={5} />

        {/* Limited orbit for manual exploration */}
        <OrbitControls
          enabled={!isPlaying}
          target={cameraFrame.target}
          minPolarAngle={Math.PI * 0.25}
          maxPolarAngle={Math.PI * 0.55}
          minDistance={2}
          maxDistance={6}
          enableDamping
          dampingFactor={0.08}
        />
      </Canvas>

      {/* ── UI Overlays ─────────────────────────────────────────── */}
      {currentBeat && (
        <>
          <BeatHeader beat={currentBeat} />
          <DialogueSubtitle dialogue={currentBeat.dialogue} />
          <EduCard edu={currentBeat.edu} />

          {currentBeat.interactive && currentBeat.interactive.type !== "none" && (
            <QuizOverlay
              interaction={currentBeat.interactive}
              onSubmit={handleInteraction}
              beatId={currentBeat.id}
            />
          )}
        </>
      )}

      {/* Progress & controls */}
      {showData && (
        <ProgressBar
          progress={progress}
          beatIndex={beatIndex}
          totalBeats={showData.beats.length}
          onPrev={handlePrev}
          onNext={handleNext}
          isPlaying={isPlaying}
          onTogglePlay={handleTogglePlay}
        />
      )}

      {/* Sound toggle */}
      <button
        onClick={() => setSoundMuted(!soundMuted)}
        className="absolute top-4 right-4 md:right-8 p-2.5 rounded-lg bg-white/10 hover:bg-white/15 text-white transition-all z-10"
      >
        {soundMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
      </button>

      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-14 md:right-20 p-2.5 rounded-lg bg-white/10 hover:bg-white/15 text-white transition-all z-10"
      >
        <X size={18} />
      </button>

      {/* Completion screen */}
      {state === "complete" && (
        <CompletionScreen onRestart={handleRestart} onNavigate={handleNavigate} />
      )}

      {/* Summary badge */}
      {interactions.length > 0 && state !== "complete" && (
        <div className="absolute top-24 left-4 md:left-8 pointer-events-none">
          <div className="flex items-center gap-1.5 bg-emerald-500/20 backdrop-blur-sm rounded-lg px-3 py-1.5 border border-emerald-500/30">
            <Award size={14} className="text-emerald-400" />
            <span className="text-emerald-300 text-xs font-medium">
              {interactions.filter((i) => i.correct).length}/{interactions.length} correct
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
