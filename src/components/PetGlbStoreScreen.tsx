import { useCallback, useEffect, useState } from "react";
import { authedFetch } from "../api";

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

export default function PetGlbStoreScreen() {
  const [product, setProduct] = useState<Product | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

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

  const refresh = () => {
    if (!order) return;
    call(`/api/pet-glb/orders/${order.orderUuid}/poll`, { method: "POST" })
      .then((r) => setOrder(r.order ?? r))
      .catch(() => {});
  };

  const download = () => {
    if (!order) return;
    call(`/api/pet-glb/orders/${order.orderUuid}/download`, { method: "POST" })
      .then((r) => setDownloadUrl(r.url))
      .catch(() => {});
  };

  const allRefsPresent = product?.referenceRequirements.required.every((k) => refs[k]?.trim()) ?? false;

  if (error && !product) {
    return <div className="p-6 text-sm text-red-500">{error}</div>;
  }
  if (!product) return <div className="p-6 text-sm opacity-70">Loading…</div>;

  return (
    <div className="mx-auto max-w-3xl p-6 space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{product.name}</h1>
        <ul className="text-sm opacity-80 list-disc pl-5">
          {product.deliverables.map((d) => <li key={d}>{d}</li>)}
        </ul>
        {product.operatorApprovalRequired && (
          <p className="text-sm rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2">
            Every model is reviewed by our team before it is delivered to you.
          </p>
        )}
      </header>

      <section className="space-y-2">
        <h2 className="font-medium">Photo requirements</h2>
        <ul className="text-sm opacity-80 list-disc pl-5 space-y-1">
          {product.referenceRequirements.guidance.map((g) => <li key={g}>{g}</li>)}
        </ul>
      </section>

      {!order ? (
        <button
          onClick={startOrder}
          disabled={busy}
          className="rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {busy ? "Starting…" : "Start my order"}
        </button>
      ) : (
        <section className="space-y-6">
          <div className="rounded-md border px-3 py-2 text-sm">
            <div className="font-medium">{CUSTOMER_STAGE[order.state] ?? order.state}</div>
            <div className="opacity-60 text-xs mt-1">
              Order {order.orderUuid.slice(0, 8)} · {order.creditsReserved} credits {order.creditsDisposition}
            </div>
          </div>

          {["awaiting_payment", "paid", "awaiting_references", "references_received"].includes(order.state) && (
            <div className="space-y-3">
              <h2 className="font-medium">Upload your photos</h2>
              {product.referenceRequirements.required.map((key) => (
                <label key={key} className="block text-sm">
                  <span className="block mb-1">{VIEW_LABELS[key] ?? key}</span>
                  <input
                    type="url"
                    placeholder="https://…"
                    value={refs[key] ?? ""}
                    onChange={(e) => setRefs((p) => ({ ...p, [key]: e.target.value }))}
                    className="w-full rounded border px-2 py-1"
                  />
                </label>
              ))}
              <button
                onClick={submitReferences}
                disabled={busy || !allRefsPresent}
                className="rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
              >
                {busy ? "Submitting…" : "Submit photos and build my model"}
              </button>
              {!allRefsPresent && (
                <p className="text-xs opacity-60">All five views are required before we can start.</p>
              )}
            </div>
          )}

          {["queued", "generating", "validating", "repair_required", "awaiting_human_review", "approved", "delivering"].includes(order.state) && (
            <button onClick={refresh} disabled={busy} className="rounded-md border px-4 py-2 disabled:opacity-50">
              {busy ? "Checking…" : "Check progress"}
            </button>
          )}

          {(order.state === "approved" || order.state === "delivered") && (
            <div className="space-y-2">
              <button
                onClick={download}
                disabled={busy}
                className="rounded-md bg-emerald-600 px-4 py-2 text-white disabled:opacity-50"
              >
                {busy ? "Preparing…" : "Download my model"}
              </button>
              {downloadUrl && (
                <p className="text-sm">
                  <a href={downloadUrl} className="text-blue-600 underline" download>
                    Download .glb
                  </a>{" "}
                  <span className="opacity-60 text-xs">(link expires in 15 minutes)</span>
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
