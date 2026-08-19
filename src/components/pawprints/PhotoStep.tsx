import React, { useRef, useState } from "react";
import { ArrowRight, ChevronLeft, ImagePlus, Loader2, Scissors, Undo2, X } from "lucide-react";
import { MAX_PAWPRINT_PHOTOS } from "../../pawprints/collageEngine";
import { preparePhoto, type StudioPhoto } from "../../pawprints/renderPawprint";
import { removeBackground } from "../../photo-edit/api";

export const LOW_RESOLUTION_WARNING = "Low-resolution image — print not allowed / digital OK. Continue?";

export function LowResolutionDialog({ count, onContinue, onReject }: {
  count: number;
  onContinue: () => void;
  onReject: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="low-resolution-title" aria-describedby="low-resolution-description" className="w-full max-w-md rounded-3xl bg-surface p-6 text-on-surface shadow-2xl">
        <h2 id="low-resolution-title" className="text-xl font-black">Low-resolution image</h2>
        <p id="low-resolution-description" className="mt-3 font-semibold text-on-surface-variant">{LOW_RESOLUTION_WARNING}</p>
        {count > 1 && <p className="mt-2 text-sm text-on-surface-variant">{count} selected images are below 600 pixels on at least one side.</p>}
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button type="button" onClick={onContinue} className="min-h-12 rounded-xl bg-primary px-4 font-black text-on-primary">Yes, continue</button>
          <button type="button" onClick={onReject} className="min-h-12 rounded-xl border border-outline-variant px-4 font-black text-on-surface">No, remove image</button>
        </div>
      </section>
    </div>
  );
}

export function PhotoStep({ photos, onPhotosChange, error, onError, onContinue, onBack }: {
  photos: StudioPhoto[];
  onPhotosChange: (photos: StudioPhoto[]) => void;
  error: string;
  onError: (message: string) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const photoInput = useRef<HTMLInputElement>(null);
  const [pendingBatch, setPendingBatch] = useState<{ all: StudioPhoto[]; normal: StudioPhoto[]; lowCount: number } | null>(null);
  const [mattingId, setMattingId] = useState<string | null>(null);
  // The server owns this flag. Rather than baking a VITE_ build-time copy that
  // would need a rebuild to flip, the control is offered and retired the first
  // time the server answers FEATURE_DISABLED — one wasted request per session
  // when it is off, and no redeploy needed when it is turned on.
  const [editingRetired, setEditingRetired] = useState(false);

  const toggleBackground = async (photo: StudioPhoto) => {
    // Undo is a local swap: the original was kept, so declining costs nothing
    // and never calls the provider again.
    if (photo.backgroundRemoved && photo.originalDataUrl) {
      onPhotosChange(photos.map((item) => (
        item.id === photo.id
          ? { ...item, dataUrl: item.originalDataUrl!, originalDataUrl: undefined, backgroundRemoved: false }
          : item
      )));
      return;
    }

    onError("");
    setMattingId(photo.id);
    try {
      const outcome = await removeBackground(photo.dataUrl);
      if (outcome.removed && outcome.dataUrl) {
        const cutout = outcome.dataUrl;
        onPhotosChange(photos.map((item) => (
          item.id === photo.id
            ? { ...item, dataUrl: cutout, originalDataUrl: item.dataUrl, backgroundRemoved: true }
            : item
        )));
      } else if (outcome.featureDisabled) {
        setEditingRetired(true);
      } else {
        onError(outcome.reason || "The background could not be separated.");
      }
    } finally {
      setMattingId(null);
    }
  };

  const choosePhotos = async (files: File[]) => {
    onError("");
    const remaining = MAX_PAWPRINT_PHOTOS - photos.length;
    if (remaining < 1) return onError(`A Pawprint can contain up to ${MAX_PAWPRINT_PHOTOS} photos.`);
    const accepted = files.slice(0, remaining);
    try {
      const prepared: StudioPhoto[] = [];
      // Sequential work is intentional: decoding many large photos in parallel
      // can exceed the memory ceiling on iOS and lower-end Android devices.
      for (const file of accepted) prepared.push(await preparePhoto(file));
      const lowResolution = prepared.filter((photo) => photo.lowResolution);
      if (lowResolution.length) {
        setPendingBatch({ all: prepared, normal: prepared.filter((photo) => !photo.lowResolution), lowCount: lowResolution.length });
      } else {
        onPhotosChange([...photos, ...prepared]);
      }
    } catch (caught: any) {
      onError(caught.message || "The photo could not be opened.");
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-8">
      <button onClick={onBack} className="mb-6 flex min-h-11 items-center gap-2 text-sm font-black text-primary"><ChevronLeft size={18} /> Back</button>
      <div className="mb-8 max-w-2xl">
        <h1 className="text-3xl font-black text-on-surface">Choose your pet's photo</h1>
        <p className="mt-2 text-on-surface-variant">A clear photo facing the camera gives the image generator the best chance of preserving your pet's face, markings, and expression.</p>
      </div>
      <button type="button" onClick={() => photoInput.current?.click()} className="min-h-64 w-full overflow-hidden rounded-3xl border-2 border-dashed border-outline-variant bg-surface-container-low transition hover:border-primary">
        <span className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center">
          <ImagePlus size={40} className="text-primary" />
          <strong className="text-lg">Upload or choose a photo</strong>
          <small className="text-on-surface-variant">PNG, JPEG, or WebP · up to 20 MB each · low-resolution images are allowed for digital use</small>
        </span>
      </button>
      <input ref={photoInput} type="file" multiple accept="image/png,image/jpeg,image/webp,image/avif,image/gif" className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); if (files.length) void choosePhotos(files); event.target.value = ""; }} />
      {photos.length > 0 && (
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((photo) => (
            <div key={photo.id} className="group relative aspect-square overflow-hidden rounded-xl border border-outline-variant">
              {/* A checkerboard reads through the transparency, so a cutout is
                  visibly a cutout. On a plain tile a matte that removed nothing
                  looks identical to one that worked. */}
              <div
                className={photo.backgroundRemoved ? "h-full w-full bg-[length:16px_16px] bg-[linear-gradient(45deg,#00000014_25%,transparent_25%,transparent_75%,#00000014_75%),linear-gradient(45deg,#00000014_25%,transparent_25%,transparent_75%,#00000014_75%)] bg-[position:0_0,8px_8px]" : "h-full w-full"}
              >
                <img src={photo.dataUrl} alt={photo.name} className="h-full w-full object-cover" />
              </div>
              <button type="button" onClick={() => onPhotosChange(photos.filter((item) => item.id !== photo.id))} aria-label={`Remove ${photo.name}`} className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/65 text-white"><X size={14} /></button>
              {!editingRetired && (
                <button
                  type="button"
                  onClick={() => void toggleBackground(photo)}
                  disabled={mattingId !== null}
                  aria-label={photo.backgroundRemoved ? `Restore the background on ${photo.name}` : `Remove the background from ${photo.name}`}
                  className="absolute inset-x-1 bottom-1 flex min-h-8 items-center justify-center gap-1 rounded-lg bg-black/65 px-2 text-[11px] font-black text-white disabled:opacity-50"
                >
                  {mattingId === photo.id
                    ? (<><Loader2 size={12} className="animate-spin" /> Separating…</>)
                    : photo.backgroundRemoved
                      ? (<><Undo2 size={12} /> Undo</>)
                      : (<><Scissors size={12} /> Cut out</>)}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <p className="mt-4 rounded-xl bg-error/10 p-3 text-sm font-bold text-error">{error}</p>}
      <button type="button" onClick={onContinue} disabled={photos.length === 0} className="mt-6 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-6 font-black text-on-primary disabled:opacity-40 sm:w-auto">
        Continue <ArrowRight size={18} />
      </button>
      {pendingBatch && (
        <LowResolutionDialog
          count={pendingBatch.lowCount}
          onContinue={() => {
            onPhotosChange([...photos, ...pendingBatch.all]);
            setPendingBatch(null);
            onError("");
          }}
          onReject={() => {
            if (pendingBatch.normal.length) onPhotosChange([...photos, ...pendingBatch.normal]);
            setPendingBatch(null);
            onError("The low-resolution image was not added.");
          }}
        />
      )}
    </div>
  );
}
