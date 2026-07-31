import React, { useEffect, useState } from "react";
import { ArrowRight, Search, ShoppingBag, Sparkles, X, Loader2, Check, Palette } from "lucide-react";
import {
  fetchMarketplaceListings,
  checkoutDigitalListing,
  fetchUserEntitlements,
  fetchPublishedCustomizableProducts,
  type CustomizableProduct,
} from "../api";
import CustomizeScreen from "./CustomizeScreen";
import FriendlyError from "./FriendlyError";

type MarketplaceCategory = "all" | "custom_gear" | "breed" | "memorial" | "accessories" | "seasonal";

const CATEGORIES: { id: MarketplaceCategory; label: string; icon: string }[] = [
  { id: "all", label: "All", icon: "🐾" },
  { id: "custom_gear", label: "Custom Prints & Gear", icon: "🎨" },
  { id: "breed", label: "Breed Models", icon: "🐕" },
  { id: "memorial", label: "Memorial Pieces", icon: "🕊️" },
  { id: "accessories", label: "Accessories", icon: "🎀" },
  { id: "seasonal", label: "Seasonal", icon: "🎄" },
];

interface MarketplaceScreenProps {
  onOpenCreate: () => void;
}

export default function MarketplaceScreen({ onOpenCreate }: MarketplaceScreenProps) {
  const [category, setCategory] = useState<MarketplaceCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  
  const [listings, setListings] = useState<any[]>([]);
  const [customProducts, setCustomProducts] = useState<CustomizableProduct[]>([]);
  const [customizingProduct, setCustomizingProduct] = useState<CustomizableProduct | null>(null);
  const [loading, setLoading] = useState(true);
  const [ownedIds, setOwnedIds] = useState<Set<number>>(new Set());

  const [selectedListing, setSelectedListing] = useState<any | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");

  const refreshListings = async () => {
    setLoading(true);
    try {
      const params: any = {};
      if (category !== "all" && category !== "custom_gear") params.category = category;
      if (searchQuery) params.q = searchQuery;
      
      const [res, customList, entitlements] = await Promise.all([
        fetchMarketplaceListings(params),
        fetchPublishedCustomizableProducts(),
        fetchUserEntitlements().catch(() => []),
      ]);

      setListings(res.listings || []);
      setCustomProducts(customList || []);
      
      const owned = new Set<number>();
      for (const e of entitlements) {
        const match = (res.listings || []).find((l: any) => l.uuid === e.listing_uuid);
        if (match) owned.add(match.id);
      }
      setOwnedIds(owned);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => refreshListings(), 300);
    return () => clearTimeout(timer);
  }, [category, searchQuery]);

  const handleBuy = async (uuid: string) => {
    setCheckoutBusy(true);
    setCheckoutError("");
    try {
      const idempotencyKey = `digital_${uuid}_${Date.now()}`;
      const res = await checkoutDigitalListing(uuid, idempotencyKey);
      window.location.assign(res.checkoutUrl);
    } catch (err: any) {
      setCheckoutError(err.message || "Failed to start checkout.");
    } finally {
      setCheckoutBusy(false);
    }
  };

  if (customizingProduct) {
    return (
      <CustomizeScreen
        product={customizingProduct}
        onBack={() => setCustomizingProduct(null)}
        onSuccess={() => {
          setCustomizingProduct(null);
          refreshListings();
        }}
      />
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 pb-28 pt-7 sm:px-6">
      {/* Header */}
      <div className="glass-hero rounded-[2rem] p-6 sm:p-8">
        <div className="flex items-center gap-2 text-primary">
          <ShoppingBag size={18} />
          <span className="text-xs font-black uppercase tracking-[.18em]">Marketplace</span>
        </div>
        <h1 className="mt-2 text-2xl font-black tracking-tight text-on-surface sm:text-3xl">
          3D Pet Marketplace
        </h1>
        <p className="mt-2 max-w-xl text-sm text-on-surface-variant">
          Browse breed-specific models, memorial pieces, accessories, and seasonal collections.
        </p>
        {/* Search */}
        <div className="relative mt-5 max-w-md">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant" />
          <input
            type="text"
            placeholder="Search marketplace..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest py-3 pl-10 pr-4 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>

      {/* Category tabs */}
      <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="Marketplace category">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            type="button"
            role="tab"
            aria-selected={category === cat.id}
            onClick={() => setCategory(cat.id)}
            className={`min-h-10 rounded-full px-4 text-xs font-black transition ${
              category === cat.id
                ? "bg-primary text-on-primary"
                : "border border-outline-variant/45 bg-surface/80 text-on-surface-variant hover:text-primary"
            }`}
          >
            <span className="mr-1.5">{cat.icon}</span>
            {cat.label}
          </button>
        ))}
      </div>

      {/* Custom Prints & Gear Section */}
      {(category === "all" || category === "custom_gear") && customProducts.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center gap-2 mb-4">
            <Palette size={18} className="text-primary" />
            <h2 className="text-lg font-black text-on-surface">Custom Prints & Gear</h2>
          </div>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
            {customProducts.map((p) => (
              <article
                key={`custom-${p.id}`}
                className="glass-showcase group flex flex-col justify-between overflow-hidden rounded-[1.6rem] border border-primary/30 p-4 transition hover:border-primary"
              >
                <div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-black text-primary uppercase">
                    Customizable
                  </span>
                  <h3 className="mt-2 text-sm font-black text-on-surface line-clamp-1">
                    {p.listing_name || `Custom Product #${p.id}`}
                  </h3>
                  <p className="mt-1 text-xs text-on-surface-variant line-clamp-2">
                    {p.listing_description || "Add your pet photo to create custom apparel, mugs, or posters."}
                  </p>
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-outline-variant/20 pt-3">
                  <span className="text-xs font-black text-primary">
                    ${(p.retail_price_cents / 100).toFixed(2)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCustomizingProduct(p)}
                    className="rounded-xl bg-primary px-3 py-1.5 text-xs font-black text-on-primary hover:bg-primary/90"
                  >
                    Customize
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {/* Items grid */}
      {loading ? (
        <div className="mt-8 rounded-[2rem] border border-dashed border-outline-variant/50 bg-surface/80 p-12 flex justify-center">
          <Loader2 className="animate-spin text-primary" size={24} />
        </div>
      ) : listings.length === 0 ? (
        <div className="mt-8 rounded-[2rem] border border-dashed border-outline-variant/50 bg-surface/80 p-12 text-center text-sm text-on-surface-variant">
          No items match your search.
        </div>
      ) : (
        <div className="mt-7 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
          {listings.map((item) => {
            const isOwned = ownedIds.has(item.id);
            const coverImage = item.previews?.[0]?.url || "https://placehold.co/400?text=No+Preview";
            return (
              <article
                key={item.id}
                onClick={() => setSelectedListing(item)}
                className="glass-showcase group cursor-pointer overflow-hidden rounded-[1.6rem] relative"
              >
                <div className="relative aspect-square overflow-hidden bg-surface-container-highest">
                  <img
                    src={coverImage}
                    alt={item.name}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    referrerPolicy="no-referrer"
                  />
                  <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[10px] font-black capitalize text-white">
                    {item.category}
                  </span>
                  {isOwned && (
                    <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-emerald-500 px-2 py-1 text-[10px] font-black uppercase text-white shadow">
                      <Check size={10} /> Owned
                    </span>
                  )}
                </div>
                <div className="p-4">
                  <h3 className="text-sm font-black text-on-surface truncate">{item.name}</h3>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs font-bold text-primary">
                      {item.digital_price_cents ? `$${(item.digital_price_cents / 100).toFixed(2)}` : 'Free'}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] font-bold text-primary opacity-0 transition-opacity group-hover:opacity-100">
                      View <ArrowRight size={10} />
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Listing Detail Modal */}
      {selectedListing && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[92vh] w-full max-w-4xl overflow-auto rounded-[2rem] border border-white/30 bg-surface/95 p-5 shadow-2xl backdrop-blur-2xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-on-surface">{selectedListing.name}</h2>
                <p className="text-xs text-on-surface-variant capitalize">{selectedListing.category} Model</p>
              </div>
              <button 
                type="button" 
                onClick={() => { setSelectedListing(null); setCheckoutError(""); }} 
                className="grid h-10 w-10 place-items-center rounded-full border border-outline-variant/40"
              >
                <X size={18} />
              </button>
            </div>
            
            <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-8">
              {/* Preview Carousel */}
              <div className="flex flex-col gap-3">
                <div className="aspect-square overflow-hidden rounded-2xl bg-surface-container-highest">
                  <img 
                    src={selectedListing.previews?.[0]?.url || "https://placehold.co/400"} 
                    alt={selectedListing.name} 
                    className="h-full w-full object-cover" 
                  />
                </div>
                {selectedListing.previews?.length > 1 && (
                  <div className="flex gap-2 overflow-x-auto pb-2">
                    {selectedListing.previews.map((preview: any, idx: number) => (
                      <img 
                        key={idx} 
                        src={preview.url} 
                        alt="preview" 
                        className="h-16 w-16 rounded-xl object-cover border border-outline-variant/40"
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Details & Actions */}
              <div className="flex flex-col">
                {selectedListing.description && (
                  <p className="text-sm text-on-surface whitespace-pre-wrap">{selectedListing.description}</p>
                )}
                
                <div className="mt-6 flex flex-wrap gap-2">
                  {selectedListing.tags_json && (() => {
                    try {
                      const tags = JSON.parse(selectedListing.tags_json);
                      return tags.map((t: string) => (
                        <span key={t} className="rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">{t}</span>
                      ));
                    } catch { return null; }
                  })()}
                </div>

                <div className="mt-auto pt-8">
                  <div className="mb-4 flex items-end gap-2">
                    <span className="text-3xl font-black text-on-surface">
                      ${(selectedListing.digital_price_cents / 100).toFixed(2)}
                    </span>
                    <span className="text-sm text-on-surface-variant pb-1">digital download</span>
                  </div>

                  {ownedIds.has(selectedListing.id) ? (
                    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center">
                      <p className="font-bold text-emerald-600 flex items-center justify-center gap-2">
                        <Check size={18} /> You own this model
                      </p>
                      <p className="text-xs text-emerald-700 mt-1">Check your FurBin to download the files.</p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={() => handleBuy(selectedListing.uuid)}
                        disabled={checkoutBusy || !selectedListing.digital_price_cents}
                        className="w-full flex min-h-12 items-center justify-center rounded-xl bg-primary px-6 text-sm font-black text-on-primary disabled:opacity-50 transition"
                      >
                        {checkoutBusy ? <Loader2 className="animate-spin mr-2" size={16} /> : <ShoppingBag className="mr-2" size={16} />}
                        {checkoutBusy ? "Opening checkout..." : "Buy now"}
                      </button>
                      {checkoutError && <FriendlyError message={checkoutError} action="Please try again in a moment." className="text-left" />}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Hand-off */}
      <div className="mt-10 glass-card rounded-2xl p-6 text-center">
        <Sparkles size={22} className="mx-auto mb-3 text-primary" />
        <h3 className="text-base font-black text-on-surface">Can't find what you need?</h3>
        <p className="mt-2 text-xs text-on-surface-variant">
          Create your own custom 3D pet model using photos of your pet.
        </p>
        <button
          type="button"
          onClick={onOpenCreate}
          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-black text-on-primary shadow-md transition-all hover:brightness-105 active:scale-95"
        >
          Create Custom Model
          <ArrowRight size={14} />
        </button>
      </div>
    </main>
  );
}
