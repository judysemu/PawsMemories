import type { ProviderEvent, ProviderObservation, ProviderSubmission } from "./fulfillment.ts";

export interface FrozenAssetReaderPort {
  readFrozenVersion(assetUuid: string, versionNumber: number): Promise<{
    assetUuid: string;
    versionNumber: number;
    sha256: string;
    byteLength: number;
    contentType: string;
  } | null>;
}

export interface FulfillmentProviderPort {
  readonly provider: "printful" | "slant3d";
  submitFrozenManifest(input: {
    idempotencyKey: string;
    printManifestHash: string;
    frozenFileUrl: string;
    providerSku: string;
    placement: string;
    quantity: number;
    recipient: {
      name: string;
      email: string;
      address1: string;
      address2?: string;
      city: string;
      stateCode?: string;
      countryCode: string;
      postalCode: string;
    };
  }): Promise<{ providerOrderId: string; state: "submitted" | "processing" }>;
  observe(providerOrderId: string | null, idempotencyKey: string): Promise<ProviderObservation>;
  requestRefund(input: { providerOrderId: string; amountMinor: number; idempotencyKey: string }): Promise<{
    state: "requested" | "processing" | "succeeded" | "failed" | "unknown";
    providerRefundId: string | null;
    refundedAmountMinor: number;
  }>;
}

/**
 * The lead implementation must lock by localOrderUuid and persist the transition
 * plus event identity atomically. Provider calls happen outside this transaction.
 */
export interface FulfillmentRepositoryPort {
  getByLocalOrderUuid(localOrderUuid: string): Promise<ProviderSubmission | null>;
  withOrderLock<T>(localOrderUuid: string, work: (repository: FulfillmentLockedRepositoryPort) => Promise<T>): Promise<T>;
}

export interface FulfillmentLockedRepositoryPort {
  /** Backed by UNIQUE(provider, provider_event_id) for permanent replay protection. */
  claimProviderEventId(
    provider: "printful" | "slant3d",
    providerEventId: string,
    localOrderUuid: string,
  ): Promise<"inserted" | "existing" | "conflict">;
  /** Called in the same transaction as claimProviderEventId and saveTransition. */
  recordProviderEventEvidence(input: {
    provider: "printful" | "slant3d";
    localOrderUuid: string;
    event: ProviderEvent;
    disposition: "applied" | "duplicate" | "ignored_stale" | "requires_reconciliation";
    reason: string;
    recordedAt: string;
  }): Promise<void>;
  insertIfAbsent(snapshot: ProviderSubmission): Promise<"inserted" | "existing">;
  getForUpdate(): Promise<ProviderSubmission | null>;
  saveTransition(expectedUpdatedAt: string, snapshot: ProviderSubmission): Promise<"saved" | "conflict">;
}
