import crypto from "node:crypto";
import { putPrivateObject, deletePrivateObject, extensionForMime } from "../../storage.private";
import type { ViewKind } from "./types";

export type StoredReferenceObject = { objectKey: string; sizeBytes: number; sha256: string };

export interface ReferenceStorageAdapter {
  storeReferenceImage(
    sessionUuid: string,
    attemptNumber: number,
    viewKind: ViewKind,
    imageBuffer: Buffer,
    mimeType?: string,
  ): Promise<StoredReferenceObject>;
  storeReferenceSource(sessionUuid: string, imageBuffer: Buffer, mimeType: string): Promise<StoredReferenceObject>;
  storeReferenceReport(sessionUuid: string, attemptNumber: number, reportBuffer: Buffer): Promise<StoredReferenceObject>;
  storeReferenceManifest(sessionUuid: string, manifestBuffer: Buffer): Promise<StoredReferenceObject>;
  cleanupReferenceImage(objectKey: string): Promise<void>;
}

export function mintReferenceObjectKey(
  sessionUuid: string,
  attemptNumber: number,
  viewKind: ViewKind,
  mimeType: string,
): string {
  if (!/^[0-9a-f-]{36}$/i.test(sessionUuid)) {
    throw new Error(`Invalid session UUID: ${sessionUuid}`);
  }
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error(`Invalid attempt number: ${attemptNumber}`);
  }
  const ext = extensionForMime(mimeType);
  return `references/${sessionUuid}/attempt_${attemptNumber}/${viewKind}.${ext}`;
}

export async function storeReferenceImage(
  sessionUuid: string,
  attemptNumber: number,
  viewKind: ViewKind,
  imageBuffer: Buffer,
  mimeType: string = "image/png",
): Promise<StoredReferenceObject> {
  const objectKey = mintReferenceObjectKey(sessionUuid, attemptNumber, viewKind, mimeType);
  return putPrivateObject(objectKey, imageBuffer, mimeType);
}

export async function storeReferenceSource(
  sessionUuid: string,
  imageBuffer: Buffer,
  mimeType: string,
): Promise<StoredReferenceObject> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionUuid)) throw new Error(`Invalid session UUID: ${sessionUuid}`);
  const objectKey = `references/${sessionUuid}/source/${crypto.randomUUID()}.${extensionForMime(mimeType)}`;
  return putPrivateObject(objectKey, imageBuffer, mimeType);
}

export async function storeReferenceReport(
  sessionUuid: string,
  attemptNumber: number,
  reportBuffer: Buffer,
): Promise<StoredReferenceObject> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionUuid) || !Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("Invalid reference report identity.");
  }
  const objectKey = `references/${sessionUuid}/attempt_${attemptNumber}/consistency-report-${crypto.randomUUID()}.json`;
  return putPrivateObject(objectKey, reportBuffer, "application/json");
}

export async function storeReferenceManifest(
  sessionUuid: string,
  manifestBuffer: Buffer,
): Promise<StoredReferenceObject> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionUuid)) throw new Error("Invalid reference manifest identity.");
  const objectKey = `references/${sessionUuid}/approved/manifest-${crypto.randomUUID()}.json`;
  return putPrivateObject(objectKey, manifestBuffer, "application/json");
}

export async function cleanupReferenceImage(objectKey: string): Promise<void> {
  if (!objectKey.startsWith("references/")) {
    throw new Error("Refusing to clean up object outside references/ prefix.");
  }
  await deletePrivateObject(objectKey).catch((err) => {
    console.warn(`⚠️ Compensating cleanup failed for reference object ${objectKey}:`, err.message);
  });
}

export const privateReferenceStorage: ReferenceStorageAdapter = {
  storeReferenceImage,
  storeReferenceSource,
  storeReferenceReport,
  storeReferenceManifest,
  cleanupReferenceImage,
};
