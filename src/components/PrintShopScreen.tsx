/**
 * PrintShopScreen — the physical storefront for Pawsome3D figurines.
 * Digital PawPrints and Shopify merchandise live in their own public Store.
 *
 * Ordering itself is never client-authoritative. Every price, variant and
 * filament is resolved server-side; this page only collects intent and a
 * shipping address, then hands off to a Stripe checkout the server creates.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, Package, Printer, ShieldCheck, Truck } from "lucide-react";
import {
  createSlant3dCheckout,
  fetchFulfillmentReadiness,
  fetchModelLibrary,
  type ModelLibraryItem,
} from "../api";
import { UserProfile } from "../types";

interface ShippingAddress {
  name: string;
  email: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

interface Props {
  userProfile: UserProfile;
}

const PRINT_EXAMPLES = [
  { src: "/model-lab/3dashephardmod.png", alt: "Australian Shepherd collectible on an engraved base" },
  { src: "/model-lab/3dbetsy.png", alt: "Dalmatian puppy print on a Betsy name base" },
  { src: "/model-lab/3dbodhi.png", alt: "Small fluffy dog print on an engraved base" },
  { src: "/model-lab/3dgermanshepmod.png", alt: "German Shepherd figurine on a Fido name base" },
  { src: "/model-lab/3dgoldenmod.png", alt: "Golden doodle figurine on a Reggie name base" },
] as const;

/** Minimum viable shipping payload. Vendors reject partial addresses outright. */
function addressComplete(address: ShippingAddress): boolean {
  return Boolean(
    address.name.trim() && address.email.trim() && address.line1.trim()
    && address.city.trim() && address.state.trim() && address.zip.trim()
    && address.country.trim().length === 2,
  );
}

function SectionShell({ title, subtitle, icon, badge, children }: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  badge: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[1.75rem] border border-outline-variant/35 bg-surface/80 p-5 shadow-lg backdrop-blur-xl sm:p-7">
      <header className="mb-5 flex flex-wrap items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-black text-on-surface">{title}</h2>
          <p className="mt-1 text-sm text-on-surface-variant">{subtitle}</p>
        </div>
        {badge}
      </header>
      {children}
    </section>
  );
}

function StatusBadge({ available }: { available: boolean }) {
  return available ? (
    <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-[10px] font-black uppercase tracking-wide text-emerald-700">
      Shipping now
    </span>
  ) : (
    <span className="rounded-full bg-amber-500/15 px-3 py-1 text-[10px] font-black uppercase tracking-wide text-amber-700">
      Coming soon
    </span>
  );
}

function ComingSoonNotice({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs font-bold text-amber-700">
      {children}
    </p>
  );
}

export default function PrintShopScreen({ userProfile }: Props) {
  const [modelPrintingAvailable, setModelPrintingAvailable] = useState(false);

  const [models, setModels] = useState<ModelLibraryItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelLibraryError, setModelLibraryError] = useState("");
  const [modelLoadAttempt, setModelLoadAttempt] = useState(0);
  const [selectedModelId, setSelectedModelId] = useState<number | null>(null);
  const [targetHeightMm, setTargetHeightMm] = useState(120);

  const [shipping, setShipping] = useState<ShippingAddress>({
    name: userProfile.fullName || "",
    email: userProfile.email || "",
    line1: "",
    city: userProfile.city || "",
    state: "",
    zip: "",
    country: "US",
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    fetchFulfillmentReadiness()
      .then((readiness) => active && setModelPrintingAvailable(readiness.modelPrinting.available))
      .catch(() => active && setModelPrintingAvailable(false));

    // The model library is authenticated. A signed-out visitor still sees the
    // storefront and its pricing, just not their own printable models.
    if (userProfile.email) {
      setModelsLoading(true);
      setModelLibraryError("");
      fetchModelLibrary()
        .then((items) => {
          if (!active) return;
          const printable = items.filter((item) => item.rigged_model_url || item.model_url);
          setModels(printable);
          const requestedId = Number(new URLSearchParams(window.location.search).get("model"));
          setSelectedModelId((current) => requestedId > 0 && printable.some((item) => item.id === requestedId)
            ? requestedId
            : current ?? printable[0]?.id ?? null);
        })
        .catch((cause: any) => {
          if (!active) return;
          setModels([]);
          setModelLibraryError(cause?.message || "Your model library could not be loaded.");
        })
        .finally(() => active && setModelsLoading(false));
    } else {
      setModelsLoading(false);
    }

    return () => { active = false; };
  }, [userProfile.email, modelLoadAttempt]);

  const selectedModel = useMemo(
    () => models.find((item) => item.id === selectedModelId) || null,
    [models, selectedModelId],
  );

  const canOrderFigurine = Boolean(
    modelPrintingAvailable && selectedModel
    && selectedModel.source_type !== "marketplace_listing"
    && addressComplete(shipping) && !busy,
  );

  const beginFigurineCheckout = async () => {
    if (!selectedModel) return;
    setBusy(true);
    setError("");
    try {
      const result = await createSlant3dCheckout({
        sourceType: selectedModel.source_type as "creation" | "avatar" | "pet_glb_order",
        sourceId: selectedModel.id,
        targetHeightMm,
        recipient: {
          name: shipping.name.trim(),
          email: shipping.email.trim(),
          line1: shipping.line1.trim(),
          city: shipping.city.trim(),
          state: shipping.state.trim(),
          zip: shipping.zip.trim(),
          country: shipping.country.trim().toUpperCase(),
        },
      });
      window.location.assign(result.checkoutUrl);
    } catch (caught: any) {
      setError(caught?.message || "This model could not be prepared for printing.");
    } finally {
      setBusy(false);
    }
  };

  const addressField = (
    key: keyof ShippingAddress,
    placeholder: string,
    extra: { span?: boolean; maxLength?: number; type?: string; uppercase?: boolean } = {},
  ) => (
    <input
      aria-label={placeholder}
      type={extra.type || "text"}
      placeholder={placeholder}
      maxLength={extra.maxLength}
      value={shipping[key]}
      disabled={!modelPrintingAvailable}
      onChange={(event) => setShipping((current) => ({
        ...current,
        [key]: extra.uppercase ? event.target.value.toUpperCase() : event.target.value,
      }))}
      className={`${extra.span ? "col-span-2 " : ""}min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm disabled:opacity-50`}
    />
  );

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-28 pt-8">
      <header className="mb-8 max-w-2xl">
        <p className="text-xs font-black uppercase tracking-[.2em] text-primary">Print Shop</p>
        <h1 className="mt-2 text-3xl font-black text-on-surface">Order your pet as a physical keepsake</h1>
        <p className="mt-2 text-on-surface-variant">
          Full-colour 3D figurines, produced by our print partner and shipped to your door.
        </p>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs font-bold text-on-surface-variant">
          <span className="flex items-center gap-1.5"><ShieldCheck size={14} className="text-primary" /> Secure Stripe checkout</span>
          <span className="flex items-center gap-1.5"><Truck size={14} className="text-primary" /> Tracked delivery</span>
          <span className="flex items-center gap-1.5"><Package size={14} className="text-primary" /> Made to order</span>
        </div>
      </header>

      {error && <p className="mb-6 rounded-xl bg-error/10 p-3 text-sm font-bold text-error">{error}</p>}

      <div className="space-y-6">
        {/* ── Slant 3D: printed figurines ─────────────────────────────────── */}
        <SectionShell
          title="3D printed figurines"
          subtitle="Your pet's 3D model printed as a solid figurine and shipped to you."
          icon={<Package size={20} />}
          badge={<StatusBadge available={modelPrintingAvailable} />}
        >
          <div className="mb-6">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase tracking-[.16em] text-primary">Printed examples</p>
                <p className="mt-1 text-sm text-on-surface-variant">See how personalized pet models look as finished, shelf-ready keepsakes.</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {PRINT_EXAMPLES.map((example) => (
                <figure key={example.src} className="group aspect-square overflow-hidden rounded-2xl border border-outline-variant/35 bg-surface-container-low">
                  <img
                    src={example.src}
                    alt={example.alt}
                    loading="lazy"
                    className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                  />
                </figure>
              ))}
            </div>
          </div>

          {!userProfile.email ? (
            <p className="rounded-xl border border-outline-variant/40 bg-surface-container-low p-4 text-sm text-on-surface-variant">
              Sign in to choose one of your 3D pet models to print.
            </p>
          ) : modelsLoading ? (
            <p className="flex items-center gap-2 text-sm text-on-surface-variant">
              <Loader2 size={16} className="animate-spin" /> Loading your models…
            </p>
          ) : modelLibraryError ? (
            <div role="alert" className="rounded-xl border border-error/30 bg-error/10 p-4 text-sm text-error">
              <p className="font-bold">{modelLibraryError}</p>
              <button type="button" onClick={() => setModelLoadAttempt((value) => value + 1)} className="mt-3 min-h-10 rounded-xl border border-error/40 px-4 text-xs font-black">
                Retry model library
              </button>
            </div>
          ) : models.length === 0 ? (
            <p className="rounded-xl border border-outline-variant/40 bg-surface-container-low p-4 text-sm text-on-surface-variant">
              You don't have a finished 3D model yet. Create one and it will appear here ready to print.
            </p>
          ) : (
            <>
              <label className="text-xs font-black uppercase tracking-wide text-on-surface">Choose a model</label>
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                {models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => setSelectedModelId(model.id)}
                    className={`overflow-hidden rounded-2xl border text-left transition ${
                      selectedModelId === model.id
                        ? "border-primary ring-2 ring-primary/30"
                        : "border-outline-variant/40 hover:border-primary/50"
                    }`}
                  >
                    <div className="aspect-square bg-surface-container-low">
                      {model.image_url ? (
                        <img src={model.image_url} alt={model.name || "Pet model"} className="h-full w-full object-cover" />
                      ) : (
                        <span className="grid h-full w-full place-items-center text-3xl opacity-40">🐾</span>
                      )}
                    </div>
                    <p className="truncate p-2 text-xs font-black text-on-surface">{model.name || `Model #${model.id}`}</p>
                  </button>
                ))}
              </div>

              <div className="mt-5">
                <label className="text-xs font-black uppercase tracking-wide text-on-surface">Printed height</label>
                <div className="mt-2 flex items-center gap-3">
                  <input
                    type="range"
                    min="25"
                    max="300"
                    step="5"
                    value={targetHeightMm}
                    disabled={!modelPrintingAvailable}
                    onChange={(event) => setTargetHeightMm(Number(event.target.value))}
                    className="w-full"
                  />
                  <span className="w-20 text-right text-sm font-black text-primary">{targetHeightMm} mm</span>
                </div>
                <p className="mt-2 text-xs text-on-surface-variant">
                  Your source model is never altered. A separate, uniformly scaled STL is produced and validated, the print partner
                  returns production and delivery costs, and only then does a secure checkout open.
                </p>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                {addressField("name", "Full name", { span: true })}
                {addressField("email", "Email", { span: true, type: "email" })}
                {addressField("line1", "Street address", { span: true })}
                {addressField("city", "City")}
                {addressField("state", "State")}
                {addressField("zip", "Postal code")}
                {addressField("country", "Country", { maxLength: 2, uppercase: true })}
              </div>

              {!modelPrintingAvailable && (
                <ComingSoonNotice>
                  Figurine printing is being switched on shortly. Your models stay available to view and download in the meantime.
                </ComingSoonNotice>
              )}

              <button
                type="button"
                onClick={() => void beginFigurineCheckout()}
                disabled={!canOrderFigurine}
                className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-black text-on-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? <Loader2 size={17} className="animate-spin" /> : <Printer size={17} />}
                {busy
                  ? "Preparing & quoting…"
                  : !modelPrintingAvailable
                    ? "Figurine printing unavailable"
                    : "Price & secure checkout"}
              </button>

              {modelPrintingAvailable && !addressComplete(shipping) && (
                <p className="mt-2 text-center text-[11px] text-on-surface-variant">
                  Enter a complete shipping address to get your price.
                </p>
              )}
            </>
          )}
        </SectionShell>
      </div>

      <p className="mt-8 text-center text-[11px] text-on-surface-variant">
        Prices are confirmed at checkout and include production and delivery. Nothing enters production until payment is confirmed.
      </p>
    </main>
  );
}
