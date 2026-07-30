import { ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  approveReferenceManifest,
  authedFetch,
  createReferenceSession,
  startReferenceAttempt,
} from "../api";
import PetModelViewer from "./PetModelViewer";

type MeshProfile = "hd" | "smart_mesh";
type SubjectProfile = "pet" | "humanoid";
type TextureQuality = "standard" | "detailed";
type StageKind = "reference" | "base" | "texture" | "rig_check" | "rig";

interface Product {
  name: string;
  deliverables: string[];
  prices: { base: number; texture: number; rig: number; currency: string };
  meshProfiles: Record<MeshProfile, {
    faceLimit: number;
    maxTriangles: number;
    modelVersion: string;
  }>;
  facialRig: {
    available: false;
    minimumSuccessRate: number;
    reason: string;
  };
  referenceRequirements: {
    requiredSourceUploads: number;
    optionalSourceAngles: string[];
    generatedForApproval: string[];
    guidance: string[];
  };
}

interface ValidationReport {
  operatorReady: boolean;
  triangleCount?: number;
  checks: Array<{
    id: string;
    passed: boolean | null;
    detail: string;
  }>;
  reasonCodes: string[];
}

interface StageAttempt {
  attemptUuid: string;
  stage: StageKind;
  attemptNumber: number;
  state: "awaiting_customer_approval" | "queued" | "processing" | "approved" | "rejected" | "failed";
  artifactSha256: string | null;
  assetVersionId: number | null;
  validationReport: ValidationReport | null;
  validationReportSha256: string | null;
  capabilityReport: { riggable: boolean; rigType: string | null } | null;
  priceCredits: number;
  creditsDisposition: "none" | "charged" | "refunded";
  rejectionReason: string | null;
  failureCode: string | null;
}

interface Order {
  orderUuid: string;
  state: string;
  meshProfile: MeshProfile;
  subjectProfile: SubjectProfile;
  includeTexture: boolean;
  includeRig: boolean;
  textureQuality: TextureQuality;
  styleDirection: string | null;
  referenceManifest: Record<string, string> | null;
  creditsReserved: number;
  approvedVersionId: number | null;
  finalCustomerVersionId: number | null;
}

interface OrderView {
  order: Order;
  currentStage: StageAttempt | null;
  progress?: number;
  quote: { base: number; texture: number; rig: number; total: number };
  meshPolicy: { faceLimit: number; maxTriangles: number };
  facialRig: Product["facialRig"];
}

interface GeneratedReferenceView {
  viewKind: "front" | "left" | "right" | "rear" | "front_three_quarter";
  signedUrl: string;
}

const REFERENCE_FIELDS = [
  ["frontUrl", "Front"],
  ["leftUrl", "Left side"],
  ["rearUrl", "Rear"],
  ["rightUrl", "Right side"],
  ["threeQuarterUrl", "Three-quarter"],
] as const;

const STYLE_PRESETS = [
  { id: "reference", label: "Reference-faithful", text: "" },
  { id: "soft", label: "Soft stylized", text: "Soft stylized finish while preserving the reference colors and markings." },
  { id: "toy", label: "Toy collectible", text: "Premium collectible toy finish with clean color separation and soft material response." },
  { id: "studio", label: "Studio realistic", text: "Studio-realistic fur and material finish faithful to the reference photography." },
] as const;

const STAGE_LABELS: Record<StageKind, string> = {
  reference: "360° views",
  base: "Blank base mesh",
  texture: "Texture",
  rig_check: "Rig readiness",
  rig: "Rig",
};

function idempotencyKey(): string {
  return crypto.randomUUID();
}

export default function PetModelStudio() {
  const [product, setProduct] = useState<Product | null>(null);
  const [view, setView] = useState<OrderView | null>(null);
  const [recentOrders, setRecentOrders] = useState<OrderView[]>([]);
  const [operatorQueue, setOperatorQueue] = useState<OrderView[] | null>(null);
  const [operatorSelection, setOperatorSelection] = useState<OrderView | null>(null);
  const [operatorPreviewUrl, setOperatorPreviewUrl] = useState<string | null>(null);
  const [meshProfile, setMeshProfile] = useState<MeshProfile>("hd");
  const [subjectProfile, setSubjectProfile] = useState<SubjectProfile>("pet");
  const [includeTexture, setIncludeTexture] = useState(true);
  const [includeRig, setIncludeRig] = useState(false);
  const [textureQuality, setTextureQuality] = useState<TextureQuality>("standard");
  const [stylePreset, setStylePreset] = useState("reference");
  const [styleDirection, setStyleDirection] = useState("");
  const [inputMode, setInputMode] = useState<"image" | "multi" | "generate" | "text">("multi");
  const [autoContinue, setAutoContinue] = useState(false);
  const [printHeight, setPrintHeight] = useState(100);
  const [references, setReferences] = useState<Record<string, string>>({});
  const [referenceSession, setReferenceSession] = useState<{ sessionUuid: string; manifestHash: string } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      authedFetch("/api/pet-glb/product"),
      authedFetch("/api/pet-glb/orders?limit=12"),
      authedFetch("/api/pet-glb/operator/queue"),
    ])
      .then(async ([productResponse, ordersResponse, operatorResponse]) => {
        const productBody = await productResponse.json();
        if (!productResponse.ok) throw new Error(productBody?.message || "Model generator is unavailable.");
        setProduct(productBody);
        if (ordersResponse.ok) setRecentOrders(await ordersResponse.json());
        if (operatorResponse.ok) setOperatorQueue(await operatorResponse.json());
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Model generator is unavailable."));
  }, []);

  useEffect(() => {
    setPreviewUrl(null);
    setRejectionReason("");
  }, [view?.currentStage?.attemptUuid]);

  useEffect(() => {
    if (!includeTexture) {
      setIncludeRig(false);
      setStylePreset("reference");
      setStyleDirection("");
    }
  }, [includeTexture]);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const response = await authedFetch(path, init);
      const text = await response.text();
      let body: any = {};
      try { body = text ? JSON.parse(text) : {}; }
      catch { throw new Error(`Server returned an unreadable response (${response.status}).`); }
      if (!response.ok) throw new Error(body?.message || body?.error || "Request failed.");
      return body;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Request failed.";
      setError(message);
      throw cause;
    } finally {
      setBusy(false);
    }
  }, []);

  const selectedStyle = styleDirection.trim() || STYLE_PRESETS.find((preset) => preset.id === stylePreset)?.text || "";

  const total = useMemo(() => {
    if (!product) return 0;
    return product.prices.base
      + (includeTexture ? product.prices.texture : 0)
      + (includeRig ? product.prices.rig : 0);
  }, [product, includeTexture, includeRig]);

  const applyView = useCallback((next: OrderView) => {
    setView(next);
    setRecentOrders((current) => [
      next,
      ...current.filter((item) => item.order.orderUuid !== next.order.orderUuid),
    ]);
  }, []);

  const start = async () => {
    try {
      const sourceImage = references.frontUrl;
      if (inputMode !== "text" && !sourceImage) {
        throw new Error("Add one clear pet photo to generate the 360° views.");
      }
      const session = await createReferenceSession(
        inputMode === "text" ? "text" : "photo",
        inputMode === "text" ? selectedStyle : undefined,
        subjectProfile,
        sourceImage,
      );
      const generated = await startReferenceAttempt(session.sessionUuid, `views_${crypto.randomUUID()}`);
      const generatedViews = (generated.session.views || []) as GeneratedReferenceView[];
      const manifestHash = String(generated.session.manifestHash || "");
      if (generatedViews.length !== 5 || !manifestHash) {
        throw new Error("The image generator did not return a complete 360° view set.");
      }
      const byKind = new Map(generatedViews.map((item) => [item.viewKind, item.signedUrl]));
      const generatedManifest = {
        frontUrl: byKind.get("front"),
        leftUrl: byKind.get("left"),
        rightUrl: byKind.get("right"),
        rearUrl: byKind.get("rear"),
        threeQuarterUrl: byKind.get("front_three_quarter"),
      };
      if (Object.values(generatedManifest).some((value) => !value)) {
        throw new Error("The generated 360° view set is missing a required angle.");
      }
      const created = await call("/api/pet-glb/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meshProfile,
          subjectProfile,
          includeTexture,
          includeRig,
          textureQuality,
          styleDirection: selectedStyle || null,
          facialRig: false,
        }),
      }) as OrderView;
      applyView(created);
      const withReferences = await call(`/api/pet-glb/orders/${created.order.orderUuid}/references`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ references: generatedManifest }),
      }) as OrderView;
      setReferences(generatedManifest as Record<string, string>);
      setReferenceSession({ sessionUuid: session.sessionUuid, manifestHash });
      applyView(withReferences);
      if (autoContinue) {
        await approveReferenceManifest(session.sessionUuid, manifestHash);
        await approveStage(withReferences);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not generate the 360° views.");
    }
  };

  const loadReferenceFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).slice(0, REFERENCE_FIELDS.length);
    files.forEach((file, index) => {
      const reader = new FileReader();
      reader.onload = () => {
        const key = index === 0 ? "frontUrl" : REFERENCE_FIELDS[index][0];
        setReferences((current) => ({ ...current, [key]: String(reader.result || "") }));
      };
      reader.readAsDataURL(file);
    });
    event.target.value = "";
  };

  const saveReferences = () => {
    if (!view) return;
    call(`/api/pet-glb/orders/${view.order.orderUuid}/references`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ references }),
    }).then(applyView).catch(() => {});
  };

  const approveStage = async (targetView: OrderView) => {
    const stage = targetView.currentStage;
    if (!stage?.artifactSha256) return;
    const approved = await call(`/api/pet-glb/orders/${targetView.order.orderUuid}/stages/${stage.stage}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: idempotencyKey(),
        attemptUuid: stage.attemptUuid,
        artifactSha256: stage.artifactSha256,
        assetVersionId: stage.assetVersionId,
        reportSha256: stage.validationReportSha256,
      }),
    }) as OrderView;
    applyView(approved);
  };

  const approve = async () => {
    const stage = view?.currentStage;
    if (!view || !stage?.artifactSha256) return;
    try {
      if (stage.stage === "reference" && referenceSession) {
        await approveReferenceManifest(referenceSession.sessionUuid, referenceSession.manifestHash);
      }
      await approveStage(view);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve the generated views.");
    }
  };

  const poll = () => {
    const stage = view?.currentStage;
    if (!view || !stage || stage.stage === "reference") return;
    call(`/api/pet-glb/orders/${view.order.orderUuid}/stages/${stage.stage}/poll`, {
      method: "POST",
    }).then(applyView).catch(() => {});
  };

  const loadPreview = () => {
    if (!view) return;
    call(`/api/pet-glb/orders/${view.order.orderUuid}/stages/current/preview`)
      .then((body) => setPreviewUrl(body.url))
      .catch(() => {});
  };

  const reject = () => {
    const stage = view?.currentStage;
    if (!view || !stage || rejectionReason.trim().length < 3) return;
    call(`/api/pet-glb/orders/${view.order.orderUuid}/stages/${stage.stage}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: idempotencyKey(),
        attemptUuid: stage.attemptUuid,
        reason: rejectionReason.trim(),
      }),
    }).then(applyView).catch(() => {});
  };

  const retry = () => {
    const stage = view?.currentStage;
    if (!view || !stage || stage.stage === "reference") return;
    call(`/api/pet-glb/orders/${view.order.orderUuid}/stages/${stage.stage}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: idempotencyKey(),
        attemptUuid: stage.attemptUuid,
      }),
    }).then(applyView).catch(() => {});
  };

  const download = () => {
    if (!view) return;
    call(`/api/pet-glb/orders/${view.order.orderUuid}/download`, { method: "POST" })
      .then((body) => setDownloadUrl(body.url))
      .catch(() => {});
  };

  const inspectOperatorOrder = (candidate: OrderView) => {
    setOperatorSelection(candidate);
    setOperatorPreviewUrl(null);
    call(`/api/pet-glb/operator/orders/${candidate.order.orderUuid}/preview`)
      .then((body) => setOperatorPreviewUrl(body.url))
      .catch(() => {});
  };

  const releaseOperatorOrder = () => {
    const candidate = operatorSelection;
    const versionId = candidate?.order.finalCustomerVersionId;
    if (!candidate || !versionId) return;
    call(`/api/pet-glb/operator/orders/${candidate.order.orderUuid}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        versionId,
        note: "Exact customer-approved version inspected and released.",
      }),
    })
      .then(() => {
        setOperatorQueue((current) => current?.filter(
          (item) => item.order.orderUuid !== candidate.order.orderUuid,
        ) ?? null);
        setOperatorSelection(null);
        setOperatorPreviewUrl(null);
      })
      .catch(() => {});
  };

  if (!product && !error) return <div className="p-6 text-sm opacity-70">Loading model generator…</div>;
  if (!product) return <div className="p-6 text-sm text-red-500">{error}</div>;

  const stage = view?.currentStage;
  const primaryReferenceReady = Boolean(references.frontUrl?.trim());
  const validationPasses = stage?.validationReport?.operatorReady !== false;
  const canApprove = stage?.state === "awaiting_customer_approval"
    && Boolean(stage.artifactSha256)
    && validationPasses
    && (stage.stage !== "rig_check" || stage.capabilityReport?.riggable === true);
  const selectedStages: StageKind[] = [
    "reference",
    "base",
    ...(view?.order.includeTexture ?? includeTexture ? ["texture" as const] : []),
    ...(view?.order.includeRig ?? includeRig ? ["rig_check" as const, "rig" as const] : []),
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-5 p-3 sm:p-5">
      <header className="flex flex-wrap items-end justify-between gap-4 rounded-3xl border border-white/10 bg-black/20 px-5 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Pawsome3D model lab</p>
          <h1 className="mt-1 text-3xl font-semibold">{product.name}</h1>
        </div>
        <p className="max-w-xl text-sm opacity-70">
          Build like a professional 3D studio, with one important pause: you approve the generated 360° views before the base mesh begins.
        </p>
      </header>

      {!view ? (
        <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)_320px]">
          <section className="space-y-5 rounded-3xl border border-white/15 bg-white/[0.07] p-4 backdrop-blur-xl">
            <nav aria-label="Model tools" className="grid grid-cols-3 gap-2 border-b border-white/10 pb-4">
              <button type="button" className="rounded-xl bg-cyan-400 px-3 py-2 text-xs font-bold text-slate-950">Model</button>
              <button type="button" disabled className="rounded-xl border border-white/10 px-3 py-2 text-xs opacity-35">Texture</button>
              <button type="button" disabled className="rounded-xl border border-white/10 px-3 py-2 text-xs opacity-35">Animate</button>
            </nav>
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold">1. Mesh</legend>
              <div className="grid gap-2">
                {(["hd", "smart_mesh"] as const).map((profile) => (
                  <button
                    key={profile}
                    type="button"
                    onClick={() => setMeshProfile(profile)}
                    className={`rounded-2xl border p-3 text-left transition ${meshProfile === profile ? "border-cyan-300 bg-cyan-400/15" : "border-white/15 bg-black/10"}`}
                  >
                    <span className="font-medium">{profile === "hd" ? "HD" : "SmartMesh"}</span>
                    <span className="mt-1 block text-xs opacity-65">
                      {profile === "hd"
                        ? `Up to ${product.meshProfiles.hd.maxTriangles.toLocaleString()} measured triangles`
                        : `Lightweight · max ${product.meshProfiles.smart_mesh.maxTriangles.toLocaleString()} measured triangles`}
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold">2. Start from</legend>
              <div className="grid grid-cols-2 gap-2">
                {([
                  ["image", "Image upload"],
                  ["multi", "Multi-image"],
                  ["generate", "Image + generate"],
                  ["text", "Text to model"],
                ] as const).map(([mode, label]) => (
                  <button key={mode} type="button" onClick={() => setInputMode(mode)}
                    className={`rounded-xl border px-2 py-2 text-xs ${inputMode === mode ? "border-cyan-300 bg-cyan-400/15" : "border-white/10"}`}>
                    {label}
                  </button>
                ))}
              </div>
              <label className="flex cursor-pointer items-center justify-center rounded-2xl border border-dashed border-cyan-300/35 bg-cyan-300/5 px-3 py-5 text-center text-xs">
                <input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={loadReferenceFiles} />
                <span>
                  <strong className="block text-sm">Choose at least one pet photo</strong>
                  {inputMode === "multi" ? "One photo is enough; extra angles are optional" : "One clear photo generates the complete view set"}
                </span>
              </label>
              <div className="grid grid-cols-5 gap-1.5">
                {REFERENCE_FIELDS.map(([key, label]) => (
                  <div key={key} className={`aspect-square overflow-hidden rounded-lg border ${references[key] ? "border-emerald-300/50" : "border-white/10 bg-black/20"}`}>
                    {references[key]
                      ? <img src={references[key]} alt={`${label} upload`} className="h-full w-full object-cover" />
                      : <span className="flex h-full items-center justify-center px-1 text-center text-[9px] opacity-45">{key === "frontUrl" ? "Required" : `${label} optional`}</span>}
                  </div>
                ))}
              </div>
              {(inputMode === "generate" || inputMode === "text") && (
                <textarea value={styleDirection} onChange={(event) => setStyleDirection(event.target.value.slice(0, 400))}
                  className="min-h-20 w-full rounded-xl border border-white/15 bg-black/20 p-3 text-xs"
                  placeholder={inputMode === "text" ? "Describe the pet, pose, markings, and base…" : "Describe the extra views you want generated…"} />
              )}
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold">3. General settings</legend>
              <label className="block text-xs">
                <span className="mb-1 block opacity-70">Subject</span>
                <select value={subjectProfile} onChange={(event) => setSubjectProfile(event.target.value as SubjectProfile)}
                  className="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2">
                  <option value="pet">Pet / animal</option>
                  <option value="humanoid">Humanoid character</option>
                </select>
                {subjectProfile === "humanoid" && (
                  <span className="mt-1 block opacity-55">AI behavior is not embedded in the GLB.</span>
                )}
              </label>
              <label className="block text-xs">
                <span className="mb-1 flex justify-between opacity-70"><span>Finished print height</span><strong>{printHeight} mm</strong></span>
                <input type="range" min="50" max="200" step="10" value={printHeight} onChange={(event) => setPrintHeight(Number(event.target.value))} className="w-full" />
              </label>
              <div className="rounded-xl border border-amber-200/15 bg-amber-200/5 p-3 text-xs opacity-75">
                For reliable printing, use clear full-body views with visible paws, tail, and floor contact. Fine fur becomes sculpted surface detail.
              </div>
              <label className="flex items-start gap-3 rounded-2xl border border-white/15 p-3">
                <input type="checkbox" checked={includeTexture} onChange={(event) => setIncludeTexture(event.target.checked)} className="mt-1" />
                <span>
                  <span className="text-sm font-medium">Texture after base</span>
                  <span className="block text-xs opacity-65">The Texture tool unlocks when the untextured mesh finishes.</span>
                </span>
              </label>
              <label className={`flex items-start gap-3 rounded-2xl border p-3 ${includeTexture ? "border-white/15" : "border-white/5 opacity-45"}`}>
                <input type="checkbox" checked={includeRig} disabled={!includeTexture} onChange={(event) => setIncludeRig(event.target.checked)} className="mt-1" />
                <span>
                  <span className="text-sm font-medium">Animate after texture</span>
                  <span className="block text-xs opacity-65">The Animate tool unlocks only after rig compatibility passes.</span>
                </span>
              </label>
              <label className="flex items-start gap-3 text-xs">
                <input type="checkbox" checked={autoContinue} onChange={(event) => setAutoContinue(event.target.checked)} className="mt-0.5" />
                <span>Auto-approve the generated 360° views and begin the base mesh. Later paid stages still ask before charging.</span>
              </label>
              <p className="text-xs opacity-60">When complete, your private model appears in the Fur Bin.</p>
            </fieldset>

            {includeTexture && inputMode !== "generate" && inputMode !== "text" && (
              <fieldset className="space-y-3">
                <legend className="text-sm font-semibold">Texture direction</legend>
                <div className="flex flex-wrap gap-2">
                  {STYLE_PRESETS.map((preset) => (
                    <button key={preset.id} type="button" onClick={() => setStylePreset(preset.id)}
                      className={`rounded-full border px-3 py-1.5 text-xs ${stylePreset === preset.id ? "border-cyan-300 bg-cyan-400/15" : "border-white/15"}`}>
                      {preset.label}
                    </button>
                  ))}
                </div>
                <textarea
                  value={styleDirection}
                  onChange={(event) => setStyleDirection(event.target.value.slice(0, 400))}
                  placeholder="Optional texture/material direction. This will not change the approved body geometry."
                  className="min-h-24 w-full rounded-2xl border border-white/15 bg-black/15 p-3 text-sm"
                />
                <div className="flex items-center justify-between text-xs opacity-60">
                  <label>
                    Quality{" "}
                    <select value={textureQuality} onChange={(event) => setTextureQuality(event.target.value as TextureQuality)}
                      className="rounded border border-white/15 bg-black/30 px-2 py-1">
                      <option value="standard">Standard</option>
                      <option value="detailed">Detailed</option>
                    </select>
                  </label>
                  <span>{styleDirection.length}/400</span>
                </div>
              </fieldset>
            )}
            <button onClick={start} disabled={busy || (inputMode !== "text" ? !primaryReferenceReady : !selectedStyle.trim())}
              className="group relative w-full overflow-hidden rounded-2xl bg-cyan-400 px-4 py-3.5 font-bold text-slate-950 disabled:opacity-40">
              <span className="relative z-10">{busy ? "Gathering reference sand…" : "Generate base model"}</span>
              {busy && <span className="absolute inset-0 animate-pulse bg-[radial-gradient(circle_at_20%_80%,#f5d08a_0_2px,transparent_3px)] bg-[length:18px_18px]" />}
            </button>
          </section>

          <section className="relative min-h-[720px] overflow-hidden rounded-3xl border border-white/15 bg-[radial-gradient(circle_at_50%_35%,rgba(34,211,238,0.13),transparent_38%),linear-gradient(145deg,rgba(15,23,42,0.95),rgba(3,7,18,0.98))]">
            <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-white/10 bg-black/20 px-5 py-3 text-xs backdrop-blur">
              <span className="font-semibold">Live model viewer</span>
              <span className="rounded-full border border-white/10 px-3 py-1 opacity-65">Drag to rotate · scroll to zoom</span>
            </div>
            <div className="flex min-h-[480px] items-center justify-center px-8 pb-8 pt-20 text-center">
              <div className="max-w-md">
                <div className="mx-auto mb-5 flex h-48 w-48 items-end justify-center rounded-full bg-[radial-gradient(ellipse_at_bottom,#d6a75f_0_2%,#8b633d_15%,transparent_62%)] opacity-90">
                  <span className="mb-8 text-6xl drop-shadow-2xl">🐾</span>
                </div>
                <h2 className="text-2xl font-semibold">Your pet takes shape here</h2>
                <p className="mt-2 text-sm opacity-60">Reference sand gathers into an untextured base mesh. Texture and Animate unlock only after the mesh is complete.</p>
              </div>
            </div>
            <PrintGallery />
          </section>

          <aside className="h-fit space-y-4 rounded-3xl border border-white/15 bg-white/[0.08] p-5 backdrop-blur-xl">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-cyan-300">Build summary</p>
              <h2 className="mt-1 text-xl font-semibold">Ready for your shelf</h2>
            </div>
            <PriceRow label="Blank base mesh" value={product.prices.base} />
            <PriceRow label="Texture" value={includeTexture ? product.prices.texture : 0} muted={!includeTexture} />
            <PriceRow label="Rig" value={includeRig ? product.prices.rig : 0} muted={!includeRig} />
            <div className="border-t border-white/15 pt-3">
              <PriceRow label="Maximum total" value={total} strong />
            </div>
            <p className="text-xs opacity-60">Creating the order is free. The base charge happens only when you approve your reference set.</p>
            <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/5 p-3 text-xs">
              <strong className="block text-sm">Simple print checkout</strong>
              Approve model → choose {printHeight} mm size → enter shipping → secure card checkout → Slant 3D prints and ships.
            </div>
            <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-3 text-xs">
              Facial blendshape rigging is not for sale. It returns only after at least {Math.round(product.facialRig.minimumSuccessRate * 100)}% measured reliability.
            </div>
            {recentOrders.length > 0 && (
              <div className="space-y-2 border-t border-white/15 pt-4">
                <h2 className="text-sm font-semibold">Your model builds</h2>
                {recentOrders.slice(0, 6).map((item) => (
                  <button
                    key={item.order.orderUuid}
                    type="button"
                    onClick={() => setView(item)}
                    className="flex w-full items-center justify-between rounded-xl border border-white/10 px-3 py-2 text-left text-xs"
                  >
                    <span>{item.order.meshProfile === "smart_mesh" ? "SmartMesh" : "HD"} · {item.order.subjectProfile}</span>
                    <span className="max-w-28 truncate opacity-60">{item.order.state.replaceAll("_", " ")}</span>
                  </button>
                ))}
              </div>
            )}
            {operatorQueue !== null && (
              <div className="space-y-2 border-t border-white/15 pt-4">
                <h2 className="text-sm font-semibold">Operator release queue</h2>
                {operatorQueue.length === 0 ? (
                  <p className="text-xs opacity-60">No customer-approved models are waiting.</p>
                ) : operatorQueue.map((item) => (
                  <button
                    key={item.order.orderUuid}
                    type="button"
                    onClick={() => inspectOperatorOrder(item)}
                    className="flex w-full items-center justify-between rounded-xl border border-amber-300/20 px-3 py-2 text-left text-xs"
                  >
                    <span>{item.order.orderUuid.slice(0, 8)} · {item.order.meshProfile === "smart_mesh" ? "SmartMesh" : "HD"}</span>
                    <span className="opacity-60">Inspect</span>
                  </button>
                ))}
                {operatorSelection && (
                  <div className="space-y-3 rounded-2xl border border-amber-300/25 bg-amber-300/10 p-3">
                    <div className="text-xs">
                      Exact version <strong>{operatorSelection.order.finalCustomerVersionId}</strong>
                      {operatorSelection.currentStage?.validationReport?.triangleCount !== undefined
                        ? ` · ${operatorSelection.currentStage.validationReport.triangleCount.toLocaleString()} triangles`
                        : ""}
                    </div>
                    {operatorSelection.order.referenceManifest && (
                      <div className="grid grid-cols-5 gap-1">
                        {REFERENCE_FIELDS.map(([key, label]) => (
                          <img
                            key={key}
                            src={operatorSelection.order.referenceManifest?.[key]}
                            alt={`${label} operator reference`}
                            className="aspect-square w-full rounded-md object-cover"
                          />
                        ))}
                      </div>
                    )}
                    <div className="text-xs opacity-70">
                      {operatorSelection.order.subjectProfile} · maximum charged {operatorSelection.quote.total} PupCoins
                    </div>
                    {operatorSelection.currentStage?.validationReport?.checks.map((check) => (
                      <div key={check.id} className="flex gap-2 text-xs">
                        <span className={check.passed === true ? "text-emerald-300" : "text-red-300"}>
                          {check.passed === true ? "✓" : "×"}
                        </span>
                        <span>{check.detail}</span>
                      </div>
                    ))}
                    {operatorPreviewUrl ? (
                      <PetModelViewer
                        src={operatorPreviewUrl}
                        alt="Operator final-version preview"
                        className="h-64 w-full overflow-hidden rounded-xl"
                      />
                    ) : (
                      <p className="text-xs opacity-60">Loading the private final version…</p>
                    )}
                    <button
                      type="button"
                      onClick={releaseOperatorOrder}
                      disabled={busy || !operatorPreviewUrl || !operatorSelection.order.finalCustomerVersionId}
                      className="w-full rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-40"
                    >
                      Approve exact version & release
                    </button>
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1.4fr_0.8fr]">
          <section className="min-h-[480px] overflow-hidden rounded-3xl border border-white/15 bg-black/20 backdrop-blur-xl">
            {stage?.stage === "reference" && view.order.referenceManifest ? (
              <div className="grid h-full grid-cols-2 gap-3 p-4 sm:grid-cols-3">
                {REFERENCE_FIELDS.map(([key, label]) => (
                  <figure key={key} className="overflow-hidden rounded-2xl border border-white/15 bg-black/20">
                    <img src={view.order.referenceManifest?.[key]} alt={`${label} reference`} className="aspect-square h-auto w-full object-cover" />
                    <figcaption className="px-3 py-2 text-xs">{label}</figcaption>
                  </figure>
                ))}
              </div>
            ) : previewUrl ? (
              <PetModelViewer src={previewUrl} alt={`${stage ? STAGE_LABELS[stage.stage] : "Model"} preview`} className="h-[520px] w-full" />
            ) : (
              <div className="flex min-h-[480px] items-center justify-center p-8 text-center">
                <div className="max-w-md space-y-3">
                  <div className="text-lg font-medium">{stage ? STAGE_LABELS[stage.stage] : "Final review"}</div>
                  <p className="text-sm opacity-65">
                    {stage?.state === "processing" || stage?.state === "queued"
                      ? `This stage is running${view.progress !== undefined ? ` · ${view.progress}%` : ""}.`
                      : stage?.assetVersionId
                        ? "The GLB is stored privately. Load its short-lived preview when you are ready to inspect it."
                        : "Complete the current controls to continue."}
                  </p>
                  {stage?.assetVersionId && (
                    <button onClick={loadPreview} disabled={busy} className="rounded-2xl border border-cyan-300/40 px-4 py-2 text-sm">
                      Load secure 3D preview
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>

          <aside className="space-y-4">
            <ol className="space-y-2 rounded-3xl border border-white/15 bg-white/[0.07] p-4 backdrop-blur-xl">
              {selectedStages.map((kind) => {
                const active = stage?.stage === kind;
                const stageIndex = selectedStages.indexOf(kind);
                const activeIndex = stage ? selectedStages.indexOf(stage.stage) : selectedStages.length;
                const done = stageIndex < activeIndex || (active && stage?.state === "approved");
                return (
                  <li key={kind} className="flex items-center gap-3 text-sm">
                    <span className={`h-3 w-3 rounded-full ${done ? "bg-emerald-400" : active ? "animate-pulse bg-cyan-300" : "bg-white/20"}`} />
                    <span className={active ? "font-semibold" : done ? "opacity-65" : "opacity-40"}>{STAGE_LABELS[kind]}</span>
                  </li>
                );
              })}
              <li className="flex items-center gap-3 text-sm">
                <span className={`h-3 w-3 rounded-full ${view.order.state === "approved" || view.order.state === "delivered" ? "bg-emerald-400" : "bg-white/20"}`} />
                <span className="opacity-65">Final quality review</span>
              </li>
            </ol>

            {view.order.state === "awaiting_references" && (
              <div className="space-y-3 rounded-3xl border border-white/15 bg-white/[0.07] p-4">
                <h2 className="font-semibold">Add one source image</h2>
                <p className="text-xs opacity-60">One clear image is enough. Pawsome3D generates the complete multi-angle set for your approval.</p>
                {REFERENCE_FIELDS.map(([key, label]) => (
                  <label key={key} className="block text-xs">
                    <span className="mb-1 block opacity-75">{label}{key === "frontUrl" ? "" : " · optional"}</span>
                    <input type="url" value={references[key] || ""} onChange={(event) => setReferences((current) => ({ ...current, [key]: event.target.value }))}
                      className="w-full rounded-xl border border-white/15 bg-black/20 px-3 py-2" placeholder="https://…" />
                  </label>
                ))}
                <button onClick={saveReferences} disabled={busy || !primaryReferenceReady}
                  className="w-full rounded-2xl bg-cyan-500 px-4 py-2.5 font-semibold text-slate-950 disabled:opacity-40">
                  Generate 360° views
                </button>
              </div>
            )}

            {stage && (
              <div className="space-y-3 rounded-3xl border border-white/15 bg-white/[0.07] p-4 backdrop-blur-xl">
                <div>
                  <h2 className="font-semibold">{STAGE_LABELS[stage.stage]}</h2>
                  <p className="text-xs opacity-60">
                    Attempt {stage.attemptNumber}
                    {stage.priceCredits > 0 ? ` · ${stage.priceCredits} PupCoins ${stage.creditsDisposition}` : " · no charge"}
                  </p>
                </div>

                {(stage.state === "queued" || stage.state === "processing") && stage.stage !== "reference" && (
                  <button onClick={poll} disabled={busy} className="w-full rounded-2xl border border-cyan-300/40 px-4 py-2.5">
                    {busy ? "Checking…" : "Check stage progress"}
                  </button>
                )}

                {stage.validationReport && (
                  <div className="space-y-2 text-xs">
                    {stage.validationReport.triangleCount !== undefined && (
                      <div className="rounded-xl bg-black/20 px-3 py-2">
                        Measured triangles: <strong>{stage.validationReport.triangleCount.toLocaleString()}</strong>
                        {" · "}limit {view.meshPolicy.maxTriangles.toLocaleString()}
                      </div>
                    )}
                    {stage.validationReport.checks.map((check) => (
                      <div key={check.id} className="flex gap-2">
                        <span className={check.passed === true ? "text-emerald-300" : "text-red-300"}>{check.passed === true ? "✓" : "×"}</span>
                        <span>{check.detail}</span>
                      </div>
                    ))}
                  </div>
                )}

                {stage.stage === "rig_check" && stage.capabilityReport && (
                  <div className={`rounded-xl px-3 py-2 text-xs ${stage.capabilityReport.riggable ? "bg-emerald-400/10" : "bg-red-400/10"}`}>
                    {stage.capabilityReport.riggable
                      ? `Compatible ${stage.capabilityReport.rigType} rig confirmed.`
                      : "Rig compatibility was not confirmed. You will not be charged for rigging."}
                  </div>
                )}

                {canApprove && (
                  <button onClick={approve} disabled={busy} className="w-full rounded-2xl bg-emerald-500 px-4 py-2.5 font-semibold text-slate-950 disabled:opacity-50">
                    {stage.stage === "reference"
                      ? `Approve generated 360° views & build base · ${view.quote.base} PupCoins`
                      : stage.stage === "base" && view.order.includeTexture
                        ? `Approve base & add texture · ${view.quote.texture} PupCoins`
                        : stage.stage === "rig_check"
                          ? `Approve rigging · ${view.quote.rig} PupCoins`
                          : `Approve ${STAGE_LABELS[stage.stage]}`}
                  </button>
                )}

                {stage.state === "awaiting_customer_approval" && (
                  <div className="space-y-2 border-t border-white/10 pt-3">
                    <textarea value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value.slice(0, 500))}
                      className="min-h-20 w-full rounded-xl border border-white/15 bg-black/20 p-2 text-xs"
                      placeholder="What must be corrected?" />
                    <button onClick={reject} disabled={busy || rejectionReason.trim().length < 3}
                      className="w-full rounded-xl border border-red-300/30 px-3 py-2 text-xs disabled:opacity-40">
                      Request remake
                    </button>
                  </div>
                )}

                {stage.state === "rejected" && stage.stage !== "reference" && (
                  <button onClick={retry} disabled={busy} className="w-full rounded-2xl bg-cyan-500 px-4 py-2.5 font-semibold text-slate-950">
                    Retry {STAGE_LABELS[stage.stage]}
                    {stage.attemptNumber > 1 ? " · 5 PupCoins" : " · first retry free"}
                  </button>
                )}
              </div>
            )}

            {view.order.state === "stage_rejected" && stage?.stage === "reference" && (
              <button onClick={() => setView({ ...view, order: { ...view.order, state: "awaiting_references" } })}
                className="w-full rounded-2xl border border-cyan-300/40 px-4 py-2.5">
                Update reference links
              </button>
            )}

            {view.order.state === "awaiting_human_review" && (
              <div className="rounded-3xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm">
                Your exact approved GLB is in final quality review. No later version can be substituted.
              </div>
            )}

            {(view.order.state === "approved" || view.order.state === "delivered") && (
              <div className="space-y-3 rounded-3xl border border-emerald-300/25 bg-emerald-300/10 p-4">
                <h2 className="font-semibold">Your model is ready</h2>
                <button onClick={download} disabled={busy} className="w-full rounded-2xl bg-emerald-500 px-4 py-2.5 font-semibold text-slate-950">
                  Create secure download link
                </button>
                {downloadUrl && <a href={downloadUrl} download className="block text-center text-sm underline">Download approved .glb</a>}
              </div>
            )}

            <div className="rounded-2xl border border-white/10 px-3 py-2 text-xs opacity-65">
              Order {view.order.orderUuid.slice(0, 8)} · {view.order.meshProfile === "smart_mesh" ? "SmartMesh" : "HD"} · {view.order.subjectProfile}
            </div>
          </aside>
        </div>
      )}

      {error && <div role="alert" className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</div>}
      {view && (
        <button type="button" onClick={() => setView(null)} className="text-sm opacity-65 underline">
          Back to model builds
        </button>
      )}
    </div>
  );
}

function PriceRow({ label, value, muted, strong }: { label: string; value: number; muted?: boolean; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between text-sm ${muted ? "opacity-40" : ""} ${strong ? "font-semibold" : ""}`}>
      <span>{label}</span>
      <span>{value} PupCoins</span>
    </div>
  );
}

const PRINT_EXAMPLES = [
  { src: "/model-lab/3dashephardmod.png", alt: "Australian Shepherd collectible on an engraved base" },
  { src: "/model-lab/3dbetsy.png", alt: "Dalmatian puppy print on a Betsy name base" },
  { src: "/model-lab/3dbodhi.png", alt: "Small fluffy dog print on an engraved base" },
  { src: "/model-lab/3dgermanshepmod.png", alt: "German Shepherd figurine on a Fido name base" },
  { src: "/model-lab/3dgoldenmod.png", alt: "Golden doodle figurine on a Reggie name base" },
] as const;

function PrintGallery() {
  return (
    <div className="border-t border-white/10 bg-black/25 p-4">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-200">Made physical</p>
          <h3 className="text-lg font-semibold">Personalized 3D printed keepsakes</h3>
        </div>
        <span className="text-xs opacity-55">Printed examples</span>
      </div>
      <div className="grid grid-cols-5 gap-2">
        {PRINT_EXAMPLES.map((example) => (
          <figure key={example.src} className="group aspect-square overflow-hidden rounded-xl border border-white/10 bg-white/5">
            <img src={example.src} alt={example.alt} loading="lazy"
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
          </figure>
        ))}
      </div>
    </div>
  );
}
