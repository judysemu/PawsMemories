import React from "react";
import { ArrowRight, BookOpen, FileCode, CheckCircle2, HelpCircle, Layers, Cpu, Compass, Sparkles } from "lucide-react";

interface GlbGuidePageProps {
  onOpenCreate: () => void;
  onOpenPricing: () => void;
}

export default function GlbGuidePage({ onOpenCreate, onOpenPricing }: GlbGuidePageProps) {
  return (
    <div className="w-full min-h-screen pb-24 text-on-surface">
      {/* ─────────────── HERO SECTION ─────────────── */}
      <section className="relative overflow-hidden px-4 pt-10 sm:px-6 md:pt-16">
        <div className="mx-auto max-w-6xl">
          <div className="glass-hero relative flex flex-col items-center gap-8 rounded-[2.5rem] p-8 md:flex-row md:gap-12 md:p-12">
            <div className="flex-1 text-center md:text-left">
              <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3.5 py-1 text-xs font-bold text-primary mb-4">
                <BookOpen size={14} />
                GLB Technical Guide &amp; FAQ
              </div>
              <h1 className="text-3xl font-black leading-tight tracking-tight sm:text-4xl lg:text-5xl">
                What is a <span className="text-primary">GLB Pet Model</span>? Complete Guide
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-relaxed text-on-surface-variant md:text-base">
                Everything you need to know about pet GLB files: what GLB format is, how it compares to OBJ and FBX, how to open GLB models in Blender, and how to display pet 3D models in WebGL and mobile AR.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center md:justify-start">
                <button
                  type="button"
                  onClick={onOpenCreate}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg transition-all hover:bg-primary/90 active:scale-95"
                >
                  Download Sample GLB Model
                  <ArrowRight size={16} />
                </button>
                <button
                  type="button"
                  onClick={onOpenPricing}
                  className="glass-button flex items-center justify-center gap-2 rounded-2xl px-7 py-4 text-sm font-bold text-on-surface hover:text-primary"
                >
                  Browse Model Prices
                </button>
              </div>
            </div>
            <div className="relative shrink-0">
              <img
                src="/featured-models/tuck.webp"
                alt="GLB Pet Model File Format"
                className="h-56 w-56 rounded-3xl object-cover shadow-2xl ring-4 ring-primary/20 sm:h-64 sm:w-64 md:h-80 md:w-80"
              />
              <div className="absolute -bottom-4 -left-4 rounded-2xl bg-surface-container-highest/90 p-4 shadow-xl backdrop-blur-md border border-white/20">
                <p className="text-xs font-black text-primary">glTF 2.0 Binary (.GLB)</p>
                <p className="text-[11px] text-on-surface-variant">Embedded PBR + Skeleton Data</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── AI ANSWER SNIPPETS / DIRECT SUMMARY ─────────────── */}
      <section className="mt-12 px-4 sm:px-6">
        <div className="mx-auto max-w-4xl rounded-2xl bg-primary/5 p-6 border border-primary/20 space-y-4">
          <div>
            <h2 className="text-xs font-black uppercase tracking-wider text-primary mb-1">
              Direct Answer: What is a GLB pet model?
            </h2>
            <p className="text-sm leading-relaxed text-on-surface">
              A <strong>GLB pet model</strong> is a 3D digital representation of a dog, cat, or animal saved in the binary glTF 2.0 format (.glb). A pet GLB file combines 3D mesh geometry, PBR (Physically Based Rendering) texture maps, lighting shaders, and skeletal animations into a single compact binary file that loads natively in web browsers and mobile AR without needing external texture folders.
            </p>
          </div>
          <div className="pt-3 border-t border-primary/10">
            <h3 className="text-xs font-black uppercase tracking-wider text-primary mb-1">
              Direct Answer: GLB vs OBJ vs FBX for pet models
            </h3>
            <p className="text-sm leading-relaxed text-on-surface">
              <strong>GLB</strong> is the gold standard for web apps and AR because it bundles textures into one self-contained binary file. <strong>OBJ</strong> requires separate .mtl files and image assets, making web deployment complex. <strong>FBX</strong> is popular in game engines (Unity/Unreal) but is proprietary and heavier to load directly in browsers.
            </p>
          </div>
        </div>
      </section>

      {/* ─────────────── COMPARISON TABLE ─────────────── */}
      <section className="mt-16 px-4 sm:px-6">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-black text-on-surface text-center mb-8">3D File Format Comparison</h2>
          <div className="overflow-x-auto glass-card rounded-2xl p-6">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-white/20 text-primary font-black uppercase tracking-wider">
                  <th className="p-3">Feature</th>
                  <th className="p-3">GLB (glTF 2.0)</th>
                  <th className="p-3">OBJ + MTL</th>
                  <th className="p-3">FBX</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10 text-on-surface">
                <tr>
                  <td className="p-3 font-bold">Single File Packaging</td>
                  <td className="p-3 text-emerald-400 font-bold">Yes (Binary)</td>
                  <td className="p-3 text-rose-400">No (Multiple Files)</td>
                  <td className="p-3 text-emerald-400 font-bold">Yes</td>
                </tr>
                <tr>
                  <td className="p-3 font-bold">Web &amp; AR Native Support</td>
                  <td className="p-3 text-emerald-400 font-bold">Native (Three.js/AR)</td>
                  <td className="p-3 text-amber-400">Requires Loaders</td>
                  <td className="p-3 text-amber-400">Heavy for Web</td>
                </tr>
                <tr>
                  <td className="p-3 font-bold">PBR Material Support</td>
                  <td className="p-3 text-emerald-400 font-bold">Full Standard</td>
                  <td className="p-3 text-rose-400">Legacy Basic</td>
                  <td className="p-3 text-emerald-400 font-bold">Full Standard</td>
                </tr>
                <tr>
                  <td className="p-3 font-bold">Blender Compatibility</td>
                  <td className="p-3 text-emerald-400 font-bold">100% Native Import</td>
                  <td className="p-3 text-emerald-400 font-bold">100% Native Import</td>
                  <td className="p-3 text-emerald-400 font-bold">100% Native Import</td>
                </tr>
                <tr>
                  <td className="p-3 font-bold">File Size Optimization</td>
                  <td className="p-3 text-emerald-400 font-bold">Highly Compressed</td>
                  <td className="p-3 text-rose-400">Uncompressed Text</td>
                  <td className="p-3 text-amber-400">Medium / Heavy</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ─────────────── HOW TO VIEW & USE GLB ─────────────── */}
      <section className="mt-20 px-4 sm:px-6">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-black text-on-surface text-center mb-8">How to View &amp; Use a GLB Pet File</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="glass-card p-6 rounded-2xl">
              <h3 className="text-lg font-black text-on-surface mb-2">1. In Blender 3D</h3>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                Open Blender &rarr; File &rarr; Import &rarr; glTF 2.0 (.glb/.gltf). Select your pet GLB file. All textures, materials, and armature bones will load automatically.
              </p>
            </div>
            <div className="glass-card p-6 rounded-2xl">
              <h3 className="text-lg font-black text-on-surface mb-2">2. In Web Apps (Three.js)</h3>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                Import <code className="bg-surface-container px-1 py-0.5 rounded text-primary">GLTFLoader</code> from Three.js and call <code className="bg-surface-container px-1 py-0.5 rounded text-primary">loader.load('pet.glb', callback)</code>. Render immediately with light setups.
              </p>
            </div>
            <div className="glass-card p-6 rounded-2xl">
              <h3 className="text-lg font-black text-on-surface mb-2">3. Mobile Augmented Reality (AR)</h3>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                On iOS, GLB files can be converted to USDZ or viewed via <code className="bg-surface-container px-1 py-0.5 rounded text-primary">&lt;model-viewer&gt;</code>. On Android, GLB opens directly in Scene Viewer AR.
              </p>
            </div>
            <div className="glass-card p-6 rounded-2xl">
              <h3 className="text-lg font-black text-on-surface mb-2">4. 3D Color Printing</h3>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                GLB files carry surface texture data that modern full-color 3D printers (e.g. Mimaki 3DUJ-553) use to print vibrant physical pet figurines.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── CTA ─────────────── */}
      <section className="mt-20 px-4 sm:px-6">
        <div className="mx-auto max-w-4xl text-center glass-card p-10 rounded-3xl">
          <h2 className="text-2xl font-black text-on-surface">Get Your GLB Pet Model Today</h2>
          <p className="mt-3 text-sm text-on-surface-variant max-w-xl mx-auto">
            Browse our catalog of affordable GLB pet models or generate a custom model from your pet photo.
          </p>
          <button
            type="button"
            onClick={onOpenCreate}
            className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg hover:bg-primary/90 transition-all active:scale-95"
          >
            Explore GLB Pet Models <ArrowRight size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}
