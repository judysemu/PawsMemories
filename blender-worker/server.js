import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import net from "net";
import { execSync, exec, spawn } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import Jimp from "jimp";
import * as templates from "./animation-templates.js";
import { buildSkeletalClipScript, SKELETAL_CLIP_MANIFEST } from "./skeletal-clips.js";
import { buildSkeletalClipScript as buildSkeletalClipScriptHuman, SKELETAL_CLIP_MANIFEST as SKELETAL_CLIP_MANIFEST_HUMAN } from "./skeletal-clips-human.js";
import {
  createBlenderPipelineRunner,
  createRigPipelineHandler,
  createRigPipelineProcessor,
  createWorkerAuthMiddleware,
  RIG_PIPELINE_MAX_REQUEST_BYTES,
} from "./rig_pipeline/index.js";

const execPromise = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// Blender TCP Bridge Client
// =============================================================================

const BRIDGE_HOST = process.env.BLENDER_BRIDGE_HOST || "127.0.0.1";
const BRIDGE_PORT = parseInt(process.env.BLENDER_BRIDGE_PORT || "9876", 10);
const BRIDGE_SCRIPT_PATH = process.env.BLENDER_BRIDGE_SCRIPT || path.join(__dirname, "bridge", "tcp_server.py");
const SHOULD_AUTOSTART_BRIDGE = process.env.BLENDER_AUTOSTART_BRIDGE !== "false";
let bridgeProcess = null;

class BlenderBridgeClient {
  constructor(host = BRIDGE_HOST, port = BRIDGE_PORT) {
    this.host = host;
    this.port = port;
    this._requestId = 0;
  }

  /**
   * Send a JSON-RPC request to the Blender TCP bridge and wait for the response.
   * Creates a fresh TCP connection per request (simple, reliable for async work).
   */
  async send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      const socket = new net.Socket();
      let buffer = "";
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const succeed = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        socket.destroy();
        fail(new Error(`Bridge request timed out after 600s: ${method}`));
      }, 600000);

      socket.connect(this.port, this.host, () => {
        const request = JSON.stringify({ id, method, params }) + "\n";
        socket.write(request);
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          clearTimeout(timeout);
          const line = buffer.slice(0, newlineIndex);
          try {
            const response = JSON.parse(line);
            if (response.error) {
              fail(new Error(response.error.message || JSON.stringify(response.error)));
            } else {
              succeed(response.result);
            }
          } catch (e) {
            fail(new Error(`Invalid JSON from bridge: ${line.slice(0, 200)}`));
          }
          socket.end();
        }
      });

      socket.on("error", (err) => {
        fail(new Error(`Bridge connection error: ${err.message}`));
      });

      socket.on("close", () => {
        // Blender can be killed after writing an export but before sending
        // the JSON-RPC response. Treat the closed socket as a real failure so
        // Hostinger records the job failure immediately instead of waiting for
        // the 600-second request timeout.
        if (!settled) fail(new Error(`Blender bridge closed before replying to ${method}`));
      });
    });
  }

  async executeCode(code) {
    return this.send("execute_code", { code });
  }

  async getViewport(azimuth, elevation) {
    return this.send("get_viewport", { azimuth, elevation });
  }

  async readScene() {
    return this.send("read_scene", {});
  }

  async setViewportAngle(azimuth, elevation) {
    return this.send("set_viewport_angle", { azimuth, elevation });
  }

  async undo() {
    return this.send("undo", {});
  }

  async saveCheckpoint(name) {
    return this.send("save_checkpoint", { name });
  }

  async restoreCheckpoint(name) {
    return this.send("restore_checkpoint", { name });
  }

  async exportGlb(outputPath) {
    return this.send("export_glb", { output_path: outputPath });
  }

  async preparePrintStl(targetHeightMm) {
    return this.send("prepare_print_stl", { target_height_mm: targetHeightMm });
  }

  async physicsValidate(profile, facial) {
    return this.send("physics_validate", { profile, facial: !!facial });
  }

  async ping() {
    return this.send("ping", {});
  }
}

const bridge = new BlenderBridgeClient();
const rigPipelineProcessor = createRigPipelineProcessor({
  runner: createBlenderPipelineRunner({ bridge }),
});

function isLoopbackBridgeHost() {
  return BRIDGE_HOST === "127.0.0.1" || BRIDGE_HOST === "localhost" || BRIDGE_HOST === "::1";
}

function resolveBlenderCommand() {
  const candidates = [
    process.env.BLENDER_BIN,
    "blender",
    "/Applications/Blender.app/Contents/MacOS/Blender",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      execSync(`command -v "${candidate}"`, { stdio: "ignore", shell: "/bin/sh" });
      return candidate;
    } catch {}
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function waitForBridgeReady(timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await bridge.ping();
      if (result?.success) return result;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(lastError?.message || `Blender bridge did not become ready within ${timeoutMs}ms`);
}

async function ensureBridgeReady() {
  try {
    return await bridge.ping();
  } catch (err) {
    if (!SHOULD_AUTOSTART_BRIDGE || !isLoopbackBridgeHost()) {
      throw err;
    }

    if (bridgeProcess && bridgeProcess.exitCode === null) {
      return waitForBridgeReady(30000);
    }

    const blenderCommand = resolveBlenderCommand();
    if (!blenderCommand) {
      throw new Error("Blender bridge is not running and no Blender executable was found. Set BLENDER_BIN or start blender --background --python bridge/tcp_server.py.");
    }

    console.log(`[Bridge] Autostarting Blender TCP bridge with ${blenderCommand}`);
    bridgeProcess = spawn(blenderCommand, ["--background", "--python", BRIDGE_SCRIPT_PATH], {
      cwd: __dirname,
      env: { ...process.env, BLENDER_BRIDGE_PORT: String(BRIDGE_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    bridgeProcess.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[Bridge/blender] ${text}`);
    });
    bridgeProcess.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[Bridge/blender] ${text}`);
    });
    bridgeProcess.on("exit", (code, signal) => {
      console.warn(`[Bridge] Blender TCP bridge exited: code=${code} signal=${signal}`);
      // A dead child must not be treated as a healthy autostart process. The
      // next request will call ensureBridgeReady and start a fresh bridge.
      bridgeProcess = null;
    });
    bridgeProcess.on("error", (spawnErr) => {
      console.error(`[Bridge] Failed to start Blender TCP bridge: ${spawnErr.message}`);
    });

    return waitForBridgeReady(45000);
  }
}

// Extract the meaningful Python error from Blender's combined output
function extractBlenderError(stdout, stderr) {
  const combined = (stdout || "") + "\n" + (stderr || "");
  // Look for Python traceback in the output and capture everything after it
  const tracebackMatch = combined.match(/Traceback \(most recent call last\)[\s\S]+/m);
  if (tracebackMatch) {
    // Return last 1500 chars of traceback to get the full chain
    return tracebackMatch[0].slice(-1500);
  }
  // Look for lines containing ERROR or Error
  const errorLines = combined.split("\n").filter(l =>
    l.includes("ERROR") || l.includes("Error:") || l.includes("Exception:")
  ).filter(l =>
    !l.includes("mounted file-systems") && !l.includes("libEGL")
  );
  if (errorLines.length > 0) {
    return errorLines.join("\n").slice(-1500);
  }
  // Fallback: return tail of stdout (more useful than stderr for Blender)
  return (stdout || stderr || "Unknown error").slice(-1500);
}

const app = express();
const PORT = process.env.PORT || 10000;

function requireWorkerAuth(req, res, next) {
  const expected = process.env.WORKER_SHARED_SECRET;
  const provided = req.get("x-worker-secret");
  if (!expected || !provided) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  if (
    expectedBuffer.length !== providedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// The worker can execute arbitrary Blender/Python code and perform expensive
// downloads/renders. Keep only liveness public, and authenticate before the
// 100 MB JSON parser so anonymous traffic cannot allocate large request bodies.
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  return requireWorkerAuth(req, res, next);
});

// Auth runs before this route-specific parser so unauthenticated callers cannot
// force the legacy 100 MB parser to allocate for the rig pipeline endpoint.
app.post(
  "/rig-pipeline/process",
  createWorkerAuthMiddleware(),
  requireBridge,
  express.json({ limit: RIG_PIPELINE_MAX_REQUEST_BYTES }),
  createRigPipelineHandler(rigPipelineProcessor),
);

// Increase limit for GLB model data and large scripts
app.use(express.json({ limit: "100mb" }));

// =============================================================================
// In-memory job store for async processing
// =============================================================================
const jobs = new Map();

// Auto-cleanup jobs older than 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 15 * 60 * 1000) {
      // Cleanup temp dir if still around
      if (job.tempDir) {
        try { fs.rmSync(job.tempDir, { recursive: true, force: true }); } catch {}
      }
      jobs.delete(id);
    }
  }
}, 60000);

// Health check endpoint — also checks bridge connectivity
app.get("/health", async (req, res) => {
  try {
    const bridgeStatus = await bridge.ping().catch(() => null);
    res.status(200).json({
      status: "ok",
      activeJobs: jobs.size,
      bridge: bridgeStatus ? "connected" : "disconnected",
      blenderVersion: bridgeStatus?.blender_version || null,
    });
  } catch {
    res.status(200).json({ status: "ok", activeJobs: jobs.size, bridge: "disconnected" });
  }
});

// =============================================================================
// NEW: Bridge proxy endpoints (for the multi-agent system)
// =============================================================================

const IFC_WORKER = path.join(__dirname, "ifc_worker", "ifc_worker.py");
const IFC_CACHE = path.join(os.tmpdir(), "pawsome3d-ifc-cache");
const IFC_MAX_BYTES = 50 * 1024 * 1024;
const IFC_MAX_CONCURRENT = Math.max(1, Number(process.env.IFC_MAX_CONCURRENT || 2));
let ifcActiveProcesses = 0;
fs.mkdirSync(IFC_CACHE, { recursive: true });

function runIfcWorker(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (ifcActiveProcesses >= IFC_MAX_CONCURRENT) return reject(new Error("IFC worker is busy; retry shortly"));
    ifcActiveProcesses += 1;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      ifcActiveProcesses -= 1;
      callback(value);
    };
    const child = spawn(process.env.IFC_PYTHON || "python3", [IFC_WORKER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error("IFC operation timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      clearTimeout(timer);
      let result;
      try { result = JSON.parse(stdout.trim().split("\n").at(-1) || "{}"); }
      catch { return finish(reject, new Error(`Invalid IFC worker response: ${stderr || stdout}`)); }
      if (code !== 0 || !result.success) return finish(reject, new Error(result.error || stderr || "IFC operation failed"));
      finish(resolve, result);
    });
  });
}

function decodeIfcBase64(value) {
  if (typeof value !== "string" || !value) throw new Error("Missing ifc_base64");
  const raw = value.startsWith("data:") ? value.split(",")[1] : value;
  const buffer = Buffer.from(raw || "", "base64");
  if (!buffer.length || buffer.length > IFC_MAX_BYTES) throw new Error("IFC input must be between 1 byte and 50 MB");
  return buffer;
}

app.use(["/ifc/convert", "/ifc/export"], requireWorkerAuth);

app.post("/ifc/convert", async (req, res) => {
  let tempDir;
  try {
    const input = decodeIfcBase64(req.body?.ifc_base64);
    const hash = crypto.createHash("sha256").update(input).digest("hex");
    const cachedGlb = path.join(IFC_CACHE, `${hash}.glb`);
    const cachedSidecar = path.join(IFC_CACHE, `${hash}.json`);
    if (fs.existsSync(cachedGlb) && fs.existsSync(cachedSidecar)) {
      return res.json({ success: true, cached: true, sourceHash: hash, glb_base64: fs.readFileSync(cachedGlb).toString("base64"), sidecar: JSON.parse(fs.readFileSync(cachedSidecar, "utf8")) });
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ifc-import-"));
    const source = path.join(tempDir, "source.ifc");
    fs.writeFileSync(source, input, { mode: 0o600 });
    const report = await runIfcWorker(["convert", source, cachedGlb, "--dump-sidecar", cachedSidecar]);
    res.json({ success: true, cached: false, sourceHash: hash, glb_base64: fs.readFileSync(cachedGlb).toString("base64"), sidecar: report });
  } catch (err) {
    res.status(422).json({ error: err.message });
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

app.post("/ifc/export", async (req, res) => {
  let tempDir;
  try {
    if (!req.body?.model || typeof req.body.model !== "object") return res.status(400).json({ error: "Missing BIM model" });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ifc-export-"));
    const source = path.join(tempDir, "model.json");
    const ifc = path.join(tempDir, "model.ifc");
    const glb = path.join(tempDir, "model.glb");
    const sidecar = path.join(tempDir, "model.sidecar.json");
    fs.writeFileSync(source, JSON.stringify(req.body.model), { mode: 0o600 });
    const exportReport = await runIfcWorker(["export", source, ifc]);
    const conversionReport = await runIfcWorker(["convert", ifc, glb, "--dump-sidecar", sidecar]);
    res.json({ success: true, ifc_base64: fs.readFileSync(ifc).toString("base64"), glb_base64: fs.readFileSync(glb).toString("base64"), sidecar: conversionReport, exportReport });
  } catch (err) {
    res.status(422).json({ error: err.message });
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function requireBridge(req, res, next) {
  try {
    await ensureBridgeReady();
    next();
  } catch (err) {
    res.status(503).json({ error: `Blender TCP bridge unavailable: ${err.message}` });
  }
}

app.use([
  "/scene",
  "/viewport",
  "/execute",
  "/undo",
  "/checkpoint",
  "/export-glb",
  "/import-glb",
  "/agent/build",
  "/bake-lod",
  // These three already receive x-worker-secret from server.ts but were never
  // checked here, so they were reachable unauthenticated on the public Render
  // URL — each one downloads an arbitrary glb_url and drives Blender, which is
  // free CPU and outbound fetch for anyone who finds the host. Adding them is
  // safe precisely because every existing caller already sends the header:
  //   /prepare-print        server.ts:5367, 5563
  //   /texture/rebake       server.ts /api/texture/rebake
  //   /texture/render-views server/textureJob.ts (UV2)
  "/prepare-print",
  "/physics-validate",
  "/texture/rebake",
  "/texture/render-views",
], requireWorkerAuth, requireBridge);

// Read the current Blender scene graph
app.get("/scene", async (req, res) => {
  try {
    const result = await bridge.readScene();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Capture a viewport screenshot
app.get("/viewport", async (req, res) => {
  try {
    const azimuth = req.query.azimuth ? parseFloat(req.query.azimuth) : undefined;
    const elevation = req.query.elevation ? parseFloat(req.query.elevation) : undefined;
    const result = await bridge.getViewport(azimuth, elevation);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Execute arbitrary bpy code via the bridge
app.post("/execute", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Missing 'code' in request body" });
    const result = await bridge.executeCode(code);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set viewport camera angle
app.post("/viewport/angle", async (req, res) => {
  try {
    const { azimuth, elevation } = req.body;
    const result = await bridge.setViewportAngle(azimuth || 45, elevation || 30);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Undo last operation
app.post("/undo", async (req, res) => {
  try {
    const result = await bridge.undo();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save a named checkpoint
app.post("/checkpoint/save", async (req, res) => {
  try {
    const { name } = req.body;
    const result = await bridge.saveCheckpoint(name || "default");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore a named checkpoint
app.post("/checkpoint/restore", async (req, res) => {
  try {
    const { name } = req.body;
    const result = await bridge.restoreCheckpoint(name || "default");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export scene as GLB
app.post("/export-glb", async (req, res) => {
  try {
    const result = await bridge.exportGlb();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Convert the currently imported GLB to a physically calibrated STL derivative.
app.post("/prepare-print", async (req, res) => {
  try {
    let { glb_base64, glb_url, target_height_mm } = req.body || {};
    if (!glb_base64 && glb_url) {
      const source = await fetch(glb_url);
      if (!source.ok) throw new Error(`Failed to download glb_url (${source.status})`);
      glb_base64 = Buffer.from(await source.arrayBuffer()).toString("base64");
    }
    if (!glb_base64) return res.status(400).json({ error: "glb_base64 or glb_url is required" });
    const imported = await bridge.send("import_glb", { glb_base64 });
    if (!imported?.success) throw new Error(imported?.error || "GLB import failed");
    const result = await bridge.preparePrintStl(Number(target_height_mm || 100));
    res.status(result?.success ? 200 : 422).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rig quality gates: anatomy + physics validation at gravity 9.8 m/s^2.
// Accepts an already-imported scene, or a glb_base64/glb_url to import first.
app.post("/physics-validate", async (req, res) => {
  try {
    let { glb_base64, glb_url, profile, facial } = req.body || {};
    if (!glb_base64 && glb_url) {
      const source = await fetch(glb_url);
      if (!source.ok) throw new Error(`Failed to download glb_url (${source.status})`);
      glb_base64 = Buffer.from(await source.arrayBuffer()).toString("base64");
    }
    if (glb_base64) {
      const imported = await bridge.send("import_glb", { glb_base64 });
      if (!imported?.success) throw new Error(imported?.error || "GLB import failed");
    }
    const result = await bridge.physicsValidate(String(profile || "quadruped"), !!facial);
    res.status(result?.success ? 200 : 422).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import a base64 GLB into the persistent Blender scene
app.post("/import-glb", async (req, res) => {
  try {
    let { glb_base64 } = req.body;
    if (!glb_base64) return res.status(400).json({ error: "Missing 'glb_base64' in request body" });
    // Strip a data URL prefix if present (same guard as /agent-build).
    // Without this, base64.b64decode silently corrupts the GLB and Blender
    // fails with "Bad glTF: json error: utf-8".
    if (glb_base64.startsWith("data:")) {
      glb_base64 = glb_base64.split(",")[1] || glb_base64;
    }
    const result = await bridge.send("import_glb", { glb_base64 });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// POST /bake-lod — AR_PET_SIM_SPEC §3.1/§3.3
// Receives: { glb_base64 | glb_url, bonemap? }
// Imports the rigged GLB, runs jobs/bake_lod.py (decimate/atlas/bone-rename/
// validate/budget), and returns { stats, glb_base64 } for the caller to upload to B2.
// =============================================================================
const BAKE_LOD_SCRIPT_PATH = path.join(__dirname, "jobs", "bake_lod.py");
const DEFAULT_BONEMAP_PATH = path.join(__dirname, "bonemap.json");

app.post("/bake-lod", async (req, res) => {
  try {
    let { glb_base64, glb_url, bonemap, avatar_type } = req.body || {};

    if (!glb_base64 && glb_url) {
      const r = await fetch(glb_url);
      if (!r.ok) throw new Error(`Failed to download glb_url (${r.status})`);
      const buf = Buffer.from(await r.arrayBuffer());
      glb_base64 = buf.toString("base64");
    }
    if (!glb_base64) {
      return res.status(400).json({ error: "Provide glb_base64 or glb_url." });
    }
    if (glb_base64.startsWith("data:")) {
      glb_base64 = glb_base64.split(",")[1] || glb_base64;
    }
    if (!bonemap) {
      const isHuman = avatar_type === "human";
      const bonemapPath = isHuman
        ? path.join(__dirname, "bonemap.human.json")
        : DEFAULT_BONEMAP_PATH;
      bonemap = JSON.parse(fs.readFileSync(bonemapPath, "utf8"));
    }

    const tempGlbPath = `/tmp/bake_input_${crypto.randomUUID()}.glb`;
    const outPath = `/tmp/bake_output_${crypto.randomUUID()}.glb`;

    // 1) Clear scene + import the rigged GLB.
    const importRes = await bridge.executeCode(`
import bpy, base64, os
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
glb_bytes = base64.b64decode("""${glb_base64}""")
with open("${tempGlbPath}", "wb") as f:
    f.write(glb_bytes)
bpy.ops.import_scene.gltf(filepath="${tempGlbPath}")
os.remove("${tempGlbPath}")
print("IMPORT_COMPLETE")
`);
    if (!importRes.success) {
      throw new Error(`GLB import failed: ${importRes.error}`);
    }

    // 2) Load bake_lod.py and run it with the bonemap.
    const bakeScript = fs.readFileSync(BAKE_LOD_SCRIPT_PATH, "utf8");
    const params = JSON.stringify({ out_path: outPath, bonemap, avatar_type });
    const bakeRes = await bridge.executeCode(
      `${bakeScript}\nrun_bake_lod(json.loads(r'''${params}'''))\n`
    );
    if (!bakeRes.success) {
      throw new Error(`bake-lod failed: ${bakeRes.error}`);
    }
    const m = /BAKE_RESULT:(\{.*\})/.exec(bakeRes.stdout || "");
    const stats = m ? JSON.parse(m[1]) : null;

    // 3) Export the baked scene bytes for the caller to upload to B2.
    const exported = await bridge.exportGlb();

    res.json({ success: true, stats, glb_base64: exported.glb_base64, size_bytes: exported.size_bytes });
  } catch (err) {
    console.error("[bake-lod] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// POST /texture/rebake — UV_TEXTURE_GENERATION_PLAN.md UV8
// Re-projects the avatar's approved multiview reference images onto the mesh
// and bakes a fresh base-color atlas (likeness repair — no generation step).
// Receives: { glb_base64 | glb_url, views: {front|left|back|right: url}, texture_size? }
// Returns:  { success, stats, glb_base64, size_bytes }
// =============================================================================
const REBAKE_SCRIPT_PATH = path.join(__dirname, "jobs", "rebake_texture.py");

app.post("/texture/rebake", async (req, res) => {
  try {
    let { glb_base64, glb_url, views, texture_size, front_axis_deg } = req.body || {};
    if (!glb_base64 && glb_url) {
      const source = await fetch(glb_url);
      if (!source.ok) throw new Error(`Failed to download glb_url (${source.status})`);
      glb_base64 = Buffer.from(await source.arrayBuffer()).toString("base64");
    }
    if (!glb_base64) return res.status(400).json({ error: "glb_base64 or glb_url is required" });
    if (!views || typeof views !== "object" || !Object.keys(views).length) {
      return res.status(400).json({ error: "views {front|left|back|right: url} is required" });
    }
    if (glb_base64.startsWith("data:")) glb_base64 = glb_base64.split(",")[1] || glb_base64;

    const tempGlbPath = `/tmp/rebake_input_${crypto.randomUUID()}.glb`;
    const importRes = await bridge.executeCode(`
import bpy, base64, os
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
glb_bytes = base64.b64decode("""${glb_base64}""")
with open("${tempGlbPath}", "wb") as f:
    f.write(glb_bytes)
bpy.ops.import_scene.gltf(filepath="${tempGlbPath}")
os.remove("${tempGlbPath}")
print("IMPORT_COMPLETE")
`);
    if (!importRes.success) throw new Error(`GLB import failed: ${importRes.error}`);

    const rebakeScript = fs.readFileSync(REBAKE_SCRIPT_PATH, "utf8");
    const params = JSON.stringify({
      views,
      texture_size: Number(texture_size) || 1024,
      front_axis_deg: Number(front_axis_deg) || 0,
    });
    const rebakeRes = await bridge.executeCode(
      `${rebakeScript}\nrun_rebake(json.loads(r'''${params}'''))\n`
    );
    if (!rebakeRes.success) throw new Error(`rebake failed: ${rebakeRes.error}`);
    const m = /REBAKE_RESULT:(\{.*\})/.exec(rebakeRes.stdout || "");
    const stats = m ? JSON.parse(m[1]) : null;
    if (!stats?.success) throw new Error(stats?.error || "Rebake produced no result.");

    const exported = await bridge.exportGlb();
    res.json({ success: true, stats, glb_base64: exported.glb_base64, size_bytes: exported.size_bytes });
  } catch (err) {
    console.error("[texture/rebake] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// POST /agent/build — Full multi-agent avatar build endpoint
// Receives: { glb_base64, pet_analysis, build_config? }
// Returns:  { jobId } immediately, poll /jobs/:jobId for results
// =============================================================================
// =============================================================================
// POST /texture/render-views — UV_TEXTURE_GENERATION_PLAN.md UV2
// Renders N calibrated canonical views of a pet mesh plus the camera parameters
// needed to re-project them. These are the source images UV3 conditions on.
//
// Cameras use the SAME convention as /texture/rebake (see jobs/render_views.py)
// so views rendered here can be baked back by the existing projection bake.
//
// Receives: { glb_base64 | glb_url, tier?, views?, resolution?, transparent? }
// Returns:  { success, views: {name: base64png}, cameras, bounds, resolution }
// =============================================================================
const RENDER_VIEWS_SCRIPT_PATH = path.join(__dirname, "jobs", "render_views.py");

app.post("/texture/render-views", async (req, res) => {
  try {
    let { glb_base64, glb_url, tier, views, resolution, transparent } = req.body || {};
    if (!glb_base64 && glb_url) {
      const source = await fetch(glb_url);
      if (!source.ok) throw new Error(`Failed to download glb_url (${source.status})`);
      glb_base64 = Buffer.from(await source.arrayBuffer()).toString("base64");
    }
    if (!glb_base64) return res.status(400).json({ error: "glb_base64 or glb_url is required" });
    if (glb_base64.startsWith("data:")) glb_base64 = glb_base64.split(",")[1] || glb_base64;

    const tempGlbPath = `/tmp/render_views_input_${crypto.randomUUID()}.glb`;
    const importRes = await bridge.executeCode(`
import bpy, base64, os
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
glb_bytes = base64.b64decode("""${glb_base64}""")
with open("${tempGlbPath}", "wb") as f:
    f.write(glb_bytes)
bpy.ops.import_scene.gltf(filepath="${tempGlbPath}")
os.remove("${tempGlbPath}")
print("IMPORT_COMPLETE")
`);
    if (!importRes.success) throw new Error(`GLB import failed: ${importRes.error}`);

    const renderScript = fs.readFileSync(RENDER_VIEWS_SCRIPT_PATH, "utf8");
    const params = JSON.stringify({
      tier: tier || "standard",
      views: Array.isArray(views) && views.length ? views : null,
      resolution: Number(resolution) || null,
      transparent: transparent === undefined ? true : Boolean(transparent),
    });
    const renderRes = await bridge.executeCode(
      `${renderScript}\nrun_render_views(json.loads(r'''${params}'''))\n`
    );
    if (!renderRes.success) throw new Error(`render-views failed: ${renderRes.error}`);

    // The payload carries base64 PNGs, so the result line can be very large —
    // match against the last RENDER_VIEWS_RESULT marker on its own line rather
    // than a greedy scan of stdout.
    const m = /RENDER_VIEWS_RESULT:(\{[\s\S]*\})/.exec(renderRes.stdout || "");
    const result = m ? JSON.parse(m[1]) : null;
    if (!result?.success) throw new Error(result?.error || "Render produced no result.");

    res.json({
      success: true,
      views: result.views,
      cameras: result.cameras,
      bounds: result.bounds,
      tier: result.tier,
      resolution: result.resolution,
      transparent: result.transparent,
      convention: result.convention,
    });
  } catch (err) {
    console.error("[texture/render-views] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/agent/build", async (req, res) => {
  const jobId = crypto.randomUUID();

  try {
    const { glb_base64, pet_analysis, build_config } = req.body;

    if (!glb_base64) {
      return res.status(400).json({ error: "Missing glb_base64" });
    }

    console.log(`[Agent Build ${jobId}] Starting multi-agent avatar build...`);

    jobs.set(jobId, {
      type: "agent-build",
      status: "processing",
      stage: "initializing",
      createdAt: Date.now(),
      steps: [],
    });

    res.status(202).json({ jobId, status: "processing" });

    // Background: Import the GLB into the persistent Blender scene
    (async () => {
      try {
        const job = jobs.get(jobId);

        // Step 1: Clear scene and import GLB
        job.stage = "importing_mesh";
        console.log(`[Agent Build ${jobId}] Importing GLB into Blender...`);

        // Write GLB to temp file (bridge can read it)
        const tempGlbPath = `/tmp/agent_input_${jobId}.glb`;
        let rawGlb = glb_base64;
        if (rawGlb.startsWith("data:")) {
          rawGlb = rawGlb.split(",")[1] || rawGlb;
        }
        // We need to write the file inside the container
        const importCode = `
import bpy, sys, base64, os

# Clear scene
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

# Write GLB from base64
glb_data = base64.b64decode("""${rawGlb.slice(0, 100)}""")
# ... full base64 would be too large for inline code

# Import GLB
bpy.ops.import_scene.gltf(filepath=r"${tempGlbPath}")
print("IMPORT_COMPLETE")
`;

        // For large GLB data, write to file first via a simpler approach
        const writeResult = await bridge.executeCode(`
import bpy, base64, os, sys

# Clear scene
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

# Write GLB data to temp file
glb_b64 = """${rawGlb}"""
glb_bytes = base64.b64decode(glb_b64)
with open("${tempGlbPath}", "wb") as f:
    f.write(glb_bytes)
print(f"Wrote {len(glb_bytes)} bytes to ${tempGlbPath}")

# Import GLB
bpy.ops.import_scene.gltf(filepath="${tempGlbPath}")

# Clean up temp file
os.remove("${tempGlbPath}")

# Report what we imported
mesh_count = sum(1 for o in bpy.context.scene.objects if o.type == 'MESH')
print(f"Imported {mesh_count} mesh(es)")
print("IMPORT_COMPLETE")
`);

        if (!writeResult.success) {
          throw new Error(`GLB import failed: ${writeResult.error}`);
        }

        job.steps.push({ step: "import", success: true, output: writeResult.stdout });

        // Step 2: Save initial checkpoint
        job.stage = "checkpoint_initial";
        await bridge.saveCheckpoint(`build_${jobId}_initial`);
        job.steps.push({ step: "checkpoint_initial", success: true });

        // Step 3: Read the scene to get mesh info
        job.stage = "reading_scene";
        const sceneData = await bridge.readScene();
        job.steps.push({ step: "read_scene", success: true, data: {
          object_count: sceneData.object_count,
          objects: sceneData.objects?.map(o => ({ name: o.name, type: o.type })),
        }});

        // Step 4: Take initial viewport screenshot
        job.stage = "initial_viewport";
        const viewport = await bridge.getViewport(45, 30);
        job.steps.push({ step: "initial_viewport", success: viewport.success });

        // Store scene state + viewport for the orchestrator to consume
        job.sceneState = sceneData;
        job.viewportImage = viewport.image_base64;
        job.petAnalysis = pet_analysis;
        job.stage = "ready_for_orchestrator";

        // The actual multi-agent orchestration will be driven by the main app's
        // agent/graph/orchestrator.ts — it polls this job status and sends
        // individual commands via the /execute, /viewport, /scene endpoints.
        // 
        // For now, mark as ready. The orchestrator takes over from here.
        console.log(`[Agent Build ${jobId}] ✅ Scene ready for orchestrator`);

      } catch (err) {
        console.error(`[Agent Build ${jobId}] Error:`, err.message);
        const job = jobs.get(jobId);
        if (job) {
          job.status = "failed";
          job.error = err.message;
        }
      }
    })();

  } catch (err) {
    console.error(`[Agent Build ${jobId}] Sync error:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal error starting agent build" });
    }
  }
});

// =============================================================================
// GET /jobs/:jobId — Poll for job status and results
// =============================================================================
app.get("/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  const response = {
    jobId: req.params.jobId,
    status: job.status,
    type: job.type,
    stage: job.stage,
    createdAt: job.createdAt,
  };

  if (job.status === "complete") {
    response.result = job.result;
  } else if (job.status === "failed") {
    response.error = job.error;
  }

  // Include steps for agent-build jobs
  if (job.type === "agent-build" && job.steps) {
    response.steps = job.steps;
  }

  res.json(response);
});

// =============================================================================
// Original /render endpoint (unchanged, for legacy avatar generation via bpy)
// =============================================================================
app.post("/render", async (req, res) => {
  try {
    const { python_script } = req.body;
    
    if (!python_script) {
      return res.status(400).json({ error: "Missing python_script in request body" });
    }

    // Generate temp paths securely
    const tempId = crypto.randomUUID();
    const scriptPath = path.join(os.tmpdir(), `avatar_${tempId}.py`);
    const outputPath = path.join(os.tmpdir(), `avatar_${tempId}.png`);

    console.log(`[Job ${tempId}] Received render request`);

    // Override the output path in the script to point to our secure temp directory
    let modifiedScript = python_script;
    modifiedScript = modifiedScript.replace(/output_path\s*=\s*.+/g, `output_path = r"${outputPath}"`);

    // Write the python script to disk
    fs.writeFileSync(scriptPath, modifiedScript, 'utf8');

    // Execute blender in the background
    console.log(`[Job ${tempId}] Running Blender CLI...`);
    try {
      execSync(`blender --background --python-exit-code 1 --python "${scriptPath}"`, { stdio: 'pipe' });
    } catch (blenderErr) {
      console.error(`[Job ${tempId}] Blender execution failed:`, blenderErr.message);
      if (blenderErr.stdout) console.error("Stdout:", blenderErr.stdout.toString());
      if (blenderErr.stderr) console.error("Stderr:", blenderErr.stderr.toString());
      
      if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
      return res.status(500).json({ error: "Blender rendering crashed. Check python script syntax." });
    }

    // Check if the output image was actually created
    if (!fs.existsSync(outputPath)) {
      console.error(`[Job ${tempId}] Expected output image not found at ${outputPath}`);
      if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
      return res.status(500).json({ error: "Blender finished but no output image was generated." });
    }

    // Read the image and convert to base64
    const imageBuffer = fs.readFileSync(outputPath);
    const base64Data = imageBuffer.toString("base64");
    
    console.log(`[Job ${tempId}] Render successful, returning base64 (size: ${base64Data.length} chars)`);

    // Clean up temp files
    fs.unlinkSync(scriptPath);
    fs.unlinkSync(outputPath);

    // Return the generated image
    res.json({
      success: true,
      image_base64: `data:image/png;base64,${base64Data}`
    });

  } catch (err) {
    console.error("Unexpected error in /render:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============================================================================
// POST /rig-model — ASYNC: Import GLB + apply AI-generated rigging armature
// Receives: { glb_base64, rigging_script }
// Returns:  { jobId } immediately, poll /jobs/:jobId for results
// =============================================================================
app.post("/rig-model", async (req, res) => {
  const jobId = crypto.randomUUID();
  const tempDir = path.join(os.tmpdir(), `rig_${jobId}`);
  
  try {
    const { glb_base64, rigging_script } = req.body;

    if (!glb_base64 || !rigging_script) {
      return res.status(400).json({ error: "Missing glb_base64 or rigging_script" });
    }

    console.log(`[Rig ${jobId}] Starting async rigging job...`);

    // Create temp directory
    fs.mkdirSync(tempDir, { recursive: true });

    const inputGlbPath = path.join(tempDir, "input.glb");
    const outputGlbPath = path.join(tempDir, "rigged_output.glb");
    const scriptPath = path.join(tempDir, "rig_script.py");

    // Write the input GLB file
    let rawGlb = glb_base64;
    if (rawGlb.startsWith("data:")) {
      rawGlb = rawGlb.split(",")[1] || rawGlb;
    }
    fs.writeFileSync(inputGlbPath, Buffer.from(rawGlb, "base64"));
    console.log(`[Rig ${jobId}] Input GLB written: ${fs.statSync(inputGlbPath).size} bytes`);

    // Build the full Blender script
    const fullScript = `
import bpy
import sys

# --- Step 1: Clear default scene ---
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# --- Step 2: Import the GLB mesh ---
print("[Rig] Importing GLB...")
bpy.ops.import_scene.gltf(filepath=r"${inputGlbPath}")

# Make sure the imported mesh is selected and active
mesh_obj = None
for obj in bpy.context.scene.objects:
    if obj.type == 'MESH':
        mesh_obj = obj
        break

if not mesh_obj:
    print("[Rig] ERROR: No mesh found after import!")
    sys.exit(1)

bpy.context.view_layer.objects.active = mesh_obj
mesh_obj.select_set(True)
print(f"[Rig] Mesh found: {mesh_obj.name}")

# --- Step 3: Execute AI-generated rigging script ---
print("[Rig] Applying rigging armature...")

${rigging_script}

# --- Step 3.5: Safety cleanup to prevent glTF export crashes ---
print("[Rig] Verifying vertex weights to prevent export crashes...")
for obj in bpy.context.scene.objects:
    if obj.type == 'MESH':
        armature_mod = next((mod for mod in obj.modifiers if mod.type == 'ARMATURE'), None)
        if armature_mod and armature_mod.object:
            arm_obj = armature_mod.object
            if arm_obj.data.bones:
                bone_name = arm_obj.data.bones[0].name
                if bone_name not in obj.vertex_groups:
                    vg = obj.vertex_groups.new(name=bone_name)
                else:
                    vg = obj.vertex_groups[bone_name]
                # Guarantee at least one vertex is assigned to force a valid skin object
                # This bypasses the AttributeError: 'NoneType' has no attribute 'joints' in io_scene_gltf2
                if len(obj.data.vertices) > 0:
                    vg.add([0], 0.01, 'ADD')

# --- Step 4: Export the rigged model as GLB ---
print("[Rig] Exporting rigged GLB...")
try:
    bpy.ops.export_scene.gltf(
        filepath=r"${outputGlbPath}",
        export_format='GLB',
        export_animation=True, # Modern Blender 4+ / 5 API
        export_skins=True,
        export_def_bones=True
    )
except TypeError:
    bpy.ops.export_scene.gltf(
        filepath=r"${outputGlbPath}",
        export_format='GLB',
        export_animations=True, # Legacy Blender 3.4 API
        export_skins=True,
        export_def_bones=True
    )

print("[Rig] RIGGING_EXPORT_COMPLETE")
`;

    fs.writeFileSync(scriptPath, fullScript, "utf8");

    // Register the job as processing
    jobs.set(jobId, {
      type: "rig-model",
      status: "processing",
      createdAt: Date.now(),
      tempDir,
    });

    // Return immediately with jobId
    res.status(202).json({ jobId, status: "processing" });

    // Run Blender asynchronously
    console.log(`[Rig ${jobId}] Running Blender CLI for rigging (async)...`);
    const child = exec(
      `blender --background --python-exit-code 1 --python "${scriptPath}"`,
      { timeout: 300000, maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const job = jobs.get(jobId);
        if (!job) return;

        if (error) {
          const errorDetail = extractBlenderError(stdout, stderr);
          console.error(`[Rig ${jobId}] Blender rigging failed:`, errorDetail);
          job.status = "failed";
          job.error = `Blender rigging failed: ${errorDetail}`;
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          return;
        }

        console.log(`[Rig ${jobId}] Blender stdout (last 500 chars):`, (stdout || "").slice(-500));

        // Check output
        if (!fs.existsSync(outputGlbPath)) {
          console.error(`[Rig ${jobId}] Rigged GLB not found at ${outputGlbPath}`);
          job.status = "failed";
          job.error = "Blender completed but no rigged GLB was generated.";
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          return;
        }

        const riggedBuffer = fs.readFileSync(outputGlbPath);
        const riggedBase64 = riggedBuffer.toString("base64");
        console.log(`[Rig ${jobId}] ✅ Rigging successful (${riggedBuffer.length} bytes)`);

        job.status = "complete";
        job.result = { success: true, rigged_glb_base64: riggedBase64 };

        // Cleanup temp files
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    );

  } catch (err) {
    console.error(`[Rig ${jobId}] Unexpected error:`, err);
    const job = jobs.get(jobId);
    if (job) {
      job.status = "failed";
      job.error = "Internal server error during rigging";
    }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    // Only send error response if we haven't already sent the 202
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error during rigging" });
    }
  }
});

// =============================================================================
// POST /bake-clips — ASYNC: Take a rigged GLB, author named skeletal Action
// clips on its armature, export a multi-animation GLB (Phase 5).
// Receives: { rigged_glb_base64 }
// Returns:  { jobId } immediately; poll /jobs/:jobId for
//           { success, rigged_glb_base64, clips: [{name,loop,durationSec}] }
// =============================================================================
app.post("/bake-clips", async (req, res) => {
  const jobId = crypto.randomUUID();
  const tempDir = path.join(os.tmpdir(), `clips_${jobId}`);

  try {
    const { rigged_glb_base64, avatar_type } = req.body;
    if (!rigged_glb_base64) {
      return res.status(400).json({ error: "Missing rigged_glb_base64" });
    }

    const isHuman = avatar_type === "human";
    const clipScriptBuilder = isHuman ? buildSkeletalClipScriptHuman : buildSkeletalClipScript;
    const clipManifest = isHuman ? SKELETAL_CLIP_MANIFEST_HUMAN : SKELETAL_CLIP_MANIFEST;

    console.log(`[Clips ${jobId}] Starting skeletal clip bake (avatarType=${avatar_type || 'dog'})...`);
    fs.mkdirSync(tempDir, { recursive: true });

    const inputGlbPath = path.join(tempDir, "rigged_input.glb");
    const outputGlbPath = path.join(tempDir, "clips_output.glb");
    const scriptPath = path.join(tempDir, "clips_script.py");

    let rawGlb = rigged_glb_base64;
    if (rawGlb.startsWith("data:")) {
      rawGlb = rawGlb.split(",")[1] || rawGlb;
    }
    fs.writeFileSync(inputGlbPath, Buffer.from(rawGlb, "base64"));
    fs.writeFileSync(scriptPath, clipScriptBuilder(inputGlbPath, outputGlbPath), "utf8");

    jobs.set(jobId, { type: "bake-clips", status: "processing", createdAt: Date.now(), tempDir, clipManifest });

    res.status(202).json({ jobId, status: "processing" });

    exec(
      `blender --background --python-exit-code 1 --python "${scriptPath}"`,
      { timeout: 300000, maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const job = jobs.get(jobId);
        if (!job) return;
        if (error) {
          const detail = extractBlenderError(stdout, stderr);
          console.error(`[Clips ${jobId}] Blender clip bake failed:`, detail);
          job.status = "failed";
          job.error = `Blender clip bake failed: ${detail}`;
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          return;
        }
        if (!fs.existsSync(outputGlbPath)) {
          job.status = "failed";
          job.error = "Blender completed but no clip GLB was generated.";
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          return;
        }
        const buffer = fs.readFileSync(outputGlbPath);
        console.log(`[Clips ${jobId}] ✅ Clip bake successful (${buffer.length} bytes)`);
        job.status = "complete";
        job.result = {
          success: true,
          rigged_glb_base64: buffer.toString("base64"),
          clips: job.clipManifest || SKELETAL_CLIP_MANIFEST,
        };
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    );
  } catch (err) {
    console.error(`[Clips ${jobId}] Unexpected error:`, err);
    const job = jobs.get(jobId);
    if (job) {
      job.status = "failed";
      job.error = "Internal server error during clip bake";
    }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error during clip bake" });
    }
  }
});

// =============================================================================
// POST /bake-sprites — ASYNC: Take rigged GLB, run modular templates → sprite sheet
// Receives: { rigged_glb_base64 }
// Returns:  { jobId } immediately, poll /jobs/:jobId for results
// =============================================================================
app.post("/bake-sprites", async (req, res) => {
  const jobId = crypto.randomUUID();
  const tempDir = path.join(os.tmpdir(), `sprites_${jobId}`);

  try {
    const { rigged_glb_base64 } = req.body;

    if (!rigged_glb_base64) {
      return res.status(400).json({ error: "Missing rigged_glb_base64" });
    }

    console.log(`[Sprites ${jobId}] Starting modular sprite bake job...`);
    fs.mkdirSync(tempDir, { recursive: true });

    const inputGlbPath = path.join(tempDir, "rigged_model.glb");
    const outputPngPath = path.join(tempDir, "sprite_sheet.png");
    const outputJsonPath = path.join(tempDir, "sprite_sheet.json");

    let rawGlb = rigged_glb_base64;
    if (rawGlb.startsWith("data:")) {
      rawGlb = rawGlb.split(",")[1] || rawGlb;
    }
    fs.writeFileSync(inputGlbPath, Buffer.from(rawGlb, "base64"));

    jobs.set(jobId, {
      type: "bake-sprites",
      status: "processing",
      createdAt: Date.now(),
      tempDir,
    });
    res.status(202).json({ jobId, status: "processing" });

    // ASYNC BACKGROUND PROCESSING
    (async () => {
      try {
        const actions = [
          { name: "eating", frames: 4, fps: 8, scriptFn: templates.getEatingScript },
          { name: "drinking", frames: 4, fps: 8, scriptFn: templates.getDrinkingScript },
          { name: "running", frames: 6, fps: 12, scriptFn: templates.getRunningScript },
          { name: "playing", frames: 4, fps: 10, scriptFn: templates.getPlayingScript },
          { name: "sleeping", frames: 3, fps: 4, scriptFn: templates.getSleepingScript },
          { name: "photo", frames: 3, fps: 6, scriptFn: templates.getPhotoScript },
        ];

        let animationMetadata = {
          frameWidth: 128,
          frameHeight: 128,
          animations: {}
        };

        const frameSize = 128;
        const maxFrames = Math.max(...actions.map(a => a.frames));
        const sheetWidth = maxFrames * frameSize;
        const sheetHeight = actions.length * frameSize;

        // Initialize empty sprite sheet canvas
        const spriteSheet = new Jimp(sheetWidth, sheetHeight, 0x00000000);

        for (let i = 0; i < actions.length; i++) {
          const action = actions[i];
          const scriptStr = action.scriptFn(inputGlbPath, tempDir, action.name);
          const scriptPath = path.join(tempDir, `${action.name}_script.py`);
          fs.writeFileSync(scriptPath, scriptStr);

          console.log(`[Sprites ${jobId}] Rendering action: ${action.name}`);
          try {
            await execPromise(`blender --background --python-exit-code 1 --python "${scriptPath}"`, { timeout: 300000 });
            
            // Stitch frames for this action
            for (let f = 0; f < action.frames; f++) {
              const framePath = path.join(tempDir, `${action.name}_${f.toString().padStart(4, '0')}.png`);
              if (fs.existsSync(framePath)) {
                const frameImg = await Jimp.read(framePath);
                spriteSheet.composite(frameImg, f * frameSize, i * frameSize);
              } else {
                console.warn(`[Sprites ${jobId}] Frame missing: ${framePath}`);
              }
            }
          } catch (err) {
            console.error(`[Sprites ${jobId}] Action ${action.name} failed:`, extractBlenderError(err.stdout, err.stderr));
            // Failed frames will remain blank (transparent) on the sheet
          }

          animationMetadata.animations[action.name] = {
            row: i,
            frames: action.frames,
            fps: action.fps
          };
        }

        console.log(`[Sprites ${jobId}] Writing final sprite sheet...`);
        await spriteSheet.writeAsync(outputPngPath);
        fs.writeFileSync(outputJsonPath, JSON.stringify(animationMetadata));

        const spritePng = fs.readFileSync(outputPngPath);
        const spriteBase64 = spritePng.toString("base64");

        const job = jobs.get(jobId);
        if (job) {
          job.status = "complete";
          job.result = {
            success: true,
            sprite_sheet_base64: `data:image/png;base64,${spriteBase64}`,
            animation_metadata: animationMetadata,
          };
        }
      } catch (err) {
        console.error(`[Sprites ${jobId}] Unexpected background error:`, err);
        const job = jobs.get(jobId);
        if (job) {
          job.status = "failed";
          job.error = "Internal server error during sprite baking processing";
        }
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    })();

  } catch (err) {
    console.error(`[Sprites ${jobId}] Unexpected synchronous error:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error starting sprite baking" });
    }
  }
});

// =============================================================================
// Global error handler — catches request aborted, body-parser errors, etc.
// Prevents unhandled exceptions from crashing the process.
// =============================================================================
app.use((err, req, res, next) => {
  // Client disconnected before we finished reading the request body
  if (err.type === 'request.aborted' || err.message === 'request aborted') {
    console.warn(`[Server] Request aborted by client: ${req.method} ${req.url} (this is normal for slow uploads)`);
    if (!res.headersSent) {
      res.status(400).json({ error: "Request aborted by client" });
    }
    return;
  }

  // Body too large
  if (err.type === 'entity.too.large') {
    console.warn(`[Server] Request body too large: ${req.method} ${req.url}`);
    if (!res.headersSent) {
      res.status(413).json({ error: "Request body too large" });
    }
    return;
  }

  // JSON parse error
  if (err.type === 'entity.parse.failed') {
    console.warn(`[Server] Invalid JSON in request: ${req.method} ${req.url}`);
    if (!res.headersSent) {
      res.status(400).json({ error: "Invalid JSON in request body" });
    }
    return;
  }

  // Unknown error
  console.error(`[Server] Unhandled error on ${req.method} ${req.url}:`, err.message || err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Blender microservice listening on port ${PORT}`);
  console.log(`Legacy endpoints: /render, /rig-model, /bake-sprites, /jobs/:jobId, /health`);
  console.log(`Bridge endpoints: /scene, /viewport, /execute, /undo, /checkpoint/*, /export-glb`);
  console.log(`Agent endpoint:   /agent/build`);

  if (SHOULD_AUTOSTART_BRIDGE && isLoopbackBridgeHost()) {
    ensureBridgeReady()
      .then((status) => console.log(`[Bridge] Ready: Blender ${status.blender_version || "unknown"}`))
      .catch((err) => console.warn(`[Bridge] Startup check failed: ${err.message}`));
  }
});

async function shutdown(signal) {
  console.log(`[Server] ${signal} received, shutting down...`);
  httpServer.close(() => {
    if (bridgeProcess && bridgeProcess.exitCode === null) {
      bridgeProcess.kill("SIGTERM");
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
