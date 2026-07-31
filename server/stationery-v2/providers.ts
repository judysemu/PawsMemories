import type { FulfillmentProviderPort } from "./ports.ts";
import type { ProviderObservation } from "./fulfillment.ts";

type Recipient = {
  name: string;
  email: string;
  address1: string;
  address2?: string;
  city: string;
  stateCode?: string;
  countryCode: string;
  postalCode: string;
};

type SubmissionInput = {
  idempotencyKey: string;
  printManifestHash: string;
  frozenFileUrl: string;
  providerSku: string;
  placement: string;
  quantity: number;
  recipient: Recipient;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(env[name] || "").trim();
  if (!value || /replace|example|changeme/i.test(value)) throw new Error(`${name} is missing or invalid.`);
  return value;
}

function providerState(value: unknown): Exclude<ProviderObservation, { availability: "unavailable" | "not_found" }> ["state"] {
  const state = String(value || "").toLowerCase();
  if (["fulfilled", "delivered", "completed"].includes(state)) return "fulfilled";
  if (["canceled", "cancelled"].includes(state)) return "canceled";
  if (["failed", "error"].includes(state)) return "failed_terminal";
  if (["draft", "pending", "queued", "submitted"].includes(state)) return "submitted";
  return "processing";
}

async function jsonRequest(baseUrl: string, token: string, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    redirect: "error",
    signal: init.signal || AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Fulfillment provider returned HTTP ${response.status}.`);
  return body?.result || body?.data || body;
}

function printfulVariantId(env: NodeJS.ProcessEnv, sku: string): number {
  const rawMap = String(env.PRINTFUL_STATIONERY_VARIANT_MAP || "{}");
  let map: Record<string, unknown>;
  try { map = JSON.parse(rawMap) as Record<string, unknown>; } catch { throw new Error("PRINTFUL_STATIONERY_VARIANT_MAP must be valid JSON."); }
  const value = map[sku] ?? sku;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error("No valid Printful variant is configured for this stationery SKU.");
  return id;
}

function recipientPrintful(recipient: Recipient) {
  return {
    name: recipient.name,
    email: recipient.email,
    address1: recipient.address1,
    ...(recipient.address2 ? { address2: recipient.address2 } : {}),
    city: recipient.city,
    ...(recipient.stateCode ? { state_code: recipient.stateCode } : {}),
    country_code: recipient.countryCode,
    zip: recipient.postalCode,
  };
}

export class PrintfulStationeryProvider implements FulfillmentProviderPort {
  readonly provider = "printful" as const;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly storeId: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.token = required(env, "PRINTFUL_API_KEY");
    this.baseUrl = String(env.PRINTFUL_API_BASE_URL || "https://api.printful.com").replace(/\/$/, "");
    this.storeId = String(env.PRINTFUL_STORE_ID || "").trim();
  }

  async submitFrozenManifest(input: SubmissionInput) {
    const order = await jsonRequest(this.baseUrl, this.token, "/orders?confirm=false&update_existing=true", {
      method: "POST",
      headers: this.storeId ? { "X-PF-Store-Id": this.storeId } : {},
      body: JSON.stringify({
        external_id: input.idempotencyKey,
        recipient: recipientPrintful(input.recipient),
        items: [{ variant_id: printfulVariantId(this.env, input.providerSku), quantity: input.quantity, files: [{ type: "default", url: input.frozenFileUrl }] }],
        metadata: { pawsome_manifest_hash: input.printManifestHash, placement: input.placement },
      }),
    });
    const providerOrderId = String(order?.id || order?.order?.id || "");
    if (!providerOrderId) throw new Error("Printful did not return an order ID.");
    await jsonRequest(this.baseUrl, this.token, `/orders/${encodeURIComponent(providerOrderId)}/confirm`, {
      method: "POST",
      headers: this.storeId ? { "X-PF-Store-Id": this.storeId } : {},
      body: "{}",
    });
    return { providerOrderId, state: "processing" as const };
  }

  async observe(providerOrderId: string | null, idempotencyKey: string): Promise<ProviderObservation> {
    if (!providerOrderId) return { availability: "not_found", checkedAt: new Date().toISOString() };
    try {
      const order = await jsonRequest(this.baseUrl, this.token, `/orders/${encodeURIComponent(providerOrderId)}`, { headers: this.storeId ? { "X-PF-Store-Id": this.storeId } : {} });
      return { availability: "found", checkedAt: new Date().toISOString(), providerOrderId, state: providerState(order?.status) };
    } catch { return { availability: "unavailable", checkedAt: new Date().toISOString() }; }
  }

  async requestRefund(): Promise<{ state: "unknown"; providerRefundId: null; refundedAmountMinor: number }> {
    return { state: "unknown", providerRefundId: null, refundedAmountMinor: 0 };
  }
}

export class Slant3dStationeryProvider implements FulfillmentProviderPort {
  readonly provider = "slant3d" as const;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly platformId: string;
  private readonly filamentId: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.token = required(env, "SLANT3D_API_KEY");
    this.platformId = required(env, "SLANT3D_PLATFORM_ID");
    this.filamentId = required(env, "SLANT3D_DEFAULT_FILAMENT_ID");
    this.baseUrl = String(env.SLANT3D_API_BASE_URL || "https://slant3dapi.com/v2/api").replace(/\/$/, "");
  }

  async submitFrozenManifest(input: SubmissionInput) {
    const file = await jsonRequest(this.baseUrl, this.token, "/files", {
      method: "POST",
      body: JSON.stringify({ URL: input.frozenFileUrl, name: input.providerSku, platformId: this.platformId, type: "pdf" }),
    });
    const fileId = String(file?.publicFileServiceId || file?.id || "");
    if (!fileId) throw new Error("Slant3D did not return a file ID.");
    const order = await jsonRequest(this.baseUrl, this.token, "/orders", {
      method: "POST",
      body: JSON.stringify({
        customer: { platformId: this.platformId, details: { email: input.recipient.email, address: { name: input.recipient.name, line1: input.recipient.address1, line2: input.recipient.address2 || "", city: input.recipient.city, state: input.recipient.stateCode || "", zip: input.recipient.postalCode, country: input.recipient.countryCode } } },
        items: [{ type: "PRINT", publicFileServiceId: fileId, filamentId: this.filamentId, quantity: input.quantity, name: input.providerSku, SKU: input.providerSku }],
        metadata: { pawsomeManifestHash: input.printManifestHash, idempotencyKey: input.idempotencyKey, placement: input.placement },
      }),
    });
    const providerOrderId = String(order?.publicId || order?.order?.publicId || order?.id || "");
    if (!providerOrderId) throw new Error("Slant3D did not return an order ID.");
    await jsonRequest(this.baseUrl, this.token, `/orders/${encodeURIComponent(providerOrderId)}`, {
      method: "POST",
      body: "{}",
    });
    return { providerOrderId, state: "processing" as const };
  }

  async observe(providerOrderId: string | null, idempotencyKey: string): Promise<ProviderObservation> {
    if (!providerOrderId) return { availability: "not_found", checkedAt: new Date().toISOString() };
    try {
      const order = await jsonRequest(this.baseUrl, this.token, `/orders/${encodeURIComponent(providerOrderId)}`);
      return { availability: "found", checkedAt: new Date().toISOString(), providerOrderId, state: providerState(order?.status || order?.order?.status) };
    } catch { return { availability: "unavailable", checkedAt: new Date().toISOString() }; }
  }

  async requestRefund(): Promise<{ state: "unknown"; providerRefundId: null; refundedAmountMinor: number }> {
    return { state: "unknown", providerRefundId: null, refundedAmountMinor: 0 };
  }
}
