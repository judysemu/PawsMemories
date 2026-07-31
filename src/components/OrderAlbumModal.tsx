import React, { useState } from "react";
import { X, ShoppingBag, CreditCard, Truck, AlertCircle, Sparkles, RefreshCw } from "lucide-react";
import { Creation } from "../types";
import { authedFetch } from "../api";

interface OrderAlbumModalProps {
  creation: Creation;
  userCredits: number;
  onClose: () => void;
}

export default function OrderAlbumModal({ creation, userCredits, onClose }: OrderAlbumModalProps) {
  const [shippingName, setShippingName] = useState("");
  const [shippingAddress, setShippingAddress] = useState("");
  const [shippingCity, setShippingCity] = useState("");
  const [shippingState, setShippingState] = useState("");
  const [shippingZip, setShippingZip] = useState("");
  const [shippingCountry, setShippingCountry] = useState("United States");

  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const creditRequirement = 800;
  const cashRequirement = 12.00;
  const canAfford = userCredits >= creditRequirement;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canAfford) return;

    if (!shippingName || !shippingAddress || !shippingCity || !shippingState || !shippingZip) {
      setErrorMessage("Please fill out all shipping details.");
      return;
    }

    setLoading(true);
    setErrorMessage("");

    try {
      const response = await authedFetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creationId: creation.id,
          creationName: creation.name,
          imageUrl: creation.image_url || "",
          style: creation.style,
          creditsDeducted: creditRequirement,
          cashPaid: cashRequirement,
          shippingName,
          shippingAddress,
          shippingCity,
          shippingState,
          shippingZip,
          shippingCountry,
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to create checkout session");
      }

      // Redirect user to Stripe Checkout (or sandbox simulator URL)
      window.location.href = data.url;
    } catch (err: any) {
      console.error(err);
      setErrorMessage(err.message || "An error occurred during checkout setup. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-white dark:bg-slate-900 rounded-3xl p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-outline-variant/30 flex flex-col text-left text-on-surface">
        
        {/* Header */}
        <div className="flex justify-between items-center pb-4 border-b border-outline-variant/20 mb-4">
          <div className="flex items-center gap-2 text-primary">
            <ShoppingBag size={20} className="text-orange-600" />
            <h3 className="text-base font-extrabold uppercase tracking-wider font-sans">
              Print Physical Photo Album
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-on-surface-variant hover:text-on-surface p-1 rounded-full hover:bg-outline-variant/20 transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Product Details Card */}
        <div className="bg-primary/5 dark:bg-slate-800/50 rounded-2xl p-4 border border-primary/10 flex gap-4 mb-5">
          <div className="w-20 h-20 rounded-xl overflow-hidden shadow border border-outline-variant/20 shrink-0">
            <img
              src={creation.image_url || ""}
              alt={creation.name}
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
          </div>
          <div className="space-y-1 justify-center flex flex-col">
            <span className="text-[9px] font-black uppercase text-secondary tracking-widest">
              Premium Hardcover Print
            </span>
            <h4 className="text-sm font-bold text-on-surface leading-tight truncate max-w-[240px]">
              {creation.name}
            </h4>
            <p className="text-[11px] text-on-surface-variant leading-relaxed">
              20 Premium Lay-flat pages featuring your custom AI artwork styled cover.
            </p>
          </div>
        </div>

        {/* Pricing Summary */}
        <div className="bg-surface-container rounded-2xl p-4 border border-outline-variant/20 space-y-3 mb-5">
          <div className="flex justify-between items-center text-xs">
            <span className="text-on-surface-variant font-medium">Standard Album Printing</span>
            <span className="font-bold font-mono">$12.00 USD</span>
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="text-on-surface-variant font-medium">Digital Art Transfer fee</span>
            <span className="font-bold font-mono text-primary">800 credits</span>
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="text-on-surface-variant font-medium">Tracked Shipping &amp; Handling</span>
            <span className="font-bold text-emerald-600 font-sans uppercase text-[10px]">FREE / INCLUDED</span>
          </div>
          
          <div className="h-px bg-outline-variant/40 my-1"></div>
          
          <div className="flex justify-between items-center">
            <span className="text-xs font-extrabold uppercase tracking-wider text-on-surface">Total Hybrid Cost</span>
            <div className="text-right">
              <span className="text-sm font-black text-on-surface font-mono">$12.00 USD</span>
              <span className="text-xs text-on-surface-variant font-bold block">+ 800 credits</span>
            </div>
          </div>
        </div>

        {/* Credit Alert Validation */}
        {!canAfford ? (
          <div className="mb-5 p-4 bg-red-50 dark:bg-red-950/20 border border-red-200/50 dark:border-red-900/30 rounded-2xl flex gap-3 text-xs text-red-700 dark:text-red-300">
            <AlertCircle className="shrink-0 mt-0.5" size={16} />
            <div className="space-y-1">
              <p className="font-bold">Insufficient Credits</p>
              <p className="leading-relaxed">
                This physical album requires **800 credits** to process. You currently have **{userCredits} credits**. 
                You can earn credits through daily streaks and verified account achievements.
              </p>
            </div>
          </div>
        ) : (
          <div className="mb-5 p-3.5 bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200/50 dark:border-emerald-900/30 rounded-2xl flex gap-3 text-xs text-emerald-800 dark:text-emerald-300">
            <Sparkles className="shrink-0 mt-0.5 text-emerald-600" size={16} />
            <div className="space-y-0.5">
              <p className="font-bold">Credits Verified</p>
              <p className="leading-relaxed">
                You have **{userCredits} credits**. After Stripe payment completes, **800 credits** will be deducted.
              </p>
            </div>
          </div>
        )}

        {/* Shipping Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <h4 className="text-xs font-bold text-on-surface-variant uppercase tracking-widest px-1">
            Shipping Information
          </h4>

          <div className="space-y-3">
            <div>
              <label className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider px-1 block mb-1">
                Full Name
              </label>
              <input
                type="text"
                required
                disabled={loading || !canAfford}
                value={shippingName}
                onChange={(e) => setShippingName(e.target.value)}
                placeholder="e.g. Alex Smith"
                className="w-full bg-white dark:bg-slate-950 border border-outline-variant rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-primary text-slate-800 dark:text-slate-100 font-medium disabled:opacity-50"
              />
            </div>

            <div>
              <label className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider px-1 block mb-1">
                Address
              </label>
              <input
                type="text"
                required
                disabled={loading || !canAfford}
                value={shippingAddress}
                onChange={(e) => setShippingAddress(e.target.value)}
                placeholder="Street Address, Apt/Suite"
                className="w-full bg-white dark:bg-slate-950 border border-outline-variant rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-primary text-slate-800 dark:text-slate-100 font-medium disabled:opacity-50"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider px-1 block mb-1">
                  City
                </label>
                <input
                  type="text"
                  required
                  disabled={loading || !canAfford}
                  value={shippingCity}
                  onChange={(e) => setShippingCity(e.target.value)}
                  placeholder="City"
                  className="w-full bg-white dark:bg-slate-950 border border-outline-variant rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-primary text-slate-800 dark:text-slate-100 font-medium disabled:opacity-50"
                />
              </div>
              <div>
                <label className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider px-1 block mb-1">
                  State / Region
                </label>
                <input
                  type="text"
                  required
                  disabled={loading || !canAfford}
                  value={shippingState}
                  onChange={(e) => setShippingState(e.target.value)}
                  placeholder="e.g. CA, NY"
                  className="w-full bg-white dark:bg-slate-950 border border-outline-variant rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-primary text-slate-800 dark:text-slate-100 font-medium disabled:opacity-50"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider px-1 block mb-1">
                  Postal / ZIP Code
                </label>
                <input
                  type="text"
                  required
                  disabled={loading || !canAfford}
                  value={shippingZip}
                  onChange={(e) => setShippingZip(e.target.value)}
                  placeholder="Postal Code"
                  className="w-full bg-white dark:bg-slate-950 border border-outline-variant rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-primary text-slate-800 dark:text-slate-100 font-medium disabled:opacity-50"
                />
              </div>
              <div>
                <label className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider px-1 block mb-1">
                  Country
                </label>
                <select
                  disabled={loading || !canAfford}
                  value={shippingCountry}
                  onChange={(e) => setShippingCountry(e.target.value)}
                  className="w-full bg-white dark:bg-slate-950 border border-outline-variant rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-primary text-slate-800 dark:text-slate-100 font-black disabled:opacity-50 cursor-pointer"
                >
                  <option value="United States">🇺🇸 United States</option>
                  <option value="Canada">🇨🇦 Canada</option>
                  <option value="United Kingdom">🇬🇧 United Kingdom</option>
                  <option value="Australia">🇦🇺 Australia</option>
                  <option value="Germany">🇩🇪 Germany</option>
                </select>
              </div>
            </div>
          </div>

          {errorMessage && (
            <div className="p-3 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300 border border-red-200/50 dark:border-red-900/30 rounded-xl text-xs flex gap-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3 pt-4 border-t border-outline-variant/20 mt-6">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 py-3 px-4 bg-outline-variant hover:bg-outline-variant/75 text-on-surface-variant text-xs font-bold rounded-xl active:scale-95 duration-100 transition-all cursor-pointer text-center disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !canAfford}
              className="flex-1.5 py-3 px-4 bg-primary text-white text-xs font-black uppercase rounded-xl hover:bg-primary/95 shadow-md active:scale-95 duration-100 transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <RefreshCw size={13} className="animate-spin" />
                  <span>Connecting...</span>
                </>
              ) : (
                <>
                  <CreditCard size={13} />
                  <span>Pay $12.00 USD</span>
                </>
              )}
            </button>
          </div>
        </form>

        {/* Shipping details info */}
        <div className="mt-4 flex items-center gap-1.5 text-[10px] text-on-surface-variant font-medium justify-center">
          <Truck size={12} className="text-emerald-600" />
          <span>Ships in 2-3 business days with package tracking.</span>
        </div>

      </div>
    </div>
  );
}
