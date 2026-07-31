import React, { useEffect, useState } from "react";
import { ArrowLeft, Upload, Link as LinkIcon, Send, Loader2, CheckCircle2 } from "lucide-react";
import { getAppConfig, uploadPrintFile } from "../api";
import FriendlyError from "./FriendlyError";

interface PrintRequestFormProps {
  onBack: () => void;
}

const MATERIALS = ["Resin (fine detail)", "PLA (durable)", "Nylon (flexible)", "Full-color sandstone"];
const SIZES = ['3" (palm)', '4"', '6"', '8"', '10" (large)'];
const FINISHES = ["As printed (single color)", "Hand-painted"];

// Model files can be a few MB; cap the client-side upload so we don't blow the
// server's JSON body limit when base64-encoded.
const MAX_FILE_MB = 25;

export default function PrintRequestForm({ onBack }: PrintRequestFormProps) {
  const [printEmail, setPrintEmail] = useState<string>("");
  const [source, setSource] = useState<"link" | "upload">("link");
  const [modelUrl, setModelUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const [email, setEmail] = useState("");
  const [material, setMaterial] = useState(MATERIALS[0]);
  const [size, setSize] = useState(SIZES[1]);
  const [finish, setFinish] = useState(FINISHES[0]);
  const [includeBase, setIncludeBase] = useState(true);
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [summary, setSummary] = useState("");

  useEffect(() => {
    getAppConfig().then((c) => setPrintEmail(c.printEmail || "")).catch(() => {});
  }, []);

  const fileToDataUrl = (f: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(f);
    });

  const handleSubmit = async () => {
    setError("");
    // Validate model source.
    if (source === "link" && !modelUrl.trim()) {
      setError("Paste your model link, or switch to Upload.");
      return;
    }
    if (source === "upload" && !file) {
      setError("Choose a model file, or switch to Paste link.");
      return;
    }
    if (source === "upload" && file && file.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`File is too large (max ${MAX_FILE_MB} MB). Host it and paste the link instead.`);
      return;
    }
    if (!email.trim()) {
      setError("Add an email so we can send your quote.");
      return;
    }

    setSubmitting(true);
    try {
      let resolvedUrl = modelUrl.trim();
      if (source === "upload" && file) {
        const dataUrl = await fileToDataUrl(file);
        resolvedUrl = await uploadPrintFile(dataUrl, file.type || "model/gltf-binary");
      }

      const lines = [
        "New 3D print request from Pawsome3D",
        "",
        `Model: ${resolvedUrl}`,
        `Contact email: ${email.trim()}`,
        `Material: ${material}`,
        `Size: ${size}`,
        `Finish: ${finish}`,
        `Base/stand: ${includeBase ? "Yes" : "No"}`,
        `Quantity: ${quantity}`,
        `Notes: ${notes.trim() || "(none)"}`,
      ];
      const body = lines.join("\n");
      setSummary(body);

      if (printEmail) {
        const mailto = `mailto:${printEmail}?subject=${encodeURIComponent(
          `3D Print Request — ${email.trim()}`
        )}&body=${encodeURIComponent(body)}`;
        window.location.href = mailto;
      }
      setDone(true);
    } catch (err: any) {
      setError(err?.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="max-w-lg mx-auto text-center py-10">
        <CheckCircle2 size={56} className="mx-auto text-primary mb-4" />
        <h2 className="text-2xl font-extrabold text-on-surface mb-2">Request ready!</h2>
        <p className="text-sm text-on-surface-variant mb-6">
          {printEmail
            ? "Your email app should have opened with the request details. Just hit send and we'll get back to you with a quote."
            : "Copy the details below and email them to us — we'll reply with a quote."}
        </p>
        <pre className="text-left text-xs bg-black/5 dark:bg-white/5 border border-outline-variant/40 rounded-2xl p-4 whitespace-pre-wrap mb-6">
          {summary}
        </pre>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => navigator.clipboard?.writeText(summary)}
            className="px-4 py-2 rounded-full text-sm font-bold bg-secondary-container text-on-secondary-container"
          >
            Copy details
          </button>
          <button onClick={onBack} className="px-4 py-2 rounded-full text-sm font-bold bg-primary text-on-primary">
            Done
          </button>
        </div>
      </div>
    );
  }

  const inputClass =
    "w-full bg-surface-container-high border border-outline-variant/40 rounded-xl p-3 text-sm outline-none focus:border-primary transition-colors";

  return (
    <div className="max-w-lg mx-auto">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-on-surface-variant hover:text-primary mb-4">
        <ArrowLeft size={16} /> Back
      </button>
      <h2 className="text-2xl font-extrabold text-on-surface mb-1">Make a real keepsake of your pet</h2>
      <p className="text-sm text-on-surface-variant mb-6">
        Turn your digital pet into a real figurine. Share the file and a few preferences, and we’ll email you a quote.
      </p>

      {/* Model source */}
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setSource("link")}
          className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-bold border transition-colors ${source === "link" ? "bg-primary text-on-primary border-primary" : "bg-surface-container border-outline-variant/40 text-on-surface-variant"}`}
        >
          <LinkIcon size={15} /> Paste link
        </button>
        <button
          onClick={() => setSource("upload")}
          className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-bold border transition-colors ${source === "upload" ? "bg-primary text-on-primary border-primary" : "bg-surface-container border-outline-variant/40 text-on-surface-variant"}`}
        >
          <Upload size={15} /> Upload file
        </button>
      </div>

      {source === "link" ? (
        <input
          type="url"
          value={modelUrl}
          onChange={(e) => setModelUrl(e.target.value)}
          placeholder="Paste your pet file link (a GLB file works too)"
          className={`${inputClass} mb-5`}
        />
      ) : (
        <div className="mb-5">
          <input
            type="file"
            accept=".glb,.gltf,.obj,.stl,model/gltf-binary"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="w-full text-sm text-on-surface-variant file:mr-3 file:py-2 file:px-4 file:rounded-full file:border-0 file:bg-primary file:text-on-primary file:font-bold file:cursor-pointer"
          />
          <p className="text-[11px] text-on-surface-variant/70 mt-1">GLB, GLTF, OBJ or STL · max {MAX_FILE_MB} MB</p>
        </div>
      )}

      {/* Spec fields */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <label className="text-xs font-bold text-on-surface-variant">
          Material
          <select value={material} onChange={(e) => setMaterial(e.target.value)} className={`${inputClass} mt-1`}>
            {MATERIALS.map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <label className="text-xs font-bold text-on-surface-variant">
          Size
          <select value={size} onChange={(e) => setSize(e.target.value)} className={`${inputClass} mt-1`}>
            {SIZES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label className="text-xs font-bold text-on-surface-variant">
          Finish
          <select value={finish} onChange={(e) => setFinish(e.target.value)} className={`${inputClass} mt-1`}>
            {FINISHES.map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label className="text-xs font-bold text-on-surface-variant">
          Quantity
          <input
            type="number" min={1} max={100} value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
            className={`${inputClass} mt-1`}
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm text-on-surface mb-3 cursor-pointer">
        <input type="checkbox" checked={includeBase} onChange={(e) => setIncludeBase(e.target.checked)} className="accent-primary w-4 h-4" />
        Include a base / stand
      </label>

      <label className="text-xs font-bold text-on-surface-variant block mb-3">
        Your email (for the quote)
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={`${inputClass} mt-1`} />
      </label>

      <label className="text-xs font-bold text-on-surface-variant block mb-5">
        Special instructions
        <textarea
          value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Pose, color notes, deadline, anything else…"
          className={`${inputClass} mt-1 h-20 resize-none`}
        />
      </label>

      {error && <FriendlyError message={error} action="Check the details above and try again." className="mb-3" />}

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full flex items-center justify-center gap-2 bg-primary text-on-primary font-bold py-3 rounded-full disabled:opacity-50 transition-all active:scale-[0.99]"
      >
        {submitting ? <><Loader2 size={18} className="animate-spin" /> Sending your request…</> : <><Send size={16} /> Get my print quote</>}
      </button>
    </div>
  );
}
