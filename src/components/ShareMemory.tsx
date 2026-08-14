import React, { useState, useRef, useEffect } from "react";
import { ArrowLeft, Copy, Check, Download, Share2, Compass, ShieldAlert, Heart, ExternalLink, Sparkles, ShoppingBag, Video } from "lucide-react";
import { Creation } from "../types";
import { authedFetch } from "../api";
import OrderAlbumModal from "./OrderAlbumModal";
import { createVideo, pollJob } from "../api";
import { CREDIT_PRICES } from "../pricing";

interface ShareMemoryProps {
  creation: Creation;
  userCredits: number;
  onBack: () => void;
  isAdmin?: boolean;
}

export default function ShareMemory({ creation, userCredits, onBack, isAdmin }: ShareMemoryProps) {
  const [localCreation, setLocalCreation] = useState<Creation>(creation);
  const [copied, setCopied] = useState(false);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [showAnimateModal, setShowAnimateModal] = useState(false);
  const [selectedAspectRatio, setSelectedAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [animatingJobId, setAnimatingJobId] = useState<number | null>(null);
  const [pollStatus, setPollStatus] = useState<string>("");
  const [roverOwnerName, setRoverOwnerName] = useState("Alex");
  const [busy, setBusy] = useState(false);

  const pollInterval = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, []);

  const startPolling = (jobId: number) => {
    setAnimatingJobId(jobId);
    setPollStatus("queued");

    pollInterval.current = setInterval(async () => {
      try {
        const res = await pollJob(jobId);
        if (res.status === "done") {
          if (pollInterval.current) clearInterval(pollInterval.current);
          setAnimatingJobId(null);
          setLocalCreation((prev) => ({ ...prev, media_type: "video", video_url: res.video_url || null }));
        } else if (res.status === "failed") {
          if (pollInterval.current) clearInterval(pollInterval.current);
          setAnimatingJobId(null);
          alert(`Animation failed: ${res.error || "Unknown error"}`);
        } else {
          setPollStatus(res.status);
        }
      } catch (err) {
        console.error("Polling error:", err);
      }
    }, 5000);
  };

  const handleConfirmAnimate = async () => {
    if (!isAdmin && userCredits < CREDIT_PRICES.ANIMATED_VIDEO_8S) {
      alert(`You need ${CREDIT_PRICES.ANIMATED_VIDEO_8S} credits to animate a memory. Purchase more credits in the store!`);
      return;
    }
    setShowAnimateModal(false);
    try {
      const res = await createVideo(localCreation.id, "subtle cinematic motion", selectedAspectRatio);
      startPolling(res.jobId);
    } catch (err: any) {
      alert(err.message || "Failed to start animation.");
    }
  };
  const [roverCustomText, setRoverCustomText] = useState("Today was such a joyful day! I crafted this magical portrait as a keepsake memory.");
  const [roverTemplate, setRoverTemplate] = useState("stay_update");
  const [roverCopied, setRoverCopied] = useState(false);
  const [showIntegrationsGuide, setShowIntegrationsGuide] = useState(false);

  const getPetFirstName = () => {
    // Graceful extraction or fallback
    if (!localCreation.name) return "your pet";
    return localCreation.name.split(" ")[0];
  };

  const getRoverMessageText = () => {
    const petName = getPetFirstName();
    if (roverTemplate === "stay_update") {
      return `Hi ${roverOwnerName}! 🐾 Just wanted to send an update on ${petName}. They are doing fantastic! I crafted this special ${localCreation.style} artwork of them today. Check it out here: ${localCreation.image_url}`;
    }
    if (roverTemplate === "goodnight") {
      return `Good evening ${roverOwnerName}! 🌙 ${petName} is all curled up and cozy. Before we turn in, here is a lovely ${localCreation.style} photo memory I made of them: ${localCreation.image_url}`;
    }
    return `Hi ${roverOwnerName}! We just finished a super fun session. Look at this beautiful ${localCreation.style} digital keepsake of your furry buddy! 🎨🐶 Link: ${localCreation.image_url}`;
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(localCreation.image_url || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyRoverMessage = () => {
    navigator.clipboard.writeText(getRoverMessageText());
    setRoverCopied(true);
    setTimeout(() => setRoverCopied(false), 2000);
  };

  const handleDownload = async () => {
    try {
      setBusy(true);
      const urlToDownload = localCreation.media_type === "video" && localCreation.video_url 
        ? localCreation.video_url 
        : (localCreation.image_url || "");
        
      const ext = localCreation.media_type === "video" ? "mp4" : "jpeg";
      const filename = `${localCreation.name?.replace(/\s+/g, "_") || "memory"}.${ext}`;
      
      const res = await authedFetch(`/api/download?url=${encodeURIComponent(urlToDownload)}`);
      if (!res.ok) throw new Error("Download failed");
      
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error(err);
      alert("Download failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-lg mx-auto px-4 py-6 space-y-6">
      
      {/* Back button header row */}
      <div className="flex justify-between items-center px-1">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs font-bold text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
        >
          <ArrowLeft size={16} />
          Back to Feed
        </button>
        <span className="text-[10px] font-bold text-secondary uppercase tracking-widest bg-secondary-container/15 py-1 px-3 rounded-full">
          Memory Shared
        </span>
      </div>

      {/* Hero preview card of selected creation */}
      <div className="relative w-full aspect-[4/3] rounded-3xl overflow-hidden soft-glow-shadow border-4 border-white bg-surface-container bg-black">
        {localCreation.media_type === "video" && localCreation.video_url ? (
          <video
            src={localCreation.video_url}
            autoPlay
            loop
            muted
            playsInline
            className="w-full h-full object-cover"
          />
        ) : (
          <img
            alt={localCreation.name || "Creation"}
            className="w-full h-full object-cover"
            src={localCreation.image_url || ""}
            referrerPolicy="no-referrer"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent"></div>

        <div className="absolute bottom-4 left-4 right-4 flex justify-between items-end text-white">
          <div>
            <span className="text-[10px] font-bold text-primary-container-lowest uppercase tracking-wider bg-primary/40 backdrop-blur-sm px-2.5 py-0.5 rounded-full mb-1 inline-block">
              {localCreation.style} Restyle
            </span>
            <h2 className="text-lg font-bold leading-tight">{localCreation.name || "Untitled Memory"}</h2>
          </div>
          <p className="text-[10px] opacity-80 font-medium whitespace-nowrap">
            {localCreation.created_at ? new Date(localCreation.created_at).toLocaleDateString() : "Recent"}
          </p>
        </div>
        
        {localCreation.media_type === "video" && (
          <div className="absolute top-3 right-3 bg-black/60 backdrop-blur-sm text-white px-3 py-1 rounded-full flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider">
            <span className="w-1.5 h-1.5 bg-yellow-400 rounded-full animate-pulse" />
            Video
          </div>
        )}
      </div>

      {/* Streamlined Animate Flow Block */}
      {localCreation.media_type === "still" && !animatingJobId && (
        <button
          onClick={() => setShowAnimateModal(true)}
          className="w-full py-4 bg-gradient-to-r from-purple-500 to-indigo-600 text-white rounded-3xl font-black text-sm shadow-xl flex items-center justify-center gap-2 hover:brightness-110 active:scale-[0.98] transition-all cursor-pointer border-2 border-white/20"
        >
          <Sparkles size={18} />
          <span>Bring to Life - Animate Video ({CREDIT_PRICES.ANIMATED_VIDEO_8S}cr)</span>
        </button>
      )}

      {animatingJobId && (
        <div className="w-full py-4 bg-surface-container rounded-3xl border border-outline-variant/30 flex flex-col items-center justify-center space-y-2">
           <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
           <span className="text-xs font-bold text-primary uppercase tracking-widest">
              Generating Video... Status: {pollStatus}
           </span>
        </div>
      )}

      {/* Share Actions buttons */}
      <section className="bg-surface-container rounded-3xl p-5 border border-outline-variant/30 space-y-4 shadow-sm">
        <h3 className="text-xs font-bold text-on-surface-variant uppercase tracking-widest px-1">
          Share your masterpiece
        </h3>

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => alert("TikTok integration is coming soon! Direct sharing will be available in a future update.")}
            className="flex items-center justify-center gap-2 py-3 bg-on-surface text-white hover:brightness-110 active:scale-95 transition-all text-xs font-bold rounded-xl cursor-pointer opacity-70"
          >
            <Share2 size={14} className="text-secondary-container" />
            TikTok Feed
          </button>
          
          <button
            onClick={() => alert("Instagram integration is coming soon! Direct sharing will be available in a future update.")}
            className="flex items-center justify-center gap-2 py-3 bg-gradient-to-tr from-orange-500 to-rose-600 text-white hover:brightness-110 active:scale-95 transition-all text-xs font-bold rounded-xl cursor-pointer opacity-70"
          >
            <Share2 size={14} className="text-orange-200" />
            Insta Stories
          </button>
        </div>

        {/* Copy memory Link snippet block */}
        <div className="bg-white/60 p-3 rounded-xl border border-outline-variant/50 flex justify-between items-center gap-3">
          <div className="truncate text-left flex-grow">
            <span className="text-[9px] font-bold text-outline uppercase tracking-wider block">Direct Image Link</span>
            <p className="text-xs text-on-surface-variant truncate font-sans">{localCreation.image_url}</p>
          </div>
          <button
            onClick={handleCopyLink}
            className="w-10 h-10 rounded-lg bg-surface-container flex items-center justify-center text-primary border border-outline-variant/30 hover:bg-surface-container-high transition-colors cursor-pointer"
            title="Copy URL"
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </div>
      </section>

      {/* Rover Pet-Sitter Quick-Share Assistant */}
      <section className="bg-surface-container rounded-3xl p-5 border border-outline-variant/30 space-y-4 shadow-sm">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2 text-primary">
            <Compass size={18} className="text-orange-600 animate-spin animate-duration-[12000ms]" />
            <h3 className="text-xs font-black uppercase tracking-wider font-sans">
              Rover Sitter Quick-Share
            </h3>
          </div>
          <span className="text-[9px] bg-amber-500/10 text-amber-600 font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider">
            Sitter Toolkit
          </span>
        </div>

        <p className="text-xs text-on-surface-variant leading-relaxed">
          Are you sitting <strong className="text-on-surface">{getPetFirstName()}</strong>? Share this beautiful masterpiece directly with their owner Alex on your Rover thread!
        </p>

        {/* Form elements inside assistant */}
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider px-1 block mb-1">
                Owner's Name
              </label>
              <input
                type="text"
                value={roverOwnerName}
                onChange={(e) => setRoverOwnerName(e.target.value)}
                placeholder="e.g. Alex, Sarah"
                className="w-full bg-white border border-outline-variant rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-primary text-slate-800 font-medium"
              />
            </div>
            <div>
              <label className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider px-1 block mb-1">
                Update Scenario
              </label>
              <select
                value={roverTemplate}
                onChange={(e) => setRoverTemplate(e.target.value)}
                className="w-full bg-white border border-outline-variant rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-primary text-slate-800 font-black cursor-pointer"
              >
                <option value="stay_update">🐾 Active Day Update</option>
                <option value="goodnight">🌙 Sweet Dreams Sleep</option>
                <option value="keepsake">🎨 Digital Art Keepsake</option>
              </select>
            </div>
          </div>

          {/* Render Preview Card */}
          <div className="bg-white/95 dark:bg-slate-900 border border-outline-variant/40 rounded-2xl p-4 space-y-2.5 relative">
            <div className="flex justify-between items-center pb-2 border-b border-outline-variant/20">
              <span className="text-[9px] font-black text-rose-500 uppercase tracking-widest flex items-center gap-1">
                <Heart size={10} className="fill-rose-500" /> Rover Message Preview
              </span>
              <span className="text-[9px] text-on-surface-variant/50 font-mono">Character length: {getRoverMessageText().length}</span>
            </div>
            
            <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed italic pr-3 font-medium">
              "{getRoverMessageText()}"
            </p>

            {/* Direct Thumbnail Attachment Badge */}
            <div className="flex items-center gap-2.5 bg-surface-container-low/80 p-2 rounded-xl border border-outline-variant/15">
              <img
                src={localCreation.image_url || ""}
                alt="Thumbnail Attachment"
                className="w-10 h-10 object-cover rounded-lg border border-outline-variant/20"
                referrerPolicy="no-referrer"
              />
              <div className="text-[10px] truncate">
                <span className="font-bold text-on-surface block">Attached Masterpiece link</span>
                <span className="text-on-surface-variant font-mono truncate block max-w-[200px]">{localCreation.image_url}</span>
              </div>
            </div>
          </div>

          {/* Quick-Action Controls */}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <button
              onClick={handleCopyRoverMessage}
              type="button"
              className="py-3 px-4 bg-primary text-white text-xs font-black uppercase rounded-xl hover:bg-primary/95 shadow-sm active:scale-95 duration-100 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {roverCopied ? <Check size={14} className="text-white" /> : <Copy size={14} />}
              <span>{roverCopied ? "Copied!" : "Copy Rover Text"}</span>
            </button>

            <a
              href="https://www.rover.com/inbox/"
              target="_blank"
              rel="noopener noreferrer"
              className="py-3 px-4 bg-orange-600 text-white text-xs font-black uppercase rounded-xl hover:bg-orange-700 shadow-sm active:scale-95 duration-100 transition-all flex items-center justify-center gap-1.5 text-center cursor-pointer decoration-transparent"
            >
              <ExternalLink size={14} />
              <span>Go to Rover Inbox</span>
            </a>
          </div>

          {/* API Transparency notice helper info toggle */}
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setShowIntegrationsGuide(!showIntegrationsGuide)}
              className="text-[10px] text-primary font-bold uppercase tracking-wider hover:underline flex items-center gap-1 cursor-pointer"
            >
              <ShieldAlert size={12} />
              {showIntegrationsGuide ? "Hide API Integration details" : "How does direct Rover messaging integration work?"}
            </button>

            {showIntegrationsGuide && (
              <div className="mt-2 bg-primary/5 p-3 rounded-xl border border-primary/20 text-[10px] text-primary font-medium tracking-wide leading-relaxed space-y-1 animate-slide-down">
                <p className="font-bold uppercase text-[9px] tracking-wider text-primary">Integration Architecture Notice Details:</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>Rover.com is a closed marketplace and does not maintain public developer APIs or direct SMS/messaging webhooks for third-party platforms to programmatically inject messages on behalf of active users.</li>
                  <li>Our tailored **Quick-Share Assistant** bridges this gap securely! By compiling an optimized text payload and providing a 1-click clipboard shortcut tool, you can drop high-resolution cloud links into the owner's chat thread safely.</li>
                  <li>Unlike heavy platform proxies, this guarantees 100% security under Rover Terms of Service since it operates directly through your certified human workspace.</li>
                </ul>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Download direct heirloom high-res photo button */}
      <div className="pt-2 flex flex-col gap-3">
        <button
          onClick={() => alert("Physical photo album printing is coming soon! Check back later.")}
          className="w-full py-4 bg-gradient-to-tr from-amber-500 to-orange-600 text-white rounded-2xl font-black text-sm shadow-lg flex items-center justify-center gap-2 hover:brightness-110 active:scale-[0.98] transition-all cursor-pointer border border-white/10 glow-orange-shadow opacity-70"
        >
          <ShoppingBag size={16} />
          <span>Order Physical Photo Album (Coming Soon)</span>
        </button>

        <button
          onClick={handleDownload}
          className="w-full py-3.5 bg-primary text-white rounded-2xl font-bold text-sm shadow-md flex items-center justify-center gap-2 hover:bg-primary/95 transition-colors cursor-pointer border border-outline-variant/20"
        >
          <Download size={16} />
          <span>Download High-Resolution Image</span>
        </button>
        
        <button
          onClick={onBack}
          className="w-full py-2.5 text-on-surface-variant text-xs font-semibold hover:text-primary transition-colors cursor-pointer"
        >
          Browse gallery instead
        </button>
      </div>

      {showOrderModal && (
        <OrderAlbumModal
          creation={localCreation}
          userCredits={userCredits}
          onClose={() => setShowOrderModal(false)}
        />
      )}

      {/* Video Settings Modal */}
      {showAnimateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-surface rounded-3xl p-6 w-full max-w-sm text-on-surface shadow-2xl border border-outline-variant/30">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-10 h-10 bg-primary/20 rounded-full flex items-center justify-center text-primary">
                <Video size={20} />
              </div>
              <div>
                <h3 className="font-extrabold text-lg">Animate Memory</h3>
                <p className="text-[10px] uppercase font-bold tracking-widest text-secondary">{CREDIT_PRICES.ANIMATED_VIDEO_8S}cr per generation</p>
              </div>
            </div>

            <div className="space-y-4">
              {/* Aspect Ratio */}
              <div className="flex items-center justify-between bg-surface-container p-3 rounded-xl border border-outline-variant/30">
                <div>
                  <span className="text-xs font-bold">Aspect Ratio</span>
                  <p className="text-[9px] text-on-surface-variant">Landscape or Portrait</p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedAspectRatio("16:9")}
                    className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all border ${
                      selectedAspectRatio === "16:9"
                        ? "bg-primary text-white border-primary"
                        : "bg-surface-container-high text-on-surface-variant border-outline-variant hover:bg-outline-variant/20"
                    }`}
                  >
                    ⬛ 16:9
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedAspectRatio("9:16")}
                    className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all border ${
                      selectedAspectRatio === "9:16"
                        ? "bg-primary text-white border-primary"
                        : "bg-surface-container-high text-on-surface-variant border-outline-variant hover:bg-outline-variant/20"
                    }`}
                  >
                    📱 9:16
                  </button>
                </div>
              </div>

              <p className="text-xs text-on-surface-variant">Natural ambient sound is generated automatically by Veo — no separate audio step needed.</p>

              <div className="pt-2 flex gap-3">
                <button
                  onClick={() => setShowAnimateModal(false)}
                  className="flex-1 py-3 text-xs font-bold text-on-surface-variant hover:bg-surface-container rounded-xl transition-all cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmAnimate}
                  className="flex-1 py-3 bg-primary text-white rounded-xl text-xs font-black shadow-md hover:bg-primary/95 active:scale-95 transition-all flex justify-center items-center gap-1.5 cursor-pointer"
                >
                  <Sparkles size={14} />
                  Start
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
