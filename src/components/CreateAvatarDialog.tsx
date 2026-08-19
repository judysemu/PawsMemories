import React, { useState, useRef } from "react";
import { Camera, X, Check, Upload, Sparkles, Plus, User, ImageIcon, Type, ChevronDown, ChevronUp, Palette } from "lucide-react";
import {
  TEXT_STYLE_OPTIONS,
} from "../../avatarPrompts";
import { avatarGenerationCost } from "../pricing";

export interface CreateModelOptions {
  name: string;
  avatarType: 'dog' | 'human' | 'object';
  inputMode: 'image' | 'text';
  photos: string[];
  facePhoto?: string | null;
  subject?: string;
  palette?: string | null;
  style?: string;
  selectionMode: 'auto' | 'manual';
  subjectSubtype?: string;
}

interface CreateAvatarDialogProps {
  onClose: () => void;
  onSubmit: (options: CreateModelOptions) => void;
  isDarkMode: boolean;
}

const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

// Offered when a HEIC is rejected. Deliberately the bare URL: the address this
// was taken from carried gclid, gbraid and four utm_* parameters from an ad
// click, which would have routed our own users through that ad attribution.
const HEIC_CONVERTER_URL = "https://www.freeconvert.com/heic-to-jpg";

const PALETTES = [
  { id: "auto",       label: "Auto",       swatch: "linear-gradient(135deg,#a3a3a3,#e5e5e5)" },
  { id: "warm",       label: "Warm",       swatch: "linear-gradient(135deg,#f59e0b,#ef4444)" },
  { id: "cool",       label: "Cool",       swatch: "linear-gradient(135deg,#0ea5e9,#6366f1)" },
  { id: "vibrant",    label: "Vibrant",    swatch: "linear-gradient(135deg,#ec4899,#8b5cf6)" },
  { id: "pastel",     label: "Pastel",     swatch: "linear-gradient(135deg,#fbcfe8,#bfdbfe)" },
  { id: "monochrome", label: "Mono",       swatch: "linear-gradient(135deg,#525252,#d4d4d4)" },
];

function downscaleImage(dataUrl: string, maxDim = 2048): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      if (scale >= 1) return resolve(dataUrl);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(dataUrl);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.9));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

const PromptSelect = ({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string; hint?: string; recommended?: boolean }[];
}) => {
  const active = options.find((o) => o.id === value);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">{label}</span>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none bg-surface text-on-surface text-xs font-medium rounded-lg border border-outline-variant/30 pl-2 pr-6 py-2 focus:outline-none focus:border-primary/60 cursor-pointer"
        >
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}{o.recommended ? " (recommended)" : ""}
            </option>
          ))}
        </select>
        <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant/60 pointer-events-none" />
      </div>
      {active?.hint && <span className="text-[9px] text-on-surface-variant/60 leading-tight">{active.hint}</span>}
    </label>
  );
};

export default function CreateAvatarDialog({ onClose, onSubmit, isDarkMode }: CreateAvatarDialogProps) {
  const [name, setName] = useState("");
  const [inputMode, setInputMode] = useState<'image' | 'text'>('image');
  const [avatarType, setAvatarType] = useState<'dog' | 'human' | 'object'>("dog");
  const [selectionMode, setSelectionMode] = useState<'auto' | 'manual'>('auto');
  const [subjectSubtype, setSubjectSubtype] = useState("dog");
  
  // Image mode state
  const [facePhoto, setFacePhoto] = useState<string | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [photoError, setPhotoError] = useState("");
  // Shown only when a HEIC/HEIF was rejected, so the converter link appears
  // where it helps and nowhere else.
  const [showHeicHelp, setShowHeicHelp] = useState(false);
  
  // Text mode state
  const [subject, setSubject] = useState("");
  
  // Shared styling options
  const [palette, setPalette] = useState<string>("auto");
  const [showStyling, setShowStyling] = useState(false);
  const [style, setStyle] = useState(TEXT_STYLE_OPTIONS.find((o) => o.recommended)?.id || TEXT_STYLE_OPTIONS[0].id);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const faceInputRef = useRef<HTMLInputElement>(null);

  // iPhones default to HEIC, which the server cannot decode, so this is the most
  // common rejection by far. A converter link turns a dead end into a next step.
  const isHeic = (file: File) => /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);

  const validatePhoto = (file: File): string | null => {
    // HEIC/HEIF are deliberately excluded: the bundled libheif cannot decode the
    // tiled variant Apple cameras produce, so accepting them here only moves the
    // failure to after the upload. Rejecting at pick time is the honest place.
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) return "Choose a JPG, PNG, or WebP image.";
    if (file.size > MAX_PHOTO_BYTES) return `${file.name} is larger than 15 MB.`;
    return null;
  };

  const optimizeFile = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = async (event) => resolve(await downscaleImage(String(event.target?.result || "")));
    reader.readAsDataURL(file);
  });

  const handleFilesSelect = async (files: FileList | File[]) => {
    const list = Array.from(files);
    for (const file of list) {
      const issue = validatePhoto(file);
      if (issue) { setPhotoError(issue); setShowHeicHelp(isHeic(file)); return; }
    }
    const remaining = MAX_PHOTOS - photos.length;
    setPhotoError("");
    setShowHeicHelp(false);
    try {
      const optimized = await Promise.all(list.slice(0, remaining).map(optimizeFile));
      setPhotos((previous) => [...previous, ...optimized].slice(0, MAX_PHOTOS));
    } catch (error: any) {
      setPhotoError(error.message || "One of the photos could not be read.");
    }
  };

  const handleFaceFileSelect = async (files: FileList | File[]) => {
    const file = Array.from(files)[0];
    if (!file) return;
    const issue = validatePhoto(file);
    if (issue) { setPhotoError(issue); setShowHeicHelp(isHeic(file)); return; }
    setPhotoError("");
    setShowHeicHelp(false);
    try { setFacePhoto(await optimizeFile(file)); }
    catch (error: any) { setPhotoError(error.message || "The face photo could not be read."); }
  };

  const removePhoto = (index: number) => setPhotos((prev) => prev.filter((_, i) => i !== index));

  const handleSave = () => {
    if (!name.trim()) {
      alert("Please enter a name.");
      return;
    }
    if (inputMode === 'image') {
      const hasAnyPhoto = !!facePhoto || photos.length > 0;
      if (!hasAnyPhoto) {
        alert("Please upload at least one photo.");
        return;
      }
    } else {
      if (subject.trim().length < 2) {
        alert("Please enter a subject description.");
        return;
      }
    }

    onSubmit({
      name: name.trim(),
      avatarType,
      inputMode,
      photos: inputMode === 'image' ? (facePhoto ? [facePhoto, ...photos] : photos) : [],
      facePhoto: inputMode === 'image' ? facePhoto : null,
      subject: inputMode === 'text' ? subject : undefined,
      palette: palette === "auto" ? null : palette,
      style,
      selectionMode,
      subjectSubtype: selectionMode === 'manual' ? subjectSubtype : undefined,
    });
  };

  const subjectLabel = selectionMode === 'auto' ? "subject" : avatarType === "dog" ? "animal" : avatarType === "human" ? "person" : "object";
  const typeIcon = avatarType === "dog" ? "🐾" : avatarType === "human" ? "🧑" : "🧊";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in">
      <div className="bg-surface-container rounded-3xl p-6 max-w-lg w-full shadow-2xl border border-outline-variant/30 flex flex-col max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex justify-between items-center mb-5">
          <h2 className="text-xl font-extrabold flex items-center gap-2 text-on-surface">
            <Sparkles className="text-primary" size={24} /> Create 3D Model
          </h2>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-outline-variant/20 transition-colors text-on-surface-variant hover:text-on-surface">
            <X size={20} />
          </button>
        </div>

        {/* Input Mode Toggle */}
        <div className="flex gap-1.5 p-1 bg-surface-container-high rounded-2xl mb-5 mx-auto w-full">
          {([
            { id: "image", label: "Upload Photos", icon: ImageIcon },
            { id: "text", label: "Text Prompt", icon: Type },
          ] as const).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setInputMode(id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                inputMode === id
                  ? "bg-primary text-on-primary shadow"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {/* Avatar Type Segmented Control */}
        <div className="grid grid-cols-2 sm:grid-cols-4 bg-surface border border-outline-variant/30 rounded-2xl p-1 mb-3 gap-1">
          <button
            type="button"
            onClick={() => setSelectionMode("auto")}
            className={`py-2 text-xs font-bold rounded-xl transition-all ${selectionMode === "auto" ? "bg-primary text-white shadow-md" : "text-on-surface-variant hover:bg-outline-variant/10"}`}
          >
            ✨ Auto Detect
          </button>
          <button
            type="button"
            onClick={() => { setSelectionMode("manual"); setAvatarType("dog"); setSubjectSubtype("dog"); }}
            className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all ${
              selectionMode === "manual" && avatarType === "dog" ? "bg-primary text-white shadow-md" : "text-on-surface-variant hover:bg-outline-variant/10"
            }`}
          >
            🐾 Animal
          </button>
          <button
            type="button"
            onClick={() => { setSelectionMode("manual"); setAvatarType("human"); setSubjectSubtype("human"); }}
            className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all ${
              selectionMode === "manual" && avatarType === "human" ? "bg-primary text-white shadow-md" : "text-on-surface-variant hover:bg-outline-variant/10"
            }`}
          >
            🧑 Human
          </button>
          <button
            type="button"
            onClick={() => { setSelectionMode("manual"); setAvatarType("object"); setSubjectSubtype("prop"); }}
            className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all ${
              selectionMode === "manual" && avatarType === "object" ? "bg-primary text-white shadow-md" : "text-on-surface-variant hover:bg-outline-variant/10"
            }`}
          >
            🧊 Object
          </button>
        </div>

        {selectionMode === 'manual' && avatarType === 'dog' && (
          <PromptSelect label="Animal type" value={subjectSubtype} onChange={setSubjectSubtype} options={[
            { id: "dog", label: "Dog" }, { id: "cat", label: "Cat" }, { id: "horse", label: "Horse" },
            { id: "rabbit", label: "Rabbit" }, { id: "bird", label: "Bird" }, { id: "other-animal", label: "Other animal" },
          ]} />
        )}
        {selectionMode === 'manual' && avatarType === 'object' && (
          <PromptSelect label="Object type" value={subjectSubtype} onChange={setSubjectSubtype} options={[
            { id: "prop", label: "Prop / general object" }, { id: "structure", label: "Structure" },
            { id: "vehicle", label: "Vehicle" }, { id: "plant", label: "Plant" }, { id: "food", label: "Food" },
            { id: "part", label: "Mechanical part" }, { id: "collectible", label: "Collectible / toy" },
          ]} />
        )}

        {/* Info Banner */}
        <div className="bg-primary/10 border border-primary/20 text-on-surface rounded-xl p-3 text-xs flex gap-2 items-start mb-5">
          <Camera size={16} className="shrink-0 mt-0.5 text-primary" />
          <p className="opacity-80">
            {selectionMode === 'auto'
              ? "We will detect Animal, Human, or Object first, then build using that detected workflow. Choose a type above when you want your selection to override detection."
              : avatarType === "object"
              ? "Generate a static GLB 3D model. No rigging or animations will be applied."
              : "Generate one static, rig-ready 3D character. Add motion later in the separate Animation Builder."}
          </p>
        </div>

        {/* Name Input */}
        <div className="mb-5">
          <label className="block text-[10px] font-bold mb-1 opacity-60 uppercase tracking-wider text-on-surface-variant">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`Name your ${subjectLabel}...`}
            className="w-full bg-surface border border-outline-variant/30 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-primary transition-all text-on-surface"
          />
        </div>

        {inputMode === 'image' ? (
          <>
            {/* FACE PHOTO */}
            {avatarType !== 'object' && (
              <div className="mb-4">
                <label className="block text-[10px] font-bold mb-1 opacity-60 uppercase tracking-wider text-on-surface-variant">
                  {typeIcon} {selectionMode === 'auto' ? 'Primary Subject Photo' : 'Face Close-Up (recommended)'}
                </label>
                {facePhoto ? (
                  <div className="relative w-full min-h-56 aspect-[4/3] rounded-2xl overflow-hidden border-2 border-primary/40 bg-surface">
                    <img src={facePhoto} alt="Face" className="w-full h-full object-cover" />
                    <button onClick={() => setFacePhoto(null)} className="absolute top-1 right-1 bg-red-500 text-white w-6 h-6 rounded-full flex items-center justify-center">
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => faceInputRef.current?.click()} className="w-full min-h-56 rounded-2xl border-2 border-dashed border-primary/40 flex flex-col items-center justify-center gap-2 hover:bg-primary/5 transition-all">
                    <User size={32} className="text-primary" />
                    <span className="text-sm font-bold text-on-surface">Choose a clear face photo</span>
                    <span className="text-xs text-on-surface-variant">JPG, PNG or WebP · up to 15 MB</span>
                  </button>
                )}
                <input ref={faceInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.length && handleFaceFileSelect(e.target.files)} />
              </div>
            )}

            {/* ADDITIONAL PHOTOS */}
            <div className="mb-5">
              <label className="block text-[10px] font-bold mb-1 opacity-60 uppercase tracking-wider text-on-surface-variant">
                📸 {avatarType === 'object' ? 'Reference Photos' : 'Additional Angles'} ({photos.length}/{MAX_PHOTOS})
              </label>
              
              {photos.length > 0 ? (
                <div className="grid grid-cols-4 gap-2 mb-2">
                  {photos.map((p, i) => (
                    <div key={i} className="relative rounded-xl overflow-hidden border aspect-square">
                      <img src={p} alt={`Angle ${i}`} className="w-full h-full object-cover" />
                      <button onClick={() => removePhoto(i)} className="absolute top-1 right-1 bg-red-500 text-white w-5 h-5 rounded-full flex items-center justify-center">
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                  {photos.length < MAX_PHOTOS && (
                    <button onClick={() => fileInputRef.current?.click()} className="rounded-xl border-2 border-dashed aspect-square flex flex-col items-center justify-center hover:bg-surface-variant/50">
                      <Plus size={16} className="text-on-surface-variant" />
                    </button>
                  )}
                </div>
              ) : (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(event) => { event.preventDefault(); setIsDragging(false); void handleFilesSelect(event.dataTransfer.files); }}
                  className={`cursor-pointer min-h-56 rounded-2xl border-2 border-dashed flex flex-col items-center justify-center p-8 transition-all text-center ${isDragging ? "border-primary bg-primary/10" : "border-outline-variant/40 hover:bg-surface-variant/50"}`}
                >
                  <Upload size={32} className="text-primary mb-3" />
                  <span className="text-sm font-bold text-on-surface">Drop or choose {avatarType === 'object' ? 'object photos' : 'body and angle photos'}</span>
                  <span className="mt-1 text-xs text-on-surface-variant">Up to 5 images, 15 MB each</span>
                </div>
              )}
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" onChange={(e) => e.target.files?.length && handleFilesSelect(e.target.files)} />
              {photoError && (
                <p role="alert" className="mt-2 text-xs font-bold text-error">
                  {photoError}
                  {showHeicHelp && (
                    <>
                      {" iPhone photos are usually HEIC. Change it in Settings \u203A Camera \u203A Formats \u203A Most Compatible, or "}
                      <a
                        href={HEIC_CONVERTER_URL}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="underline"
                      >
                        convert it to JPG
                      </a>
                      {" first."}
                    </>
                  )}
                </p>
              )}
            </div>
          </>
        ) : (
          /* TEXT PROMPT MODE */
          <div className="mb-5">
            <label className="block text-[10px] font-bold mb-1 opacity-60 uppercase tracking-wider text-on-surface-variant">Subject Description</label>
            <textarea
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              rows={3}
              placeholder={`Describe the ${subjectLabel} in detail...`}
              className="w-full resize-none bg-surface border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-primary transition-all text-on-surface"
            />
          </div>
        )}

        {/* STYLING OPTIONS (Collapsible) */}
        <div className="mb-6">
          <button
            onClick={() => setShowStyling(!showStyling)}
            className="flex items-center gap-2 text-xs font-bold text-on-surface-variant hover:text-primary transition-colors cursor-pointer w-full text-left"
          >
            {showStyling ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            <Palette size={14} />
            Advanced Styling & Options
          </button>
          
          {showStyling && (
            <div className="mt-3 p-3 bg-surface-container/50 rounded-2xl border border-outline-variant/15 flex flex-col gap-4 animate-fade-in">
              {avatarType !== 'object' && (
                <div>
                  <label className="block text-[10px] font-bold mb-1 opacity-60 uppercase tracking-wider text-on-surface-variant">Color Coordination</label>
                  <div className="grid grid-cols-6 gap-2">
                    {PALETTES.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setPalette(p.id)}
                        className={`flex flex-col items-center gap-1 p-1 rounded-lg border ${palette === p.id ? "border-primary ring-1 ring-primary bg-primary/10" : "border-outline-variant/30"}`}
                        title={p.label}
                      >
                        <span className="w-full aspect-square rounded-md" style={{ background: p.swatch }} />
                        <span className="text-[8px] font-bold">{p.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-0.5">
                  <PromptSelect label="Style" value={style} onChange={setStyle} options={TEXT_STYLE_OPTIONS} />
                  {inputMode === 'image' && avatarType === 'human' && (
                    <span className="text-[10px] text-on-surface-variant/70 pl-1">Humans always render as a full standing figure — pick the finish.</span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Submit Button */}
        <button
          onClick={handleSave}
          className="w-full bg-primary text-white py-3.5 rounded-xl font-black uppercase tracking-wider flex items-center justify-center gap-2 hover:bg-primary/90 transition-all shadow-lg active:scale-95"
        >
          <Sparkles size={18} />
          Create Model ({selectionMode === 'auto' ? 'up to ' : ''}{avatarGenerationCost(avatarType, inputMode)} PupCoins)
        </button>
      </div>
    </div>
  );
}
