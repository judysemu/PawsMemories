#!/usr/bin/env -S npx tsx
/**
 * Back up the Barkley source clip library to the private B2 bucket.
 *
 * public/barkley/barkley.glb is built from whole-model Tripo exports that live
 * OUTSIDE this repo (~51 MB in /Users/robert/barkley-clips). The repo can
 * therefore not rebuild the avatar from its own contents: lose that directory
 * and recovering it means paying Tripo to re-export every preset and
 * re-authoring the hand-keyed clips. This pushes it somewhere durable.
 *
 *   npx tsx scripts/manual/backup-barkley-clips.ts
 *   npx tsx scripts/manual/backup-barkley-clips.ts --dir /path/to/clips --dry-run
 *
 * Objects land under backups/barkley-clips/. That prefix is deliberately
 * outside the three prefixes deletePrivateObject will act on
 * (marketplace/, references/, models/), so nothing in the app can delete a
 * backup through the normal helpers — removing one takes the B2 console.
 *
 * Re-running is cheap: a file whose size and digest already match the manifest
 * is skipped, so this is safe to run on a schedule.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  putPrivateObject,
  headPrivateObject,
  getPrivateObjectBuffer,
  assertPrivateStorageConfig,
} from "../../storage.private.ts";

const dirFlag = process.argv.indexOf("--dir");
const SRC = dirFlag > 0 ? process.argv[dirFlag + 1] : "/Users/robert/barkley-clips";
const DRY = process.argv.includes("--dry-run");
const PREFIX = "backups/barkley-clips";
const MANIFEST_KEY = `${PREFIX}/manifest.json`;

interface Entry { file: string; sizeBytes: number; sha256: string; uploadedAt: string }

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

(async () => {
  try {
    assertPrivateStorageConfig();
  } catch (err: any) {
    console.error(`Private storage is not configured: ${err?.message || err}`);
    console.error("MEDIA_PRIVATE_BUCKET_NAME, MEDIA_PRIVATE_BUCKET_KEY, MEDIA_PRIVATE_BUCKET_SECRET");
    console.error("and MEDIA_BUCKET_URL must be set. They live in Hostinger, not in the local .env.");
    process.exit(2);
  }

  if (!fs.existsSync(SRC)) {
    console.error(`Source directory not found: ${SRC}`);
    process.exit(2);
  }

  const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".glb")).sort();
  if (!files.length) {
    console.error(`No .glb files in ${SRC} — refusing to write an empty manifest over a good one.`);
    process.exit(2);
  }

  // Read the previous manifest so an unchanged file is not re-uploaded. A
  // missing or unreadable manifest is not an error: it just means everything
  // is treated as new.
  let previous: Record<string, Entry> = {};
  try {
    const raw = await getPrivateObjectBuffer(MANIFEST_KEY);
    for (const e of JSON.parse(raw.toString("utf8")).files as Entry[]) previous[e.file] = e;
    console.log(`Existing manifest lists ${Object.keys(previous).length} file(s).`);
  } catch {
    console.log("No existing manifest — treating every file as new.");
  }

  const entries: Entry[] = [];
  let uploaded = 0, skipped = 0, bytes = 0;

  for (const file of files) {
    const full = path.join(SRC, file);
    const buf = fs.readFileSync(full);
    const digest = sha256(buf);
    const key = `${PREFIX}/${file}`;
    const prior = previous[file];

    // Trust the manifest only when the object is genuinely still there at the
    // right size; a manifest that has drifted from the bucket would otherwise
    // skip a file that no longer exists.
    if (prior && prior.sha256 === digest) {
      const head = await headPrivateObject(key);
      if (head && head.sizeBytes === buf.byteLength) {
        entries.push(prior);
        skipped++;
        console.log(`  ${file.padEnd(28)} unchanged`);
        continue;
      }
    }

    if (DRY) {
      console.log(`  ${file.padEnd(28)} would upload ${(buf.byteLength / 1048576).toFixed(2)} MB`);
      entries.push({ file, sizeBytes: buf.byteLength, sha256: digest, uploadedAt: "dry-run" });
      uploaded++; bytes += buf.byteLength;
      continue;
    }

    const res = await putPrivateObject(key, buf, "model/gltf-binary");
    if (res.sha256 !== digest) throw new Error(`${file}: digest mismatch after upload`);
    entries.push({ file, sizeBytes: buf.byteLength, sha256: digest, uploadedAt: new Date().toISOString() });
    uploaded++; bytes += buf.byteLength;
    console.log(`  ${file.padEnd(28)} uploaded ${(buf.byteLength / 1048576).toFixed(2)} MB`);
  }

  const manifest = {
    generatedAt: DRY ? "dry-run" : new Date().toISOString(),
    source: SRC,
    fileCount: entries.length,
    totalBytes: entries.reduce((n, e) => n + e.sizeBytes, 0),
    files: entries,
  };

  if (!DRY) {
    await putPrivateObject(MANIFEST_KEY, Buffer.from(JSON.stringify(manifest, null, 2)), "application/json");
  }

  console.log(
    `\n${uploaded} uploaded, ${skipped} unchanged, ${(bytes / 1048576).toFixed(1)} MB transferred.` +
    `\nManifest: ${MANIFEST_KEY} (${entries.length} files, ` +
    `${(manifest.totalBytes / 1048576).toFixed(1)} MB total)${DRY ? " — DRY RUN, nothing written" : ""}`
  );
})().catch((err) => { console.error(err?.message || err); process.exit(1); });
