import React, { useState } from "react";
import { X, Zap, Check, RefreshCw, ShoppingCart, Sparkles, Star } from "lucide-react";
import { authedFetch } from "../api";
import { CREDIT_PACKS, SERVICE_PRICES } from "../pricing";

interface CreditStoreProps {
  onClose: () => void;
  currentCredits: number;
}

export default function CreditStore({ onClose, currentCredits }: CreditStoreProps) {
  const [selectedPack, setSelectedPack] = useState<string>("pack_600");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handlePurchase = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authedFetch("/api/create-credits-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId: selectedPack }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to start purchase.");
      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  const selected = CREDIT_PACKS.find((p) => p.id === selectedPack)!;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-white dark:bg-slate-900 rounded-3xl p-6 max-w-2xl w-full shadow-2xl border border-outline-variant/30 flex flex-col text-on-surface max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex justify-between items-center pb-4 border-b border-outline-variant/20 mb-5">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary/10 rounded-xl flex items-center justify-center">
              <Zap size={18} className="text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-wider text-on-surface">Buy Credits</h3>
              <p className="text-[10px] text-on-surface-variant font-medium">Current balance: <span className="font-black text-primary">{currentCredits} cr</span></p>
            </div>
          </div>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface p-1 rounded-full hover:bg-outline-variant/20 transition-colors cursor-pointer">
            <X size={18} />
          </button>
        </div>


        {/* Pack grid */}
        <div className="grid grid-cols-2 gap-3 mb-5">
          {CREDIT_PACKS.map((pack) => (
            <button
              key={pack.id}
              type="button"
              onClick={() => setSelectedPack(pack.id)}
              disabled={pack.comingSoon}
              className={`relative rounded-2xl p-4 text-left border-2 transition-all cursor-pointer active:scale-95 ${
                selectedPack === pack.id
                  ? "border-primary bg-primary/5 shadow-md"
                  : "border-outline-variant/30 bg-surface-container hover:border-primary/40"
              } ${pack.id === "pack_275" ? "ring-1 ring-secondary/40" : ""} disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {pack.id === "pack_275" && (
                <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-secondary text-white text-[9px] font-black px-2.5 py-0.5 rounded-full uppercase tracking-wider whitespace-nowrap flex items-center gap-1">
                  <Star size={8} className="fill-white" /> Most Popular
                </span>
              )}

              {pack.comingSoon && (
                <span className="absolute top-2.5 right-2.5 text-[9px] font-black uppercase text-on-surface-variant">Coming soon</span>
              )}

              {selectedPack === pack.id && (
                <div className="absolute top-2.5 right-2.5 w-5 h-5 bg-primary rounded-full flex items-center justify-center">
                  <Check size={11} className="text-white" />
                </div>
              )}

              <div className="text-xl font-black text-on-surface font-mono mb-0.5">{pack.credits}<span className="text-xs font-bold text-on-surface-variant ml-0.5">cr</span></div>
              <div className="text-sm font-black text-primary font-mono">
                ${pack.price.toFixed(2)}
                {pack.bonusPercent > 0 && <span className="ml-2 text-[9px] text-secondary">{pack.bonusPercent}% bonus</span>}
              </div>
              <div className="text-[10px] text-on-surface-variant font-medium mt-1">{pack.label}</div>

            </button>
          ))}
        </div>

        <div className="mb-5 border-t border-outline-variant/20 pt-5">
          <h4 className="mb-3 flex items-center gap-2 text-sm font-black uppercase tracking-wide">
            <Sparkles size={16} className="text-primary" /> Credit prices
          </h4>
          <div className="divide-y divide-outline-variant/20 rounded-2xl border border-outline-variant/30 overflow-hidden">
            {SERVICE_PRICES.map((item) => (
              <div key={`${item.label}-${item.detail || ""}`} className="flex items-center justify-between gap-4 bg-surface-container px-4 py-3 text-sm">
                <div>
                  <span className="font-bold text-on-surface">{item.label}</span>
                  {item.detail && <span className="block text-xs text-on-surface-variant">{item.detail}</span>}
                  {item.comingSoon && <span className="text-xs font-bold text-secondary">Coming soon</span>}
                </div>
                <span className="shrink-0 font-black text-primary">
                  {item.credits === null ? "Unavailable" : item.credits === 0 ? "Included" : `${item.credits} cr`}
                </span>
              </div>
            ))}
          </div>
        </div>


        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-700 border border-red-200/50 rounded-xl text-xs">
            {error}
          </div>
        )}

        {/* CTA */}
        <button
          onClick={handlePurchase}
          disabled={loading}
          className="w-full py-4 bg-primary text-white rounded-2xl font-black text-sm shadow-md hover:bg-primary/95 active:scale-[0.98] transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
        >
          {loading ? (
            <><RefreshCw size={16} className="animate-spin" /> Connecting to Checkout...</>
          ) : (
            <><ShoppingCart size={16} /> Buy {selected.credits} Credits — ${selected.price.toFixed(2)}</>
          )}
        </button>

        <p className="text-center text-[10px] text-on-surface-variant mt-3 font-medium">
          Secure payment via Stripe · Credits added instantly after payment
        </p>
      </div>
    </div>
  );
}
