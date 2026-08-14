import { getPool, setCreationVideoUrl, updateJobStatus } from "../../db";
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

  try {
    await assertResolvesToPublicHost(result.videoUrl);
    const videoUrl = await uploadBinaryFromUrl(result.videoUrl.toString(), "video/mp4");
    if (!await markGenerationJobDoneOnce(getPool(), job.id)) {
      return { status: "already_finalized" };
    }
    if (job.creation_id) {
      await setCreationVideoUrl(job.creation_id, job.user_phone, videoUrl);
    }
    await sendSms(job.user_phone, `🐾 Paws & Memories: Your pet video animation is ready! View it at ${process.env.APP_URL || "your app"}.`);
    return { status: "done", videoUrl };
  } catch (err: any) {
    const message = err?.message || "Video finalize failed";
    await failGenerationJobAndRefundOnce(getPool(), job.id, message);
    return { status: "failed", error: message };
  }
}
