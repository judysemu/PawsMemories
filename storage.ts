import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import { storageHttpClientOptions } from "./storage.http";

/**
 * Object Storage Utility for Backblaze B2 / S3-compatible storage.
 * Handles uploading base64 images/videos and returning their public URLs.
 */

const bucketName = process.env.MEDIA_BUCKET_NAME;
const bucketEndpoint = process.env.MEDIA_BUCKET_URL;
const accessKeyId = process.env.MEDIA_BUCKET_KEY;
const secretAccessKey = process.env.MEDIA_BUCKET_SECRET;

if (!bucketName || !bucketEndpoint || !accessKeyId || !secretAccessKey) {
  console.warn("⚠️ Object storage environment variables are missing. Uploads will fail.");
}

const s3Client = new S3Client({
  region: "us-east-1", // Backblaze B2 ignores this, but AWS SDK requires it
  endpoint: bucketEndpoint,
  credentials: {
    accessKeyId: accessKeyId || "",
    secretAccessKey: secretAccessKey || "",
  },
  forcePathStyle: true, // Required for Backblaze B2 and some S3-compatible endpoints
  ...storageHttpClientOptions(),
});

export function getPublicObjectUrl(objectKey: string, env: NodeJS.ProcessEnv = process.env): string {
  const endpoint = env.MEDIA_BUCKET_URL;
  const name = env.MEDIA_BUCKET_NAME;
  if (!endpoint || !name) throw new Error("Public object storage is not configured.");
  const url = new URL(endpoint);
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  return `${url.protocol}//${name}.${url.host}/${encodedKey}`;
}

/**
 * Maps a MIME type to an appropriate file extension.
 */
export function getExtensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "model/gltf-binary": "glb",
    "model/gltf+json": "gltf",
    "model/stl": "stl",
    "application/octet-stream": "glb",
    "audio/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "application/x-step": "ifc",
    "application/json": "json",
  };
  if (map[mimeType]) return map[mimeType];
  
  if (mimeType.startsWith("image/")) return "png";
  if (mimeType.startsWith("video/")) return "mp4";
  if (mimeType.startsWith("model/")) return "glb";
  if (mimeType.startsWith("audio/")) return "mp3";
  
  return "bin";
}

/**
 * Determines the subfolder based on whether the upload is an image or video,
 * unless overridden.
 */
export function getFolderFromMime(mimeType: string, folderOverride?: string): string {
  if (folderOverride) return folderOverride;
  if (mimeType.startsWith("video/")) return "videos";
  if (mimeType.startsWith("model/")) return "models";
  if (mimeType.startsWith("audio/")) return "sounds";
  return "creations";
}

/**
 * Uploads a base64 data URL string to the configured S3-compatible bucket.
 * Supports both images and videos.
 * @param base64String The full data URL string (e.g., "data:image/jpeg;base64,..." or "data:video/mp4;base64,...")
 * @returns The public URL of the uploaded object.
 */
export async function uploadBase64Image(base64String: string, folderOverride?: string): Promise<string> {
  if (!bucketName || !bucketEndpoint) {
    throw new Error("Object storage is not configured. Please check MEDIA_BUCKET_* environment variables.");
  }

  // Parse the base64 string. Use [\s\S]+ to tolerate newlines in the base64 payload.
  let cleanBase64 = base64String.trim();
  if (cleanBase64.startsWith("Z2xURg")) {
    cleanBase64 = `data:model/gltf-binary;base64,${cleanBase64}`;
  }
  const matches = cleanBase64.match(/^data:([A-Za-z0-9-+\/.]+);base64,([\s\S]+)$/);
  if (!matches || matches.length !== 3) {
    const prefix = base64String.substring(0, 100);
    throw new Error(`Invalid base64 data string provided to uploadBase64Image. Prefix: ${prefix}`);
  }

  const mimeType = matches[1];
  const base64Data = matches[2];
  const buffer = Buffer.from(base64Data, "base64");

  // Determine file extension and folder from MIME type
  const extension = getExtensionFromMime(mimeType);
  const folder = getFolderFromMime(mimeType, folderOverride);
  const fileName = `${folder}/${Date.now()}-${uuidv4()}.${extension}`;

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: fileName,
        Body: buffer,
        ContentType: mimeType,
        // Backblaze B2 public buckets don't strictly need ACL, but this is standard
        ACL: "public-read",
      })
    );

    // Construct the public URL
    const url = new URL(bucketEndpoint);
    const publicUrl = `${url.protocol}//${bucketName}.${url.host}/${fileName}`;

    console.log(`✅ Successfully uploaded ${fileName} (${mimeType}) to object storage.`);
    return publicUrl;
  } catch (error: any) {
    console.error("❌ Failed to upload media to object storage:", error);
    throw new Error(`Object storage upload failed: ${error.message}`);
  }
}

/**
 * Uploads raw base64-encoded binary (e.g. a baked LOD GLB returned by the
 * blender-worker) to the configured bucket. Accepts an optional data: URL.
 * @returns The public URL of the uploaded object.
 */
export async function uploadBase64Binary(
  base64: string,
  mimeType: string = "model/gltf-binary",
  folderOverride?: string
): Promise<string> {
  if (!bucketName || !bucketEndpoint) {
    throw new Error("Object storage is not configured. Please check MEDIA_BUCKET_* environment variables.");
  }
  const raw = base64.startsWith("data:") ? base64.split(",")[1] || base64 : base64;
  const buffer = Buffer.from(raw, "base64");

  const extension = getExtensionFromMime(mimeType);
  const folder = getFolderFromMime(mimeType, folderOverride);
  const fileName = `${folder}/${Date.now()}-${uuidv4()}.${extension}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: fileName,
      Body: buffer,
      ContentType: mimeType,
      ACL: "public-read",
    })
  );
  const url = new URL(bucketEndpoint);
  return `${url.protocol}//${bucketName}.${url.host}/${fileName}`;
}

/**
 * Downloads a remote binary (e.g. a Meshy GLB model) and uploads it to the
 * configured bucket. Streams bytes directly without a base64 round-trip, which
 * matters for larger 3D model files.
 * @param sourceUrl Public URL of the remote asset to mirror.
 * @param mimeType  MIME type to store it under (default model/gltf-binary).
 * @returns The public URL of the uploaded object.
 */
export async function uploadBinaryFromUrl(
  sourceUrl: string,
  mimeType: string = "model/gltf-binary",
  folderOverride?: string
): Promise<string> {
  if (!bucketName || !bucketEndpoint) {
    throw new Error("Object storage is not configured. Please check MEDIA_BUCKET_* environment variables.");
  }

  const res = await fetch(sourceUrl);
  if (!res.ok) {
    throw new Error(`Failed to download remote asset (${res.status}) from ${sourceUrl}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  const extension = getExtensionFromMime(mimeType);
  const folder = getFolderFromMime(mimeType, folderOverride);
  const fileName = `${folder}/${Date.now()}-${uuidv4()}.${extension}`;

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: fileName,
        Body: buffer,
        ContentType: mimeType,
        ACL: "public-read",
      })
    );

    const url = new URL(bucketEndpoint);
    const publicUrl = `${url.protocol}//${bucketName}.${url.host}/${fileName}`;

    console.log(`✅ Successfully uploaded ${fileName} (${mimeType}) to object storage.`);
    return publicUrl;
  } catch (error: any) {
    console.error("❌ Failed to upload remote asset to object storage:", error);
    throw new Error(`Object storage upload failed: ${error.message}`);
  }
}

/**
 * Fetches a public URL and converts it to a data URI base64 string.
 */
export async function fetchUrlAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url} for base64 conversion: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const mime = res.headers.get("content-type") || "application/octet-stream";
  return `data:${mime};base64,${base64}`;
}
