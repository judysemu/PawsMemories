import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "node:crypto";
import { storageHttpClientOptions } from "./storage.http";

/**
 * PRIVATE object storage — customer-owned source and generated assets.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM storage.ts
 * ------------------------------------------------
 * Backblaze B2's S3-compatible API does NOT support object-level ACLs. Objects
 * inherit their bucket's ACL, only the canned values "private" and "public-read"
 * are accepted, and setting an object ACL that differs from its parent bucket
 * returns 403. Access control on B2 is a bucket-level property.
 *
 * Consequence: the public MEDIA_BUCKET_NAME cannot hold paid assets. Anything
 * written there is readable by anyone holding the URL, forever, with no way to
 * revoke after a refund and no entitlement check anywhere on the path.
 * Unguessable UUID keys do not fix this — that is obscurity, not access control,
 * and it fails permanently the first time a URL is shared, logged, cached by a
 * proxy, or leaked in a referrer header.
 *
 * So the bucket IS the security boundary:
 *   storage.ts          -> MEDIA_BUCKET_NAME          (public-read)  previews, look variations
 *   storage.private.ts  -> MEDIA_PRIVATE_BUCKET_NAME  (private)      references, source GLBs, STL derivatives
 *
 * Rules enforced here:
 *   1. This module NEVER writes to the public bucket.
 *   2. This module NEVER sends an ACL parameter. On a private bucket it is
 *      redundant; on a public bucket it would 403. Omitting it keeps the bucket
 *      as the single source of truth.
 *   3. Object keys are server-minted UUIDs. User filenames are display metadata
 *      only and never appear in a key path, so there is no traversal surface.
 *   4. Reads leave the server only as short-lived presigned URLs, and only after
 *      the caller has verified an entitlement.
 *
 * Ref: IMPLEMENTATION_SPEC.md §4, MARKETPLACE_AND_STYLES_SPEC.md §1.3
 * Ref: https://www.backblaze.com/docs/cloud-storage-s3-compatible-api
 */

let publicBucketName = process.env.MEDIA_BUCKET_NAME || "";
let privateBucketName = process.env.MEDIA_PRIVATE_BUCKET_NAME || "";
let bucketEndpoint = process.env.MEDIA_BUCKET_URL || "";

/** Private bucket may use its own credentials; otherwise it reuses the shared
 *  all-buckets key. Both live in the same B2 account behind the same endpoint. */
let accessKeyId =
  process.env.MEDIA_PRIVATE_BUCKET_KEY || process.env.MEDIA_BUCKET_KEY || "";
let secretAccessKey =
  process.env.MEDIA_PRIVATE_BUCKET_SECRET || process.env.MEDIA_BUCKET_SECRET || "";

const DEFAULT_SIGNED_URL_TTL_SECONDS = 900; // 15 minutes
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 60 * 60 * 24 * 7; // B2/S3 presign ceiling is 7 days

/** Upload presign window. Deliberately much shorter than the download TTL —
 *  an admin uploads immediately after requesting the URL. */
export const PRESIGNED_UPLOAD_TTL_SECONDS = 300;

export const MAX_GLB_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_PREVIEW_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_GLB_MIME = new Set(["model/gltf-binary"]);
export const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export class PrivateStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateStorageError";
  }
}

type ResolvedPrivateStorageConfig = {
  publicBucketName: string;
  privateBucketName: string;
  bucketEndpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function configuredValue(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] || "").trim();
}

function isPlaceholderCredential(value: string): boolean {
  return /^(?:YOUR_|MY_|CHANGE[_-]?ME|REPLACE[_-]?ME)/i.test(value);
}

function resolvePrivateStorageConfig(env: NodeJS.ProcessEnv): ResolvedPrivateStorageConfig {
  const publicName = configuredValue(env, "MEDIA_BUCKET_NAME");
  const privateName = configuredValue(env, "MEDIA_PRIVATE_BUCKET_NAME");
  const endpointValue = configuredValue(env, "MEDIA_BUCKET_URL");
  const privateKey = configuredValue(env, "MEDIA_PRIVATE_BUCKET_KEY");
  const privateSecret = configuredValue(env, "MEDIA_PRIVATE_BUCKET_SECRET");
  const sharedKey = configuredValue(env, "MEDIA_BUCKET_KEY");
  const sharedSecret = configuredValue(env, "MEDIA_BUCKET_SECRET");

  if (!privateName) {
    throw new PrivateStorageError(
      "MEDIA_PRIVATE_BUCKET_NAME is not set. Private customer assets have nowhere " +
        "safe to live — refusing to start rather than recording objects that were not uploaded.",
    );
  }
  if (publicName && privateName === publicName) {
    throw new PrivateStorageError(
      `MEDIA_PRIVATE_BUCKET_NAME ("${privateName}") is the same bucket as MEDIA_BUCKET_NAME. ` +
        "Backblaze applies ACLs per bucket, so this would publish every private asset. " +
        "Point MEDIA_PRIVATE_BUCKET_NAME at a bucket whose type is Private.",
    );
  }
  if (!endpointValue) {
    throw new PrivateStorageError("MEDIA_BUCKET_URL is required for private asset storage.");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new PrivateStorageError("MEDIA_BUCKET_URL must be a valid absolute URL.");
  }
  const localEndpoint = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1";
  if (endpoint.protocol !== "https:" && !localEndpoint) {
    throw new PrivateStorageError("MEDIA_BUCKET_URL must use HTTPS outside local development.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new PrivateStorageError("MEDIA_BUCKET_URL must not contain credentials, query parameters, or a fragment.");
  }

  if (Boolean(privateKey) !== Boolean(privateSecret)) {
    throw new PrivateStorageError(
      "MEDIA_PRIVATE_BUCKET_KEY and MEDIA_PRIVATE_BUCKET_SECRET must be configured together.",
    );
  }
  if (!privateKey && Boolean(sharedKey) !== Boolean(sharedSecret)) {
    throw new PrivateStorageError(
      "MEDIA_BUCKET_KEY and MEDIA_BUCKET_SECRET must be configured together when private credentials are not supplied.",
    );
  }

  const key = privateKey || sharedKey;
  const secret = privateSecret || sharedSecret;
  if (!key || !secret) {
    throw new PrivateStorageError(
      "No credentials for the private bucket. Set MEDIA_PRIVATE_BUCKET_KEY/_SECRET, " +
        "or ensure MEDIA_BUCKET_KEY/_SECRET belong to a key scoped to all buckets " +
        "(a key pinned to one bucket cannot reach the private one).",
    );
  }
  if (isPlaceholderCredential(key) || isPlaceholderCredential(secret)) {
    throw new PrivateStorageError("Private bucket credentials still contain placeholder values.");
  }

  return {
    publicBucketName: publicName,
    privateBucketName: privateName,
    bucketEndpoint: endpoint.toString().replace(/\/$/, ""),
    accessKeyId: key,
    secretAccessKey: secret,
  };
}

/**
 * Fail fast on a configuration that would silently expose paid assets.
 *
 * If both names resolve to the same bucket, every "private" write lands in a
 * public-read bucket and every entitlement check becomes theatre. B2 gives us no
 * per-object fallback to catch this at runtime, so it has to be caught at boot.
 */
export function assertPrivateStorageConfig(env: NodeJS.ProcessEnv = process.env): void {
  resolvePrivateStorageConfig(env);
}

let cachedClient: S3Client | null = null;

function client(): S3Client {
  if (cachedClient) return cachedClient;
  const resolved = resolvePrivateStorageConfig(process.env);
  publicBucketName = resolved.publicBucketName;
  privateBucketName = resolved.privateBucketName;
  bucketEndpoint = resolved.bucketEndpoint;
  accessKeyId = resolved.accessKeyId;
  secretAccessKey = resolved.secretAccessKey;
  cachedClient = new S3Client({
    region: "us-east-1", // Backblaze ignores this; the AWS SDK requires it
    endpoint: bucketEndpoint,
    credentials: {
      accessKeyId: accessKeyId || "",
      secretAccessKey: secretAccessKey || "",
    },
    forcePathStyle: true, // required for Backblaze B2
    ...storageHttpClientOptions(),
  });
  return cachedClient;
}

/** Test seam — drops the memoised client so env changes take effect. */
export function resetPrivateStorageClient(): void {
  cachedClient = null;
  publicBucketName = process.env.MEDIA_BUCKET_NAME || "";
  privateBucketName = process.env.MEDIA_PRIVATE_BUCKET_NAME || "";
  bucketEndpoint = process.env.MEDIA_BUCKET_URL || "";
  accessKeyId = process.env.MEDIA_PRIVATE_BUCKET_KEY || process.env.MEDIA_BUCKET_KEY || "";
  secretAccessKey = process.env.MEDIA_PRIVATE_BUCKET_SECRET || process.env.MEDIA_BUCKET_SECRET || "";
}

export type PrivateAssetKind = "source_glb" | "stl_derivative";

const EXTENSION_BY_MIME: Record<string, string> = {
  "model/gltf-binary": "glb",
  "model/gltf+json": "gltf",
  "model/stl": "stl",
  "application/sla": "stl",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function extensionForMime(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType] || "bin";
}

/**
 * Mint an object key. Server-generated UUIDs only — a user-supplied filename
 * never reaches this path, so `../` and absolute-path tricks have nowhere to go.
 */
export function mintObjectKey(listingUuid: string, mimeType: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(listingUuid)) {
    throw new PrivateStorageError(`Invalid listing UUID: ${listingUuid}`);
  }
  return `marketplace/${listingUuid}/${uuidv4()}.${extensionForMime(mimeType)}`;
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function resolveTtl(seconds?: number): number {
  const configured = Number(
    process.env.MEDIA_SIGNED_URL_TTL_SECONDS || DEFAULT_SIGNED_URL_TTL_SECONDS,
  );
  const requested = seconds ?? configured;
  if (!Number.isFinite(requested)) return DEFAULT_SIGNED_URL_TTL_SECONDS;
  return Math.min(Math.max(Math.trunc(requested), MIN_TTL_SECONDS), MAX_TTL_SECONDS);
}

/** Upload bytes we already hold server-side (e.g. an STL from the Blender worker). */
export async function putPrivateObject(
  objectKey: string,
  body: Buffer,
  mimeType: string,
): Promise<{ objectKey: string; sizeBytes: number; sha256: string }> {
  await client().send(
    new PutObjectCommand({
      Bucket: privateBucketName,
      Key: objectKey,
      Body: body,
      ContentType: mimeType,
      // NO ACL — see the header comment. The bucket defines access.
    }),
  );
  return { objectKey, sizeBytes: body.byteLength, sha256: sha256Hex(body) };
}

/** Delete a known private object when a later metadata write cannot be committed. */
export async function deletePrivateObject(objectKey: string): Promise<void> {
  if (!objectKey.startsWith("marketplace/") && !objectKey.startsWith("references/") && !objectKey.startsWith("models/")) {
    throw new PrivateStorageError("Refusing to delete an object outside allowed private prefixes.");
  }
  await client().send(
    new DeleteObjectCommand({ Bucket: privateBucketName, Key: objectKey }),
  );
}

/**
 * Presigned PUT so the browser uploads straight to Backblaze. Large GLB bodies
 * never transit Hostinger.
 *
 * The returned URL is a capability: anyone holding it can write to that exact
 * key until it expires. That is acceptable because the key is server-minted and
 * unguessable, the window is 5 minutes, and nothing is trusted until
 * headPrivateObject() confirms what actually landed.
 */
export async function createPresignedUpload(
  objectKey: string,
  mimeType: string,
  ttlSeconds: number = PRESIGNED_UPLOAD_TTL_SECONDS,
): Promise<{ uploadUrl: string; objectKey: string; expiresAt: string }> {
  const expiresIn = Math.min(Math.max(Math.trunc(ttlSeconds), MIN_TTL_SECONDS), 3600);
  const uploadUrl = await getSignedUrl(
    client(),
    new PutObjectCommand({
      Bucket: privateBucketName,
      Key: objectKey,
      ContentType: mimeType,
    }),
    { expiresIn },
  );
  return {
    uploadUrl,
    objectKey,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

/**
 * Read back what was actually stored.
 *
 * This is the trust boundary for browser uploads. The client tells us a size and
 * a MIME type when asking for the presigned URL; neither is believed. Callers
 * MUST compare this result against the claim before writing an asset row —
 * otherwise a caller could register a 2 KB text file as a 90 MB GLB, or upload
 * something entirely different from what was declared.
 */
export async function headPrivateObject(
  objectKey: string,
): Promise<{ sizeBytes: number; mimeType: string; etag: string | null } | null> {
  try {
    const head = await client().send(
      new HeadObjectCommand({ Bucket: privateBucketName, Key: objectKey }),
    );
    return {
      sizeBytes: Number(head.ContentLength ?? 0),
      mimeType: String(head.ContentType || "application/octet-stream"),
      etag: head.ETag ? head.ETag.replace(/"/g, "") : null,
    };
  } catch (err: any) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey") return null;
    throw err;
  }
}

/**
 * Short-lived presigned GET.
 *
 * CALLER CONTRACT: only call this after confirming the requesting user holds a
 * live, non-revoked entitlement for this asset. Nothing in this function checks
 * ownership — it mints a capability for whoever asks.
 */
export async function getPrivateSignedUrl(
  objectKey: string,
  ttlSeconds?: number,
): Promise<{ url: string; expiresAt: string; ttlSeconds: number }> {
  const expiresIn = resolveTtl(ttlSeconds);
  const url = await getSignedUrl(
    client(),
    new GetObjectCommand({ Bucket: privateBucketName, Key: objectKey }),
    { expiresIn },
  );
  return {
    url,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    ttlSeconds: expiresIn,
  };
}

/** Fetch private bytes server-side, e.g. to hand a GLB to the Blender worker. */
export async function getPrivateObjectBuffer(objectKey: string): Promise<Buffer> {
  const res = await client().send(
    new GetObjectCommand({ Bucket: privateBucketName, Key: objectKey }),
  );
  const body = res.Body as any;
  if (!body) throw new PrivateStorageError(`Empty body for ${objectKey}`);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Validate a declared upload before minting a presigned URL. */
export function validateUploadClaim(
  kind: "source_glb" | "preview_image",
  mimeType: string,
  sizeBytes: number,
): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, error: "A positive file size is required." };
  }
  if (kind === "source_glb") {
    if (!ALLOWED_GLB_MIME.has(mimeType)) {
      return { ok: false, error: `Source models must be model/gltf-binary, received ${mimeType}.` };
    }
    if (sizeBytes > MAX_GLB_BYTES) {
      return { ok: false, error: `Source models must be ${MAX_GLB_BYTES / (1024 * 1024)} MB or smaller.` };
    }
    return { ok: true };
  }
  if (!ALLOWED_IMAGE_MIME.has(mimeType)) {
    return { ok: false, error: `Preview images must be JPEG, PNG, or WebP, received ${mimeType}.` };
  }
  if (sizeBytes > MAX_PREVIEW_IMAGE_BYTES) {
    return { ok: false, error: `Preview images must be ${MAX_PREVIEW_IMAGE_BYTES / (1024 * 1024)} MB or smaller.` };
  }
  return { ok: true };
}

export const __privateStorageInternals = {
  get privateBucketName() { return privateBucketName; },
  get publicBucketName() { return publicBucketName; },
  resolveTtl,
};
