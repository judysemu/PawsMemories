import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ANIMATOR_DATA_DIR } from "./paths.ts";

const MAX_AUDIO_SOURCES = 8;
const MAX_DURATION_SECONDS = 30;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 45_000;

export interface AudioSource {
  path: string;
  gain: number;
  loop?: boolean;
}

export interface MuxRequest {
  workspaceRoot?: string;
  videoPath: string;
  audioSources: AudioSource[];
  outputPath: string;
  maxDuration?: number;
}

export interface ValidatedMuxRequest {
  workspaceRoot: string;
  videoPath: string;
  audioSources: AudioSource[];
  outputPath: string;
  maxDuration: number;
}

export interface VerifiedMuxResult {
  outputPath: string;
  videoStreams: number;
  audioStreams: number;
  durationSeconds: number;
}

function trustedPath(workspaceRoot: string, candidate: string, mustExist: boolean): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) throw new Error("Remote URLs are not allowed in Animator mux inputs");
  const root = path.resolve(workspaceRoot);
  const absolute = path.resolve(root, candidate);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("Path traversal outside Animator workspace");
  if (mustExist && !fs.existsSync(absolute)) throw new Error(`Mux input path does not exist: ${candidate}`);
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) throw new Error("Symlink mux paths are not allowed");
  const relativeSegments = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let cursor = root;
  for (const segment of relativeSegments.slice(0, mustExist ? undefined : -1)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Symlink mux paths are not allowed");
  }
  return absolute;
}

export function validateMuxRequest(input: MuxRequest): ValidatedMuxRequest {
  const workspaceRoot = path.resolve(input.workspaceRoot || ANIMATOR_DATA_DIR);
  if (!Array.isArray(input.audioSources) || input.audioSources.length < 1 || input.audioSources.length > MAX_AUDIO_SOURCES) {
    throw new Error(`Audio source count must be between 1 and ${MAX_AUDIO_SOURCES}`);
  }
  const maxDuration = input.maxDuration ?? 10;
  if (!Number.isFinite(maxDuration) || maxDuration <= 0 || maxDuration > MAX_DURATION_SECONDS) throw new Error(`Mux duration must be between 0 and ${MAX_DURATION_SECONDS} seconds`);
  const videoPath = trustedPath(workspaceRoot, input.videoPath, true);
  const outputPath = trustedPath(workspaceRoot, input.outputPath, false);
  if (videoPath === outputPath) throw new Error("Mux output must not overwrite its input");
  if (fs.statSync(videoPath).size > MAX_VIDEO_BYTES) throw new Error("Video input exceeds mux size limit");
  const audioSources = input.audioSources.map((source) => {
    if (!Number.isFinite(source.gain) || source.gain < 0 || source.gain > 1) throw new Error("Audio gain must be between 0 and 1");
    const sourcePath = trustedPath(workspaceRoot, source.path, true);
    if (fs.statSync(sourcePath).size > MAX_AUDIO_BYTES) throw new Error("Audio input exceeds mux size limit");
    return { path: sourcePath, gain: source.gain, loop: source.loop === true };
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  return { workspaceRoot, videoPath, audioSources, outputPath, maxDuration };
}

export function buildFfmpegMuxArgs(request: ValidatedMuxRequest, outputPath = request.outputPath): string[] {
  const args = ["-y", "-nostdin", "-i", request.videoPath];
  for (const source of request.audioSources) {
    if (source.loop) args.push("-stream_loop", "-1");
    args.push("-i", source.path);
  }
  const labels: string[] = [];
  const filters = request.audioSources.map((source, index) => {
    const label = `a${index}`;
    labels.push(`[${label}]`);
    return `[${index + 1}:a]volume=${source.gain.toFixed(4)}[${label}]`;
  });
  filters.push(`${labels.join("")}amix=inputs=${request.audioSources.length}:duration=first:normalize=1,alimiter=limit=0.95[aout]`);
  const outputExtension = path.extname(outputPath).toLowerCase();
  const audioCodec = outputExtension === ".mp4" ? "aac" : "libopus";
  return [...args, "-filter_complex", filters.join(";"), "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", audioCodec, "-t", String(request.maxDuration), outputPath];
}

function runProcess(executable: string, args: string[], timeoutMs = PROCESS_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${executable} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (stdout.length < 1_000_000) stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 1_000_000) stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`${executable} unavailable: ${error.message}`)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${executable} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function verifyMuxOutput(outputPath: string, maxDuration: number): Promise<VerifiedMuxResult> {
  const { stdout } = await runProcess("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", outputPath]);
  let probe: { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
  try { probe = JSON.parse(stdout); } catch { throw new Error("ffprobe returned invalid JSON"); }
  const videoStreams = probe.streams?.filter((stream) => stream.codec_type === "video").length || 0;
  const audioStreams = probe.streams?.filter((stream) => stream.codec_type === "audio").length || 0;
  const durationSeconds = Number(probe.format?.duration || 0);
  if (videoStreams !== 1 || audioStreams < 1) throw new Error("Mux verification requires exactly one video stream and at least one audio stream");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > maxDuration + 0.5) throw new Error("Mux output duration failed verification");
  return { outputPath, videoStreams, audioStreams, durationSeconds };
}

export async function muxAudioBed(input: MuxRequest): Promise<VerifiedMuxResult> {
  const request = validateMuxRequest(input);
  const partialPath = `${request.outputPath}.partial${path.extname(request.outputPath) || ".webm"}`;
  try {
    await runProcess("ffmpeg", buildFfmpegMuxArgs(request, partialPath));
    const verified = await verifyMuxOutput(partialPath, request.maxDuration);
    fs.renameSync(partialPath, request.outputPath);
    return { ...verified, outputPath: request.outputPath };
  } catch (error) {
    if (fs.existsSync(partialPath)) fs.rmSync(partialPath, { force: true });
    throw error;
  }
}
