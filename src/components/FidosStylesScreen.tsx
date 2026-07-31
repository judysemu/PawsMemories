import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Bounds, ContactShadows, Environment, Html, OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { UserProfile, Avatar, PublicUser } from "../types";
import {
  Layers, Shirt, Palette, SunMedium, Grid3X3, Mic, Download,
  Sparkles, Brush, Upload, CheckCircle2, X, ZoomIn, RotateCw,
  RotateCcw, Maximize2, Save, RefreshCw, ChevronDown, Star,
  PawPrint, Gift
} from "lucide-react";
import { authedFetch, createVoiceCloneAsset, fetchAvatars, createTextureJob, rebakeTextureJob, getTextureJob, type TextureJobStatus } from "../api";
import { AnimatorErrorBoundary } from "../animator/components/AnimatorErrorBoundary";
import { CREDIT_PRICES } from "../pricing";
import { FULL_WARDROBE_CATALOG, WARDROBE_CATALOG, WAGS_EXCLUSIVE_CATALOG } from "../wardrobe/catalog";
import { WardrobeLayer } from "../wardrobe/WardrobeLayer";

/**
 * Client mirror of the server's TEXTURE_STYLIZE_ENABLED gate.
 *
 * Kept as a build-time constant rather than fetched: the server is the
 * authority (it returns 503 regardless), so this only decides whether we render
 * a form the user cannot submit. Both default off and must be flipped together
 * when UV3/UV4 land — see UV_TEXTURE_COMPLETION_PLAN.md.
 */
const COAT_STYLIZE_AVAILABLE =
  String(import.meta.env.VITE_TEXTURE_STYLIZE_ENABLED || "").toLowerCase() === "true";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FidosStylesScreenProps {
  userProfile: UserProfile;
  onGoToPawprints?: () => void;
  onUserUpdate?: (user: PublicUser) => void;
}

type LightMode = "warm" | "neutral" | "bright";
type ActiveTool = "looks" | "wardrobe" | "coat" | "texture" | "lighting" | "surface" | "voice" | "export";
type QualityTier = "draft" | "standard" | "studio";

interface TextureOverride {
  itemId: string;
  color: string;
  pattern: "none" | "plaid" | "dots" | "stripes" | "floral";
  presetIdx?: number;
}

interface LooksJob {
  id: string;
  status: "pending" | "completed" | "failed";
  result?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIGHT_SETTINGS: Record<LightMode, { color: string; intensity: number; label: string }> = {
  warm:    { color: "#ffd59a", intensity: 1.2,  label: "Warm"    },
  neutral: { color: "#fff7df", intensity: 1.55, label: "Neutral" },
  bright:  { color: "#ffffff", intensity: 2.1,  label: "Bright"  },
};

const QUALITY_TIERS: {
  id: QualityTier;
  label: string;
  credits: number;
  looks: number;
  eta: string;
  recommended?: boolean;
}[] = [
  { id: "draft",    label: "Draft",    credits: 2,  looks: 1, eta: "~15s"    },
  { id: "standard", label: "Standard", credits: 8,  looks: 4, eta: "~1-2min", recommended: true },
  { id: "studio",   label: "Studio",   credits: 20, looks: 4, eta: "~3-5min" },
];

const STYLE_PRESETS = [
  "Realistic",
  "Studio Portrait",
  "Holiday",
  "Fantasy",
  "Vintage",
];

// 24 texture preset tiles — solid colors as placeholder until CC0 PNGs are on disk
const TEXTURE_PRESETS: { idx: number; color: string; label: string }[] = [
  { idx: 0,  color: "#c9a87c", label: "Tan leather"    },
  { idx: 1,  color: "#4a3728", label: "Dark brown"     },
  { idx: 2,  color: "#f5e6d0", label: "Cream"          },
  { idx: 3,  color: "#e63946", label: "Crimson"        },
  { idx: 4,  color: "#457b9d", label: "Ocean blue"     },
  { idx: 5,  color: "#1d3557", label: "Navy"           },
  { idx: 6,  color: "#2d6a4f", label: "Forest"         },
  { idx: 7,  color: "#95d5b2", label: "Mint"           },
  { idx: 8,  color: "#f4a261", label: "Tangerine"      },
  { idx: 9,  color: "#e9c46a", label: "Honey gold"     },
  { idx: 10, color: "#264653", label: "Teal slate"     },
  { idx: 11, color: "#e76f51", label: "Terracotta"     },
  { idx: 12, color: "#b5838d", label: "Dusty rose"     },
  { idx: 13, color: "#6d6875", label: "Mauve"          },
  { idx: 14, color: "#ffb703", label: "Sunflower"      },
  { idx: 15, color: "#fb8500", label: "Pumpkin"        },
  { idx: 16, color: "#8ecae6", label: "Sky"            },
  { idx: 17, color: "#219ebc", label: "Cornflower"     },
  { idx: 18, color: "#f8edeb", label: "Blush"          },
  { idx: 19, color: "#8d99ae", label: "Steel"          },
  { idx: 20, color: "#2b2d42", label: "Charcoal"       },
  { idx: 21, color: "#ffffff", label: "White"          },
  { idx: 22, color: "#000000", label: "Black"          },
  { idx: 23, color: "#a8dadc", label: "Aquamarine"     },
];

// ---------------------------------------------------------------------------
// WebGL helpers
// ---------------------------------------------------------------------------

function hasWebGL2(): boolean {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch { return false; }
}

function isMobile(): boolean {
  return window.matchMedia?.("(max-width: 760px), (pointer: coarse)").matches ?? false;
}

// ---------------------------------------------------------------------------
// 3-D sub-components (inside the Canvas)
// ---------------------------------------------------------------------------

function SceneTools({ onCanvasReady }: { onCanvasReady: (c: HTMLCanvasElement) => void }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => onCanvasReady(gl.domElement), [gl, onCanvasReady]);
  return null;
}

function CameraZoom({ zoom }: { zoom: number }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    camera.position.set(0, 1.2, 3.2 / Math.max(0.25, zoom / 100));
    camera.updateProjectionMatrix();
  }, [camera, zoom]);
  return null;
}

function FidosStylesModel({
  url,
  microMesh,
  soften,
}: {
  url: string;
  microMesh: boolean;
  soften: boolean;
}) {
  const { scene } = useGLTF(url);
  const model = useMemo(() => {
    const cloned = skeletonClone(scene) as THREE.Object3D;
    const box = new THREE.Box3().setFromObject(cloned);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const targetHeight = size.y > 1.2 ? 1.55 : 0.85;
    cloned.scale.setScalar(targetHeight / (size.y || 1));
    cloned.updateMatrixWorld(true);
    const scaledBox = new THREE.Box3().setFromObject(cloned);
    scaledBox.getCenter(center);
    cloned.position.x -= center.x;
    cloned.position.z -= center.z;
    cloned.position.y -= scaledBox.min.y;
    cloned.updateMatrixWorld(true);
    cloned.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((mat: any) => {
        if ("roughness" in mat) mat.roughness = soften ? 0.82 : 0.55;
        if ("metalness" in mat) mat.metalness = 0.02;
        if ("normalScale" in mat && microMesh)
          mat.normalScale = new THREE.Vector2(0.35, 0.35);
      });
    });
    return cloned;
  }, [scene, microMesh, soften]);

  return <primitive object={model} />;
}

/* Wardrobe rendering lives in src/wardrobe/WardrobeLayer.tsx — the remaining
   procedural placeholder meshes are quarantined there (see that file's header)
   so this viewer stays free of fake geometry. */

// ---------------------------------------------------------------------------
// Tool-rail icon button
// ---------------------------------------------------------------------------

type IconComponent = React.ComponentType<{ size?: number; className?: string }>;

function ToolBtn({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: IconComponent;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={`flex flex-col items-center gap-1 w-12 py-2.5 rounded-xl text-[10px] font-black transition-all ${
        active
          ? "bg-primary text-on-primary shadow-md"
          : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
      }`}
    >
      <Icon size={18} />
      <span className="leading-none">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function FidosStylesScreen({
  userProfile,
  onGoToPawprints,
  onUserUpdate,
}: FidosStylesScreenProps) {
  // ── Scene / model state ────────────────────────────────────────────────────
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [selectedId, setSelectedId] = useState<number | "">("");
  const [lightMode, setLightMode] = useState<LightMode>("warm");
  const [zoom, setZoom] = useState(100);
  const [turntable, setTurntable] = useState(true);
  const [turntableSpeed, setTurntableSpeed] = useState(0.8);
  const [microMesh, setMicroMesh] = useState(false);
  const [soften, setSoften] = useState(false);
  const [background, setBackground] = useState("#f7f3eb");
  const [viewResetKey, setViewResetKey] = useState(0);
  const [webgl2] = useState(() => hasWebGL2());
  const [mobile] = useState(() => isMobile());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);

  // ── Wardrobe state ─────────────────────────────────────────────────────────
  const [wardrobeIds, setWardrobeIds] = useState<string[]>([]);
  const [wardrobeMsg, setWardrobeMsg] = useState("");
  // Wags-exclusive wardrobe items this user owns via delivered boxes (W3).
  const [ownedWagsItems, setOwnedWagsItems] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    authedFetch("/api/wags/wardrobe")
      .then((r) => (r.ok ? r.json() : { owned: [] }))
      .then((d) => { if (!cancelled) setOwnedWagsItems(new Set(d.owned ?? [])); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // ── Tool rail ──────────────────────────────────────────────────────────────
  const [activeTool, setActiveTool] = useState<ActiveTool>("looks");

  // ── Looks / Hermes state ───────────────────────────────────────────────────
  const [qualityTier, setQualityTier] = useState<QualityTier>("standard");
  const [looksPrompt, setLooksPrompt] = useState("");
  const [looksIdentity, setLooksIdentity] = useState("");
  const [stylePreset, setStylePreset] = useState("");
  const [looksJob, setLooksJob] = useState<LooksJob | null>(null);
  const [looksGenerating, setLooksGenerating] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Coat / UV Texture state ────────────────────────────────────────────────
  const [coatPrompt, setCoatPrompt] = useState("");
  const [coatTier, setCoatTier] = useState<QualityTier>("standard");
  const [coatIdentity, setCoatIdentity] = useState<"high"|"medium"|"stylized">("high");
  const [coatJob, setCoatJob] = useState<TextureJobStatus | null>(null);
  const [coatGenerating, setCoatGenerating] = useState(false);
  const [coatOverrides, setCoatOverrides] = useState<Record<number, string>>({});
  const pollCoatRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Texture state (T1) ─────────────────────────────────────────────────────
  const [textureTarget, setTextureTarget] = useState<string>("");   // wardrobeItem.id
  const [textureOverrides, setTextureOverrides] = useState<Record<string, TextureOverride>>({});

  // ── Voice clone state ──────────────────────────────────────────────────────
  const [showVoiceConsent, setShowVoiceConsent] = useState(false);
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [voiceName, setVoiceName] = useState(`${userProfile.fullName || "My pet"} voice`);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState("");
  const [voiceSpeed, setVoiceSpeed] = useState(1);
  const [voicePitch, setVoicePitch] = useState(0);
  const [voiceTone, setVoiceTone] = useState("gentle");
  const voiceInputRef = useRef<HTMLInputElement | null>(null);

  // ── Project persistence ────────────────────────────────────────────────────
  const [projectId, setProjectId] = useState<number | null>(null);
  const [projectLoadedAvatarId, setProjectLoadedAvatarId] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState("Autosaved");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // Lifecycle: load avatars
  // ---------------------------------------------------------------------------
  useEffect(() => {
    fetchAvatars().then((items) => {
      setAvatars(items);
      const firstReady = items.find((a) => a.rigged_model_url || a.model_url);
      if (firstReady) {
        setSelectedId(firstReady.id);
        setLooksIdentity(firstReady.name ? `${firstReady.name} — a pet model` : "");
      }
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Lifecycle: load wardrobe
  // ---------------------------------------------------------------------------
  useEffect(() => {
    authedFetch("/api/wardrobe")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error("wardrobe load failed")))
      .then((data) => {
        const sel = Array.isArray(data?.selected) ? data.selected : [];
        setWardrobeIds(
          sel.filter((id: unknown): id is string =>
            typeof id === "string" && FULL_WARDROBE_CATALOG.some((item) => item.id === id)
          ).slice(0, 15)
        );
      })
      .catch(() => setWardrobeMsg("Wardrobe could not be loaded."));
  }, []);

  // ---------------------------------------------------------------------------
  // Lifecycle: load fidos project settings for selected avatar
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setProjectId(null);
    setProjectLoadedAvatarId(null);
    setLightMode("warm");
    setBackground("#f7f3eb");
    setMicroMesh(false);
    setSoften(false);
    setTextureOverrides({});
    setZoom(100);
    setTurntable(true);
    setTurntableSpeed(0.8);
    setSaveStatus("Loading…");
    authedFetch(`/api/fidos/projects?avatar_id=${selectedId}`)
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error(data?.error || "Could not load project.");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        if (data) {
          setProjectId(data.id ?? null);
          const s = data.settings_json ?? {};
          if (s.lightMode) setLightMode(s.lightMode);
          if (s.background) setBackground(s.background);
          if (s.microMesh !== undefined) setMicroMesh(s.microMesh);
          if (s.soften !== undefined) setSoften(s.soften);
          if (s.textureOverrides) setTextureOverrides(s.textureOverrides);
          if (Number.isFinite(s.zoom)) setZoom(s.zoom);
          if (s.turntable !== undefined) setTurntable(Boolean(s.turntable));
          if (Number.isFinite(s.turntableSpeed)) setTurntableSpeed(s.turntableSpeed);
        }
        setProjectLoadedAvatarId(Number(selectedId));
        setSaveStatus("Autosaved");
      })
      .catch(() => { if (!cancelled) setSaveStatus("Project load failed"); });
    return () => { cancelled = true; };
  }, [selectedId]);

  // ---------------------------------------------------------------------------
  // Auto-save project settings
  // ---------------------------------------------------------------------------
  const scheduleProjectSave = useCallback(() => {
    if (!selectedId || projectLoadedAvatarId !== Number(selectedId)) return;
    setSaveStatus("Saving…");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      const settings = {
        lightMode, background, microMesh, soften, textureOverrides,
        zoom, turntable, turntableSpeed,
      };
      try {
        const body = JSON.stringify({
          avatar_id: selectedId,
          settings_json: settings,
          ...(projectId ? { id: projectId } : {}),
        });
        const r = await authedFetch(
          projectId ? `/api/fidos/projects/${projectId}` : "/api/fidos/projects",
          { method: projectId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body }
        );
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.error || "Could not save project.");
        if (data?.id && !projectId) setProjectId(data.id);
        setSaveStatus("Autosaved");
      } catch {
        setSaveStatus("Save failed");
      }
    }, 1200);
  }, [selectedId, projectLoadedAvatarId, lightMode, background, microMesh, soften, textureOverrides, zoom, turntable, turntableSpeed, projectId]);

  useEffect(() => { scheduleProjectSave(); }, [scheduleProjectSave]);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------
  const selected = avatars.find((a) => a.id === selectedId);
  // UV8 re-bake: a completed job can swap the viewer to the rebaked GLB.
  // The override is per-avatar and reversible — the original is never lost.
  const [rebakeOverrides, setRebakeOverrides] = useState<Record<number, string>>({});
  const [rebakeJob, setRebakeJob] = useState<{
    id: string;
    status: string;
    resultUrl?: string | null;
    error?: string | null;
    /** UV8 gate result, surfaced so the user sees whether the repair helped. */
    likeness?: { before: number | null; after: number | null; delta: number | null; improved: boolean | null } | null;
  } | null>(null);
  const [rebakeBusy, setRebakeBusy] = useState(false);
  const modelUrl = (typeof selectedId === "number" && coatOverrides[selectedId])
    || (typeof selectedId === "number" && rebakeOverrides[selectedId])
    || selected?.rigged_model_url || selected?.model_url || "";

  const startRebake = useCallback(async () => {
    if (typeof selectedId !== "number" || rebakeBusy) return;
    setRebakeBusy(true);
    setRebakeJob(null);
    try {
      const res = await authedFetch("/api/texture/rebake", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // One key per avatar+day: a retry the same day resumes the same job
          // instead of queueing a duplicate bake on the worker.
          "Idempotency-Key": `rebake-${selectedId}-${new Date().toISOString().slice(0, 10)}`,
        },
        body: JSON.stringify({ avatar_id: selectedId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not start the re-bake.");
      setRebakeJob({ id: data.jobId, status: data.status, resultUrl: data.resultUrl });
      if (data.status === "completed" && data.resultUrl) {
        setRebakeOverrides((prev) => ({ ...prev, [selectedId]: data.resultUrl }));
        setRebakeBusy(false);
        return;
      }
      const poll = async () => {
        const jr = await authedFetch(`/api/texture/jobs/${data.jobId}`);
        const job = await jr.json();
        setRebakeJob({
          id: data.jobId,
          status: job.status,
          resultUrl: job.resultUrl,
          error: job.error,
          likeness: job.stats?.likeness ?? null,
        });
        if (job.status === "completed" && job.resultUrl) {
          setRebakeOverrides((prev) => ({ ...prev, [selectedId]: job.resultUrl }));
          setRebakeBusy(false);
        } else if (job.status === "failed") {
          setRebakeBusy(false);
        } else {
          setTimeout(poll, 5000);
        }
      };
      setTimeout(poll, 5000);
    } catch (e: any) {
      setRebakeJob({ id: "", status: "failed", error: e?.message || "Re-bake failed." });
      setRebakeBusy(false);
    }
  }, [selectedId, rebakeBusy]);
  const light = LIGHT_SETTINGS[lightMode];
  const selectedWardrobeItems = FULL_WARDROBE_CATALOG.filter((item) => wardrobeIds.includes(item.id));
  const textureTargetItem = selectedWardrobeItems.find((i) => i.id === textureTarget) ?? selectedWardrobeItems[0] ?? null;

  // ---------------------------------------------------------------------------
  // Wardrobe toggle
  // ---------------------------------------------------------------------------
  const toggleWardrobe = async (id: string) => {
    const next = wardrobeIds.includes(id)
      ? wardrobeIds.filter((i) => i !== id)
      : [...wardrobeIds, id].slice(0, 15);
    setWardrobeIds(next);
    setWardrobeMsg("Saving…");
    try {
      const r = await authedFetch("/api/wardrobe", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected: next }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "save failed");
      const saved = Array.isArray(data?.selected)
        ? data.selected.filter((i: unknown): i is string => typeof i === "string").slice(0, 15)
        : next;
      setWardrobeIds(saved);
      setWardrobeMsg(`${saved.length}/15 items equipped.`);
    } catch (err: any) {
      setWardrobeMsg(err.message || "Could not save wardrobe.");
    }
  };

  // ---------------------------------------------------------------------------
  // Generate looks via Hermes
  // ---------------------------------------------------------------------------
  const tierMeta = QUALITY_TIERS.find((t) => t.id === qualityTier)!;

  const generateLooks = async () => {
    if (!selectedId) return;
    if (!looksPrompt.trim()) { setLooksJob({ id: "", status: "failed", error: "Add a style prompt first." }); return; }
    setLooksGenerating(true);
    setLooksJob(null);
    try {
      const r = await authedFetch("/api/hermes/looks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "looks",
          payload: {
            avatar_id: Number(selectedId),
            prompt: `${stylePreset ? stylePreset + " — " : ""}${looksPrompt.trim()}`,
            identity_summary: looksIdentity.trim() || (selected?.name ?? "a pet model"),
            look_count: tierMeta.looks,
            reference_photo_count: 0,
            aspect_ratio: "4:5",
            output_schema: "pawsome.look-spec.v1",
            quality_tier: qualityTier,
          },
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Hermes request failed");
      const job: LooksJob = { id: data.id, status: data.status, result: data.result };
      setLooksJob(job);
      if (job.status !== "completed") startPolling(job.id);
    } catch (err: any) {
      setLooksJob({ id: "", status: "failed", error: err.message });
    } finally {
      setLooksGenerating(false);
    }
  };

  const startPolling = (jobId: string) => {
    let attempts = 0;
    const MAX = 40;
    const poll = async () => {
      if (attempts++ > MAX) {
        setLooksJob((prev) => prev ? { ...prev, status: "failed", error: "Timed out." } : prev);
        return;
      }
      try {
        const r = await authedFetch(`/api/hermes/jobs/${jobId}`);
        const data = await r.json();
        setLooksJob({ id: jobId, status: data.status, result: data.result, error: data.error });
        if (data.status === "pending") {
          pollRef.current = setTimeout(poll, 3000);
        }
      } catch {
        pollRef.current = setTimeout(poll, 5000);
      }
    };
    pollRef.current = setTimeout(poll, 2000);
  };

  useEffect(() => {
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, []);

  // ---------------------------------------------------------------------------
  // Texture helper
  // ---------------------------------------------------------------------------
  const applyTexturePreset = (itemId: string, preset: typeof TEXTURE_PRESETS[number]) => {
    setTextureOverrides((prev) => ({
      ...prev,
      [itemId]: { itemId, color: preset.color, pattern: "none", presetIdx: preset.idx },
    }));
  };

  const applyTextureColor = (itemId: string, color: string) => {
    setTextureOverrides((prev) => ({
      ...prev,
      [itemId]: { ...(prev[itemId] ?? { itemId, pattern: "none" }), color },
    }));
  };

  const applyTexturePattern = (itemId: string, pattern: TextureOverride["pattern"]) => {
    setTextureOverrides((prev) => ({
      ...prev,
      [itemId]: { ...(prev[itemId] ?? { itemId, color: "#c9a87c" }), pattern },
    }));
  };

  // ---------------------------------------------------------------------------
  // Voice clone
  // ---------------------------------------------------------------------------
  const readFile = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const onVoiceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVoiceBusy(true);
    setVoiceMsg("");
    try {
      const { asset, user } = await createVoiceCloneAsset({
        name: voiceName.trim() || "Voice clone",
        audioBase64: await readFile(file),
        mimeType: file.type || "audio/webm",
        bytes: file.size,
        voiceConsent: true,
      });
      if (user) onUserUpdate?.(user);
      setVoiceMsg(`${asset.name} saved.`);
      setShowVoiceConsent(false);
      setVoiceConsent(false);
    } catch (err: any) {
      setVoiceMsg(err.message || "Could not save the voice.");
    } finally {
      setVoiceBusy(false);
      if (voiceInputRef.current) voiceInputRef.current.value = "";
    }
  };

  // ---------------------------------------------------------------------------
  // Screenshot
  // ---------------------------------------------------------------------------
  const downloadScreenshot = () => {
    canvasRef.current?.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: `${selected?.name || "fidos-styles"}-look.png` });
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  };

  const resetView = () => {
    setZoom(100);
    setTurntable(true);
    setTurntableSpeed(0.8);
    setBackground("#f7f3eb");
    setViewResetKey((v) => v + 1);
  };

  // ---------------------------------------------------------------------------
  // Render helpers — config panels
  // ---------------------------------------------------------------------------

  function LooksPanel() {
    const looksResult = looksJob?.result as any;
    return (
      <div className="space-y-4 p-4">
        {/* Model selector */}
        <div>
          <label className="text-xs font-black text-on-surface mb-1.5 block">Model</label>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(Number(e.target.value) || "")}
            className="w-full min-h-11 rounded-xl border border-outline-variant bg-surface-container px-3 text-sm"
          >
            <option value="">Choose a model</option>
            {avatars.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.rigged_model_url && !a.model_url}>
                {a.name}{!a.rigged_model_url && !a.model_url ? " (not ready)" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Quality tier cards */}
        <div>
          <label className="text-xs font-black text-on-surface mb-2 block">Quality</label>
          <div className="space-y-2">
            {QUALITY_TIERS.map((tier) => (
              <button
                key={tier.id}
                type="button"
                onClick={() => setQualityTier(tier.id)}
                className={`w-full rounded-xl border px-3 py-2.5 text-left text-sm transition-all ${
                  qualityTier === tier.id
                    ? "border-primary bg-primary/10"
                    : "border-outline-variant hover:border-primary/40"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-black text-on-surface flex items-center gap-1.5">
                    {tier.label}
                    {tier.recommended && (
                      <span className="rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-black text-on-primary">Recommended</span>
                    )}
                  </span>
                  <span className="font-black text-primary">{tier.credits} cr</span>
                </div>
                <div className="mt-0.5 text-[11px] text-on-surface-variant">
                  {tier.looks} {tier.looks === 1 ? "look" : "looks"} · {tier.eta}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Style presets */}
        <div>
          <label className="text-xs font-black text-on-surface mb-2 block">Style preset</label>
          <div className="flex flex-wrap gap-1.5">
            {STYLE_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setStylePreset(stylePreset === p ? "" : p)}
                className={`rounded-lg px-2.5 py-1 text-[11px] font-black border transition-all ${
                  stylePreset === p ? "bg-primary text-on-primary border-primary" : "border-outline-variant text-on-surface"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Identity */}
        <div>
          <label className="text-xs font-black text-on-surface mb-1.5 block">Pet identity</label>
          <textarea
            value={looksIdentity}
            onChange={(e) => setLooksIdentity(e.target.value)}
            rows={2}
            placeholder="Golden retriever, fluffy, amber eyes…"
            className="w-full rounded-xl border border-outline-variant bg-surface-container px-3 py-2 text-sm resize-none"
          />
        </div>

        {/* Prompt */}
        <div>
          <label className="text-xs font-black text-on-surface mb-1.5 block">Style prompt</label>
          <textarea
            value={looksPrompt}
            onChange={(e) => setLooksPrompt(e.target.value)}
            rows={3}
            placeholder="Cozy autumn walk, warm plaid jacket, fallen leaves…"
            className="w-full rounded-xl border border-outline-variant bg-surface-container px-3 py-2 text-sm resize-none"
          />
        </div>

        {/* Generate button */}
        <button
          type="button"
          disabled={looksGenerating || !selectedId}
          onClick={generateLooks}
          className="w-full min-h-12 rounded-xl bg-primary text-on-primary font-black flex items-center justify-center gap-2 disabled:opacity-50 transition-all hover:brightness-105"
        >
          {looksGenerating
            ? <><RefreshCw size={16} className="animate-spin" /> Planning looks…</>
            : <><Sparkles size={16} /> Generate {tierMeta.looks} Look{tierMeta.looks > 1 ? "s" : ""} ({tierMeta.credits} cr)</>}
        </button>

        {/* Job status */}
        {looksJob?.status === "failed" && (
          <p className="text-xs font-bold text-red-500 rounded-xl border border-red-200 bg-red-50 px-3 py-2">{looksJob.error ?? "Generation failed."}</p>
        )}

        {/* Result */}
        {looksJob?.status === "completed" && looksResult?.looks && (
          <div className="space-y-2">
            <p className="text-xs font-black text-primary">✓ {looksResult.looks.length} look{looksResult.looks.length > 1 ? "s" : ""} planned</p>
            {looksResult.looks.map((look: any) => (
              <div key={look.id} className="rounded-xl border border-outline-variant bg-surface-container px-3 py-2.5">
                <p className="text-xs font-black text-on-surface">{look.title}</p>
                <p className="mt-0.5 text-[11px] text-on-surface-variant leading-snug">{look.outfit?.style}</p>
                {look.outfit?.colors?.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {look.outfit.colors.map((c: string) => (
                      <span key={c} className="rounded-full border border-outline-variant px-2 py-0.5 text-[10px] text-on-surface-variant">{c}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function WardrobePanel() {
    return (
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-black text-on-surface">Wardrobe</span>
          <span className="text-[11px] font-black text-primary">{wardrobeIds.length}/15</span>
        </div>
        <p className="text-[11px] text-on-surface-variant">CC0 modular accessories (Quaternius). Accessories attach as meshes to the model skeleton — GLB-based bone attachment is in Phase 3.5.</p>
        <div className="grid grid-cols-2 gap-1.5">
          {WARDROBE_CATALOG.map((item) => (
            <button
              key={item.id}
              onClick={() => void toggleWardrobe(item.id)}
              className={`min-h-14 rounded-xl border p-2 text-left text-[11px] font-black transition-all ${
                wardrobeIds.includes(item.id)
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-outline-variant text-on-surface"
              }`}
            >
              <span className="mb-1 block h-3 w-3 rounded-full" style={{ background: item.color }} />
              {item.name}
            </button>
          ))}
        </div>

        {/* Wags exclusives — unlocked only through delivered Wardrobe Wags boxes.
            Locked tiles are visible on purpose: they are the subscription's
            storefront inside the workspace. */}
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs font-black text-on-surface">Wags exclusives</span>
          <span className="text-[10px] font-black uppercase tracking-wide text-primary">{ownedWagsItems.size} owned</span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {WAGS_EXCLUSIVE_CATALOG.map((item) => {
            const owned = ownedWagsItems.has(item.id);
            const equipped = wardrobeIds.includes(item.id);
            return (
              <button
                key={item.id}
                disabled={!owned}
                onClick={() => owned && void toggleWardrobe(item.id)}
                title={owned ? item.name : `${item.name} — arrives in a Wardrobe Wags box`}
                className={`min-h-14 rounded-xl border p-2 text-left text-[11px] font-black transition-all ${
                  equipped
                    ? "border-primary bg-primary/10 text-primary"
                    : owned
                      ? "border-outline-variant text-on-surface"
                      : "border-outline-variant/40 text-on-surface-variant opacity-55 cursor-not-allowed"
                }`}
              >
                <span className="mb-1 flex items-center gap-1.5">
                  <span className="block h-3 w-3 rounded-full" style={{ background: item.color }} />
                  {!owned && <Gift size={10} className="text-on-surface-variant" />}
                </span>
                {item.name}
              </button>
            );
          })}
        </div>
        {wardrobeMsg && <p className="text-[11px] font-bold text-primary">{wardrobeMsg}</p>}
      </div>
    );
  }

  function TexturePanel() {
    const target = textureTargetItem;
    const currentOverride = target ? textureOverrides[target.id] : null;
    return (
      <div className="p-4 space-y-4">
        {/* PRINT GATE — deliberate product boundary, not a temporary notice.
            Physical figurines go through GLB → STL → Slant 3D, and STL carries
            geometry only; Slant prints one filament color. No texture applied
            here can ever appear on a print, so we say so up front rather than
            let a customer discover it after paying for a figurine. */}
        <div className="rounded-xl border border-amber-300/50 bg-amber-50 px-3 py-2.5 dark:bg-amber-900/15 dark:border-amber-500/30">
          <p className="text-[11px] font-bold leading-snug text-amber-800 dark:text-amber-200">
            Digital only — textures show in the 3D viewer, screenshots, and Wags content.
            Printed figurines are single-color and do not carry textures.
          </p>
        </div>
        <div>
          <label className="text-xs font-black text-on-surface mb-1.5 block">Apply to</label>
          {selectedWardrobeItems.length === 0 ? (
            <p className="text-[11px] text-on-surface-variant">Equip a wardrobe item first.</p>
          ) : (
            <select
              value={textureTarget || selectedWardrobeItems[0]?.id || ""}
              onChange={(e) => setTextureTarget(e.target.value)}
              className="w-full min-h-11 rounded-xl border border-outline-variant bg-surface-container px-3 text-sm"
            >
              {selectedWardrobeItems.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          )}
        </div>

        {target && (
          <>
            {/* Preset swatches */}
            <div>
              <label className="text-xs font-black text-on-surface mb-2 block">Presets</label>
              <div className="grid grid-cols-6 gap-1.5">
                {TEXTURE_PRESETS.map((preset) => (
                  <button
                    key={preset.idx}
                    title={preset.label}
                    type="button"
                    onClick={() => applyTexturePreset(target.id, preset)}
                    className={`h-9 w-full rounded-lg border-2 transition-all ${
                      currentOverride?.presetIdx === preset.idx
                        ? "border-primary scale-110 shadow-md"
                        : "border-transparent hover:border-primary/40"
                    }`}
                    style={{ background: preset.color }}
                  />
                ))}
              </div>
            </div>

            {/* Custom color */}
            <div>
              <label className="text-xs font-black text-on-surface mb-1.5 block">Custom color</label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={currentOverride?.color ?? target.color}
                  onChange={(e) => applyTextureColor(target.id, e.target.value)}
                  className="h-11 w-11 cursor-pointer rounded-xl border border-outline-variant p-0.5"
                />
                <span className="text-sm font-mono text-on-surface-variant">
                  {currentOverride?.color ?? target.color}
                </span>
              </div>
            </div>

            {/* Pattern */}
            <div>
              <label className="text-xs font-black text-on-surface mb-2 block">Pattern</label>
              <div className="grid grid-cols-2 gap-1.5">
                {(["none", "plaid", "dots", "stripes", "floral"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => applyTexturePattern(target.id, p)}
                    className={`min-h-9 rounded-xl border text-xs font-black capitalize transition-all ${
                      (currentOverride?.pattern ?? "none") === p
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-outline-variant text-on-surface"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  function LightingPanel() {
    return (
      <div className="p-4 space-y-4">
        {/* Light mode */}
        <div>
          <label className="text-xs font-black text-on-surface mb-2 block">Lighting</label>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(LIGHT_SETTINGS) as LightMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setLightMode(mode)}
                className={`min-h-11 rounded-xl text-sm font-black border transition-all ${
                  lightMode === mode ? "bg-primary text-on-primary" : "border-outline-variant text-on-surface"
                }`}
              >
                {LIGHT_SETTINGS[mode].label}
              </button>
            ))}
          </div>
        </div>

        {/* Zoom */}
        <div>
          <label className="text-xs font-black text-on-surface block">Zoom — {zoom}%</label>
          <input
            type="range" min={25} max={400} value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-full mt-2"
          />
        </div>

        {/* Turntable */}
        <label className="flex items-center justify-between gap-3 text-sm font-bold">
          <span className="flex items-center gap-2"><RotateCw size={15} /> 360 turntable</span>
          <input type="checkbox" checked={turntable} onChange={(e) => setTurntable(e.target.checked)} className="h-5 w-5 accent-primary" />
        </label>
        {turntable && (
          <input
            type="range" min={0.1} max={2} step={0.1} value={turntableSpeed}
            onChange={(e) => setTurntableSpeed(Number(e.target.value))}
            className="w-full"
          />
        )}

        {/* Background */}
        <div>
          <label className="text-xs font-black text-on-surface mb-2 block">Background</label>
          <div className="grid grid-cols-4 gap-2">
            {["#f7f3eb", "#dbeafe", "#dcfce7", "#171717"].map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Background ${color}`}
                onClick={() => setBackground(color)}
                className={`h-10 rounded-xl border-2 ${background === color ? "border-primary" : "border-transparent"}`}
                style={{ background: color }}
              />
            ))}
          </div>
        </div>

        {/* Reset */}
        <button
          type="button"
          onClick={resetView}
          className="w-full min-h-11 rounded-xl border border-outline-variant flex items-center justify-center gap-2 text-sm font-black"
        >
          <RotateCcw size={15} /> Reset view
        </button>
      </div>
    );
  }

  const startCoatStylization = useCallback(async () => {
    if (typeof selectedId !== "number" || coatGenerating || !coatPrompt.trim()) return;
    setCoatGenerating(true);
    setCoatJob(null);
    try {
      const idempotencyKey = `stylize-${selectedId}-${Date.now()}`;
      const data = await createTextureJob(idempotencyKey, {
        avatar_id: selectedId,
        prompt: coatPrompt,
        tier: coatTier,
        identity_strength: coatIdentity,
      });
      setCoatJob({ jobId: data.jobId, status: data.status as any });

      const poll = async () => {
        try {
          const job = await getTextureJob(data.jobId);
          setCoatJob(job);
          if (job.status === "completed" && job.resultUrl) {
            setCoatOverrides((prev) => ({ ...prev, [selectedId]: job.resultUrl! }));
            setCoatGenerating(false);
          } else if (job.status === "failed") {
            setCoatGenerating(false);
          } else {
            pollCoatRef.current = setTimeout(poll, 3000);
          }
        } catch (err: any) {
           setCoatJob({ jobId: data.jobId, status: "failed", error: err?.message || "Polling failed" });
           setCoatGenerating(false);
        }
      };
      pollCoatRef.current = setTimeout(poll, 3000);
    } catch (e: any) {
      setCoatJob({ jobId: "", status: "failed", error: e?.message || "Failed to start." });
      setCoatGenerating(false);
    }
  }, [selectedId, coatGenerating, coatPrompt, coatTier, coatIdentity]);

  function CoatPanel() {
    // The stylization backend is quarantined (see server/textureJob.ts) — the
    // pipeline it orchestrates cannot complete. Rather than let the form submit
    // into a 503, the panel states the position and points at Texture repair,
    // which does work today. Offering a control that always fails is worse than
    // not offering it: it costs the user a wait and teaches them the feature is
    // broken rather than pending.
    if (!COAT_STYLIZE_AVAILABLE) {
      return (
        <div className="p-4 flex flex-col h-full">
          <h2 className="text-sm font-black text-on-surface mb-2">Restyle Coat</h2>
          <div className="rounded-xl border border-outline-variant/50 bg-surface-container p-3">
            <p className="text-xs font-black text-on-surface mb-1">Coming soon</p>
            <p className="text-[11px] leading-snug text-on-surface-variant">
              Prompt-driven coat restyling is still in development. In the
              meantime, <span className="font-black text-primary">Texture repair</span>{" "}
              re-bakes your pet&apos;s coat from your own approved photos — the
              most likeness-faithful result available, at no extra cost.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setActiveTool("texture")}
            className="mt-3 w-full min-h-11 rounded-xl bg-primary text-on-primary text-sm font-black flex items-center justify-center gap-2"
          >
            <Brush size={14} /> Go to Texture repair
          </button>
        </div>
      );
    }
    return (
      <div className="p-4 flex flex-col h-full">
        <h2 className="text-sm font-black text-on-surface mb-2">Restyle Coat (Beta)</h2>
        <p className="text-xs text-on-surface-variant mb-4">
          Paint directly onto your pet's surface texture. This creates a new variant.
        </p>

        <label className="text-xs font-black text-on-surface mb-1 block">Style Prompt</label>
        <textarea
          value={coatPrompt}
          onChange={(e) => setCoatPrompt(e.target.value)}
          placeholder="e.g. galaxy fur, clay figurine, realistic orange tabby"
          className="w-full rounded-xl border border-outline bg-surface p-3 text-sm font-bold text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary mb-4 resize-none h-20"
        />

        <div className="mb-4">
           <label className="text-xs font-black text-on-surface mb-1 block">Identity Preservation</label>
           <select 
             value={coatIdentity} 
             onChange={(e) => setCoatIdentity(e.target.value as any)}
             className="w-full h-10 px-3 rounded-xl border border-outline bg-surface text-sm font-bold"
           >
             <option value="high">High (Keep exactly like original)</option>
             <option value="medium">Medium (Allow some variation)</option>
             <option value="stylized">Stylized (Allow full repaint)</option>
           </select>
        </div>

        <div className="mb-4">
           <label className="text-xs font-black text-on-surface mb-1 block">Quality Tier</label>
           <div className="flex gap-2">
             {(["draft", "standard", "studio"] as const).map(t => (
               <button
                 key={t}
                 onClick={() => setCoatTier(t)}
                 className={`flex-1 py-2 text-xs font-bold rounded-lg border ${
                   coatTier === t ? "bg-primary text-on-primary border-primary" : "border-outline bg-surface text-on-surface"
                 }`}
               >
                 {t.charAt(0).toUpperCase() + t.slice(1)}
               </button>
             ))}
           </div>
           <p className="text-[10px] text-on-surface-variant mt-1 text-center">
             {coatTier === "draft" ? "Low resolution. Fast. (2 credits)" : coatTier === "studio" ? "High resolution + Seam repair pass. (20 credits)" : "Standard resolution. (8 credits)"}
           </p>
        </div>

        <button
          type="button"
          disabled={coatGenerating || !coatPrompt.trim()}
          onClick={startCoatStylization}
          className="mt-auto w-full min-h-12 rounded-xl bg-primary text-on-primary font-black flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {coatGenerating ? <RefreshCw size={16} className="animate-spin" /> : <Sparkles size={16} />}
          {coatGenerating ? "Applying Style..." : "Apply Coat"}
        </button>

        {coatJob && coatJob.status !== "queued" && (
          <div className="mt-3 p-3 bg-surface-container rounded-xl text-xs font-bold text-center">
             Status: {coatJob.status}
             {coatJob.error && <p className="text-error mt-1">{coatJob.error}</p>}
          </div>
        )}

        {typeof selectedId === "number" && coatOverrides[selectedId] && (
           <button
             type="button"
             onClick={() => setCoatOverrides(prev => { const n = {...prev}; delete n[selectedId]; return n; })}
             className="w-full mt-2 min-h-11 rounded-xl border border-outline-variant text-sm font-black text-on-surface-variant flex items-center justify-center gap-2"
           >
             <RotateCcw size={15} /> Revert to Original
           </button>
        )}
      </div>
    );
  }

  function SurfacePanel() {
    return (
      <div className="p-4 space-y-4">
        <p className="text-xs font-black text-on-surface">Surface Quality</p>
        <label className="flex items-center justify-between gap-3 text-sm font-bold">
          <span>Micro-mesh detail</span>
          <input type="checkbox" checked={microMesh} onChange={(e) => setMicroMesh(e.target.checked)} className="h-5 w-5 accent-primary" />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm font-bold">
          <span>Soft friendly shader</span>
          <input type="checkbox" checked={soften} onChange={(e) => setSoften(e.target.checked)} className="h-5 w-5 accent-primary" />
        </label>

        {/* UV8 — likeness repair. Re-projects the approved reference photos
            onto the mesh and re-bakes the color texture. No AI generation,
            no charge: it repairs what the user already paid to create. */}
        <div className="border-t border-outline-variant/40 pt-4 space-y-2">
          <p className="text-xs font-black text-on-surface">Texture repair</p>
          <p className="text-[11px] leading-snug text-on-surface-variant">
            Muddy or striped coat? Re-bake the texture from your approved
            reference photos. The original model is kept — you can switch back.
          </p>
          <button
            type="button"
            disabled={typeof selectedId !== "number" || rebakeBusy}
            onClick={() => void startRebake()}
            className="w-full min-h-11 rounded-xl bg-primary text-on-primary text-sm font-black flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {rebakeBusy
              ? <><RefreshCw size={14} className="animate-spin" /> Re-baking… (takes a few minutes)</>
              : <><Brush size={14} /> Re-bake from my photos</>}
          </button>
          {rebakeJob?.status === "failed" && (
            <p className="text-[11px] font-bold text-red-500">{rebakeJob.error || "Re-bake failed — please try again."}</p>
          )}
          {/* UV8 gate readout. Phrased as colour match rather than a raw
              CIEDE2000 figure — the number is meaningful to us, not to a pet
              owner. Shown only when scoring actually ran. */}
          {rebakeJob?.status === "completed" && rebakeJob.likeness?.improved !== null
            && rebakeJob.likeness?.before != null && rebakeJob.likeness?.after != null && (
            <p className="text-[11px] leading-snug text-on-surface-variant">
              {rebakeJob.likeness.improved ? (
                <>
                  <span className="font-black text-primary">Closer to your photos.</span>{" "}
                  Colour match improved by{" "}
                  {Math.round(
                    ((rebakeJob.likeness.before - rebakeJob.likeness.after) / rebakeJob.likeness.before) * 100,
                  )}
                  %.
                </>
              ) : (
                <>
                  <span className="font-black text-on-surface">Original was already a close match.</span>{" "}
                  The re-bake didn&apos;t improve colour accuracy — keep whichever you prefer.
                </>
              )}
            </p>
          )}
          {typeof selectedId === "number" && rebakeOverrides[selectedId] && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2">
              <span className="text-[11px] font-black text-primary">Re-baked texture active</span>
              <button
                type="button"
                onClick={() => setRebakeOverrides((prev) => { const next = { ...prev }; delete next[selectedId]; return next; })}
                className="text-[11px] font-black text-on-surface-variant underline"
              >
                Use original
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  function VoicePanel() {
    return (
      <div className="p-4 space-y-4">
        <p className="text-xs font-black text-on-surface">Voice Clone</p>
        <select className="w-full min-h-11 rounded-xl border border-outline-variant bg-surface-container px-3 text-sm">
          <option>Randy gentle narrator</option>
          <option>Warm storyteller</option>
          <option>Bright announcer</option>
        </select>
        <label className="block text-xs font-bold">Speed {voiceSpeed.toFixed(1)}×</label>
        <input type="range" min={0.6} max={1.4} step={0.1} value={voiceSpeed} onChange={(e) => setVoiceSpeed(Number(e.target.value))} className="w-full" />
        <label className="block text-xs font-bold">Pitch {voicePitch}</label>
        <input type="range" min={-6} max={6} value={voicePitch} onChange={(e) => setVoicePitch(Number(e.target.value))} className="w-full" />
        <label className="block text-xs font-bold">Tone</label>
        <select value={voiceTone} onChange={(e) => setVoiceTone(e.target.value)} className="w-full min-h-11 rounded-xl border border-outline-variant bg-surface-container px-3 text-sm">
          <option value="gentle">Gentle</option>
          <option value="playful">Playful</option>
          <option value="calm">Calm</option>
        </select>
        <button
          type="button"
          onClick={() => setShowVoiceConsent(true)}
          disabled={!userProfile.isAdmin && userProfile.credits < CREDIT_PRICES.VOICE_CLONE}
          className="w-full min-h-12 rounded-xl bg-primary text-on-primary font-black flex items-center justify-center gap-2 disabled:opacity-45"
        >
          <Upload size={16} /> Clone voice ({CREDIT_PRICES.VOICE_CLONE} cr)
        </button>
        {voiceMsg && <p className="text-xs font-bold text-primary">{voiceMsg}</p>}
      </div>
    );
  }

  function ExportPanel() {
    return (
      <div className="p-4 space-y-3">
        <p className="text-xs font-black text-on-surface">Export</p>
        <p className="text-[11px] leading-snug text-on-surface-variant">
          Styled looks and textures are digital. Ordering a printed figurine uses
          the untextured model — prints are single-color.
        </p>
        <button
          type="button"
          onClick={downloadScreenshot}
          className="w-full min-h-12 rounded-xl bg-primary text-on-primary font-black flex items-center justify-center gap-2"
        >
          <Download size={16} /> Screenshot PNG
        </button>
        <button
          type="button"
          onClick={() => viewerRef.current?.requestFullscreen?.()}
          className="w-full min-h-11 rounded-xl border border-outline-variant flex items-center justify-center gap-2 text-sm font-black"
        >
          <Maximize2 size={15} /> Fullscreen
        </button>
        <button
          type="button"
          onClick={onGoToPawprints}
          className="w-full min-h-11 rounded-xl border border-outline-variant flex items-center justify-center gap-2 text-sm font-black"
        >
          <PawPrint size={15} /> Open in Pawprints
        </button>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const TOOLS: { id: ActiveTool; icon: IconComponent; label: string }[] = [
    { id: "looks",    icon: Layers,    label: "Looks"    },
    { id: "wardrobe", icon: Shirt,     label: "Wardrobe" },
    { id: "coat",     icon: Brush,     label: "Coat"     },
    { id: "texture",  icon: Palette,   label: "Texture"  },
    { id: "lighting", icon: SunMedium, label: "Light"    },
    { id: "surface",  icon: Grid3X3,   label: "Surface"  },
    { id: "voice",    icon: Mic,       label: "Voice"    },
    { id: "export",   icon: Download,  label: "Export"   },
  ];

  const ConfigPanel =
    activeTool === "looks"    ? LooksPanel    :
    activeTool === "wardrobe" ? WardrobePanel :
    activeTool === "coat"     ? CoatPanel     :
    activeTool === "texture"  ? TexturePanel  :
    activeTool === "lighting" ? LightingPanel :
    activeTool === "surface"  ? SurfacePanel  :
    activeTool === "voice"    ? VoicePanel    :
    ExportPanel;

  return (
    <div className="flex h-[calc(100dvh-64px)] overflow-hidden animate-fade-in">

      {/* ── LEFT TOOL RAIL ─────────────────────────────── */}
      <nav className="hidden md:flex flex-col items-center gap-1 w-14 shrink-0 border-r border-outline-variant/40 bg-surface-container/50 pt-4 pb-6 px-1 overflow-y-auto">
        <div className="mb-3">
          <Brush size={18} className="text-primary" />
        </div>
        {TOOLS.map((t) => (
          <ToolBtn
            key={t.id}
            icon={t.icon}
            label={t.label}
            active={activeTool === t.id}
            onClick={() => setActiveTool(t.id)}
          />
        ))}
        <div className="mt-auto text-[10px] font-black text-on-surface-variant text-center leading-tight px-1">
          {saveStatus}
        </div>
      </nav>

      {/* ── CONFIG PANEL ───────────────────────────────── */}
      <aside className="hidden md:flex flex-col w-72 shrink-0 border-r border-outline-variant/40 bg-surface overflow-y-auto">
        <div className="sticky top-0 z-10 bg-surface border-b border-outline-variant/40 px-4 py-3 flex items-center gap-2">
          {React.createElement(TOOLS.find((t) => t.id === activeTool)!.icon, { size: 16, className: "text-primary" })}
          <span className="text-sm font-black text-on-surface capitalize">
            {TOOLS.find((t) => t.id === activeTool)!.label}
          </span>
        </div>
        <ConfigPanel />
      </aside>

      {/* ── VIEWPORT ───────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0">
        <AnimatorErrorBoundary onClose={() => {}} hasWebGL2={webgl2}>
          <div
            ref={viewerRef}
            className="relative flex-1 overflow-hidden"
            style={{ background }}
          >
            {!webgl2 ? (
              <div className="h-full flex items-center justify-center p-8 text-center text-on-surface">
                This editor needs a browser with WebGL 2.
              </div>
            ) : !modelUrl ? (
              <div className="h-full flex items-center justify-center p-8 text-center text-on-surface-variant">
                <div>
                  <Brush size={36} className="mx-auto mb-3 opacity-30" />
                  <p className="text-sm font-bold">Choose a ready GLB model to begin.</p>
                  <p className="mt-1 text-xs opacity-60">Go to Looks → pick a model from the dropdown.</p>
                </div>
              </div>
            ) : (
              <Canvas
                shadows
                dpr={mobile ? [1, 1.25] : [1, 1.75]}
                camera={{ position: [0, 1.2, 3.2 / (zoom / 100)], fov: 42 }}
                gl={{ preserveDrawingBuffer: true, powerPreference: "high-performance", failIfMajorPerformanceCaveat: false }}
              >
                <SceneTools onCanvasReady={(c) => { canvasRef.current = c; }} />
                <CameraZoom zoom={zoom} />
                <color attach="background" args={[background]} />
                <ambientLight intensity={0.55} />
                <pointLight position={[0, 2.8, 0.4]} intensity={light.intensity} color={light.color} castShadow />
                <Suspense fallback={<Html center><div className="text-on-surface text-sm font-bold">Loading…</div></Html>}>
                  <Bounds fit clip observe margin={1.15}>
                    <FidosStylesModel url={modelUrl} microMesh={microMesh} soften={soften} />
                    <WardrobeLayer selectedIds={wardrobeIds} />
                  </Bounds>
                </Suspense>
                {/* Shadow-only grounding — no solid turntable slab (spec §8.2:
                    placeholder props removed; the model reads as floating in the
                    studio environment, grounded only by its contact shadow). */}
                <ContactShadows position={[0, 0.001, 0]} opacity={0.45} scale={4} blur={2.4} far={2.2} resolution={512} frames={turntable ? Infinity : 1} />
                <Environment preset="studio" />
                <OrbitControls
                  key={viewResetKey}
                  enablePan
                  minDistance={0.7}
                  maxDistance={8}
                  autoRotate={turntable}
                  autoRotateSpeed={turntableSpeed}
                />
              </Canvas>
            )}

            {/* Floating toolbar overlay */}
            <div className="absolute bottom-3 right-3 flex gap-2">
              <button
                type="button"
                onClick={resetView}
                title="Reset view"
                className="h-9 w-9 rounded-xl bg-surface/80 backdrop-blur border border-outline-variant/60 flex items-center justify-center text-on-surface shadow hover:bg-surface"
              >
                <RotateCcw size={15} />
              </button>
              <button
                type="button"
                onClick={downloadScreenshot}
                title="Screenshot"
                className="h-9 w-9 rounded-xl bg-surface/80 backdrop-blur border border-outline-variant/60 flex items-center justify-center text-on-surface shadow hover:bg-surface"
              >
                <Download size={15} />
              </button>
            </div>
          </div>
        </AnimatorErrorBoundary>

        {/* Mobile tool tabs */}
        <nav className="md:hidden flex border-t border-outline-variant/40 bg-surface overflow-x-auto">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTool(t.id)}
              className={`flex flex-col items-center gap-0.5 px-3 py-2 text-[10px] font-black shrink-0 border-t-2 transition-all ${
                activeTool === t.id
                  ? "border-primary text-primary"
                  : "border-transparent text-on-surface-variant"
              }`}
            >
              {React.createElement(t.icon, { size: 18 })}
              {t.label}
            </button>
          ))}
        </nav>

        {/* Mobile config panel (slide-up sheet) */}
        <div className="md:hidden max-h-72 overflow-y-auto border-t border-outline-variant/40 bg-surface">
          <ConfigPanel />
        </div>
      </div>

      {/* ── VOICE CONSENT MODAL ──────────────────────── */}
      {showVoiceConsent && (
        <div className="fixed inset-0 z-[80] bg-black/70 flex items-center justify-center p-4">
          <section className="w-full max-w-lg rounded-2xl bg-surface text-on-surface border border-outline-variant shadow-2xl p-6">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h2 className="text-2xl font-black">Voice permission</h2>
                <p className="text-sm leading-relaxed text-on-surface-variant mt-2">
                  Confirm you own this voice or have documented permission to clone it.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowVoiceConsent(false)}
                className="w-11 h-11 rounded-full border border-outline-variant flex items-center justify-center"
              >
                <X size={20} />
              </button>
            </div>
            <label className="block text-sm font-bold mb-2" htmlFor="voice-name">Voice name</label>
            <input
              id="voice-name"
              value={voiceName}
              onChange={(e) => setVoiceName(e.target.value)}
              className="w-full min-h-12 rounded-xl border border-outline-variant bg-surface-container px-4 text-base mb-4"
            />
            <label className="flex items-start gap-3 rounded-xl border border-outline-variant/50 bg-surface-container p-4 text-sm leading-relaxed cursor-pointer mb-5">
              <input
                type="checkbox"
                checked={voiceConsent}
                onChange={(e) => setVoiceConsent(e.target.checked)}
                className="mt-1 h-5 w-5 accent-primary"
              />
              <span>I confirm I own this voice or have documented permission to clone it.</span>
            </label>
            <button
              type="button"
              disabled={!voiceConsent || voiceBusy}
              onClick={() => voiceInputRef.current?.click()}
              className="w-full min-h-14 rounded-xl bg-primary text-on-primary font-black disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {voiceBusy
                ? "Saving…"
                : <><CheckCircle2 size={20} /> Choose audio · {CREDIT_PRICES.VOICE_CLONE} cr</>}
            </button>
            <input ref={voiceInputRef} type="file" accept="audio/*" className="hidden" onChange={onVoiceFile} />
          </section>
        </div>
      )}
    </div>
  );
}
