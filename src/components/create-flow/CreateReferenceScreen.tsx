import React, { useEffect, useRef, useState } from "react";
import { Screen } from "../../types";
import { useCreateFlow } from "./CreateFlowContext";
import { ChevronLeft, ChevronRight, RefreshCw, AlertTriangle, ZoomIn, X, CheckCircle, Info } from "lucide-react";
import {
  authedFetch,
  createReferenceSession,
  startReferenceAttempt,
  retryReferenceAttempt,
  cancelReferenceSession,
  replaceReferenceSource,
} from "../../api";

interface CreateReferenceScreenProps {
  onNavigate: (screen: Screen) => void;
}

interface ViewItem {
  viewKind: "front" | "left" | "right" | "rear" | "front_three_quarter";
  signedUrl: string;
  isSynthesized: boolean;
  widthPx: number;
  heightPx: number;
}

interface ReportData {
  status: "pass" | "warn" | "fail";
  scaleConfidence: "unknown" | "declared" | "calibrated";
  reportHash: string;
  metrics: Record<string, any> | null;
}

export default function CreateReferenceScreen({ onNavigate }: CreateReferenceScreenProps) {
  const { state, setState } = useCreateFlow();
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Phase 2 Multiview State
  const [multiviewSessionUuid, setMultiviewSessionUuid] = useState<string | null>(null);
  const [multiviewViews, setMultiviewViews] = useState<ViewItem[]>([]);
  const [multiviewReport, setMultiviewReport] = useState<ReportData | null>(null);
  const [manifestHash, setManifestHash] = useState<string | null>(null);
  const [retryNotes, setRetryNotes] = useState<string>("");
  const [zoomedView, setZoomedView] = useState<ViewItem | null>(null);
  const automaticStartRef = useRef(false);

  const viewLabels: Record<string, string> = {
    front: "Front View",
    left: "Left Profile",
    right: "Right Profile",
    rear: "Rear View",
    front_three_quarter: "3/4 Perspective",
  };

  const initMultiviewSession = async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const mode = state.inputMode === "text" ? "text" : "photo";
      const prompt = state.inputMode === "text" ? (state.textPrompt || "").trim() : undefined;
      const created = await createReferenceSession(mode, prompt, state.species || "pet", state.inputPhotoUrl);
      setMultiviewSessionUuid(created.sessionUuid);

      const idempotencyKey = `att_${crypto.randomUUID()}`;
      const started = await startReferenceAttempt(created.sessionUuid, idempotencyKey);

      setMultiviewViews(started.session.views || []);
      setMultiviewReport(started.session.report || null);
      setManifestHash(started.session.manifestHash || null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleMultiviewRetry = async () => {
    if (!multiviewSessionUuid) return;
    setIsGenerating(true);
    setError(null);
    try {
      const idempotencyKey = `retry_${crypto.randomUUID()}`;
      const retried = await retryReferenceAttempt(multiviewSessionUuid, idempotencyKey, retryNotes);
      setMultiviewViews(retried.session.views || []);
      setMultiviewReport(retried.session.report || null);
      setManifestHash(retried.session.manifestHash || null);
      setRetryNotes("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleReplaceSource = async (file: File) => {
    if (!multiviewSessionUuid) return;
    setIsGenerating(true);
    setError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read the replacement photo."));
        reader.readAsDataURL(file);
      });
      await replaceReferenceSource(multiviewSessionUuid, dataUrl);
      const restarted = await startReferenceAttempt(multiviewSessionUuid, `replace_${crypto.randomUUID()}`);
      setMultiviewViews(restarted.session.views || []);
      setMultiviewReport(restarted.session.report || null);
      setManifestHash(restarted.session.manifestHash || null);
      setState((current) => ({ ...current, inputPhotoUrl: dataUrl }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const continueToCustomize = () => {
    if (!multiviewSessionUuid || !manifestHash) return;
    setState((s) => ({ ...s, sessionId: multiviewSessionUuid, candidateImageUrl: multiviewViews[0]?.signedUrl || s.candidateImageUrl }));
    onNavigate(Screen.CREATE_CUSTOMIZE);
  };

  const generateLegacyCandidate = async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const res = await authedFetch("/api/create-pipeline/generate-reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          species: state.species,
          breed: state.breed,
          petName: state.petName,
          intent: state.intent,
          style: state.style,
          inputPhotoUrl: state.inputMode === "text" ? null : state.inputPhotoUrl,
          inputMode: state.inputMode ?? "image",
          textPrompt: state.inputMode === "text" ? (state.textPrompt || "").trim() : undefined,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to generate concept.");
      }

      setState((s) => ({
        ...s,
        sessionId: data.sessionId,
        candidateImageUrl: data.candidateUrl,
      }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    if (automaticStartRef.current) return;
    const hasInput =
      state.inputMode === "text"
        ? !!(state.textPrompt || "").trim()
        : !!state.inputPhotoUrl;
    if (!state.candidateImageUrl && multiviewViews.length === 0 && !isGenerating && !error && hasInput) {
      automaticStartRef.current = true;
      void initMultiviewSession();
    }
  }, []);

  // Keyboard close for zoom modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomedView(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="w-full max-w-5xl mx-auto px-5 sm:px-6 py-8 animate-in fade-in zoom-in duration-500">
      <div className="mb-6 flex items-center justify-between">
        <button
          onClick={() => onNavigate(Screen.CREATE)}
          className="flex items-center gap-1 text-on-surface-variant hover:text-primary font-medium"
        >
          <ChevronLeft size={20} /> Back
        </button>
        <div className="flex gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-primary/30"></div>
          <div className="w-2.5 h-2.5 rounded-full bg-primary"></div>
          <div className="w-2.5 h-2.5 rounded-full bg-primary/30"></div>
          <div className="w-2.5 h-2.5 rounded-full bg-primary/30"></div>
        </div>
      </div>

      <div className="text-center mb-8">
        <h1 className="text-3xl font-black text-on-surface mb-2">
          {multiviewViews.length > 0 ? "Your Pet's 5-View Reference" : "Preparing Your Pet"}
        </h1>
        <p className="text-on-surface-variant text-lg">
          {multiviewViews.length > 0
            ? "These views are already attached to your tracked model build."
            : "We transformed your photo into a 3D-ready blueprint."}
        </p>
      </div>

      <div className="glass-panel p-4 sm:p-6 rounded-3xl relative overflow-hidden min-h-[400px] flex flex-col items-center justify-center">
        {isGenerating ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <RefreshCw className="animate-spin text-primary mb-6" size={48} />
            <h3 className="text-xl font-bold text-on-surface mb-2">
              Generating 5-View Reference...
            </h3>
            <p className="text-on-surface-variant">
              Synthesizing five high-resolution views and a visual consistency report.
            </p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12 text-center max-w-md mx-auto">
            <div className="w-16 h-16 rounded-full bg-error/10 flex items-center justify-center mb-4">
              <AlertTriangle className="text-error" size={32} />
            </div>
            <h3 className="text-xl font-bold text-on-surface mb-2">Oops, something went wrong</h3>
            <p className="text-on-surface-variant mb-6">{error}</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => multiviewSessionUuid ? handleMultiviewRetry() : initMultiviewSession()}
                className="px-6 py-3 bg-primary text-on-primary font-bold rounded-xl shadow-md hover:scale-105 transition-transform"
              >
                Try Again
              </button>
              {multiviewSessionUuid && state.inputMode !== "text" && (
                <label className="px-6 py-3 bg-surface-variant text-on-surface font-bold rounded-xl border border-outline-variant cursor-pointer hover:bg-surface-variant/80">
                  Replace Source Photo
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleReplaceSource(file);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              )}
            </div>
          </div>
        ) : multiviewViews.length > 0 ? (
          <div className="w-full flex flex-col gap-6">
            {/* 5-View Canonical Review Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
              {multiviewViews.map((v) => (
                <div
                  key={v.viewKind}
                  className="relative group rounded-2xl overflow-hidden shadow-md border-2 border-surface-variant aspect-square bg-black/20 flex flex-col justify-between p-2"
                >
                  <img
                    src={v.signedUrl}
                    alt={`${viewLabels[v.viewKind] || v.viewKind} reference image`}
                    className="w-full h-full object-contain cursor-pointer transition-transform group-hover:scale-105"
                    onClick={() => setZoomedView(v)}
                  />
                  <div className="absolute top-2 left-2 bg-black/70 backdrop-blur-md px-2 py-0.5 rounded-full text-[10px] font-bold text-white uppercase tracking-wider">
                    {viewLabels[v.viewKind] || v.viewKind}
                  </div>
                  <div className="absolute bottom-2 right-2 flex items-center gap-1">
                    <span className="bg-primary/90 text-on-primary text-[9px] font-bold px-1.5 py-0.5 rounded">
                      {v.isSynthesized ? "Synthesized" : "Captured"}
                    </span>
                    <button
                      onClick={() => setZoomedView(v)}
                      className="p-1 bg-black/60 hover:bg-black text-white rounded-full"
                      aria-label={`Zoom ${viewLabels[v.viewKind]}`}
                    >
                      <ZoomIn size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Disclaimer Warning Banner */}
            <div className="flex items-start gap-3 p-4 rounded-2xl bg-surface-variant/40 border border-outline-variant/30 text-xs text-on-surface-variant">
              <Info size={18} className="text-primary flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-on-surface mb-0.5">Pre-Build Reference Notice</p>
                <p>
                  Generated hidden views are estimated angles. Pre-build consistency checks evaluate visual suitability but do not guarantee mesh, rig, print, or dimensional accuracy.
                </p>
              </div>
            </div>

            {/* AI Consistency Report Card */}
            {multiviewReport && (
              <div className="p-5 rounded-2xl bg-surface-variant/20 border border-outline-variant/40 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {multiviewReport.status === "pass" ? <CheckCircle className="text-emerald-500" size={20} /> : <AlertTriangle className="text-amber-500" size={20} />}
                    <h4 className="font-bold text-on-surface">AI Visual Consistency Report</h4>
                  </div>
                  <span className={`px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${multiviewReport.status === "pass" ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400"}`}>
                    Status: {multiviewReport.status} | Scale: {multiviewReport.scaleConfidence}
                  </span>
                </div>
                {multiviewReport.metrics?.metrics && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    {multiviewReport.metrics.metrics.map((m: any, idx: number) => (
                      <div key={idx} className="flex items-center justify-between p-2 rounded-lg bg-surface/40">
                        <span className="font-medium text-on-surface">{m.name}</span>
                        <span className={`font-bold ${m.status === "pass" ? "text-emerald-400" : m.status === "fail" ? "text-error" : "text-amber-400"}`}>{m.status === "warn" && m.score === 0 ? "Review" : `${(m.score * 100).toFixed(0)}%`}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Retry with Notes Input */}
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                placeholder="Optional adjustment notes for retry (e.g. adjust ear shape...)"
                value={retryNotes}
                onChange={(e) => setRetryNotes(e.target.value)}
                className="flex-1 px-4 py-3 rounded-xl bg-surface-variant/40 border border-outline-variant text-on-surface text-sm focus:outline-none focus:border-primary"
              />
              <button
                onClick={handleMultiviewRetry}
                className="py-3 px-6 rounded-xl font-bold text-on-surface bg-surface-variant hover:bg-surface-variant/80 border border-outline-variant transition-colors flex items-center justify-center gap-2 text-sm"
              >
                <RefreshCw size={16} /> Retry Multiview
              </button>
              {state.inputMode !== "text" && (
                <label className="py-3 px-6 rounded-xl font-bold text-on-surface bg-surface-variant hover:bg-surface-variant/80 border border-outline-variant transition-colors flex items-center justify-center gap-2 text-sm cursor-pointer">
                  Replace Source
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleReplaceSource(file);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              )}
            </div>

            {/* Action Buttons & Pricing Disclaimer */}
            <div className="flex flex-col gap-2 pt-2 border-t border-outline-variant/30">
              <button
                onClick={continueToCustomize}
                className="w-full py-4 px-6 rounded-2xl font-black text-on-primary bg-primary shadow-lg shadow-primary/25 hover:scale-[1.01] transition-transform flex items-center justify-center gap-2 text-base"
              >
                Continue customizing <ChevronRight size={20} />
              </button>
              <p className="text-center text-xs text-on-surface-variant">
                The exact reference manifest stays attached to this pet for asset tracking.
              </p>
            </div>
          </div>
        ) : state.candidateImageUrl ? (
          /* Legacy Single-Image Concept Fallback */
          <div className="w-full max-w-lg mx-auto flex flex-col gap-6">
            <div className="relative rounded-2xl overflow-hidden shadow-2xl border-4 border-surface-variant aspect-square">
              <img src={state.candidateImageUrl} alt="AI Concept" className="w-full h-full object-cover" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => generateLegacyCandidate()}
                className="py-4 rounded-xl font-bold text-on-surface bg-surface-variant border border-outline-variant hover:bg-surface-variant/80 transition-colors flex justify-center items-center gap-2"
              >
                <RefreshCw size={18} /> Remake Image
              </button>
              <button
                onClick={() => onNavigate(Screen.CREATE_CUSTOMIZE)}
                className="py-4 px-2 rounded-xl font-black text-on-primary bg-primary shadow-lg shadow-primary/25 hover:scale-[1.02] transition-transform flex justify-center items-center gap-2"
              >
                Continue <ChevronRight size={20} />
              </button>
            </div>
            <p className="text-center text-xs text-on-surface-variant">
              Still no PupCoins charged. Next, we'll customize it before building.
            </p>
          </div>
        ) : null}
      </div>

      {/* Zoom Inspection Modal */}
      {zoomedView && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="relative max-w-3xl w-full bg-surface p-6 rounded-3xl flex flex-col items-center gap-4">
            <button
              onClick={() => setZoomedView(null)}
              className="absolute top-4 right-4 p-2 rounded-full bg-surface-variant hover:bg-surface-variant/80 text-on-surface"
              aria-label="Close zoom modal"
            >
              <X size={20} />
            </button>
            <h3 className="text-lg font-bold text-on-surface">
              {viewLabels[zoomedView.viewKind] || zoomedView.viewKind} ({zoomedView.widthPx}x{zoomedView.heightPx})
            </h3>
            <img
              src={zoomedView.signedUrl}
              alt={`${viewLabels[zoomedView.viewKind]} high resolution detail`}
              className="max-h-[70vh] object-contain rounded-2xl border border-outline-variant"
            />
            <p className="text-xs text-on-surface-variant">Press Escape or click X to close zoom view.</p>
          </div>
        </div>
      )}
    </div>
  );
}
