import { z } from "zod";

export const VisibilitySchema = z.enum(["private", "friends", "community"]);

export const LocationSettingsSchema = z.object({
  visibility: VisibilitySchema,
  sharePreciseWithFriends: z.boolean().default(false),
}).strict();

export const PresenceSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracyMeters: z.number().finite().min(0).max(10_000).optional(),
  petId: z.number().int().positive().optional(),
}).strict();

export const UserReportSchema = z.object({
  reportedUserId: z.number().int().positive(),
  reason: z.enum(["unsafe_behavior", "harassment", "spam", "false_information", "other"]),
  details: z.string().trim().max(1000).default(""),
}).strict();

export const ModerationDecisionSchema = z.object({
  status: z.enum(["reviewing", "resolved", "dismissed"]),
}).strict();

export const FriendshipDecisionSchema = z.object({
  status: z.enum(["accepted", "declined"]),
}).strict();

export const HazardSchema = z.object({
  type: z.enum(["broken_glass", "aggressive_dog", "hot_pavement", "foxtails_burrs", "poison_or_trash", "path_blocked"]),
  severity: z.enum(["caution", "moderate", "severe", "critical"]),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  notes: z.string().trim().max(500).default(""),
}).strict();

export function parseId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
