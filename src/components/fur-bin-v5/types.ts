export type FurBinItemStatus = "active" | "archived" | "deleted";
export type ModerationState = "pending" | "approved" | "rejected" | "suspended";
export type VerificationState = "verified" | "not_verified" | "failed";

export interface MeasuredBadge {
  id: "rig" | "facial" | "animation";
  label: string;
  state: VerificationState;
  evidenceLabel: string;
}

export interface FurBinVersion {
  versionNumber: number;
  createdAt: string;
  sizeBytes: number;
  mimeType: string;
  isCurrent: boolean;
  validationLabel?: string;
}

export interface FurBinDerivative {
  derivativeUuid: string;
  versionNumber: number;
  label: string;
  scope: "private" | "public";
  purpose: "preview" | "showcase" | "print" | "animation" | "other";
  validationLabel?: string;
}

export interface FurBinShowcase {
  showcaseUuid: string;
  title: string;
  description: string | null;
  tags: string[];
  category: string;
  attribution: string | null;
  rightsDeclaration: string;
  commercialEligible: boolean;
  moderationState: ModerationState;
  viewCount: number;
  publishedAt: string | null;
  coverUrl?: string;
  publicViewUrl?: string;
  createdAt: string;
}

export interface FurBinItem {
  itemUuid: string;
  title: string;
  description: string | null;
  tags: string[];
  dimensions: { width: number; height: number; depth: number; unit: string } | null;
  badges: MeasuredBadge[];
  accessoryCount: number;
  derivativeCount: number;
  storageBytes: number;
  status: FurBinItemStatus;
  signedViewUrl?: string;
  coverUrl?: string;
  createdAt: string;
  updatedAt: string;
  currentVersionNumber?: number;
  versions: FurBinVersion[];
  derivatives: FurBinDerivative[];
  showcase?: FurBinShowcase;
  feedbackDecision?: "keep" | "toss";
}

export interface FurBinCollection {
  collectionUuid: string;
  name: string;
  description: string | null;
  itemCount?: number;
}

export interface LibraryFilters {
  query?: string;
  tag?: string;
  collectionUuid?: string;
  hasRig?: boolean;
  hasFacial?: boolean;
  hasAnimations?: boolean;
  page?: number;
  limit?: number;
}

export interface LibraryPage {
  items: FurBinItem[];
  total: number;
  page: number;
  limit: number;
}

export interface PublishShowcaseInput {
  itemUuid: string;
  publicDerivativeUuid: string;
  publicDerivativeVersionNumber: number;
  title: string;
  description?: string;
  tags: string[];
  category: string;
  attribution?: string;
  rightsDeclaration: string;
  commercialEligible: boolean;
}

export interface FurBinClientCapabilities {
  listCollections: boolean;
  versionHistory: boolean;
  rollbackByVersionNumber: boolean;
  archive: boolean;
  separatePublicDerivative: boolean;
  ownerShowcaseLookup: boolean;
}

export interface FurBinV5Api {
  readonly capabilities: FurBinClientCapabilities;
  searchItems(filters: LibraryFilters): Promise<LibraryPage>;
  getItem(itemUuid: string): Promise<FurBinItem>;
  submitFeedback(itemUuid: string, input: { decision: "keep" } | { decision: "toss"; subject: string; message: string }): Promise<{ decision: "keep" | "toss"; emailSent: boolean; feedbackUuid: string }>;
  listCollections(): Promise<FurBinCollection[]>;
  createCollection(input: { name: string; description?: string }): Promise<FurBinCollection>;
  addItemToCollection(collectionUuid: string, itemUuid: string): Promise<void>;
  rollbackVersion(itemUuid: string, versionNumber: number): Promise<FurBinItem>;
  archiveItem(itemUuid: string): Promise<FurBinItem>;
  publishShowcase(input: PublishShowcaseInput): Promise<FurBinShowcase>;
  unpublishShowcase(showcaseUuid: string): Promise<void>;
  getPublicShowcase(showcaseUuid: string): Promise<FurBinShowcase>;
}

export class FurBinClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FurBinClientError";
  }
}
