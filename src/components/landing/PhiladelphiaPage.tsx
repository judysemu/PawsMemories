import React from "react";
import { ArrowRight, MapPin, Building2, CheckCircle2, ShieldCheck, Heart, Sparkles, Award } from "lucide-react";

interface PhiladelphiaPageProps {
  onOpenCreate: () => void;
  onOpenPricing: () => void;
}

export default function PhiladelphiaPage({ onOpenCreate, onOpenPricing }: PhiladelphiaPageProps) {
  return (
    <div className="w-full min-h-screen pb-24 text-on-surface">
      {/* ─────────────── HERO SECTION ─────────────── */}
      <section className="relative overflow-hidden px-4 pt-10 sm:px-6 md:pt-16">
        <div className="mx-auto max-w-6xl">
          <div className="glass-hero relative flex flex-col items-center gap-8 rounded-[2.5rem] p-8 md:flex-row md:gap-12 md:p-12">
            <div className="flex-1 text-center md:text-left">
              <div className="inline-flex items-center gap-2 rounded-full bg-blue-500/10 px-3.5 py-1 text-xs font-bold text-blue-500 mb-4">
                <MapPin size={14} />
                Philadelphia &amp; Tri-State Region
              </div>
              <h1 className="text-3xl font-black leading-tight tracking-tight sm:text-4xl lg:text-5xl">
                Affordable <span className="text-primary">3D Pet Models</span> in Philadelphia, PA
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-relaxed text-on-surface-variant md:text-base">
                Serving Philadelphia pet owners, Tri-State veterinary clinics, groomers, and pet industry businesses. High quality GLB pet models with instant digital delivery across Pennsylvania and beyond.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center md:justify-start">
                <button
                  type="button"
                  onClick={onOpenCreate}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg transition-all hover:bg-primary/90 active:scale-95"
                >
                  Order Philly Pet 3D Model
                  <ArrowRight size={16} />
                </button>
                <button
                  type="button"
                  onClick={onOpenPricing}
                  className="glass-button flex items-center justify-center gap-2 rounded-2xl px-7 py-4 text-sm font-bold text-on-surface hover:text-primary"
                >
                  View Pricing &amp; Commercial Terms
                </button>
              </div>
            </div>
            <div className="relative shrink-0">
              <img
                src="/featured-models/shiba-inu.webp"
                alt="Philadelphia 3D Pet Models"
                className="h-56 w-56 rounded-3xl object-cover shadow-2xl ring-4 ring-primary/20 sm:h-64 sm:w-64 md:h-80 md:w-80"
              />
              <div className="absolute -bottom-4 -left-4 rounded-2xl bg-surface-container-highest/90 p-4 shadow-xl backdrop-blur-md border border-white/20">
                <p className="text-xs font-black text-primary">Philly Pet 3D Models</p>
                <p className="text-[11px] text-on-surface-variant">Greater Philadelphia &amp; NJ Coverage</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── PHILADELPHIA LOCAL PARTNERSHIPS & SERVICES ─────────────── */}
      <section className="mt-16 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="text-center mb-12">
            <h2 className="text-xs font-black uppercase tracking-widest text-primary">Philly Local Industry Connections</h2>
            <p className="text-2xl font-black text-on-surface mt-2">Serving Pet Owners &amp; Businesses across Greater Philly</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="glass-card p-6 rounded-2xl">
              <Building2 className="text-primary mb-4" size={32} />
              <h3 className="text-lg font-black text-on-surface">Philly Groomers &amp; Pet Spas</h3>
              <p className="mt-2 text-xs text-on-surface-variant leading-relaxed">
                Empowering grooming salons in Rittenhouse, Fishtown, and Manayunk with interactive 3D dog and cat model visualizers for customer styling.
              </p>
            </div>
            <div className="glass-card p-6 rounded-2xl">
              <Award className="text-primary mb-4" size={32} />
              <h3 className="text-lg font-black text-on-surface">Tri-State Vet &amp; Animal Hospitals</h3>
              <p className="mt-2 text-xs text-on-surface-variant leading-relaxed">
                Providing veterinary clinics throughout Philadelphia, South Jersey, and Delaware with 3D digital keepsakes and pet memorial models.
              </p>
            </div>
            <div className="glass-card p-6 rounded-2xl">
              <Heart className="text-primary mb-4" size={32} />
              <h3 className="text-lg font-black text-on-surface">Local 3D Tech &amp; Design Studios</h3>
              <p className="mt-2 text-xs text-on-surface-variant leading-relaxed">
                Collaborating with Philadelphia tech workshops and creative agencies to integrate GLB pet models into interactive web apps and AR installations.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── PHILADELPHIA CUSTOMER EXAMPLES ─────────────── */}
      <section className="mt-20 px-4 sm:px-6">
        <div className="mx-auto max-w-5xl glass-card p-8 rounded-3xl">
          <h2 className="text-xl font-black text-on-surface mb-6 text-center">Philadelphia Customer &amp; Business Highlights</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-4 rounded-xl bg-surface-container-low border border-white/10">
              <span className="text-xs font-bold text-primary">Fishtown Pet Boutique (Philadelphia)</span>
              <p className="text-xs text-on-surface-variant mt-2">
                "Pawsome3D provided us with custom GLB pet models for our online shop catalog. Our customers love seeing products rendered in 3D!"
              </p>
            </div>
            <div className="p-4 rounded-xl bg-surface-container-low border border-white/10">
              <span className="text-xs font-bold text-primary">Philly Pet Parent (Old City)</span>
              <p className="text-xs text-on-surface-variant mt-2">
                "Captured our Boston Terrier in a custom 3D model. The GLB file imported seamlessly into Blender and we printed a 5-inch full-color figurine!"
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── CTA ─────────────── */}
      <section className="mt-20 px-4 sm:px-6">
        <div className="mx-auto max-w-4xl text-center glass-card p-10 rounded-3xl">
          <h2 className="text-2xl font-black text-on-surface">Create Your Philadelphia Pet 3D Model</h2>
          <p className="mt-3 text-sm text-on-surface-variant max-w-xl mx-auto">
            Upload a photo of your pet to receive an affordable, versatile GLB 3D model with instant digital file delivery.
          </p>
          <button
            type="button"
            onClick={onOpenCreate}
            className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg hover:bg-primary/90 transition-all active:scale-95"
          >
            Create Philly Pet Model <ArrowRight size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}
