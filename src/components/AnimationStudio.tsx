import React, { useMemo, useState } from "react";
import { Download, Film, ImagePlus, Mic2, Play, RefreshCw, Sparkles, Wand2, X } from "lucide-react";
import { Creation, UserProfile } from "../types";
import { addUserPhoto, createVideo, createVoicePreview, pollJob } from "../api";
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
  const [uploadMessage, setUploadMessage] = useState("");

  const cost = CREDIT_PRICES.ANIMATED_VIDEO;
  const canAfford = userProfile.isAdmin || (userProfile.credits ?? 0) >= cost;
  const selected = images.find((creation) => creation.id === selectedId) || null;

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
    <main data-creative-dashboard="true" className="h-[calc(100dvh-4rem)] w-full overflow-hidden bg-background p-2 text-on-background sm:p-3" aria-labelledby="ai-video-title">
      <header className="mx-auto mb-2 grid max-w-[1720px] shrink-0 gap-2 xl:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-outline-variant/25 bg-surface/90 px-4 py-2 shadow-sm">
          <Film size={22} className="shrink-0 text-primary" />
          <div className="min-w-0"><h1 id="ai-video-title" className="truncate text-lg font-black text-on-surface">Fur Reels</h1><p className="truncate text-xs text-on-surface-variant">Direct an eight-second pet story with picture, motion, sound, and voice.</p></div>
          <button type="button" onClick={onClose} className="ml-auto rounded-full p-2 text-on-surface-variant hover:text-primary" aria-label="Close"><X size={20} /></button>
        </div>
        <dl className="grid min-w-0 grid-cols-4 gap-2">
          <div className="rounded-2xl border border-primary/30 bg-primary/10 px-3 py-2"><dt className="text-[9px] font-black uppercase tracking-widest text-primary/70">Length</dt><dd className="text-sm font-black text-primary">8 seconds</dd></div>
          <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low px-3 py-2"><dt className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant">Story</dt><dd className="truncate text-sm font-black">{script.title}</dd></div>
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
          <p className="font-bold">Generating the complete 8-second scene and sound…</p>
          <p className="text-xs">The job is registered, so it continues safely if you leave this page.</p>
        </section>
      ) : (
        <div className="mx-auto grid h-[calc(100%-4.75rem)] min-h-0 max-w-[1720px] gap-2 lg:grid-cols-[280px_minmax(0,1fr)_300px] xl:grid-cols-[300px_minmax(0,1fr)_330px]">
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

          <section data-dashboard-region="center" className="min-h-0 space-y-5 overflow-y-auto rounded-2xl border border-outline-variant/25 bg-surface-container-lowest p-4 shadow-sm [scrollbar-width:thin] sm:p-5">
            <div className="rounded-2xl border border-primary/25 bg-primary/5 p-4">
              <h2 className="text-sm font-black text-on-surface">What works best</h2>
              {/* VG-6: this guidance previously said "Four simple two-second
                  beats" and "Slow movement and one smooth camera move", which
                  pushed people toward writing the minimal, stiff prompts the
                  model then faithfully rendered. Safety guidance below is
                  unchanged; the motion guidance now asks for continuity. */}
              <ul className="mt-2 space-y-1 text-xs leading-relaxed text-on-surface-variant"><li>• One main pet and one clear action</li><li>• Describe continuous, lifelike motion — what the pet does, how it moves, and how the environment reacts</li><li>• One smooth, motivated camera move (slow push-in, arc, or parallax) — avoid static shots</li><li>• Let motion flow between beats rather than freezing between them</li><li>• Consistent setting, lighting, and pet identity</li></ul>
              <p className="mt-2 text-xs font-bold text-primary">Avoid rapid cuts, crowds, costume changes, collisions, tiny props, and complex choreography.</p>
            </div>
            <div>
              <label htmlFor="ai-video-template" className="text-sm font-black text-on-surface">Choose an 8-second story</label>
              <select id="ai-video-template" value={script.id} onChange={(event) => selectTemplate(event.target.value)} className="mt-2 w-full rounded-xl border border-outline-variant/50 bg-surface px-3 py-3 text-sm text-on-surface">
                {AI_VIDEO_SCRIPTS.map((template) => <option key={template.id} value={template.id}>{template.title} · {template.genre}</option>)}
              </select>
            </div>

            <div className="grid gap-3">
              {field("Setting", "setting")}
              {field("Characters and identity", "characters")}
              {field("Motions", "motions")}
              <fieldset className="space-y-2">
                {/* LIVE-4: VG-3 relaxed the schema from a fixed 4-tuple to 3-6
                    beats and stripped the literal 0-2s/2-4s timestamps, but this
                    copy still promised "four timed" directions. */}
                <legend className="text-xs font-bold text-on-surface">Stage directions, in order</legend>
                {script.stageDirections.map((direction, index) => (
                  <input key={index} value={direction} onChange={(event) => updateStageDirection(index, event.target.value)} className="w-full rounded-xl border border-outline-variant/50 bg-surface px-3 py-2 text-sm text-on-surface" aria-label={`Stage direction ${index + 1}`} />
                ))}
              </fieldset>
              {field("Lighting", "lighting")}
              {field("Color and filter", "filter")}
              {field("Camera direction", "camera")}
            </div>
          </section>

          <aside data-dashboard-region="right" className="min-h-0 space-y-5 overflow-y-auto rounded-2xl border border-outline-variant/25 bg-surface/90 p-3 shadow-sm [scrollbar-width:thin]">
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
              <div className="mt-4 rounded-xl bg-surface px-3 py-3 text-xs text-on-surface-variant"><Sparkles className="mr-1 inline text-primary" size={13} /> Exactly 8 seconds · directed beats that flow together · native sound · identity protection</div>
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
