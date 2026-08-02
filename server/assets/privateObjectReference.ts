/**
 * Recover the immutable private-storage object key from a legacy presigned URL.
 * Query parameters are capabilities and are never retained or compared.
 */
export function privateReferenceObjectKey(
  value: unknown,
  bucketName = process.env.MEDIA_PRIVATE_BUCKET_NAME || "",
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try { return decodeURIComponent(segment); } catch { return ""; }
    });
  const bucketIndex = bucketName ? segments.indexOf(bucketName) : -1;
  const referenceIndex = segments.indexOf("references", bucketIndex >= 0 ? bucketIndex + 1 : 0);
  if (referenceIndex < 0) return null;
  const objectKey = segments.slice(referenceIndex).join("/");
  return objectKey.startsWith("references/") && !objectKey.includes("..") ? objectKey : null;
}
