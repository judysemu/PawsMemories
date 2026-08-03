import React, { useState, useRef } from "react";
import { Screen } from "../types";
import { Upload, Camera, ChevronRight, Wand2 } from "lucide-react";
import { useCreateFlow } from "./create-flow/CreateFlowContext";
import FriendlyError from "./FriendlyError";

interface CreateScreenProps {
  onNavigate: (screen: Screen) => void;
}

/** Public pet subjects, in the order shown. The broader backend model profiles
 * remain available to internal callers but are not advertised in this flow. */
const SUBJECT_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "dog", label: "Dog", hint: "A natural four-legged shape" },
  { value: "cat", label: "Cat", hint: "A natural four-legged shape" },
];

function downscaleReferenceImage(dataUrl: string, maxDimension = 2048): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
      if (scale >= 1) {
        resolve(dataUrl);
        return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("This browser could not optimize the image."));
        return;
      }
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.88));
    };
    image.onerror = () => reject(new Error("The selected image could not be decoded."));
    image.src = dataUrl;
  });
}

export default function CreateScreen({ onNavigate }: CreateScreenProps) {
  const { state, setState } = useCreateFlow();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setError("Please select a valid image file.");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setError("Image must be smaller than 10MB.");
      return;
    }

    setIsProcessing(true);
    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64Url = event.target?.result as string;
      try {
        const optimizedPhoto = await downscaleReferenceImage(base64Url);
        setState((prev) => ({
          ...prev,
          inputPhotoUrl: optimizedPhoto,
        }));
        setError(null);
      } catch (optimizationError: any) {
        setError(optimizationError?.message || "Failed to optimize image file.");
      } finally {
        setIsProcessing(false);
      }
    };
    reader.onerror = () => {
      setError("Failed to read image file.");
      setIsProcessing(false);
    };
    reader.readAsDataURL(file);
  };

  /** Single source of truth for "can this step proceed" — used by both the
   *  button's disabled state and its styling, so they can never disagree. */
  const isReady = !!state.inputPhotoUrl;

  const handleNext = () => {
    if (!state.inputPhotoUrl) {
      setError("Please upload a reference photo to continue.");
      return;
    }
    setState((current) => ({ ...current, inputMode: "image" }));
    onNavigate(Screen.CREATE_REFERENCE);
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8 animate-in fade-in zoom-in duration-500">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-black text-on-surface mb-2">Create Your 3D Pet</h1>
        <p className="text-on-surface-variant text-lg">Upload one clear photo of your cat or dog.</p>
      </div>

      <div className="glass-panel p-8 rounded-3xl relative overflow-hidden">
        <div className="grid md:grid-cols-2 gap-8">
          
          {/* Upload Section */}
          <div className="flex flex-col gap-6">
            <h2 className="text-xl font-bold text-on-surface flex items-center gap-2">
              <Camera className="text-primary" /> Step 1: Upload Photo
            </h2>
            <div
              className={`border-2 border-dashed rounded-2xl p-8 flex flex-col items-center justify-center text-center transition-colors cursor-pointer min-h-[300px] relative overflow-hidden ${
                state.inputPhotoUrl ? 'border-primary bg-primary/5' : 'border-outline-variant hover:border-primary/50 hover:bg-surface-variant/30'
              }`}
              onClick={() => fileInputRef.current?.click()}
            >
              <input 
                type="file" 
                ref={fileInputRef}
                onChange={handlePhotoUpload}
                accept="image/jpeg, image/png, image/webp"
                className="hidden"
              />
              
              {state.inputPhotoUrl ? (
                <>
                  <img src={state.inputPhotoUrl} alt="Reference" className="absolute inset-0 w-full h-full object-cover opacity-60" />
                  <div className="relative z-10 bg-surface/80 backdrop-blur-md p-4 rounded-xl shadow-lg border border-outline-variant/30">
                    <span className="font-bold text-on-surface">Photo selected!</span>
                    <p className="text-xs text-on-surface-variant mt-1">Click to change</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                    <Upload size={32} className="text-primary" />
                  </div>
                  <p className="font-bold text-on-surface mb-2">Tap to upload a photo</p>
                  <p className="text-sm text-on-surface-variant">JPG, PNG, or WebP up to 10MB</p>
                </>
              )}

              {isProcessing && (
                <div className="absolute inset-0 bg-surface/50 backdrop-blur-sm flex items-center justify-center z-20">
                  <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
                </div>
              )}
            </div>

            {error && <FriendlyError message={error} action="Check the details above and try again." />}
          </div>

          {/* Configuration Section */}
          <div className="flex flex-col gap-6">
            <h2 className="text-xl font-bold text-on-surface flex items-center gap-2">
              <Wand2 className="text-primary" /> Step 2: Details
            </h2>

            <div className="space-y-4 flex-1">
              <div>
                <label className="block text-sm font-bold text-on-surface mb-2">Pet Name (Optional)</label>
                <input 
                  type="text"
                  value={state.petName || ""}
                  onChange={(e) => setState(s => ({...s, petName: e.target.value}))}
                  placeholder="e.g. Bella"
                  className="w-full px-4 py-3 rounded-xl border border-outline-variant bg-surface text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-bold text-on-surface mb-2">Subject</label>
                <div className="grid grid-cols-2 gap-2">
                  {SUBJECT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => setState(s => ({...s, species: option.value}))}
                      title={option.hint}
                      className={`py-2 px-3 rounded-lg text-sm font-bold capitalize transition-all ${
                        state.species === option.value
                          ? 'bg-primary text-on-primary shadow-md'
                          : 'bg-surface-variant/50 text-on-surface-variant hover:bg-surface-variant'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] leading-snug text-on-surface-variant">
                  This helps us shape your pet naturally.
                </p>
              </div>
              
              <div>
                <label className="block text-sm font-bold text-on-surface mb-2">Style</label>
                <div className="grid grid-cols-2 gap-2">
                  {["Realistic", "Cartoon", "Clay", "Low Poly"].map((style) => (
                    <button
                      key={style}
                      onClick={() => setState(s => ({...s, style}))}
                      className={`py-2 px-3 rounded-lg text-sm font-bold transition-all ${
                        (state.style || "Realistic") === style 
                          ? 'bg-secondary text-on-secondary shadow-md' 
                          : 'bg-surface-variant/50 text-on-surface-variant hover:bg-surface-variant'
                      }`}
                    >
                      {style}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button
              onClick={handleNext}
              disabled={!isReady}
              className={`w-full py-4 rounded-xl font-black text-lg flex items-center justify-center gap-2 transition-all ${
                isReady
                  ? 'bg-primary text-on-primary shadow-lg shadow-primary/25 hover:scale-[1.02]'
                  : 'bg-surface-variant text-on-surface-variant/50 cursor-not-allowed'
              }`}
            >
              Generate Pet Views <ChevronRight />
            </button>
            <p className="text-center text-xs text-on-surface-variant">No PupCoins will be charged yet.</p>
          </div>

        </div>
      </div>
    </div>
  );
}
