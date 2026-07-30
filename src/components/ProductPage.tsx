import React, { useState } from "react";
import { ArrowRight, CheckCircle2, ShieldCheck, Download, Box, Sparkles, Star, Cpu, Layers, RefreshCw, FileText, Check, HelpCircle } from "lucide-react";

interface ProductPageProps {
  productSlug?: string;
  onOpenCreate: () => void;
  onOpenPricing: () => void;
}

export interface ProductData {
  slug: string;
  name: string;
  petType: string;
  breed: string;
  price: string;
  format: string;
  image: string;
  polygons: string;
  vertices: string;
  fileSize: string;
  textures: string;
  includedFiles: string[];
  compatibility: string[];
  personalLicense: string;
  commercialLicense: string;
  deliveryMethod: string;
  refundTerms: string;
  description: string;
}

const PRODUCTS_DATABASE: Record<string, ProductData> = {
  "shiba-inu-glb": {
    slug: "shiba-inu-glb",
    name: "Shiba Inu Classic GLB",
    petType: "Dog",
    breed: "Shiba Inu",
    price: "$19.00",
    format: "Binary glTF 2.0 (.GLB)",
    image: "/featured-models/shiba-inu.webp",
    polygons: "14,200 Triangles",
    vertices: "7,350 Vertices",
    fileSize: "4.8 MB",
    textures: "4096 x 4096 PBR Albedo, Normal, Roughness Maps",
    includedFiles: [
      "1x Single Binary .GLB File",
      "Embedded 4K PBR Textures",
      "Rigged Armature / Skeletal Rig",
      "5 Core Animation Clips (Idle, Walk, Sit, Wag, Bark)",
      "Optional OBJ + MTL fallback zip"
    ],
    compatibility: [
      "Blender (Native glTF 2.0 Import)",
      "Three.js & WebGL Web Frameworks",
      "Unity 2022+ & Unreal Engine 5+",
      "iOS AR QuickLook (.usdz auto-convert / .glb)",
      "Android Scene Viewer AR"
    ],
    personalLicense: "Personal / Non-Commercial Use: Unlimited personal renders, 3D printing for self, background scenes.",
    commercialLicense: "Commercial License Add-on (+$20): Commercial web display, e-commerce catalog, video production, apps.",
    deliveryMethod: "Instant Digital File Download (Automatic GLB file download sent to your email immediately upon purchase).",
    refundTerms: "100% Satisfaction Guarantee. 30-day free revision window for custom orders. 14-day digital refund policy if model fails specifications.",
    description: "The Shiba Inu Classic GLB is a meticulously sculpted, game-ready 3D dog model in binary glTF 2.0 format. Designed with clean quad topology, PBR materials, and embedded textures, it loads instantly in WebGL apps, mobile AR, and Blender."
  },
  "chihuahua-classic-glb": {
    slug: "chihuahua-classic-glb",
    name: "Chihuahua Classic GLB",
    petType: "Dog",
    breed: "Chihuahua",
    price: "$19.00",
    format: "Binary glTF 2.0 (.GLB)",
    image: "/featured-models/chihuahua.webp",
    polygons: "12,800 Triangles",
    vertices: "6,500 Vertices",
    fileSize: "3.9 MB",
    textures: "4096 x 4096 PBR Textures",
    includedFiles: [
      "1x Single Binary .GLB File",
      "Embedded 4K PBR Textures",
      "Rigged Armature / Skeleton",
      "Interactive 3D Preview Assets"
    ],
    compatibility: [
      "Blender 3.0+",
      "Three.js & Babylon.js",
      "Unity & Unreal Engine",
      "iOS QuickLook & Android Scene Viewer"
    ],
    personalLicense: "Personal / Non-Commercial Use",
    commercialLicense: "Commercial License Available",
    deliveryMethod: "Instant Automatic Digital Download",
    refundTerms: "100% Satisfaction Guarantee & 14-Day Refund Window",
    description: "Chihuahua Classic GLB is a lightweight, realistic 3D dog model formatted in binary glTF 2.0. Perfect for mobile apps, AR experiences, and 3D pet printing."
  },
  "tuxedo-boston-terrier-glb": {
    slug: "tuxedo-boston-terrier-glb",
    name: "Tuxedo Boston Terrier GLB",
    petType: "Dog",
    breed: "Boston Terrier",
    price: "$24.00",
    format: "Binary glTF 2.0 (.GLB)",
    image: "/featured-models/boston-terrier.webp",
    polygons: "16,500 Triangles",
    vertices: "8,400 Vertices",
    fileSize: "5.2 MB",
    textures: "4K PBR Textures",
    includedFiles: [
      "1x Binary .GLB File",
      "4K PBR Material Suite",
      "Skeleton Rig"
    ],
    compatibility: [
      "Blender",
      "Three.js / WebGL",
      "Unity / Unreal",
      "Mobile AR"
    ],
    personalLicense: "Personal License",
    commercialLicense: "Commercial License Available",
    deliveryMethod: "Instant Digital Download",
    refundTerms: "100% Satisfaction Guarantee",
    description: "Tuxedo Boston Terrier GLB is a highly detailed 3D model featuring signature tuxedo markings, PBR fur shaders, and game-ready mesh structure."
  },
  "labradoodle-tuck-glb": {
    slug: "labradoodle-tuck-glb",
    name: "Labradoodle Tuck GLB",
    petType: "Dog",
    breed: "Labradoodle",
    price: "$29.00",
    format: "Binary glTF 2.0 (.GLB)",
    image: "/featured-models/tuck.webp",
    polygons: "18,900 Triangles",
    vertices: "9,700 Vertices",
    fileSize: "6.1 MB",
    textures: "4K High-Res PBR Textures",
    includedFiles: [
      "1x Binary .GLB File",
      "High-res PBR Fur Textures",
      "Full Rigged Skeleton"
    ],
    compatibility: [
      "Blender",
      "Three.js",
      "Unity",
      "AR QuickLook"
    ],
    personalLicense: "Personal License",
    commercialLicense: "Commercial License Available",
    deliveryMethod: "Instant Digital Download",
    refundTerms: "100% Satisfaction Guarantee",
    description: "Labradoodle Tuck GLB is a premium curly-coat 3D dog model engineered for high visual fidelity in both digital 3D scenes and physical 3D printing."
  }
};

export default function ProductPage({ productSlug = "shiba-inu-glb", onOpenCreate, onOpenPricing }: ProductPageProps) {
  const product = PRODUCTS_DATABASE[productSlug] || PRODUCTS_DATABASE["shiba-inu-glb"];
  const [selectedLicense, setSelectedLicense] = useState<"personal" | "commercial">("personal");
  const [purchased, setPurchased] = useState(false);

  const displayPrice = selectedLicense === "personal" ? product.price : `$${parseFloat(product.price.replace("$", "")) + 20}.00`;

  return (
    <div className="w-full min-h-screen pb-24 text-on-surface">
      {/* ─────────────── BREADCRUMB & HEADER ─────────────── */}
      <section className="px-4 pt-6 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-center gap-2 text-xs font-semibold text-on-surface-variant">
            <a href="/" className="hover:text-primary">Home</a>
            <span>/</span>
            <a href="/dog-3d-models" className="hover:text-primary">{product.petType} Models</a>
            <span>/</span>
            <span className="text-primary font-bold">{product.name}</span>
          </div>
        </div>
      </section>

      {/* ─────────────── MAIN PRODUCT SECTION ─────────────── */}
      <section className="mt-6 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
            {/* Left Column: Interactive Preview & Image Showcase */}
            <div className="space-y-4">
              <div className="relative aspect-square w-full overflow-hidden rounded-3xl glass-card bg-surface-container border border-white/20">
                <img
                  src={product.image}
                  alt={`${product.name} - 3D pet model GLB`}
                  className="h-full w-full object-cover"
                />
                <div className="absolute top-4 left-4 rounded-full bg-primary/90 px-3.5 py-1.5 text-xs font-black text-on-primary backdrop-blur-md">
                  {product.format}
                </div>
                <div className="absolute bottom-4 right-4 rounded-2xl bg-black/70 px-4 py-2 text-xs text-white backdrop-blur-md border border-white/20">
                  <span className="flex items-center gap-2 font-bold">
                    <Box size={14} className="text-primary" /> Interactive 3D GLB Preview
                  </span>
                </div>
              </div>
              <div className="p-4 glass-card rounded-2xl text-xs text-on-surface-variant flex items-center justify-between">
                <span>Format: <strong className="text-on-surface">{product.format}</strong></span>
                <span>Polygons: <strong className="text-on-surface">{product.polygons}</strong></span>
                <span>File Size: <strong className="text-on-surface">{product.fileSize}</strong></span>
              </div>
            </div>

            {/* Right Column: Details, Specifications, Pricing & Buy Button */}
            <div className="flex flex-col justify-between space-y-6">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary mb-3">
                  <Sparkles size={14} />
                  {product.breed} ({product.petType})
                </div>
                <h1 className="text-3xl font-black text-on-surface">{product.name}</h1>
                <p className="mt-3 text-sm text-on-surface-variant leading-relaxed">
                  {product.description}
                </p>

                {/* Price Display */}
                <div className="mt-6 flex items-baseline gap-3">
                  <span className="text-4xl font-black text-primary">{displayPrice}</span>
                  <span className="text-xs font-bold text-on-surface-variant uppercase tracking-wider">USD</span>
                </div>

                {/* License Selector */}
                <div className="mt-6 space-y-3">
                  <label className="text-xs font-black uppercase tracking-wider text-on-surface">Select License:</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setSelectedLicense("personal")}
                      className={`p-3.5 rounded-2xl text-left border text-xs font-bold transition-all ${
                        selectedLicense === "personal"
                          ? "border-primary bg-primary/10 text-primary shadow-sm"
                          : "border-white/10 glass-card text-on-surface-variant hover:text-on-surface"
                      }`}
                    >
                      <div>Personal License</div>
                      <div className="text-[11px] font-normal text-on-surface-variant mt-0.5">{product.price}</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedLicense("commercial")}
                      className={`p-3.5 rounded-2xl text-left border text-xs font-bold transition-all ${
                        selectedLicense === "commercial"
                          ? "border-primary bg-primary/10 text-primary shadow-sm"
                          : "border-white/10 glass-card text-on-surface-variant hover:text-on-surface"
                      }`}
                    >
                      <div>Commercial License</div>
                      <div className="text-[11px] font-normal text-on-surface-variant mt-0.5">+ $20.00</div>
                    </button>
                  </div>
                </div>

                {/* Buy Button */}
                <div className="mt-8">
                  {purchased ? (
                    <div className="p-4 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-center text-sm font-bold flex items-center justify-center gap-2">
                      <CheckCircle2 size={18} />
                      Downloading {product.name} (.GLB) ... Check your email!
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPurchased(true)}
                      className="w-full flex items-center justify-center gap-2 rounded-2xl bg-primary px-8 py-4 text-base font-black text-on-primary shadow-xl hover:bg-primary/90 transition-all active:scale-95"
                    >
                      <Download size={18} />
                      Buy Model &amp; Download GLB ({displayPrice})
                    </button>
                  )}
                  <p className="mt-2 text-[11px] text-center text-on-surface-variant">
                    Instant automatic download after checkout • 100% Satisfaction Guarantee
                  </p>
                </div>
              </div>

              {/* Delivery & Terms Quick Hits */}
              <div className="glass-card p-4 rounded-2xl space-y-2 text-xs">
                <div className="flex items-center gap-2 text-on-surface">
                  <Check className="text-primary shrink-0" size={16} />
                  <span><strong>Delivery Method:</strong> {product.deliveryMethod}</span>
                </div>
                <div className="flex items-center gap-2 text-on-surface">
                  <ShieldCheck className="text-primary shrink-0" size={16} />
                  <span><strong>Refund &amp; Revision Terms:</strong> {product.refundTerms}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── DETAILED SPECIFICATIONS TABS ─────────────── */}
      <section className="mt-16 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Included Files & Features */}
            <div className="glass-card p-6 rounded-3xl">
              <h2 className="text-lg font-black text-on-surface mb-4 flex items-center gap-2">
                <FileText className="text-primary" size={20} /> Included Files &amp; Features
              </h2>
              <ul className="space-y-3">
                {product.includedFiles.map((file, idx) => (
                  <li key={idx} className="flex items-start gap-2.5 text-xs text-on-surface">
                    <CheckCircle2 className="text-primary shrink-0 mt-0.5" size={16} />
                    <span>{file}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Software & Platform Compatibility */}
            <div className="glass-card p-6 rounded-3xl">
              <h2 className="text-lg font-black text-on-surface mb-4 flex items-center gap-2">
                <Cpu className="text-primary" size={20} /> Software &amp; Platform Compatibility
              </h2>
              <ul className="space-y-3">
                {product.compatibility.map((platform, idx) => (
                  <li key={idx} className="flex items-start gap-2.5 text-xs text-on-surface">
                    <CheckCircle2 className="text-primary shrink-0 mt-0.5" size={16} />
                    <span>{platform}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────── TECHNICAL SPECIFICATIONS TABLE ─────────────── */}
      <section className="mt-12 px-4 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="glass-card p-6 rounded-3xl">
            <h2 className="text-lg font-black text-on-surface mb-4 flex items-center gap-2">
              <Layers className="text-primary" size={20} /> Technical Specifications
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
              <div className="p-3 bg-surface-container rounded-xl">
                <span className="text-[10px] uppercase font-bold text-on-surface-variant">File Format</span>
                <p className="font-bold text-on-surface mt-1">{product.format}</p>
              </div>
              <div className="p-3 bg-surface-container rounded-xl">
                <span className="text-[10px] uppercase font-bold text-on-surface-variant">Poly Count</span>
                <p className="font-bold text-on-surface mt-1">{product.polygons}</p>
              </div>
              <div className="p-3 bg-surface-container rounded-xl">
                <span className="text-[10px] uppercase font-bold text-on-surface-variant">Vertex Count</span>
                <p className="font-bold text-on-surface mt-1">{product.vertices}</p>
              </div>
              <div className="p-3 bg-surface-container rounded-xl">
                <span className="text-[10px] uppercase font-bold text-on-surface-variant">Texture Specs</span>
                <p className="font-bold text-on-surface mt-1">{product.textures}</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
