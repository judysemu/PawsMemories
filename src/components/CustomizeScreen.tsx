import React, { useState, useEffect, useRef } from "react";
import FriendlyError from "./FriendlyError";
import {
  ArrowLeft,
  Upload,
  Archive,
  Check,
  ShoppingBag,
  Loader2,
  AlertCircle,
  Sparkles,
  MapPin,
  User,
  Mail,
  Building,
  Globe,
} from "lucide-react";
import type { Creation } from "../types";
import {
  fetchPublishedCustomizableProducts,
  fetchCreations,
  checkoutCustomizeOrder,
  type CustomizableProduct,
} from "../api";

interface CustomizeScreenProps {
  product?: CustomizableProduct | null;
  onBack: () => void;
  onSuccess: (orderId: string) => void;
}

export default function CustomizeScreen({ product: initialProduct, onBack, onSuccess }: CustomizeScreenProps) {
  const [products, setProducts] = useState<CustomizableProduct[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<CustomizableProduct | null>(initialProduct || null);
  const [loadingProducts, setLoadingProducts] = useState(!initialProduct);

  // Source Photo selection: "upload" vs "furbin"
  const [sourceKind, setSourceKind] = useState<"upload" | "furbin">("upload");
  const [uploadedPhotoUrl, setUploadedPhotoUrl] = useState<string>("");
  const [furbinCreations, setFurbinCreations] = useState<Creation[]>([]);
  const [selectedCreation, setSelectedCreation] = useState<Creation | null>(null);
  const [loadingCreations, setLoadingCreations] = useState(false);

  // Recipient Shipping Address State
  const [recipient, setRecipient] = useState({
    name: "",
    email: "",
    address1: "",
    city: "",
    state_code: "",
    country_code: "US",
    zip: "",
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Load published customizable products if not provided
  useEffect(() => {
    if (!initialProduct) {
      (async () => {
        setLoadingProducts(true);
        try {
          const list = await fetchPublishedCustomizableProducts();
          setProducts(list);
          if (list.length > 0) setSelectedProduct(list[0]);
        } catch (err: any) {
          console.error(err);
        } finally {
          setLoadingProducts(false);
        }
      })();
    }
  }, [initialProduct]);

  // Load FurBin creations when FurBin tab selected
  useEffect(() => {
    if (sourceKind === "furbin" && furbinCreations.length === 0) {
      (async () => {
        setLoadingCreations(true);
        try {
          const list = await fetchCreations();
          // Filter to still images or creations with image_url
          const valid = list.filter((c) => c.image_url);
          setFurbinCreations(valid);
          if (valid.length > 0) {
            setSelectedCreation(valid[0]);
          }
        } catch (err: any) {
          console.error(err);
        } finally {
          setLoadingCreations(false);
        }
      })();
    }
  }, [sourceKind, furbinCreations.length]);

  // Handle local file upload convert to Data URL
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      setError("Image must be smaller than 25 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      if (typeof event.target?.result === "string") {
        setUploadedPhotoUrl(event.target.result);
        setError("");
      }
    };
    reader.readAsDataURL(file);
  };

  const selectedPhotoUrl =
    sourceKind === "upload" ? uploadedPhotoUrl : selectedCreation?.image_url || "";

  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!selectedProduct) {
      setError("Please select a product to customize.");
      return;
    }
    if (!selectedPhotoUrl) {
      setError("Please upload a photo or select one from FurBin.");
      return;
    }
    if (!recipient.name || !recipient.email || !recipient.address1 || !recipient.city || !recipient.zip) {
      setError("Please fill out all required shipping fields.");
      return;
    }

    setSubmitting(true);
    try {
      const idempotencyKey = `cust_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const payload = {
        customizableId: selectedProduct.id,
        sourcePhotoUrl: selectedPhotoUrl,
        sourceKind,
        recipient: {
          ...recipient,
          country_code: recipient.country_code.toUpperCase(),
        },
      };

      const result = await checkoutCustomizeOrder(payload, idempotencyKey);
      if (result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
      } else {
        onSuccess(idempotencyKey);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Could not start customizer checkout.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-7 sm:px-6">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-outline-variant/30 pb-5">
        <button
          onClick={onBack}
          className="rounded-xl border border-outline-variant/40 p-2 text-on-surface-variant hover:bg-surface-container"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <div className="flex items-center gap-2 text-primary">
            <ShoppingBag size={18} />
            <span className="text-xs font-black uppercase tracking-wider">Custom Prints & Gear</span>
          </div>
          <h1 className="text-2xl font-black text-on-surface">Design Your Custom Keepsake</h1>
        </div>
      </div>

      {error && <FriendlyError message={error} action="Check the form and try again." className="mt-4" />}

      {loadingProducts ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-primary" size={28} />
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-12">
          {/* Left Column: Product & Photo Selector + Live Composited Preview */}
          <div className="lg:col-span-7 flex flex-col gap-6">
            {/* Product Switcher if multiple published */}
            {products.length > 1 && (
              <div className="rounded-2xl border border-outline-variant/40 bg-surface/80 p-4">
                <label className="block text-xs font-bold text-on-surface-variant mb-2">Select Item</label>
                <div className="flex flex-wrap gap-2">
                  {products.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setSelectedProduct(p)}
                      className={`rounded-xl px-3 py-1.5 text-xs font-bold transition ${
                        selectedProduct?.id === p.id
                          ? "bg-primary text-on-primary"
                          : "border border-outline-variant/40 bg-surface text-on-surface-variant hover:text-on-surface"
                      }`}
                    >
                      {p.listing_name || `Product #${p.id}`} (${(p.retail_price_cents / 100).toFixed(2)})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Photo Source Selector Tab: Upload vs FurBin */}
            <div className="rounded-2xl border border-outline-variant/40 bg-surface/80 p-5">
              <h3 className="text-xs font-black uppercase tracking-wider text-primary">1. Choose Photo Source</h3>
              <div className="mt-3 flex rounded-xl bg-surface-container p-1 text-xs font-bold">
                <button
                  type="button"
                  onClick={() => setSourceKind("upload")}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 transition ${
                    sourceKind === "upload" ? "bg-primary text-on-primary shadow-sm" : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  <Upload size={14} /> Upload Photo
                </button>
                <button
                  type="button"
                  onClick={() => setSourceKind("furbin")}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 transition ${
                    sourceKind === "furbin" ? "bg-primary text-on-primary shadow-sm" : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  <Archive size={14} /> Pick from FurBin
                </button>
              </div>

              {/* Upload Input */}
              {sourceKind === "upload" && (
                <div className="mt-4">
                  <label className="flex aspect-video w-full cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-outline-variant/50 bg-surface-container-lowest p-4 transition hover:border-primary">
                    <Upload size={24} className="text-primary mb-2" />
                    <span className="text-xs font-bold text-on-surface">Click to select photo file</span>
                    <span className="text-[10px] text-on-surface-variant mt-1">PNG or JPEG up to 25 MB</span>
                    <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
                  </label>
                </div>
              )}

              {/* FurBin Picker */}
              {sourceKind === "furbin" && (
                <div className="mt-4">
                  {loadingCreations ? (
                    <div className="flex justify-center py-6">
                      <Loader2 className="animate-spin text-primary" size={20} />
                    </div>
                  ) : furbinCreations.length === 0 ? (
                    <p className="text-center text-xs font-bold text-on-surface-variant py-4">
                      No saved creations found in FurBin.
                    </p>
                  ) : (
                    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                      {furbinCreations.map((c) => (
                        <div
                          key={c.id}
                          onClick={() => setSelectedCreation(c)}
                          className={`relative aspect-square cursor-pointer overflow-hidden rounded-xl border-2 transition ${
                            selectedCreation?.id === c.id ? "border-primary ring-2 ring-primary/30" : "border-transparent hover:opacity-90"
                          }`}
                        >
                          <img src={c.image_url!} alt="Creation" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                          {selectedCreation?.id === c.id && (
                            <div className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-on-primary">
                              <Check size={12} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Live Composited Resolution Preview Container */}
            {selectedProduct && (
              <div className="rounded-2xl border border-outline-variant/40 bg-surface-container-lowest p-6">
                <div className="flex items-center justify-between text-xs">
                  <h3 className="font-black text-on-surface">2. Placement & Print Preview</h3>
                  <span className="font-mono text-[11px] text-on-surface-variant">
                    Print File: {selectedProduct.printfile_width_px} × {selectedProduct.printfile_height_px} px
                  </span>
                </div>

                <div className="relative mt-4 aspect-square w-full overflow-hidden rounded-xl border border-outline-variant/30 bg-surface-container-highest flex items-center justify-center">
                  {/* Background Mockup Frame */}
                  <div className="absolute inset-0 bg-gradient-to-tr from-surface-container-highest to-surface-container opacity-90" />

                  {/* Placement Box Composited Preview */}
                  <div
                    className="absolute border border-dashed border-primary/60 bg-black/5 overflow-hidden flex items-center justify-center shadow-inner"
                    style={{
                      left: `${selectedProduct.box_x * 100}%`,
                      top: `${selectedProduct.box_y * 100}%`,
                      width: `${selectedProduct.box_w * 100}%`,
                      height: `${selectedProduct.box_h * 100}%`,
                      borderRadius:
                        selectedProduct.box_shape === "circle"
                          ? "50%"
                          : selectedProduct.box_shape === "arch"
                          ? "50% 50% 0 0"
                          : "0",
                    }}
                  >
                    {selectedPhotoUrl ? (
                      <img
                        src={selectedPhotoUrl}
                        alt="Buyer Custom Print"
                        className="h-full w-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span className="text-[11px] font-bold text-on-surface-variant/70 text-center px-4">
                        Select a photo above to render live preview
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Recipient Shipping Address & Order Submission */}
          <div className="lg:col-span-5">
            <form onSubmit={handleCheckout} className="rounded-2xl border border-outline-variant/40 bg-surface/80 p-6 flex flex-col gap-4">
              <h3 className="text-xs font-black uppercase tracking-wider text-primary">3. Shipping Recipient</h3>

              <div>
                <label className="block text-xs font-bold text-on-surface-variant mb-1">Full Name *</label>
                <div className="relative">
                  <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
                  <input
                    type="text"
                    required
                    placeholder="Recipient Full Name"
                    value={recipient.name}
                    onChange={(e) => setRecipient({ ...recipient, name: e.target.value })}
                    className="w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest py-2.5 pl-9 pr-3 text-xs font-bold text-on-surface"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-on-surface-variant mb-1">Email *</label>
                <div className="relative">
                  <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
                  <input
                    type="email"
                    required
                    placeholder="receipt@example.com"
                    value={recipient.email}
                    onChange={(e) => setRecipient({ ...recipient, email: e.target.value })}
                    className="w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest py-2.5 pl-9 pr-3 text-xs font-bold text-on-surface"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-on-surface-variant mb-1">Address Line 1 *</label>
                <div className="relative">
                  <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
                  <input
                    type="text"
                    required
                    placeholder="Street Address"
                    value={recipient.address1}
                    onChange={(e) => setRecipient({ ...recipient, address1: e.target.value })}
                    className="w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest py-2.5 pl-9 pr-3 text-xs font-bold text-on-surface"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant mb-1">City *</label>
                  <input
                    type="text"
                    required
                    placeholder="City"
                    value={recipient.city}
                    onChange={(e) => setRecipient({ ...recipient, city: e.target.value })}
                    className="w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest py-2.5 px-3 text-xs font-bold text-on-surface"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant mb-1">State / Province</label>
                  <input
                    type="text"
                    placeholder="State Code (e.g. CA)"
                    value={recipient.state_code}
                    onChange={(e) => setRecipient({ ...recipient, state_code: e.target.value })}
                    className="w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest py-2.5 px-3 text-xs font-bold text-on-surface"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant mb-1">ZIP / Postal Code *</label>
                  <input
                    type="text"
                    required
                    placeholder="Postal Code"
                    value={recipient.zip}
                    onChange={(e) => setRecipient({ ...recipient, zip: e.target.value })}
                    className="w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest py-2.5 px-3 text-xs font-bold text-on-surface"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant mb-1">Country *</label>
                  <input
                    type="text"
                    required
                    maxLength={2}
                    placeholder="US"
                    value={recipient.country_code}
                    onChange={(e) => setRecipient({ ...recipient, country_code: e.target.value.toUpperCase() })}
                    className="w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest py-2.5 px-3 text-xs font-bold text-on-surface uppercase"
                  />
                </div>
              </div>

              {/* Order Pricing Summary */}
              {selectedProduct && (
                <div className="mt-4 border-t border-outline-variant/30 pt-4 text-xs font-bold space-y-1">
                  <div className="flex justify-between text-on-surface-variant">
                    <span>Subtotal</span>
                    <span>${(selectedProduct.retail_price_cents / 100).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-on-surface-variant">
                    <span>Silent Dropship Fulfillment</span>
                    <span className="text-emerald-600">Included</span>
                  </div>
                  <div className="flex justify-between text-sm font-black text-on-surface pt-2 border-t border-outline-variant/20">
                    <span>Total Due</span>
                    <span className="text-primary">${(selectedProduct.retail_price_cents / 100).toFixed(2)}</span>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !selectedPhotoUrl || !selectedProduct}
                className="mt-2 w-full rounded-xl bg-primary py-3.5 text-xs font-black text-on-primary hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting ? <Loader2 size={16} className="animate-spin" /> : <ShoppingBag size={16} />}
                Proceed to Checkout
              </button>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
