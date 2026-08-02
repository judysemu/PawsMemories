export interface LivePetBuildView {
  order: {
    orderUuid: string;
    state: string;
    approvedVersionId?: number | null;
    finalCustomerVersionId?: number | null;
  };
  currentStage: {
    attemptUuid: string;
    stage: string;
    state: string;
    artifactSha256?: string | null;
    assetVersionId?: number | null;
  } | null;
}

export type LiveBuildAction = "poll" | "refresh" | "stop";

const TERMINAL_ORDER_STATES = new Set(["approved", "delivered", "failed", "cancelled", "canceled", "deleted"]);
const ACTIVE_STAGE_STATES = new Set(["queued", "processing"]);

export function liveBuildAction(view: LivePetBuildView | null): LiveBuildAction {
  if (!view || TERMINAL_ORDER_STATES.has(view.order.state.toLowerCase())) return "stop";
  const stage = view.currentStage;
  if (!stage) return "refresh";
  if (stage.state === "awaiting_customer_approval") return "stop";
  if (stage.stage !== "reference" && ACTIVE_STAGE_STATES.has(stage.state)) return "poll";
  if (stage.state === "failed" || stage.state === "rejected") return "stop";
  return "refresh";
}

export function livePreviewIdentity(view: LivePetBuildView | null): string {
  if (!view) return "none";
  const stage = view.currentStage;
  return [
    view.order.orderUuid,
    stage?.attemptUuid || "none",
    stage?.artifactSha256 || "none",
    stage?.assetVersionId ?? "none",
    view.order.finalCustomerVersionId ?? view.order.approvedVersionId ?? "none",
  ].join(":");
}

/**
 * Small selection-aware single-flight gate. It never owns order data; it only
 * prevents overlapping provider refreshes and stale UI delivery.
 */
export class SerializedLiveRefresh {
  private selectedIdentity = "";
  private inFlight = false;

  select(identity: string) {
    this.selectedIdentity = identity;
  }

  async run<T>(identity: string, operation: () => Promise<T>): Promise<T | undefined> {
    if (this.inFlight) return undefined;
    if (!this.selectedIdentity) this.selectedIdentity = identity;
    this.inFlight = true;
    try {
      const result = await operation();
      return this.selectedIdentity === identity ? result : undefined;
    } finally {
      this.inFlight = false;
    }
  }
}
