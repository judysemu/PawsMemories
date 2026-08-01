import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  authedFetch,
  createReferenceSession,
  startReferenceAttempt,
} from "../api";
import PetModelViewer from "./PetModelViewer";
import CreativeDashboard from "./studio/CreativeDashboard";
import {
  liveBuildAction,
  livePreviewIdentity,
  SerializedLiveRefresh,
} from "./pet-model/livePetBuild";

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
  rigGeneration: {
    available: boolean;
    requestCap: number;
    costCapMicroUsd: number;
    reason: string | null;
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
  state: "awaiting_customer_approval" | "queued" | "processing" | "persisting" | "recovery_required" | "approved" | "rejected" | "failed";
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
  const [meshProfile, setMeshProfile] = useState<MeshProfile>("smart_mesh");
  const [subjectProfile, setSubjectProfile] = useState<SubjectProfile>("pet");
  const [includeTexture, setIncludeTexture] = useState(true);
  const [includeRig, setIncludeRig] = useState(true);
  const [textureQuality, setTextureQuality] = useState<TextureQuality>("standard");
  const [stylePreset, setStylePreset] = useState("reference");
  const [styleDirection, setStyleDirection] = useState("");
  const [inputMode, setInputMode] = useState<"image" | "multi" | "generate" | "text">("image");
  const [collarSizeClass, setCollarSizeClass] = useState<CollarSizeClass>("medium_dog");
  const [neckCircumferenceMm, setNeckCircumferenceMm] = useState(400);
  const [collarWidthMm, setCollarWidthMm] = useState(25);
  const [collarClearanceMm, setCollarClearanceMm] = useState(10);
  const [collarColor, setCollarColor] = useState("#2563eb");
  const [collarJob, setCollarJob] = useState<{ jobUuid?: string; state?: string } | null>(null);
  const [collarReadiness, setCollarReadiness] = useState<CollarReadiness | null>(null);
  const [references, setReferences] = useState<Record<string, string>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [generationMessage, setGenerationMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const downloadRequestIdRef = useRef(0);
  const liveRefreshRef = useRef(new SerializedLiveRefresh());
  const previewRequestIdRef = useRef(0);
  const downloadIdentity = view
    ? `${view.order.orderUuid}:${view.order.approvedVersionId ?? "none"}`
    : "none";
  const activeDownloadIdentityRef = useRef(downloadIdentity);
  activeDownloadIdentityRef.current = downloadIdentity;

  useEffect(() => {
    Promise.all([
      authedFetch("/api/pet-glb/product"),
      authedFetch("/api/pet-glb/orders?limit=12"),
    ])
      .then(async ([productResponse, ordersResponse]) => {
        const productBody = await productResponse.json();
        if (!productResponse.ok) throw new Error(productBody?.message || "Model generator is unavailable.");
        setProduct(productBody);
        if (ordersResponse.ok) {
          const orders = await ordersResponse.json() as OrderView[];
          setRecentOrders(orders);
          const requestedOrder = new URLSearchParams(window.location.search).get("order");
          const requestedView = requestedOrder
            ? orders.find((candidate) => candidate.order.orderUuid === requestedOrder)
            : undefined;
          if (requestedView) setView(requestedView);
        }
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

  useEffect(() => {
    const orderUuid = view?.order.orderUuid;
    if (!orderUuid) return;
    const runner = liveRefreshRef.current;
    runner.select(orderUuid);
    const action = liveBuildAction(view);
    if (action === "stop") return;

    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      const next = await runner.run(orderUuid, async () => {
        const currentAction = liveBuildAction(view);
        const stage = view.currentStage;
        if (currentAction === "poll" && stage && stage.stage !== "reference") {
          return await requestJson(`/api/pet-glb/orders/${orderUuid}/stages/${stage.stage}/poll`, { method: "POST" }) as OrderView;
        }
        return await requestJson(`/api/pet-glb/orders/${orderUuid}`) as OrderView;
      }).catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not refresh this build.");
        return undefined;
      });
      if (!cancelled && next) applyView(next);
    };

    timer = window.setTimeout(() => void refresh(), 900);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyView, view]);

  const previewIdentity = livePreviewIdentity(view);
  useEffect(() => {
    const orderUuid = view?.order.orderUuid;
    const versionId = view?.currentStage?.assetVersionId;
    if (!orderUuid || !versionId) return;
    const requestId = ++previewRequestIdRef.current;
    requestJson(`/api/pet-glb/orders/${orderUuid}/stages/current/preview`)
      .then((body) => {
        if (requestId === previewRequestIdRef.current && Number(body.versionId) === versionId) {
          setPreviewUrl(String(body.url));
        }
      })
      .catch((cause) => {
        if (requestId === previewRequestIdRef.current) {
          setError(cause instanceof Error ? cause.message : "The live model preview could not be refreshed.");
        }
      });
    return () => {
      if (requestId === previewRequestIdRef.current) previewRequestIdRef.current += 1;
    };
  }, [previewIdentity, view?.currentStage?.assetVersionId, view?.order.orderUuid]);

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
      setGenerationMessage("Saving your pet and starting the model…");
      const building = await requestJson(`/api/pet-glb/orders/${created.order.orderUuid}/references`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ references: generatedManifest }),
      }) as OrderView;
      setReferences(generatedManifest as Record<string, string>);
      applyView(building);
      setGenerationMessage("Your pet is building live.");
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
    setGenerationMessage(null);
    setError(null);
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
      setCollarReadiness({ ready: true, blockers: [] });
    }
  };

  if (!product && !error) return <div className="p-6 text-sm opacity-70">Loading model generator…</div>;
  if (!product) return <div className="p-6 text-sm text-red-500">{error}</div>;

  const stage = view?.currentStage;
  const primaryReferenceReady = Boolean(references.frontUrl?.trim());
  const selectedStages: StageKind[] = [
    "reference",
    "base",
    ...(view?.order.includeTexture ?? includeTexture ? ["texture" as const] : []),
    ...(view?.order.includeRig ?? includeRig ? ["rig_check" as const, "rig" as const] : []),
  ];

  const activeStageIndex = stage ? selectedStages.indexOf(stage.stage) : -1;
  const progressPercent = view
    ? view.order.state === "approved" || view.order.state === "delivered"
      ? 100
      : Math.max(4, Math.round(((Math.max(activeStageIndex, 0) + (view.progress || 0) / 100) / Math.max(selectedStages.length, 1)) * 100))
    : 0;
  const sourcePoster = view?.order.referenceManifest?.frontUrl || references.frontUrl || null;
  const buildActive = Boolean(stage && ["queued", "processing", "persisting", "recovery_required"].includes(stage.state));
  const currentStatus = view
    ? stage
      ? STAGE_LABELS[stage.stage]
      : view.order.state.replaceAll("_", " ")
    : "Ready for a photo";

  return (
    <CreativeDashboard
      title="Build your pet in 3D"
      subtitle="One continuous workspace from photo to Fur Bin"
      metrics={[
        { label: "Stage", value: currentStatus, tone: buildActive ? "active" : view ? "success" : "neutral" },
        { label: "Overall progress", value: view ? String(progressPercent) + "%" : "Not started", tone: buildActive ? "active" : "neutral" },
        { label: "PupCoins", value: view ? view.order.creditsReserved : total, tone: "neutral" },
        { label: "Saved builds", value: recentOrders.length, tone: "neutral" },
      ]}
      left={(
        <div className="space-y-4">
          <section>
            <h2 className="text-xs font-black uppercase tracking-[0.16em] text-on-surface-variant">Your pet</h2>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(["image", "multi"] as const).map((mode) => (
                <button key={mode} type="button" disabled={Boolean(view)} onClick={() => setInputMode(mode)}
                  className={inputMode === mode ? "rounded-xl bg-primary px-3 py-2 text-xs font-black text-on-primary" : "rounded-xl border border-outline-variant/35 px-3 py-2 text-xs font-black"}>
                  {mode === "image" ? "One photo" : "Four angles"}
                </button>
              ))}
            </div>
            <label className="mt-3 flex min-h-24 cursor-pointer items-center justify-center rounded-2xl border-2 border-dashed border-primary/35 bg-primary/5 p-3 text-center">
              <input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={loadReferenceFiles} disabled={Boolean(view)} />
              <span className="text-xs"><strong className="block text-sm">Choose pet photos</strong>{inputMode === "multi" ? "Four angles required: front, left, rear, and right" : "One clear full-body photo"}</span>
            </label>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {UPLOAD_FIELDS.map(([key, label]) => (
                <div key={key} className="relative aspect-square overflow-hidden rounded-lg border border-outline-variant/30 bg-surface-container">
                  {references[key]
                    ? <img src={references[key]} alt={label} className="h-full w-full object-cover" />
                    : <span className="grid h-full place-items-center px-1 text-center text-[9px] text-on-surface-variant">{key === "frontUrl" ? "Front" : "+"}</span>}
                  {references[key] && !view && <button type="button" onClick={() => removeReference(key)} aria-label={`Remove ${label} image`} className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/70 text-white">×</button>}
                </div>
              ))}
            </div>
          </section>

          <section className="border-t border-outline-variant/25 pt-4">
            <h2 className="text-xs font-black uppercase tracking-[0.16em] text-on-surface-variant">Model finish</h2>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(["smart_mesh", "hd"] as const).map((profile) => (
                <button key={profile} type="button" disabled={Boolean(view)} onClick={() => setMeshProfile(profile)}
                  className={meshProfile === profile ? "rounded-xl border border-primary bg-primary/10 p-3 text-left text-xs font-black text-primary" : "rounded-xl border border-outline-variant/35 p-3 text-left text-xs font-black"}>
                  {profile === "smart_mesh" ? "SmartMesh" : "HD detail"}
                </button>
              ))}
            </div>
            <label className="mt-3 flex items-start gap-3 rounded-xl border border-outline-variant/30 p-3 text-xs">
              <input type="checkbox" checked={includeTexture} disabled={Boolean(view)} onChange={(event) => setIncludeTexture(event.target.checked)} />
              <span><strong className="block">Add lifelike color</strong><span className="text-on-surface-variant">Uses your pet's markings and coat colors.</span></span>
            </label>
            <label className="mt-2 flex items-start gap-3 rounded-xl border border-outline-variant/30 p-3 text-xs">
              <input type="checkbox" checked={includeRig} disabled={Boolean(view) || !product.rigGeneration.available} onChange={(event) => setIncludeRig(event.target.checked)} />
              <span><strong className="block">Make animation-ready</strong><span className="text-on-surface-variant">{product.rigGeneration.available ? "Adds a pet body skeleton after texturing." : product.rigGeneration.reason}</span></span>
            </label>
            <p className="mt-2 text-[10px] leading-relaxed text-on-surface-variant">Animation-ready body rig · {product.prices.rig} PupCoins. Facial blendshapes are separate from the body/skeletal rig above. AI behavior is not embedded in the GLB.</p>
            {includeTexture && (
              <div className="mt-3">
                <label className="text-xs font-bold text-on-surface-variant">Color style</label>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {STYLE_PRESETS.map((preset) => (
                    <button key={preset.id} type="button" disabled={Boolean(view)} onClick={() => setStylePreset(preset.id)}
                      className={stylePreset === preset.id ? "rounded-full bg-primary px-3 py-1.5 text-[10px] font-black text-on-primary" : "rounded-full border border-outline-variant/35 px-3 py-1.5 text-[10px] font-black"}>
                      {preset.label}
                    </button>
                  ))}
                </div>
                <textarea value={styleDirection} disabled={Boolean(view)} onChange={(event) => setStyleDirection(event.target.value.slice(0, 400))}
                  className="mt-2 min-h-16 w-full resize-none rounded-xl border border-outline-variant/35 bg-surface-container-low p-2 text-xs"
                  placeholder="Optional: describe a collar, coat finish, or markings to preserve" />
              </div>
            )}
          </section>

          {!view ? (
            <button type="button" onClick={start} disabled={busy || (!primaryReferenceReady && inputMode !== "text")}
              className="w-full rounded-2xl bg-primary px-4 py-3 text-sm font-black text-on-primary shadow-lg disabled:opacity-40">
              {busy ? "Starting your pet…" : "Build my pet · up to " + total + " PupCoins"}
            </button>
          ) : (
            <button type="button" onClick={() => selectOrder(view)} className="w-full rounded-2xl border border-primary/30 px-4 py-2 text-xs font-black text-primary">
              Live build connected
            </button>
          )}
        </div>
      )}
      center={(
        <div className="relative h-full min-h-[420px] overflow-hidden bg-[radial-gradient(circle_at_50%_35%,rgba(14,165,233,0.20),transparent_42%),linear-gradient(145deg,#eef2f7,#cbd5e1)]">
          <div className="absolute left-3 top-3 z-30 rounded-full bg-black/65 px-3 py-1.5 text-xs font-black text-white backdrop-blur">
            Live model viewer
          </div>
          {previewUrl ? (
            <div className="absolute inset-0">
              <PetModelViewer src={previewUrl} poster={sourcePoster || undefined} alt="Live model of your pet" autoRotate={false} thumbnail={false} className="h-full w-full" />
            </div>
          ) : stage?.stage === "reference" && view?.order.referenceManifest ? (
            <div className="grid h-full grid-cols-2 gap-2 p-12 sm:grid-cols-3">
              {REFERENCE_FIELDS.map(([key, label]) => (
                <figure key={key} className="overflow-hidden rounded-xl border border-white/60 bg-white/70 shadow">
                  <img src={view.order.referenceManifest?.[key]} alt={label} className="h-[calc(100%-28px)] w-full object-cover" />
                  <figcaption className="px-2 py-1 text-center text-[10px] font-black text-slate-700">{label}</figcaption>
                </figure>
              ))}
            </div>
          ) : sourcePoster ? (
            <div className="absolute inset-0 flex items-center justify-center p-12">
              <img src={sourcePoster} alt="Your pet reference" className="max-h-full max-w-full rounded-2xl object-contain shadow-2xl" />
            </div>
          ) : (
            <div className="absolute inset-0 grid place-items-center p-8 text-center text-slate-600">
              <div><div className="text-6xl">🐾</div><h2 className="mt-3 text-xl font-black">Your pet will appear here</h2><p className="mt-1 text-sm">Choose a clear photo to begin.</p></div>
            </div>
          )}

          {(busy || buildActive) && (
            <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden bg-slate-950/30 backdrop-blur-[1px]">
              <div className="absolute inset-x-[12%] bottom-0 top-0 bg-[linear-gradient(180deg,transparent,rgba(34,211,238,.18),transparent)] animate-pulse" />
              {Array.from({ length: 10 }, (_, index) => (
                <span key={index} className="absolute bottom-[-12%] h-20 w-px animate-[rise_2.6s_linear_infinite] bg-cyan-200/80 shadow-[0_0_12px_3px_rgba(34,211,238,.55)]"
                  style={{ left: String(8 + index * 9) + "%", animationDelay: String(index * 0.16) + "s" }} />
              ))}
              <div aria-live="polite" className="absolute inset-x-0 bottom-6 text-center text-white">
                <strong className="rounded-full bg-black/65 px-4 py-2 text-sm backdrop-blur">{generationMessage || currentStatus}</strong>
              </div>
            </div>
          )}

          {view && (
            <div className="absolute inset-x-4 bottom-3 z-30 h-2 overflow-hidden rounded-full bg-black/25">
              <div className="h-full rounded-full bg-cyan-400 transition-[width] duration-700" style={{ width: String(progressPercent) + "%" }} />
            </div>
          )}
        </div>
      )}
      right={(
        <div className="space-y-4">
          <section>
            <h2 className="text-xs font-black uppercase tracking-[0.16em] text-on-surface-variant">Build journey</h2>
            <ol className="mt-3 space-y-2">
              {selectedStages.map((kind, index) => {
                const active = stage?.stage === kind;
                const complete = view ? index < activeStageIndex || (active && stage?.state === "approved") : false;
                return (
                  <li key={kind} className="flex items-center gap-3 rounded-xl border border-outline-variant/20 px-3 py-2 text-xs">
                    <span className={complete ? "h-2.5 w-2.5 rounded-full bg-emerald-500" : active ? "h-2.5 w-2.5 animate-pulse rounded-full bg-primary" : "h-2.5 w-2.5 rounded-full bg-outline-variant"} />
                    <span className={active ? "font-black text-primary" : complete ? "font-bold" : "text-on-surface-variant"}>{STAGE_LABELS[kind]}</span>
                  </li>
                );
              })}
              <li className="flex items-center gap-3 rounded-xl border border-outline-variant/20 px-3 py-2 text-xs">
                <span className={view && ["approved", "delivered"].includes(view.order.state) ? "h-2.5 w-2.5 rounded-full bg-emerald-500" : "h-2.5 w-2.5 rounded-full bg-outline-variant"} />
                <span className="font-bold">Saved to Fur Bin</span>
              </li>
            </ol>
            {stage && (
              <div className="mt-3 rounded-xl bg-surface-container-low p-3 text-xs">
                <strong>{STAGE_LABELS[stage.stage]}</strong>
                <p className="mt-1 text-on-surface-variant">Attempt {stage.attemptNumber}{stage.priceCredits > 0 ? " · " + stage.priceCredits + " PupCoins " + stage.creditsDisposition : ""}</p>
                {stage.validationReport && <p className="mt-1">{stage.validationReport.operatorReady ? "Quality checks passed." : "Quality checks need attention."}</p>}
              </div>
            )}
          </section>

          {error && <div role="alert" className="rounded-xl border border-error/30 bg-error/10 p-3 text-xs font-bold text-error">{error}</div>}

          {stage && ["failed", "rejected"].includes(stage.state) && stage.stage !== "reference" && (
            <button type="button" onClick={retry} disabled={busy} className="w-full rounded-xl bg-primary px-3 py-2 text-xs font-black text-on-primary">
              Retry this stage at full price
            </button>
          )}

          {view && ["approved", "delivered"].includes(view.order.state) && (
            <section className="space-y-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
              <strong className="block text-sm">Your pet is ready</strong>
              <button type="button" onClick={download} disabled={busy} className="w-full rounded-xl bg-emerald-600 px-3 py-2 font-black text-white">Create download link</button>
              {downloadUrl && <a href={downloadUrl} download className="block text-center font-black underline">Download your 3D pet</a>}
              <p>Saved automatically in Fur Bin.</p>
            </section>
          )}

          {view?.order.approvedVersionId && (
            <details className="rounded-xl border border-outline-variant/30 p-3 text-xs">
              <summary className="cursor-pointer font-black">Custom-fit collars</summary>
              <div className="mt-3 space-y-2">
                <p className="text-on-surface-variant">Collar ordering stays disabled before any PupCoins can be charged unless the production worker is ready.</p>
                <select value={collarSizeClass} onChange={(event) => setCollarSizeClass(event.target.value as CollarSizeClass)} className="w-full rounded-lg border border-outline-variant/30 bg-surface p-2">
                  <option value="kitten_toy">Kitten / toy</option><option value="cat_mini">Cat / mini</option><option value="medium_dog">Medium dog</option><option value="large_dog">Large dog</option>
                </select>
                <input aria-label="Collar color" type="color" value={collarColor} onChange={(event) => setCollarColor(event.target.value)} className="h-9 w-full" />
                <button type="button" onClick={buildCollar} disabled={busy || collarReadiness?.ready !== true} className="w-full rounded-lg bg-primary px-3 py-2 font-black text-on-primary disabled:opacity-40">Build fitted collar</button>
                {collarJob && <p>Collar job {collarJob.jobUuid?.slice(0, 8)} · {collarJob.state}</p>}
              </div>
            </details>
          )}

          <section>
            <h2 className="text-xs font-black uppercase tracking-[0.16em] text-on-surface-variant">Your model builds</h2>
            <div className="mt-2 space-y-2">
              {recentOrders.map((item) => (
                <button key={item.order.orderUuid} type="button" onClick={() => selectOrder(item)}
                  className={view?.order.orderUuid === item.order.orderUuid ? "flex w-full items-center gap-2 rounded-xl border border-primary bg-primary/10 p-2 text-left" : "flex w-full items-center gap-2 rounded-xl border border-outline-variant/25 p-2 text-left"}>
                  {item.order.referenceManifest?.frontUrl
                    ? <img src={item.order.referenceManifest.frontUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />
                    : <span className="grid h-10 w-10 place-items-center rounded-lg bg-surface-container">🐾</span>}
                  <span className="min-w-0"><strong className="block truncate text-xs">{item.order.meshProfile === "smart_mesh" ? "SmartMesh pet" : "HD pet"}</strong><span className="block truncate text-[10px] capitalize text-on-surface-variant">{item.order.state.replaceAll("_", " ")}</span></span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    />
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
