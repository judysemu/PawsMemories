import React, { useMemo, useState } from "react";
import { ArrowRight, Clock3, Crown, PawPrint } from "lucide-react";
import {
  FAMOUS_PORTRAIT_CATEGORIES,
  publicFamousPortraitCatalog,
  type FamousPortraitRecord,
} from "../../shared/historicalPetCatalog.ts";

type FamousPortraitCategory = typeof FAMOUS_PORTRAIT_CATEGORIES[number];

const CATEGORY_LABELS: Record<FamousPortraitCategory, string> = {
  "historic-women": "Historic Women",
  leaders: "Presidents & World Leaders",
  "sports-legends": "Sports Legends",
  "myth-holiday": "Myth & Holiday",
  "arts-adventure": "Arts & Adventure",
  halloween: "Halloween",
  landmarks: "Famous Landmarks",
};

const PUBLIC_PORTRAITS = publicFamousPortraitCatalog();

export function portraitsForCategory(category: FamousPortraitCategory) {
  return PUBLIC_PORTRAITS.filter((portrait) => portrait.category === category);
}

interface FamousPortraitsProps {
  onOpenPawprints: () => void;
}

function PortraitCard({ portrait, onOpenPawprints }: { portrait: Omit<FamousPortraitRecord, "inspirationSource" | "numberSource">; onOpenPawprints: () => void }) {
  const available = portrait.availability === "available" && portrait.previewAsset;
  return (
    <article className="group overflow-hidden rounded-[1.6rem] border border-outline-variant/25 bg-surface-container-low shadow-sm transition hover:-translate-y-1 hover:shadow-xl">
      <div className="relative aspect-[4/5] overflow-hidden bg-gradient-to-br from-primary/25 via-surface-container-high to-secondary/20">
        {available ? (
          <img
            src={portrait.previewAsset.publicPath}
            alt={portrait.altText}
            width={portrait.previewAsset.width}
            height={portrait.previewAsset.height}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-7 text-center" style={{ background: `radial-gradient(circle at 50% 28%, ${portrait.palette[1]}55, transparent 42%), linear-gradient(145deg, ${portrait.palette[0]}, ${portrait.palette[2]})` }}>
            <Crown size={44} className="text-white/85" aria-hidden="true" />
            {portrait.uniformNumber !== null && <span className="mt-5 text-5xl font-black text-white/90">#{portrait.uniformNumber}</span>}
            {portrait.fictionalMark && <span className="mt-2 rounded-full border border-white/35 px-3 py-1 text-xs font-black tracking-[.16em] text-white">{portrait.fictionalMark}</span>}
            <span className="mt-5 inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[.18em] text-white/75"><Clock3 size={12} /> Portrait art in progress</span>
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent p-5 pt-16 text-white">
          <h3 className="text-lg font-black">{portrait.displayName}</h3>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/80">{portrait.fictionalRole}</p>
        </div>
      </div>
      <div className="p-4">
        {available ? (
          <button type="button" onClick={onOpenPawprints} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-black text-on-primary">
            Make my pet famous <ArrowRight size={15} />
          </button>
        ) : (
          <div className="flex min-h-11 items-center justify-center rounded-xl bg-surface-container-high px-4 text-sm font-bold text-on-surface-variant">Coming soon</div>
        )}
      </div>
    </article>
  );
}

export default function FamousPortraits({ onOpenPawprints }: FamousPortraitsProps) {
  const [category, setCategory] = useState<FamousPortraitCategory>("arts-adventure");
  const portraits = useMemo(() => portraitsForCategory(category), [category]);

  return (
    <section aria-labelledby="famous-portraits-title" className="mt-14 px-4 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="flex items-center gap-2 text-xs font-black uppercase tracking-[.18em] text-primary"><PawPrint size={17} /> Famous Portraits</p>
            <h2 id="famous-portraits-title" className="mt-2 text-3xl font-black tracking-tight text-on-surface">Your pet belongs in the history books</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">Choose a playful role, then turn your favorite pet photo into a digital portrait or printed keepsake.</p>
          </div>
          <button type="button" onClick={onOpenPawprints} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-primary/35 px-5 text-sm font-black text-primary">Open Historic Pawprints <ArrowRight size={15} /></button>
        </div>

        <div role="tablist" aria-label="Famous Portrait categories" className="mt-6 flex gap-2 overflow-x-auto pb-2 [scrollbar-width:none]">
          {FAMOUS_PORTRAIT_CATEGORIES.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={category === id}
              onClick={() => setCategory(id)}
              className={`min-h-11 shrink-0 rounded-full px-4 text-xs font-black transition ${category === id ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface-variant hover:text-primary"}`}
            >
              {CATEGORY_LABELS[id]}
            </button>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4" aria-live="polite">
          {portraits.map((portrait) => <PortraitCard key={portrait.id} portrait={portrait} onOpenPawprints={onOpenPawprints} />)}
        </div>
      </div>
    </section>
  );
}
