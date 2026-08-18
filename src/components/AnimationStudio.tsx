import React, { useMemo, useState } from "react";
import { Download, Film, ImagePlus, RefreshCw, Sparkles, Wand2, X } from "lucide-react";
import { Creation, UserProfile } from "../types";
import { addUserPhoto, createVideo, pollJob } from "../api";
import { AI_VIDEO_SCRIPTS, DEFAULT_AI_VIDEO_SCRIPT, type AiVideoScriptTemplate } from "../aiVideoScripts";
import { VideoTeachingPanel, isVideoStudioV2Enabled } from "./video/VideoTeachingPanel";
import { animatedVideoCost } from "../pricing";

interface AnimationStudioProps {
  creations: Creation[];
  userProfile: UserProfile;
  onOpenCreditStore: () => void;
  onClose: () => void;
  onCreationsChanged?: () => Promise<void> | void;
}

type EditableScript = AiVideoScriptTemplate;
type ScriptMode = "template" | "custom";

function editable(template: AiVideoScriptTemplate): EditableScript {
  return { ...template, stageDirections: [...template.stageDirections] };
}

function buildCustomScript(title: string, description: string): EditableScript {
  return {
    ...DEFAULT_AI_VIDEO_SCRIPT,
    id: "custom",
    title: title.trim() || "Custom Scene",
    genre: "cinematic pet portrait",
    motions: description.trim() || DEFAULT_AI_VIDEO_SCRIPT.motions,
    stageDirections: [
      description.trim() || DEFAULT_AI_VIDEO_SCRIPT.stageDirections[0],
      DEFAULT_AI_VIDEO_SCRIPT.stageDirections[1],
      DEFAULT_AI_VIDEO_SCRIPT.stageDirections[2],
      DEFAULT_AI_VIDEO_SCRIPT.stageDirections[3],
    ],
  };
}

/** Customer guided video generation: a directed script, never a manual timeline editor. */
export default function AnimationStudio({ creations, userProfile, onOpenCreditStore, onClose, onCreationsChanged }: AnimationStudioProps) {
  const images = useMemo(() => creations.filter((creation) => creation.image_url), [creations]);
  const [selectedId, setSelectedId] = useState<number | null>(images[0]?.id ?? null);
  const [scriptMode, setScriptMode] = useState<ScriptMode>("template");
  const [script, setScript] = useState<EditableScript>(() => editable(DEFAULT_AI_VIDEO_SCRIPT));
  const [customTitle, setCustomTitle] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [aspect, setAspect] = useState<"16:9" | "9:16">("9:16");
  const [duration, setDuration] = useState<8 | 15>(8);
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadMessage, setUploadMessage] = useState("");

  const cost = animatedVideoCost(duration);
  const canAfford = userProfile.isAdmin || (userProfile.credits ?? 0) >= cost;
  const selected = images.find((creation) => creation.id === selectedId) || null;

  const activeScript = scriptMode === "custom"
    ? buildCustomScript(customTitle, customDescription)
    : script;

  const uploadAnotherPhoto = async (file: File | undefined) => {
    if (!file) return;
    setUploadMessage("");
    if (!/^image\/(?:png|jpe?g|webp)$/i.test(file.type) || file.size > 20 * 1024 * 1024) {
      setUploadMessage("Choose a PNG, JPEG, or WebP photo smaller than 20 MB.");
      return;
    }
    try {
      const image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("The photo could not be read."));
        reader.readAsDataURL(file);
      });
      await addUserPhoto(image);
      setUploadMessage("Photo saved to your account. Create a portrait from it, then it will appear here for animation.");
    } catch (caught: any) {
      setUploadMessage(caught?.message || "The photo could not be uploaded.");
    }
  };

  const selectTemplate = (templateId: string) => {
    const template = AI_VIDEO_SCRIPTS.find((candidate) => candidate.id === templateId) || DEFAULT_AI_VIDEO_SCRIPT;
    setScript(editable(template));
  };

  // v2 teaching panel handlers. A sample fills the whole script; an idea chip
  // touches only Setting and Characters, so a customer who has already tuned
  // lighting, camera and beats does not lose that work to a single tap.
  const applyTeachingSample = (sample: { sections: { id: string; text: string }[] }) => {
    const byId = Object.fromEntries(sample.sections.map((section) => [section.id, section.text]));
    setScript((current) => ({
      ...current,
      setting: byId.setting ?? current.setting,
      characters: byId.characters ?? current.characters,
      motions: byId.motions ?? current.motions,
      lighting: byId.lighting ?? current.lighting,
      filter: byId.filter ?? current.filter,
      camera: byId.camera ?? current.camera,
      // The annotated sample states its beats as one arrow-joined line; split
      // it back into the four fields the form actually holds.
      stageDirections: (() => {
        const beats = String(byId.stageDirections || "").split("→").map((beat) => beat.trim()).filter(Boolean);
        return beats.length === 4
          ? (beats as [string, string, string, string])
          : current.stageDirections;
      })(),
    }));
  };

  const applyTeachingIdea = (idea: { setting: string; characters: string }) => {
    setScript((current) => ({ ...current, setting: idea.setting, characters: idea.characters }));
  };

  const updateStageDirection = (index: number, value: string) => {
    const directions = [...script.stageDirections] as [string, string, string, string];
    directions[index] = value;
    setScript((current) => ({ ...current, stageDirections: directions }));
  };

  const generate = async () => {
    if (!selected) { setError("Pick an image to animate first."); return; }
    if (!canAfford) { onOpenCreditStore(); return; }
    setError(null);
    setResultUrl(null);
    setStatus("generating");
    try {
      const { jobId } = await createVideo(selected.id, activeScript, aspect, duration);
      for (let attempt = 0; attempt < 150; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        try {
          const job = await pollJob(jobId);
          if (job.status === "done" && job.video_url) {
            setResultUrl(job.video_url);
            setStatus("done");
            await onCreationsChanged?.();
            return;
          }
          if (job.status === "failed") throw new Error(job.error || "Video generation failed.");
        } catch (pollError: any) {
          if (pollError?.message && /failed/i.test(pollError.message)) throw pollError;
        }
      }
      throw new Error("This is taking longer than expected. Your tracked job can continue in the background.");
    } catch (generationError: any) {
      setError(generationError?.message || "Could not create the animation.");
      setStatus("error");
    }
  };

  const field = (label: string, key: keyof Pick<EditableScript, "setting" | "characters" | "motions" | "lighting" | "filter" | "camera">, rows = 2) => (
    <label className="block text-xs font-bold text-on-surface">
      {label}
      <textarea
        value={script[key]}
        onChange={(event) => setScript((current) => ({ ...current, [key]: event.target.value }))}
        rows={rows}
        className="mt-1 w-full rounded-xl border border-outline-variant/50 bg-surface px-3 py-2 text-sm font-normal text-on-surface"
      />
    </label>
  );

  return (
    <main data-creative-dashboard="true" className="h-[calc(100dvh-4rem)] w-full overflow-hidden lg:overflow-hidden bg-background p-2 text-on-background sm:p-3" aria-labelledby="ai-video-title">
      <header className="mx-auto mb-2 grid max-w-[1720px] shrink-0 gap-2 xl:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-outline-variant/25 bg-surface/90 px-4 py-2 shadow-sm">
          <Film size={22} className="shrink-0 text-primary" />
          <div className="min-w-0"><h1 id="ai-video-title" className="truncate text-lg font-black text-on-surface">Fur Reels</h1><p className="truncate text-xs text-on-surface-variant">Direct a pet story with picture, motion, and natural sound.</p></div>
          <button type="button" onClick={onClose} className="ml-auto rounded-full p-2 text-on-surface-variant hover:text-primary" aria-label="Close"><X size={20} /></button>
        </div>
        <dl className="grid min-w-0 grid-cols-4 gap-2">
          <div className="rounded-2xl border border-primary/30 bg-primary/10 px-3 py-2"><dt className="text-[9px] font-black uppercase tracking-widest text-primary/70">Length</dt><dd className="text-sm font-black text-primary">{duration}s</dd></div>
          <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low px-3 py-2"><dt className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant">Story</dt><dd className="truncate text-sm font-black">{activeScript.title}</dd></div>
          <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low px-3 py-2"><dt className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant">Frame</dt><dd className="text-sm font-black">{aspect}</dd></div>
          <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low px-3 py-2"><dt className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant">Price</dt><dd className="text-sm font-black">{cost} PupCoins</dd></div>
        </dl>
      </header>

      {status === "done" && resultUrl && (
        <section className="mb-6 overflow-hidden rounded-2xl border border-outline-variant/40 bg-black/40">
          <video src={resultUrl} controls autoPlay loop className="max-h-[520px] w-full bg-black" />
          <div className="flex gap-2 p-3">
            <a href={resultUrl} download className="flex flex-1 items-center justify-center gap-2 rounded-full bg-primary py-2.5 text-sm font-bold text-on-primary"><Download size={16} /> Download</a>
            <button type="button" onClick={() => { setStatus("idle"); setResultUrl(null); }} className="flex-1 rounded-full bg-surface-container-high py-2.5 text-sm font-bold text-on-surface">Make another</button>
          </div>
        </section>
      )}

      {status === "generating" ? (
        <section className="flex flex-col items-center justify-center gap-4 py-20 text-on-surface-variant">
          <RefreshCw className="animate-spin text-primary" size={32} />
          <p className="font-bold">Generating your {duration}-second scene and natural sound…</p>
          <p className="text-xs">The job is registered, so it continues safely if you leave this page.</p>
        </section>
      ) : (
        <div className="mx-auto grid h-[calc(100%-4.75rem)] min-h-0 max-w-[1720px] gap-2 lg:overflow-hidden lg:grid-cols-[minmax(220px,.72fr)_minmax(0,1.35fr)_minmax(280px,.9fr)]">
          {/* Left — image picker */}
          <section data-dashboard-region="left" className="min-h-0 space-y-5 overflow-y-auto rounded-2xl border border-outline-variant/25 bg-surface/90 p-3 shadow-sm [scrollbar-width:thin]">
            <div>
              <h2 className="text-sm font-black text-on-surface">Your uploads</h2>
              <p className="mt-1 text-xs text-on-surface-variant">Choose the portrait you want to bring to life.</p>
              {images.length === 0 ? <p className="mt-3 rounded-xl border border-outline-variant/40 p-5 text-sm text-on-surface-variant">Create a pet portrait first, then return here to animate it.</p> : (
                <div className="mt-3 grid grid-cols-2 gap-2.5">{images.map((creation) => (
                  <button key={creation.id} type="button" onClick={() => setSelectedId(creation.id)} className={`relative overflow-hidden rounded-xl border-2 text-left ${selectedId === creation.id ? "border-primary ring-2 ring-primary/30" : "border-transparent"}`}>
                    <img src={creation.image_url as string} alt={creation.name || creation.place_label || "Creation"} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                    <span className="block truncate bg-surface px-2 py-1.5 text-[10px] font-bold text-on-surface">{creation.name || creation.place_label || "Pet portrait"}</span>
                  </button>
                ))}</div>
              )}
              <input id="fur-reels-upload" type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { void uploadAnotherPhoto(event.target.files?.[0]); event.target.value = ""; }} />
              <button type="button" onClick={() => document.getElementById("fur-reels-upload")?.click()} className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-primary/35 px-3 text-sm font-black text-primary"><ImagePlus size={16} /> Upload another photo</button>
              {uploadMessage && <p className="mt-2 text-xs leading-relaxed text-on-surface-variant" role="status">{uploadMessage}</p>}
            </div>
          </section>

          {/* Center — script editor */}
          <section data-dashboard-region="center" className="min-h-0 space-y-5 overflow-y-auto rounded-2xl border border-outline-variant/25 bg-surface-container-lowest p-4 shadow-sm [scrollbar-width:thin] sm:p-5">
            <div className="rounded-2xl border border-primary/25 bg-primary/5 p-4">
              <h2 className="text-sm font-black text-on-surface">What works best</h2>
              <ul className="mt-2 space-y-1 text-xs leading-relaxed text-on-surface-variant"><li>• One main pet and one clear action</li><li>• Describe continuous, lifelike motion — what the pet does, how it moves, and how the environment reacts</li><li>• One smooth, motivated camera move (slow push-in, arc, or parallax) — avoid static shots</li><li>• Let motion flow between beats rather than freezing between them</li><li>• Consistent setting, lighting, and pet identity</li></ul>
              <p className="mt-2 text-xs font-bold text-primary">Avoid rapid cuts, crowds, costume changes, collisions, tiny props, and complex choreography.</p>
            </div>

            {/* Script mode toggle */}
            <div>
              <div className="mb-3 flex overflow-hidden rounded-xl border border-outline-variant/40">
                <button type="button" onClick={() => setScriptMode("template")} className={`flex-1 px-3 py-2 text-sm font-bold ${scriptMode === "template" ? "bg-primary text-on-primary" : "bg-surface text-on-surface-variant"}`}>Choose a template</button>
                <button type="button" onClick={() => setScriptMode("custom")} className={`flex-1 px-3 py-2 text-sm font-bold ${scriptMode === "custom" ? "bg-primary text-on-primary" : "bg-surface text-on-surface-variant"}`}>Write your own</button>
              </div>

              {scriptMode === "template" ? (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="ai-video-template" className="text-sm font-black text-on-surface">Story</label>
                    <select id="ai-video-template" value={script.id} onChange={(event) => selectTemplate(event.target.value)} className="mt-2 w-full rounded-xl border border-outline-variant/50 bg-surface px-3 py-3 text-sm text-on-surface">
                      {AI_VIDEO_SCRIPTS.map((template) => <option key={template.id} value={template.id}>{template.title} · {template.genre}</option>)}
                    </select>
                  </div>
                  <div className="grid gap-3">
                    {field("Setting", "setting")}
                    {field("Characters and identity", "characters")}
                    {field("Motions", "motions")}
                    <fieldset className="space-y-2">
                      <legend className="text-xs font-bold text-on-surface">Stage directions, in order</legend>
                      {script.stageDirections.map((direction, index) => (
                        <input key={index} value={direction} onChange={(event) => updateStageDirection(index, event.target.value)} className="w-full rounded-xl border border-outline-variant/50 bg-surface px-3 py-2 text-sm text-on-surface" aria-label={`Stage direction ${index + 1}`} />
                      ))}
                    </fieldset>
                    {field("Lighting", "lighting")}
                    {field("Color and filter", "filter")}
                    {field("Camera direction", "camera")}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <label className="block text-xs font-bold text-on-surface">
                    Title
                    <input
                      value={customTitle}
                      onChange={(e) => setCustomTitle(e.target.value)}
                      placeholder="e.g. Midnight Garden Chase"
                      className="mt-1 w-full rounded-xl border border-outline-variant/50 bg-surface px-3 py-2 text-sm font-normal text-on-surface"
                    />
                  </label>
                  <label className="block text-xs font-bold text-on-surface">
                    Script / scene description
                    <textarea
                      value={customDescription}
                      onChange={(e) => setCustomDescription(e.target.value)}
                      rows={6}
                      placeholder="Describe what you want the pet to do, the setting, lighting, mood, and any camera moves. The more vivid and specific, the better the result."
                      className="mt-1 w-full rounded-xl border border-outline-variant/50 bg-surface px-3 py-2 text-sm font-normal text-on-surface"
                    />
                  </label>
                  <p className="text-xs text-on-surface-variant">Your description drives the motion prompt directly. You can be as cinematic or as simple as you like.</p>
                </div>
              )}
            </div>
          </section>

          {/* Right — settings + generate */}
          <aside data-dashboard-region="right" className="min-h-0 space-y-5 overflow-y-auto rounded-2xl border border-outline-variant/25 bg-surface/90 p-3 shadow-sm [scrollbar-width:thin]">
            <section className="rounded-3xl border border-outline-variant/30 bg-surface-container-low p-4 sm:p-5">
              <h2 className="text-sm font-black text-on-surface">Frame and generate</h2>

              {/* Aspect ratio */}
              <div className="mt-3 flex overflow-hidden rounded-xl border border-outline-variant/40">
                <button type="button" onClick={() => setAspect("9:16")} className={`flex-1 px-3 py-2 text-sm font-bold ${aspect === "9:16" ? "bg-primary text-on-primary" : "bg-surface text-on-surface-variant"}`}>Portrait</button>
                <button type="button" onClick={() => setAspect("16:9")} className={`flex-1 px-3 py-2 text-sm font-bold ${aspect === "16:9" ? "bg-primary text-on-primary" : "bg-surface text-on-surface-variant"}`}>Landscape</button>
              </div>

              {/* Duration */}
              <div className="mt-4">
                <label className="text-xs font-bold text-on-surface">Duration</label>
                <div className="mt-2 flex overflow-hidden rounded-xl border border-outline-variant/40">
                  <button type="button" onClick={() => setDuration(8)} className={`flex-1 px-3 py-2 text-sm font-bold ${duration === 8 ? "bg-primary text-on-primary" : "bg-surface text-on-surface-variant"}`}>8 seconds</button>
                  <button type="button" onClick={() => setDuration(15)} className={`flex-1 px-3 py-2 text-sm font-bold ${duration === 15 ? "bg-primary text-on-primary" : "bg-surface text-on-surface-variant"}`}>15 seconds</button>
                </div>
                {isVideoStudioV2Enabled() && (
                  <VideoTeachingPanel
                    durationSeconds={duration}
                    onApplySample={applyTeachingSample}
                    onApplyIdea={applyTeachingIdea}
                  />
                )}
                <p className="mt-1 text-[10px] text-on-surface-variant">{animatedVideoCost(duration)} PupCoins</p>
              </div>

              <div className="mt-4 rounded-xl bg-surface px-3 py-3 text-xs text-on-surface-variant"><Sparkles className="mr-1 inline text-primary" size={13} /> Directed beats that flow together · native natural sound · identity protection</div>
              <p className="mt-3 text-xs leading-relaxed text-on-surface-variant">Your finished Fur Reels are saved to your account and appear here when you return.</p>
              {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
              <button type="button" onClick={() => void generate()} disabled={!selected} className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-primary py-4 font-extrabold text-on-primary disabled:opacity-50">
                <Wand2 size={18} /> {canAfford ? `Generate Video · ${cost} PupCoins` : `Get PupCoins (${cost})`}
              </button>
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
