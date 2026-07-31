import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type mysql from "mysql2/promise";
import { dbConfigured, getPool } from "../../db.ts";
import { createPresignedUpload, getPrivateSignedUrl, headPrivateObject } from "../../storage.private.ts";
import { PaymentEvidenceSchema, type PaymentEvidence, type RenderDispatch } from "./apiContracts.ts";
import type {
  FrozenFileAccessPort,
  PaymentEvidenceReaderPort,
  ProviderWebhookAuthenticatorPort,
  RenderCallbackAuthenticatorPort,
  RenderDispatcherPort,
} from "./apiPorts.ts";
import { MySqlStationeryV2Repository } from "./repository.ts";
import { StationeryV2Service } from "./service.ts";
import { PrintfulStationeryProvider, Slant3dStationeryProvider } from "./providers.ts";
import { registerAsset } from "../assets/service.ts";
import { WorkerAssetRegistrationSchema, WorkerUploadRequestSchema } from "./apiContracts.ts";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function requiredSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() || "";
  if (value.length < 24 || /replace|example|changeme/i.test(value)) {
    throw new Error(`${name} is missing or invalid; Stationery v2 remains disabled.`);
  }
  return value;
}

function requiredHttpsUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() || "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${name} must use HTTPS.`);
  return parsed.toString().replace(/\/+$/, "");
}

export class HmacSha256Authenticator implements ProviderWebhookAuthenticatorPort, RenderCallbackAuthenticatorPort {
  constructor(
    private readonly secrets: Readonly<Partial<Record<"printful" | "slant3d" | "render", string>>>,
  ) {}

  async authenticate(input: {
    provider?: "printful" | "slant3d";
    headers: IncomingHttpHeaders;
    rawBody: Buffer;
  }): Promise<boolean> {
    const key = input.provider || "render";
    const secret = this.secrets[key];
    if (!secret || input.rawBody.byteLength === 0) return false;
    const headerName = key === "render" ? "x-stationery-render-signature" : "x-stationery-provider-signature";
    const supplied = singleHeader(input.headers[headerName]);
    if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
    const expected = crypto.createHmac("sha256", secret).update(input.rawBody).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(supplied.toLowerCase()), Buffer.from(expected));
  }

  async authenticateNative(input: { provider: "printful" | "slant3d"; headers: IncomingHttpHeaders; rawBody: Buffer }): Promise<boolean> {
    const secret = this.secrets[input.provider];
    if (!secret || input.rawBody.byteLength === 0) return false;
    const supplied = input.provider === "printful"
      ? singleHeader(input.headers["x-pf-webhook-signature"])
      : singleHeader(input.headers["x-slant3d-webhook-signature"] ?? input.headers["x-slant3d-signature"]);
    if (!supplied) return false;
    const key = input.provider === "printful" && /^[a-f0-9]+$/i.test(secret) && secret.length % 2 === 0
      ? Buffer.from(secret, "hex")
      : Buffer.from(secret, "utf8");
    const expected = crypto.createHmac("sha256", key).update(input.rawBody).digest("hex");
    return /^[a-f0-9]{64}$/i.test(supplied)
      && crypto.timingSafeEqual(Buffer.from(supplied.toLowerCase(), "utf8"), Buffer.from(expected, "utf8"));
  }
}

export class HttpsStationeryRenderDispatcher implements RenderDispatcherPort {
  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async dispatch(input: RenderDispatch): Promise<void> {
    const body = JSON.stringify(input);
    const signature = crypto.createHmac("sha256", this.secret).update(body).digest("hex");
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stationery-render-signature": signature,
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Stationery render worker returned HTTP ${response.status}.`);
  }
}

export class SqlStationeryPaymentEvidenceReader implements PaymentEvidenceReaderPort {
  constructor(private readonly pool: mysql.Pool) {}

  async getPaymentEvidence(ownerId: string, paymentUuid: string): Promise<PaymentEvidence | null> {
    const [rows]: any = await this.pool.query(
      `SELECT payment_uuid, owner_id, state, fulfillment_provider, provider_sku,
              unit_amount_minor, quantity, amount_minor, currency, confirmed_at, evidence_hash
       FROM stationery_payment_evidence
       WHERE payment_uuid = ? AND owner_id = ? LIMIT 1`,
      [paymentUuid, ownerId],
    );
    if (!rows[0]) return null;
    return PaymentEvidenceSchema.parse({
      paymentUuid: String(rows[0].payment_uuid),
      ownerId: String(rows[0].owner_id),
      state: rows[0].state,
      fulfillmentProvider: rows[0].fulfillment_provider,
      providerSku: String(rows[0].provider_sku),
      unitAmountMinor: Number(rows[0].unit_amount_minor),
      quantity: Number(rows[0].quantity),
      amountMinor: Number(rows[0].amount_minor),
      currency: String(rows[0].currency),
      confirmedAt: rows[0].confirmed_at ? toIso(rows[0].confirmed_at) : null,
      evidenceHash: String(rows[0].evidence_hash),
    });
  }
}

export class PrivateStationeryFileAccess implements FrozenFileAccessPort {
  constructor(private readonly pool: mysql.Pool) {}

  async createProviderReadUrl(input: {
    ownerId: string;
    assetUuid: string;
    versionNumber: number;
    expectedSha256: string;
  }): Promise<string> {
    const [rows]: any = await this.pool.query(
      `SELECT av.object_key, av.sha256, av.bucket
       FROM assets a
       JOIN asset_versions av ON av.asset_id = a.id
       WHERE a.asset_uuid = ? AND a.owner_id = ? AND a.status = 'active'
         AND av.version_number = ? LIMIT 1`,
      [input.assetUuid, input.ownerId, input.versionNumber],
    );
    const row = rows[0];
    if (!row || row.bucket !== "private" || String(row.sha256) !== input.expectedSha256) {
      throw new Error("Frozen stationery file identity or ownership could not be verified.");
    }
    return (await getPrivateSignedUrl(String(row.object_key), 900)).url;
  }
}

export function createStationeryV2Production(options: {
  env?: NodeJS.ProcessEnv;
  pool?: mysql.Pool;
  fetchImpl?: FetchLike;
} = {}) {
  const env = options.env || process.env;
  if (!options.pool && !dbConfigured()) throw new Error("Database configuration is required for Stationery v2.");
  const pool = options.pool || getPool();
  const workerSecret = requiredSecret(env, "STATIONERY_RENDER_WORKER_SECRET");
  const renderEndpoint = requiredHttpsUrl(env, "STATIONERY_RENDER_WORKER_URL");
  const repository = new MySqlStationeryV2Repository(() => pool);
  const providers = {
    printful: new PrintfulStationeryProvider(env),
    slant3d: new Slant3dStationeryProvider(env),
  };
  const service = new StationeryV2Service({
    repository,
    renderDispatcher: new HttpsStationeryRenderDispatcher(renderEndpoint, workerSecret, options.fetchImpl),
    paymentEvidence: new SqlStationeryPaymentEvidenceReader(pool),
    frozenFileAccess: new PrivateStationeryFileAccess(pool),
    providers,
  });
  return {
    service,
    repository,
    routerDependencies: {
      renderCallbackAuthenticator: new HmacSha256Authenticator({ render: workerSecret }),
      providerWebhookAuthenticator: new HmacSha256Authenticator({
        printful: requiredSecret(env, "PRINTFUL_WEBHOOK_SECRET"),
        slant3d: requiredSecret(env, "SLANT3D_WEBHOOK_SECRET"),
      }),
      workerAssetRegistrar: async (rawInput) => {
        const input = WorkerAssetRegistrationSchema.parse(rawInput);
        const head = await headPrivateObject(input.objectKey);
        if (!head || head.sizeBytes !== input.sizeBytes || head.mimeType !== input.mimeType) {
          throw new Error("Worker output object could not be verified against its registration claim.");
        }
        const registered = await registerAsset({
          ...input,
          visibility: "private",
          sourceProvider: "stationery-worker",
          license: "proprietary",
          commercialUseEligible: true,
        }, { authorization: { internal: true }, isNewObjectUpload: false, pool });
        return { assetUuid: registered.asset.asset_uuid, versionNumber: registered.version.version_number, sha256: registered.version.sha256 };
      },
      workerUploadSigner: async (rawInput) => {
        const input = WorkerUploadRequestSchema.parse(rawInput);
        const safeOwner = input.ownerId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
        return createPresignedUpload(`marketplace/stationery/${safeOwner}/${input.jobUuid}.${input.mimeType === "application/pdf" ? "pdf" : input.mimeType === "image/jpeg" ? "jpg" : "png"}`, input.mimeType, 900);
      },
    },
  };
}

function singleHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] || "").trim() : String(value || "").trim();
}

function toIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z"));
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid payment evidence timestamp.");
  return date.toISOString();
}
