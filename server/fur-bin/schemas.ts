// ─── Phase 5: Fur Bin Zod Validation Schemas ────────────────────────────────
import { z } from "zod";

// ── Search & Filter Request ────────────────────────────────────────────────
export const SearchFurBinRequestSchema = z.object({
  query: z.string().max(200).optional(),
  tag: z.string().max(100).optional(),
  collectionUuid: z.string().uuid().optional(),
  hasRig: z.boolean().optional(),
  hasFacial: z.boolean().optional(),
  hasAnimations: z.boolean().optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();

export type SearchFurBinRequest = z.infer<typeof SearchFurBinRequestSchema>;

export const RegisterFurBinItemRequestSchema = z.object({
  assetUuid: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  title: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
}).strict();

export type RegisterFurBinItemRequest = z.infer<typeof RegisterFurBinItemRequestSchema>;

export const SubmitFurBinDefectReportSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  message: z.string().trim().min(10).max(4000),
}).strict();

export type SubmitFurBinDefectReport = z.infer<typeof SubmitFurBinDefectReportSchema>;

// ── Create Collection Request ──────────────────────────────────────────────
export const CreateCollectionRequestSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
}).strict();

export type CreateCollectionRequest = z.infer<typeof CreateCollectionRequestSchema>;

// ── Add Item to Collection Request ──────────────────────────────────────────
export const AddCollectionItemRequestSchema = z.object({
  itemUuid: z.string().uuid(),
}).strict();

// ── Publish Showcase Request ───────────────────────────────────────────────
export const PublishShowcaseRequestSchema = z.object({
  itemUuid: z.string().uuid(),
  publicDerivativeUuid: z.string().uuid(),
  publicDerivativeVersionNumber: z.number().int().positive(),
  title: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().max(100)).max(20).default([]),
  category: z.string().min(1).max(100).default("general"),
  attribution: z.string().max(500).optional(),
  rightsDeclaration: z.string().max(200).default("all_rights_reserved"),
  commercialEligible: z.boolean().default(false),
}).strict();

export type PublishShowcaseRequest = z.infer<typeof PublishShowcaseRequestSchema>;

// ── Moderation Decision Request (Admin) ────────────────────────────────────
export const ModerationDecisionRequestSchema = z.object({
  newState: z.enum(["approved", "rejected", "suspended"]),
  reason: z.string().min(1).max(1000),
}).strict();

export type ModerationDecisionRequest = z.infer<typeof ModerationDecisionRequestSchema>;

// ── Version Rollback Request ───────────────────────────────────────────────
export const RollbackVersionRequestSchema = z.object({
  versionNumber: z.number().int().positive(),
}).strict();

export const ShowcaseBrowseRequestSchema = z.object({
  query: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();

export const OwnerShowcaseListRequestSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();
