#!/usr/bin/env node
/** Run the accepted Blender rig and clip code once, without opening a service. */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const EXPECTED_BLENDER_VERSION = "5.1.2";
const EXPECTED_SOURCE_REVISION = "75fbf0183001ed9876c8dbb35de6b68552ee08bd";
const EXPECTED_MODEL_REVISION = "af44b45f2e35a493886929c6d786e563ec68364d";
const REVISION_PATTERN = /^[0-9a-f]{40}$/;

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function runBlenderScript(source, label) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `paws-${label}-`));
  const scriptPath = path.join(temporary, `${label}.py`);
  try {
    fs.writeFileSync(scriptPath, source, { mode: 0o600, flag: "wx" });
    execFileSync("blender", ["--background", "--python-exit-code", "1", "--python", scriptPath], {
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 45 * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { success: true };
  } catch {
    return { success: false, error: `${label} Blender process failed` };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function requireFinalContract(inspection) {
  const document = inspection.document;
  const animations = Array.isArray(document.animations) ? document.animations : [];
  const names = animations.map((animation) => String(animation?.name || "").toLowerCase());
  if (!names.some((name) => name.includes("idle")) || !names.some((name) => name.includes("walk"))) {
    throw new Error("FINAL_REQUIRED_CLIPS_MISSING");
  }
  let channels = 0;
  for (const animation of animations) {
    for (const channel of animation?.channels || []) {
      channels += 1;
      if (!Number.isInteger(channel?.target?.node) || !document.nodes?.[channel.target.node]) {
        throw new Error("FINAL_ANIMATION_TARGET_INVALID");
      }
    }
  }
  if (channels === 0 || !inspection.hasSkinnedMesh || inspection.jointCount === 0) {
    throw new Error("FINAL_RIG_CONTRACT_MISSING");
  }
  const weighted = (document.meshes || []).flatMap((mesh) => mesh?.primitives || []).some(
    (primitive) => primitive?.attributes?.JOINTS_0 !== undefined && primitive?.attributes?.WEIGHTS_0 !== undefined,
  );
  if (!weighted || !(document.materials || []).length || !((document.textures || []).length || (document.images || []).length)) {
    throw new Error("FINAL_PBR_OR_WEIGHTS_MISSING");
  }
  for (const entry of [...(document.buffers || []), ...(document.images || [])]) {
    if (typeof entry?.uri === "string" && !entry.uri.startsWith("data:")) throw new Error("FINAL_EXTERNAL_URI_REJECTED");
  }
  return [...new Set(names)].sort();
}

async function main() {
  const { values } = parseArgs({
    options: {
      "input-dir": { type: "string" },
      "output-dir": { type: "string" },
    },
    strict: true,
  });
  const inputDirectory = path.resolve(values["input-dir"] || "");
  const outputDirectory = path.resolve(values["output-dir"] || "");
  const sourcePath = path.join(inputDirectory, "master.glb");
  const metadataPath = path.join(inputDirectory, "base-metadata.json");
  if (
    !values["input-dir"] || !values["output-dir"]
    || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()
    || !fs.existsSync(metadataPath) || !fs.statSync(metadataPath).isFile()
  ) {
    throw new Error("FINITE_BLENDER_INPUT_MISSING");
  }
  const runtimeRepositoryRevision = process.env.PAWS_RUNTIME_REPOSITORY_REVISION || "";
  if (process.env.BLENDER_VERSION !== EXPECTED_BLENDER_VERSION || !REVISION_PATTERN.test(runtimeRepositoryRevision)) {
    throw new Error("BLENDER_IMAGE_METADATA_MISMATCH");
  }
  const runtimeRevisionFile = process.env.PAWS_RUNTIME_REVISION_FILE || "/app/PAWS_RUNTIME_REVISION";
  if (!fs.existsSync(runtimeRevisionFile)
    || fs.readFileSync(runtimeRevisionFile, "utf8").trim() !== runtimeRepositoryRevision) {
    throw new Error("IMAGE_RUNTIME_REVISION_MISMATCH");
  }
  const version = execFileSync("blender", ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (!version.startsWith(`Blender ${EXPECTED_BLENDER_VERSION}`)) throw new Error("BLENDER_VERSION_MISMATCH");

  const source = fs.readFileSync(sourcePath);
  const baseMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  if (
    baseMetadata.status !== "PASS"
    || baseMetadata.provider !== "trellis2"
    || baseMetadata.runtimeRepositoryRevision !== runtimeRepositoryRevision
    || baseMetadata.sourceRevision !== EXPECTED_SOURCE_REVISION
    || baseMetadata.modelRevision !== EXPECTED_MODEL_REVISION
    || baseMetadata.outputSha256 !== digest(source)
    || baseMetadata.outputBytes !== source.length
  ) throw new Error("TRELLIS_HANDOFF_INVALID");

  const appRoot = process.env.PAWS_BLENDER_APP_ROOT || "/app";
  const pipelineModule = await import(pathToFileURL(path.join(appRoot, "rig_pipeline", "index.js")));
  const clipsModule = await import(pathToFileURL(path.join(appRoot, "skeletal-clips.js")));
  const bridge = { executeCode: async (script) => runBlenderScript(script, "rig") };
  const processor = pipelineModule.createRigPipelineProcessor({
    runner: pipelineModule.createBlenderPipelineRunner({
      bridge,
      pipelineDirectory: path.join(appRoot, "rig_pipeline"),
    }),
    profileDirectory: path.join(appRoot, "profiles"),
    acquireAsset: async () => source,
  });
  const jobUuid = crypto.randomUUID();
  const attemptUuid = crypto.randomUUID();
  const processed = await processor.process({
    contractVersion: 1,
    jobUuid,
    attemptUuid,
    idempotencyKey: `azureml-oneshot-${attemptUuid}`,
    profileId: "quadruped.dog.medium",
    classification: "quadruped",
    requestFacial: false,
    requestedFacialTargets: [],
    source: { locator: "artifact+job://trellis/master.glb", sha256: digest(source), sizeBytes: source.length },
    budgets: { maxJoints: 128, maxInfluences: 4, maxTriangles: 1_000_000, maxTextureDimension: 4096 },
    accessories: [],
  });
  if (processed.rig?.overallPass !== true) throw new Error("RIG_PIPELINE_NOT_ACCEPTED");
  const rigged = Buffer.from(processed.output.glbBase64, "base64");
  if (digest(rigged) !== processed.output.sha256 || rigged.length !== processed.output.sizeBytes) {
    throw new Error("RIGGED_ARTIFACT_INTEGRITY_FAILED");
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "paws-clips-once-"));
  try {
    const riggedPath = path.join(temporary, "rigged.glb");
    const finalPath = path.join(temporary, "final.glb");
    fs.writeFileSync(riggedPath, rigged, { mode: 0o600, flag: "wx" });
    const clipScript = clipsModule.buildSkeletalClipScript(riggedPath, finalPath);
    const clipResult = runBlenderScript(clipScript, "clips");
    if (!clipResult.success || !fs.existsSync(finalPath)) throw new Error("CLIP_BAKE_FAILED");
    const final = fs.readFileSync(finalPath);
    const inspection = pipelineModule.inspectGlb(final);
    const animations = requireFinalContract(inspection);
    if (digest(source) === digest(final)) throw new Error("FINAL_ARTIFACT_UNCHANGED");
    fs.writeFileSync(path.join(outputDirectory, "rigged.glb"), rigged, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(path.join(outputDirectory, "final.glb"), final, { mode: 0o600, flag: "wx" });
    const acceptance = {
      schemaVersion: "paws.azureml-inhouse-e2e.v1",
      status: "PASS",
      provider: "trellis2",
      runtimeRepositoryRevision,
      sourceRevision: EXPECTED_SOURCE_REVISION,
      modelRevision: EXPECTED_MODEL_REVISION,
      blenderVersion: EXPECTED_BLENDER_VERSION,
      baseSha256: digest(source),
      riggedSha256: digest(rigged),
      finalSha256: digest(final),
      finalBytes: final.length,
      animations,
      hasSkinnedMesh: inspection.hasSkinnedMesh,
      jointCount: inspection.jointCount,
      externalGenerativeProviderCalls: 0,
    };
    fs.writeFileSync(path.join(outputDirectory, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log("BLENDER_ONESHOT_PASS");
}

await main();
