import React, { useEffect, useState, useRef, useMemo } from "react";
import * as THREE from "three";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Environment, ContactShadows } from "@react-three/drei";
import { Play, Pause, FastForward, Video, Plus, X, List, Clapperboard, Download, Square, Sun, CloudRain, Volume2, VolumeX, Mic, Shuffle, MousePointer2, Move3D, Rotate3D, Scaling, Camera, Bone, Grid3X3, ShieldCheck, Repeat2, Wand2 } from "lucide-react";
import { useSceneController, SceneTicker } from "../controller/useSceneController.ts";
import { useCaptureSession } from "../capture/useCaptureSession.ts";
import { ANIMATOR_DEFAULTS } from "../defaults.ts";
import { WeatherSystem, WeatherType } from "../scenes/weather/WeatherSystem.tsx";
import { SoundSystem } from "../scenes/sound/SoundSystem.tsx";
import { evaluateSequence, SceneSequence } from "../scenes/SceneSequence.ts";
import { lightingFor } from "../scenes/lightingRig.ts";
import { AnimatorErrorBoundary } from "./AnimatorErrorBoundary.tsx";
import { isMobile, hasWebGL2, hasWebCodecs } from "../utils/capabilities.ts";
import { filterReadyAvatars, resolveAvatarGlbUrl } from "../utils/avatarUtils.ts";
import { getToken } from "../../api";
import { ALL_OBJECT_KINDS, OBJECT_CATALOG } from "../../three/objects/catalog.ts";
import { runScript } from "../scenes/SceneSequence.ts";
import { retargetClip } from "../utils/retargetUtils.ts";
import { findSkinnedMesh } from "../../three/ar/ik.ts";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { useTheatreSheet } from "./TheatreWrapper.tsx";
import { playLiveActorSpeech, type LiveSpeechHandle } from "../speech/liveSpeech.ts";
import { CREDIT_PRICES } from "../../pricing.ts";

/**
 * Renders the scene backdrop based on the preset's `backdrop.kind`.
 * Previously the code read `environment.hdriBucketUrl` (which never existed on
 * the preset schema), so HDRIs fell back to "city" and `image` backdrops — like
 * the Arkham renders — displayed nothing at all. This switches on the real
 * `backdrop: { kind, url }` shape returned by /api/scenes/environments.
 */
function SceneBackdrop({ backdrop }: { backdrop?: { kind?: string; url?: string } }) {
  const { scene } = useThree();
  const kind = backdrop?.kind;
  const url = backdrop?.url;
  const mobile = isMobile();

  // Load every shipped JPEG/WebP ourselves. This keeps missing/corrupt assets in
  // a local fallback instead of allowing drei's Suspense loader to trip the
  // whole-studio error boundary when a script changes environments.
  useEffect(() => {
    if (!url || mobile || !["image", "hdri", "dome360"].includes(String(kind))) return;
    let disposed = false;
    let loadedTexture: THREE.Texture | null = null;
    const previousBackground = scene.background;
    const previousEnvironment = scene.environment;
    scene.background = new THREE.Color(kind === "image" ? "#29323a" : "#8aa0b5");
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    loader.load(
      url,
      (tex) => {
        if (disposed) { tex.dispose(); return; }
        loadedTexture = tex;
        tex.colorSpace = THREE.SRGBColorSpace;
        if (kind === "hdri" || kind === "dome360") {
          tex.mapping = THREE.EquirectangularReflectionMapping;
          scene.environment = tex;
        }
        scene.background = tex;
      },
      undefined,
      (err) => console.warn("[Animator] backdrop image failed to load:", url, err)
    );
    return () => {
      disposed = true;
      if (scene.background === loadedTexture) scene.background = previousBackground;
      if (scene.environment === loadedTexture) scene.environment = previousEnvironment;
      loadedTexture?.dispose();
    };
  }, [kind, mobile, url, scene]);

  if (mobile) {
    return <Environment preset="city" background />;
  }
  
  if (kind === "image") {
    return <Environment preset="apartment" />;
  }
  if (kind === "hdri" || kind === "dome360") return null;
  // procedural / glb-scene(unbuilt) / none → neutral visible environment.
  return <Environment preset="city" background />;
}

/**
 * Syncs the R3F camera with Theatre's imperative camera object state
 */
function TheatreCameraRig({ cameraObj }: { cameraObj: any }) {
  const { camera } = useThree();
  
  useFrame(() => {
    if (cameraObj) {
      const v = cameraObj.value;
      camera.position.set(v.position.x, v.position.y, v.position.z);
      if ((camera as THREE.PerspectiveCamera).fov !== v.fov) {
        (camera as THREE.PerspectiveCamera).fov = v.fov;
        camera.updateProjectionMatrix();
      }
    }
  });
  
  return null;
}

/**
 * Inner viewport component that depends on `useThree` context.
 */
function Viewport({
  sceneController,
  environment,
  weather,
  cameraState,
  soundMuted,
  soundUnlocked,
  soundReady,
  lightTarget,
  soundCue,
  ikOptions,
  proMode,
  cameraObj,
}: {
  sceneController: ReturnType<typeof useSceneController>,
  environment: any,
  weather: WeatherType,
  cameraState: { position: [number, number, number], fov: number },
  soundMuted: boolean,
  soundUnlocked: boolean,
  soundReady: boolean,
  lightTarget: any,
  soundCue: any,
  ikOptions: any,
  proMode?: boolean,
  cameraObj?: any,
}) {
  const scene = sceneController.getScene();
  
  const lighting = useMemo(() => {
    if (environment) {
      const baseTime = typeof lightTarget === 'string' ? lightTarget : (lightTarget?.preset || environment.defaultTimeOfDay || "afternoon");
      const baseLighting = lightingFor(baseTime as any, environment);
      return typeof lightTarget === 'object' ? { ...baseLighting, ...lightTarget } : baseLighting;
    }
    return null;
  }, [environment, lightTarget]);

  return (
    <>
      {/* Per-frame controller tick — must live inside <Canvas> */}
      <SceneTicker controller={sceneController} ikOptions={ikOptions} />

      <primitive object={scene} />

      {proMode && (
        <TheatreCameraRig cameraObj={cameraObj} />
      )}

      <WeatherSystem weather={weather} />
      
      {environment && (
        <SoundSystem 
          ambientSoundId={environment.ambientSoundId}
          weather={weather} 
          volume={ANIMATOR_DEFAULTS.sound.volume}
          soundCue={soundCue}
          muted={soundMuted}
          unlocked={soundUnlocked}
          ready={soundReady}
        />
      )}

      <SceneBackdrop backdrop={environment?.backdrop} />
      
      <ContactShadows 
        resolution={1024} 
        scale={10} 
        blur={ANIMATOR_DEFAULTS.shadows.contactShadowBlur} 
        opacity={ANIMATOR_DEFAULTS.shadows.contactShadowOpacity} 
        far={10} 
      />
      
      <OrbitControls 
        makeDefault 
        enabled={!proMode}
        target={ANIMATOR_DEFAULTS.camera.target}
        maxPolarAngle={Math.PI / 2 + 0.1}
      />
      
      {/* Dynamic Lighting from Profile */}
      {lighting ? (
        <>
          <ambientLight intensity={lighting.ambientIntensity} />
          <directionalLight 
            position={lighting.sunPosition} 
            intensity={lighting.sunIntensity} 
            castShadow 
          />
          {lighting.fogDensity > 0 && (
            <fogExp2 attach="fog" color={lighting.fogColor} density={lighting.fogDensity} />
          )}
        </>
      ) : (
        <>
          <ambientLight intensity={0.5} />
          <directionalLight position={[5, 5, 5]} intensity={1} castShadow />
        </>
      )}
    </>
  );
}

export default function AnimatorScreen({
  initialAssetId,
  onClose,
  onOpenVideoCreator,
}: {
  initialAssetId: string | null;
  onClose: () => void;
  onOpenVideoCreator?: () => void;
}) {
  const sceneController = useSceneController();
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState(1.0);
  const [timeline, setTimeline] = useState(0); // 0 to 1
  
  const [mode, setMode] = useState<"cast" | "scene">("cast");
  const [environments, setEnvironments] = useState<any[]>([]);
  const [scripts, setScripts] = useState<any[]>([]);
  const [directorScripts, setDirectorScripts] = useState<any[]>([]);
  const [userAvatars, setUserAvatars] = useState<any[]>([]);
  const [libraryClips, setLibraryClips] = useState<any[]>([]);
  const [activeDirectorScript, setActiveDirectorScript] = useState<any>(null);
  const [directorSearch, setDirectorSearch] = useState("");
  const [castAssignments, setCastAssignments] = useState<Record<string, string>>({});
  const [mappedRoles, setMappedRoles] = useState<Record<string, string>>({});
  const [ikOptions, setIkOptions] = useState<Record<string, { groundIK: boolean, lookAtCamera: boolean }>>({});
  const [proMode, setProMode] = useState(false);
  const [workspaceTool, setWorkspaceTool] = useState<"select" | "move" | "rotate" | "scale" | "camera" | "rig" | "voice">("select");
  const [timelineView, setTimelineView] = useState<"timeline" | "dope" | "xsheet">("timeline");
  const [timelineFps, setTimelineFps] = useState<12 | 24 | 30>(24);
  const [loopPlayback, setLoopPlayback] = useState(true);
  const [showViewerGrid, setShowViewerGrid] = useState(true);
  const [showSafeArea, setShowSafeArea] = useState(true);
  const [sceneName, setSceneName] = useState("PAWSOME_SCENE_01");
  const [studioNotice, setStudioNotice] = useState("");
  
  const { cameraObj } = useTheatreSheet(proMode, "PawsMemories");
  
  const mobile = useMemo(() => isMobile(), []);
  const webGL2 = useMemo(() => hasWebGL2(), []);
  const webCodecs = useMemo(() => hasWebCodecs(), []);
  const [contextLost, setContextLost] = useState(false);
  const [actorLoadError, setActorLoadError] = useState(false);
  
  const [activeEnvId, setActiveEnvId] = useState<string>("");
  const [weather, setWeather] = useState<WeatherType>("clear");
  const [lightTarget, setLightTarget] = useState<any>(null);
  const [soundTarget, setSoundTarget] = useState<any>(null);
  const [soundMuted, setSoundMuted] = useState(false);
  const [soundUnlocked, setSoundUnlocked] = useState(false);
  const [activeSequenceId, setActiveSequenceId] = useState<string>("");
  
  const [morphInfluences, setMorphInfluences] = useState<Record<string, number>>({});
  const [bookmarks, setBookmarks] = useState<any[]>([]);
  
  const [voiceoverText, setVoiceoverText] = useState("");
  const [isVoiceoverRunning, setIsVoiceoverRunning] = useState(false);
  const [voiceoverJob, setVoiceoverJob] = useState<{ jobId: number; status: string; progress: number; error: string | null; resultUrl: string | null; mimeType?: string | null } | null>(null);
  const [isVoicePreviewRunning, setIsVoicePreviewRunning] = useState(false);
  const [voicePreviewTier, setVoicePreviewTier] = useState<"A" | "B" | "C" | null>(null);
  
  const [addingAssetId, setAddingAssetId] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  
  const rafRef = useRef<number>(0);
  const initialAssetLoadedRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureSession = useCaptureSession(canvasRef);
  const voicePreviewRef = useRef<LiveSpeechHandle | null>(null);
  const voicePreviewAbortRef = useRef<AbortController | null>(null);
  const directorRuntimeRef = useRef<{ scriptId: string; lastTime: number; clips: Record<string, string> }>({
    scriptId: "",
    lastTime: 0,
    clips: {},
  });

  const actors = sceneController.listActors();
  const activeActorId = sceneController.getActiveActorId();
  const activeController = activeActorId ? sceneController.getActorController(activeActorId) : null;
  
  const duration = activeController ? activeController.getDuration() : 10;

  useEffect(() => {
    activeController?.setLoop(loopPlayback);
  }, [activeController, loopPlayback]);
  
  const activeEnv = environments.find(e => e.id === activeEnvId);
  const activeSequence = ANIMATOR_DEFAULTS.sequences.find(s => s.id === activeSequenceId) as SceneSequence | undefined;
  const visibleDirectorScripts = useMemo(() => {
    const query = directorSearch.trim().toLowerCase();
    if (!query) return directorScripts;
    return directorScripts.filter((script) =>
      [script.name, script.category, script.description].some((value) => String(value || "").toLowerCase().includes(query))
    );
  }, [directorScripts, directorSearch]);
  
  const [cameraState, setCameraState] = useState({ 
    position: ANIMATOR_DEFAULTS.camera.position as [number, number, number], 
    fov: ANIMATOR_DEFAULTS.camera.fov 
  });
  
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);

  useEffect(() => {
    if (activeController) {
      const morphs = activeController.listMorphTargets();
      const initial: Record<string, number> = {};
      morphs.forEach(m => initial[m] = 0);
      setMorphInfluences(initial);
    }
  }, [activeController]);

  const handleMorphChange = (name: string, value: number) => {
    setMorphInfluences(prev => ({ ...prev, [name]: value }));
    if (activeController) {
      activeController.setMorphInfluence(name, value);
    }
  };
  
  const saveBookmark = () => {
    if (cameraRef.current) {
      const pos = cameraRef.current.position;
      setBookmarks(prev => [...prev, {
        id: Date.now().toString(),
        name: `Cam ${prev.length + 1}`,
        position: [pos.x, pos.y, pos.z],
        fov: cameraRef.current!.fov
      }]);
    }
  };

  // Fetch presets
  useEffect(() => {
    fetch("/api/scenes/environments", { headers: { "Authorization": `Bearer ${getToken()}` }})
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setEnvironments(data);
      })
      .catch(console.error);
      
    fetch("/api/scenes/scripts", { headers: { "Authorization": `Bearer ${getToken()}` }})
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setScripts(data);
      })
      .catch(console.error);
      
      fetch("/api/scenes/director-scripts", { headers: { "Authorization": `Bearer ${getToken()}` }})
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setDirectorScripts(data);
      })
      .catch(console.error);

    fetch("/api/avatars", { headers: { "Authorization": `Bearer ${getToken()}` }})
      .then(r => r.json())
      .then(data => {
        const avatars = Array.isArray(data) ? data : data?.avatars;
        if (Array.isArray(avatars)) setUserAvatars(filterReadyAvatars(avatars));
      })
      .catch(console.error);
      
    fetch("/api/scenes/clips", { headers: { "Authorization": `Bearer ${getToken()}` }})
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setLibraryClips(data);
      })
      .catch(console.error);
  }, []);

  // Sync timeline progress and evaluate sequences
  useEffect(() => {
    const updateTimeline = () => {
      let currentTime = 0;
      if (activeController) {
        currentTime = activeController.getCurrentTime();
        setTimeline(currentTime / (activeController.getDuration() || 1));
      }
      
      if (activeSequence) {
        const state = evaluateSequence(activeSequence, currentTime);
        if (state.weatherTarget) {
          setWeather(state.weatherTarget as WeatherType);
        }
        if (state.cameraTarget) {
          setCameraState(state.cameraTarget);
        }
        if (activeController) {
          const target = state.clipTargets[activeActorId || "default"];
          if (target) activeController.selectClip(target);
        }
      }
      
      if (activeDirectorScript) {
        const runtime = directorRuntimeRef.current;
        if (runtime.scriptId !== activeDirectorScript.id || currentTime + 0.05 < runtime.lastTime) {
          runtime.scriptId = activeDirectorScript.id;
          runtime.clips = {};
        }
        runtime.lastTime = currentTime;
        const state = runScript(activeDirectorScript, currentTime);
        if (state.cameraTarget) setCameraState(state.cameraTarget);
        if (state.weatherTarget) setWeather(state.weatherTarget as WeatherType);
        if (state.lightTarget) setLightTarget(state.lightTarget);
        setSoundTarget((previous: any) => JSON.stringify(previous) === JSON.stringify(state.soundTarget ?? null) ? previous : (state.soundTarget ?? null));

        for (const [roleId, clipTarget] of Object.entries(state.clipTargets)) {
          const actorId = mappedRoles[roleId];
          if (actorId) {
            const controller = sceneController.getActorController(actorId);
            if (controller && runtime.clips[roleId] !== clipTarget.name) {
              const requested = String(clipTarget.name || "");
              const clips = controller.listClips();
              const normalized = requested.toLowerCase().replace(/[_\s]+/g, "-");
              const playable = clips.find((clip) => clip.name === requested)
                || clips.find((clip) => clip.name.toLowerCase().replace(/[_\s]+/g, "-") === normalized);
              if (!playable) {
                setStudioNotice(`The cast model has no playable rig clips for “${requested}”.`);
                continue;
              }
              const blend = clipTarget.blend || 0;
              if (blend > 0) {
                controller.crossFadeTo(playable.name, blend);
              } else {
                controller.selectClip(playable.name, 0);
              }
              runtime.clips[roleId] = requested;
            }
          }
        }
      }

      rafRef.current = requestAnimationFrame(updateTimeline);
    };
    rafRef.current = requestAnimationFrame(updateTimeline);
    return () => cancelAnimationFrame(rafRef.current!);
  }, [activeController, activeSequence, activeDirectorScript, mappedRoles, sceneController]);

  // Load initial asset
  useEffect(() => {
    setActorLoadError(false);
    if (initialAssetId && initialAssetLoadedRef.current !== initialAssetId) {
      initialAssetLoadedRef.current = initialAssetId;
      sceneController.addActor(initialAssetId).then((actorId) => {
        if (!actorId) setActorLoadError(true);
      }).catch((error) => {
        console.error("[animator] initial actor load failed", error);
        initialAssetLoadedRef.current = null;
        setActorLoadError(true);
      });
    }
  }, [initialAssetId, sceneController]);

  const handlePlayPause = () => {
    if (!isPlaying) setSoundUnlocked(true);
    if (isPlaying) sceneController.pauseAll();
    else sceneController.playAll();
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setTimeline(v);
    sceneController.seekAll(v * duration);
  };

  const handleSpeed = (v: number) => {
    setSpeed(v);
    sceneController.setGlobalSpeed(v);
  };

  const selectWorkspaceTool = (tool: typeof workspaceTool) => {
    setWorkspaceTool(tool);
    if (tool === "camera" || tool === "voice") setMode("scene");
    else setMode("cast");
    if (tool === "camera") setProMode(true);
  };

  const handleAddActor = (e: React.FormEvent) => {
    e.preventDefault();
    if (!addingAssetId) return;
    if (mobile && actors.length >= 2) {
      alert("Mobile devices are limited to 2 actors to preserve memory.");
      return;
    }
    sceneController.addActor(addingAssetId);
    setShowAddModal(false);
    setAddingAssetId("");
  };
  
  const [recordingId, setRecordingId] = useState<string | null>(null);

  useEffect(() => {
    if (!voiceoverJob || ["done", "failed"].includes(voiceoverJob.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/animator/voiceover-jobs/${voiceoverJob.jobId}`, { headers: { "Authorization": `Bearer ${getToken()}` } });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Voiceover status failed");
        if (!cancelled) setVoiceoverJob(payload);
      } catch (error: any) {
        if (!cancelled) setVoiceoverJob((current) => current ? { ...current, status: "failed", progress: 100, error: error.message } : current);
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [voiceoverJob?.jobId, voiceoverJob?.status]);

  const stopVoicePreview = () => {
    voicePreviewAbortRef.current?.abort();
    voicePreviewAbortRef.current = null;
    voicePreviewRef.current?.cancel();
    voicePreviewRef.current = null;
    setIsVoicePreviewRunning(false);
  };

  useEffect(() => () => {
    voicePreviewAbortRef.current?.abort();
    voicePreviewRef.current?.cancel();
  }, []);

  const handlePreviewVoice = async () => {
    if (!voiceoverText.trim() || !activeActorId) return;
    const root = sceneController.getActorRoot(activeActorId);
    if (!root) {
      alert("Add and select a rigged actor before previewing voice.");
      return;
    }

    stopVoicePreview();
    setIsVoicePreviewRunning(true);
    setVoicePreviewTier(null);
    const abortController = new AbortController();
    voicePreviewAbortRef.current = abortController;
    try {
      const handle = await playLiveActorSpeech({
        root,
        text: voiceoverText.trim(),
        signal: abortController.signal,
        onPlayer: (player) => sceneController.setActorLipSyncPlayer(activeActorId, player),
        onTier: setVoicePreviewTier,
        onEnd: () => {
          voicePreviewRef.current = null;
          setIsVoicePreviewRunning(false);
        },
      });
      voicePreviewRef.current = handle;
    } catch (error: any) {
      if (error?.name !== "AbortError") alert(`Voice preview failed: ${error.message}`);
      setIsVoicePreviewRunning(false);
    } finally {
      if (voicePreviewAbortRef.current === abortController) voicePreviewAbortRef.current = null;
    }
  };

  const handleGenerateVoiceover = async () => {
    if (!voiceoverText) return;
    setIsVoiceoverRunning(true);
    try {
      let currentRecordingId = recordingId;
      if (!currentRecordingId) {
        if (!captureSession.hasRecording) {
          alert("Please record a video first!");
          setIsVoiceoverRunning(false);
          return;
        }
        const data = await captureSession.saveToBackend();
        currentRecordingId = data.recordingId;
        setRecordingId(currentRecordingId);
      }

      const res = await fetch("/api/scenes/voiceover", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${getToken()}`
        },
        body: JSON.stringify({
          recordingId: currentRecordingId,
          text: voiceoverText
        })
      });
      const data = await res.json();
      if (!data.success) {
        alert("Failed: " + data.error);
      } else {
        setVoiceoverJob({ jobId: Number(data.jobId), status: data.status || "queued", progress: 20, error: null, resultUrl: null });
      }
    } catch (err: any) {
      alert("Error: " + err.message);
    } finally {
      setIsVoiceoverRunning(false);
    }
  };

  const handleApplyCast = async () => {
    if (!activeDirectorScript) return;
    try {
      setStudioNotice("Loading cast and preparing motion…");
      sceneController.dispose(); // clear existing actors
      const newMappedRoles: Record<string, string> = {};
      for (const role of activeDirectorScript.roles || []) {
        const avatarId = castAssignments[role.id];
        if (avatarId) {
          const avatar = userAvatars.find(a => String(a.id) === avatarId);
          const glbUrl = avatar ? resolveAvatarGlbUrl(avatar) : null;
          if (avatar && glbUrl) {
            const actorId = await sceneController.addActor(glbUrl, { label: avatar.name || role.name });
            if (actorId) newMappedRoles[role.id] = actorId;
          }
        }
      }
      if (Object.keys(newMappedRoles).length === 0) {
        setStudioNotice("Choose at least one ready rigged model for the script cast.");
        return;
      }
      if (activeDirectorScript.schemaVersion === "2") {
        const required = Array.isArray(activeDirectorScript.requiredCapabilities) ? activeDirectorScript.requiredCapabilities : [];
        for (const [roleId, actorId] of Object.entries(newMappedRoles)) {
          const controller = sceneController.getActorController(actorId);
          const available = new Set((controller?.listClips() || []).map((clip) => clip.name.toLowerCase().replace(/[_\s]+/g, "-")));
          const missing = required.filter((capability: string) => !available.has(capability.toLowerCase().replace(/[_\s]+/g, "-")));
          if (missing.length > 0) {
            sceneController.pauseAll();
            setMappedRoles({});
            setStudioNotice(`This cast is not compatible with ${activeDirectorScript.name}. Missing motion: ${missing.join(", ")}. Choose a ${activeDirectorScript.requiredSkeleton} rig that includes every required clip.`);
            return;
          }
          if (!activeDirectorScript.roleIds?.includes(roleId)) {
            setStudioNotice("This cast contains a role that the selected script does not declare.");
            return;
          }
        }
      }
      setMappedRoles(newMappedRoles);
      directorRuntimeRef.current = { scriptId: activeDirectorScript.id, lastTime: 0, clips: {} };
      sceneController.seekAll(0);
      sceneController.playAll();
      setSoundUnlocked(true);
      setTimeline(0);
      setIsPlaying(true);
      setStudioNotice("Script is playing. Motion is generated from the model rig and updated every frame.");
    } catch (error: any) {
      console.error("[Animator] Could not apply director cast", error);
      setStudioNotice(error?.message || "The script could not load this cast.");
    }
  };

  const selectDirectorScript = (script: any) => {
    if (!script || !Array.isArray(script.events) || !Array.isArray(script.roles)) {
      setStudioNotice("That script is incomplete and was not loaded.");
      return;
    }
    setActiveDirectorScript(script);
    setStudioNotice("Script selected. Confirm the cast, then choose Apply Cast & Play.");
    setActiveSequenceId("");
    directorRuntimeRef.current = { scriptId: script.id, lastTime: 0, clips: {} };
    const scriptEnvironmentId = script.environmentId || script.recommendedEnvironment;
    if (scriptEnvironmentId) {
      const environment = environments.find((candidate) => candidate.id === scriptEnvironmentId);
      if (environment) setActiveEnvId(environment.id);
    }
    const initialCast: Record<string, string> = {};
    (script.roles || []).forEach((role: any, index: number) => {
      if (userAvatars[index]) initialCast[role.id] = String(userAvatars[index].id);
    });
    setCastAssignments(initialCast);
  };

  const selectRandomVoiceScript = () => {
    if (scripts.length === 0) return;
    const script = scripts[Math.floor(Math.random() * scripts.length)];
    setVoiceoverText(script.text);
    if (activeController && script.suggestedClip) activeController.crossFadeTo(script.suggestedClip, 0.35);
  };

  const selectRandomDirectorScript = () => {
    const choices = visibleDirectorScripts.length > 0 ? visibleDirectorScripts : directorScripts;
    if (choices.length === 0) return;
    selectDirectorScript(choices[Math.floor(Math.random() * choices.length)]);
  };

  const handleApplyLibraryClip = async (clipData: any) => {
    if (!activeController || !activeActorId) return;
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(clipData.url);
      const srcClip = gltf.animations[0];
      if (!srcClip) return;
      
      const srcMesh = findSkinnedMesh(gltf.scene);
      const tgtRoot = sceneController.getActorRoot(activeActorId);
      const tgtMesh = tgtRoot ? findSkinnedMesh(tgtRoot) : null;
      
      if (srcMesh && tgtMesh) {
        const retargeted = retargetClip(tgtMesh, srcMesh, srcClip, clipData.skeleton);
        retargeted.name = clipData.id;
        activeController.addClip(retargeted);
        activeController.crossFadeTo(retargeted.name, 0.5);
      } else {
        alert("Could not find required SkinnedMesh to retarget.");
      }
    } catch (e: any) {
      alert("Failed to apply library animation: " + e.message);
    }
  };

  return (
    <AnimatorErrorBoundary hasWebGL2={webGL2} onClose={onClose}>
      <div className="relative z-0 flex h-[calc(100dvh-10rem)] min-h-[40rem] w-full flex-col overflow-hidden bg-black font-sans text-white md:h-[calc(100dvh-4rem)]">
          {actorLoadError && (
            <div role="status" className="absolute top-16 left-1/2 -translate-x-1/2 z-20 rounded-xl bg-amber-500/90 px-4 py-2 text-sm text-black shadow-lg">
              Couldn't load the selected model — the studio is still available
            </div>
          )}
          {studioNotice && (
            <button type="button" onClick={() => setStudioNotice("")} className="absolute left-1/2 top-16 z-30 max-w-[min(90vw,42rem)] -translate-x-1/2 rounded-xl border border-primary/40 bg-slate-950/95 px-4 py-2 text-left text-xs text-white shadow-xl">
              {studioNotice}
            </button>
          )}
          {/* Production workbench header — adapted from the supplied CELFORGE interface. */}
          <div className="absolute inset-x-0 top-0 z-30 flex h-14 items-center gap-2 border-b border-white/15 bg-slate-950/95 px-2 shadow-xl backdrop-blur-xl sm:px-4">
            <div className="flex min-w-0 items-center gap-2">
              <Clapperboard className="shrink-0 text-primary" size={20} />
              <div className="min-w-0">
                <h1 className="truncate text-sm font-black tracking-wide sm:text-base">3D Animation Builder</h1>
                <input
                  aria-label="Scene name"
                  value={sceneName}
                  onChange={(event) => setSceneName(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "_"))}
                  className="block w-32 bg-transparent font-mono text-[9px] text-white/45 outline-none sm:w-48"
                />
              </div>
            </div>

            <div className="ml-auto hidden items-center rounded-lg border border-white/10 bg-white/5 p-0.5 sm:flex">
              <button onClick={() => setMode("cast")} className={`min-h-9 px-3 text-[10px] font-black uppercase tracking-wider ${mode === "cast" ? "bg-primary text-on-primary" : "text-white/55 hover:text-white"}`}>Cast &amp; Rig</button>
              <button onClick={() => setMode("scene")} className={`min-h-9 px-3 text-[10px] font-black uppercase tracking-wider ${mode === "scene" ? "bg-primary text-on-primary" : "text-white/55 hover:text-white"}`}>Scene</button>
            </div>

            {onOpenVideoCreator && (
              <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onOpenVideoCreator(); }} aria-label="Back to Video Creator" title="Back to Video Creator" className="relative z-40 flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-lg border border-white/15 px-2 text-[10px] font-black uppercase tracking-wider text-white/70 hover:border-primary hover:text-primary md:px-3">
                <Wand2 size={13} /><span className="hidden md:inline">Video Creator</span>
              </button>
            )}
            <button
              type="button"
              onClick={captureSession.isRecording ? captureSession.stop : captureSession.start}
              disabled={!webCodecs}
              className="min-h-9 rounded-lg bg-primary px-3 text-[10px] font-black uppercase tracking-wider text-on-primary disabled:opacity-40"
            >
              {captureSession.isRecording ? "Stop" : "Render"}
            </button>
            <button onClick={onClose} aria-label="Back to Video Creator" title="Back to Video Creator" className="grid h-9 w-9 place-items-center rounded-lg hover:bg-white/10">
              <X size={18} />
            </button>
          </div>

          <aside className="absolute bottom-36 left-0 top-14 z-20 hidden w-16 flex-col border-r border-white/10 bg-slate-950/90 p-2 backdrop-blur md:flex">
            <span className="mb-2 text-center text-[8px] font-black uppercase tracking-widest text-white/35">Tools</span>
            {([
              ["select", "Select", MousePointer2],
              ["move", "Move", Move3D],
              ["rotate", "Rotate", Rotate3D],
              ["scale", "Scale", Scaling],
              ["camera", "Camera", Camera],
              ["rig", "Rig", Bone],
              ["voice", "Voice", Mic],
            ] as const).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => selectWorkspaceTool(id)}
                title={label}
                aria-label={`${label} tool`}
                className={`mb-1 grid min-h-11 place-items-center rounded-lg border transition ${workspaceTool === id ? "border-primary bg-primary text-on-primary" : "border-transparent text-white/55 hover:border-white/20 hover:text-white"}`}
              >
                <Icon size={18} />
              </button>
            ))}
            <span className="mt-auto text-center font-mono text-[8px] uppercase text-white/30">{workspaceTool}</span>
          </aside>

          {/* 3D Viewport */}
          <div className="absolute bottom-36 left-0 right-0 top-14 md:left-16">
            {contextLost && (
              <div className="absolute inset-0 z-40 bg-black/80 flex items-center justify-center text-white p-6 text-center" onClick={() => setContextLost(false)}>
                <div>
                  <h2 className="text-xl font-bold mb-2">Graphics Context Lost</h2>
                  <p className="text-white/60 mb-4">The device ran out of graphics memory or the app went to the background.</p>
                  <p className="text-sm font-bold text-primary animate-pulse">Tap anywhere to resume</p>
                </div>
              </div>
            )}
            <Canvas 
              ref={canvasRef}
              camera={{ 
                position: cameraState.position, 
                fov: cameraState.fov 
              }}
              gl={{
                toneMapping: (React as any).useMemo(() => (THREE as any)[ANIMATOR_DEFAULTS.renderer.toneMapping], []),
                outputColorSpace: ANIMATOR_DEFAULTS.renderer.outputColorSpace,
                powerPreference: "high-performance",
                failIfMajorPerformanceCaveat: false,
                antialias: !mobile
              }}
              dpr={mobile ? [1, 1.5] : [1, ANIMATOR_DEFAULTS.renderer.dprMax]}
              shadows={{ type: ANIMATOR_DEFAULTS.renderer.shadowMapType as any }}
              onCreated={({ camera, gl }) => { 
                cameraRef.current = camera as THREE.PerspectiveCamera; 
                gl.domElement.addEventListener("webglcontextlost", (e) => {
                  e.preventDefault();
                  setContextLost(true);
                  if (isPlaying) {
                    sceneController.pauseAll();
                    setIsPlaying(false);
                  }
                });
                gl.domElement.addEventListener("webglcontextrestored", () => {
                  setContextLost(false);
                });
              }}
            >
              <Viewport 
                sceneController={sceneController} 
                environment={activeEnv}
                weather={weather}
                cameraState={cameraState}
                soundMuted={soundMuted}
                soundUnlocked={soundUnlocked}
                soundReady={isPlaying}
                lightTarget={lightTarget}
                soundCue={soundTarget}
                ikOptions={ikOptions}
                proMode={proMode}
                cameraObj={cameraObj}
              />
            </Canvas>
            {showViewerGrid && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 opacity-20"
                style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.18) 1px, transparent 1px)", backgroundSize: "40px 40px" }}
              />
            )}
            {showSafeArea && <div aria-hidden="true" className="pointer-events-none absolute inset-[8%] border border-dashed border-white/35" />}
          </div>

      {/* HUD Overlays */}
      <div className="absolute bottom-0 left-0 right-0 flex flex-col gap-3 p-2 pointer-events-none md:left-16 md:p-3">
        
        {/* Middle HUD */}
        <div className="flex justify-between items-end w-full max-w-7xl mx-auto">
          
          {mode === "cast" && (
            <>
              {/* Actors Panel */}
              <div className="bg-black/60 backdrop-blur-md rounded-2xl border border-white/10 p-4 flex flex-col gap-3 pointer-events-auto min-w-[200px]">
                <div className="flex justify-between items-center mb-1">
                  <h3 className="text-xs font-bold text-white/60 uppercase tracking-wider flex items-center gap-1">
                    <List size={12} /> Cast
                  </h3>
                  <button onClick={() => setShowAddModal(true)} className="hover:text-primary transition-colors">
                    <Plus size={16} />
                  </button>
                </div>
                
                <div className="flex flex-col gap-1 max-h-[30vh] overflow-y-auto">
                  {actors.length === 0 && <span className="text-xs text-white/40 italic">Empty Stage</span>}
                  {actors.map((actor) => (
                    <div 
                      key={actor.actorId} 
                      className={`flex justify-between items-center p-2 rounded-lg cursor-pointer transition-colors ${activeActorId === actor.actorId ? 'bg-primary/20 border border-primary/50' : 'hover:bg-white/5 border border-transparent'}`}
                      onClick={() => sceneController.setActiveActor(actor.actorId)}
                    >
                      <span className="text-sm font-medium truncate max-w-[120px]">{actor.label}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); sceneController.removeActor(actor.actorId); }}
                        className="opacity-50 hover:opacity-100 hover:text-error"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                
                <h3 className="text-xs font-bold text-white/60 uppercase tracking-wider mt-2 border-t border-white/10 pt-3">Objects</h3>
                <div className="flex flex-wrap gap-2 max-h-[15vh] overflow-y-auto pb-1">
                  {ALL_OBJECT_KINDS.map(kind => {
                    const def = OBJECT_CATALOG[kind];
                    return (
                      <button
                        key={kind}
                        onClick={() => {
                          if (!def.glbUrl) return;
                          if (mobile && actors.length >= 2) {
                            alert("Mobile devices are limited to 2 actors to preserve memory.");
                            return;
                          }
                          sceneController.addActor(def.glbUrl, { label: def.label });
                        }}
                        className="w-10 h-10 bg-white/5 hover:bg-white/20 rounded-lg flex items-center justify-center text-xl transition-colors border border-transparent hover:border-primary/50"
                        title={def.label}
                      >
                        {def.emoji}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Clips Panel */}
              {activeController && (
                <div className="bg-black/60 backdrop-blur-md rounded-2xl border border-white/10 p-4 flex flex-col gap-3 pointer-events-auto max-w-[300px] max-h-[40vh] overflow-y-auto">
                  <div className="flex justify-between items-center mb-1">
                    <h3 className="text-xs font-bold text-white/60 uppercase tracking-wider">Animations</h3>
                    {false /* Hidden until retargeting pipeline is wired */ && (
                      <button 
                        className="text-[10px] bg-primary/20 text-primary px-2 py-1 rounded-md hover:bg-primary/40 transition-colors"
                        title="Generate more animations (1 Credit)"
                      >
                        + More (1 🪙)
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {activeController.listClips().map((clip) => (
                      <button
                        key={clip.name}
                        onClick={() => { setActiveSequenceId(""); activeController.selectClip(clip.name); }}
                        className="text-xs px-3 py-1.5 rounded-full bg-white/10 hover:bg-primary/40 border border-white/5 transition-all text-left truncate max-w-full"
                        title={clip.name}
                      >
                        {clip.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              
              {/* IK Panel */}
              {activeController && activeActorId && (
                <div className="bg-black/60 backdrop-blur-md rounded-2xl border border-white/10 p-4 flex flex-col gap-3 pointer-events-auto w-[250px]">
                  <h3 className="text-xs font-bold text-white/60 uppercase tracking-wider">IK Controls</h3>
                  <div className="flex flex-col gap-2">
                    <label className="flex justify-between text-xs items-center">
                      <span className="text-white font-medium">Ground IK (Planted Feet)</span>
                      <input 
                        type="checkbox" 
                        checked={ikOptions[activeActorId]?.groundIK || false}
                        onChange={(e) => setIkOptions(prev => ({
                          ...prev,
                          [activeActorId]: { ...prev[activeActorId], groundIK: e.target.checked }
                        }))}
                        className="accent-primary"
                      />
                    </label>
                    <label className="flex justify-between text-xs items-center">
                      <span className="text-white font-medium">Look at Camera</span>
                      <input 
                        type="checkbox" 
                        checked={ikOptions[activeActorId]?.lookAtCamera || false}
                        onChange={(e) => setIkOptions(prev => ({
                          ...prev,
                          [activeActorId]: { ...prev[activeActorId], lookAtCamera: e.target.checked }
                        }))}
                        className="accent-primary"
                      />
                    </label>
                  </div>
                </div>
              )}
              
              {/* Library Clips Panel */}
              {activeController && libraryClips.length > 0 && (
                <div className="bg-black/60 backdrop-blur-md rounded-2xl border border-white/10 p-4 flex flex-col gap-3 pointer-events-auto max-w-[300px] max-h-[30vh] overflow-y-auto">
                  <h3 className="text-xs font-bold text-white/60 uppercase tracking-wider">Library Animations</h3>
                  <div className="flex flex-wrap gap-2">
                    {libraryClips.map((clip) => (
                      <button
                        key={clip.id}
                        onClick={() => handleApplyLibraryClip(clip)}
                        className="text-xs px-3 py-1.5 rounded-full bg-primary/20 hover:bg-primary/40 text-primary border border-primary/20 transition-all text-left truncate max-w-full"
                        title={clip.description}
                      >
                        + {clip.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              
              {/* Morph Targets Panel */}
              {activeController && Object.keys(morphInfluences).length > 0 && (
                <div className="bg-black/60 backdrop-blur-md rounded-2xl border border-white/10 p-4 flex flex-col gap-3 pointer-events-auto w-[250px] max-h-[40vh] overflow-y-auto">
                  <h3 className="text-xs font-bold text-white/60 uppercase tracking-wider">Morph Targets</h3>
                  <div className="flex flex-col gap-2">
                    {Object.keys(morphInfluences).map(morph => (
                      <div key={morph} className="flex flex-col gap-1">
                        <div className="flex justify-between text-xs">
                          <span>{morph}</span>
                          <span className="text-white/40">{morphInfluences[morph].toFixed(2)}</span>
                        </div>
                        <input 
                          type="range" min="0" max="1" step="0.01" 
                          value={morphInfluences[morph]} 
                          onChange={(e) => handleMorphChange(morph, parseFloat(e.target.value))}
                          className="accent-primary"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {mode === "scene" && (
            <div className="flex gap-4 items-end pointer-events-none">
              {/* Environment & Weather Panel */}
              <div className="bg-black/60 backdrop-blur-md rounded-2xl border border-white/10 p-4 flex flex-col gap-3 pointer-events-auto w-[250px]">
                <h3 className="text-xs font-bold text-white/60 uppercase tracking-wider flex items-center gap-1">
                  <Sun size={12} /> Environments
                </h3>
                <div className="grid grid-cols-2 gap-2 max-h-[20vh] overflow-y-auto">
                  <button 
                    onClick={() => setActiveEnvId("")}
                    className={`text-xs p-2 rounded-xl text-center border transition-all ${activeEnvId === "" ? 'bg-primary/30 border-primary' : 'bg-white/5 border-transparent hover:bg-white/10'}`}
                  >
                    Default
                  </button>
                  {environments.map(env => (
                    <button 
                      key={env.id}
                      onClick={() => setActiveEnvId(env.id)}
                      className={`text-xs p-2 rounded-xl text-center border transition-all truncate ${activeEnvId === env.id ? 'bg-primary/30 border-primary' : 'bg-white/5 border-transparent hover:bg-white/10'}`}
                    >
                      {env.label || env.name}
                    </button>
                  ))}
                </div>
                
                <h3 className="text-xs font-bold text-white/60 uppercase tracking-wider flex items-center gap-1 mt-2">
                  <CloudRain size={12} /> Weather
                </h3>
                <select 
                  value={weather}
                  onChange={(e) => setWeather(e.target.value as WeatherType)}
                  className="bg-black/50 border border-white/20 rounded-xl p-2 text-xs outline-none focus:border-primary w-full"
                >
                  <option value="clear">Clear</option>
                  <option value="rain">Rain</option>
                  <option value="snow">Snow</option>
                  <option value="fog">Fog</option>
                  <option value="overcast">Overcast</option>
                </select>
                
                <button 
                  onClick={() => { setSoundUnlocked(true); setSoundMuted(!soundMuted); }}
                  className={`flex items-center gap-2 text-xs p-2 rounded-xl justify-center transition-colors border ${soundMuted ? 'bg-red-500/20 border-red-500 text-red-400' : 'bg-white/10 border-transparent hover:bg-white/20'}`}
                >
                  {soundMuted ? <VolumeX size={14} /> : <Volume2 size={14} />} 
                  {soundMuted ? "Sound Muted" : "Sound Enabled"}
                </button>
              </div>

                {/* Sequences & Voiceover Panel */}
                <div className="bg-black/60 backdrop-blur-md rounded-2xl border border-white/10 p-4 flex flex-col gap-3 pointer-events-auto w-[300px]">
                  <h3 className="text-xs font-bold text-white/60 uppercase tracking-wider">Sequences</h3>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setActiveSequenceId("")}
                      className={`text-xs px-3 py-1.5 rounded-full border transition-all ${activeSequenceId === "" ? 'bg-primary/40 border-primary' : 'bg-white/10 border-white/5 hover:bg-white/20'}`}
                    >
                      Free Play
                    </button>
                    {ANIMATOR_DEFAULTS.sequences.map(seq => (
                      <button
                        key={seq.id}
                        onClick={() => setActiveSequenceId(seq.id)}
                        className={`text-xs px-3 py-1.5 rounded-full border transition-all ${activeSequenceId === seq.id ? 'bg-primary/40 border-primary' : 'bg-white/10 border-white/5 hover:bg-white/20'}`}
                      >
                        {seq.name}
                      </button>
                    ))}
                  </div>

                  <div className="w-full h-px bg-white/10 my-1"></div>
                  
                  <h3 className="text-xs font-bold text-white/60 uppercase tracking-wider flex items-center gap-1">
                    <Mic size={12} /> Voiceover
                  </h3>
                  <textarea 
                    value={voiceoverText}
                    onChange={(e) => setVoiceoverText(e.target.value)}
                    placeholder="Enter script here..."
                    className="bg-black/50 border border-white/20 rounded-xl p-2 text-xs outline-none focus:border-primary w-full h-16 resize-none"
                  />
                  <div className="flex justify-between items-center gap-2">
                    <select 
                      onChange={(e) => setVoiceoverText(e.target.value)}
                      className="bg-transparent border-none text-xs text-white/60 outline-none w-24"
                      value=""
                    >
                      <option value="" disabled>Presets...</option>
                      {scripts.map(s => (
                        <option key={s.id} value={s.text}>{s.title}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={selectRandomVoiceScript}
                      disabled={scripts.length === 0}
                      title="Choose a different voice script"
                      className="bg-white/10 text-white text-[10px] font-bold px-2.5 py-1.5 rounded-full disabled:opacity-50 hover:bg-white/20 transition-colors"
                    >
                      <Shuffle size={11} className="inline mr-1" /> Surprise me
                    </button>
                    <div className="flex gap-1.5">
                      <button
                        onClick={isVoicePreviewRunning ? stopVoicePreview : handlePreviewVoice}
                        disabled={!isVoicePreviewRunning && (!voiceoverText || !activeActorId)}
                        title={`Live voice preview uses ${CREDIT_PRICES.AI_VOICE_30_SECONDS} credits for non-admin users`}
                        className="bg-white/15 text-white text-[10px] font-bold px-2.5 py-1.5 rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {isVoicePreviewRunning ? "Stop Preview" : `Preview (${CREDIT_PRICES.AI_VOICE_30_SECONDS})`}
                        {voicePreviewTier ? ` · Tier ${voicePreviewTier}` : ""}
                      </button>
                      <button
                        onClick={handleGenerateVoiceover}
                        disabled={isVoiceoverRunning || !voiceoverText}
                        className="bg-primary text-on-primary text-xs font-bold px-3 py-1.5 rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {isVoiceoverRunning ? "Queueing..." : "Generate voiced video"}
                      </button>
                    </div>
                  </div>
                  {voiceoverJob && (
                    <div role="status" className="rounded-xl border border-white/15 bg-black/35 p-2 text-[10px] text-white/75">
                      {voiceoverJob.status === "failed" ? (
                        <span className="text-red-300">Voiced export failed: {voiceoverJob.error || "Unknown error"}</span>
                      ) : voiceoverJob.status === "done" && voiceoverJob.resultUrl ? (
                        <div className="space-y-2">
                          <span className="font-bold text-emerald-300">Verified voiced video ready</span>
                          <video src={voiceoverJob.resultUrl} controls playsInline className="w-full rounded-lg bg-black" />
                          <a href={voiceoverJob.resultUrl} download className="block rounded-lg bg-primary px-3 py-2 text-center font-bold text-on-primary">Download voiced video</a>
                        </div>
                      ) : (
                        <div>
                          <span>Voiced export {voiceoverJob.status} · {voiceoverJob.progress}%</span>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-primary" style={{ width: `${voiceoverJob.progress}%` }} /></div>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="w-full h-px bg-white/10 my-1"></div>

                  <h3 className="text-xs font-bold text-white/60 uppercase tracking-wider flex items-center justify-between">
                    <span>Camera Bookmarks</span>
                    <button onClick={saveBookmark} className="hover:text-primary transition-colors text-white/60">
                      <Plus size={14} />
                    </button>
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {bookmarks.length === 0 && <span className="text-[10px] text-white/40">No bookmarks saved</span>}
                    {bookmarks.map((b, i) => (
                      <button 
                        key={b.id}
                        onClick={() => setCameraState({ position: b.position, fov: b.fov })}
                        className="text-xs px-2 py-1 bg-white/10 hover:bg-white/20 rounded border border-transparent"
                      >
                        {b.name}
                      </button>
                    ))}
                  </div>
                </div>
                
                {/* Director Scripts Panel */}
                <div className="bg-black/60 backdrop-blur-md rounded-2xl border border-white/10 p-4 flex flex-col gap-3 pointer-events-auto min-w-[200px]">
                  <h3 className="text-xs font-bold text-white/60 uppercase tracking-wider flex items-center gap-1">
                    <Play size={12} /> Director Scripts ({directorScripts.length})
                  </h3>
                  <div className="flex gap-2">
                    <input
                      value={directorSearch}
                      onChange={(event) => setDirectorSearch(event.target.value)}
                      placeholder="Find a scene..."
                      aria-label="Search director scripts"
                      className="min-w-0 flex-1 bg-black/50 border border-white/20 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      onClick={selectRandomDirectorScript}
                      disabled={directorScripts.length === 0}
                      title="Choose a fresh scene"
                      className="rounded-lg bg-primary/20 px-2 text-primary hover:bg-primary/40 disabled:opacity-50"
                    >
                      <Shuffle size={14} />
                    </button>
                  </div>
                  <div className="flex flex-col gap-1 max-h-[30vh] overflow-y-auto">
                    {visibleDirectorScripts.length === 0 && <span className="text-xs text-white/40 italic">No scripts found.</span>}
                    {visibleDirectorScripts.map(script => (
                      <div 
                        key={script.id}
                        onClick={() => selectDirectorScript(script)}
                        className={`p-2 rounded-lg cursor-pointer text-sm font-medium transition-colors ${activeDirectorScript?.id === script.id ? 'bg-primary/20 text-primary border border-primary/50' : 'hover:bg-white/5 border border-transparent'}`}
                      >
                        <div>{script.name}</div>
                        <div className="text-[10px] font-normal text-white/40 mt-0.5">{script.category}</div>
                      </div>
                    ))}
                  </div>
                  {activeDirectorScript && activeDirectorScript.roles && activeDirectorScript.roles.length > 0 && (
                    <div className="mt-2 p-3 bg-white/5 rounded-xl border border-white/10 flex flex-col gap-2">
                      <h4 className="text-xs font-bold text-white/60 uppercase">Cast Assignments</h4>
                      {activeDirectorScript.roles.map((role: any) => (
                        <div key={role.id} className="flex justify-between items-center text-xs">
                          <span className="text-white font-medium">{role.name}</span>
                          <select 
                            className="bg-black/50 border border-white/20 rounded p-1 text-white max-w-[120px]"
                            value={castAssignments[role.id] || ""}
                            onChange={(e) => setCastAssignments(prev => ({ ...prev, [role.id]: e.target.value }))}
                          >
                            <option value="">(Skip Role)</option>
                            {userAvatars.map(a => (
                              <option key={a.id} value={a.id}>{a.name}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                      <button 
                        onClick={handleApplyCast}
                        className="mt-2 w-full py-1.5 bg-primary text-on-primary font-bold rounded-lg text-xs"
                      >
                        Apply Cast & Play
                      </button>
                    </div>
                  )}
                </div>
              </div>
          )}
        </div>

        {/* Timeline + transport, using the supplied workstation's three editing views. */}
        <div className="pointer-events-auto mx-auto flex w-full max-w-7xl flex-col overflow-hidden rounded-xl border border-white/15 bg-slate-950/95 shadow-2xl backdrop-blur-xl">
          <div className="flex min-h-9 items-center gap-1 border-b border-white/10 px-2">
            {(["timeline", "dope", "xsheet"] as const).map((view) => (
              <button key={view} type="button" onClick={() => setTimelineView(view)} className={`min-h-8 px-3 text-[9px] font-black uppercase tracking-widest ${timelineView === view ? "bg-primary text-on-primary" : "text-white/45 hover:text-white"}`}>
                {view === "dope" ? "Dope Sheet" : view === "xsheet" ? "X-Sheet" : "Timeline"}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1">
              <select aria-label="Timeline frames per second" value={timelineFps} onChange={(event) => setTimelineFps(Number(event.target.value) as 12 | 24 | 30)} className="h-8 rounded border border-white/10 bg-white/5 px-2 text-[9px] font-bold text-white outline-none">
                <option value={12} className="bg-slate-900">12 FPS</option>
                <option value={24} className="bg-slate-900">24 FPS</option>
                <option value={30} className="bg-slate-900">30 FPS</option>
              </select>
              <button type="button" onClick={() => setShowViewerGrid((value) => !value)} aria-pressed={showViewerGrid} title="Toggle grid" className={`grid h-8 w-8 place-items-center rounded border ${showViewerGrid ? "border-primary bg-primary text-on-primary" : "border-white/10 text-white/45"}`}><Grid3X3 size={13} /></button>
              <button type="button" onClick={() => setShowSafeArea((value) => !value)} aria-pressed={showSafeArea} title="Toggle safe area" className={`grid h-8 w-8 place-items-center rounded border ${showSafeArea ? "border-primary bg-primary text-on-primary" : "border-white/10 text-white/45"}`}><ShieldCheck size={13} /></button>
              <button type="button" onClick={() => setLoopPlayback((value) => !value)} aria-pressed={loopPlayback} title="Toggle loop" className={`grid h-8 w-8 place-items-center rounded border ${loopPlayback ? "border-primary bg-primary text-on-primary" : "border-white/10 text-white/45"}`}><Repeat2 size={13} /></button>
            </div>
          </div>

          <div className="hidden grid-cols-[132px_minmax(0,1fr)] border-b border-white/10 sm:grid">
            <div className="border-r border-white/10 px-3 py-2 font-mono text-[9px] uppercase text-white/45">
              {timelineView === "timeline" ? (actors[0]?.label || "Empty stage") : timelineView === "dope" ? `${Math.max(actors.length, 1)} channels` : `Frame ${String(Math.round(timeline * duration * timelineFps) + 1).padStart(3, "0")}`}
            </div>
            <div className="relative h-9 overflow-hidden bg-white/[.025]" style={{ backgroundImage: "linear-gradient(90deg, rgba(255,255,255,.1) 1px, transparent 1px)", backgroundSize: "10% 100%" }}>
              {[0, 0.18, 0.42, 0.68, 1].map((position, index) => (
                <button key={position} type="button" aria-label={`Go to keyframe ${index + 1}`} onClick={() => { setTimeline(position); sceneController.seekAll(position * duration); }} className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-primary bg-slate-950" style={{ left: `${position * 100}%` }} />
              ))}
              <div className="pointer-events-none absolute inset-y-0 w-px bg-primary shadow-[0_0_8px_currentColor]" style={{ left: `${timeline * 100}%` }} />
            </div>
          </div>

          <div className="flex items-center gap-2 p-2 sm:gap-4">
            <button onClick={handlePlayPause} aria-label={isPlaying ? "Pause timeline" : "Play timeline"} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary text-on-primary transition active:scale-95">
              {isPlaying ? <Pause size={18} className="fill-current" /> : <Play size={18} className="ml-0.5 fill-current" />}
            </button>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <input type="range" min="0" max="1" step="0.001" value={timeline} onChange={handleSeek} aria-label="Timeline position" className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/20 accent-primary" />
              <div className="flex justify-between font-mono text-[9px] text-white/40"><span>{(timeline * duration).toFixed(2)}s</span><span>{duration.toFixed(2)}s</span></div>
            </div>
            <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1">
              <FastForward size={13} className="text-white/50" />
              <select value={speed} onChange={(event) => handleSpeed(parseFloat(event.target.value))} aria-label="Playback speed" className="bg-transparent text-[10px] font-bold text-white outline-none">
                <option value={0.5} className="bg-slate-900">0.5x</option><option value={1} className="bg-slate-900">1.0x</option><option value={1.5} className="bg-slate-900">1.5x</option><option value={2} className="bg-slate-900">2.0x</option>
              </select>
            </div>
            {webCodecs && captureSession.hasRecording && !captureSession.isRecording && <button onClick={captureSession.download} className="hidden min-h-9 items-center gap-1.5 rounded-lg bg-secondary px-3 text-[10px] font-black uppercase sm:flex"><Download size={14} /> Save</button>}
            {webCodecs && <button onClick={captureSession.isRecording ? captureSession.stop : captureSession.start} className={`hidden min-h-9 items-center gap-1.5 rounded-lg px-3 text-[10px] font-black uppercase sm:flex ${captureSession.isRecording ? "bg-white text-red-600" : "bg-red-600 text-white"}`}>{captureSession.isRecording ? <Square size={14} className="fill-current" /> : <Video size={14} />}{captureSession.isRecording ? "Stop" : "Record"}</button>}
          </div>
        </div>
      </div>

      {/* Add Actor Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <form onSubmit={handleAddActor} className="bg-slate-900 rounded-3xl p-6 w-full max-w-sm border border-white/10 shadow-2xl">
            <h2 className="text-lg font-bold mb-4">Add Model to Stage</h2>
            
            <div className="flex flex-col gap-2 mb-6 max-h-[40vh] overflow-y-auto">
              {userAvatars.length === 0 ? (
                <div className="text-white/40 text-sm italic text-center p-4 bg-black/20 rounded-xl">No ready avatars found.</div>
              ) : (
                userAvatars.map(avatar => (
                  <div 
                    key={avatar.id}
                    onClick={() => {
                      const url = resolveAvatarGlbUrl(avatar);
                      if (!url) return;
                      if (mobile && actors.length >= 2) {
                        alert("Mobile devices are limited to 2 actors to preserve memory.");
                        return;
                      }
                      sceneController.addActor(url, { label: avatar.name });
                      setShowAddModal(false);
                      setAddingAssetId("");
                    }}
                    className="flex items-center gap-3 p-3 bg-black/40 hover:bg-black/60 rounded-xl cursor-pointer transition-colors border border-transparent hover:border-primary/50"
                  >
                    {avatar.imageUrl ? (
                      <img src={avatar.imageUrl} alt="" className="w-10 h-10 rounded-lg object-cover bg-black" />
                    ) : (
                      <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center text-xs">No img</div>
                    )}
                    <span className="font-medium text-sm flex-1 truncate">{avatar.name}</span>
                    <Plus size={16} className="text-white/40 group-hover:text-primary" />
                  </div>
                ))
              )}
            </div>

            <details className="mb-6 group">
              <summary className="text-xs text-white/40 hover:text-white cursor-pointer select-none mb-2 outline-none">
                Advanced: Paste URL
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                <input 
                  type="text" 
                  placeholder="Asset ID or GLB URL..." 
                  value={addingAssetId}
                  onChange={(e) => setAddingAssetId(e.target.value)}
                  className="w-full bg-black/50 border border-white/20 rounded-xl p-3 text-sm outline-none focus:border-primary transition-colors"
                />
                <button 
                  type="submit"
                  className="px-4 py-2 rounded-xl text-sm font-bold bg-white/10 text-white hover:bg-white/20 transition-colors self-end"
                >
                  Add Custom
                </button>
              </div>
            </details>

            <div className="flex gap-3 justify-between items-center">
              <label className="flex items-center gap-2 text-xs font-bold bg-black/60 px-3 py-1.5 rounded-full border border-white/10 pointer-events-auto">
                <span className="text-white/60">PRO MODE</span>
                <input type="checkbox" checked={proMode} onChange={e => setProMode(e.target.checked)} className="accent-primary" />
              </label>
              <button 
                type="button" 
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 rounded-xl text-sm font-bold text-white/60 hover:text-white transition-colors"
              >
                Close
              </button>
            </div>
          </form>
        </div>
      )}
      </div>
    </AnimatorErrorBoundary>
  );
}
