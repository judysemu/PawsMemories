/**
 * Provider-neutral generation types for CUSTOM_RIGGED_PET_GLB_V1.
 *
 * G2 boundary rule (see docs/audits/G1_REVIEW_AND_CORRECTIONS.md §3.3):
 * nothing in this file may reference a provider-issued URL, a provider task
 * handle, or any provider-specific status string. Artifacts carry BYTES and
 * METADATA only. If a URL field ever appears here, the leak this phase exists
 * to close has survived under a different name.
 */

export interface PetModelGenerationInput {
  frontUrl: string;
  leftUrl: string;
  rightUrl: string;
  rearUrl: string;
  /**
   * Collected by G4 reference intake but NOT consumed under Path 1 — the
   * Tripo adapter maps 5 canonical views onto a 4-slot contract and drops
   * this one (server/model-builds/provider.ts:100-110, "Tripo has no fifth
   * slot"). Recorded, not hidden. Consumed once G12 replaces the provider.
   */
  threeQuarterUrl: string;
}

export type GenerationJobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface GenerationJob {
  /** Our job UUID. NEVER a provider task handle. */
  id: string;
  status: GenerationJobStatus;
  progress?: number;
  /** Reason code on failure/cancellation. Never a raw provider error blob. */
  reason?: string;
}

export interface ArtifactBlob {
  data: Buffer;
  sha256: string;
  size: number;
}

export interface GenerationArtifacts {
  glb: ArtifactBlob;
  previews: Array<ArtifactBlob & { type: string }>;
  metadata: Record<string, unknown>;
}

/**
 * Internal job record. Persisted by the job store, never returned upward.
 * `glbUrl` lives here and ONLY here — it must not cross the provider boundary.
 */
export interface ProviderJobRecord {
  jobId: string;
  providerId: string;
  providerVersion: string;
  providerTaskHandle: string;
  model: string;
  configHash: string;
  cancelled: boolean;
  /** Provider-issued download URL, resolved during polling. Internal only. */
  glbUrl?: string;
  createdAt: number;
}
