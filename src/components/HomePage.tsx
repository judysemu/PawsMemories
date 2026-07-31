import React from "react";
import { ArrowRight, Camera, Palette, ShieldCheck, Printer, Sparkles, Star, Heart, Gift, Dog, PawPrint } from "lucide-react";
import { UserProfile } from "../types";
import HeroScroller from "./HeroScroller";

interface HomePageProps {
  userProfile: UserProfile;
  onOpenCreate: () => void;
  onOpenShop: () => void;
  onOpenPawprints: () => void;
  onOpenFurball: () => void;
  onOpenFidos: () => void;
}

/* Featured showcase — local studio photography served from public/featured-models.
   Previously four hotlinked lh3.googleusercontent.com URLs, which put a
   third-party CDN on the critical path of the homepage above the fold.
   Sources are center-cropped to 4:5 and encoded as WebP (~14-32 KB each,
   down from ~4.6 MB of source PNG/JPEG). A matching .jpg sits alongside
   each .webp on disk as a fallback asset. */
const FEATURED_MODELS = [
  {
    name: "Chihuahua Classic",
    breed: "Chihuahua",
    style: "Realistic",
    size: '4" tall',
    price: "Example design",
    image: "/featured-models/chihuahua.webp",
  },
  {
    name: "Tuxedo Charmer",
    breed: "Boston Terrier",
    style: "Realistic",
    size: '5" tall',
    price: "Example design",
    image: "/featured-models/boston-terrier.webp",
  },
  {
    name: "Tuck",
    breed: "Labradoodle",
    style: "Realistic",
    size: '6" tall',
    price: "Example design",
    image: "/featured-models/tuck.webp",
  },
  {
    name: "Snow Shiba",
    breed: "Shiba Inu",
    style: "Realistic",
    size: '5" tall',
    price: "Example design",
    image: "/featured-models/shiba-inu.webp",
  },
];

const HOW_IT_WORKS = [
  { step: 1, title: "Upload", desc: "Share a photo of your pet and tell us a bit about them.", icon: Camera },
  { step: 2, title: "Customize", desc: "Choose pose, accessories, collar, and engraving options.", icon: Palette },
  { step: 3, title: "Validate", desc: "Our engine checks the model is printable and structurally sound.", icon: ShieldCheck },
  { step: 4, title: "Print", desc: "Pick your size, material, and finish — then we print and ship.", icon: Printer },
];

const STORIES = [
  { title: "Memorials", desc: "Honor a beloved companion with a lasting keepsake.", icon: Heart, color: "text-rose-500" },
  { title: "New Puppies", desc: "Capture the first year in a custom figurine.", icon: Dog, color: "text-amber-600" },
  { title: "Gifts", desc: "Surprise any pet parent with a one-of-a-kind present.", icon: Gift, color: "text-emerald-600" },
  { title: "Family Companions", desc: "Celebrate the pet that made your house a home.", icon: Star, color: "text-sky-500" },
];

export default function HomePage({
  userProfile,
  onOpenCreate,
  onOpenShop,
  onOpenPawprints,
}: HomePageProps) {
  const firstName = userProfile.fullName?.split(" ")[0] || "there";

  return (
    <div className="w-full min-h-[calc(100dvh-64px)] pb-28 md:pb-12">
      {/* ─────────────── HERO ─────────────── */}
      <section className="relative w-full overflow-hidden px-4 pt-8 sm:px-6 md:pt-14">
        <div className="mx-auto max-w-6xl">
          <div className="glass-hero relative flex flex-col items-center gap-8 rounded-[2rem] p-8 md:flex-row md:gap-12 md:p-12">
            {/* Ambient glows */}
            <div className="pointer-events-none absolute -left-20 -top-20 h-56 w-56 rounded-full bg-primary/15 blur-[80px]" />
            <div className="pointer-events-none absolute -bottom-16 -right-16 h-48 w-48 rounded-full bg-secondary/15 blur-[70px]" />

            {/* Text side */}
            <div className="relative z-10 flex-1 text-center md:text-left">
              <p className="mb-2 text-xs font-black uppercase tracking-[.2em] text-primary">
                Pawsome3D
              </p>
              <h1 className="text-3xl font-black leading-tight tracking-tight text-on-surface sm:text-4xl lg:text-5xl">
                Turn your favorite pet photo into a <span className="text-primary">keepsake you can keep forever</span>
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-relaxed text-on-surface-variant md:text-base">
                Pawsome3D turns a photo, memory, or idea into a personalized pet creation for your home, your phone, or a real-world keepsake. Technical downloads such as GLB are available when you need them.
              </p>

              {/* CTAs */}
              <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center md:justify-start">
                <button
                  id="hero-create-cta"
                  type="button"
                  onClick={onOpenCreate}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg transition-all hover:brightness-105 hover:bg-primary/90 focus:outline-none focus:ring-4 focus:ring-primary/30 active:scale-95 disabled:opacity-50"
                >
                  <Sparkles size={16} className="fill-on-primary" />
                  Make my pet
                  <ArrowRight size={16} />
                </button>
                <button
                  id="hero-shop-cta"
                  type="button"
                  onClick={onOpenShop}
                  className="glass-button flex items-center justify-center gap-2 rounded-2xl px-7 py-4 text-sm font-bold text-on-surface transition-all hover:text-primary"
                >
                  View Pricing
                  <ArrowRight size={14} />
                </button>
              </div>
            </div>

            {/* Hero image */}
            <div className="relative z-10 shrink-0">
              <div className="dog-float">
                <img
                  src="/brand/furball3d.jpg"
                  alt="Affordable 3D Pet Models in GLB Format"
                  className="h-48 w-48 rounded-3xl object-cover shadow-2xl ring-2 ring-white/40 sm:h-56 sm:w-56 md:h-72 md:w-72"
                />
              </div>
              <div className="absolute -bottom-3 -right-3 flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-[10px] font-black text-on-primary shadow-lg">
                <Printer size={12} />
                GLB &amp; Print-Ready
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── SUPPORTING HEADING & COPY SECTION ─────────────── */}
      <section className="mt-12 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl glass-card p-8 rounded-3xl text-center md:text-left flex flex-col md:flex-row items-center justify-between gap-6 border border-primary/20 bg-primary/5">
          <div className="flex-1">
            <h2 className="text-2xl font-black tracking-tight text-on-surface">
              Your pet, made wonderfully real
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-on-surface-variant max-w-2xl">
              Create a digital keepsake for yourself, your family, or someone who misses a beloved pet. Downloadable formats, including GLB, are available in the details when you need them.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenCreate}
            className="shrink-0 flex items-center gap-2 rounded-2xl bg-primary px-7 py-3.5 text-sm font-black text-on-primary shadow-md hover:bg-primary/90 transition-all active:scale-95"
          >
            Start creating
            <ArrowRight size={16} />
          </button>
        </div>
      </section>

      {/* ─────────────── QUICK HITS ───────────────
          Four scroll-snapped cards sitting directly under the hero, each with
          its own callout. Placed above Featured Models because these are the
          offers we want read first; Featured Models is browsing, not an offer. */}
      <section className="mt-8 md:mt-10">
        <div className="mx-auto mb-3 max-w-6xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-xs font-black uppercase tracking-[.18em] text-primary">Quick hits</h2>
        </div>
        <HeroScroller
          onOpenCreate={onOpenCreate}
          onOpenPawprints={onOpenPawprints}
          onOpenShop={onOpenShop}
        />
      </section>

      {/* ─────────────── FEATURED MODELS ─────────────── */}
      <section className="mt-14 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-6 flex items-center gap-2">
            <Star size={18} className="text-primary" />
            <h2 className="text-xs font-black uppercase tracking-[.18em] text-primary">Featured Models</h2>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURED_MODELS.map((model) => (
              <article
                key={model.name}
                className="glass-showcase group cursor-pointer overflow-hidden rounded-[1.6rem]"
                onClick={onOpenCreate}
              >
                <div className="relative aspect-[4/5] overflow-hidden">
                  <img
                    src={model.image}
                    alt={`${model.name} — ${model.breed} 3D model`}
                    width={800}
                    height={1000}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-4 pt-12">
                    <h3 className="text-sm font-black text-white">{model.name}</h3>
                    <p className="mt-0.5 text-[11px] text-white/80">{model.breed} · {model.style}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between p-4">
                  <div>
                    <span className="text-[10px] font-bold text-on-surface-variant">{model.size}</span>
                    <span className="ml-2 text-xs font-bold text-primary">{model.price}</span>
                  </div>
                  <span className="flex items-center gap-1 text-xs font-bold text-primary opacity-0 transition-opacity group-hover:opacity-100">
                    Customize <ArrowRight size={12} />
                  </span>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ─────────────── HOW IT WORKS ─────────────── */}
      <section className="mt-16 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-8 text-center">
            <h2 className="text-xs font-black uppercase tracking-[.18em] text-primary">How It Works</h2>
            <p className="mt-2 text-2xl font-black tracking-tight text-on-surface md:text-3xl">
              From photo to physical keepsake
            </p>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {HOW_IT_WORKS.map(({ step, title, desc, icon: Icon }) => (
              <div key={step} className="glass-card group relative rounded-2xl p-6 text-center">
                {/* Step number */}
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-on-primary text-lg font-black shadow-md">
                  {step}
                </div>
                <Icon size={28} className="mx-auto mb-3 text-primary transition-transform group-hover:scale-110" />
                <h3 className="text-base font-black text-on-surface">{title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-on-surface-variant">{desc}</p>
                {/* Connector arrow (hidden on last & mobile) */}
                {step < 4 && (
                  <div className="pointer-events-none absolute -right-3 top-1/2 hidden -translate-y-1/2 text-primary/30 lg:block">
                    <ArrowRight size={20} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─────────────── PERSONAL STORIES ─────────────── */}
      <section className="mt-16 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-6 text-center">
            <h2 className="text-xs font-black uppercase tracking-[.18em] text-primary">Personal Stories</h2>
            <p className="mt-2 text-xl font-black tracking-tight text-on-surface md:text-2xl">
              Every pet deserves to be remembered
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {STORIES.map(({ title, desc, icon: Icon, color }) => (
              <div key={title} className="glass-tile rounded-2xl p-5 text-center">
                <Icon size={28} className={`mx-auto mb-3 ${color}`} />
                <h3 className="text-sm font-black text-on-surface">{title}</h3>
                <p className="mt-1.5 text-[11px] leading-relaxed text-on-surface-variant">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─────────────── PAWPRINTS ─────────────── */}
      <section className="mt-16 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="glass-card flex flex-col items-center gap-6 rounded-[2rem] p-8 md:flex-row md:p-10">
            <img
              src="/brand/pawprints.png"
              alt="Pawprints keepsakes"
              className="h-32 w-32 shrink-0 rounded-2xl object-cover shadow-lg ring-1 ring-white/40 md:h-40 md:w-40"
            />
            <div className="flex-1 text-center md:text-left">
              <span className="text-[10px] font-black uppercase tracking-[.18em] text-primary">Pawprints</span>
              <h2 className="mt-1 text-xl font-black tracking-tight text-on-surface md:text-2xl">
                Digital keepsakes, cards, and personalized artwork
              </h2>
              <p className="mt-2 max-w-md text-sm text-on-surface-variant">
                Create beautiful Pawprints with your favorite photos and heartfelt words for any occasion — birthdays, memorials, holidays, and more.
              </p>
              <button
                type="button"
                onClick={onOpenPawprints}
                className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-black text-on-primary shadow-md transition-all hover:brightness-105 active:scale-95"
              >
                <PawPrint size={16} />
                Create a Pawprint
                <ArrowRight size={14} />
              </button>
            </div>
          </div>
        </div>
      </section>

    </div>
  );
}
