import assert from "node:assert/strict";
import test from "node:test";
import {
  storeReferenceImage,
  storeReferenceManifest,
  storeReferenceReport,
  storeReferenceSource,
} from "../server/reference-sessions/storage.ts";
import { resetPrivateStorageClient } from "../storage.private.ts";

const storageEnvNames = [
  "MEDIA_BUCKET_NAME",
  "MEDIA_PRIVATE_BUCKET_NAME",
  "MEDIA_BUCKET_URL",
  "MEDIA_BUCKET_KEY",
  "MEDIA_BUCKET_SECRET",
  "MEDIA_PRIVATE_BUCKET_KEY",
  "MEDIA_PRIVATE_BUCKET_SECRET",
];

test("reference persistence fails closed when private Backblaze configuration is missing", async (t) => {
  const prior = Object.fromEntries(storageEnvNames.map((name) => [name, process.env[name]]));
  for (const name of storageEnvNames) delete process.env[name];
  resetPrivateStorageClient();

  t.after(() => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetPrivateStorageClient();
  });

  const sessionUuid = "3f2504e0-4f89-11d3-9a0c-0305e82b3301";
  const image = Buffer.from("durable-reference-image");
  const writes = [
    () => storeReferenceSource(sessionUuid, image, "image/png"),
    () => storeReferenceImage(sessionUuid, 1, "front", image, "image/png"),
    () => storeReferenceReport(sessionUuid, 1, Buffer.from("{}")),
    () => storeReferenceManifest(sessionUuid, Buffer.from("{}")),
  ];

  for (const write of writes) {
    await assert.rejects(write, /MEDIA_PRIVATE_BUCKET_NAME/);
  }
});
