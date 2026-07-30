const DEFAULT_BASE_URL = "https://slant3dapi.com/v2/api";

export interface SlantAddress {
  name: string;
  email: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface SlantFile {
  publicFileServiceId: string;
  fileURL?: string;
  STLMetrics?: { x?: number; y?: number; z?: number; weight?: number; surfaceArea?: number; volume?: number; imageURL?: string };
}

export interface SlantEstimate {
  subtotal: number;
  pricePerUnit: number;
  quantity: number;
  total: number;
  totalMaterial?: number;
  estimatedPrintTime?: number;
  dimensions?: { x: number; y: number; z: number };
}

export interface SlantDraftOrder {
  publicId: string;
  status: string;
  totals: { printingCost: number; deliveryCost: number; totalCost: number };
  raw: unknown;
}

function config() {
  const apiKey = String(process.env.SLANT3D_API_KEY || "").trim();
  const platformId = String(process.env.SLANT3D_PLATFORM_ID || "").trim();
  const filamentId = String(process.env.SLANT3D_DEFAULT_FILAMENT_ID || "").trim();
  if (!apiKey || !platformId || !filamentId) {
    throw new Error("Slant 3D printing is not configured.");
  }
  return {
    apiKey,
    platformId,
    filamentId,
    baseUrl: String(process.env.SLANT3D_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ""),
  };
}

async function request(path: string, init: RequestInit = {}): Promise<any> {
  const { apiKey, baseUrl } = config();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    throw new Error(slantErrorMessage(payload, response.status));
  }
  return payload;
}

/**
 * Slant sometimes returns structured error objects instead of strings. Reduce
 * them to a useful, bounded message without logging the full provider payload.
 */
export function slantErrorMessage(payload: unknown, status: number): string {
  const record = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const candidates = [record.message, record.error, record.detail];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().slice(0, 300);
    }
    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      for (const value of [nested.message, nested.error, nested.detail]) {
        if (typeof value === "string" && value.trim()) {
          return value.trim().slice(0, 300);
        }
      }
      const code = nested.code ?? nested.type;
      if (typeof code === "string" || typeof code === "number") {
        return `Slant 3D error ${String(code).slice(0, 80)} (HTTP ${status}).`;
      }
    }
  }

  return `Slant 3D returned HTTP ${status}.`;
}

export function slant3dConfigured(): boolean {
  return Boolean(process.env.SLANT3D_API_KEY && process.env.SLANT3D_PLATFORM_ID && process.env.SLANT3D_DEFAULT_FILAMENT_ID);
}

function arrayFrom(value: any, keys: string[]): any[] {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

/** Non-mutating credential/platform/material check for the admin deployment gate. */
export async function verifySlant3dConfiguration(): Promise<{
  authenticated: true;
  platformValid: boolean;
  filamentValid: boolean;
  filamentAvailable: boolean;
  filamentName: string | null;
}> {
  const { platformId, filamentId } = config();
  const [platformPayload, filamentPayload] = await Promise.all([
    request(`/platforms/${encodeURIComponent(platformId)}`, { method: "GET", signal: AbortSignal.timeout(30_000) }),
    request("/filaments", { method: "GET", signal: AbortSignal.timeout(30_000) }),
  ]);
  const platform = platformPayload?.data?.platform || platformPayload?.data || platformPayload?.platform || platformPayload;
  const filamentData = filamentPayload?.data || filamentPayload;
  const filaments = arrayFrom(filamentData, ["filaments", "items", "results"]);
  const selected = filaments.find((item: any) => String(item?.publicId || item?.id || "") === filamentId);
  const returnedPlatformId = String(platform?.publicId || platform?.id || platform?.platformId || "");
  return {
    authenticated: true,
    platformValid: returnedPlatformId === platformId,
    filamentValid: Boolean(selected),
    filamentAvailable: Boolean(selected && selected.available !== false),
    filamentName: selected ? String(selected.name || selected.color || "Selected filament").slice(0, 120) : null,
  };
}

export async function uploadSlantFileFromUrl(input: { stlUrl: string; name: string; ownerId: string }): Promise<SlantFile> {
  const { platformId } = config();
  const payload = await request("/files", {
    method: "POST",
    body: JSON.stringify({ URL: input.stlUrl, name: input.name.slice(0, 80), platformId, ownerId: input.ownerId, type: "stl" }),
  });
  const file = payload?.data || payload;
  if (!file?.publicFileServiceId) throw new Error("Slant 3D did not return a file identifier.");
  return file as SlantFile;
}

export async function estimateSlantFile(input: { publicFileServiceId: string; quantity?: number; filamentId?: string }): Promise<SlantEstimate> {
  const { filamentId } = config();
  const payload = await request(`/files/${encodeURIComponent(input.publicFileServiceId)}/estimate`, {
    method: "POST",
    body: JSON.stringify({
      options: {
        filamentId: input.filamentId || filamentId,
        quantity: input.quantity || 1,
        slicerOptions: { support_enable: true },
      },
    }),
  });
  const estimate = payload?.data || payload;
  if (!Number.isFinite(Number(estimate?.total))) throw new Error("Slant 3D did not return a print estimate.");
  return { ...estimate, total: Number(estimate.total), subtotal: Number(estimate.subtotal || estimate.total), pricePerUnit: Number(estimate.pricePerUnit || estimate.total), quantity: Number(estimate.quantity || 1) };
}

export async function draftSlantOrder(input: {
  publicFileServiceId: string;
  address: SlantAddress;
  ownerId: string;
  itemName: string;
  quantity?: number;
}): Promise<SlantDraftOrder> {
  const { platformId, filamentId } = config();
  const payload = await request("/orders", {
    method: "POST",
    body: JSON.stringify({
      customer: {
        platformId,
        details: {
          email: input.address.email,
          address: {
            name: input.address.name,
            line1: input.address.line1,
            line2: input.address.line2 || "",
            city: input.address.city,
            state: input.address.state,
            zip: input.address.zip,
            country: input.address.country,
          },
        },
      },
      items: [{
        type: "PRINT",
        publicFileServiceId: input.publicFileServiceId,
        filamentId,
        quantity: input.quantity || 1,
        name: input.itemName.slice(0, 120),
        SKU: `pawsome3d-${input.publicFileServiceId.slice(0, 18)}`,
        options: { slicerOptions: { support_enable: true } },
      }],
      metadata: { ownerId: input.ownerId, source: "PAWSOME3D" },
    }),
  });
  const data = payload?.data || payload;
  const order = data?.order || data;
  const totals = data?.totals || {
    printingCost: Number(order?.printingCost || 0),
    deliveryCost: Number(order?.deliveryCost || 0),
    totalCost: Number(order?.printingCost || 0) + Number(order?.deliveryCost || 0),
  };
  if (!order?.publicId || !Number.isFinite(Number(totals?.totalCost))) throw new Error("Slant 3D did not return a valid draft order.");
  return {
    publicId: String(order.publicId),
    status: String(order.status || "DRAFT"),
    totals: { printingCost: Number(totals.printingCost), deliveryCost: Number(totals.deliveryCost), totalCost: Number(totals.totalCost) },
    raw: data,
  };
}

export async function processSlantOrder(publicOrderId: string): Promise<any> {
  return await request(`/orders/${encodeURIComponent(publicOrderId)}`, { method: "POST", body: "{}" });
}

export async function getSlantOrder(publicOrderId: string): Promise<any> {
  return await request(`/orders/${encodeURIComponent(publicOrderId)}`);
}

export async function submitSlantOrderIfDraft(publicOrderId: string): Promise<any> {
  const current = await getSlantOrder(publicOrderId);
  const status = String(current?.data?.status || current?.data?.order?.status || "").toUpperCase();
  if (status && status !== "DRAFT") return current;
  return await processSlantOrder(publicOrderId);
}
