import { useState, useRef, useCallback } from "react";
import { createViewportSource } from "./viewportSource.ts";
import { ANIMATOR_DEFAULTS } from "../defaults.ts";
import { getToken } from "../../api.ts";

export interface SavedAnimatorRecording {
  recordingId: string;
  url: string;
  mimeType: "video/webm" | "video/mp4";
}

export function parseSavedAnimatorRecording(value: unknown): SavedAnimatorRecording {
  const record = value as Partial<SavedAnimatorRecording> | null;
  if (!record || typeof record.recordingId !== "string" || !/^[0-9a-f-]{36}$/i.test(record.recordingId) || typeof record.url !== "string" || !record.url.startsWith("/") && !record.url.startsWith("https://") || !["video/webm", "video/mp4"].includes(String(record.mimeType))) {
    throw new Error("Recording service returned an invalid response");
  }
  return record as SavedAnimatorRecording;
}

export function useCaptureSession(canvasRef: React.RefObject<HTMLCanvasElement>) {
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const start = useCallback(() => {
    if (!canvasRef.current) return;
    
    // Fallback to preserveDrawingBuffer if needed, though captureStream usually works without it
    // if called at the right time.
    const stream = createViewportSource(canvasRef.current, ANIMATOR_DEFAULTS.recording.fps);
    
    const options = {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: ANIMATOR_DEFAULTS.recording.bitrate
    };
    
    // Fallback to available types if vp9 is not supported
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options.mimeType = 'video/webm;codecs=vp8';
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = 'video/webm';
      }
    }

    const recorder = new MediaRecorder(stream, options);
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      setIsRecording(false);
    };

    recorder.start(100); // 100ms chunks
    setIsRecording(true);
    
    // Auto stop after max duration
    setTimeout(() => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
    }, ANIMATOR_DEFAULTS.recording.maxDurationSeconds * 1000);

  }, [canvasRef]);

  const stop = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const download = useCallback(() => {
    if (chunksRef.current.length === 0) return;
    const blob = new Blob(chunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `animator_capture_${Date.now()}.webm`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const saveToBackend = useCallback(async () => {
    if (chunksRef.current.length === 0) return null;
    const blob = new Blob(chunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'video/webm' });
    
    const formData = new FormData();
    formData.append("video", blob, "capture.webm");
    
    const res = await fetch("/api/animator/recordings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${getToken()}` },
      body: formData,
    });
    
    if (!res.ok) throw new Error("Failed to save recording");
    return parseSavedAnimatorRecording(await res.json());
  }, []);

  return {
    isRecording,
    start,
    stop,
    download,
    saveToBackend,
    hasRecording: chunksRef.current.length > 0,
  };
}
