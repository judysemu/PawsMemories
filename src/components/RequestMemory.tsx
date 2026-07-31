import React, { useState, useRef, useEffect } from "react";
import {
  ArrowLeft, Upload, Camera, Image, Video, Sparkles, Globe,
  Send, Clock, CheckCircle2, XCircle, RefreshCw, AlertCircle,
  ChevronRight, Star
} from "lucide-react";
import { RequestType, PhotoRequest } from "../types";
import { submitPhotoRequest, fetchMyRequests } from "../api";

interface RequestMemoryProps {
  onNavigateBack: () => void;
  onUnlockAchievement?: (id: string) => void;
}

const TIERS: {
  id: RequestType;
  label: string;
  price: number;
  icon: React.ReactNode;
  badge?: string;
  description: string;
  highlight?: boolean;
}[] = [
  {
    id: "photo_standard",
    label: "Standard Photo",
    price: 2.99,
    icon: <Image size={22} />,
    description: "AI-styled pet portrait with a preset backdrop",
  },
  {
    id: "photo_premium",
    label: "Premium Photo",
    price: 4.99,
    icon: <Globe size={22} />,
    description: "AI-styled portrait at a real-world Street View location",
    highlight: true,
    badge: "Most Popular",
  },
  {
    id: "video_standard",
    label: "Standard Video",
    price: 7.99,
    icon: <Video size={22} />,
    description: "8-second animated video clip with cinematic motion",
  },
  {
    id: "video_premium",
    label: "Premium Video",
    price: 12.99,
    icon: <Sparkles size={22} />,
    description: "Premium animated clip with custom motion & audio",
  },
];

const STATUS_CONFIG: Record<
  string,
  { label: string; icon: React.ReactNode; color: string; bg: string }
> = {
  pending:   { label: "In Review",  icon: <Clock size={13} />,          color: "text-amber-700",  bg: "bg-amber-50 border-amber-200" },
  fulfilled: { label: "Ready! ✨",  icon: <CheckCircle2 size={13} />,   color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200" },
  rejected:  { label: "Rejected",   icon: <XCircle size={13} />,        color: "text-red-700",    bg: "bg-red-50 border-red-200" },
};

const TYPE_LABELS: Record<RequestType, string> = {
  photo_standard: "Standard Photo",
  photo_premium:  "Premium Photo",
  video_standard: "Standard Video",
  video_premium:  "Premium Video",
};

export default function RequestMemory({ onNavigateBack, onUnlockAchievement }: RequestMemoryProps) {
  const [selectedTier, setSelectedTier] = useState<RequestType>("photo_standard");
  const [comment, setComment] = useState("");
  const [uploadedBase64, setUploadedBase64] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [myRequests, setMyRequests] = useState<PhotoRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [activeView, setActiveView] = useState<"form" | "requests">("form");
  const [isCameraActive, setIsCameraActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);

  useEffect(() => () => {
    activeStream?.getTracks().forEach((track) => track.stop());
  }, [activeStream]);

  const selectedTierObj = TIERS.find((t) => t.id === selectedTier)!;

  useEffect(() => {
    loadRequests();
  }, []);

  async function loadRequests() {
    setRequestsLoading(true);
    const reqs = await fetchMyRequests();
    setMyRequests(reqs);
    setRequestsLoading(false);
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const b64 = reader.result as string;
      setUploadedBase64(b64);
      setPreviewUrl(b64);
      if (onUnlockAchievement) onUnlockAchievement("camera_use");
    };
    reader.readAsDataURL(file);
  };

  const startCamera = async () => {
    try {
      setIsCameraActive(true);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      setActiveStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch (err: any) {
      setIsCameraActive(false);
      setError("Camera permission denied: " + err.message);
    }
  };

  const stopCamera = () => {
    activeStream?.getTracks().forEach((t) => t.stop());
    setActiveStream(null);
    setIsCameraActive(false);
  };

  const captureSnapshot = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    const size = Math.min(video.videoWidth, video.videoHeight) || 512;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(video, 0, 0, size, size);
      const dataUrl = canvas.toDataURL("image/jpeg");
      setUploadedBase64(dataUrl);
      setPreviewUrl(dataUrl);
    }
    stopCamera();
    if (onUnlockAchievement) onUnlockAchievement("camera_use");
  };

  const handleSubmit = async () => {
    if (!comment.trim() || comment.trim().length < 10) {
      setError("Please describe what you'd like (at least 10 characters).");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const { checkoutUrl, mode } = await submitPhotoRequest(selectedTier, comment.trim(), uploadedBase64);
      if (mode === "sandbox") {
        setSubmitted(true);
        await loadRequests();
      } else {
        window.location.href = checkoutUrl;
      }
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="w-full max-w-md mx-auto px-4 py-8 flex flex-col items-center text-center space-y-6 animate-fade-in">
        <div className="w-24 h-24 bg-primary/10 rounded-full flex items-center justify-center soft-glow-shadow">
          <span className="text-5xl">🐾</span>
        </div>
        <div>
          <h2 className="text-2xl font-extrabold text-on-surface mb-2">Request Submitted!</h2>
          <p className="text-sm text-on-surface-variant leading-relaxed">
            We've received your request and payment. Our team will personally craft your memory and notify you by SMS when it's ready.
          </p>
        </div>
        <div className="w-full p-4 bg-primary/5 border border-primary/20 rounded-2xl text-xs text-primary font-medium leading-relaxed">
          ✅ You'll receive an SMS notification as soon as your creation is ready in your gallery.
        </div>
        <button
          onClick={() => { setSubmitted(false); setActiveView("requests"); loadRequests(); }}
          className="w-full py-3 bg-primary text-white rounded-2xl font-bold text-sm shadow-md hover:bg-primary/95 active:scale-[0.98] transition-all flex items-center justify-center gap-2 cursor-pointer"
        >
          <Clock size={16} />
          View My Requests
        </button>
        <button onClick={onNavigateBack} className="text-sm text-on-surface-variant hover:text-on-surface underline cursor-pointer">
          Back to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onNavigateBack}
          className="w-9 h-9 rounded-full bg-surface-container hover:bg-outline-variant/30 text-on-surface flex items-center justify-center border border-outline-variant/30 transition-all cursor-pointer shadow-sm flex-shrink-0"
          aria-label="Back"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <h2 className="text-lg font-extrabold tracking-tight text-on-surface leading-tight">Request a Memory</h2>
          <p className="text-[11px] text-on-surface-variant font-medium">Personally crafted by our team · SMS notification when ready</p>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex rounded-2xl bg-surface-container border border-outline-variant/30 p-1 gap-1">
        <button
          onClick={() => setActiveView("form")}
          className={`flex-1 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${activeView === "form" ? "bg-primary text-white shadow-sm" : "text-on-surface-variant hover:text-on-surface"}`}
        >
          New Request
        </button>
        <button
          onClick={() => setActiveView("requests")}
          className={`flex-1 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-1.5 ${activeView === "requests" ? "bg-primary text-white shadow-sm" : "text-on-surface-variant hover:text-on-surface"}`}
        >
          My Requests
          {myRequests.filter(r => r.status === "pending").length > 0 && (
            <span className="bg-secondary text-white text-[9px] font-black w-4 h-4 rounded-full flex items-center justify-center">
              {myRequests.filter(r => r.status === "pending").length}
            </span>
          )}
        </button>
      </div>

      {/* === MY REQUESTS VIEW === */}
      {activeView === "requests" && (
        <div className="space-y-3 animate-fade-in">
          <button
            onClick={loadRequests}
            className="flex items-center gap-1.5 text-xs text-primary hover:underline cursor-pointer ml-auto"
          >
            <RefreshCw size={11} /> Refresh
          </button>
          {requestsLoading ? (
            <div className="space-y-3">
              {[1,2].map(i => (
                <div key={i} className="h-20 rounded-2xl bg-surface-container animate-pulse border border-outline-variant/20" />
              ))}
            </div>
          ) : myRequests.length === 0 ? (
            <div className="text-center py-12 space-y-3">
              <span className="text-5xl">🐾</span>
              <p className="text-sm text-on-surface-variant font-medium">No requests yet.</p>
              <button onClick={() => setActiveView("form")} className="text-sm text-primary underline cursor-pointer">
                Submit your first request →
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {myRequests.map((req) => {
                const cfg = STATUS_CONFIG[req.status] || STATUS_CONFIG.pending;
                return (
                  <div
                    key={req.id}
                    className="bg-surface-container rounded-2xl p-4 border border-outline-variant/30 shadow-sm space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-on-surface truncate">{TYPE_LABELS[req.request_type]}</p>
                        <p className="text-[11px] text-on-surface-variant leading-relaxed line-clamp-2 mt-0.5">{req.comment}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold ${cfg.bg} ${cfg.color}`}>
                          {cfg.icon} {cfg.label}
                        </span>
                        {req.amount_paid && (
                          <span className="text-[10px] text-on-surface-variant font-mono">${Number(req.amount_paid).toFixed(2)} paid</span>
                        )}
                      </div>
                    </div>

                    {req.status === "fulfilled" && req.result_url && (
                      <div className="mt-2">
                        {req.result_url.endsWith(".mp4") || req.result_url.includes("video") ? (
                          <video
                            src={req.result_url}
                            autoPlay
                            loop
                            muted
                            playsInline
                            className="w-full rounded-xl aspect-square object-cover border border-outline-variant/20"
                          />
                        ) : (
                          <img
                            src={req.result_url}
                            alt="Your creation"
                            className="w-full rounded-xl aspect-square object-cover border border-outline-variant/20"
                          />
                        )}
                      </div>
                    )}

                    {req.status === "rejected" && req.admin_notes && (
                      <p className="text-[10px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">
                        Note: {req.admin_notes}
                      </p>
                    )}

                    <p className="text-[9px] text-outline font-mono">{new Date(req.created_at).toLocaleDateString()}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* === NEW REQUEST FORM === */}
      {activeView === "form" && (
        <div className="space-y-5 animate-fade-in">

          {/* Pet Photo Upload */}
          <section className="space-y-2">
            <h3 className="text-xs font-bold text-on-surface-variant uppercase tracking-widest px-1">
              1. Upload Your Pet's Photo
            </h3>

            {isCameraActive ? (
              <div className="relative aspect-square w-full rounded-2xl overflow-hidden bg-slate-950 shadow-xl">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="absolute inset-0 w-full h-full object-cover scale-x-[-1]"
                />
                <div className="absolute inset-8 border-2 border-dashed border-white/60 rounded-3xl pointer-events-none flex items-center justify-center">
                  <span className="text-[10px] text-white font-bold uppercase tracking-widest bg-black/50 px-2.5 py-1 rounded-full">
                    Position Pet Here
                  </span>
                </div>
                <div className="absolute bottom-4 left-4 right-4 flex gap-3">
                  <button onClick={stopCamera} className="flex-1 py-2.5 bg-slate-900/90 text-white border border-slate-700 rounded-xl text-xs font-bold cursor-pointer">
                    Cancel
                  </button>
                  <button onClick={captureSnapshot} className="flex-1 py-2.5 bg-secondary text-white rounded-xl text-xs font-black cursor-pointer flex items-center justify-center gap-1.5 shadow-md">
                    <Camera size={13} /> Snap Photo
                  </button>
                </div>
              </div>
            ) : previewUrl ? (
              <div className="relative aspect-square w-full rounded-2xl overflow-hidden shadow-xl border border-outline-variant/30">
                <img src={previewUrl} alt="Pet photo" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent flex items-end p-3">
                  <button
                    onClick={() => { setPreviewUrl(null); setUploadedBase64(null); }}
                    className="text-[10px] font-bold uppercase tracking-wide text-white/80 hover:text-white bg-black/40 px-3 py-1.5 rounded-lg cursor-pointer"
                  >
                    Change Photo
                  </button>
                </div>
              </div>
            ) : (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square w-full rounded-2xl border-2 border-dashed border-outline-variant/50 bg-surface-container flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all group shadow-sm"
              >
                <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center group-hover:scale-105 transition-transform">
                  <Upload size={24} className="text-primary" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-bold text-on-surface">Drop or click to upload</p>
                  <p className="text-[11px] text-on-surface-variant mt-0.5">JPG, PNG, HEIC · Optional but recommended</p>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); startCamera(); }}
                  className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-primary bg-primary/10 px-3 py-1.5 rounded-full hover:bg-primary/20 transition-all cursor-pointer"
                >
                  <Camera size={11} /> Use Camera
                </button>
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
          </section>

          {/* Tier selector */}
          <section className="space-y-2">
            <h3 className="text-xs font-bold text-on-surface-variant uppercase tracking-widest px-1">
              2. Choose Your Tier
            </h3>
            <div className="grid grid-cols-2 gap-2.5">
              {TIERS.map((tier) => {
                const active = selectedTier === tier.id;
                return (
                  <button
                    key={tier.id}
                    type="button"
                    onClick={() => setSelectedTier(tier.id)}
                    className={`relative rounded-2xl p-3.5 text-left border-2 transition-all cursor-pointer active:scale-95 ${
                      active
                        ? "border-primary bg-primary/5 shadow-md"
                        : "border-outline-variant/30 bg-surface-container hover:border-primary/40"
                    } ${tier.highlight ? "ring-1 ring-secondary/30" : ""}`}
                  >
                    {tier.badge && (
                      <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-secondary text-white text-[8px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider whitespace-nowrap flex items-center gap-0.5">
                        <Star size={7} className="fill-white" /> {tier.badge}
                      </span>
                    )}
                    {active && (
                      <div className="absolute top-2 right-2 w-4 h-4 bg-primary rounded-full flex items-center justify-center">
                        <span className="text-white text-[8px] font-black">✓</span>
                      </div>
                    )}
                    <div className={`mb-2 ${active ? "text-primary" : "text-on-surface-variant"}`}>
                      {tier.icon}
                    </div>
                    <p className="text-xs font-black text-on-surface leading-tight">{tier.label}</p>
                    <p className="text-[10px] text-on-surface-variant mt-0.5 leading-tight">{tier.description}</p>
                    <p className={`text-sm font-black mt-2 font-mono ${active ? "text-primary" : "text-on-surface"}`}>
                      ${tier.price.toFixed(2)}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Comment box */}
          <section className="space-y-2">
            <h3 className="text-xs font-bold text-on-surface-variant uppercase tracking-widest px-1">
              3. Describe What You'd Like
            </h3>
            <textarea
              id="request-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, 500))}
              rows={5}
              placeholder="e.g. I'd love my dog Daisy in a Pixar-style clay render sitting at the Eiffel Tower, with warm golden-hour light and confetti falling around her. She's a golden retriever with fluffy ears!"
              className="w-full bg-white border border-outline-variant rounded-2xl py-3 px-4 text-sm focus:outline-none focus:border-primary text-slate-800 font-medium resize-none leading-relaxed placeholder:text-slate-400 placeholder:font-normal shadow-sm"
            />
            <div className="flex justify-between items-center px-1">
              <p className="text-[10px] text-on-surface-variant">Be as descriptive as possible — style, mood, location, pet details.</p>
              <span className={`text-[10px] font-mono ${comment.length > 450 ? "text-secondary" : "text-outline"}`}>
                {comment.length}/500
              </span>
            </div>
          </section>

          {/* Summary & CTA */}
          <section className="bg-surface-container rounded-2xl p-4 border border-outline-variant/30 space-y-3 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-on-surface-variant">Selected</span>
              <span className="text-xs font-black text-on-surface">{selectedTierObj.label}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-on-surface-variant">Total</span>
              <span className="text-sm font-black text-primary font-mono">${selectedTierObj.price.toFixed(2)}</span>
            </div>
            <div className="h-px bg-outline-variant/20" />
            <p className="text-[10px] text-on-surface-variant leading-relaxed">
              Payment processed securely via Stripe. You'll receive an SMS when your creation is ready. Turnaround is typically 24–48 hours.
            </p>
          </section>

          {error && (
            <div className="p-3 bg-error-container text-on-error-container border border-error/30 rounded-2xl flex gap-2.5 text-xs">
              <AlertCircle size={15} className="text-error flex-shrink-0 mt-0.5" />
              <p className="leading-relaxed">{error}</p>
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={loading}
            id="submit-request-btn"
            className="w-full py-4 bg-primary text-white rounded-2xl font-black text-sm shadow-md hover:bg-primary/95 active:scale-[0.98] transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60 shimmer-button"
          >
            {loading ? (
              <><RefreshCw size={16} className="animate-spin" /> Connecting to Checkout…</>
            ) : (
              <><Send size={16} /> Submit Request — ${selectedTierObj.price.toFixed(2)}<ChevronRight size={14} /></>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
