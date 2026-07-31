import React, { useEffect, useMemo, useState } from "react";
import type { Creation, UserProfile, VoiceCloneAsset } from "../types";
import { Download, Eye, FileImage, Film, HardDrive, PackageOpen, PawPrint, Printer, RefreshCw, ShieldAlert, ShieldCheck, Volume2, X, Loader2 } from "lucide-react";
import StorageMeter from "./StorageMeter";
import PetModelViewer from "./PetModelViewer";
import { createSlant3dCheckout, createMarketplacePrintCheckout, fetchFulfillmentReadiness, fetchModelLibrary, fetchModelPrintOrders, fetchPawprintPrintOrders, listVoiceCloneAssets, fetchUserEntitlements, fetchDigitalOrderStatus, downloadDigitalListing, fetchCustomizeOrders, type ModelLibraryItem, type ModelPrintOrder, type PawprintPrintOrder, type CustomizeOrder } from "../api";

const FurBinV5Experience = React.lazy(() => import("./fur-bin-v5"));

interface FurBinScreenProps {
  userProfile: UserProfile;
  creations: Creation[];
  onOpenCreditStore: () => void;
}

type BinFilter = "all" | "images" | "videos" | "models" | "pawprints";

function outputType(creation: Creation): Exclude<BinFilter, "all"> {
  if (creation.video_url) return "videos";
  if (creation.media_type === "model") return "models"; // Explicitly respect media_type
  if (creation.model_url) return "models";
  if (creation.preset_name?.toLowerCase() === "pawprint") return "pawprints";
  return "images";
}

function outputUrl(creation: Creation) {
  return creation.video_url || creation.model_url || creation.image_url || "";
}

export function legacyCreationIsRepresented(
  creation: Pick<Creation, "id">,
  models: Array<Pick<ModelLibraryItem, "id" | "source_type">>,
): boolean {
  return models.some((model) =>
    model.source_type === "creation" && Number(model.id) === Number(creation.id));
}

export default function FurBinScreen(props: FurBinScreenProps) {
  if (import.meta.env.VITE_FUR_BIN_V5_ENABLED === "true") {
    return <React.Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-on-surface-variant"><Loader2 className="animate-spin" aria-label="Loading Fur Bin" /></div>}><FurBinV5Experience /></React.Suspense>;
  }

  return <LegacyFurBinScreen {...props} />;
}

function LegacyFurBinScreen({ creations, userProfile, onOpenCreditStore }: FurBinScreenProps) {
  const [voiceAssets, setVoiceAssets] = useState<VoiceCloneAsset[]>([]);
  const [filter, setFilter] = useState<BinFilter>("all");
  const [models, setModels] = useState<ModelLibraryItem[]>([]);
  const [printOrders, setPrintOrders] = useState<ModelPrintOrder[]>([]);
  const [pawprintPrintOrders, setPawprintPrintOrders] = useState<PawprintPrintOrder[]>([]);
  const [customOrders, setCustomOrders] = useState<CustomizeOrder[]>([]);
  const [marketplaceModels, setMarketplaceModels] = useState<any[]>([]);
  
  const [selectedModel, setSelectedModel] = useState<ModelLibraryItem | null>(null);
  const [targetHeightMm, setTargetHeightMm] = useState(100);
  const [printBusy, setPrintBusy] = useState(false);
  const [printError, setPrintError] = useState("");
  const [modelPrintingAvailable, setModelPrintingAvailable] = useState(false);
  
  const [pollingOrder, setPollingOrder] = useState<{ id: string, status: string } | null>(null);
  const [downloadingListing, setDownloadingListing] = useState<string | null>(null);
  const [preparingViewerForListing, setPreparingViewerForListing] = useState<string | null>(null);

  const [printRecipient, setPrintRecipient] = useState({
    name: userProfile.fullName || "",
    email: userProfile.email || "",
    line1: "",
    line2: "",
    city: userProfile.city || "",
    state: "",
    zip: userProfile.zip || "",
    country: "US",
  });

  useEffect(() => {
    listVoiceCloneAssets().then(setVoiceAssets).catch(() => setVoiceAssets([]));
    let active = true;
    
    // Polling for new checkout
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get("order_id");
    let pollTimer: number | null = null;
    
    if (params.get("digital_success") === "true" && orderId) {
      setPollingOrder({ id: orderId, status: "processing" });
      pollTimer = window.setInterval(() => {
        fetchDigitalOrderStatus(orderId).then(res => {
          if (res.status === 'paid' && active) {
            setPollingOrder({ id: orderId, status: "paid" });
            fetchUserEntitlements().then(items => setMarketplaceModels(items)).catch(() => {});
            if (pollTimer) window.clearInterval(pollTimer);
          }
        }).catch(() => {});
      }, 3000);
    }

    const refresh = () => {
      fetchModelLibrary().then((items) => active && setModels(items)).catch(() => {});
      fetchModelPrintOrders().then((items) => active && setPrintOrders(items)).catch(() => {});
      fetchPawprintPrintOrders().then((items) => active && setPawprintPrintOrders(items)).catch(() => {});
      fetchCustomizeOrders().then((items) => active && setCustomOrders(items)).catch(() => {});
      fetchUserEntitlements().then((items) => active && setMarketplaceModels(items)).catch(() => {});
      fetchFulfillmentReadiness().then((readiness) => active && setModelPrintingAvailable(readiness.modelPrinting.available)).catch(() => active && setModelPrintingAvailable(false));
    };
    refresh();
    
    const timer = window.setInterval(refresh, 15_000);
    return () => { 
      active = false; 
      window.clearInterval(timer);
      if (pollTimer) window.clearInterval(pollTimer);
    };
  }, []);

  const visible = useMemo(() => [...creations]
    .filter((creation) => outputType(creation) !== "models" || !legacyCreationIsRepresented(creation, models))
    .filter((creation) => filter === "all" || outputType(creation) === filter)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()), [creations, filter, models]);

  const beginPrint = async () => {
    if (!selectedModel) return;
    setPrintBusy(true);
    setPrintError("");
    try {
      if (selectedModel.source_type === "marketplace_listing" && selectedModel.listing_uuid) {
        const result = await createMarketplacePrintCheckout({
          listingUuid: selectedModel.listing_uuid,
          targetHeightMm,
          recipient: printRecipient,
        });
        window.location.assign(result.checkoutUrl);
      } else {
        const result = await createSlant3dCheckout({
          sourceType: selectedModel.source_type as "creation" | "avatar",
          sourceId: selectedModel.id,
          targetHeightMm,
          recipient: printRecipient,
        });
        window.location.assign(result.checkoutUrl);
      }
    } catch (err: any) {
      setPrintError(err?.message || "Could not prepare this model for printing.");
    } finally {
      setPrintBusy(false);
    }
  };

  const handleDownloadMarketplaceModel = async (uuid: string) => {
    setDownloadingListing(uuid);
    try {
      const res = await downloadDigitalListing(uuid);
      window.location.assign(res.url);
    } catch (err) {
      console.error("Download failed:", err);
      alert("Download failed. Please try again later.");
    } finally {
      setDownloadingListing(null);
    }
  };

  const handlePrintMarketplaceModel = async (m: any) => {
    setPreparingViewerForListing(m.listing_uuid);
    setPrintError("");
    try {
      const res = await downloadDigitalListing(m.listing_uuid);
      setSelectedModel({
        id: m.entitlement_id,
        source_type: "marketplace_listing",
        listing_uuid: m.listing_uuid,
        name: m.name,
        breed: null,
        image_url: m.preview_url,
        model_url: res.url,
        rigged_model_url: res.url,
        status: "complete",
        created_at: new Date().toISOString(),
      });
      setTargetHeightMm(100);
    } catch (err: any) {
      console.error("View failed:", err);
      alert("Could not load this model for printing.");
    } finally {
      setPreparingViewerForListing(null);
    }
  };

  const groups = useMemo(() => {
    const grouped = new Map<string, Creation[]>();
    for (const item of visible) {
      const key = filter === "all" ? outputType(item) : filter;
      const list = grouped.get(key) || [];
      list.push(item);
      grouped.set(key, list);
    }
    return [...grouped.entries()];
  }, [filter, visible]);

  return (
    <main className="mx-auto w-full max-w-7xl px-4 pb-28 pt-7 sm:px-6">
      <div className="flex flex-col gap-4 rounded-[2rem] border border-outline-variant/35 bg-surface/90 p-5 shadow-xl backdrop-blur-xl sm:flex-row sm:items-end sm:justify-between sm:p-7">
        <div><div className="flex items-center gap-2 text-primary"><HardDrive size={18} /><span className="text-xs font-black uppercase tracking-[.18em]">Your library</span></div><h1 data-tour="furbin-title" className="mt-2 text-3xl font-black tracking-tight text-on-surface sm:text-4xl">Fur Bin</h1><p className="mt-2 max-w-xl text-sm text-on-surface-variant">Your FurBin keeps every image, video, model, Pawprint, and voice file in one place.</p></div>
        {/* Storage moved into the header as a compact health widget. It was a
            full-width panel between the title and the content, which on a phone
            pushed the actual library — the reason anyone opens this page —
            below the fold. The "Show me how" tour button lived here too and is
            gone; Randy still offers the tour from the chat widget. */}
        <StorageMeter variant="health" />
      </div>

      {/* Models first: they are the highest-value artefacts in the bin, so they
          lead rather than sitting under the filter chips. */}
      {(filter === "all" || filter === "models") && marketplaceModels.length > 0 && <section className="mt-7">
        <div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-black uppercase tracking-[.16em] text-on-surface">Marketplace models</h2><span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-black text-primary">{marketplaceModels.length}</span></div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
          {marketplaceModels.map((m) => (
             <article key={m.entitlement_id} className="overflow-hidden rounded-[1.6rem] border border-white/30 bg-surface/75 shadow-xl backdrop-blur-2xl">
                <div className="aspect-square bg-surface-container-highest relative">
                  <img src={m.preview_url || "https://placehold.co/400"} alt={m.name} className="h-full w-full object-cover" />
                </div>
                <div className="p-4">
                  <h3 className="truncate text-sm font-black text-on-surface">{m.name}</h3>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => handleDownloadMarketplaceModel(m.listing_uuid)}
                      disabled={downloadingListing === m.listing_uuid}
                      className="inline-flex min-h-10 w-full items-center justify-center gap-1 rounded-xl bg-primary px-2 text-xs font-black text-on-primary disabled:opacity-50"
                    >
                      {downloadingListing === m.listing_uuid ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                      {downloadingListing === m.listing_uuid ? "Getting..." : "GLB"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePrintMarketplaceModel(m)}
                      disabled={preparingViewerForListing === m.listing_uuid}
                      className="inline-flex min-h-10 w-full items-center justify-center gap-1 rounded-xl border border-primary/30 px-2 text-xs font-black text-primary disabled:opacity-50"
                    >
                      {preparingViewerForListing === m.listing_uuid ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
                      Print
                    </button>
                  </div>
                </div>
             </article>
          ))}
       </div>
      </section>}

      {(filter === "all" || filter === "models") && <section className="mt-7">
        <div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-black uppercase tracking-[.16em] text-on-surface">Custom 3D models</h2><span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-black text-primary">{models.length}</span></div>
        {models.length === 0 ? <div className="rounded-[2rem] border border-dashed border-outline-variant/50 bg-surface/80 p-10 text-center text-sm text-on-surface-variant">No completed 3D models yet. Building models will appear here automatically.</div> : <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {models.map((model) => { const modelUrl = model.rigged_model_url || model.model_url || ""; return <article key={`${model.source_type}-${model.id}`} className="overflow-hidden rounded-[1.6rem] border border-white/30 bg-surface/75 shadow-xl backdrop-blur-2xl"><div className="h-64 bg-gradient-to-br from-primary/10 via-surface to-secondary/10"><PetModelViewer src={modelUrl} poster={model.image_url || undefined} alt={model.name || "Your 3D model"} className="h-full w-full" /></div><div className="p-4"><h3 className="truncate text-sm font-black text-on-surface">{model.name || "3D model"}</h3><p className="mt-1 text-xs text-on-surface-variant">{model.breed || "Custom model"} · {new Date(model.created_at).toLocaleDateString()}</p><div className="mt-4 grid grid-cols-3 gap-2"><button type="button" onClick={() => setSelectedModel(model)} className="inline-flex min-h-10 items-center justify-center gap-1 rounded-xl bg-primary text-xs font-black text-on-primary"><Eye size={14} /> Open</button><a href={modelUrl} download className="inline-flex min-h-10 items-center justify-center gap-1 rounded-xl border border-primary/30 text-xs font-black text-primary"><Download size={14} /> GLB</a><button type="button" onClick={() => setSelectedModel(model)} className="inline-flex min-h-10 items-center justify-center gap-1 rounded-xl border border-primary/30 text-xs font-black text-primary"><Printer size={14} /> Print</button></div></div></article>; })}
        </div>}
      </section>}

      <div className="mt-7 flex flex-wrap gap-2" role="tablist" aria-label="FurBin output type">
        {(["all", "images", "videos", "models", "pawprints"] as BinFilter[]).map((item) => <button key={item} type="button" role="tab" aria-selected={filter === item} onClick={() => setFilter(item)} className={`min-h-10 rounded-full px-4 text-xs font-black capitalize transition ${filter === item ? "bg-primary text-on-primary" : "border border-outline-variant/45 bg-surface/80 text-on-surface-variant hover:text-primary"}`}>{item === "all" ? "All outputs" : item}</button>)}
      </div>
      
      {pollingOrder && pollingOrder.status === 'processing' && (
        <div className="mt-6 flex items-center justify-center gap-3 rounded-[2rem] border border-primary/30 bg-primary/10 p-6 text-primary">
          <Loader2 className="animate-spin" size={24} />
          <div>
            <p className="text-sm font-black">Processing your purchase...</p>
            <p className="text-xs opacity-80">This usually takes a few seconds.</p>
          </div>
        </div>
      )}

      {(filter === "all" || filter === "models") && printOrders.length > 0 && <section className="mt-7">
        <div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-black uppercase tracking-[.16em] text-on-surface">3D print orders</h2><span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-black text-primary">{printOrders.length}</span></div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{printOrders.map((order) => <article key={order.id} className="rounded-[1.5rem] border border-white/30 bg-surface/75 p-4 shadow-lg backdrop-blur-2xl"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black text-on-surface">Slant 3D order #{order.id}</p><p className="mt-1 text-[11px] text-on-surface-variant">{Number(order.target_height_mm)} mm figurine · {new Date(order.created_at).toLocaleDateString()}</p></div><span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-black uppercase text-primary">{order.status.replaceAll("_", " ")}</span></div>{order.retail_price_cents ? <p className="mt-3 text-sm font-black text-on-surface">${(order.retail_price_cents / 100).toFixed(2)}</p> : null}{order.status === "awaiting_payment" && order.checkout_url && <a href={order.checkout_url} className="mt-3 inline-flex min-h-10 items-center justify-center rounded-xl bg-primary px-4 text-xs font-black text-on-primary">Resume secure checkout</a>}{order.tracking?.map((shipment, index) => <div key={`${shipment.trackingNumber || shipment.trackingUrl}-${index}`} className="mt-3 rounded-xl bg-primary/10 p-3 text-xs"><p className="font-black text-on-surface">{shipment.carrier || "Shipment"}{shipment.service ? ` · ${shipment.service}` : ""}</p>{shipment.trackingNumber && <p className="mt-1 text-on-surface-variant">Tracking: {shipment.trackingNumber}</p>}{shipment.trackingUrl && <a href={shipment.trackingUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex font-black text-primary">Track shipment</a>}</div>)}<p className="mt-3 text-[10px] text-on-surface-variant">Provider reference: {order.provider_pack_id || "pending"}</p></article>)}</div>
      </section>}

      {(filter === "all" || filter === "pawprints") && pawprintPrintOrders.length > 0 && <section className="mt-7">
        <div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-black uppercase tracking-[.16em] text-on-surface">Pawprint print orders</h2><span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-black text-primary">{pawprintPrintOrders.length}</span></div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{pawprintPrintOrders.map((order) => <article key={order.id} className="rounded-[1.5rem] border border-white/30 bg-surface/75 p-4 shadow-lg backdrop-blur-2xl"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black text-on-surface">Printful order #{order.id}</p><p className="mt-1 text-[11px] text-on-surface-variant">{order.product_code.replaceAll("-", " ")} · Qty {order.quantity} · {new Date(order.created_at).toLocaleDateString()}</p></div><span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-black uppercase text-primary">{order.status.replaceAll("_", " ")}</span></div>{order.retail_price_cents ? <p className="mt-3 text-sm font-black text-on-surface">${(order.retail_price_cents / 100).toFixed(2)}</p> : null}<div className="mt-3 flex flex-wrap gap-2">{order.status === "awaiting_payment" && order.checkout_url && <a href={order.checkout_url} className="inline-flex min-h-10 items-center justify-center rounded-xl bg-primary px-4 text-xs font-black text-on-primary">Resume secure checkout</a>}<a href={order.print_file_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center justify-center rounded-xl border border-primary/30 px-4 text-xs font-black text-primary">Print file</a></div>{order.tracking?.map((shipment, index) => <div key={`${shipment.trackingNumber || shipment.trackingUrl}-${index}`} className="mt-3 rounded-xl bg-primary/10 p-3 text-xs"><p className="font-black text-on-surface">{shipment.carrier || "Shipment"}{shipment.service ? ` · ${shipment.service}` : ""}</p>{shipment.trackingNumber && <p className="mt-1 text-on-surface-variant">Tracking: {shipment.trackingNumber}</p>}{shipment.trackingUrl && <a href={shipment.trackingUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex font-black text-primary">Track shipment</a>}</div>)}<p className="mt-3 text-[10px] text-on-surface-variant">Provider reference: {order.provider_order_id || "pending"}</p></article>)}</div>
      </section>}

      {customOrders.length > 0 && <section className="mt-7">
        <div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-black uppercase tracking-[.16em] text-on-surface">Custom gear & print orders</h2><span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-black text-primary">{customOrders.length}</span></div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{customOrders.map((order) => <article key={order.id} className="rounded-[1.5rem] border border-white/30 bg-surface/75 p-4 shadow-lg backdrop-blur-2xl"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black text-on-surface">Order #{order.id}</p><p className="mt-1 text-[11px] text-on-surface-variant">Custom Print · {new Date(order.created_at).toLocaleDateString()}</p></div><span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-black uppercase text-primary">{order.status.replaceAll("_", " ")}</span></div>{order.retail_price_cents ? <p className="mt-3 text-sm font-black text-on-surface">${(order.retail_price_cents / 100).toFixed(2)}</p> : null}<div className="mt-3 flex flex-wrap gap-2">{order.status === "awaiting_payment" && order.checkout_url && <a href={order.checkout_url} className="inline-flex min-h-10 items-center justify-center rounded-xl bg-primary px-4 text-xs font-black text-on-primary">Resume secure checkout</a>}{order.print_file_url && <a href={order.print_file_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center justify-center rounded-xl border border-primary/30 px-4 text-xs font-black text-primary">Print file</a>}</div><p className="mt-3 text-[10px] text-on-surface-variant">Order status: {order.status}</p></article>)}</div>
      </section>}

      {(filter !== "models" || models.length === 0) && (visible.length === 0 ? <div className="mt-6 rounded-[2rem] border border-dashed border-outline-variant/50 bg-surface/80 p-12 text-center text-sm text-on-surface-variant">Your FurBin is empty for this output type.</div> : (
        <div className="mt-7 space-y-8">
          {groups.map(([kind, items]) => <section key={kind}><div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-black uppercase tracking-[.16em] text-on-surface">{kind}</h2><span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-black text-primary">{items.length}</span></div><div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
            {items.map((creation) => { const url = outputUrl(creation); const type = outputType(creation); const isPendingModel = type === "models" && !creation.model_url; return <article key={creation.id} className="group overflow-hidden rounded-[1.6rem] border border-white/30 bg-surface/75 shadow-xl backdrop-blur-2xl transition hover:-translate-y-1 hover:border-primary/50"><div className="relative aspect-[3/4] overflow-hidden bg-surface-container-highest">{type === "videos" ? <video src={url} controls playsInline preload="metadata" className="h-full w-full bg-black object-cover" /> : isPendingModel ? <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-variant text-on-surface-variant"><RefreshCw size={34} className="animate-spin text-primary" /><span className="px-3 text-center text-xs font-black">Building</span><img src={creation.image_url || ""} className="absolute inset-0 w-full h-full object-cover opacity-20 mix-blend-luminosity" /></div> : type === "models" ? <div className="flex h-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-primary/20 via-surface to-secondary/15 text-primary"><PackageOpen size={34} /><span className="px-3 text-center text-xs font-black">3D model</span></div> : url ? <img src={url} alt={creation.pet_name || type} className="h-full w-full object-cover transition group-hover:scale-105" referrerPolicy="no-referrer" /> : <div className="flex h-full items-center justify-center"><FileImage size={28} /></div>}<span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/65 px-2 py-1 text-[10px] font-black capitalize text-white">{type === "videos" ? <Film size={12} /> : type === "models" ? <PackageOpen size={12} /> : type === "pawprints" ? <PawPrint size={12} /> : <FileImage size={12} />}{type}</span></div><div className="flex items-center gap-2 p-3"><div className="min-w-0 flex-1"><h3 className="truncate text-xs font-black text-on-surface">{creation.pet_name || (type === "pawprints" ? "Pawprint" : isPendingModel ? "Building Model..." : "Saved output")}</h3><p className="mt-1 text-[10px] text-on-surface-variant">{new Date(creation.created_at).toLocaleDateString()}</p></div>{url && !isPendingModel && <a href={url} download className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary hover:bg-primary hover:text-on-primary" aria-label="Download from FurBin"><Download size={14} /></a>}</div></article>; })}
          </div></section>)}
        </div>
      ))}

      <section className="mt-9 rounded-[2rem] border border-outline-variant/35 bg-surface/75 p-5 shadow-xl backdrop-blur-xl"><div className="mb-4 flex items-center gap-2"><Volume2 size={17} className="text-primary" /><h2 className="text-sm font-black uppercase tracking-[.16em] text-on-surface">Voice files</h2></div>{voiceAssets.length === 0 ? <p className="text-sm text-on-surface-variant">No voice files saved.</p> : <div className="space-y-2">{voiceAssets.map((asset) => <div key={asset.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface-container p-3"><div className="min-w-0"><div className="truncate text-sm font-bold text-on-surface">{asset.name}</div><div className="text-[11px] text-on-surface-variant">{Math.max(1, Math.round(asset.bytes / 1024))} KB · {asset.mime_type}</div></div><span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-black ${asset.voice_consent ? "bg-emerald-600/15 text-emerald-700" : "bg-error/10 text-error"}`}>{asset.voice_consent ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}{asset.voice_consent ? "Consent saved" : "Missing consent"}</span></div>)}</div>}</section>
      <p className="mt-5 text-center text-xs text-on-surface-variant">Storage stays bounded by your current FurBin allowance. Add paid storage only when you need more space.</p>

      {selectedModel && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="3D model viewer"><div className="max-h-[92vh] w-full max-w-4xl overflow-auto rounded-[2rem] border border-white/30 bg-surface/95 p-5 shadow-2xl backdrop-blur-2xl"><div className="flex items-center justify-between gap-3"><div><h2 className="text-xl font-black text-on-surface">{selectedModel.name || "3D model"}</h2><p className="text-xs text-on-surface-variant">Backblaze model · interactive viewer</p></div><button type="button" onClick={() => { setSelectedModel(null); setPrintError(""); }} className="grid h-10 w-10 place-items-center rounded-full border border-outline-variant/40"><X size={18} /></button></div><div className="mt-4 h-[52vh] min-h-[360px] overflow-hidden rounded-2xl bg-surface-container-highest">{/* thumbnail={false}: the detail modal is the one place a live viewer is
    safe on mobile, because exactly one WebGL context exists at a time. */}
<PetModelViewer src={selectedModel.rigged_model_url || selectedModel.model_url || ""} poster={selectedModel.image_url || undefined} thumbnail={false} className="h-full w-full" /></div><div className="mt-5 grid gap-4 rounded-2xl border border-outline-variant/35 bg-surface-container p-4 md:grid-cols-[1fr_auto]"><div><label className="text-xs font-black uppercase tracking-wide text-on-surface">Printed height</label><div className="mt-2 flex items-center gap-3"><input type="range" min="25" max="300" step="5" value={targetHeightMm} onChange={(event) => setTargetHeightMm(Number(event.target.value))} className="w-full" disabled={!modelPrintingAvailable} /><span className="w-20 text-right text-sm font-black text-primary">{targetHeightMm} mm</span></div><p className="mt-2 text-xs text-on-surface-variant">Your source GLB remains unchanged. Pawsome3D creates a separate, uniformly scaled STL, validates the mesh, obtains Slant 3D production and delivery costs, then opens a secure Stripe checkout.</p>{!modelPrintingAvailable && <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs font-bold text-amber-700">Physical model printing is being configured. Your model remains available to view and download.</p>}<div className="mt-4 grid grid-cols-2 gap-2"><input aria-label="Shipping name" placeholder="Full name" value={printRecipient.name} onChange={(event) => setPrintRecipient((current) => ({ ...current, name: event.target.value }))} className="col-span-2 min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" disabled={!modelPrintingAvailable} /><input aria-label="Shipping email" type="email" placeholder="Email" value={printRecipient.email} onChange={(event) => setPrintRecipient((current) => ({ ...current, email: event.target.value }))} className="col-span-2 min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" disabled={!modelPrintingAvailable} /><input aria-label="Shipping street address" placeholder="Street address" value={printRecipient.line1} onChange={(event) => setPrintRecipient((current) => ({ ...current, line1: event.target.value }))} className="col-span-2 min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" disabled={!modelPrintingAvailable} /><input aria-label="Shipping city" placeholder="City" value={printRecipient.city} onChange={(event) => setPrintRecipient((current) => ({ ...current, city: event.target.value }))} className="min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" disabled={!modelPrintingAvailable} /><input aria-label="Shipping state" placeholder="State" value={printRecipient.state} onChange={(event) => setPrintRecipient((current) => ({ ...current, state: event.target.value }))} className="min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" disabled={!modelPrintingAvailable} /><input aria-label="Shipping postal code" placeholder="Postal code" value={printRecipient.zip} onChange={(event) => setPrintRecipient((current) => ({ ...current, zip: event.target.value }))} className="min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" disabled={!modelPrintingAvailable} /><input aria-label="Shipping country" placeholder="Country" maxLength={2} value={printRecipient.country} onChange={(event) => setPrintRecipient((current) => ({ ...current, country: event.target.value.toUpperCase() }))} className="min-h-11 rounded-xl border border-outline-variant bg-surface px-3 text-sm" disabled={!modelPrintingAvailable} /></div>{printError && <p className="mt-2 text-sm font-bold text-error">{printError}</p>}</div><div className="flex flex-col gap-2"><a href={selectedModel.rigged_model_url || selectedModel.model_url || ""} download className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-primary/30 px-4 text-sm font-black text-primary"><Download size={16} /> Download GLB</a><button type="button" onClick={beginPrint} disabled={printBusy || !modelPrintingAvailable} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-black text-on-primary disabled:cursor-not-allowed disabled:opacity-50"><Printer size={16} /> {printBusy ? "Preparing & quoting…" : modelPrintingAvailable ? "Price & checkout" : "Printing unavailable"}</button></div></div></div></div>}
    </main>
  );
}
