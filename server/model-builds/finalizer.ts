export interface ModelFinalizationPollResult {
  done: boolean;
  progress?: number;
  error?: string;
  failureCode?: string;
}

/**
 * Replaceable port for turning a generated base model into the final internal
 * artifact. Provider task handles stay below the paid-product boundary.
 */
export interface ModelArtifactFinalizer {
  startFinalization(sourceTaskHandle: string): Promise<void>;
  pollFinalization(sourceTaskHandle: string): Promise<ModelFinalizationPollResult>;
  downloadFinal(sourceTaskHandle: string): Promise<Buffer>;
}

export function isModelArtifactFinalizer(value: unknown): value is ModelArtifactFinalizer {
  const candidate = value as Partial<ModelArtifactFinalizer> | null;
  return Boolean(candidate
    && typeof candidate.startFinalization === "function"
    && typeof candidate.pollFinalization === "function"
    && typeof candidate.downloadFinal === "function");
}
