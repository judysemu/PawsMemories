import React from "react";
import { ArrowRight, MapPin, Building2, CheckCircle2, ShieldCheck, Heart, Sparkles, Compass } from "lucide-react";

interface DenverPageProps {
  onOpenCreate: () => void;
  onOpenPricing: () => void;
}

export default function DenverPage({ onOpenCreate, onOpenPricing }: DenverPageProps) {
  return (
    <div className="w-full min-h-screen pb-24 text-on-surface">
      {/* ─────────────── HERO SECTION ─────────────── */}
      <section className="relative overflow-hidden px-4 pt-10 sm:px-6 md:pt-16">
        <div className="mx-auto max-w-6xl">
          <div className="glass-hero relative flex flex-col items-center gap-8 rounded-[2.5rem] p-8 md:flex-row md:gap-12 md:p-12">
            <div className="flex-1 text-center md:text-left">
              <div className="inline-flex items-center gap-2 rounded-full bg-amber-500/10 px-3.5 py-1 text-xs font-bold text-amber-500 mb-4">
                <MapPin size={14} />
                Denver &amp; Rocky Mountain Region
              </div>
              <h1 className="text-3xl font-black leading-tight tracking-tight sm:text-4xl lg:text-5xl">
                Affordable <span className="text-primary">3D Pet Models</span> in Denver, Colorado
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-relaxed text-on-surface-variant md:text-base">
                Serving Denver pet owners, local veterinary clinics, groomers, and pet businesses. Get versatile GLB pet models designed for digital projects, local 3D printing, and personalized pet keepsakes.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center md:justify-start">
                <button
                  type="button"
                  onClick={onOpenCreate}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg transition-all hover:bg-primary/90 active:scale-95"
                >
                  Order Denver Pet 3D Model
                  <ArrowRight size={16} />
                </button>
                <button
                  type="button"
                  onClick={onOpenPricing}
                  className="glass-button flex items-center justify-center gap-2 rounded-2xl px-7 py-4 text-sm font-bold text-on-surface hover:text-primary"
                >
                  View Pricing &amp; Local Options
                </button>
              </div>
            </div>
            <div className="relative shrink-0">
              <img
                src="/featured-models/tuck.webp"
                alt="Denver 3D Pet Models"
                className="h-56 w-56 rounded-3xl object-cover shadow-2xl ring-4 ring-primary/20 sm:h-64 sm:w-64 md:h-80 md:w-80"
              />
              <div className="absolute -bottom-4 -left-4 rounded-2xl bg-surface-container-highest/90 p-4 shadow-xl backdrop-blur-md border border-white/20">
                <p className="text-xs font-black text-primary">Mile High Pet 3D Models</p>
                <p className="text-[11px] text-on-surface-variant">Denver, CO Local Visibility &amp; Support</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── DENVER COMMUNITY & PARTNERSHIPS ─────────────── */}
      <section className="mt-16 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="text-center mb-12">
            <h2 className="text-xs font-black uppercase tracking-widest text-primary">Local Partnerships &amp; Ecosystem</h2>
            <p className="text-2xl font-black text-on-surface mt-2">Connecting Denver's Pet Community with 3D Tech</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="glass-card p-6 rounded-2xl">
              <Building2 className="text-primary mb-4" size={32} />
              <h3 className="text-lg font-black text-on-surface">Local Denver Clinics &amp; Vets</h3>
              <p className="mt-2 text-xs text-on-surface-variant leading-relaxed">
                Partnering with veterinary practices across Capitol Hill, LoDo, and Cherry Creek to offer client memorial keepsakes and 3D anatomical pet displays.
              </p>
            </div>
            <div className="glass-card p-6 rounded-2xl">
              <Compass className="text-primary mb-4" size={32} />
              <h3 className="text-lg font-black text-on-surface">Denver Maker Labs &amp; 3D Printing</h3>
              <p className="mt-2 text-xs text-on-surface-variant leading-relaxed">
                Our GLB files are optimized for printing at local Denver makerspaces (RiNo Arts District &amp; Baker Maker Labs) or full-color commercial 3D print hubs.
              </p>
            </div>
            <div className="glass-card p-6 rounded-2xl">
              <Heart className="text-primary mb-4" size={32} />
              <h3 className="text-lg font-black text-on-surface">Colorado Outdoor Pet Stories</h3>
              <p className="mt-2 text-xs text-on-surface-variant leading-relaxed">
                Capture your mountain companion's favorite memory—from hiking Red Rocks to playing in Washington Park—in a lasting 3D digital model.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── DENVER CUSTOMER EXAMPLES ─────────────── */}
      <section className="mt-20 px-4 sm:px-6">
        <div className="mx-auto max-w-5xl glass-card p-8 rounded-3xl">
          <h2 className="text-xl font-black text-on-surface mb-6 text-center">Denver Customer &amp; Business Highlights</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-4 rounded-xl bg-surface-container-low border border-white/10">
              <span className="text-xs font-bold text-primary">Mile High Dog Grooming (Highlands)</span>
              <p className="text-xs text-on-surface-variant mt-2">
                "We use Pawsome3D's GLB models on our web booking portal so Denver clients can select their desired haircut style on a 3D dog model before their visit!"
              </p>
            </div>
            <div className="p-4 rounded-xl bg-surface-container-low border border-white/10">
              <span className="text-xs font-bold text-primary">Denver Pet Parent (Wash Park)</span>
              <p className="text-xs text-on-surface-variant mt-2">
                "Created a 3D GLB model of our Golden Retriever, Cooper, after our trip to Mount Blue Sky. The detail and texture quality are phenomenal."
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── CTA ─────────────── */}
      <section className="mt-20 px-4 sm:px-6">
        <div className="mx-auto max-w-4xl text-center glass-card p-10 rounded-3xl">
          <h2 className="text-2xl font-black text-on-surface">Ready to Create a 3D Pet Model in Denver?</h2>
          <p className="mt-3 text-sm text-on-surface-variant max-w-xl mx-auto">
            Upload your pet's photo for instant digital GLB file generation or connect with our Denver area partners.
          </p>
          <button
            type="button"
            onClick={onOpenCreate}
            className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg hover:bg-primary/90 transition-all active:scale-95"
          >
            Create Denver Pet Model <ArrowRight size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}
