import React from "react";
import { ArrowRight, Building2, ShieldCheck, Briefcase, CheckCircle2, Award, Zap, Layers, BarChart3, Globe } from "lucide-react";

interface PetProfessionalsPageProps {
  onOpenCreate: () => void;
  onOpenPricing: () => void;
}

export default function PetProfessionalsPage({ onOpenCreate, onOpenPricing }: PetProfessionalsPageProps) {
  return (
    <div className="w-full min-h-screen pb-24 text-on-surface">
      {/* ─────────────── HERO SECTION ─────────────── */}
      <section className="relative overflow-hidden px-4 pt-10 sm:px-6 md:pt-16">
        <div className="mx-auto max-w-6xl">
          <div className="glass-hero relative flex flex-col items-center gap-8 rounded-[2.5rem] p-8 md:flex-row md:gap-12 md:p-12">
            <div className="flex-1 text-center md:text-left">
              <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3.5 py-1 text-xs font-bold text-primary mb-4">
                <Building2 size={14} />
                B2B &amp; Commercial 3D Solutions
              </div>
              <h1 className="text-3xl font-black leading-tight tracking-tight sm:text-4xl lg:text-5xl">
                Commercial <span className="text-primary">3D Pet Models</span> for Businesses &amp; Brands
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-relaxed text-on-surface-variant md:text-base">
                Elevate your pet brand, veterinary clinic, grooming salon, or e-commerce store with high-fidelity, web-optimized GLB pet models. Standardized, affordable, and licensed for commercial use.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center md:justify-start">
                <button
                  type="button"
                  onClick={onOpenCreate}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg transition-all hover:bg-primary/90 active:scale-95"
                >
                  Request Business Models
                  <ArrowRight size={16} />
                </button>
                <button
                  type="button"
                  onClick={onOpenPricing}
                  className="glass-button flex items-center justify-center gap-2 rounded-2xl px-7 py-4 text-sm font-bold text-on-surface hover:text-primary"
                >
                  Commercial Licensing Terms
                </button>
              </div>
            </div>
            <div className="relative shrink-0">
              <img
                src="/featured-models/boston-terrier.webp"
                alt="3D Pet Models for Businesses"
                className="h-56 w-56 rounded-3xl object-cover shadow-2xl ring-4 ring-primary/20 sm:h-64 sm:w-64 md:h-80 md:w-80"
              />
              <div className="absolute -bottom-4 -left-4 rounded-2xl bg-surface-container-highest/90 p-4 shadow-xl backdrop-blur-md border border-white/20">
                <p className="text-xs font-black text-primary">Pet Product 3D Models</p>
                <p className="text-[11px] text-on-surface-variant">Ready for WebGL, AR &amp; 3D Renders</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── AI ANSWER / SUMMARY BOX ─────────────── */}
      <section className="mt-12 px-4 sm:px-6">
        <div className="mx-auto max-w-4xl rounded-2xl bg-primary/5 p-6 border border-primary/20">
          <h2 className="text-xs font-black uppercase tracking-wider text-primary mb-2">
            Executive Summary: How pet businesses use 3D animal models
          </h2>
          <p className="text-sm leading-relaxed text-on-surface">
            <strong>3D pet models for businesses</strong> allow veterinarians, pet product brands, groomers, and pet insurance providers to showcase products in interactive 3D, enable AR product try-ons, and render marketing imagery at a fraction of traditional photography costs. Pawsome3D delivers commercial-use GLB files optimized for web performance across desktop and mobile browsers.
          </p>
        </div>
      </section>

      {/* ─────────────── INDUSTRY USE CASES ─────────────── */}
      <section className="mt-16 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="text-center mb-12">
            <h2 className="text-xs font-black uppercase tracking-widest text-primary">Industry Applications</h2>
            <p className="text-2xl font-black text-on-surface mt-2">Tailored for Every Pet Industry Professional</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="glass-card p-6 rounded-2xl">
              <Briefcase className="text-primary mb-4" size={32} />
              <h3 className="text-lg font-black text-on-surface">Pet Product Brands &amp; E-Commerce</h3>
              <p className="mt-2 text-xs text-on-surface-variant leading-relaxed">
                Display collars, harnesses, apparel, and toys on interactive 3D dog and cat models. Boost conversion rates by 40% with WebGL 360-degree product viewers.
              </p>
            </div>
            <div className="glass-card p-6 rounded-2xl">
              <Award className="text-primary mb-4" size={32} />
              <h3 className="text-lg font-black text-on-surface">Veterinarians &amp; Animal Health</h3>
              <p className="mt-2 text-xs text-on-surface-variant leading-relaxed">
                Use anatomical and breed-accurate 3D models for client education, procedure explanations, and digital clinic marketing materials.
              </p>
            </div>
            <div className="glass-card p-6 rounded-2xl">
              <Globe className="text-primary mb-4" size={32} />
              <h3 className="text-lg font-black text-on-surface">Grooming Salons &amp; Mobile Pet Spa</h3>
              <p className="mt-2 text-xs text-on-surface-variant leading-relaxed">
                Showcase coat styles, cut variations, and breed grooming standards in 3D to set clear expectations for pet parents.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── WHY PAWSOME3D FOR BUSINESS ─────────────── */}
      <section className="mt-20 px-4 sm:px-6">
        <div className="mx-auto max-w-5xl glass-card p-8 rounded-3xl">
          <h2 className="text-xl font-black text-on-surface mb-6 text-center">Why Leading Pet Brands Choose Pawsome3D</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div className="flex gap-3 items-start">
              <CheckCircle2 className="text-primary shrink-0 mt-1" size={20} />
              <div>
                <h4 className="text-sm font-bold text-on-surface">Standardized Binary GLB</h4>
                <p className="text-xs text-on-surface-variant mt-1">Lightweight glTF 2.0 binary files that load instantaneously across all modern web browsers.</p>
              </div>
            </div>
            <div className="flex gap-3 items-start">
              <CheckCircle2 className="text-primary shrink-0 mt-1" size={20} />
              <div>
                <h4 className="text-sm font-bold text-on-surface">Full Commercial License</h4>
                <p className="text-xs text-on-surface-variant mt-1">Royalty-free commercial use rights for advertising, digital products, apps, and video production.</p>
              </div>
            </div>
            <div className="flex gap-3 items-start">
              <CheckCircle2 className="text-primary shrink-0 mt-1" size={20} />
              <div>
                <h4 className="text-sm font-bold text-on-surface">Custom Photo-to-3D Pipeline</h4>
                <p className="text-xs text-on-surface-variant mt-1">Need a specific mascot or brand pet in 3D? Upload photos and receive a production GLB in 48 hours.</p>
              </div>
            </div>
            <div className="flex gap-3 items-start">
              <CheckCircle2 className="text-primary shrink-0 mt-1" size={20} />
              <div>
                <h4 className="text-sm font-bold text-on-surface">AR &amp; WebGL Integration</h4>
                <p className="text-xs text-on-surface-variant mt-1">Plug-and-play code snippets for Three.js, React Three Fiber, Shopify, WooCommerce, and mobile apps.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── CTA ─────────────── */}
      <section className="mt-20 px-4 sm:px-6">
        <div className="mx-auto max-w-4xl text-center glass-card p-10 rounded-3xl">
          <h2 className="text-2xl font-black text-on-surface">Partner with Pawsome3D for Your Business</h2>
          <p className="mt-3 text-sm text-on-surface-variant max-w-xl mx-auto">
            Get instant access to our commercial 3D pet model catalog or request custom pet 3D models for your brand.
          </p>
          <button
            type="button"
            onClick={onOpenCreate}
            className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg hover:bg-primary/90 transition-all active:scale-95"
          >
            Get Business 3D Models <ArrowRight size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}
