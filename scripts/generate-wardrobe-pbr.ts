#!/usr/bin/env -S npx tsx
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createAzurePbrQueue } from "../server/pbr/azurePbrQueue";

import {
  FAL_PBR_ENDPOINT,
  FAL_PBR_MAP_KINDS,
  generateFalPbrMaterial,
} from "../server/pbr/falPbr";
import {
  WARDROBE_PBR_PROFILES,
  getWardrobePbrProfile,
} from "../shared/wardrobePbrCatalog";
import {
  parseWardrobePbrManifest,
  type WardrobePbrManifest,
  type WardrobePbrManifestEntry,
} from "../src/wardrobe/pbrManifest";

const ROOT = process.cwd();
const MATERIALS_ROOT = path.resolve(ROOT, "public/wardrobe/materials");
const MANIFEST_PATH = path.join(MATERIALS_ROOT, "manifest.json");
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message: string): never {
  throw new Error(message);
}

function parseArguments(args: string[]): { ids: string[]; force: boolean } {
  const ids: string[] = [];
  let all = false;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all") all = true;
    else if (arg === "--force") force = true;
    else if (arg === "--material") ids.push(args[++index] || fail("--material requires an ID"));
    else if (arg.startsWith("--material=")) ids.push(arg.slice("--material=".length));
    else fail(`Unknown argument: ${arg}`);
  }
  if (all && ids.length) fail("Use --all or --material, not both");
  if (!all && !ids.length) fail("Select --all or at least one --material <id>");

  const selected = all ? WARDROBE_PBR_PROFILES.map((entry) => entry.id) : [...new Set(ids)];
  for (const id of selected) {
    if (!SAFE_ID.test(id) || !getWardrobePbrProfile(id)) fail(`Unknown material ID: ${id}`);
  }
  const maximum = Math.max(1, Math.min(50, Number(process.env.FAL_PBR_MAX_MATERIALS_PER_RUN || 15) || 15));
  if (selected.length > maximum) fail(`Selected ${selected.length} materials; run cap is ${maximum}`);
  return { ids: selected, force };
}

function configHash(profile: NonNullable<ReturnType<typeof getWardrobePbrProfile>>): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    model: FAL_PBR_ENDPOINT,
    maps: FAL_PBR_MAP_KINDS,
    dimension: 1024,
    prompt: profile.prompt,
    seed: profile.seed,
    promptExpansion: false,
  })).digest("hex");
}

async function readManifest(): Promise<WardrobePbrManifest> {
  try {
    const parsed = parseWardrobePbrManifest(JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8")));
    if (!parsed) fail("Existing wardrobe PBR manifest is invalid");
    return parsed;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    return { schemaVersion: 1, generatedAt: null, materials: {} };
  }
}

async function existingEntryIsComplete(entry: WardrobePbrManifestEntry, expectedHash: string): Promise<boolean> {
  if (entry.configHash !== expectedHash) return false;
  for (const kind of FAL_PBR_MAP_KINDS) {
    const absolutePath = path.resolve(ROOT, `public${entry.maps[kind].path}`);
    if (!absolutePath.startsWith(`${MATERIALS_ROOT}${path.sep}`)) return false;
    let bytes: Buffer;
    try { bytes = await fs.readFile(absolutePath); } catch { return false; }
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== entry.maps[kind].sha256) return false;
  }
  return true;
}

async function writeManifest(manifest: WardrobePbrManifest): Promise<void> {
  const temporary = `${MANIFEST_PATH}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await fs.rename(temporary, MANIFEST_PATH);
}

async function installMaterial(
  profile: NonNullable<ReturnType<typeof getWardrobePbrProfile>>,
  generated: Awaited<ReturnType<typeof generateFalPbrMaterial>>,
  expectedHash: string,
): Promise<WardrobePbrManifestEntry> {
  const destination = path.join(MATERIALS_ROOT, profile.id);
  const staging = path.join(MATERIALS_ROOT, `.${profile.id}.tmp-${crypto.randomUUID()}`);
  const backup = path.join(MATERIALS_ROOT, `.${profile.id}.backup-${crypto.randomUUID()}`);
  await fs.mkdir(staging, { recursive: false });
  try {
    for (const kind of FAL_PBR_MAP_KINDS) {
      await fs.writeFile(path.join(staging, `${kind}.png`), generated.maps[kind].bytes, { mode: 0o644 });
    }
    let hadDestination = false;
    try {
      await fs.rename(destination, backup);
      hadDestination = true;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(staging, destination);
    } catch (error) {
      if (hadDestination) await fs.rename(backup, destination).catch(() => undefined);
      throw error;
    }
    if (hadDestination) await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    materialId: profile.id,
    configHash: expectedHash,
    provider: "fal-ai",
    model: FAL_PBR_ENDPOINT,
    seed: generated.seed,
    maps: Object.fromEntries(FAL_PBR_MAP_KINDS.map((kind) => [kind, {
      path: `/wardrobe/materials/${profile.id}/${kind}.png`,
      sha256: generated.maps[kind].sha256,
      width: generated.maps[kind].width,
      height: generated.maps[kind].height,
    }])) as WardrobePbrManifestEntry["maps"],
  };
}

async function main(): Promise<void> {
  if (process.env.FAL_PBR_AUTHORING_ENABLED !== "1") {
    fail("Paid PBR authoring is disabled. Set FAL_PBR_AUTHORING_ENABLED=1 for an explicit authoring run.");
  }

  // Build the queue adapter: Azure Container Apps or fal.ai
  const azureUrl = String(process.env.AZURE_PBR_WORKER_URL || "").trim();
  const azureSecret = String(process.env.AZURE_PBR_WORKER_SECRET || "").trim();
  let queue: ReturnType<typeof createAzurePbrQueue> | undefined;

  if (azureUrl) {
    if (!azureSecret) fail("AZURE_PBR_WORKER_SECRET is required when AZURE_PBR_WORKER_URL is set");
    queue = createAzurePbrQueue(azureUrl, azureSecret);
    process.stdout.write(`Using Azure PBR worker at ${azureUrl}\n`);
  } else {
    if (!String(process.env.FAL_KEY || "").trim()) fail("FAL_KEY or AZURE_PBR_WORKER_URL is required for PBR authoring");
    process.stdout.write("Using fal.ai PBR provider\n");
  }

  const { ids, force } = parseArguments(process.argv.slice(2));
  await fs.mkdir(MATERIALS_ROOT, { recursive: true });
  const manifest = await readManifest();

  for (const id of ids) {
    const profile = getWardrobePbrProfile(id)!;
    const expectedHash = configHash(profile);
    const existing = manifest.materials[id];
    if (existing && await existingEntryIsComplete(existing, expectedHash)) {
      process.stdout.write(`${id}: already verified; skipped\n`);
      continue;
    }
    if (existing && !force) {
      fail(`${id}: existing material differs or is incomplete; inspect it, then pass --force to replace it`);
    }

    const providerLabel = azureUrl ? "Azure PBR worker" : "fal.ai";
    process.stdout.write(`${id}: submitting one paid ${providerLabel} PBR authoring request\n`);
    const generated = await generateFalPbrMaterial(
      { prompt: profile.prompt, seed: profile.seed },
      { ...(queue ? { queue } : {}) },
    );
    manifest.materials[id] = await installMaterial(profile, generated, expectedHash);
    manifest.generatedAt = new Date().toISOString();
    await writeManifest(manifest);
    process.stdout.write(`${id}: installed four validated local maps\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`Wardrobe PBR authoring failed: ${String(error?.message || error)}\n`);
  process.exitCode = 1;
});
