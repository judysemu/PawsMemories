import crypto from "node:crypto";

const extensionByMime = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function storedObject(objects, objectKey, body) {
  const buffer = Buffer.from(body);
  const stored = {
    objectKey,
    sizeBytes: buffer.byteLength,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
  objects.set(objectKey, { ...stored, body: buffer });
  return stored;
}

/** Explicit test dependency. Production never substitutes this for Backblaze. */
export function createReferenceStorageTestDouble() {
  const objects = new Map();
  return {
    objects,
    async storeReferenceImage(sessionUuid, attemptNumber, viewKind, imageBuffer, mimeType = "image/png") {
      const ext = extensionByMime[mimeType] || "bin";
      return storedObject(objects, `references/${sessionUuid}/attempt_${attemptNumber}/${viewKind}.${ext}`, imageBuffer);
    },
    async storeReferenceSource(sessionUuid, imageBuffer, mimeType) {
      const ext = extensionByMime[mimeType] || "bin";
      return storedObject(objects, `references/${sessionUuid}/source/${crypto.randomUUID()}.${ext}`, imageBuffer);
    },
    async storeReferenceReport(sessionUuid, attemptNumber, reportBuffer) {
      return storedObject(
        objects,
        `references/${sessionUuid}/attempt_${attemptNumber}/consistency-report-${crypto.randomUUID()}.json`,
        reportBuffer,
      );
    },
    async storeReferenceManifest(sessionUuid, manifestBuffer) {
      return storedObject(
        objects,
        `references/${sessionUuid}/approved/manifest-${crypto.randomUUID()}.json`,
        manifestBuffer,
      );
    },
    async loadReferenceObject(objectKey) {
      const stored = objects.get(objectKey);
      if (!stored) throw new Error(`Test reference object not found: ${objectKey}`);
      return Buffer.from(stored.body);
    },
    async cleanupReferenceImage(objectKey) {
      objects.delete(objectKey);
    },
  };
}
