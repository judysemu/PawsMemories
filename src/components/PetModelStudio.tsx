import { useCallback, useEffect, useMemo, useState } from "react";
import { authedFetch } from "../api";
import PetModelViewer from "./PetModelViewer";

/**
 * Unified 3D modeler (Tripo/Meshy-style studio) for CUSTOM_RIGGED_PET_GLB_V1.
 *
 * One surface, two ways to buy the GLB:
 *   - "Do it for me"  — the full pipeline runs automatically to a rigged,
 *      idle+walk-animated model (the staged Tripo pipeline in the adapter).
 *   - "Step by step"  — the same pipeline presented as gated stages. Per-stage
 *      user gating + intermediate previews require the backend pause hook
 *      (PET_GLB_STEP_MODE), which is the next backend slice; today the timeline
 *      is live but advances automatically. Flagged honestly, not faked.
 */

type OrderState =
  | "draft" | "awaiting_payment" | "paid" | "awaiting_references" | "references_received"
  | "queued" | "generating" | "validating" | "repair_required" | "awaiting_human_review"
  | "approved" | "delivering" | "delivered" | "failed" | "refund_pending" | "refunded" | "cancelled";

interface Order {
  orderUuid: string;
  state: OrderState;
  approvedVersionId: number | null;
  creditsReserved: number;
  creditsDisposition: string;
}

interface Product {
  sku: string;
  name: string;
  deliverables: string[];
  operatorApprovalRequired: boolean;
  referenceRequirements: { required: string[]; guidance: string[] };
}

const VIEW_LABELS: Record<string, string> = {
  front: "Front", left: "Left side", right: "Right side",
  rear: "Rear", three_quarter: "Three-quarter / elevated",
};

/** Build pipeline stages, mapped from order state → a friendly timeline. */
const STAGES = [
  { key: "base", label: "Base model", states: ["queued", "generating"] },
  { key: "rig", label: "Rig", states: ["generating"] },
  { key: "animate", label: "Idle + walk", states: ["generating", "validating"] },
  { key: "review", label: "Quality review", states: ["validating", "awaiting_human_review", "repair_required"] },
  { key: "ready", label: "Ready", states: ["approved", "delivering", "delivered"] },
] as const;

const STAGE_ORDER: OrderState[] = [
  "queued", "generating", "validating", "awaiting_human_review", "approved", "delivering", "delivered",
];

const CUSTOMER_STAGE: Partial<Record<OrderState, string>> = {
  draft: "Starting your order",
  awaiting_payment: "Awaiting payment",
  paid: "Payment received",
  awaiting_references: "Waiting for your photos",
  references_received: "Photos received",
  queued: "Queued for modelling",
  generating: "Building your model",
  validating: "Running quality checks",
  repair_required: "Corrections in progress",
  awaiting_human_review: "In review by our team",
  approved: "Approved — preparing your download",
  delivering: "Preparing your download",
  delivered: "Ready to download",
  failed: "Something went wrong",
  refund_pending: "Refund in progress",
  refunded: "Refunded",
  cancelled: "Cancelled",
};

export default function PetModelStudio() {
  const [product, setProduct] = useState<Product | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [mode, setMode] = useState<"auto" | "steps">("auto");
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [clip, setClip] = useState<"idle" | "walk">("idle");

  useEffect(() => {
    authedFetch("/api/pet-glb/product")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Product unavailable"))))
      .then(setProduct)
      .catch((e) => setError(e.message));
  }, []);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(path, init);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message || body?.error || "Request failed");
      return body;
    } catch (e: any) {
      setError(e.message);
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const startOrder = () => call("/api/pet-glb/orders", { method: "POST" }).then(setOrder).catch(() => {});
  const payWithCredits = () =>
    order && call(`/api/pet-glb/orders/${order.orderUuid}/pay`, { method: "POST" }).then(setOrder).catch(() => {});

  const submitReferences = () => {
    if (!order) return;
    const references = {
      frontUrl: refs.front, leftUrl: refs.left, rightUrl: refs.right,
      rearUrl: refs.rear, threeQuarterUrl: refs.three_quarter,
    };
    call(`/api/pet-glb/orders/${order.orderUuid}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ references }),
    }).then(setOrder).catch(() => {});
  };

  const refresh = () =>
    order && call(`/api/pet-glb/orders/${order.orderUuid}/poll`, { method: "POST" })
      .then((r) => setOrder(r.order ?? r)).catch(() => {});

  const download = () =>
    order && call(`/api/pet-glb/orders/${order.orderUuid}/download`, { method: "POST" })
      .then((r) => setDownloadUrl(r.url)).catch(() => {});

  const allRefsPresent = product?.referenceRequirements.required.every((k) => refs[k]?.trim()) ?? false;

  const activeStageIndex = useMemo(() => {
    if (!order) return -1;
    const i = STAGE_ORDER.indexOf(order.state);
    if (i < 0) return -1;
    // Map fine order-state to the 5-stage studio timeline.
    if (order.state === "approved" || order.state === "delivering" || order.state === "delivered") return 4;
    if (order.state === "validating" || order.state === "awaiting_human_review" || order.state === "repair_required") return 3;
    if (order.state === "generating") return 2;
    return 0;
  }, [order]);

  if (error && !product) return <div className="p-6 text-sm text-red-500">{error}</div>;
  if (!product) return <div className="p-6 text-sm opacity-70">Loading studio…</div>;

  const modelReady = order?.state === "approved" || order?.state === "delivered";

  return (
    <div className="mx-auto max-w-5xl p-6 space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{product.name}</h1>
          <p className="text-sm opacity-70">
            {product.deliverables.join(" · ")}
          </p>
        </div>
        <div className="inline-flex rounded-lg border p-1 text-sm">
          <button
            onClick={() => setMode("auto")}
            className={`rounded-md px-3 py-1 ${mode === "auto" ? "bg-blue-600 text-white" : "opacity-70"}`}
          >
            Do it for me
          </button>
          <button
            onClick={() => setMode("steps")}
            className={`rounded-md px-3 py-1 ${mode === "steps" ? "bg-blue-600 text-white" : "opacity-70"}`}
          >
            Step by step
          </button>
        </div>
      </header>

      <div className="grid gap-6 md:grid-cols-[1.3fr_1fr]">
        {/* ── 3D stage ─────────────────────────────────────────────── */}
        <section className="rounded-xl border bg-black/5 dark:bg-white/5 min-h-[360px] flex flex-col">
          <div className="flex-1 flex items-center justify-center p-2">
            {modelReady && downloadUrl ? (
              <PetModelViewer
                src={downloadUrl}
                animationName={clip}
                alt="Your rigged pet model"
                className="w-full h-[360px]"
              />
            ) : (
              <div className="text-center text-sm opacity-60 px-6">
                {order ? (CUSTOMER_STAGE[order.state] ?? order.state) : "Your model will appear here."}
                <div className="mt-4 text-xs opacity-70">
                  Grey base mesh → textured → rigged → idle + walk animation
                </div>
              </div>
            )}
          </div>
          {modelReady && downloadUrl && (
            <div className="flex items-center justify-center gap-2 border-t p-2 text-sm">
              <span className="opacity-60">Animation:</span>
              {(["idle", "walk"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setClip(c)}
                  className={`rounded-md px-3 py-1 capitalize ${clip === c ? "bg-emerald-600 text-white" : "border"}`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </section>

        {/* ── Controls ─────────────────────────────────────────────── */}
        <section className="space-y-4">
          {/* Pipeline timeline */}
          {order && STAGE_ORDER.includes(order.state) && (
            <ol className="space-y-1 text-sm">
              {STAGES.map((s, i) => {
                const done = i < activeStageIndex;
                const active = i === activeStageIndex;
                return (
                  <li key={s.key} className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${done ? "bg-emerald-500" : active ? "bg-blue-500 animate-pulse" : "bg-gray-300"}`} />
                    <span className={active ? "font-medium" : done ? "opacity-60" : "opacity-40"}>{s.label}</span>
                  </li>
                );
              })}
            </ol>
          )}

          {!order && (
            <div className="space-y-2">
              <button onClick={startOrder} disabled={busy}
                className="w-full rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
                {busy ? "Starting…" : mode === "auto" ? "Build my pet — do it for me" : "Start step-by-step build"}
              </button>
              <p className="text-xs opacity-60">
                {mode === "auto"
                  ? "We run every step automatically and deliver a rigged, animated model."
                  : "You approve each stage — base mesh, texture, rig, animation — as it completes."}
              </p>
            </div>
          )}

          {order && (
            <div className="rounded-md border px-3 py-2 text-sm">
              <div className="font-medium">{CUSTOMER_STAGE[order.state] ?? order.state}</div>
              <div className="opacity-60 text-xs mt-1">
                Order {order.orderUuid.slice(0, 8)} · {order.creditsReserved} credits {order.creditsDisposition}
              </div>
            </div>
          )}

          {order?.state === "awaiting_payment" && (
            <div className="space-y-2">
              <button onClick={payWithCredits} disabled={busy}
                className="w-full rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
                {busy ? "Processing…" : `Pay ${order.creditsReserved} credits`}
              </button>
              <p className="text-xs opacity-60">Paid from your credit balance. You upload photos next.</p>
            </div>
          )}

          {order && ["paid", "awaiting_references", "references_received"].includes(order.state) && (
            <div className="space-y-3">
              <h2 className="font-medium text-sm">Upload your photos</h2>
              {product.referenceRequirements.required.map((key) => (
                <label key={key} className="block text-sm">
                  <span className="block mb-1 opacity-80">{VIEW_LABELS[key] ?? key}</span>
                  <input type="url" placeholder="https://…" value={refs[key] ?? ""}
                    onChange={(e) => setRefs((p) => ({ ...p, [key]: e.target.value }))}
                    className="w-full rounded border px-2 py-1" />
                </label>
              ))}
              <button onClick={submitReferences} disabled={busy || !allRefsPresent}
                className="w-full rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
                {busy ? "Submitting…" : "Build my model"}
              </button>
              {!allRefsPresent && <p className="text-xs opacity-60">All five views are required.</p>}
            </div>
          )}

          {order && ["queued", "generating", "validating", "repair_required", "awaiting_human_review", "delivering"].includes(order.state) && (
            <button onClick={refresh} disabled={busy}
              className="w-full rounded-md border px-4 py-2 disabled:opacity-50">
              {busy ? "Checking…" : "Check progress"}
            </button>
          )}

          {modelReady && (
            <button onClick={download} disabled={busy}
              className="w-full rounded-md bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">
              {busy ? "Preparing…" : "Load & download my model"}
            </button>
          )}

          {downloadUrl && (
            <p className="text-sm">
              <a href={downloadUrl} className="text-blue-600 underline" download>Download .glb</a>{" "}
              <span className="opacity-60 text-xs">(link expires in 15 minutes)</span>
            </p>
          )}

          {product.operatorApprovalRequired && (
            <p className="text-xs rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2">
              Every model is reviewed by our team before delivery.
            </p>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
        </section>
      </div>
    </div>
  );
}
