// ─── Phase 5: Fur Bin Domain Types ──────────────────────────────────────────

export type ItemStatus = "active" | "archived" | "deleted";
export type ModerationState = "pending" | "approved" | "rejected" | "suspended";
export type VerificationState = "verified" | "not_verified" | "failed";

export interface MeasuredBadgePublic {
  id: "rig" | "facial" | "animation";
  label: string;
  state: VerificationState;
  evidenceLabel: string;
  manifestHash?: string;
  validatorVersion?: string;
  ruleIds: string[];
}

export interface FurBinVersionPublic {
  versionNumber: number;
  createdAt: string;
  sizeBytes: number;
  mimeType: string;
  isCurrent: boolean;
  validationLabel?: string;
}

export interface FurBinDerivativePublic {
  derivativeUuid: string;
  versionNumber: number;
  label: string;
  scope: "private" | "public";
  purpose: "preview" | "showcase" | "print" | "animation" | "other";
  validationLabel?: string;
}

export interface FurBinItemRecord {
  id: number;
  item_uuid: string;
  owner_id: string;
  asset_id: number;
  current_version_id: number | null;
  title: string;
  description: string | null;
  cover_asset_id: number | null;
  tags_json: string[];
  dimensions_json: { width: number; height: number; depth: number; unit: string } | null;
  has_rig: boolean;
  has_facial: boolean;
  has_animations: boolean;
  accessory_count: number;
  derivative_count: number;
  storage_bytes: number;
  status: ItemStatus;
  created_at: Date;
  updated_at: Date;
}

export interface FurBinCollectionRecord {
  id: number;
  collection_uuid: string;
  owner_id: string;
  name: string;
  description: string | null;
  cover_asset_id: number | null;
  sort_order: number;
  status: ItemStatus;
  created_at: Date;
  updated_at: Date;
}

export interface ShowcaseRecord {
  id: number;
  showcase_uuid: string;
  owner_id: string;
  fur_bin_item_id: number;
  published_version_id: number;
  title: string;
  description: string | null;
  tags_json: string[];
  category: string;
  cover_asset_id: number | null;
  attribution: string | null;
  rights_declaration: string;
  commercial_eligible: boolean;
  moderation_state: ModerationState;
  moderation_notes: string | null;
  view_count: number;
  published_at: Date | null;
  unpublished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ModerationHistoryRecord {
  id: number;
  showcase_id: number;
  previous_state: ModerationState;
  new_state: ModerationState;
  moderator_id: string;
  reason: string | null;
  created_at: Date;
}

// ── Public DTOs ─────────────────────────────────────────────────────────────

export interface FurBinItemPublic {
  itemUuid: string;
  assetUuid?: string;
  title: string;
  description: string | null;
  tags: string[];
  dimensions: { width: number; height: number; depth: number; unit: string } | null;
  hasRig: boolean;
  hasFacial: boolean;
  hasAnimations: boolean;
  accessoryCount: number;
  derivativeCount: number;
  storageBytes: number;
  status: ItemStatus;
  badges: MeasuredBadgePublic[];
  currentVersionNumber?: number;
  versions: FurBinVersionPublic[];
  derivatives: FurBinDerivativePublic[];
  showcase?: ShowcaseRecordPublic;
  signedViewUrl?: string; // Short-lived signed URL for model view
  coverUrl?: string;
  sourceOrderUuid?: string;
  retryPriceCredits?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShowcaseRecordPublic {
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
