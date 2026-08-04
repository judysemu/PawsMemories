import React, { useEffect, useRef, useState } from "react";
import { MousePointer2, X, Sparkles } from "lucide-react";

/**
 * Quick guided "watch how it's done" overlay for making a Happy Birthday
 * Pawprint. A scripted cursor moves through a phone mockup, "clicks" each
 * control, and a caption pops out for every step. Self-contained (no live DOM
 * driving). Uses the shipped Furball3D brand image with an emoji fallback.
 */

interface Props {
  onClose: () => void;
  onStart: () => void; // drop the user into the Birthday theme when they finish
}

type ScreenId =
  "themes" | "layouts" | "photo" | "name" | "message" | "create" | "done";
interface Step {
  screen: ScreenId;
  cursor: { top: string; left: string };
  caption: string;
}

const STEPS: Step[] = [
  {
    screen: "themes",
    cursor: { top: "26%", left: "72%" },
    caption: "Tap the Holiday & Birthday theme 🎂",
  },
  {
    screen: "layouts",
    cursor: { top: "30%", left: "30%" },
    caption: "Pick a layout you like",
  },
  {
    screen: "photo",
    cursor: { top: "34%", left: "50%" },
    caption: "Add your pet's photo",
  },
  {
    screen: "name",
    cursor: { top: "62%", left: "40%" },
    caption: "Type their name",
  },
  {
    screen: "message",
    cursor: { top: "72%", left: "45%" },
    caption: "Add a birthday message",
  },
  {
    screen: "create",
    cursor: { top: "90%", left: "50%" },
    caption: "Tap Create — that's it!",
  },
  {
    screen: "done",
    cursor: { top: "50%", left: "50%" },
    caption: "Done! Download or share it 🎉",
  },
];

const PET_SRC = "/brand/furball3d.jpg";

function PetPhoto({ className = "" }: { className?: string }) {
  const [ok, setOk] = useState(true);
  if (!ok)
    return (
      <div
        className={`flex items-center justify-center bg-primary/10 text-4xl ${className}`}
      >
        🐶
      </div>
    );
  return (
    <img
      src={PET_SRC}
      onError={() => setOk(false)}
      alt="Your pet"
      className={`object-cover ${className}`}
    />
  );
}

/**
 * PP-14: the overlay auto-advanced every 2.1s regardless of the user's motion
 * preference. Respect `prefers-reduced-motion: reduce` — for someone with
 * vestibular sensitivity a self-driving animation is the exact thing the
 * setting exists to stop.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    setReduced(query.matches);
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);
  return reduced;
}

export default function PawprintWalkthrough({ onClose, onStart }: Props) {
  const [i, setI] = useState(0);
  const prefersReducedMotion = usePrefersReducedMotion();
  const [playing, setPlaying] = useState(true);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!playing || last || prefersReducedMotion) return;
    const t = setTimeout(
      () => setI((n) => Math.min(n + 1, STEPS.length - 1)),
      2100,
    );
    return () => clearTimeout(t);
  }, [i, playing, last, prefersReducedMotion]);

  /**
   * PP-14: this was a modal in appearance only — no role, no Escape handler,
   * and no focus containment, so keyboard and screen-reader users could tab
   * straight out into the page behind it with no way to dismiss it.
   */
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const container = dialogRef.current;
    const focusables = () => Array.from(
      container?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) || [],
    ).filter((element) => !element.hasAttribute("disabled"));

    focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last_ = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last_.focus();
      } else if (!event.shiftKey && document.activeElement === last_) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const chips = [
    { e: "🕊️", l: "Loss" },
    { e: "🐶", l: "New Pup" },
    { e: "🩺", l: "Vet" },
    { e: "🎂", l: "Birthday" },
    { e: "🌿", l: "Nature" },
    { e: "✈️", l: "Travel" },
  ];

  const screen = () => {
    switch (step.screen) {
      case "themes":
        return (
          <div className="grid grid-cols-2 gap-2 p-3">
            {chips.map((c) => (
              <div
                key={c.l}
                className={`rounded-xl h-16 flex flex-col items-center justify-center text-xs font-bold ${c.l === "Birthday" ? "bg-primary text-on-primary ring-4 ring-primary/30 scale-105" : "bg-surface-container-high text-on-surface"}`}
              >
                <span className="text-xl">{c.e}</span>
                {c.l}
              </div>
            ))}
          </div>
        );
      case "layouts":
        return (
          <div className="p-3 space-y-2">
            <div className="text-[10px] font-bold text-on-surface-variant">
              HOLIDAY &amp; BIRTHDAY
            </div>
            {["Portrait Card", "Landscape Postcard"].map((n, idx) => (
              <div
                key={n}
                className={`rounded-xl h-20 flex items-center px-3 text-xs font-bold ${idx === 0 ? "bg-primary/15 ring-2 ring-primary/50 text-on-surface" : "bg-surface-container-high text-on-surface-variant"}`}
              >
                🎂 {n}
              </div>
            ))}
          </div>
        );
      default:
        // Editor screens: photo / name / message / create share one layout that fills in.
        return (
          <div className="p-3 space-y-2">
            <div className="text-[10px] font-bold text-on-surface-variant">
              PORTRAIT CARD · 🎂
            </div>
            <div
              className={`rounded-xl h-28 overflow-hidden flex items-center justify-center border-2 border-dashed ${["photo", "name", "message", "create", "done"].includes(step.screen) ? "border-primary/40" : "border-outline-variant/40"}`}
            >
              {["photo", "name", "message", "create", "done"].includes(
                step.screen,
              ) ? (
                <PetPhoto className="w-full h-full" />
              ) : (
                <span className="text-[10px] text-on-surface-variant">
                  Upload photo
                </span>
              )}
            </div>
            <div
              className={`rounded-lg h-8 px-2 flex items-center text-xs ${["name", "message", "create", "done"].includes(step.screen) ? "bg-surface-container text-on-surface font-bold" : "bg-surface-container-high text-on-surface-variant/50"}`}
            >
              {["name", "message", "create", "done"].includes(step.screen)
                ? "Buddy"
                : "Pet name"}
            </div>
            <div
              className={`rounded-lg h-8 px-2 flex items-center text-xs ${["message", "create", "done"].includes(step.screen) ? "bg-surface-container text-on-surface font-bold" : "bg-surface-container-high text-on-surface-variant/50"}`}
            >
              {["message", "create", "done"].includes(step.screen)
                ? "Happy 5th Birthday, Buddy!"
                : "Your message"}
            </div>
            <div
              className={`rounded-full h-9 flex items-center justify-center text-xs font-black uppercase tracking-wide ${step.screen === "create" ? "bg-primary text-on-primary ring-4 ring-primary/30 scale-105" : "bg-primary/80 text-on-primary"}`}
            >
              ✨ Create Pawprint
            </div>
          </div>
        );
    }
  };

  const doneCard = (
    <div className="relative w-full h-full flex flex-col items-center justify-center p-4 text-center">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {["🎉", "🎊", "🎈", "⭐", "🎂", "🎉", "✨", "🎈"].map((c, k) => (
          <span
            key={k}
            className="absolute text-lg animate-bounce"
            style={{
              left: `${(k * 13 + 6) % 92}%`,
              top: `${(k * 17 + 8) % 70}%`,
              animationDelay: `${k * 0.15}s`,
            }}
          >
            {c}
          </span>
        ))}
      </div>
      <div className="w-40 h-40 rounded-2xl overflow-hidden ring-4 ring-primary/30 shadow-lg z-10">
        <PetPhoto className="w-full h-full" />
      </div>
      <div className="mt-3 z-10 font-black text-on-surface">
        🎂 Happy Birthday, Buddy!
      </div>
      <div className="mt-3 flex gap-2 z-10">
        <span className="px-3 py-1.5 rounded-full bg-primary text-on-primary text-[11px] font-bold">
          Download
        </span>
        <span className="px-3 py-1.5 rounded-full bg-surface-container-high text-on-surface text-[11px] font-bold">
          Share
        </span>
      </div>
    </div>
  );

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pawprint-walkthrough-title"
      className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center p-4 animate-in fade-in"
    >
      <button
        onClick={onClose}
        aria-label="Close walkthrough"
        className="absolute top-4 right-4 text-white/70 hover:text-white p-2 rounded-full hover:bg-white/10"
      >
        <X size={22} />
      </button>
      <div id="pawprint-walkthrough-title" className="text-white/90 font-extrabold mb-3 flex items-center gap-2">
        <Sparkles size={16} /> Make a Happy Birthday Pawprint
      </div>

      {/* PP-13: a fixed 300px-wide mockup overflowed 320px devices once side
          padding was accounted for. Clamp to the viewport and hold the aspect
          ratio so it scales down instead of clipping. */}
      <div className="relative w-[min(300px,calc(100vw-2rem))] aspect-[300/520] rounded-[2rem] bg-surface border-4 border-black/30 shadow-2xl overflow-hidden">
        <div className="h-9 bg-surface-container-high flex items-center justify-center text-[10px] font-bold text-on-surface-variant">
          Pawprints — Digital Stationery
        </div>
        <div className="relative h-[calc(100%-2.25rem)]">
          {step.screen === "done" ? doneCard : screen()}

          {/* Animated cursor + click ripple */}
          {step.screen !== "done" && (
            <div
              className="absolute transition-all duration-700 ease-out z-20 pointer-events-none"
              style={{
                top: step.cursor.top,
                left: step.cursor.left,
                transform: "translate(-30%, -20%)",
              }}
            >
              <span className="absolute -inset-3 rounded-full bg-primary/40 animate-ping" />
              <MousePointer2
                size={26}
                className="text-black drop-shadow-lg fill-white"
              />
            </div>
          )}

          {/* Caption pop-out */}
          <div
            key={i}
            className="absolute left-1/2 -translate-x-1/2 bottom-3 w-[85%] bg-black/85 text-white text-[12px] font-semibold rounded-xl px-3 py-2 text-center animate-in fade-in slide-in-from-bottom-2 z-30"
          >
            {step.caption}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="mt-4 flex items-center gap-3">
        {/* PP-14: the step dots were unlabelled 8px buttons — invisible to a
            screen reader and below any reasonable touch target. */}
        <div className="flex gap-1.5" role="tablist" aria-label="Walkthrough steps">
          {STEPS.map((_, k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={k === i}
              aria-label={`Step ${k + 1} of ${STEPS.length}`}
              onClick={() => {
                setPlaying(false);
                setI(k);
              }}
              className="grid h-11 w-6 place-items-center"
            >
              <span aria-hidden className={`block w-2 h-2 rounded-full ${k === i ? "bg-white" : "bg-white/40"}`} />
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        {!last ? (
          <>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-full text-white/70 hover:text-white text-sm"
            >
              Skip
            </button>
            <button
              onClick={() => {
                setPlaying(false);
                setI((n) => Math.min(n + 1, STEPS.length - 1));
              }}
              className="px-5 py-2 rounded-full bg-white text-black text-sm font-bold"
            >
              Next
            </button>
          </>
        ) : (
          <button
            onClick={() => {
              onStart();
              onClose();
            }}
            className="px-6 py-2.5 rounded-full bg-primary text-on-primary text-sm font-extrabold flex items-center gap-2"
          >
            <Sparkles size={15} /> Make one now
          </button>
        )}
      </div>
    </div>
  );
}
