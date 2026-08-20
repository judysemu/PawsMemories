import { getCreationVideoUrl, getPool, setCreationVideoUrl, updateJobStatus } from "../../db";
import { failGenerationJobAndRefundOnce, markGenerationJobDoneOnce } from "../generationRefunds";
import { sendSms } from "../sms";
import { uploadBinaryFromUrl } from "../../storage";
import { assertResolvesToPublicHost, pollFalVideo } from "./falVideo";

export interface AiVideoJobRef {
  id: number;
  operation_name: string | null;
  creation_id: number | null;
  user_phone: string;
}

export type FalVideoPollOutcome =
  | { status: "running" }
  | { status: "done"; videoUrl: string }
  | { status: "failed"; error: string }
  | { status: "already_finalized" };

/** Looks up which provider a video job was submitted to, keyed off job_id — the
 *  correct dispatch key (vs. sniffing operation_name shape). */
export async function getAiVideoProvider(jobId: number): Promise<{ provider: string; provider_model: string } | null> {
  const [rows] = await getPool().query(
    "SELECT provider, provider_model FROM ai_video_requests WHERE job_id = ? LIMIT 1",
    [jobId],
  );
  const arr = rows as unknown as { provider: string; provider_model: string }[];
  return arr.length ? arr[0] : null;
}

/** Polls a fal.ai video job and, if complete, downloads/re-uploads the result
 *  and marks the job done — the logic shared by the client-driven poll route
 *  and the background sweep. */
export async function pollAndFinishFalVideoJob(job: AiVideoJobRef, endpoint: string): Promise<FalVideoPollOutcome> {
  if (!job.operation_name) {
    await failGenerationJobAndRefundOnce(getPool(), job.id, "Video job has no provider request id.");
    return { status: "failed", error: "Video job has no provider request id." };
  }

  let result: { done: boolean; videoUrl?: URL; error?: string };
  try {
    result = await pollFalVideo(endpoint, job.operation_name);
  } catch (err: any) {
    const message = err?.message || "fal.ai poll failed";
    await failGenerationJobAndRefundOnce(getPool(), job.id, message);
    return { status: "failed", error: message };
  }

  if (!result.done) {
    await updateJobStatus(job.id, "running");
    return { status: "running" };
  }

  if (!result.videoUrl) {
    const message = result.error || "No video generated";
    await failGenerationJobAndRefundOnce(getPool(), job.id, message);
    return { status: "failed", error: message };
  }

  // Only fetching and storing the video may fail the job. Everything after the
  // upload is bookkeeping on work that already succeeded and was already paid
  // for, and must degrade rather than reverse the outcome.
  let videoUrl: string;
  try {
    await assertResolvesToPublicHost(result.videoUrl);
    videoUrl = await uploadBinaryFromUrl(result.videoUrl.toString(), "video/mp4");
  } catch (err: any) {
    const message = err?.message || "Video finalize failed";
    await failGenerationJobAndRefundOnce(getPool(), job.id, message);
    return { status: "failed", error: message };
  }

  if (!await markGenerationJobDoneOnce(getPool(), job.id)) {
    // Another poller finished first. The URL is already on the creation, so
    // return it rather than leaving this caller with nothing to display —
    // whichever poller loses the race, the customer still gets their video.
    const settled = job.creation_id ? await getCreationVideoUrl(job.creation_id, job.user_phone) : null;
    return settled ? { status: "done", videoUrl: settled } : { status: "already_finalized" };
  }

  if (job.creation_id) {
    // A false return means the id/phone pair matched no row, so the video has
    // no home: uploaded, billed, and unreachable by the customer. Record enough
    // to find the orphan later instead of reporting success and losing it.
    const attached = await setCreationVideoUrl(job.creation_id, job.user_phone, videoUrl).catch((err: any) => {
      console.error("[ai-video] attach threw", `job=${job.id}`, `creation=${job.creation_id}`, err?.message || err);
      return false;
    });
    if (!attached) {
      console.error(
        "[ai-video] ORPHANED VIDEO — no creation row was updated",
        `job=${job.id}`, `creation=${job.creation_id}`, `phone=${job.user_phone}`, `url=${videoUrl}`,
      );
    }
  }

  // A courtesy text must never be able to unmake a finished video. This used to
  // sit inside the try above, so an SMS outage marked a completed job failed and
  // refunded a customer who already had their video attached and playable.
  try {
    await sendSms(job.user_phone, `🐾 Paws & Memories: Your pet video animation is ready! View it at ${process.env.APP_URL || "your app"}.`);
  } catch (err: any) {
    console.error("[ai-video] ready SMS failed (video is unaffected)", `job=${job.id}`, err?.message || err);
  }

  return { status: "done", videoUrl };
}
