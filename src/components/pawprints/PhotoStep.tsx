import React, { useRef } from "react";
import { ArrowRight, ChevronLeft, ImagePlus, X } from "lucide-react";
import { MAX_PAWPRINT_PHOTOS } from "../../pawprints/collageEngine";
import { preparePhoto, type StudioPhoto } from "../../pawprints/renderPawprint";

export function PhotoStep({ photos, onPhotosChange, error, onError, onContinue, onBack }: {
  photos: StudioPhoto[];
  onPhotosChange: (photos: StudioPhoto[]) => void;
  error: string;
  onError: (message: string) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const photoInput = useRef<HTMLInputElement>(null);

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
      onPhotosChange([...photos, ...prepared]);
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
          <small className="text-on-surface-variant">PNG, JPEG, or WebP · up to 20 MB each · minimum 600 × 600</small>
        </span>
      </button>
      <input ref={photoInput} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); if (files.length) void choosePhotos(files); event.target.value = ""; }} />
      {photos.length > 0 && (
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((photo) => (
            <div key={photo.id} className="group relative aspect-square overflow-hidden rounded-xl border border-outline-variant">
              <img src={photo.dataUrl} alt={photo.name} className="h-full w-full object-cover" />
              <button type="button" onClick={() => onPhotosChange(photos.filter((item) => item.id !== photo.id))} aria-label={`Remove ${photo.name}`} className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/65 text-white"><X size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="mt-4 rounded-xl bg-error/10 p-3 text-sm font-bold text-error">{error}</p>}
      <button type="button" onClick={onContinue} disabled={photos.length === 0} className="mt-6 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-6 font-black text-on-primary disabled:opacity-40 sm:w-auto">
        Continue <ArrowRight size={18} />
      </button>
    </div>
  );
}
