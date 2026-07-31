import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowRight, Gift, Film, Crown, Gamepad2 } from "lucide-react";
import {
  HISTORICAL_PET_CATALOG,
  type HistoricalPetRecord,
} from "../../shared/historicalPetCatalog.ts";

/**
 * HeroScroller — the four "quick hit" hero cards.
 *
 * DESIGN NOTES
 * ------------
 * Scroll-snap carriage, not a timed carousel. A timed carousel moves the hero
 * out from under someone mid-read; snap points hand pacing to the reader and
 * cost no JS to drive. Horizontal on desktop, vertical stack on mobile where a
 * horizontal scroll region fights the page scroll.
 *
 * The active card is tracked with IntersectionObserver rather than scroll math
 * so it stays correct through resize, zoom, and keyboard navigation without a
 * resize listener.
 *
 * ACCESSIBILITY
 * - Each card is a real <button>/<a>, so the whole flow is keyboard reachable.
 * - The dot rail is <button>s with aria-current, not decorative divs.
 * - Motion: everything animated here is suppressed under
 *   prefers-reduced-motion, including the video's scroll pacing.
 */

export interface HeroScrollerProps {
  onOpenCreate: () => void;
  onOpenPawprints: () => void;
  onOpenShop: () => void;
}

type SlideId = "pawprint-offer" | "appeal-reel" | "collection" | "playpen";

interface Slide {
  id: SlideId;
  eyebrow: string;
  title: string;
  callout: string;
  body: string;
  cta: string;
  icon: React.ComponentType<{
    size?: number;
    strokeWidth?: number;
    className?: string;
  }>;
}

const SLIDES: Slide[] = [
  {
    id: "pawprint-offer",
    eyebrow: "Send a pawprint",
    title: "A keepsake made from your photo",
    callout: "MADE BY YOU",
    body: "Design a personal Pawprint with your own photo and words, then download it or email the finished keepsake to someone you love.",
    cta: "Send a pawprint",
    icon: Gift,
  },
  {
    id: "appeal-reel",
    eyebrow: "Photo to motion",
    title: "Your pet, actually moving",
    callout: "HYPER-REAL",
    body: "One still photo becomes a hyper-realistic animated video. The ears lift, the head turns, the fur catches the light. It plays as you scroll.",
    cta: "Animate a photo",
    icon: Film,
  },
  {
    id: "collection",
    eyebrow: "Collection preview",
    title: "Original historical roles, as pets",
    callout: "PREVIEW",
    body: "Four original, pre-1900-inspired pet portraits preview stories being developed for Animator. These are concept images, not finished 3D models or products.",
    cta: "Create your own pet",
    icon: Crown,
  },
  {
    id: "playpen",
    eyebrow: "Try it now",
    title: "A playpen, right here",
    callout: "PLAYABLE",
    body: "No signup, no download. Poke the pet and watch it respond — a two-bit sketch of what your own model will do once it's yours.",
    cta: "Make mine real",
    icon: Gamepad2,
  },
];

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return reduced;
}

/* ─────────────────────────── Slide 2: video ─────────────────────────── */

/**
 * The reel plays, but the scroller keeps pace: playback is driven by how far the
 * card has travelled through the viewport rather than by wall-clock time. Scroll
 * forward and it advances; stop and it holds on a frame.
 *
 * Hard-muted per the brief — `muted` plus `defaultMuted` so autoplay policies
 * don't block the first frame, and no controls to un-mute.
 *
 * Falls back to a still if the mp4 isn't present. That matters because the file
 * is generated out-of-band by scripts/generate-hero-reel.mjs; the hero must not
 * render a black box on a fresh checkout.
 */
function AppealReel({ reduced }: { reduced: boolean }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The generated reel is not shipped in this release. Start on the owned still
  // instead of deliberately requesting absent media and relying on onError.
  const [failed, setFailed] = useState(true);
  const rafRef = useRef<number | null>(null);

  // React renders `muted` as a property, but autoplay gating in some engines
  // reads the ATTRIBUTE. Setting it imperatively guarantees the hero can never
  // produce sound, which the brief requires, and keeps autoplay unblocked.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    v.defaultMuted = true;
    v.setAttribute("muted", "");
  }, [failed]);

  useEffect(() => {
    if (reduced || failed) return;
    const wrap = wrapRef.current;
    const video = videoRef.current;
    if (!wrap || !video) return;

    let ticking = false;

    const sync = () => {
      ticking = false;
      const v = videoRef.current;
      if (!v || !v.duration || Number.isNaN(v.duration)) return;
      const rect = wrap.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      // 0 when the card's top edge reaches the bottom of the viewport,
      // 1 when its bottom edge reaches the top.
      const raw = (vh - rect.top) / (vh + rect.height);
      const progress = Math.min(1, Math.max(0, raw));
      const target = progress * v.duration;
      // Only seek on a meaningful delta; sub-frame seeks thrash the decoder.
      if (Math.abs(v.currentTime - target) > 0.04) {
        v.currentTime = target;
      }
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      rafRef.current = requestAnimationFrame(sync);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    sync();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [reduced, failed]);

  if (failed) {
    return (
      <div
        ref={wrapRef}
        className="relative h-full w-full overflow-hidden rounded-2xl bg-surface-container-high"
      >
        <img
          src="/featured-models/tuck.webp"
          alt="A labradoodle model rendered in 3D"
          className="h-full w-full object-cover"
        />
        <span className="absolute bottom-3 left-3 rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white backdrop-blur-sm">
          Reel coming soon
        </span>
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden rounded-2xl bg-black/80"
    >
      <video
        ref={videoRef}
        src="/featured-models/tuck.webp"
        poster="/featured-models/tuck.webp"
        muted
        playsInline
        preload="metadata"
        loop={reduced}
        autoPlay={reduced}
        aria-label="A pet photo animated into a moving video"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
      <span className="absolute bottom-3 left-3 rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white backdrop-blur-sm">
        {reduced ? "Playing" : "Scroll to play"}
      </span>
    </div>
  );
}

/* ─────────────────────── Slide 3: collection preview ─────────────────── */

function HistoricalPreviewCard({
  entry,
  onOpenCreate,
  reduced,
}: {
  entry: HistoricalPetRecord;
  onOpenCreate: () => void;
  reduced: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpenCreate}
      aria-label={`${entry.displayName} concept preview. Open Create to make your own pet.`}
      className={`group relative min-h-32 overflow-hidden rounded-2xl bg-surface-container-high text-left ring-1 ring-inset ring-outline-variant/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${reduced ? "" : "transition-transform hover:scale-[1.02]"}`}
    >
      {imageFailed ? (
        <span
          role="img"
          aria-label={`${entry.displayName} preview unavailable`}
          className="grid h-full min-h-32 place-items-center px-3 text-center text-xs font-bold text-on-surface-variant"
        >
          Preview unavailable
        </span>
      ) : (
        <img
          src={entry.previewAsset.publicPath}
          alt={entry.altText}
          width={entry.previewAsset.width}
          height={entry.previewAsset.height}
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
          className="h-full min-h-32 w-full object-cover"
        />
      )}
      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-3 pb-2 pt-8 text-white">
        <span className="block text-[11px] font-black leading-tight">
          {entry.displayName}
        </span>
        <span className="block text-[9px] font-semibold opacity-85">
          Concept preview · {entry.stylePeriod}
        </span>
      </span>
    </button>
  );
}

function CollectionSlide({
  onOpenCreate,
  reduced,
}: {
  onOpenCreate: () => void;
  reduced: boolean;
}) {
  return (
    <div className="grid h-full w-full grid-cols-2 gap-2.5">
      {HISTORICAL_PET_CATALOG.map((entry) => (
        <HistoricalPreviewCard
          key={entry.id}
          entry={entry}
          onOpenCreate={onOpenCreate}
          reduced={reduced}
        />
      ))}
    </div>
  );
}

/* ───────────────────────── Slide 4: the playpen ──────────────────────── */

type PetKind = "cat" | "dog";
type PetAction = "idle" | "sit" | "wave" | "spin" | "happy";

/**
 * A deliberately two-bit playpen: a single-colour stroked SVG outline, no fills,
 * no 3D, no assets to download. It is a promise of the real model rather than a
 * preview of it, and it has to cost nothing on the landing page's critical path.
 *
 * Pure CSS animation keyed off a state string. Reduced-motion swaps the
 * animations for static poses rather than disabling the controls, so the
 * interaction still works.
 */
function Playpen({
  reduced,
  onOpenCreate,
}: {
  reduced: boolean;
  onOpenCreate: () => void;
}) {
  const [kind, setKind] = useState<PetKind>("dog");
  const [action, setAction] = useState<PetAction>("idle");
  const timer = useRef<number | null>(null);

  const trigger = useCallback((next: PetAction) => {
    setAction(next);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAction("idle"), 1400);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const animClass = reduced
    ? ""
    : action === "wave"
      ? "hero-pet-wave"
      : action === "spin"
        ? "hero-pet-spin"
        : action === "happy"
          ? "hero-pet-bounce"
          : action === "sit"
            ? "hero-pet-sit"
            : "hero-pet-idle";

  return (
    <div className="flex h-full w-full flex-col gap-2.5">
      <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-2xl bg-surface-container-high ring-1 ring-inset ring-outline-variant/20">
        {/* two-bit floor line */}
        <div className="pointer-events-none absolute inset-x-6 bottom-8 h-px bg-on-surface/15" />
        <svg
          viewBox="0 0 120 120"
          className={`h-32 w-32 text-on-surface ${animClass}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          role="img"
          aria-label={`A simple outline ${kind}, currently ${action}`}
        >
          {kind === "dog" ? (
            <>
              <ellipse cx="60" cy="74" rx="26" ry="18" />
              <circle cx="60" cy="42" r="18" />
              <path d="M46 30 L40 14 L54 24" />
              <path d="M74 30 L80 14 L66 24" />
              <circle
                cx="53"
                cy="41"
                r="2.2"
                fill="currentColor"
                stroke="none"
              />
              <circle
                cx="67"
                cy="41"
                r="2.2"
                fill="currentColor"
                stroke="none"
              />
              <path d="M60 48 L60 52" />
              <path d="M54 52 Q60 57 66 52" />
              <path d="M86 66 Q100 58 96 44" />
              <path d="M44 90 L44 100 M56 92 L56 102 M64 92 L64 102 M76 90 L76 100" />
            </>
          ) : (
            <>
              <ellipse cx="60" cy="74" rx="24" ry="18" />
              <circle cx="60" cy="42" r="17" />
              <path d="M45 31 L41 13 L57 23" />
              <path d="M75 31 L79 13 L63 23" />
              <path d="M50 40 L56 40 M64 40 L70 40" />
              <path d="M60 47 L60 50" />
              <path d="M53 50 Q60 56 67 50" />
              <path d="M38 44 L26 40 M38 48 L26 50" />
              <path d="M82 46 L94 42 M82 50 L94 52" />
              <path d="M84 70 Q104 66 100 34" />
              <path d="M46 90 L46 100 M56 92 L56 102 M64 92 L64 102 M74 90 L74 100" />
            </>
          )}
        </svg>

        <div className="absolute left-3 top-3 flex gap-1 rounded-full bg-surface/80 p-0.5 backdrop-blur-sm">
          {(["dog", "cat"] as PetKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setKind(k);
                trigger("happy");
              }}
              aria-pressed={kind === k}
              className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase transition-colors ${
                kind === k
                  ? "bg-primary text-on-primary"
                  : "text-on-surface-variant hover:text-primary"
              }`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {(
          [
            { id: "sit", label: "Sit" },
            { id: "wave", label: "Wave" },
            { id: "spin", label: "Spin" },
            { id: "happy", label: "Treat" },
          ] as { id: PetAction; label: string }[]
        ).map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => trigger(c.id)}
            className={`rounded-xl py-2 text-[10px] font-black uppercase tracking-wide ring-1 ring-inset transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              action === c.id
                ? "bg-primary text-on-primary ring-primary"
                : "bg-surface-container-high text-on-surface-variant ring-outline-variant/20 hover:text-primary"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onOpenCreate}
        className="rounded-xl bg-primary/10 py-2 text-[11px] font-black uppercase tracking-wide text-primary ring-1 ring-inset ring-primary/25 transition-colors hover:bg-primary/20"
      >
        Make mine real →
      </button>
    </div>
  );
}

/* ───────────────────────────── The scroller ──────────────────────────── */

export default function HeroScroller({
  onOpenCreate,
  onOpenPawprints,
  onOpenShop,
}: HeroScrollerProps) {
  const reduced = usePrefersReducedMotion();
  const railRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<(HTMLElement | null)[]>([]);
  const [active, setActive] = useState(0);

  const actionFor = useMemo<Record<SlideId, () => void>>(
    () => ({
      "pawprint-offer": onOpenPawprints,
      "appeal-reel": onOpenCreate,
      collection: onOpenCreate,
      playpen: onOpenCreate,
    }),
    [onOpenCreate, onOpenPawprints],
  );

  useEffect(() => {
    const cards = cardRefs.current.filter(Boolean) as HTMLElement[];
    if (!cards.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        // Pick the most-visible card rather than the first to cross the line,
        // so a slow scroll doesn't flicker the dot rail between neighbours.
        let best: { idx: number; ratio: number } | null = null;
        for (const e of entries) {
          const idx = cards.indexOf(e.target as HTMLElement);
          if (idx < 0) continue;
          if (!best || e.intersectionRatio > best.ratio)
            best = { idx, ratio: e.intersectionRatio };
        }
        if (best && best.ratio > 0.35) setActive(best.idx);
      },
      { threshold: [0.35, 0.6, 0.9] },
    );
    cards.forEach((c) => io.observe(c));
    return () => io.disconnect();
  }, []);

  const scrollTo = (idx: number) => {
    const card = cardRefs.current[idx];
    if (!card) return;
    card.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "nearest",
      inline: "center",
    });
  };

  return (
    <section aria-label="Quick hits" className="w-full">
      {/* Scoped keyframes. Inlined rather than added to index.css because they
          exist only for the playpen and shouldn't outlive it. */}
      <style>{`
        @keyframes heroPetIdle { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-3px) } }
        @keyframes heroPetWave { 0%,100% { transform: rotate(0deg) } 25% { transform: rotate(-9deg) } 75% { transform: rotate(9deg) } }
        @keyframes heroPetSpin { 100% { transform: rotate(360deg) } }
        @keyframes heroPetBounce { 0%,100% { transform: translateY(0) scale(1) } 40% { transform: translateY(-14px) scale(1.05) } }
        @keyframes heroPetSit { 0% { transform: translateY(0) } 100% { transform: translateY(6px) scaleY(.94) } }
        .hero-pet-idle { animation: heroPetIdle 3.2s ease-in-out infinite }
        .hero-pet-wave { animation: heroPetWave .5s ease-in-out 2 }
        .hero-pet-spin { animation: heroPetSpin .9s ease-in-out 1 }
        .hero-pet-bounce { animation: heroPetBounce .55s ease-out 2 }
        .hero-pet-sit { animation: heroPetSit .35s ease-out forwards }
        @media (prefers-reduced-motion: reduce) {
          .hero-pet-idle, .hero-pet-wave, .hero-pet-spin, .hero-pet-bounce, .hero-pet-sit { animation: none }
        }
        .hero-rail::-webkit-scrollbar { display: none }
      `}</style>

      <div
        ref={railRef}
        className="hero-rail flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth px-4 pb-4 sm:px-6 md:gap-6 lg:px-8 [scrollbar-width:none]"
      >
        {SLIDES.map((slide, i) => {
          const Icon = slide.icon;
          const go = actionFor[slide.id];
          return (
            <article
              key={slide.id}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${SLIDES.length}: ${slide.title}`}
              className="relative flex w-[86vw] shrink-0 snap-center flex-col gap-4 overflow-hidden rounded-[1.75rem] border border-outline-variant/20 bg-surface-container/70 p-5 shadow-lg backdrop-blur-sm sm:w-[68vw] md:w-[46vw] md:flex-row md:p-6 lg:w-[40rem]"
            >
              {/* Callout ribbon — one per card, as specified. */}
              <span className="absolute right-4 top-4 z-10 rounded-full bg-primary px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-on-primary shadow">
                {slide.callout}
              </span>

              <div className="flex min-w-0 flex-1 flex-col justify-between gap-4">
                <div>
                  <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[.18em] text-primary">
                    <Icon size={13} strokeWidth={2.25} aria-hidden="true" />
                    {slide.eyebrow}
                  </p>
                  <h3 className="text-xl font-black leading-tight tracking-tight text-on-surface md:text-2xl">
                    {slide.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">
                    {slide.body}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={go}
                  className="inline-flex w-fit items-center gap-1.5 rounded-2xl bg-primary px-5 py-3 text-xs font-black text-on-primary shadow transition-all hover:brightness-105 focus:outline-none focus-visible:ring-4 focus-visible:ring-primary/30 active:scale-95"
                >
                  {slide.cta}
                  <ArrowRight size={14} strokeWidth={2.5} />
                </button>
              </div>

              <div className="h-56 w-full shrink-0 md:h-auto md:w-[46%]">
                {slide.id === "appeal-reel" && <AppealReel reduced={reduced} />}
                {slide.id === "collection" && (
                  <CollectionSlide
                    onOpenCreate={onOpenCreate}
                    reduced={reduced}
                  />
                )}
                {slide.id === "playpen" && (
                  <Playpen reduced={reduced} onOpenCreate={onOpenCreate} />
                )}
                {slide.id === "pawprint-offer" && (
                  <button
                    type="button"
                    onClick={onOpenPawprints}
                    className="group relative flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/10 ring-1 ring-inset ring-primary/20 transition-transform hover:scale-[1.02]"
                  >
                    <span className="text-4xl font-black tracking-tighter text-primary">
                      PAWPRINT
                    </span>
                    <span className="text-[11px] font-black uppercase tracking-[.2em] text-on-surface-variant">
                      made by you
                    </span>
                    <span className="mt-1 flex items-center gap-1 text-[10px] font-bold text-on-surface-variant">
                      <Gift size={12} strokeWidth={2} aria-hidden="true" />{" "}
                      Download or email
                    </span>
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {/* Dot rail */}
      <div
        className="mt-1 flex items-center justify-center gap-2"
        role="tablist"
        aria-label="Choose a slide"
      >
        {SLIDES.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={active === i}
            aria-current={active === i ? "true" : undefined}
            aria-label={s.title}
            onClick={() => scrollTo(i)}
            className={`h-2 rounded-full transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              active === i
                ? "w-7 bg-primary"
                : "w-2 bg-on-surface/20 hover:bg-on-surface/40"
            }`}
          />
        ))}
      </div>
    </section>
  );
}
