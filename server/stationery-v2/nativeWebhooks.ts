import crypto from "node:crypto";
import { z } from "zod";
import { ProviderEventSchema, type ProviderEvent } from "./fulfillment.ts";

const NativePayload = z.record(z.string(), z.unknown());

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function eventTime(payload: Record<string, unknown>): string {
  const raw = firstString(payload.occurred_at, payload.created, payload.timestamp) ?? new Date().toISOString();
  const date = /^\d+$/.test(raw) ? new Date(Number(raw) * 1000) : new Date(raw);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeStatus(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[- ]/g, "_");
}

export interface NativeReference {
  providerIdempotencyKey: string | null;
  providerOrderId: string | null;
  event: ProviderEvent;
  providerEventId: string;
}

export function parseNativeProviderWebhook(provider: "printful" | "slant3d", input: unknown): NativeReference {
  const payload = NativePayload.parse(input);
  const data = asRecord(payload.data);
  const order = asRecord(data.order ?? payload.order ?? data);
  const type = normalizeStatus(firstString(payload.type, payload.event, data.type) ?? "order_updated");
  const providerOrderId = firstString(order.id, order.order_id, data.order_id, payload.order_id);
  const providerIdempotencyKey = firstString(order.external_id, order.externalId, data.external_id, payload.external_id);
  const status = normalizeStatus(firstString(order.status, data.status, payload.status));
  const occurredAt = eventTime(payload);
  const providerEventId = firstString(payload.id, payload.event_id, data.id, data.event_id)
    ?? `${type}:${providerOrderId ?? providerIdempotencyKey ?? crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24)}`;
  const eventId = `${provider}:${providerEventId}`;
  const base = { eventId, occurredAt };
  let event: ProviderEvent;
  if (type.includes("ship") || type === "order_fulfilled" || status === "fulfilled" || status === "shipped") {
    event = { ...base, type: "provider_fulfilled", ...(providerOrderId ? { providerOrderId } : {}) } as ProviderEvent;
  } else if (type.includes("cancel") || status === "canceled" || status === "cancelled") {
    event = { ...base, type: "cancellation_confirmed", providerOrderId } as ProviderEvent;
  } else if (type.includes("fail") || status === "failed" || status === "error") {
    event = { ...base, type: "provider_failed", providerOrderId, retryable: status !== "error" } as ProviderEvent;
  } else if (type.includes("create") || type.includes("submit") || status === "pending") {
    event = providerOrderId ? { ...base, type: "submission_acknowledged", providerOrderId } : { ...base, type: "outcome_uncertain" };
  } else {
    event = providerOrderId ? { ...base, type: "provider_processing", providerOrderId } : { ...base, type: "outcome_uncertain" };
  }
  return { providerIdempotencyKey, providerOrderId, event: ProviderEventSchema.parse(event), providerEventId };
}
