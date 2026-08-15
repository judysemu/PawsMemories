import React, { useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, Loader2, PackageOpen, PawPrint, RefreshCw, Sparkles } from "lucide-react";
import type { ShopifyStoreProduct } from "../../shared/shopifyStoreCatalog";
import { authedFetch } from "../api";

interface PawprintDownloadSummary {
  pawprintId: number;
  cleanDownloadUrl: string;
  composedDownloadUrl: string;
}

function money(amount: string, currencyCode: string): string {
  const value = Number(amount);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode }).format(Number.isFinite(value) ? value : 0);
  } catch {
    return `${currencyCode} ${Number.isFinite(value) ? value.toFixed(2) : amount}`;
  }
}

function productPrice(product: ShopifyStoreProduct): string {
  const min = money(product.minPrice, product.currencyCode);
  return product.minPrice === product.maxPrice ? min : `From ${min}`;
}

export default function Store() {
  const [products, setProducts] = useState<ShopifyStoreProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [pawprint, setPawprint] = useState<PawprintDownloadSummary | null>(null);
  const [pawprintLoading, setPawprintLoading] = useState(false);
  const [pawprintError, setPawprintError] = useState("");
  const [downloading, setDownloading] = useState<"clean" | "composed" | null>(null);

  const requestedPawprintId = useMemo(() => {
    const value = Number(new URLSearchParams(window.location.search).get("pawprint"));
    return Number.isInteger(value) && value > 0 ? value : null;
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setCatalogError("");
    fetch("/api/store/products")
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "The shop catalog could not be loaded.");
        return data;
      })
      .then((data) => active && setProducts(Array.isArray(data.products) ? data.products : []))
      .catch((error: any) => active && setCatalogError(error?.message || "The shop catalog could not be loaded."))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [reloadKey]);

  useEffect(() => {
    if (!requestedPawprintId) return;
    let active = true;
    setPawprintLoading(true);
    authedFetch(`/api/pawprints/${requestedPawprintId}`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in to download your completed PawPrint." : data.error || "Your completed PawPrint could not be loaded.");
        return data;
      })
      .then((data) => active && setPawprint(data as PawprintDownloadSummary))
      .catch((error: any) => active && setPawprintError(error?.message || "Your completed PawPrint could not be loaded."))
      .finally(() => active && setPawprintLoading(false));
    return () => { active = false; };
  }, [requestedPawprintId]);

  const downloadPawprint = async (kind: "clean" | "composed") => {
    if (!pawprint) return;
    setDownloading(kind);
    setPawprintError("");
    try {
      const url = kind === "clean" ? pawprint.cleanDownloadUrl : pawprint.composedDownloadUrl;
      const response = await authedFetch(url);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "The PawPrint download could not be prepared.");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `pawprint-${kind}-${pawprint.pawprintId}.${blob.type === "image/png" ? "png" : blob.type === "image/jpeg" ? "jpg" : "webp"}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (error: any) {
      setPawprintError(error?.message || "The PawPrint download could not be prepared.");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-8 sm:px-6" aria-labelledby="shop-title">
      <header className="overflow-hidden rounded-[2rem] border border-outline-variant/25 bg-gradient-to-br from-primary/15 via-surface-container to-secondary/10 px-5 py-8 text-center shadow-xl sm:px-8 sm:py-10">
        <span className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-[11px] font-black uppercase tracking-[.16em] text-primary"><PackageOpen size={13} /> Pawsome3D Shop</span>
        <h1 id="shop-title" className="mt-3 text-3xl font-black tracking-tight text-on-surface">Make something special with your pet</h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-on-surface-variant sm:text-base">Browse the latest products from our Shopify store. Products marked for PawPrint personalization open directly on Shopify, where you upload and position your finished image.</p>
      </header>

      {requestedPawprintId && (
        <section className="mt-6 rounded-3xl border border-emerald-600/30 bg-emerald-600/10 p-5 sm:p-6" aria-live="polite">
          <div className="flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-emerald-600/15 text-emerald-800 dark:text-emerald-300"><PawPrint size={23} /></span>
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-black text-on-surface">Your digital PawPrint is ready</h2>
              <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">Download both versions below. Then visit the direct Shopify product page to personalize an eligible product with your PawPrint.</p>
              {pawprintLoading && <p className="mt-4 flex items-center gap-2 text-sm font-bold text-on-surface-variant"><Loader2 size={16} className="animate-spin" /> Loading your downloads…</p>}
              {pawprint && (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <button type="button" onClick={() => void downloadPawprint("clean")} disabled={downloading !== null} className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-emerald-700/35 bg-surface px-4 font-black text-emerald-800 disabled:opacity-50 dark:text-emerald-300"><Download size={17} />{downloading === "clean" ? "Preparing…" : "Download clean image"}</button>
                  <button type="button" onClick={() => void downloadPawprint("composed")} disabled={downloading !== null} className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 font-black text-white disabled:opacity-50"><Download size={17} />{downloading === "composed" ? "Preparing…" : "Download layout + words"}</button>
                </div>
              )}
              {pawprintError && <p role="alert" className="mt-4 rounded-xl bg-error/10 p-3 text-sm font-bold text-error">{pawprintError}</p>}
            </div>
          </div>
        </section>
      )}

      <section className="mt-8" aria-labelledby="shop-products-title">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div><p className="text-xs font-black uppercase tracking-[.18em] text-primary">Daily Shopify catalog</p><h2 id="shop-products-title" className="mt-1 text-2xl font-black text-on-surface">Products</h2></div>
          {!loading && catalogError && <button type="button" onClick={() => setReloadKey((value) => value + 1)} className="flex min-h-11 items-center gap-2 rounded-xl border border-outline-variant px-4 text-sm font-black text-primary"><RefreshCw size={15} /> Retry</button>}
        </div>
        {loading ? (
          <div className="grid min-h-48 place-items-center rounded-3xl bg-surface-container-low"><p className="flex items-center gap-2 font-bold text-on-surface-variant"><Loader2 size={18} className="animate-spin" /> Loading products…</p></div>
        ) : catalogError ? (
          <p role="alert" className="rounded-3xl bg-error/10 p-6 text-center font-bold text-error">{catalogError}</p>
        ) : products.length === 0 ? (
          <div className="rounded-3xl border border-outline-variant/30 bg-surface p-8 text-center"><Sparkles className="mx-auto text-primary" /><h3 className="mt-3 font-black text-on-surface">The catalog is being refreshed</h3><p className="mt-2 text-sm text-on-surface-variant">Please check back after the next Shopify sync.</p></div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <article key={product.id} className="overflow-hidden rounded-3xl border border-outline-variant/25 bg-surface shadow-lg">
                <div className="aspect-square bg-surface-container-low">
                  {product.featuredImageUrl ? <img src={product.featuredImageUrl} alt={product.featuredImageAlt || product.title} className="h-full w-full object-cover" loading="lazy" /> : <div className="grid h-full place-items-center text-primary/50"><PawPrint size={52} /></div>}
                </div>
                <div className="p-5">
                  {product.pawprintPersonalizable && <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-primary"><PawPrint size={12} /> PawPrint personalizable</span>}
                  <h3 className="mt-3 text-lg font-black text-on-surface">{product.title}</h3>
                  {product.description && <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-on-surface-variant">{product.description}</p>}
                  <div className="mt-4 flex items-center justify-between gap-3"><span className="font-black text-on-surface">{productPrice(product)}</span><span className={`text-xs font-bold ${product.availableForSale ? "text-emerald-700 dark:text-emerald-300" : "text-on-surface-variant"}`}>{product.availableForSale ? "Available" : "Unavailable"}</span></div>
                  <a href={product.productUrl} target="_blank" rel="noopener noreferrer" className={`mt-4 flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 text-center text-sm font-black ${product.availableForSale ? "bg-primary text-on-primary" : "pointer-events-none bg-outline-variant/30 text-on-surface-variant"}`} aria-disabled={!product.availableForSale}>{product.pawprintPersonalizable ? "Personalize with your PawPrint" : "View on Shopify"}<ExternalLink size={15} /></a>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
