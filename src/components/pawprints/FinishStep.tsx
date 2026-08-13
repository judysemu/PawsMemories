import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronLeft, Download, ImagePlus, LayoutGrid, Loader2, PawPrint, Printer, Sparkles, Type, X } from "lucide-react";
import type { PublicUser, UserProfile } from "../../types";
import { authedFetch, createPawprintShopifyCheckout } from "../../api";
import { CREDIT_PRICES } from "../../pricing";
import { MAX_PAWPRINT_PHOTOS } from "../../pawprints/collageEngine";
import {
  FULL_PRINT_WIDTH, FULL_PRINT_HEIGHT, PREVIEW_WIDTH, PREVIEW_HEIGHT, PREVIEW_DEBOUNCE_MS,
  TITLE_MAX_LENGTH, MESSAGE_MAX_LENGTH, VARIATIONS, VariationPreview, renderPawprint, urlToDataUrl,
  type StudioPhoto, type Variation,
} from "../../pawprints/renderPawprint";
import type { PawprintPrintProduct } from "../../../shared/pawprintCatalog2";
import type { PawprintEntryMode } from "./EntryStep";

interface FinishStepProps {
  entry: PawprintEntryMode;
  categoryId: string;
  optionId: string;
  categoryLabel: string;
  shopifyProduct: PawprintPrintProduct | null;
  customPrompt: string;
  customized: boolean;
  photos: StudioPhoto[];
  onPhotosChange: (photos: StudioPhoto[]) => void;
  userProfile: UserProfile;
  onOpenCreditStore: () => void;
  onUserUpdate: (user: PublicUser) => void;
  onCreationSaved?: () => Promise<void> | void;
  onBack: () => void;
}

export function FinishStep({
  entry, categoryId, optionId, categoryLabel, shopifyProduct, customPrompt, customized,
  photos, onPhotosChange, userProfile, onOpenCreditStore, onUserUpdate, onCreationSaved, onBack,
}: FinishStepProps) {
  const [title, setTitle] = useState(categoryLabel);
  const [message, setMessage] = useState("Made with love.");
  const [variation, setVariation] = useState<Variation>("classic");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [savedCreationId, setSavedCreationId] = useState<number | null>(null);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [printBusy, setPrintBusy] = useState(false);
  const [printCheckoutError, setPrintCheckoutError] = useState("");
  const [signInNoticeDismissed, setSignInNoticeDismissed] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const variationsSectionRef = useRef<HTMLElement | null>(null);

  // Stage 1: one cached AI subject-art generation per (theme/prompt, photo
  // set). Fired once when entering Finish (or when the underlying identity
  // changes) — never per keystroke. Stage 2 (below) always composites from
  // this same cached result, so Live Preview and Save can never diverge.
  const [subjectArtUrl, setSubjectArtUrl] = useState("");
  const [subjectArtDataUrl, setSubjectArtDataUrl] = useState("");
  const [subjectArtLoading, setSubjectArtLoading] = useState(true);
  const [subjectArtError, setSubjectArtError] = useState("");
  const subjectArtRequestRef = useRef(0);
  const photoIdentity = useMemo(() => photos.map((p) => p.id).join(","), [photos]);

  useEffect(() => {
    if (photos.length === 0) return;
    const requestId = subjectArtRequestRef.current + 1;
    subjectArtRequestRef.current = requestId;
    setSubjectArtLoading(true);
    setSubjectArtError("");
    (async () => {
      try {
        const response = await authedFetch("/api/pawprints/generate-subject", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entryMode: entry,
            categoryId,
            optionId,
            shopifyProductId: shopifyProduct?.shopifyProductId || "",
            customPrompt,
            photoBase64List: photos.map((p) => p.dataUrl),
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "The Pawprint art could not be generated.");
        if (subjectArtRequestRef.current !== requestId) return;
        const dataUrl = await urlToDataUrl(data.imageUrl);
        if (subjectArtRequestRef.current !== requestId) return;
        setSubjectArtUrl(data.imageUrl);
        setSubjectArtDataUrl(dataUrl);
      } catch (caught: any) {
        if (subjectArtRequestRef.current !== requestId) return;
        setSubjectArtError(caught?.message || "The Pawprint art could not be generated.");
      } finally {
        if (subjectArtRequestRef.current === requestId) setSubjectArtLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, [entry, categoryId, optionId, shopifyProduct?.shopifyProductId, customPrompt, photoIdentity]);

  // Stage 2 composite: the generated subject art fills the hero slot; any
  // additional uploaded photos fill supporting slots on multi-photo layouts
  // (filmstrip, mosaic, story, etc.).
  const compositePhotos: StudioPhoto[] = useMemo(() => {
    if (!subjectArtDataUrl) return [];
    return [{ id: "subject-art", name: "Pawprint Art", dataUrl: subjectArtDataUrl, width: 0, height: 0 }, ...photos];
  }, [subjectArtDataUrl, photos]);

  const [previewUrl, setPreviewUrl] = useState("");
  const [previewRendering, setPreviewRendering] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const previewRequestRef = useRef(0);

  useEffect(() => {
    if (compositePhotos.length === 0) return;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setPreviewRendering(true);
    const timer = window.setTimeout(() => {
      renderPawprint({
        variation, photos: compositePhotos, title: title.trim() || categoryLabel, message: message.trim(), category: categoryId,
        width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, quality: 0.82,
      }).then((dataUrl) => {
        if (previewRequestRef.current !== requestId) return;
        setPreviewUrl(dataUrl);
        setPreviewError("");
      }).catch((caught: any) => {
        if (previewRequestRef.current !== requestId) return;
        setPreviewError(caught?.message || "The preview could not be drawn.");
      }).finally(() => {
        if (previewRequestRef.current === requestId) setPreviewRendering(false);
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [variation, compositePhotos, title, message, categoryId, categoryLabel]);

  const designSignature = useMemo(() => JSON.stringify([subjectArtUrl, variation, title, message, photos.map((p) => p.id)]), [subjectArtUrl, variation, title, message, photos]);
  const liveDesignSignatureRef = useRef(designSignature);
  liveDesignSignatureRef.current = designSignature;

  const pawprintCost = (entry === "print" ? CREDIT_PRICES.PAWPRINT_PRINT : CREDIT_PRICES.PAWPRINT_DIGITAL)
    + (customized ? CREDIT_PRICES.PAWPRINT_CUSTOMIZE_ADDON : 0);
  const creditsShort = !userProfile.isAdmin && userProfile.credits < pawprintCost;
  const creditsNeeded = Math.max(0, pawprintCost - userProfile.credits);

  const choosePhotos = async (files: File[]) => {
    setError("");
    const remaining = MAX_PAWPRINT_PHOTOS - photos.length;
    if (remaining < 1) return setError(`A Pawprint can contain up to ${MAX_PAWPRINT_PHOTOS} photos.`);
    const { preparePhoto } = await import("../../pawprints/renderPawprint");
    try {
      const prepared: StudioPhoto[] = [];
      for (const file of files.slice(0, remaining)) prepared.push(await preparePhoto(file));
      onPhotosChange([...photos, ...prepared]);
      setResultUrl("");
    } catch (caught: any) {
      setError(caught.message || "The photo could not be opened.");
    }
  };

  const movePhoto = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= photos.length) return;
    const next = [...photos];
    [next[index], next[target]] = [next[target], next[index]];
    onPhotosChange(next);
  };

  const save = async () => {
    if (!subjectArtDataUrl) return;
    const submittedDesignSignature = designSignature;
    setBusy(true); setError(""); setResultUrl(""); setSavedCreationId(null);
    try {
      const renderedImage = await renderPawprint({
        variation, photos: compositePhotos, title: title.trim() || categoryLabel, message: message.trim(), category: categoryId,
        width: FULL_PRINT_WIDTH, height: FULL_PRINT_HEIGHT,
      });
      const idempotencyKey = crypto.randomUUID();
      const response = await authedFetch("/api/pawprints/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          entryMode: entry,
          categoryId,
          optionId,
          shopifyProductId: shopifyProduct?.shopifyProductId || "",
          customized,
          customName: title.trim(),
          customMessage: message.trim(),
          renderedImage,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The Pawprint could not be saved.");
      if (liveDesignSignatureRef.current !== submittedDesignSignature) {
        await onCreationSaved?.();
        if (data.user) onUserUpdate(data.user);
        throw new Error("Your design changed while it was saving. Save the updated design before sending or printing it.");
      }
      setResultUrl(data.url);
      setSavedCreationId(Number(data.creationId) || null);
      await onCreationSaved?.();
      if (data.user) onUserUpdate(data.user);
    } catch (caught: any) {
      setError(caught.message || "The Pawprint could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const orderPrint = async () => {
    if (!savedCreationId || !shopifyProduct) return;
    setPrintBusy(true);
    setPrintCheckoutError("");
    try {
      const data = await createPawprintShopifyCheckout(
        { creationId: savedCreationId, shopifyProductId: shopifyProduct.shopifyProductId, shopifyVariantId: shopifyProduct.shopifyVariantId },
        crypto.randomUUID(),
      );
      if (data.checkoutUrl) window.location.assign(String(data.checkoutUrl));
    } catch (caught: any) {
      setPrintCheckoutError(caught.message || "The print checkout could not be created.");
    } finally {
      setPrintBusy(false);
    }
  };

  const signInNotice = !userProfile.email && !signInNoticeDismissed ? (
    <div className="mb-6 flex items-start gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-3 text-sm">
      <PawPrint size={18} className="mt-0.5 shrink-0 text-primary" />
      <p className="flex-1 font-semibold text-on-surface">
        Free to design — <a href="/sign-up" className="underline">sign in</a> when you're ready to save, download, or print.
      </p>
      <button type="button" onClick={() => setSignInNoticeDismissed(true)} aria-label="Dismiss sign-in notice" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-on-surface-variant hover:bg-on-surface/10">
        <X size={15} />
      </button>
    </div>
  ) : null;

  return (
    <div className="mx-auto w-full max-w-[1500px] px-3 pb-28 pt-4 sm:px-5">
      {signInNotice}
      <header className="mb-4 flex items-center gap-3 border-b border-outline-variant/30 pb-4">
        <button onClick={onBack} className="grid h-11 w-11 place-items-center rounded-full border border-outline-variant" aria-label="Back"><ChevronLeft size={19} /></button>
        <div><p className="text-xs font-bold text-primary">{categoryLabel}</p><h1 className="font-black text-on-surface">Finish your Pawprint</h1></div>
        <span className="ml-auto hidden text-xs font-bold text-on-surface-variant sm:block">Select a variation, then save</span>
      </header>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_320px] lg:grid-cols-[72px_minmax(0,1fr)_360px]">
        <nav className="hidden rounded-2xl border border-outline-variant/30 bg-surface p-2 lg:block">
          <button onClick={() => photoInput.current?.click()} className="mb-2 flex w-full flex-col items-center gap-1 rounded-xl py-3 text-[10px] font-black hover:bg-primary/10"><ImagePlus size={20} />Photo</button>
          <button onClick={() => document.getElementById("pawprint-text")?.focus()} className="mb-2 flex w-full flex-col items-center gap-1 rounded-xl py-3 text-[10px] font-black hover:bg-primary/10"><Type size={20} />Text</button>
          <button onClick={() => variationsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} className="flex w-full flex-col items-center gap-1 rounded-xl bg-primary/10 py-3 text-[10px] font-black text-primary"><LayoutGrid size={20} />Layouts</button>
        </nav>
        <div className="space-y-4 md:col-start-1 lg:col-start-2">
          <section className="rounded-3xl border border-outline-variant/30 bg-surface p-3 sm:p-5">
            <div className="mb-3 flex items-center gap-2">
              <Sparkles size={18} className="text-primary" />
              <h2 className="font-black">Live preview</h2>
              {(subjectArtLoading || previewRendering) && <Loader2 size={15} className="animate-spin text-primary" aria-label="Updating preview" />}
              <span className="ml-auto text-xs font-bold text-on-surface-variant">Updates as you edit</span>
            </div>
            <div className="mx-auto aspect-[4/5] w-full max-w-sm overflow-hidden rounded-2xl border border-outline-variant/40 bg-surface-container-low">
              {previewUrl ? (
                <img src={previewUrl} alt={`Live preview of "${title || categoryLabel}"`} className="h-full w-full object-contain" />
              ) : (
                <div className="grid h-full w-full place-items-center px-4 text-center text-xs font-bold text-on-surface-variant" aria-busy={subjectArtLoading || previewRendering}>
                  {subjectArtError || previewError || (subjectArtLoading ? "Generating your Pawprint art…" : "Your preview will appear here.")}
                </div>
              )}
            </div>
            {(subjectArtError || previewError) && <p role="alert" className="mt-2 text-center text-xs font-bold text-error">{subjectArtError || previewError}</p>}
            <p className="mt-2 text-center text-[11px] text-on-surface-variant">Preview only — saving renders the full {FULL_PRINT_WIDTH} × {FULL_PRINT_HEIGHT} print file.</p>
          </section>
          <section ref={variationsSectionRef} id="pawprint-variations" className="rounded-3xl bg-surface-container-low p-3 sm:p-6">
            <div className="mb-4 flex items-center justify-between"><div><h2 className="font-black">Choose a variation</h2><p className="text-xs text-on-surface-variant">Your photos and words stay the same.</p></div><span className="rounded-full bg-surface px-3 py-1 text-xs font-black">{VARIATIONS.length} options</span></div>
            <div className="grid grid-cols-2 gap-2 sm:gap-4">
              {VARIATIONS.map((item) => (
                <VariationPreview key={item.id} variation={item.id} selected={variation === item.id} photos={compositePhotos} title={title || "Your title"} message={message || "Your message"} category={categoryId} onSelect={() => setVariation(item.id)} />
              ))}
            </div>
          </section>
        </div>
        <aside className="space-y-4 md:col-start-2 lg:col-start-3">
          <section className="rounded-3xl border border-outline-variant/30 bg-surface p-5">
            <div className="mb-3 flex items-center gap-2"><ImagePlus size={18} className="text-primary" /><h2 className="font-black">Photos</h2><span className="ml-auto text-xs font-black text-primary">{photos.length}/{MAX_PAWPRINT_PHOTOS}</span></div>
            <button type="button" onClick={() => photoInput.current?.click()} className="min-h-40 w-full overflow-hidden rounded-2xl border-2 border-dashed border-outline-variant bg-surface-container-low transition hover:border-primary">
              <span className="flex min-h-40 flex-col items-center justify-center gap-2 p-6 text-center"><ImagePlus size={30} className="text-primary" /><strong>Add photos</strong><small className="text-on-surface-variant">Multiple PNG, JPEG, or WebP files · up to 20 MB each<br />Minimum 600 × 600 · large images optimize automatically</small></span>
            </button>
            <input ref={photoInput} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); if (files.length) void choosePhotos(files); event.target.value = ""; }} />
            {photos.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {photos.map((photo, index) => (
                  <div key={photo.id} className="group relative aspect-square overflow-hidden rounded-xl border border-outline-variant">
                    <img src={photo.dataUrl} alt={photo.name} className="h-full w-full object-cover" />
                    <button type="button" onClick={() => onPhotosChange(photos.filter((item) => item.id !== photo.id))} aria-label={`Remove ${photo.name}`} className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/65 text-white"><X size={14} /></button>
                    <div className="absolute inset-x-0 bottom-0 flex justify-between bg-gradient-to-t from-black/70 to-transparent p-1">
                      <button type="button" disabled={index === 0} onClick={() => movePhoto(index, -1)} aria-label={`Move ${photo.name} earlier`} className="grid h-10 w-10 place-items-center rounded-full bg-black/70 text-white disabled:opacity-30"><ArrowLeft size={16} /></button>
                      <button type="button" disabled={index === photos.length - 1} onClick={() => movePhoto(index, 1)} aria-label={`Move ${photo.name} later`} className="grid h-10 w-10 place-items-center rounded-full bg-black/70 text-white disabled:opacity-30"><ArrowRight size={16} /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="rounded-3xl border border-outline-variant/30 bg-surface p-5">
            <div className="mb-3 flex items-center gap-2"><Type size={18} className="text-primary" /><h2 className="font-black">Your words</h2></div>
            <label className="text-xs font-bold text-on-surface-variant">Title</label>
            <input id="pawprint-text" value={title} maxLength={TITLE_MAX_LENGTH} onChange={(event) => setTitle(event.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-outline-variant bg-surface-container px-3" />
            <p className="mt-1 text-right text-[10px] text-on-surface-variant">{title.length}/{TITLE_MAX_LENGTH}</p>
            <label className="mt-2 block text-xs font-bold text-on-surface-variant">Message</label>
            <textarea value={message} maxLength={MESSAGE_MAX_LENGTH} rows={4} onChange={(event) => setMessage(event.target.value)} className="mt-1 w-full resize-none rounded-xl border border-outline-variant bg-surface-container p-3" />
            <p className="mt-1 text-right text-[10px] text-on-surface-variant">{message.length}/{MESSAGE_MAX_LENGTH}</p>
          </section>
          {error && <p className="rounded-xl bg-error/10 p-3 text-sm font-bold text-error">{error}</p>}
          {resultUrl && (
            <>
              <a href={resultUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-primary font-black text-primary"><Download size={17} /> Open finished Pawprint</a>
              {entry === "digital" && (
                <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4">
                  <label className="text-xs font-black text-on-surface-variant">Send this Pawprint by email</label>
                  <div className="mt-2 flex gap-2">
                    <input type="email" value={recipientEmail} onChange={(event) => setRecipientEmail(event.target.value)} placeholder="friend@example.com" className="min-h-11 min-w-0 flex-1 rounded-xl border border-outline-variant bg-surface px-3 text-sm" />
                    <button
                      type="button"
                      disabled={sending || !savedCreationId || !recipientEmail.trim()}
                      onClick={async () => {
                        setSending(true); setError("");
                        try {
                          const response = await authedFetch("/api/pawprints/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ creationId: savedCreationId, email: recipientEmail }) });
                          const data = await response.json();
                          if (!response.ok) throw new Error(data.error || "Could not send the Pawprint.");
                          setRecipientEmail("");
                        } catch (caught: any) {
                          setError(caught.message || "Could not send the Pawprint.");
                        } finally {
                          setSending(false);
                        }
                      }}
                      className="min-h-11 rounded-xl bg-primary px-4 text-xs font-black text-on-primary disabled:opacity-40"
                    >
                      {sending ? "Sending…" : "Send"}
                    </button>
                  </div>
                  <p className="mt-2 text-[10px] text-on-surface-variant">Sending an email costs {CREDIT_PRICES.PAWPRINT_EMAIL} PupCoins. Digital Pawprints only.</p>
                </div>
              )}
              {entry === "print" && shopifyProduct && (
                <div className="rounded-2xl border border-primary/25 bg-surface-container-low p-4">
                  <div className="flex items-center gap-2"><Printer size={17} className="text-primary" /><h2 className="text-sm font-black">Order your print</h2></div>
                  <p className="mt-2 text-xs text-on-surface-variant">{shopifyProduct.title} — you'll finish checkout, including shipping, on our store.</p>
                  {printCheckoutError && <p className="mt-2 rounded-xl bg-error/10 p-2 text-xs font-bold text-error">{printCheckoutError}</p>}
                  <button
                    type="button"
                    onClick={() => void orderPrint()}
                    disabled={printBusy}
                    className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-black text-on-primary disabled:opacity-40"
                  >
                    {printBusy ? <Loader2 size={17} className="animate-spin" /> : <Printer size={17} />}
                    {printBusy ? "Preparing checkout…" : "Continue to checkout"}
                  </button>
                </div>
              )}
            </>
          )}
          <div className="sticky bottom-4 z-20 space-y-2 rounded-2xl bg-surface/85 p-2 backdrop-blur md:static md:bg-transparent md:p-0 md:backdrop-blur-none">
            {!userProfile.email ? (
              <button onClick={() => { window.location.href = "/sign-up"; }} className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 font-black text-on-primary">Sign In to Save Pawprint</button>
            ) : creditsShort ? (
              <>
                <button onClick={onOpenCreditStore} className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 font-black text-on-primary">
                  You need {creditsNeeded} more PupCoin{creditsNeeded === 1 ? "" : "s"} — Get coins
                </button>
                <p className="text-center text-[11px] font-semibold text-on-surface-variant">Saving this Pawprint costs {pawprintCost} PupCoins. You have {userProfile.credits}.</p>
              </>
            ) : (
              <button onClick={() => void save()} disabled={busy || !subjectArtDataUrl} title={busy ? "Saving your Pawprint…" : !subjectArtDataUrl ? "Waiting for your Pawprint art to finish generating…" : undefined} className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 font-black text-on-primary disabled:opacity-40">
                {busy ? <Loader2 className="animate-spin" size={19} /> : <Sparkles size={19} />}
                {busy ? "Saving…" : `Save selected variation · ${pawprintCost} PupCoins`}
              </button>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
