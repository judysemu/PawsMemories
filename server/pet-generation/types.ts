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
  /** Legacy fifth view retained for old manifests; Tripo consumes four views. */
  threeQuarterUrl?: string;
  meshProfile?: MeshProfile;
  subjectProfile?: SubjectProfile;
}

export type MeshProfile = "hd" | "smart_mesh";
export type SubjectProfile = "pet" | "humanoid";
export type TextureQuality = "standard" | "detailed";
export type PetGlbStageKind = "reference" | "base" | "texture" | "rig_check" | "rig";
export type PetGlbModelStageKind = "base" | "texture" | "rig";

export interface PetGlbOrderConfiguration {
  meshProfile: MeshProfile;
  subjectProfile: SubjectProfile;
  includeTexture: boolean;
  includeRig: boolean;
  textureQuality: TextureQuality;
  styleDirection: string | null;
}

export interface RigCapability {
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
  /** Provider-neutral result of a real pre-rig capability task. */
  capability?: RigCapability;
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
  /** FK to pet_glb_orders.id once G3's order table exists. */
  orderId?: number;
  providerId: string;
  providerVersion: string;
  providerTaskHandle: string;
  model: string;
  configHash: string;
  cancelled: boolean;
  /** Provider-issued download URL, resolved during polling. Internal only. */
  glbUrl?: string;
  createdAt: number;

  /**
   * Multi-stage animated build (Tripo-native rig + idle/walk retarget). All of
   * this is INTERNAL and never crosses the provider boundary — the same rule
   * as glbUrl. `stage` drives the state machine in TripoPetGenerationAdapter;
   * the task handles and URLs are Tripo-issued and resolved during polling.
   * Absent on single-shot (non-animated) jobs.
   */
  stage?: "base" | "texture" | "rig_check" | "rig" | "idle" | "walk" | "ready";
  rigTaskHandle?: string;
  idleTaskHandle?: string;
  walkTaskHandle?: string;
  idleGlbUrl?: string;
  walkGlbUrl?: string;
}
