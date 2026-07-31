import type { IncomingHttpHeaders } from "node:http";
import type {
  CreateRenderJobRequest,
  PaymentEvidence,
  PrintOrderPublic,
  RenderDispatch,
  RenderJobPublic,
} from "./apiContracts.ts";
import type { SealedPrintManifest, SealedRenderManifest, StationeryValidationReport, TemplateVersionSpec } from "./contracts.ts";
import type { FulfillmentRepositoryPort, FulfillmentProviderPort } from "./ports.ts";
import type { ProviderObservation, ReconciliationDecision } from "./fulfillment.ts";

export interface StationeryTemplateVersionRecord {
  spec: TemplateVersionSpec;
  specHash: string;
  status: "active" | "retired";
}

export interface RenderJobCompletionRecord extends RenderJobPublic {
  ownerId: string;
  request: CreateRenderJobRequest;
  templateSpecHash: string;
}

export interface StationeryAssetEvidence {
  assetUuid: string;
  versionNumber: number;
  sha256: string;
  ownerId: string;
  status: "active" | "archived";
  commercialUseEligible: boolean;
}

export interface RenderJobInsert {
  jobUuid: string;
  ownerId: string;
  idempotencyKey: string;
  requestHash: string;
  request: CreateRenderJobRequest;
  template: StationeryTemplateVersionRecord;
  validationReport: StationeryValidationReport;
  createdAt: string;
}

export interface FrozenPrintOrderInsert {
  localOrderUuid: string;
  ownerId: string;
  renderJobUuid: string;
  clientIdempotencyKey: string;
  requestHash: string;
  manifest: SealedPrintManifest;
  paymentEvidence: PaymentEvidence;
  providerIdempotencyKey: string;
  createdAt: string;
}

export interface StationeryApiRepositoryPort extends FulfillmentRepositoryPort {
  getTemplateVersion(templateUuid: string, versionNumber: number): Promise<StationeryTemplateVersionRecord | null>;
  getAssetEvidence(assetUuid: string, versionNumber: number): Promise<StationeryAssetEvidence | null>;
  createRenderJobIdempotent(input: RenderJobInsert): Promise<{ job: RenderJobPublic; created: boolean }>;
  getRenderJob(ownerId: string, jobUuid: string): Promise<RenderJobPublic | null>;
  getRenderJobByIdempotency(ownerId: string, idempotencyKey: string): Promise<RenderJobPublic | null>;
  getRenderJobForCompletion(jobUuid: string): Promise<RenderJobCompletionRecord | null>;
  recordRenderDispatched(jobUuid: string, updatedAt: string): Promise<void>;
  recordRenderDispatchFailure(jobUuid: string, failureCode: string, updatedAt: string): Promise<void>;
  completeRenderJobImmutable(input: {
    jobUuid: string;
    renderManifest: SealedRenderManifest;
    validationReport: StationeryValidationReport;
    updatedAt: string;
  }): Promise<RenderJobPublic>;
  createFrozenPrintOrderIdempotent(input: FrozenPrintOrderInsert): Promise<{ order: PrintOrderPublic; created: boolean }>;
  getPrintOrder(ownerId: string, localOrderUuid: string): Promise<PrintOrderPublic | null>;
  getPrintOrderByIdempotency(ownerId: string, idempotencyKey: string): Promise<PrintOrderPublic | null>;
  getPrintOrderByUuid(localOrderUuid: string): Promise<(PrintOrderPublic & { ownerId: string }) | null>;
  getPrintOrderByProviderReference(input: { provider: "printful" | "slant3d"; providerIdempotencyKey?: string; providerOrderId?: string }): Promise<PrintOrderPublic | null>;
  recordReconciliation(input: {
    reconciliationUuid: string;
    localOrderUuid: string;
    requestedByOwnerId: string;
    reason: string;
    observation: ProviderObservation | null;
    decision: ReconciliationDecision;
    recordedAt: string;
  }): Promise<void>;
}

export interface RenderDispatcherPort {
  dispatch(input: RenderDispatch): Promise<void>;
}

export interface PaymentEvidenceReaderPort {
  getPaymentEvidence(ownerId: string, paymentUuid: string): Promise<PaymentEvidence | null>;
}

export interface FrozenFileAccessPort {
  createProviderReadUrl(input: {
    ownerId: string;
    assetUuid: string;
    versionNumber: number;
    expectedSha256: string;
  }): Promise<string>;
}

export interface ProviderWebhookAuthenticatorPort {
  authenticate(input: {
    provider: "printful" | "slant3d";
    headers: IncomingHttpHeaders;
    rawBody: Buffer;
  }): Promise<boolean>;
}

export interface RenderCallbackAuthenticatorPort {
  authenticate(input: { headers: IncomingHttpHeaders; rawBody: Buffer }): Promise<boolean>;
}

export type StationeryProviderMap = Readonly<Partial<Record<"printful" | "slant3d", FulfillmentProviderPort>>>;

export interface StationeryClockPort {
  now(): string;
}
