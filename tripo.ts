import sharp from "sharp";

const TRIPO_BASE = "https://api.tripo3d.ai/v2/openapi";
export const TRIPO_PREFIX = "tripo:";
const MAX_TRIPO_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
const TRIPO_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

export class TripoError extends Error {
  constructor(
    public status: number,
    public code: number | null,
    public rawMessage: string,
    message: string
  ) {
    super(message);
    this.name = "TripoError";
  }
}

export function isTripoInsufficientCredit(err: any): boolean {
  if (err instanceof TripoError) {
    return err.status === 403 && err.code === 2010;
  }
  return err && err.message && err.message.includes("enough credit");
}

function apiKey(): string {
  const key = process.env.TRIPO_API_KEY;
  if (!key) throw new Error("TRIPO_API_KEY is not configured.");
  return key;
}

export function isTripoHandle(operationName: string | null | undefined): boolean {
  return !!operationName && operationName.startsWith(TRIPO_PREFIX);
}

export function tripoTaskId(operationName: string): string {
  return operationName.slice(TRIPO_PREFIX.length);
}

/**
 * Optional turnaround views used for Tripo's `multiview_to_model`. The front
 * image is always `imageUrl`; any subset of the others may be supplied. When at
 * least one of left/back/right is present the job runs as multiview, otherwise
 * it degrades to single-image `image_to_model`.
 *
 * IMPORTANT: Tripo's multiview slot order is fixed — [FRONT, LEFT, BACK, RIGHT].
 * There is no "top" slot; missing slots are sent as empty objects.
 */
export interface TripoViewSet {
  left?: string;
  back?: string;
  right?: string;
}

export interface TripoGeometry {
  /** Target triangle budget → Tripo `face_limit`. */
  faceLimit?: number;
  /** Whether to bake a texture at all. */
  texture?: boolean;
  /** Whether the texture should be PBR. */
  pbr?: boolean;
  /** Explicit provider model version selected by the server profile. */
  modelVersion?: string;
  /** Hand-crafted low-poly topology for supported non-P1 versions. */
  smartLowPoly?: boolean;
  /** v3+ geometry quality. Not sent to P1. */
  geometryQuality?: "standard" | "detailed";
}

export interface TripoJobInput {
  /** Front / primary reference image (public URL or data URL). Always required. */
  imageUrl: string;
  /** Optional turnaround views. Presence of any one triggers multiview mode. */
  views?: TripoViewSet;
  /** Optional geometry overrides (detail/texture). Defaults preserve prior behaviour. */
  geometry?: TripoGeometry;
}

interface UploadedImage {
  ext: string;
  token: string;
}

/**
 * Decode the real bytes and produce the one upload format this bridge supports.
 * Signed object URLs may return application/octet-stream and Gemini may return
 * WebP; neither is forwarded to Tripo. Re-encoding also prevents a claimed MIME
 * type or pooled Buffer backing store from changing the uploaded file bytes.
 */
export async function normalizeTripoUploadImage(bytes: Buffer): Promise<Buffer> {
  if (bytes.length === 0 || bytes.length > MAX_TRIPO_SOURCE_IMAGE_BYTES) {
    throw new Error(`Tripo source image must be between 1 byte and ${MAX_TRIPO_SOURCE_IMAGE_BYTES} bytes.`);
  }
  const image = sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 });
  const metadata = await image.metadata();
  if (!new Set(["jpeg", "png", "webp"]).has(String(metadata.format))) {
    throw new Error("Tripo source image must decode as JPEG, PNG, or WebP.");
  }
  return image.rotate().png({ compressionLevel: 9 }).toBuffer();
}

/** Download an image (URL or data URL) and upload its bytes to Tripo → image_token. */
async function uploadToTripo(imageUrl: string): Promise<UploadedImage> {
  let sourceBytes: Buffer;

  const dataMatch = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (dataMatch) {
    sourceBytes = Buffer.from(dataMatch[2], "base64");
  } else {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRIPO_IMAGE_DOWNLOAD_TIMEOUT_MS);
    let imgRes: Response;
    try {
      imgRes = await fetch(imageUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!imgRes.ok) throw new Error(`Failed to download image for Tripo: ${imgRes.statusText}`);
    const declaredLength = Number(imgRes.headers.get("content-length") || 0);
    if (declaredLength > MAX_TRIPO_SOURCE_IMAGE_BYTES) {
      throw new Error(`Tripo source image exceeds ${MAX_TRIPO_SOURCE_IMAGE_BYTES} bytes.`);
    }
    sourceBytes = Buffer.from(await imgRes.arrayBuffer());
  }

  const normalized = await normalizeTripoUploadImage(sourceBytes);
  const blob = new Blob([Uint8Array.from(normalized)], { type: "image/png" });
  const formData = new FormData();
  formData.append("file", blob, "upload.png");

  const uploadRes = await fetch(`${TRIPO_BASE}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: formData,
  });

  const uploadJson: any = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok) {
    const code = typeof uploadJson?.code === "number" ? uploadJson.code : null;
    const rawMsg = uploadJson?.message || "";
    throw new TripoError(
      uploadRes.status,
      code,
      rawMsg,
      `Tripo upload failed (${uploadRes.status}): ${rawMsg || JSON.stringify(uploadJson)}`
    );
  }
  const token = uploadJson?.data?.image_token;
  if (!token) {
    throw new Error(`Tripo upload returned no image_token: ${JSON.stringify(uploadJson)}`);
  }
  return { ext: "png", token };
}

async function submitTask(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${TRIPO_BASE}/task`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof json?.code === "number" ? json.code : null;
    const rawMsg = json?.message || "";
    throw new TripoError(
      res.status,
      code,
      rawMsg,
      `Tripo task failed (${res.status}): ${rawMsg || JSON.stringify(json)}`
    );
  }
  const taskId = json?.data?.task_id;
  if (!taskId) {
    throw new Error(`Tripo task returned no task id: ${JSON.stringify(json)}`);
  }
  return `${TRIPO_PREFIX}${taskId}`;
}

/**
 * Start a Tripo 3D generation.
 *
 * - With turnaround views → `multiview_to_model` (front/left/back/right) for
 *   dramatically better geometry + texture wrap on the sides and back.
 * - Without → `image_to_model` from the single front image.
 *
 * Both request DETAILED PBR textures (texture_quality="detailed") for the
 * richest color/fur fidelity. `texture_alignment: "original_image"` keeps the
 * generated texture faithful to the reference colours (the "color coordination"
 * requirement) rather than letting Tripo re-tint from geometry.
 *
 * NOTE: do NOT set quad: true — Tripo forces FBX output when quad is enabled,
 * but this pipeline downloads output.model expecting a GLB.
 */
export async function startImageTo3D(input: TripoJobInput): Promise<string> {
  const left = input.views?.left;
  const back = input.views?.back;
  const right = input.views?.right;
  const hasMultiview = !!(left || back || right);

  // Shared high-fidelity flags. Geometry overrides (from the text-to-3D UI or
  // any caller) tune the triangle budget and texturing; defaults preserve the
  // original behaviour (40k faces, detailed PBR aligned to the reference image).
  const g = input.geometry || {};
  const texture = g.texture !== undefined ? g.texture : true;
  const pbr = g.pbr !== undefined ? g.pbr : true;
  const common: Record<string, unknown> = {
    texture,
    pbr,
    face_limit: g.faceLimit && g.faceLimit > 0 ? g.faceLimit : 40000,
  };
  if (g.modelVersion) common.model_version = g.modelVersion;
  if (g.smartLowPoly) common.smart_low_poly = true;
  if (g.geometryQuality) common.geometry_quality = g.geometryQuality;
  // Texture-quality/alignment only matter when a texture is actually baked.
  if (texture) {
    common.texture_quality = "detailed";
    common.texture_alignment = "original_image";
  }

  if (!hasMultiview) {
    const front = await uploadToTripo(input.imageUrl);
    return submitTask({
      type: "image_to_model",
      file: { type: front.ext, file_token: front.token },
      ...common,
    });
  }

  // Multiview: upload each present view; keep Tripo's fixed slot order.
  // Empty slots must be sent as {} so the array stays [front, left, back, right].
  // Upload sequentially. If one view is invalid, stop immediately instead of
  // creating several successful orphan uploads that can never form a task.
  const frontU = await uploadToTripo(input.imageUrl);
  const leftU = left ? await uploadToTripo(left) : null;
  const backU = back ? await uploadToTripo(back) : null;
  const rightU = right ? await uploadToTripo(right) : null;

  const slot = (u: UploadedImage | null) =>
    u ? { type: u.ext, file_token: u.token } : {};

  // Files are ordered by Tripo's fixed convention [FRONT, LEFT, BACK, RIGHT];
  // no separate orientation field is sent so unknown-param validation can't fail.
  return submitTask({
    type: "multiview_to_model",
    files: [slot(frontU), slot(leftU), slot(backU), slot(rightU)],
    ...common,
  });
}

/**
 * Start a Tripo auto-rig (UniRig quadruped) on a previously generated model.
 * Body confirmed against Tripo docs (platform.tripo3d.ai/docs/animation) + the
 * ComfyUI-Tripo node schema: { type:"animate_rig", original_model_task_id,
 * out_format:"glb", spec:"tripo", model_version }.
 *
 * `originalModelTaskId` may be passed with or without the `tripo:` prefix.
 */
export async function startRig(
  originalModelTaskId: string,
  opts?: {
    modelVersion?: string;
    avatarType?: "dog" | "human" | "object";
    rigType?: "biped" | "quadruped" | "hexapod" | "octopod" | "avian" | "serpentine" | "aquatic";
  },
): Promise<string> {
  const original = originalModelTaskId.startsWith(TRIPO_PREFIX)
    ? tripoTaskId(originalModelTaskId)
    : originalModelTaskId;
  const rigType = opts?.rigType || (opts?.avatarType === "human" ? "biped" : "quadruped");
  return submitTask({
    type: "animate_rig",
    original_model_task_id: original,
    out_format: "glb",
    spec: "tripo",
    rig_type: rigType,
    // Pin a rig model version for reproducibility; override via env if Tripo bumps it.
    model_version: opts?.modelVersion || process.env.TRIPO_RIG_MODEL_VERSION || "v2.5-20260210",
  });
}

export async function startPreRigCheck(originalModelTaskId: string): Promise<string> {
  const original = originalModelTaskId.startsWith(TRIPO_PREFIX)
    ? tripoTaskId(originalModelTaskId)
    : originalModelTaskId;
  return submitTask({
    type: "animate_prerigcheck",
    original_model_task_id: original,
  });
}

export interface TripoTextureOptions {
  prompt?: string;
  quality?: "standard" | "detailed";
  pbr?: boolean;
}

/** Separate texture operation, run only after the blank base is approved. */
export async function startTextureModel(
  originalModelTaskId: string,
  opts: TripoTextureOptions = {},
): Promise<string> {
  const original = originalModelTaskId.startsWith(TRIPO_PREFIX)
    ? tripoTaskId(originalModelTaskId)
    : originalModelTaskId;
  const body: Record<string, unknown> = {
    type: "texture_model",
    original_model_task_id: original,
    texture: true,
    pbr: opts.pbr !== false,
    texture_quality: opts.quality || "standard",
    texture_alignment: "original_image",
    bake: true,
  };
  const prompt = opts.prompt?.trim();
  if (prompt) body.texture_prompt = { text: prompt.slice(0, 400) };
  return submitTask(body);
}

/**
 * Fallback path (spec §3.1): if clip retarget confidence is too low, request one
 * of Tripo's own preset animations on the rigged model via `animate_retarget`.
 */
export async function startRetarget(
  originalModelTaskId: string,
  animation: "preset:walk" | "preset:run" | "preset:idle"
): Promise<string> {
  const original = originalModelTaskId.startsWith(TRIPO_PREFIX)
    ? tripoTaskId(originalModelTaskId)
    : originalModelTaskId;
  return submitTask({
    type: "animate_retarget",
    original_model_task_id: original,
    out_format: "glb",
    animation,
  });
}

export interface TripoPollResult {
  done: boolean;
  glbUrl?: string;
  error?: string;
  progress?: number;
  capability?: {
    riggable: boolean;
    rigType:
      | "biped"
      | "quadruped"
      | "hexapod"
      | "octopod"
      | "avian"
      | "serpentine"
      | "aquatic"
      | null;
  };
}

/** Poll any Tripo task (generation, rig, or retarget) for its GLB output. */
export const pollTripoTask = pollImageTo3D;

export async function pollImageTo3D(operationName: string): Promise<TripoPollResult> {
  const taskId = tripoTaskId(operationName);
  const res = await fetch(`${TRIPO_BASE}/task/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof json?.code === "number" ? json.code : null;
    const rawMsg = json?.message || "";
    throw new TripoError(
      res.status,
      code,
      rawMsg,
      `Tripo status check failed (${res.status}): ${rawMsg || JSON.stringify(json)}`
    );
  }

  const status = json?.data?.status;
  const progress = typeof json?.data?.progress === "number" ? json.data.progress : undefined;

  if (status === "success") {
    const output = json?.data?.output || {};
    if (typeof output.riggable === "boolean") {
      const knownRigTypes = new Set([
        "biped", "quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic",
      ]);
      const rigType = knownRigTypes.has(output.rig_type) ? output.rig_type : null;
      return {
        done: true,
        progress: 100,
        capability: { riggable: output.riggable, rigType },
      };
    }
    // Try multiple possible field names for the GLB download URL
    const glbUrl = output.model || output.model_url || output.pbr_model || output.base_model;
    console.log(`[Tripo] Task ${taskId} succeeded. Output keys: ${Object.keys(output).join(", ")}. glbUrl: ${glbUrl}`);
    if (!glbUrl) {
      throw new Error(`Tripo task succeeded but no model URL found in output: ${JSON.stringify(output)}`);
    }
    return { done: true, glbUrl, progress: 100 };
  } else if (status === "failed" || status === "cancelled") {
    return { done: true, error: `Tripo generation failed: ${status}`, progress };
  } else {
    return { done: false, progress };
  }
}
