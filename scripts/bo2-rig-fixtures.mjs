#!/usr/bin/env node
/**
 * BO-2 live rig-fixture harness.
 *
 * Drives the REAL Phase-4 rig contract against a deployed Blender worker and
 * prints the measured evidence the BO-2 exit gate requires. This is the
 * one-command live acceptance run; it performs no billing, no database writes,
 * and no storage mutations — it exercises only the worker round-trip plus the
 * same independent verification the production service applies.
 *
 * Usage:
 *   BLENDER_WORKER_URL=https://... WORKER_SHARED_SECRET=... \
 *   node scripts/bo2-rig-fixtures.mjs \
 *     --source-url <signed GLB url> --classification quadruped \
 *     [--facial] [--profile default]
 *
 * The source GLB must be reachable by the worker (a short-lived signed URL of
 * a canonical asset is the intended input). Exit code 0 = every verification
 * gate passed; nonzero = a measured failure, printed with its rule table.
 */
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import {
  HttpRigWorkerClient,
  createRigWorkerRequest,
  verifyWorkerOutput,
  inspectRiggedGlb,
} from "../server/rig-pipeline/worker.ts";

const { values: args } = parseArgs({
  options: {
    "source-url": { type: "string" },
    classification: { type: "string", default: "quadruped" },
    facial: { type: "boolean", default: false },
    profile: { type: "string", default: "default" },
  },
});

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

if (!process.env.BLENDER_WORKER_URL) fail("BLENDER_WORKER_URL is required");
if (!process.env.WORKER_SHARED_SECRET) fail("WORKER_SHARED_SECRET is required");
if (!args["source-url"]) fail("--source-url is required (signed URL of the source GLB)");
if (!["biped", "quadruped"].includes(args.classification)) fail("--classification must be biped or quadruped");

const sourceUrl = args["source-url"];

console.log(`Fetching source GLB to compute its hash: ${sourceUrl.slice(0, 80)}…`);
const sourceResponse = await fetch(sourceUrl);
if (!sourceResponse.ok) fail(`Cannot fetch source GLB (HTTP ${sourceResponse.status})`);
const sourceBytes = Buffer.from(await sourceResponse.arrayBuffer());
const sourceSha = crypto.createHash("sha256").update(sourceBytes).digest("hex");
console.log(`Source: ${sourceBytes.length} bytes, sha256 ${sourceSha.slice(0, 16)}…`);

const request = createRigWorkerRequest({
  jobUuid: crypto.randomUUID(),
  attemptUuid: crypto.randomUUID(),
  idempotencyKey: `bo2-fixture-${Date.now()}`,
  profileId: args.profile,
  classification: args.classification,
  requestFacial: args.facial,
  source: { locator: sourceUrl, sha256: sourceSha, sizeBytes: sourceBytes.length },
  accessories: [],
});

console.log(`\nDispatching to ${process.env.BLENDER_WORKER_URL}/rig-pipeline/process (classification=${args.classification}, facial=${args.facial})…`);
const started = Date.now();
const client = new HttpRigWorkerClient();
let result;
try {
  result = await client.process(request);
} catch (error) {
  fail(`Worker call failed: ${error.message}`);
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

let output;
try {
  output = verifyWorkerOutput(request, result);
} catch (error) {
  fail(`Independent output verification failed: ${error.message}`);
}

let inspection;
try {
  inspection = await inspectRiggedGlb(output, result);
} catch (error) {
  fail(`GLB reopen inspection failed: ${error.message}`);
}

console.log(`\n✅ Worker round-trip + independent verification passed in ${elapsed}s`);
console.log(`\nRig metrics (worker-measured):`);
for (const [key, value] of Object.entries(result.rig.metrics)) {
  if (key === "boneNames") continue;
  console.log(`  ${key}: ${value}`);
}
console.log(`\nReopened-GLB inspection (independent):`);
for (const [key, value] of Object.entries(inspection)) {
  console.log(`  ${key}: ${Array.isArray(value) ? value.slice(0, 12).join(", ") + (value.length > 12 ? "…" : "") : value}`);
}
console.log(`\nRig rules (${result.rig.rules.length}, overallPass=${result.rig.overallPass}):`);
for (const rule of result.rig.rules) {
  console.log(`  ${rule.pass ? "PASS" : "FAIL"}  ${rule.rule} — ${rule.detail}${rule.measured !== undefined ? ` (measured: ${rule.measured})` : ""}`);
}
console.log(`\nFacial capability: ${result.facial.capability} (blink=${result.facial.hasBlink}, jaw=${result.facial.hasJaw})`);
if (result.facial.targets.length > 0) {
  console.log(`Facial targets with measured deformation:`);
  for (const target of result.facial.targets) {
    console.log(`  ${target.canonicalName ?? target.name}: displaced=${target.displacedVertexCount} max=${target.maxDisplacement.toFixed(5)} locality=${target.localityPass} deformation=${target.deformationPass}`);
  }
}
if (result.warnings.length) console.log(`\nWarnings:\n  ${result.warnings.join("\n  ")}`);

if (!result.rig.overallPass) fail("Rig rule aggregate did not pass");
console.log(`\n✅ Fixture PASSED — record this output in phase-evidence/BO_2.md`);
