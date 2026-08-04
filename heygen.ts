// HeyGen "talking pet" video integration.
//
// Mirrors the async job pattern used for Veo in server.ts: we kick off a
// generation, store an opaque handle in generation_jobs.operation_name, and
// poll until it is done. To distinguish HeyGen jobs from Veo operations
// (which share the same DB column), HeyGen handles are stored with a
// "heygen:" prefix, e.g. "heygen:<video_id>".
//
// HeyGen flow used here (v2 API):
//   1. Upload the pet image as a Photo Avatar asset       -> image_key / asset id
//   2. Create a Photo Avatar "talking photo" video        -> video_id
//   3. Poll video_status.get until status === "completed"  -> video_url (mp4)
//
// Docs: https://docs.heygen.com/  (Photo Avatar / Avatar IV + video_status)

const HEYGEN_BASE = "https://api.heygen.com";
const HEYGEN_UPLOAD_BASE = "https://upload.heygen.com";
export const HEYGEN_PREFIX = "heygen:";

function apiKey(): string {
  const key = process.env.HEYGEN_API_KEY;
  if (!key) throw new Error("HEYGEN_API_KEY is not configured.");
  return key;
}

/** True if a generation_jobs.operation_name belongs to HeyGen. */
export function isHeyGenHandle(operationName: string | null | undefined): boolean {
  return !!operationName && operationName.startsWith(HEYGEN_PREFIX);
}

/** Extract the raw HeyGen video_id from a stored handle. */
export function heyGenVideoId(operationName: string): string {
  return operationName.slice(HEYGEN_PREFIX.length);
}

/**
 * Upload raw image bytes to HeyGen as a talking-photo asset.
 * Returns the image_key used to create a photo-avatar video.
 */
async function uploadTalkingPhoto(imageBuffer: Buffer, mimeType: string): Promise<string> {
  const res = await fetch(`${HEYGEN_UPLOAD_BASE}/v1/asset`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey(),
      "Content-Type": mimeType,
    },
    body: imageBuffer,
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HeyGen asset upload failed (${res.status}): ${JSON.stringify(json)}`);
  }
  // HeyGen returns the asset under data.image_key (talking photo) or data.id.
  const imageKey = json?.data?.image_key || json?.data?.id;
  if (!imageKey) {
    throw new Error(`HeyGen asset upload returned no image_key: ${JSON.stringify(json)}`);
  }
  return imageKey;
}

export interface HeyGenJobInput {
  imageBuffer: Buffer;
  mimeType: string;
  /** What the pet should "say". */
  script: string;
  /** HeyGen voice_id. Falls back to HEYGEN_DEFAULT_VOICE_ID env var. */
  voiceId?: string;
}

/**
 * Start a HeyGen talking-photo video generation.
 * Returns the prefixed handle to store in generation_jobs.operation_name.
 */
/**
 * VG-7: this is a lip-sync path, not an animation path.
 *
 * HeyGen's `talking_photo` character animates the mouth and face over an
 * otherwise still photograph. There is no body motion, no gesture, and no
 * background motion available through this request shape, so output is
 * inherently stiff by construction — that is the product, not a defect, and no
 * prompt or config change here will make the pet move.
 *
 * Customers who want actual motion belong on the Veo "Fur Reels" path
 * (POST /api/ai-video/*), which drives real camera and subject movement. If
 * this path ever needs to feel less static, the correct lever is a subtle
 * Ken Burns push/parallax applied in the existing ffmpeg worker after HeyGen
 * returns, not a change to this request.
 */
export async function startTalkingVideo(input: HeyGenJobInput): Promise<string> {
  const voiceId = input.voiceId || process.env.HEYGEN_DEFAULT_VOICE_ID;
  if (!voiceId) {
    throw new Error("No HeyGen voice provided and HEYGEN_DEFAULT_VOICE_ID is not set.");
  }

  const imageKey = await uploadTalkingPhoto(input.imageBuffer, input.mimeType);

  const body = {
    video_inputs: [
      {
        character: {
          type: "talking_photo",
          talking_photo_id: imageKey,
        },
        voice: {
          type: "text",
          input_text: input.script,
          voice_id: voiceId,
        },
      },
    ],
    dimension: { width: 720, height: 720 }, // 1:1 to match the still avatars
  };

  const res = await fetch(`${HEYGEN_BASE}/v2/video/generate`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HeyGen video generate failed (${res.status}): ${JSON.stringify(json)}`);
  }
  const videoId = json?.data?.video_id;
  if (!videoId) {
    throw new Error(`HeyGen video generate returned no video_id: ${JSON.stringify(json)}`);
  }
  return `${HEYGEN_PREFIX}${videoId}`;
}

export interface HeyGenPollResult {
  done: boolean;
  /** Present only when done and successful. */
  videoUrl?: string;
  /** Present when done and failed. */
  error?: string;
}

/** Poll a HeyGen video by its stored handle. */
export async function pollTalkingVideo(operationName: string): Promise<HeyGenPollResult> {
  const videoId = heyGenVideoId(operationName);
  const res = await fetch(
    `${HEYGEN_BASE}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`,
    { headers: { "x-api-key": apiKey() } }
  );
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HeyGen status check failed (${res.status}): ${JSON.stringify(json)}`);
  }

  const status = json?.data?.status;
  if (status === "completed") {
    const videoUrl = json?.data?.video_url;
    if (!videoUrl) return { done: true, error: "HeyGen completed but returned no video_url" };
    return { done: true, videoUrl };
  }
  if (status === "failed") {
    return { done: true, error: json?.data?.error?.message || "HeyGen generation failed" };
  }
  // "pending" | "processing" | "waiting"
  return { done: false };
}

/**
 * Fetch a remote mp4 URL and return it as a base64 data URL, so it can be
 * pushed through the existing uploadBase64Image() storage helper unchanged.
 */
export async function fetchMp4AsDataUrl(videoUrl: string): Promise<string> {
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Failed to download HeyGen mp4 (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:video/mp4;base64,${buf.toString("base64")}`;
}
