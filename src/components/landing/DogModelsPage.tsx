import React from "react";
import { ArrowRight, Box, CheckCircle2, ShieldCheck, Download, Sparkles, Star, Layers, Cpu, Compass } from "lucide-react";

interface DogModelsPageProps {
  onOpenCreate: () => void;
  onOpenPricing: () => void;
  onSelectProduct?: (slug: string) => void;
}

const DOG_FEATURED = [
  {
    slug: "shiba-inu-glb",
    name: "Shiba Inu Classic GLB",
    breed: "Shiba Inu",
    format: "GLB (glTF 2.0)",
    price: "$19",
    polys: "14,200",
    image: "/featured-models/shiba-inu.webp",
    specs: "4K PBR textures, Rigged skeleton, 5 animations included"
  },
  {
    slug: "chihuahua-classic-glb",
    name: "Chihuahua Classic GLB",
    breed: "Chihuahua",
    format: "GLB (glTF 2.0)",
    price: "$19",
    polys: "12,800",
    image: "/featured-models/chihuahua.webp",
    specs: "4K PBR textures, WebGL optimized, Mobile AR Ready"
  },
  {
    slug: "tuxedo-boston-terrier-glb",
    name: "Tuxedo Boston Terrier GLB",
    breed: "Boston Terrier",
    format: "GLB (glTF 2.0)",
    price: "$24",
    polys: "16,500",
    image: "/featured-models/boston-terrier.webp",
    specs: "High-detail mesh, PBR textures, Quad topology"
  },
  {
    slug: "labradoodle-tuck-glb",
    name: "Labradoodle Tuck GLB",
    breed: "Labradoodle",
    format: "GLB (glTF 2.0)",
    price: "$29",
    polys: "18,900",
    image: "/featured-models/tuck.webp",
    specs: "Realistic fur PBR shader, Rigged skeleton, AR QuickLook"
  }
];

export default function DogModelsPage({ onOpenCreate, onOpenPricing, onSelectProduct }: DogModelsPageProps) {
  return (
    <div className="w-full min-h-screen pb-24 text-on-surface">
      {/* ─────────────── HERO SECTION ─────────────── */}
      <section className="relative overflow-hidden px-4 pt-10 sm:px-6 md:pt-16">
        <div className="mx-auto max-w-6xl">
          <div className="glass-hero relative flex flex-col items-center gap-8 rounded-[2.5rem] p-8 md:flex-row md:gap-12 md:p-12">
            <div className="flex-1 text-center md:text-left">
              <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3.5 py-1 text-xs font-bold text-primary mb-4">
                <Sparkles size={14} />
                Dog 3D Models in GLB Format
              </div>
              <h1 className="text-3xl font-black leading-tight tracking-tight sm:text-4xl lg:text-5xl">
                Affordable <span className="text-primary">3D Dog Models</span> in Versatile GLB Format
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-relaxed text-on-surface-variant md:text-base">
                Explore our catalog of high-quality, game-ready, and web-ready dog 3D model GLB files. Built for pet businesses, creators, game developers, and dog lovers nationwide.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center md:justify-start">
                <button
                  type="button"
                  onClick={onOpenCreate}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg transition-all hover:bg-primary/90 active:scale-95"
                >
                  <Download size={16} />
                  Browse &amp; Buy Dog GLB Models
                  <ArrowRight size={16} />
                </button>
                <button
                  type="button"
                  onClick={onOpenPricing}
                  className="glass-button flex items-center justify-center gap-2 rounded-2xl px-7 py-4 text-sm font-bold text-on-surface hover:text-primary"
                >
                  Commercial Licensing
                </button>
              </div>
            </div>
            <div className="relative shrink-0">
              <img
                src="/featured-models/shiba-inu.webp"
                alt="3D Dog Model GLB Preview"
                className="h-56 w-56 rounded-3xl object-cover shadow-2xl ring-4 ring-primary/20 sm:h-64 sm:w-64 md:h-80 md:w-80"
              />
              <div className="absolute -bottom-4 -left-4 rounded-2xl bg-surface-container-highest/90 p-4 shadow-xl backdrop-blur-md border border-white/20">
                <p className="text-xs font-black text-primary">GLB (glTF 2.0) Format</p>
                <p className="text-[11px] text-on-surface-variant">Includes 4K PBR Textures &amp; Skeleton</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── AI ANSWER / SUMMARY BOX ─────────────── */}
      <section className="mt-12 px-4 sm:px-6">
        <div className="mx-auto max-w-4xl rounded-2xl bg-primary/5 p-6 border border-primary/20">
          <h2 className="text-xs font-black uppercase tracking-wider text-primary mb-2">
            Key Information: What makes a 3D dog model GLB format ideal?
          </h2>
          <p className="text-sm leading-relaxed text-on-surface">
            A <strong>dog 3D model GLB file</strong> is a compact binary glTF format that packages 3D geometry, PBR materials, textures, and animation clips into a single portable file. Pawsome3D provides affordable 3D dog models compatible with WebGL, Three.js, Blender, Unity, Unreal Engine, and mobile Augmented Reality (iOS AR QuickLook &amp; Android Scene Viewer).
          </p>
        </div>
      </section>

      {/* ─────────────── CATALOG SHOWCASE ─────────────── */}
      <section className="mt-16 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <h2 className="text-xs font-black uppercase tracking-widest text-primary">Dog Model Catalog</h2>
              <p className="text-2xl font-black tracking-tight text-on-surface mt-1">Featured 3D Dog Models</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {DOG_FEATURED.map((item) => (
              <div
                key={item.slug}
                className="glass-card group flex flex-col overflow-hidden rounded-2xl transition-all duration-300 hover:-translate-y-1 hover:shadow-xl cursor-pointer"
                onClick={() => onSelectProduct ? onSelectProduct(item.slug) : onOpenCreate()}
              >
                <div className="relative aspect-[4/5] overflow-hidden bg-surface-container">
                  <img
                    src={item.image}
                    alt={`${item.name} - 3D dog model GLB`}
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                  <div className="absolute top-3 right-3 rounded-full bg-black/60 px-3 py-1 text-xs font-black text-white backdrop-blur-md">
                    {item.price}
                  </div>
                </div>
                <div className="flex flex-1 flex-col p-5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-primary">{item.breed}</span>
                  <h3 className="mt-1 text-base font-black text-on-surface">{item.name}</h3>
                  <p className="mt-2 text-xs leading-relaxed text-on-surface-variant line-clamp-2">{item.specs}</p>
                  <div className="mt-4 flex items-center justify-between pt-3 border-t border-white/10">
                    <span className="text-[11px] font-semibold text-on-surface-variant">{item.polys} polys</span>
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-primary group-hover:underline">
                      View Details &amp; GLB <ArrowRight size={14} />
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─────────────── TECHNICAL SPECS & FEATURES ─────────────── */}
      <section className="mt-20 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="text-center mb-12">
            <h2 className="text-xs font-black uppercase tracking-widest text-primary">Technical Excellence</h2>
            <p className="text-2xl font-black text-on-surface mt-2">Built for Performance &amp; Compatibility</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="glass-card p-6 rounded-2xl">
              <Box className="text-primary mb-4" size={32} />
              <h3 className="text-lg font-black text-on-surface">Binary GLB Format</h3>
              <p className="mt-2 text-xs text-on-surface-variant leading-relaxed">
                Self-contained single binary file containing mesh, PBR textures, and skeleton animation data. Zero missing texture links.
              </p>
            </div>
            <div className="glass-card p-6 rounded-2xl">
              <Cpu className="text-primary mb-4" size={32} />
              <h3 className="text-lg font-black text-on-surface">Game &amp; Web Optimized</h3>
              <p className="mt-2 text-xs text-on-surface-variant leading-relaxed">
                Clean quad/tri topology under 20,000 polygons per model. Fast loading in Three.js, Babylon.js, Unity, and WebGL.
              </p>
            </div>
            <div className="glass-card p-6 rounded-2xl">
              <ShieldCheck className="text-primary mb-4" size={32} />
              <h3 className="text-lg font-black text-on-surface">Commercial License Ready</h3>
              <p className="mt-2 text-xs text-on-surface-variant leading-relaxed">
                Clear licensing terms for pet product brands, veterinary marketing, pet mobile apps, and e-commerce 3D viewers.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── CTA BOTTOM ─────────────── */}
      <section className="mt-20 px-4 sm:px-6">
        <div className="mx-auto max-w-4xl text-center glass-card p-10 rounded-3xl">
          <h2 className="text-2xl font-black text-on-surface">Need a Custom Dog Breed or Specific Pose?</h2>
          <p className="mt-3 text-sm text-on-surface-variant max-w-xl mx-auto">
            Pawsome3D generates custom 3D dog models from single pet photos. Upload your dog photo today to get a personalized GLB model.
          </p>
          <button
            type="button"
            onClick={onOpenCreate}
            className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg hover:bg-primary/90 transition-all active:scale-95"
          >
            Create Custom Dog GLB Model <ArrowRight size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}
