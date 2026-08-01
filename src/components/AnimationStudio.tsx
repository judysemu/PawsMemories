import React, { useMemo, useState } from "react";
import { Download, Film, Mic2, Play, RefreshCw, Sparkles, Wand2, X } from "lucide-react";
import { Creation, UserProfile } from "../types";
import { createVideo, createVoicePreview, pollJob } from "../api";
import { AI_VIDEO_SCRIPTS, DEFAULT_AI_VIDEO_SCRIPT, type AiVideoScriptTemplate } from "../aiVideoScripts";
import { CREDIT_PRICES } from "../pricing";

interface AnimationStudioProps {
  creations: Creation[];
  userProfile: UserProfile;
  onOpenCreditStore: () => void;
  onClose: () => void;
  onCreationsChanged?: () => Promise<void> | void;
}

type EditableScript = AiVideoScriptTemplate & { voiceText: string };

function editable(template: AiVideoScriptTemplate): EditableScript {
  return { ...template, stageDirections: [...template.stageDirections], voiceText: "" };
}

/** Customer AI video generation: a guided script, never a manual timeline editor. */
export default function AnimationStudio({ creations, userProfile, onOpenCreditStore, onClose, onCreationsChanged }: AnimationStudioProps) {
  const images = useMemo(() => creations.filter((creation) => creation.image_url), [creations]);
  const [selectedId, setSelectedId] = useState<number | null>(images[0]?.id ?? null);
  const [script, setScript] = useState<EditableScript>(() => editable(DEFAULT_AI_VIDEO_SCRIPT));
  const [aspect, setAspect] = useState<"16:9" | "9:16">("9:16");
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [voiceAudio, setVoiceAudio] = useState<string | null>(null);

  const cost = CREDIT_PRICES.ANIMATED_VIDEO;
  const canAfford = userProfile.isAdmin || (userProfile.credits ?? 0) >= cost;
  const selected = images.find((creation) => creation.id === selectedId) || null;

  const selectTemplate = (templateId: string) => {
    const template = AI_VIDEO_SCRIPTS.find((candidate) => candidate.id === templateId) || DEFAULT_AI_VIDEO_SCRIPT;
    setScript(editable(template));
    setVoiceAudio(null);
    setVoiceStatus("idle");
  };

  const updateStageDirection = (index: number, value: string) => {
    const directions = [...script.stageDirections] as [string, string, string, string];
    directions[index] = value;
    setScript((current) => ({ ...current, stageDirections: directions }));
  };

  const previewVoice = async () => {
    if (!script.voiceText.trim()) return;
    setVoiceStatus("loading");
    setVoiceAudio(null);
    try {
      const preview = await createVoicePreview(script.voiceText.trim());
      setVoiceAudio(`data:${preview.mimeType};base64,${preview.audioBase64}`);
      setVoiceStatus("ready");
    } catch (voiceError: any) {
      setVoiceStatus("error");
      setError(voiceError?.message || "The voice preview could not be generated.");
    }
  };

  const generate = async () => {
    if (!selected) { setError("Pick an image to animate first."); return; }
    if (!canAfford) { onOpenCreditStore(); return; }
    setError(null);
    setResultUrl(null);
    setStatus("generating");
    try {
      const { jobId } = await createVideo(selected.id, script, true, aspect);
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
    <main className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 animate-fade-in" aria-labelledby="ai-video-title">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3"><Film size={23} className="text-primary" /><h1 id="ai-video-title" className="text-2xl font-black text-on-surface">8-Second AI Video Studio</h1></div>
          <p className="mt-2 max-w-3xl text-sm text-on-surface-variant">Choose a scene, direct every beat, lighting, camera, and sound, then let AI animate your pet. This is guided video generation—not a manual animator tool. <strong>{cost} PupCoins</strong> per video.</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-full p-2 text-on-surface-variant hover:text-primary" aria-label="Close"><X size={20} /></button>
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
          <p className="font-bold">Generating the complete 8-second scene and sound…</p>
          <p className="text-xs">The job is registered, so it continues safely if you leave this page.</p>
        </section>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(340px,.9fr)]">
          <section className="space-y-5 rounded-3xl border border-outline-variant/30 bg-surface-container-low p-4 sm:p-6">
            <div>
              <h2 className="text-sm font-black text-on-surface">1. Choose your pet image</h2>
              {images.length === 0 ? <p className="mt-3 rounded-xl border border-outline-variant/40 p-5 text-sm text-on-surface-variant">Create a pet portrait first, then return here to animate it.</p> : (
                <div className="mt-3 grid grid-cols-3 gap-2.5 sm:grid-cols-4">{images.map((creation) => (
                  <button key={creation.id} type="button" onClick={() => setSelectedId(creation.id)} className={`relative aspect-square overflow-hidden rounded-xl border-2 ${selectedId === creation.id ? "border-primary ring-2 ring-primary/30" : "border-transparent"}`}>
                    <img src={creation.image_url as string} alt={creation.name || creation.place_label || "Creation"} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                  </button>
                ))}</div>
              )}
            </div>

            <div>
              <label htmlFor="ai-video-template" className="text-sm font-black text-on-surface">2. Choose an 8-second story</label>
              <select id="ai-video-template" value={script.id} onChange={(event) => selectTemplate(event.target.value)} className="mt-2 w-full rounded-xl border border-outline-variant/50 bg-surface px-3 py-3 text-sm text-on-surface">
                {AI_VIDEO_SCRIPTS.map((template) => <option key={template.id} value={template.id}>{template.title} · {template.genre}</option>)}
              </select>
            </div>

            <div className="grid gap-3">
              {field("Setting", "setting")}
              {field("Characters and identity", "characters")}
              {field("Motions", "motions")}
              <fieldset className="space-y-2">
                <legend className="text-xs font-bold text-on-surface">Four timed stage directions</legend>
                {script.stageDirections.map((direction, index) => (
                  <input key={index} value={direction} onChange={(event) => updateStageDirection(index, event.target.value)} className="w-full rounded-xl border border-outline-variant/50 bg-surface px-3 py-2 text-sm text-on-surface" aria-label={`Stage direction ${index + 1}`} />
                ))}
              </fieldset>
              {field("Lighting", "lighting")}
              {field("Color and filter", "filter")}
              {field("Camera direction", "camera")}
            </div>
          </section>

          <aside className="space-y-5">
            <section className="rounded-3xl border border-primary/25 bg-primary/5 p-4 sm:p-5">
              <div className="flex items-center gap-2"><Mic2 size={18} className="text-primary" /><h2 className="text-sm font-black text-on-surface">3. Add sound and a short voice line</h2></div>
              <p className="mt-2 text-xs text-on-surface-variant">The finished video includes native scene sound. Add one optional spoken line; preview it here with the configured Pawsome3D voice service.</p>
              <textarea value={script.voiceText} onChange={(event) => { setScript((current) => ({ ...current, voiceText: event.target.value.slice(0, 160) })); setVoiceAudio(null); setVoiceStatus("idle"); }} rows={3} placeholder="Optional: One short line your pet says…" className="mt-3 w-full rounded-xl border border-outline-variant/50 bg-surface px-3 py-2 text-sm text-on-surface" />
              <div className="mt-1 text-right text-[11px] text-on-surface-variant">{script.voiceText.length}/160</div>
              <button type="button" onClick={() => void previewVoice()} disabled={!script.voiceText.trim() || voiceStatus === "loading"} className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-primary/35 px-3 py-2 text-sm font-bold text-primary disabled:opacity-40">
                {voiceStatus === "loading" ? <RefreshCw className="animate-spin" size={15} /> : <Play size={15} />} Preview voice
              </button>
              {voiceAudio && <audio className="mt-3 w-full" src={voiceAudio} controls autoPlay />}
            </section>

            <section className="rounded-3xl border border-outline-variant/30 bg-surface-container-low p-4 sm:p-5">
              <h2 className="text-sm font-black text-on-surface">4. Frame and generate</h2>
              <div className="mt-3 flex overflow-hidden rounded-xl border border-outline-variant/40">
                <button type="button" onClick={() => setAspect("9:16")} className={`flex-1 px-3 py-2 text-sm font-bold ${aspect === "9:16" ? "bg-primary text-on-primary" : "bg-surface text-on-surface-variant"}`}>Portrait</button>
                <button type="button" onClick={() => setAspect("16:9")} className={`flex-1 px-3 py-2 text-sm font-bold ${aspect === "16:9" ? "bg-primary text-on-primary" : "bg-surface text-on-surface-variant"}`}>Landscape</button>
              </div>
              <div className="mt-4 rounded-xl bg-surface px-3 py-3 text-xs text-on-surface-variant"><Sparkles className="mr-1 inline text-primary" size={13} /> Exactly 8 seconds · four directed beats · native sound · identity protection</div>
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
