#!/usr/bin/env node
/**
 * Phase 8 batch-production CLI (scaffold).
 *
 * Usage: npx tsx scripts/animator-batch.mjs <manifest.json> [--dry-run]
 *
 * Reads a batch manifest, validates it, and prints the execution plan.
 * Job dispatch (rig → retarget → LOD → lipsync) wires in at Phase 8; until
 * then this exits 0 on a valid manifest (--dry-run behavior) so it can be
 * used to author manifests early.
 *
 * Manifest shape (v1):
 * {
 *   "version": "1",
 *   "profileId": "quadruped.dog.medium",        // default for all entries
 *   "steps": ["rig", "retarget", "lod", "lipsync"],
 *   "entries": [
 *     { "assetId": "abc123", "meshUrl": "https://…/pet.glb", "profileId": "…?", "speakText": "…?" }
 *   ]
 * }
 */
import fs from "node:fs";

const VALID_STEPS = new Set(["rig", "retarget", "lod", "lipsync", "reconstruct", "bake"]);

function fail(message) {
  console.error(`[animator-batch] ${message}`);
  process.exit(1);
}

const manifestPath = process.argv[2];
if (!manifestPath) fail("usage: animator-batch.mjs <manifest.json> [--dry-run]");
if (!fs.existsSync(manifestPath)) fail(`manifest not found: ${manifestPath}`);

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (err) {
  fail(`manifest is not valid JSON: ${err.message}`);
}

if (manifest.version !== "1") fail(`unsupported manifest version: ${manifest.version ?? "missing"}`);
if (!Array.isArray(manifest.steps) || !manifest.steps.length) fail("steps[] is required");
for (const step of manifest.steps) if (!VALID_STEPS.has(step)) fail(`unknown step: ${step}`);
if (!Array.isArray(manifest.entries) || !manifest.entries.length) fail("entries[] is required");
manifest.entries.forEach((entry, index) => {
  if (!entry?.assetId && !entry?.meshUrl) fail(`entry ${index}: assetId or meshUrl required`);
  if (manifest.steps.includes("lipsync") && entry.speakText && typeof entry.speakText !== "string") {
    fail(`entry ${index}: speakText must be a string`);
  }
});

console.log(`[animator-batch] manifest OK: ${manifest.entries.length} entries × steps [${manifest.steps.join(" → ")}]`);
for (const [index, entry] of manifest.entries.entries()) {
  const profile = entry.profileId || manifest.profileId || "(profile required at rig step)";
  console.log(`  ${index + 1}. ${entry.assetId || entry.meshUrl} · profile=${profile}${entry.speakText ? " · speaks" : ""}`);
}

if (process.argv.includes("--dry-run")) process.exit(0);
console.error("[animator-batch] dispatch is not implemented; rerun with --dry-run to validate only");
process.exit(2);
