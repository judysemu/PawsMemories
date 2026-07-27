import type {
  PetModelGenerationInput,
  GenerationJob,
  GenerationArtifacts,
  ProviderJobRecord,
} from "./types";

/**
 * Provider-neutral generation port. Nothing above this interface may know
 * which provider is in use.
 */
export interface PetModelGenerationProvider {
  createJob(input: PetModelGenerationInput): Promise<GenerationJob>;
  getJob(jobId: string): Promise<GenerationJob>;
  cancelJob(jobId: string): Promise<void>;
  fetchArtifacts(jobId: string): Promise<GenerationArtifacts>;
}

/**
 * Job-record persistence port.
 *
 * G2 SCOPE NOTE: the only implementation today is InMemoryJobStore below,
 * which is an EXPLICIT PLACEHOLDER. It does not survive a process restart and
 * does not work across multiple instances. That is acceptable for G2, whose
 * deliverable is the boundary, and is NOT acceptable once real paid orders
 * exist. G3 (order state machine) must supply a MySQL-backed implementation
 * of this same interface — which is why it is an interface and not a Map
 * embedded in the adapter. See docs/audits/G2_GAPS.md.
 */
export interface ProviderJobStore {
  put(record: ProviderJobRecord): Promise<void>;
  get(jobId: string): Promise<ProviderJobRecord | undefined>;
  update(jobId: string, patch: Partial<ProviderJobRecord>): Promise<void>;
}

export class InMemoryJobStore implements ProviderJobStore {
  private records = new Map<string, ProviderJobRecord>();

  async put(record: ProviderJobRecord): Promise<void> {
    this.records.set(record.jobId, { ...record });
  }

  async get(jobId: string): Promise<ProviderJobRecord | undefined> {
    const found = this.records.get(jobId);
    return found ? { ...found } : undefined;
  }

  async update(jobId: string, patch: Partial<ProviderJobRecord>): Promise<void> {
    const existing = this.records.get(jobId);
    if (!existing) throw new Error(`Job not found: ${jobId}`);
    this.records.set(jobId, { ...existing, ...patch });
  }
}

export class PetGenerationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PetGenerationError";
  }
}
