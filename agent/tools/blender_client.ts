/**
 * Blender TCP Bridge Client
 * =========================
 * Connects to the Blender TCP bridge (tcp_server.py) running inside the
 * Blender Docker container and sends JSON-RPC commands.
 *
 * Used by the MCP tool interface and the LangGraph orchestrator.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecuteResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface ViewportResult {
  success: boolean;
  image_base64: string;
  width: number;
  height: number;
}

export interface SceneObject {
  name: string;
  type: string;
  location: [number, number, number];
  rotation_euler: [number, number, number];
  scale: [number, number, number];
  visible: boolean;
  parent: string | null;
  modifiers: { name: string; type: string }[];
  // Mesh-specific
  vertex_count?: number;
  face_count?: number;
  edge_count?: number;
  vertex_groups?: string[];
  world_bbox?: [number, number, number][];
  // Armature-specific
  bones?: {
    name: string;
    parent: string | null;
    head: [number, number, number];
    tail: [number, number, number];
    length: number;
    connected: boolean;
  }[];
  // Light-specific
  light_type?: string;
  energy?: number;
  // Camera-specific
  camera_type?: string;
  ortho_scale?: number;
  lens?: number;
}

export interface SceneGraph {
  success: boolean;
  object_count: number;
  objects: SceneObject[];
  active_object: string | null;
  frame_current: number;
  frame_start: number;
  frame_end: number;
  render_engine: string;
}

export interface ExportResult {
  success: boolean;
  glb_base64: string;
  size_bytes: number;
  error?: string;
}

export interface ImportGlbResult {
  success: boolean;
  imported_count: number;
  mesh_count: number;
  objects: { name: string; type: string }[];
  error?: string;
}

export interface PhysicsValidationResult {
  success: boolean;
  pass?: boolean;
  profile?: string;
  facial?: Record<string, unknown>;
  checks?: Array<Record<string, unknown>>;
  error?: string;
}

export interface ClipManifestEntry {
  name: string;
  loop: boolean;
  durationSec: number;
}

export interface CheckpointResult {
  success: boolean;
  filepath?: string;
  error?: string;
}

export interface PingResult {
  success: boolean;
  blender_version: string;
  scene_objects: number;
}

export interface IfcConversionResult {
  success: boolean;
  cached?: boolean;
  sourceHash?: string;
  glb_base64: string;
  ifc_base64?: string;
  sidecar: Record<string, any>;
  exportReport?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class BlenderClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(
    workerUrl: string = process.env.BLENDER_WORKER_URL || "http://localhost:10000",
    timeoutMs: number = 600000
  ) {
    this.baseUrl = workerUrl.replace(/\/render$/, "");
    this.timeoutMs = timeoutMs;
  }

  /** Send an HTTP request to the Blender worker proxy. */
  public async send<T = any>(endpoint: string, method: string = "GET", body?: any): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.baseUrl}${endpoint}`;
      
      const options: RequestInit = {
        method,
        signal: controller.signal,
        headers: { 
          "Content-Type": "application/json",
          "x-worker-secret": process.env.WORKER_SHARED_SECRET || ""
        }
      };

      if (body && method !== "GET") {
        options.body = JSON.stringify(body);
      }

      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));
      
      if (!res.ok || data.error) {
        throw new Error(data.error || `Worker returned HTTP ${res.status}`);
      }

      // The python bridge wraps success responses in { success: true, ... }
      // The express server passes it through.
      return data as T;

    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`Bridge request timed out after ${this.timeoutMs / 1000}s: ${endpoint}`);
      }
      throw new Error(`Bridge connection error: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---- Public API ----

  /** Execute arbitrary Python code in Blender's context. */
  async executeCode(code: string): Promise<ExecuteResult> {
    return this.send<ExecuteResult>("/execute", "POST", { code });
  }

  /** Import a base64 GLB into the persistent Blender scene. */
  async importGlb(glbBase64: string): Promise<ImportGlbResult> {
    // Strip a data URL prefix (e.g. "data:model/gltf-binary;base64,") if present.
    // Passing the prefix through corrupts the decoded bytes and Blender fails
    // with "Bad glTF: json error: utf-8".
    let raw = glbBase64;
    if (raw.startsWith("data:")) {
      raw = raw.split(",")[1] || raw;
    }
    return this.send<ImportGlbResult>("/import-glb", "POST", { glb_base64: raw });
  }

  /** Capture a viewport screenshot from a given camera angle. */
  async getViewport(azimuth?: number, elevation?: number): Promise<ViewportResult> {
    const params = new URLSearchParams();
    if (azimuth !== undefined) params.append("azimuth", azimuth.toString());
    if (elevation !== undefined) params.append("elevation", elevation.toString());
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.send<ViewportResult>(`/viewport${query}`, "GET");
  }

  /** Get the current scene graph (all objects, transforms, bones, etc). */
  async readScene(): Promise<SceneGraph> {
    return this.send<SceneGraph>("/scene", "GET");
  }

  /** Rotate the viewport camera to see from a different angle. */
  async setViewportAngle(azimuth: number, elevation: number): Promise<{ success: boolean }> {
    return this.send("/viewport/angle", "POST", { azimuth, elevation });
  }

  /** Undo the last Blender operation. */
  async undo(): Promise<{ success: boolean; error?: string }> {
    return this.send("/undo", "POST");
  }

  /** Save the current scene as a named checkpoint. */
  async saveCheckpoint(name: string): Promise<CheckpointResult> {
    return this.send<CheckpointResult>("/checkpoint/save", "POST", { name });
  }

  /** Restore the scene from a named checkpoint. */
  async restoreCheckpoint(name: string): Promise<CheckpointResult> {
    return this.send<CheckpointResult>("/checkpoint/restore", "POST", { name });
  }

  /** Export the scene as GLB and return base64. */
  async exportGlb(): Promise<ExportResult> {
    return this.send<ExportResult>("/export-glb", "POST");
  }

  /** Validate the currently imported rig against worker-side anatomy and physics gates. */
  async physicsValidate(profile: string, facial: boolean): Promise<PhysicsValidationResult> {
    return this.send<PhysicsValidationResult>("/physics-validate", "POST", { profile, facial });
  }

  async convertIfc(ifcBase64: string): Promise<IfcConversionResult> {
    return this.send<IfcConversionResult>("/ifc/convert", "POST", { ifc_base64: ifcBase64 });
  }

  async exportIfc(model: Record<string, any>): Promise<IfcConversionResult> {
    return this.send<IfcConversionResult>("/ifc/export", "POST", { model });
  }

  /**
   * Bake named skeletal Action clips onto a rigged GLB and return a new GLB
   * containing them as glTF animation tracks (Phase 5). Async on the worker;
   * this starts the job and polls until complete.
   */
  async bakeClipsAndWait(
    riggedGlbBase64: string,
    opts: { timeoutMs?: number; intervalMs?: number; avatarType?: 'dog' | 'human' | 'object' } = {}
  ): Promise<{ riggedGlbBase64: string; clips: ClipManifestEntry[] }> {
    const { timeoutMs = 300000, intervalMs = 3000, avatarType = 'dog' } = opts;
    const start = await this.send<{ jobId?: string }>("/bake-clips", "POST", {
      rigged_glb_base64: riggedGlbBase64,
      avatar_type: avatarType,
    });
    const jobId = start.jobId;
    if (!jobId) throw new Error("bake-clips did not return a jobId");

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const job = await this.send<any>(`/jobs/${jobId}`, "GET");
      if (job.status === "complete") {
        const result = job.result || {};
        if (!result.rigged_glb_base64) throw new Error("bake-clips completed without a GLB");
        return {
          riggedGlbBase64: result.rigged_glb_base64 as string,
          clips: (result.clips as ClipManifestEntry[]) || [],
        };
      }
      if (job.status === "failed") throw new Error(job.error || "bake-clips failed");
    }
    throw new Error("bake-clips timed out");
  }

  /** Health check — verify the bridge is responsive. */
  async ping(): Promise<PingResult> {
    const health = await this.send<any>("/health", "GET");
    return {
      success: health.bridge === "connected",
      blender_version: health.blenderVersion || "unknown",
      scene_objects: 0 // /health doesn't return scene_objects
    };
  }

  /** Test connectivity — returns true if bridge is reachable. */
  async isConnected(): Promise<boolean> {
    try {
      const res = await this.ping();
      return res.success;
    } catch {
      return false;
    }
  }
}

// Singleton for convenience
let _defaultClient: BlenderClient | null = null;

export function getBlenderClient(): BlenderClient {
  if (!_defaultClient) {
    _defaultClient = new BlenderClient();
  }
  return _defaultClient;
}