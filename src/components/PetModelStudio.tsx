import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
type CollarSizeClass = "kitten_toy" | "cat_mini" | "medium_dog" | "large_dog";

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
  id?: number;
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

export interface CollarReadiness {
  ready: boolean;
  blockers: string[];
}

type AuthenticatedFetcher = (input: string, init?: RequestInit) => Promise<Response>;

type CollarBuildResult<T> =
  | { status: "created"; readiness: CollarReadiness; job: T }
  | { status: "unready" | "stale"; readiness: CollarReadiness };

const PUBLIC_COLLAR_READINESS_BLOCKERS = new Set([
  "feature_flag",
  "layer8",
  "pixel_worker",
  "blender_worker",
  "orchestrator",
  "readiness_check_failed",
  "readiness_unconfirmed",
  "readiness_unavailable",
  "readiness_stale",
]);

function unavailableCollarReadiness(blocker = "readiness_unavailable"): CollarReadiness {
  return { ready: false, blockers: [blocker] };
}

export async function fetchCollarReadiness(
  fetcher: AuthenticatedFetcher = authedFetch,
): Promise<CollarReadiness> {
  try {
    const response = await fetcher("/api/spatial-generator/health");
    const body = await response.json().catch(() => ({}));
    const blockers = Array.isArray(body?.blockers)
      ? body.blockers.filter(
        (item: unknown): item is string =>
          typeof item === "string" && PUBLIC_COLLAR_READINESS_BLOCKERS.has(item),
      )
      : [];
    const ready = response.ok
      && body?.ready === true
      && body?.featureEnabled === true
      && body?.layer8Configured === true
      && body?.pixelWorkerOnline === true
      && body?.blenderWorkerHealthy === true
      && body?.orchestratorReady === true
      && blockers.length === 0;
    return ready
      ? { ready: true, blockers: [] }
      : { ready: false, blockers: blockers.length > 0 ? blockers : ["readiness_unavailable"] };
  } catch {
    return unavailableCollarReadiness();
  }
}

export async function runReadyCollarBuild<T>(
  submit: () => Promise<T>,
  fetcher: AuthenticatedFetcher = authedFetch,
): Promise<CollarBuildResult<T>> {
  const readiness = await fetchCollarReadiness(fetcher);
  if (!readiness.ready) return { status: "unready", readiness };

  try {
    return { status: "created", readiness, job: await submit() };
  } catch (cause) {
    const error = cause as { status?: unknown; code?: unknown } | null;
    if (error?.status === 503 || error?.code === "SPATIAL_PIPELINE_NOT_READY") {
      return {
        status: "stale",
        readiness: unavailableCollarReadiness("readiness_stale"),
      };
    }
    throw cause;
  }
}

const REFERENCE_FIELDS = [
  ["frontUrl", "Front"],
  ["leftUrl", "Left side"],
  ["rearUrl", "Rear"],
  ["rightUrl", "Right side"],
  ["threeQuarterUrl", "Three-quarter"],
] as const;

const UPLOAD_FIELDS = [
  ["frontUrl", "Front photo"],
  ["leftUrl", "Left photo"],
  ["rearUrl", "Rear photo"],
  ["rightUrl", "Right photo"],
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
  rig_check: "Body-rig readiness",
  rig: "Animation-ready body rig",
};

function idempotencyKey(): string {
  return crypto.randomUUID();
}

async function requestJson(path: string, init?: RequestInit): Promise<any> {
  const response = await authedFetch(path, init);
  const text = await response.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Server returned an unreadable response (${response.status}).`);
  }
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || "Request failed.") as Error & {
      status?: number;
      code?: string;
    };
    error.status = response.status;
    if (typeof body?.error === "string") error.code = body.error;
    throw error;
  }
  return body;
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
  const [collarSizeClass, setCollarSizeClass] = useState<CollarSizeClass>("medium_dog");
  const [neckCircumferenceMm, setNeckCircumferenceMm] = useState(400);
  const [collarWidthMm, setCollarWidthMm] = useState(25);
  const [collarClearanceMm, setCollarClearanceMm] = useState(10);
  const [collarColor, setCollarColor] = useState("#2563eb");
  const [collarJob, setCollarJob] = useState<{ jobUuid?: string; state?: string } | null>(null);
  const [collarReadiness, setCollarReadiness] = useState<CollarReadiness | null>(null);
  const [references, setReferences] = useState<Record<string, string>>({});
  const [referenceSession, setReferenceSession] = useState<{ sessionUuid: string; manifestHash: string } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [generationMessage, setGenerationMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const downloadRequestIdRef = useRef(0);
  const downloadIdentity = view
    ? `${view.order.orderUuid}:${view.order.approvedVersionId ?? "none"}`
    : "none";
  const activeDownloadIdentityRef = useRef(downloadIdentity);
  activeDownloadIdentityRef.current = downloadIdentity;

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
    // A signed URL belongs to one exact order/version. Changing either
    // invalidates both the visible link and any response still in flight.
    downloadRequestIdRef.current += 1;
    setDownloadUrl(null);
  }, [downloadIdentity]);

  useEffect(() => {
    if (!view?.order.approvedVersionId) {
      setCollarReadiness(null);
      return;
    }
    let cancelled = false;
    setCollarReadiness(null);
    fetchCollarReadiness()
      .then((readiness) => {
        if (cancelled) return;
        setCollarReadiness(readiness);
      })
      .catch(() => {
        if (!cancelled) setCollarReadiness({ ready: false, blockers: ["readiness_unavailable"] });
      });
    return () => {
      cancelled = true;
    };
  }, [view?.order.approvedVersionId]);

  useEffect(() => {
    if (!includeTexture) {
      setStylePreset("reference");
      setStyleDirection("");
    }
  }, [includeTexture]);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      return await requestJson(path, init);
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

  const selectOrder = useCallback((next: OrderView) => {
    const nextIdentity = `${next.order.orderUuid}:${next.order.approvedVersionId ?? "none"}`;
    activeDownloadIdentityRef.current = nextIdentity;
    downloadRequestIdRef.current += 1;
    setDownloadUrl(null);
    setView(next);
  }, []);

  const applyView = useCallback((next: OrderView) => {
    selectOrder(next);
    setRecentOrders((current) => [
      next,
      ...current.filter((item) => item.order.orderUuid !== next.order.orderUuid),
    ]);
  }, [selectOrder]);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setGenerationMessage("Preparing your reference session…");
    try {
      const sourceImages = UPLOAD_FIELDS.map(([key]) => references[key]).filter((value): value is string => Boolean(value?.trim()));
      const sourceImage = sourceImages[0];
      if (inputMode !== "text" && !sourceImage) {
        throw new Error("Add one clear pet photo to generate the 360° views.");
      }
      if (inputMode === "multi" && sourceImages.length < UPLOAD_FIELDS.length) {
        throw new Error("Add four photos from different angles before generating the reference set.");
      }
      const session = await createReferenceSession(
        inputMode === "text" ? "text" : "photo",
        inputMode === "text" ? selectedStyle : undefined,
        subjectProfile,
        sourceImage,
        inputMode === "multi" ? sourceImages : undefined,
      );
      setGenerationMessage("Generating the complete 360° view set…");
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
      setGenerationMessage("Creating your private model build…");
      const created = await requestJson("/api/pet-glb/orders", {
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
      setGenerationMessage("Saving the generated views for approval…");
      const withReferences = await requestJson(`/api/pet-glb/orders/${created.order.orderUuid}/references`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ references: generatedManifest }),
      }) as OrderView;
      setReferences(generatedManifest as Record<string, string>);
      setReferenceSession({ sessionUuid: session.sessionUuid, manifestHash });
      applyView(withReferences);
      setGenerationMessage("360° views are ready for your approval.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not generate the 360° views.");
      setGenerationMessage(null);
    } finally {
      setBusy(false);
    }
  };

  const optimizeReferenceFile = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the reference photo."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("The reference photo could not be decoded."));
      image.onload = () => {
        const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      };
      image.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });

  const loadReferenceFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    const emptyKeys = UPLOAD_FIELDS.map(([key]) => key).filter((key) => !references[key]);
    files.slice(0, emptyKeys.length).forEach((file, index) => {
      void optimizeReferenceFile(file).then((dataUrl) => {
        const key = emptyKeys[index];
        setReferences((current) => ({ ...current, [key]: dataUrl }));
      }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not read the reference photo."));
    });
    event.target.value = "";
  };

  const removeReference = (key: string) => {
    setReferences((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setReferenceSession(null);
    setGenerationMessage(null);
    setError(null);
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
    if (!view?.order.approvedVersionId) return;
    const orderUuid = view.order.orderUuid;
    const approvedVersionId = view.order.approvedVersionId;
    const identity = `${orderUuid}:${approvedVersionId}`;
    const requestId = ++downloadRequestIdRef.current;
    setDownloadUrl(null);
    call(`/api/pet-glb/orders/${orderUuid}/download`, { method: "POST" })
      .then((body) => {
        if (
          requestId === downloadRequestIdRef.current
          && identity === activeDownloadIdentityRef.current
          && body.versionId === approvedVersionId
        ) {
          setDownloadUrl(body.url);
        }
      })
      .catch(() => {});
  };

  const buildCollar = async () => {
    const targetAssetVersionId = view?.order.approvedVersionId;
    if (!targetAssetVersionId || collarReadiness?.ready !== true) return;
    setCollarReadiness(null);
    try {
      const result = await runReadyCollarBuild(() => call("/api/spatial-generator/collar/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `collar_${crypto.randomUUID()}`,
          targetAssetVersionId,
          sizeClass: collarSizeClass,
          neckCircumferenceMm,
          strapWidthMm: collarWidthMm,
          clearanceMm: collarClearanceMm,
          strapThicknessMm: 3,
          color: collarColor,
          includeBuckle: true,
          includeDRing: true,
          targetUse: "attachment",
        }),
      }));
      setCollarReadiness(result.readiness);
      if (result.status === "created") setCollarJob(result.job);
    } catch {
      // The fresh health check passed; a non-readiness submission error does not
      // make the worker chain unhealthy.
      setCollarReadiness({ ready: true, blockers: [] });
    }
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
    <div className="h-[calc(100vh-4rem)] w-full overflow-hidden">
      <div className="mx-auto h-full max-w-[1600px] overflow-y-auto space-y-3 p-2 sm:p-3">

      {!view ? (
        <div className="grid gap-3 xl:grid-cols-[280px_minmax(0,1fr)_300px]">
          <section className="space-y-3 rounded-3xl border border-white/15 bg-white/[0.07] p-3 backdrop-blur-xl">
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
                  <strong className="block text-sm">Choose your pet photos</strong>
                  {inputMode === "multi" ? "Four angles required · front, left, rear, and right" : "One clear photo generates the complete view set"}
                </span>
              </label>
              <div className="grid grid-cols-4 gap-1.5">
                {UPLOAD_FIELDS.map(([key, label]) => (
                  <div key={key} className={`relative aspect-square overflow-hidden rounded-lg border ${references[key] ? "border-emerald-300/50" : "border-white/10 bg-black/20"}`}>
                    {references[key]
                      ? <img src={references[key]} alt={`${label} upload`} className="h-full w-full object-cover" />
                      : <span className="flex h-full items-center justify-center px-1 text-center text-[9px] opacity-55">{key === "frontUrl" ? "Required\nphoto" : "Add photo"}</span>}
                    <label className="absolute inset-0 cursor-pointer" aria-label={`Add ${label}`}><input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={loadReferenceFiles} /></label>
                    {references[key] && (
                      <button
                        type="button"
                        onClick={() => removeReference(key)}
                        aria-label={`Remove ${label} image`}
                        className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/75 text-base leading-none text-white shadow"
                      >
                        ×
                      </button>
                    )}
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
              <label className="flex items-start gap-3 rounded-2xl border border-white/15 p-3">
                <input type="checkbox" checked={includeRig} onChange={(event) => setIncludeRig(event.target.checked)} className="mt-1" />
                <span>
                  <span className="text-sm font-medium">Animation-ready body rig · {product.prices.rig} PupCoins</span>
                  <span className="block text-xs opacity-65">
                    Adds a skeleton and skin weights after the base mesh, or after Texture when selected. Animation tools unlock only after compatibility passes.
                  </span>
                </span>
              </label>
              <p className="text-xs opacity-60">Every generated reference set pauses for your approval before the base mesh begins.</p>
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
            <button onClick={start} disabled={busy || (inputMode === "multi" ? UPLOAD_FIELDS.some(([key]) => !references[key]) : inputMode !== "text" ? !primaryReferenceReady : !selectedStyle.trim())}
              className="group relative w-full overflow-hidden rounded-2xl bg-cyan-400 px-4 py-3.5 font-bold text-slate-950 disabled:opacity-40">
              <span className="relative z-10">{busy ? "Generating 360° views…" : "Generate base model"}</span>
              {busy && <span className="absolute inset-0 animate-pulse bg-[radial-gradient(circle_at_20%_80%,#f5d08a_0_2px,transparent_3px)] bg-[length:18px_18px]" />}
            </button>
            {(generationMessage || error) && (
              <div
                role={error ? "alert" : "status"}
                aria-live="polite"
                className={`rounded-2xl border px-3 py-2 text-xs ${error ? "border-red-400/35 bg-red-400/10 text-red-100" : "border-cyan-300/25 bg-cyan-300/10 text-cyan-50"}`}
              >
                {error || generationMessage}
              </div>
            )}
          </section>

          <section className="relative min-h-[620px] overflow-hidden rounded-3xl border border-slate-300/30 bg-[radial-gradient(circle_at_50%_35%,rgba(34,211,238,0.18),transparent_38%),linear-gradient(145deg,rgba(226,232,240,0.96),rgba(203,213,225,0.98))] text-slate-800">
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
            <div className="border-t border-slate-400/30 bg-white/35 p-4">
              <div className="flex items-start gap-4">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-violet-400/15 text-2xl">🦴</span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-violet-200">New accessory</p>
                  <h3 className="mt-1 text-lg font-semibold">Custom-fit collars</h3>
                  <p className="mt-1 text-xs opacity-65">
                    Finish a base model, then enter your pet's neck measurement to build a printable collar with a rigid buckle and D-ring.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                    <span className="rounded-full border border-white/10 px-3 py-1">Cats & dogs</span>
                    <span className="rounded-full border border-white/10 px-3 py-1">5–15 mm fur clearance</span>
                    <span className="rounded-full border border-white/10 px-3 py-1">Approval before export</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <aside className="h-fit space-y-3 rounded-3xl border border-white/15 bg-white/[0.08] p-4 backdrop-blur-xl">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-cyan-300">Build summary</p>
              <h2 className="mt-1 text-xl font-semibold">Build summary</h2>
            </div>
            <PriceRow label="Blank base mesh" value={product.prices.base} />
            <PriceRow label="Texture" value={includeTexture ? product.prices.texture : 0} muted={!includeTexture} />
            <PriceRow label="Animation-ready body rig" value={includeRig ? product.prices.rig : 0} muted={!includeRig} />
            <div className="border-t border-white/15 pt-3">
              <PriceRow label="Maximum total" value={total} strong />
            </div>
            <p className="text-xs opacity-60">Creating the order is free. The base charge happens only when you approve your reference set.</p>
            <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/5 p-3 text-xs">
              <strong className="block text-sm">Simple print checkout</strong>
              Approve model → choose the exact print size in Print Shop → enter shipping → secure card checkout → Slant 3D prints and ships.
            </div>
            <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-3 text-xs">
              Facial blendshapes are separate from the body/skeletal rig above and are not for sale. They return only after at least {Math.round(product.facialRig.minimumSuccessRate * 100)}% measured reliability.
            </div>
            {recentOrders.length > 0 && (
              <div className="space-y-2 border-t border-white/15 pt-4">
                <h2 className="text-sm font-semibold">Recent model orders</h2>
                {recentOrders.map((item) => (
                  <div
                    key={item.order.orderUuid}
                    className="space-y-2 rounded-xl border border-white/10 p-2 text-xs"
                  >
                    <button type="button" onClick={() => selectOrder(item)} className="flex w-full items-center gap-2 text-left">
                      {item.order.referenceManifest?.frontUrl ? <img src={item.order.referenceManifest.frontUrl} alt="Model order reference" className="h-12 w-12 rounded-lg object-cover" /> : <span className="grid h-12 w-12 place-items-center rounded-lg bg-cyan-300/15 text-xl">🐾</span>}
                      <span>
                        <strong className="block">{item.order.meshProfile === "smart_mesh" ? "SmartMesh" : "HD"} model</strong>
                        <span className="block opacity-60">{item.order.subjectProfile}</span>
                        <span className="block capitalize text-cyan-200">{item.order.state.replaceAll("_", " ")}</span>
                      </span>
                    </button>
                    {["approved", "delivered"].includes(item.order.state) && (
                      <a href={item.order.id ? `/print-shop?model=${item.order.id}` : "/print-shop"} className="block rounded-lg bg-cyan-400 px-2 py-1.5 text-center text-[11px] font-bold text-slate-950">Slant3D 3D-print checkout</a>
                    )}
                  </div>
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
                          ? `Approve body rigging · ${view.quote.rig} PupCoins`
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
                    {stage.attemptNumber < 3
                      ? ` · ${stage.attemptNumber === 1 ? "first" : "second"} retry free`
                      : ` · ${stage.stage === "base" ? view.quote.base : stage.stage === "texture" ? view.quote.texture : view.quote.rig} PupCoins`}
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

            {view.order.approvedVersionId && (
              <div className="space-y-3 rounded-3xl border border-violet-300/25 bg-violet-300/10 p-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-violet-200">Mesh accessory builder</p>
                  <h2 className="mt-1 font-semibold">Fit a collar</h2>
                  <p className="mt-1 text-xs opacity-65">Uses the approved model and real millimeter measurements. No additional image is required.</p>
                </div>
                <label className="block text-xs">
                  <span className="mb-1 block opacity-70">Pet size</span>
                  <select value={collarSizeClass} onChange={(event) => {
                    const next = event.target.value as CollarSizeClass;
                    setCollarSizeClass(next);
                    const defaults = {
                      kitten_toy: [200, 9], cat_mini: [265, 11], medium_dog: [400, 22], large_dog: [490, 32],
                    } as const;
                    setNeckCircumferenceMm(defaults[next][0]);
                    setCollarWidthMm(defaults[next][1]);
                  }} className="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2">
                    <option value="kitten_toy">Kitten / Toy breed</option>
                    <option value="cat_mini">Adult cat / Mini dog</option>
                    <option value="medium_dog">Medium dog</option>
                    <option value="large_dog">Large dog</option>
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs">
                    <span className="mb-1 block opacity-70">Neck circumference</span>
                    <input type="number" min="100" max="700" value={neckCircumferenceMm}
                      onChange={(event) => setNeckCircumferenceMm(Number(event.target.value))}
                      className="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2" />
                    <span className="opacity-45">millimeters</span>
                  </label>
                  <label className="text-xs">
                    <span className="mb-1 block opacity-70">Strap width</span>
                    <input type="number" min="8" max="38" value={collarWidthMm}
                      onChange={(event) => setCollarWidthMm(Number(event.target.value))}
                      className="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2" />
                    <span className="opacity-45">millimeters</span>
                  </label>
                </div>
                <label className="block text-xs">
                  <span className="mb-1 flex justify-between opacity-70"><span>Fur / two-finger clearance</span><strong>{collarClearanceMm} mm</strong></span>
                  <input type="range" min="5" max="15" step="1" value={collarClearanceMm}
                    onChange={(event) => setCollarClearanceMm(Number(event.target.value))} className="w-full" />
                </label>
                <label className="flex items-center justify-between text-xs">
                  <span className="opacity-70">Strap color</span>
                  <input type="color" value={collarColor} onChange={(event) => setCollarColor(event.target.value)}
                    className="h-8 w-12 rounded border border-white/15 bg-transparent" />
                </label>
                <div className="rounded-xl bg-black/20 p-3 text-xs opacity-70">
                  Includes a rigid buckle and D-ring. The flexible strap follows upper-neck bones; metal hardware remains rigid.
                </div>
                {collarReadiness?.ready !== true && (
                  <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs text-amber-100">
                    {collarReadiness === null
                      ? "Checking the collar worker chain…"
                      : "Collar generation is unavailable until every worker and the job orchestrator pass readiness. The build is disabled before any PupCoins can be charged."}
                  </div>
                )}
                <button type="button" onClick={buildCollar} disabled={busy || collarReadiness?.ready !== true}
                  className="w-full rounded-2xl bg-violet-400 px-4 py-2.5 font-semibold text-slate-950 disabled:opacity-40">
                  {busy
                    ? "Starting collar build…"
                    : collarReadiness?.ready === true
                      ? "Build collar draft"
                      : "Collar builder unavailable — no charge"}
                </button>
                {collarJob && (
                  <p className="text-xs text-emerald-200">
                    Collar job {collarJob.jobUuid?.slice(0, 8) || "created"} · {collarJob.state || "queued"}. Review is required before final export.
                  </p>
                )}
              </div>
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
