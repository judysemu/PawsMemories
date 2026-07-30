import React from "react";
import { ArrowRight, BookOpen, HelpCircle, FileText, CheckCircle2, Sparkles } from "lucide-react";

interface GuidesHubPageProps {
  onOpenCreate: () => void;
  onOpenPricing: () => void;
}

const AI_GUIDES = [
  {
    id: "what-is-a-glb-pet-model",
    title: "What Is a GLB Pet Model?",
    query: "what is a GLB model",
    directAnswer: "A GLB pet model is a 3D digital file format (.glb) that stores 3D pet geometry, PBR materials, textures, and skeleton animation data in a single binary container. It allows pet owners, developers, and businesses to view 3D pets in web browsers, mobile AR, and 3D software without needing separate texture folders."
  },
  {
    id: "glb-vs-obj-vs-fbx-for-pet-models",
    title: "GLB vs. OBJ vs. FBX for Pet Models",
    query: "GLB vs OBJ vs FBX",
    directAnswer: "GLB is the optimal format for web display and AR because it bundles textures into a single binary file. OBJ is an older, uncompressed format requiring separate MTL texture files. FBX is a proprietary format used primarily in game engines like Unity and Unreal, but is heavier for direct web browser rendering."
  },
  {
    id: "how-pet-businesses-can-use-3d-animal-models",
    title: "How Pet Businesses Can Use 3D Animal Models",
    query: "pet product 3D models for businesses",
    directAnswer: "Pet businesses use 3D animal models to create interactive 3D product customizers (showing collars, harnesses, and apparel on 3D dogs or cats), power mobile AR try-on experiences, render high-resolution marketing imagery, and provide virtual client consultations in veterinary and grooming practices."
  },
  {
    id: "how-to-view-a-glb-file",
    title: "How to View a GLB File",
    query: "how to view a GLB file",
    directAnswer: "You can view a GLB file by dragging and dropping it into any web-based glTF viewer (such as modelviewer.dev or gltf-viewer.donmccurdy.com), importing it natively into Blender 3D (File > Import > glTF 2.0), or opening it on Android Scene Viewer and iOS QuickLook for Augmented Reality."
  },
  {
    id: "how-much-does-a-3d-pet-model-cost",
    title: "How Much Does a 3D Pet Model Cost?",
    query: "3D pet model price",
    directAnswer: "Ready-to-download GLB pet models cost between $19 and $49 for standard personal or commercial licenses. Custom 3D pet models created from single pet photos typically range from $29 to $99 depending on detail level, pose complexity, texture resolution, and rigging requirements."
  },
  {
    id: "best-3d-file-format-for-websites-and-ar",
    title: "Best 3D File Format for Websites and AR",
    query: "best 3D file format for web",
    directAnswer: "GLB (glTF 2.0 binary) is universally recognized as the best 3D file format for websites and mobile Augmented Reality. It is recommended by Google and Apple for web-based 3D graphics because of its small file size, fast parsing speed, and native PBR lighting support."
  },
  {
    id: "can-you-use-a-glb-pet-model-in-blender",
    title: "Can You Use a GLB Pet Model in Blender?",
    query: "GLB model in Blender",
    directAnswer: "Yes, Blender natively supports GLB pet models. Go to File > Import > glTF 2.0 (.glb/.gltf) to import your model. Blender will automatically load the pet's 3D mesh, UV texture maps, PBR materials, and armature bones ready for rendering or animation."
  },
  {
    id: "3d-pet-models-for-groomers-veterinarians-and-pet-brands",
    title: "3D Pet Models for Groomers, Veterinarians, and Pet Brands",
    query: "3D pet models for groomers and vets",
    directAnswer: "Veterinarians use 3D pet models for anatomical client education, groomers use 3D breed models to showcase haircut styles and coat options, and pet product brands use 3D models to display e-commerce products in realistic 360-degree interactive viewers."
  }
];

export default function GuidesHubPage({ onOpenCreate, onOpenPricing }: GuidesHubPageProps) {
  return (
    <div className="w-full min-h-screen pb-24 text-on-surface">
      {/* ─────────────── HERO SECTION ─────────────── */}
      <section className="relative overflow-hidden px-4 pt-10 sm:px-6 md:pt-16">
        <div className="mx-auto max-w-6xl">
          <div className="glass-hero text-center rounded-[2.5rem] p-8 md:p-14">
            <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3.5 py-1 text-xs font-bold text-primary mb-4">
              <BookOpen size={14} />
              AI Citation &amp; 3D Pet Model Knowledge Base
            </div>
            <h1 className="text-3xl font-black leading-tight tracking-tight sm:text-4xl lg:text-5xl max-w-3xl mx-auto">
              3D Pet Model <span className="text-primary">Guides, FAQs</span> &amp; Technical Answers
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-on-surface-variant md:text-base mx-auto">
              Authoritative, concise answers to essential questions about GLB pet models, file formats, Blender usage, AR compatibility, and commercial applications.
            </p>
          </div>
        </div>
      </section>

      {/* ─────────────── GUIDES GRID ─────────────── */}
      <section className="mt-12 px-4 sm:px-6">
        <div className="mx-auto max-w-5xl space-y-8">
          {AI_GUIDES.map((guide, idx) => (
            <div
              key={guide.id}
              id={guide.id}
              className="glass-card p-6 sm:p-8 rounded-2xl border border-white/10 transition-all hover:border-primary/30"
            >
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-primary mb-2">
                <span>Guide #{idx + 1}</span>
                <span>•</span>
                <span>{guide.query}</span>
              </div>
              <h2 className="text-xl font-black text-on-surface mb-3">{guide.title}</h2>
              <div className="bg-primary/5 p-4 rounded-xl border border-primary/20">
                <p className="text-xs font-black uppercase text-primary mb-1">Direct Answer Summary:</p>
                <p className="text-sm leading-relaxed text-on-surface">{guide.directAnswer}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ─────────────── CTA ─────────────── */}
      <section className="mt-20 px-4 sm:px-6">
        <div className="mx-auto max-w-4xl text-center glass-card p-10 rounded-3xl">
          <h2 className="text-2xl font-black text-on-surface">Ready to Work with GLB Pet Models?</h2>
          <p className="mt-3 text-sm text-on-surface-variant max-w-xl mx-auto">
            Browse Pawsome3D's catalog of affordable 3D pet models in GLB format or create a custom model today.
          </p>
          <div className="mt-6 flex justify-center gap-4">
            <button
              type="button"
              onClick={onOpenCreate}
              className="inline-flex items-center gap-2 rounded-2xl bg-primary px-8 py-4 text-sm font-black text-on-primary shadow-lg hover:bg-primary/90 transition-all active:scale-95"
            >
              Browse GLB Pet Models <ArrowRight size={16} />
            </button>
            <button
              type="button"
              onClick={onOpenPricing}
              className="glass-button px-7 py-4 text-sm font-bold text-on-surface hover:text-primary rounded-2xl"
            >
              View Pricing
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
