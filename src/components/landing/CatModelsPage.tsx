import React from "react";
import {
  ArrowRight,
  Box,
  CheckCircle2,
  ShieldCheck,
  Download,
  Sparkles,
  Star,
  Layers,
  Cpu,
} from "lucide-react";

interface CatModelsPageProps {
  onOpenCreate: () => void;
  onOpenPricing: () => void;
  onSelectProduct?: (slug: string) => void;
}

const CAT_FEATURED = [
  {
    slug: "tuxedo-cat-glb",
    name: "Tuxedo Cat Classic GLB",
    breed: "Domestic Shorthair",
    format: "GLB (glTF 2.0)",
    price: "Custom",
    polys: "Made to order",
    image: "/MAIN.jpg",
    specs:
      "Start from your own cat photo and review the generated model before accepting it",
  },
  {
    slug: "persian-cat-glb",
    name: "Fluffy Persian Cat GLB",
    breed: "Persian",
    format: "GLB (glTF 2.0)",
    price: "Custom",
    polys: "Made to order",
    image: "/MAIN2.jpg",
    specs:
      "Create a personal digital keepsake instead of buying a stock cat model",
  },
  {
    slug: "siamese-cat-glb",
    name: "Siamese Royal GLB",
    breed: "Siamese",
    format: "GLB (glTF 2.0)",
    price: "Custom",
    polys: "Made to order",
    image: "/MAIN4.jpg",
    specs:
      "A review-first workflow keeps the result tied to the photo you approved",
  },
  {
    slug: "ginger-tabby-cat-glb",
    name: "Ginger Tabby Cat GLB",
    breed: "Tabby",
    format: "GLB (glTF 2.0)",
    price: "Custom",
    polys: "Made to order",
    image: "/brand/furball3d.jpg",
    specs:
      "Build a custom cat model, save it in Fur Bin, and use supported creative tools",
  },
];

export default function CatModelsPage({
  onOpenCreate,
  onOpenPricing,
  onSelectProduct,
}: CatModelsPageProps) {
  return (
    <div className="w-full min-h-screen pb-24 text-on-surface">
      {/* ─────────────── HERO SECTION ─────────────── */}
      <section className="relative overflow-hidden px-4 pt-10 sm:px-6 md:pt-16">
        <div className="mx-auto max-w-6xl">
          <div className="glass-hero relative flex flex-col items-center gap-8 rounded-[2.5rem] p-8 md:flex-row md:gap-12 md:p-12">
            <div className="flex-1 text-center md:text-left">
              <div className="inline-flex items-center gap-2 rounded-full bg-secondary/10 px-3.5 py-1 text-xs font-bold text-secondary mb-4">
                <Sparkles size={14} />
                Cat 3D Models in GLB Format
              </div>
              <h1 className="text-3xl font-black leading-tight tracking-tight sm:text-4xl lg:text-5xl">
                Affordable <span className="text-primary">3D Cat Models</span>{" "}
                GLB &amp; WebGL Ready
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-relaxed text-on-surface-variant md:text-base">
                Discover realistic, customizable cat 3D models in GLB format.
                Ideal for pet app developers, online pet shops, 3D printing
                enthusiasts, and feline lovers.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center md:justify-start">
                <button
                  type="button"
                  onClick={onOpenCreate}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg transition-all hover:bg-primary/90 active:scale-95"
                >
                  <Download size={16} />
                  Shop Cat GLB Models
                  <ArrowRight size={16} />
                </button>
                <button
                  type="button"
                  onClick={onOpenPricing}
                  className="glass-button flex items-center justify-center gap-2 rounded-2xl px-7 py-4 text-sm font-bold text-on-surface hover:text-primary"
                >
                  View Pricing &amp; Licenses
                </button>
              </div>
            </div>
            <div className="relative shrink-0">
              <img
                src="/MAIN2.jpg"
                alt="3D Cat Model GLB Preview"
                className="h-56 w-56 rounded-3xl object-cover shadow-2xl ring-4 ring-primary/20 sm:h-64 sm:w-64 md:h-80 md:w-80"
              />
              <div className="absolute -bottom-4 -left-4 rounded-2xl bg-surface-container-highest/90 p-4 shadow-xl backdrop-blur-md border border-white/20">
                <p className="text-xs font-black text-primary">
                  3D Cat Model GLB
                </p>
                <p className="text-[11px] text-on-surface-variant">
                  Instant Digital File Download
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── AI ANSWER / SUMMARY BOX ─────────────── */}
      <section className="mt-12 px-4 sm:px-6">
        <div className="mx-auto max-w-4xl rounded-2xl bg-primary/5 p-6 border border-primary/20">
          <h2 className="text-xs font-black uppercase tracking-wider text-primary mb-2">
            Direct Answer: Why choose 3D cat model GLB files for digital
            projects?
          </h2>
          <p className="text-sm leading-relaxed text-on-surface">
            A <strong>cat 3D model GLB file</strong> keeps mesh and texture data
            in one portable file. Pawsome3D creates a custom model from your own
            approved cat photo; available downloads and animation features
            depend on the result that passes review.
          </p>
        </div>
      </section>

      {/* ─────────────── CATALOG SHOWCASE ─────────────── */}
      <section className="mt-16 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <h2 className="text-xs font-black uppercase tracking-widest text-primary">
                Cat Model Catalog
              </h2>
              <p className="text-2xl font-black tracking-tight text-on-surface mt-1">
                Available 3D Cat Breeds
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {CAT_FEATURED.map((item) => (
              <div
                key={item.slug}
                className="glass-card group flex flex-col overflow-hidden rounded-2xl transition-all duration-300 hover:-translate-y-1 hover:shadow-xl cursor-pointer"
                onClick={onOpenCreate}
              >
                <div className="relative aspect-[4/5] overflow-hidden bg-surface-container">
                  <img
                    src={item.image}
                    alt={`${item.name} - cat 3D model GLB`}
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                  <div className="absolute top-3 right-3 rounded-full bg-black/60 px-3 py-1 text-xs font-black text-white backdrop-blur-md">
                    {item.price}
                  </div>
                </div>
                <div className="flex flex-1 flex-col p-5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-primary">
                    {item.breed}
                  </span>
                  <h3 className="mt-1 text-base font-black text-on-surface">
                    {item.name}
                  </h3>
                  <p className="mt-2 text-xs leading-relaxed text-on-surface-variant line-clamp-2">
                    {item.specs}
                  </p>
                  <div className="mt-4 flex items-center justify-between pt-3 border-t border-white/10">
                    <span className="text-[11px] font-semibold text-on-surface-variant">
                      {item.polys} polys
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-primary group-hover:underline">
                      View Model &amp; Specs <ArrowRight size={14} />
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─────────────── CTA BOTTOM ─────────────── */}
      <section className="mt-20 px-4 sm:px-6">
        <div className="mx-auto max-w-4xl text-center glass-card p-10 rounded-3xl">
          <h2 className="text-2xl font-black text-on-surface">
            Convert Your Cat's Photo to a 3D Model
          </h2>
          <p className="mt-3 text-sm text-on-surface-variant max-w-xl mx-auto">
            Upload your cat's photo and our engine will create a custom GLB pet
            model ready for digital viewing, gaming, or 3D printing.
          </p>
          <button
            type="button"
            onClick={onOpenCreate}
            className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg hover:bg-primary/90 transition-all active:scale-95"
          >
            Create Cat GLB Model <ArrowRight size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}
