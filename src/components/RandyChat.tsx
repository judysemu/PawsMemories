import React, { useState, useRef, useEffect, useCallback } from "react";
import { X, Send, Mic, MicOff, RefreshCw, Sparkles, Volume2, VolumeX, Navigation } from "lucide-react";
import { authedFetch } from "../api";
import { Screen, RandyAction, RandyHeadState } from "../types";
import RandyHead, { RandyHeadRef } from "./RandyHead";
import { speakText } from "../three/randyVisemes";
import RandyWalkthrough from "./RandyWalkthrough";
import { tours, type TourId } from "../randy/tours";
import { useDraggable } from "../randy/useDraggable";

interface Message {
  id: string;
  role: "user" | "model";
  text: string;
  createdAt: Date;
  action?: RandyAction;
}

interface RandyChatProps {
  onUnlockAchievement?: (id: string) => void;
  isDarkMode?: boolean;
  onNavigate?: (screen: Screen) => void;
  onOpenCreditStore?: () => void;
  onLaunchAR?: () => void;
}

/** Map screen string from API to Screen enum value */
function resolveScreen(screen?: string): Screen | null {
  if (!screen) return null;
  const map: Record<string, Screen> = {
    DASHBOARD: Screen.DASHBOARD,
    AVATAR_DASHBOARD: Screen.MODELS,
    STORE: Screen.STORE,
    COMMUNITY: Screen.COMMUNITY,
    PROFILE: Screen.PROFILE,
    ALBUMS: Screen.ALBUMS,
    ALBUM_VIEW: Screen.ALBUM_VIEW,
    PAWPRINTS: Screen.PAWPRINTS,
    PAWLISHER: Screen.PAWLISHER,
    FURBIN: Screen.FURBIN,
    REQUEST_MEMORY: Screen.PAWPRINTS,
    WAGS_INBOX: Screen.WAGS_INBOX,
  };
  return map[screen] ?? null;
}

export default function RandyChat({
  onUnlockAchievement,
  isDarkMode,
  onNavigate,
  onOpenCreditStore,
  onLaunchAR,
}: RandyChatProps) {
  const [isOpen, setIsOpen] = useState(false);
  // Randy is repositionable: his default corner overlaps page controls on
  // several screens, so the user can drag him anywhere and we remember it.
  const { containerRef, style: dragStyle, handleProps, isDragging, hasMoved, reset: resetPosition, shouldAllowClick } =
    useDraggable();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "initial",
      role: "model",
      text: "Woof! Welcome, friend! 🐾 I'm Randy, your Golden Receiver guide! Need help navigating the app, building a 3D avatar, or launching AR? Ask me anything! *wags tail*",
      createdAt: new Date(),
    },
  ]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isMuted, setIsMuted] = useState(true); // Default muted (autoplay policy)
  const [headState, setHeadState] = useState<RandyHeadState>("idle");
  const [activeTourId, setActiveTourId] = useState<TourId | null>(null);
  const [highlightTour, setHighlightTour] = useState<any | null>(null);

  // Microphone / Speech Recognition status
  const [isListening, setIsListening] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const headRef = useRef<RandyHeadRef>(null);
  const speechCancelRef = useRef<{ cancel: () => void } | null>(null);

  // Keep head state in sync
  useEffect(() => {
    headRef.current?.setState(headState);
  }, [headState]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  // Cleanup speech on unmount or close
  useEffect(() => {
    if (!isOpen) {
      speechCancelRef.current?.cancel();
      speechCancelRef.current = null;
      setHeadState("idle");
    }
  }, [isOpen]);

  useEffect(() => {
    const onStartTour = (event: Event) => {
      const tourId = (event as CustomEvent<{ tourId: TourId }>).detail?.tourId;
      if (tourId && tours[tourId]) {
        setActiveTourId(tourId);
        setIsOpen(false);
      }
    };
    window.addEventListener("randy:start-tour", onStartTour);
    return () => window.removeEventListener("randy:start-tour", onStartTour);
  }, []);

  // Set head to 'listen' state when speech recognition active
  useEffect(() => {
    if (isListening) {
      setHeadState("listen");
    } else if (!isLoading) {
      setHeadState("idle");
    }
  }, [isListening, isLoading]);

  /** Speak Randy's reply with lip-sync */
  const speakReply = useCallback((text: string) => {
    if (isMuted) return;

    // Cancel any in-progress speech
    speechCancelRef.current?.cancel();

    // Strip asterisk actions for speech (e.g. *wags tail*)
    const cleanText = text.replace(/\*[^*]+\*/g, "").trim();
    if (!cleanText) return;

    setHeadState("talk");

    speechCancelRef.current = speakText(cleanText, {
      onMouthUpdate: (value) => {
        headRef.current?.setMouthOpen(value);
      },
      onStart: () => {
        setHeadState("talk");
      },
      onEnd: () => {
        setHeadState("idle");
        speechCancelRef.current = null;
      },
    });
  }, [isMuted]);

  /** Execute a Randy action (navigation, AR launch, etc.) */
  const executeAction = useCallback((action: RandyAction) => {
    switch (action.type) {
      case "navigate": {
        const screen = resolveScreen(action.screen);
        if (screen && onNavigate) {
          onNavigate(screen);
          setIsOpen(false);
        }
        break;
      }
      case "launch_ar":
        if (onLaunchAR) {
          onLaunchAR();
          setIsOpen(false);
        }
        break;
      case "open_credit_store":
        if (onOpenCreditStore) {
          onOpenCreditStore();
        }
        break;
      case "start_tour": {
        const tourId = action.tourId as TourId | undefined;
        if (tourId && tours[tourId]) {
          setActiveTourId(tourId);
          setIsOpen(false);
        }
        break;
      }
      case "highlight":
        if (action.target) {
          setHighlightTour({
            id: "highlight",
            title: "Randy highlight",
            screen: Screen.DASHBOARD,
            steps: [{ target: action.target, title: "Look here", body: "This is the part Randy wanted to show you." }],
          });
          setIsOpen(false);
        }
        break;
      default:
        break;
    }
  }, [onNavigate, onLaunchAR, onOpenCreditStore]);

  // Handle Speech Recognition
  const toggleSpeechRecognition = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Voice speech recognition is not supported in this browser version. Try Chrome or Safari!");
      return;
    }

    if (isListening) {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      setIsListening(false);
      return;
    }

    try {
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = "en-US";

      rec.onstart = () => {
        setIsListening(true);
      };

      rec.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        if (transcript) {
          setInputValue((prev) => (prev ? prev + " " + transcript : transcript));
          // Unlock achievement for speech dictation use!
          if (onUnlockAchievement) {
            onUnlockAchievement("voice_use");
          }
        }
      };

      rec.onerror = (e: any) => {
        console.error("Speech Recognition Error:", e);
        setIsListening(false);
      };

      rec.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = rec;
      rec.start();
    } catch (err) {
      console.error(err);
      setIsListening(false);
    }
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputValue.trim() || isLoading) return;

    // Cancel any in-progress speech
    speechCancelRef.current?.cancel();

    const userText = inputValue;
    setInputValue("");
    setMessages((prev) => [
      ...prev,
      {
        id: `msg-${Date.now()}-user`,
        role: "user",
        text: userText,
        createdAt: new Date(),
      },
    ]);
    setIsLoading(true);
    setHeadState("think");

    try {
      // Map previous messages to simple { role, text } history for server
      const chatHistory = messages.map((m) => ({
        role: m.role,
        text: m.text,
      }));

      const res = await authedFetch("/api/randy-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText, history: chatHistory }),
      });

      if (!res.ok) {
        throw new Error("Failed to contact Randy's chat server.");
      }

      const data = await res.json();
      if (data.success && data.text) {
        const action: RandyAction | undefined =
          data.action && data.action.type !== "none"
            ? { type: data.action.type, screen: data.action.screen, tourId: data.action.tourId, target: data.action.target }
            : undefined;

        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}-randy`,
            role: "model",
            text: data.text,
            createdAt: new Date(),
            action,
          },
        ]);

        // Unlock chatterbox achievement
        if (onUnlockAchievement) {
          onUnlockAchievement("randy_chat");
        }

        // Speak the reply (will be skipped if muted)
        speakReply(data.text);

        // Brief happy state if no speech
        if (isMuted) {
          setHeadState("happy");
          setTimeout(() => setHeadState("idle"), 1500);
        }
      }
    } catch (err) {
      console.error(err);
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}-error`,
          role: "model",
          text: "Bow-wow... *barks with confusion* My signal leash got caught on something. Could you try sending that again?",
          createdAt: new Date(),
        },
      ]);
      setHeadState("idle");
    } finally {
      setIsLoading(false);
      // headState is managed by speech callbacks or the happy timeout above
    }
  };

  /** Get a label for the action button */
  const getActionLabel = (action: RandyAction): string => {
    switch (action.type) {
      case "navigate": {
        const labels: Record<string, string> = {
          DASHBOARD: "Go to Home",
          AVATAR_DASHBOARD: "Go to Avatars",
          STORE: "Go to Store",
          COMMUNITY: "Go to Community",
          PROFILE: "Go to Profile",
          ALBUMS: "Go to Albums",
          WAGS_INBOX: "Open Wags",
        };
        return labels[action.screen || ""] || "Take me there";
      }
      case "launch_ar":
        return "Launch AR 🌟";
      case "open_credit_store":
        return "Open Credit Store";
      case "start_tour":
        return "Show me how";
      case "highlight":
        return "Show me";
      default:
        return "Take me there";
    }
  };

  return (
    <>
    {activeTourId && (
      <RandyWalkthrough tour={tours[activeTourId]} onClose={() => setActiveTourId(null)} onNavigate={onNavigate} />
    )}
    {highlightTour && (
      <RandyWalkthrough tour={highlightTour} onClose={() => setHighlightTour(null)} onNavigate={onNavigate} />
    )}
    <div
      ref={containerRef}
      style={dragStyle}
      className={`fixed z-55 flex flex-col items-end pointer-events-none ${isDragging ? "select-none" : ""}`}
    >

      {/* Expanded chat window */}
      {isOpen && (
        <div className="w-80 h-[28rem] mb-3 bg-surface-container-low border border-outline-variant/50 rounded-3xl shadow-xl flex flex-col overflow-hidden pointer-events-auto animate-slide-up">
          {/* Header with 3D Randy Head */}
          <div
            {...handleProps}
            title="Drag to move Randy"
            className="bg-primary/10 px-4 py-2.5 border-b border-outline-variant/30 flex justify-between items-center bg-radial from-amber-50 to-amber-100/30"
          >
            <div className="flex items-center gap-2.5">
              {/* 3D Head avatar in header */}
              <RandyHead
                ref={headRef}
                size={48}
                paused={!isOpen}
                className="ring-2 ring-amber-400/60 shadow-lg flex-shrink-0"
              />
              <div>
                <h4 className="text-xs font-black text-on-surface flex items-center gap-1">
                  Randy the Golden Receiver
                  <Sparkles size={11} className="text-orange-600 animate-pulse animate-duration-1000" />
                </h4>
                <p className="text-[9px] text-primary font-bold uppercase tracking-wider">
                  {headState === "listen" ? "Listening..." :
                   headState === "think" ? "Sniffing for answers..." :
                   headState === "talk" ? "Speaking..." :
                   "Online & Tail Wagging"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {/* Mute/Unmute toggle */}
              <button
                onClick={() => {
                  setIsMuted(!isMuted);
                  if (!isMuted) {
                    // Going muted — cancel current speech
                    speechCancelRef.current?.cancel();
                    speechCancelRef.current = null;
                    setHeadState("idle");
                  }
                }}
                className={`p-1.5 rounded-full transition-all cursor-pointer ${
                  isMuted
                    ? "text-on-surface-variant/60 hover:bg-outline-variant/20"
                    : "text-orange-600 bg-orange-100/50 hover:bg-orange-100"
                }`}
                title={isMuted ? "Unmute Randy's voice" : "Mute Randy's voice"}
              >
                {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="text-on-surface-variant hover:text-on-surface p-1 rounded-full hover:bg-outline-variant/20 cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Messages Area */}
          <div ref={scrollRef} className="flex-grow p-4 overflow-y-auto space-y-3.5 hide-scrollbar">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col max-w-[85%] ${
                  msg.role === "user" ? "ml-auto items-end" : "mr-auto items-start"
                }`}
              >
                <div
                  className={`px-3 py-2.5 rounded-2xl text-xs leading-relaxed ${
                    msg.role === "user"
                      ? "bg-primary text-white rounded-tr-none"
                      : "bg-surface-container-highest text-on-surface rounded-tl-none border border-outline-variant/20"
                  }`}
                >
                  {msg.text}

                  {/* Action button for guidance actions */}
                  {msg.role === "model" && msg.action && msg.action.type !== "none" && (
                    <button
                      onClick={() => executeAction(msg.action!)}
                      className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white text-[10px] font-bold rounded-xl hover:from-amber-600 hover:to-orange-600 active:scale-95 transition-all cursor-pointer shadow-sm"
                    >
                      <Navigation size={10} />
                      {getActionLabel(msg.action)}
                    </button>
                  )}
                </div>
                <span className="text-[8px] text-on-surface-variant/65 mt-1 px-1">
                  {msg.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
            {isLoading && (
              <div className="flex items-center gap-1.5 text-xs text-on-surface-variant animate-pulse py-1">
                <RefreshCw size={12} className="animate-spin text-orange-600" />
                <span className="font-semibold italic">Randy is sniffing for answers...</span>
              </div>
            )}
          </div>

          {/* Input Panel */}
          <form onSubmit={handleSendMessage} className="p-3 border-t border-outline-variant/20 bg-surface-container">
            <div className="flex items-center gap-1.5 bg-white border border-outline-variant/40 rounded-xl p-1.5 pr-2 shadow-inner">
              <input
                type="text"
                placeholder={isListening ? "Listening... Speak now!" : "Ask Randy anything..."}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                disabled={isListening}
                className="flex-grow px-2 py-1 text-xs focus:outline-none bg-transparent disabled:opacity-50"
              />

              {/* Mic Indicator button */}
              <button
                type="button"
                onClick={toggleSpeechRecognition}
                className={`p-1.5 rounded-lg transition-all cursor-pointer ${
                  isListening
                    ? "bg-red-500 text-white animate-pulse"
                    : "text-on-surface-variant hover:bg-outline-variant/20"
                }`}
                title={isListening ? "Stop listening" : "Dictate your message with microphone"}
              >
                {isListening ? <MicOff size={13} /> : <Mic size={13} />}
              </button>

              <button
                type="submit"
                disabled={!inputValue.trim() || isLoading}
                className="p-1.5 bg-primary text-white rounded-lg hover:bg-primary/95 disabled:opacity-30 transition-all cursor-pointer shadow-sm"
              >
                <Send size={12} />
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Floating Sparkly Button — with 3D head as collapsed avatar */}
      <button
        {...handleProps}
        aria-label={isOpen ? "Close Randy" : "Chat with Randy — drag to move"}
        title="Drag to move Randy"
        onClick={() => {
          // A drag ends with a click event on the handle; swallow it so moving
          // Randy doesn't also toggle the chat window.
          if (!shouldAllowClick()) return;
          setIsOpen(!isOpen);
        }}
        onDoubleClick={() => {
          if (hasMoved) resetPosition();
        }}
        className={`w-14 h-14 bg-gradient-to-tr from-amber-500 to-orange-400 text-white rounded-full flex items-center justify-center shadow-lg transition-all pointer-events-auto relative group glow-orange-shadow overflow-hidden ${
          isDragging ? "scale-105 ring-2 ring-white/70" : "hover:scale-105 active:scale-95"
        }`}
      >
        {isOpen ? (
          <X size={24} className="animate-duration-300" />
        ) : (
          <>
            {/* Small 3D head in the bubble */}
            <RandyHead
              size={52}
              paused={isOpen}
              className="absolute inset-0.5 rounded-full"
            />
            <div className="absolute -top-1 -right-1 w-4 h-4 bg-primary text-white rounded-full text-[8.5px] font-extrabold flex items-center justify-center animate-pulse border border-white z-10">
              AI
            </div>
            {/* tooltip */}
            <span className="absolute right-16 scale-0 group-hover:scale-100 transition-all duration-200 bg-slate-900/90 text-white text-[10px] py-1 px-2.5 rounded-xl font-bold whitespace-nowrap shadow border border-slate-700 z-10">
              Chat with Randy 🐾 · drag to move
            </span>
          </>
        )}
      </button>
    </div>
    </>
  );
}
