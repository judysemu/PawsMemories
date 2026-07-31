import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";

async function check(message, testFn) {
  process.stdout.write(`- ${message}... `);
  try {
    await testFn();
    console.log(`${GREEN}✓${RESET}`);
    return true;
  } catch (e) {
    console.log(`${RED}✗${RESET}`);
    console.error(`  ${e.message}`);
    return false;
  }
}

async function probeWarning(message, testFn) {
  process.stdout.write(`- ${message}... `);
  try {
    await testFn();
    console.log(`${GREEN}✓${RESET}`);
    return true;
  } catch (e) {
    console.log(`${YELLOW}⚠ (optional, will degrade gracefully)${RESET}`);
    console.error(`  ${e.message}`);
    return true;
  }
}

async function run() {
  console.log(`${BOLD}Animator Subsystem Doctor${RESET}\n`);
  let allPass = true;

  // 1. Node version
  allPass = (await check("Node version", () => {
    const version = process.version;
    if (version < "v18.0.0") throw new Error(`Node >= v18 required, got ${version}`);
  })) && allPass;

  // 2. Runtime imports. The application uses the library APIs directly; it
  // does not shell out to the gltf-transform CLI.
  allPass = (await check("@gltf-transform core/functions importable", async () => {
    await import("@gltf-transform/core");
    await import("@gltf-transform/functions");
  })) && allPass;

  // 3. Optional Dependencies
  try {
    await import("sharp");
    console.log(`- sharp is available... ${GREEN}✓${RESET}`);
  } catch (e) {
    console.log(`- sharp is available... ${YELLOW}⚠ (Warning: sharp is missing, image operations might be slower)${RESET}`);
  }

  // 4. Workspace
  const dataDir = process.env.ANIMATOR_DATA_DIR || path.join(process.cwd(), "data", "animator");
  allPass = (await check(`ANIMATOR_DATA_DIR (${dataDir}) exists & writable`, () => {
    const fix = process.argv.includes("--fix");
    if (fix && !fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (!fs.existsSync(dataDir)) {
      throw new Error(`Directory does not exist. Run with --fix to create it.`);
    }

    const testFile = path.join(dataDir, ".test");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
  })) && allPass;

  // 5. Directories
  const dirs = [
    "originals",
    "outputs",
    "jobs/pending",
    "jobs/running",
    "jobs/done",
    "jobs/failed",
    "manifests",
    "projects",
    "recordings",
    "screenshots",
    "scenes/backgrounds",
    "tmp"
  ];
  allPass = (await check("Workspace subdirectories exist", () => {
    const fix = process.argv.includes("--fix");
    for (const d of dirs) {
      const p = path.join(dataDir, d);
      if (fix && !fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
      if (!fs.existsSync(p)) throw new Error(`Missing ${d}. Run with --fix.`);
    }
  })) && allPass;

  // ──────────────────────────────────────────────────────────────────
  // Animator Builder-out Phase‑0 probes (new job types, §12 schemas)
  // ──────────────────────────────────────────────────────────────────

  // 6. New job types directory support
  const newJobDirs = ["rig", "retarget", "repurpose", "lipsync", "reconstruct", "bake"];
  allPass = (await check("New job type directories ready", () => {
    const fix = process.argv.includes("--fix");
    for (const jt of newJobDirs) {
      const p = path.join(dataDir, "jobs", jt);
      if (fix && !fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
      if (!fs.existsSync(p)) throw new Error(`Missing jobs/${jt}. Run with --fix.`);
    }
  })) && allPass;

  // 7. Profile directory (for BoneDefinitionProfile v1 files)
  const profilesDir = path.join(process.cwd(), "blender-worker", "profiles");
  allPass = (await probeWarning(`Profiles directory (${profilesDir}) exists`, () => {
    if (!fs.existsSync(profilesDir)) {
      const fix = process.argv.includes("--fix");
      if (fix) {
        fs.mkdirSync(profilesDir, { recursive: true });
        return;
      }
      throw new Error(`Directory does not exist. Run with --fix to create it.`);
    }
  })) && allPass;

  // 8. Rhubarb Lip Sync CLI (Tier B — optional, degrades gracefully)
  //    Resolution order mirrors server/animator/lipsync.ts resolveRhubarbBin():
  //      RHUBARB_BIN env → vendor/local paths → PATH (rhubarb-lipsync | rhubarb)
  const rhubarbVendor = [
    path.join(process.cwd(), "bin", "rhubarb-lipsync"),
    path.join(process.cwd(), "bin", "rhubarb"),
    path.join(process.cwd(), "vendor", "rhubarb", "rhubarb"),
    path.join(process.cwd(), "vendor", "rhubarb", "rhubarb-lipsync"),
    "/usr/local/bin/rhubarb",
    "/usr/local/bin/rhubarb-lipsync",
    "/opt/rhubarb/rhubarb",
  ];
  function resolveRhubarbBin() {
    const envBin = process.env.RHUBARB_BIN;
    if (envBin) {
      if (path.isAbsolute(envBin) || envBin.includes("/") || envBin.includes("\\")) {
        return fs.existsSync(envBin) && fs.statSync(envBin).isFile() ? envBin : null;
      }
      return envBin; // bare name — trust PATH
    }
    for (const c of rhubarbVendor) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    for (const name of ["rhubarb-lipsync", "rhubarb"]) {
      try {
        const r = spawnSync(name, ["--version"], { stdio: "ignore", timeout: 2000 });
        if (r.status === 0) return name;
      } catch {
        /* keep probing */
      }
    }
    return null;
  }
  allPass = (await probeWarning("Rhubarb Lip Sync CLI (Tier B, optional)", () => {
    const bin = resolveRhubarbBin();
    if (!bin) {
      throw new Error(
        "Rhubarb not found. Set RHUBARB_BIN to its absolute path, or place it in bin/ or on PATH. " +
          "Download: https://github.com/DanielSWolf/rhubarb-lip-sync/releases",
      );
    }
    let ver = "unknown";
    try {
      const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
      if (r.stdout) ver = r.stdout.split("\n")[0].trim() || ver;
    } catch {
      /* version probe is best-effort */
    }
    if (process.env.RHUBARB_BIN) console.log(`      Resolved via RHUBARB_BIN = ${bin}`);
    console.log(`      Version: ${ver}`);
  })) && allPass;

  // 9. meshoptimizer (QEM simplification — optional, degrades gracefully)
  allPass = (await probeWarning("meshoptimizer (Node bindings)", async () => {
    try {
      await import("meshoptimizer");
    } catch {
      throw new Error("meshoptimizer not installed or importable");
    }
  })) && allPass;

  // 10. Worker reachability (blender-worker HTTP health endpoint)
  const workerUrl = process.env.BLENDER_WORKER_URL || "http://localhost:8080";
  const workerHealthUrl = `${workerUrl.replace(/\/+$/, "")}/health`;
  allPass = (await probeWarning(`Worker reachability (${workerHealthUrl})`, async () => {
    let response;
    try {
      response = await fetch(workerHealthUrl, { signal: AbortSignal.timeout(3000) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      throw new Error(`Worker health request failed: ${detail}`);
    }
    if (!response.ok) {
      throw new Error(`Worker health request returned HTTP ${response.status}`);
    }
  })) && allPass;

  console.log("");
  if (allPass) {
    console.log(`${GREEN}All server-side checks passed.${RESET}`);
    console.log(`\nNote: WebCodecs/H.264 support is validated client-side at runtime.`);
    console.log(`Check console snippets:`);
    console.log(`  await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 16000000, framerate: 60 })`);
    process.exit(0);
  } else {
    console.log(`${RED}Some checks failed.${RESET}`);
    process.exit(1);
  }
}

run();
