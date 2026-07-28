import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type PetModelGenerationProvider, PetGenerationError } from "./provider";
import type {
  PetModelGenerationInput,
  GenerationJob,
  GenerationArtifacts,
  SubjectProfile,
  TextureQuality,
} from "./types";

/**
 * Deterministic CI provider. Returns a fixture GLB and NO URL OF ANY KIND.
 *
 * This is the G2 gate instrument: if the downstream stack runs against this
 * unmodified, the provider boundary is real. If anything upstream needs a
 * URL, a task handle, or a provider status string, it will fail here — which
 * is the test working, not the test being wrong.
 *
 * No automated test may ever call a paid generation service. This is the
 * permanent substitute.
 */
export class StubPetGenerationProvider implements PetModelGenerationProvider {
  private jobs = new Map<string, {
    cancelled: boolean;
    capability?: { riggable: boolean; rigType: "quadruped" };
  }>();
  private fixture: Buffer;

  constructor(fixturePath = resolve(process.cwd(), "fixtures/1m-cube.glb")) {
    this.fixture = readFileSync(fixturePath);
  }

  async createJob(_input: PetModelGenerationInput): Promise<GenerationJob> {
    const jobId = crypto.randomUUID();
    this.jobs.set(jobId, { cancelled: false });
    return { id: jobId, status: "completed" };
  }

  async createBaseJob(input: PetModelGenerationInput): Promise<GenerationJob> {
    return this.createJob(input);
  }

  async createTextureJob(
    _sourceJobId: string,
    _options: { styleDirection?: string | null; quality: TextureQuality },
  ): Promise<GenerationJob> {
    return this.createJob(stubInput());
  }

  async createRigCheckJob(_sourceJobId: string): Promise<GenerationJob> {
    const job = await this.createJob(stubInput());
    this.jobs.set(job.id, { cancelled: false, capability: { riggable: true, rigType: "quadruped" } });
    return job;
  }

  async createRigJob(_sourceJobId: string, _subjectProfile: SubjectProfile): Promise<GenerationJob> {
    return this.createJob(stubInput());
  }

  async getJob(jobId: string): Promise<GenerationJob> {
    const job = this.require(jobId);
    return job.cancelled
      ? { id: jobId, status: "cancelled", reason: "CANCELLED_BY_CALLER" }
      : { id: jobId, status: "completed", progress: 100, ...(job.capability ? { capability: job.capability } : {}) };
  }

  /** Tombstone, matching the real adapter: mark, never delete. */
  async cancelJob(jobId: string): Promise<void> {
    this.require(jobId).cancelled = true;
  }

  async fetchArtifacts(jobId: string): Promise<GenerationArtifacts> {
    const job = this.require(jobId);
    if (job.cancelled) {
      throw new PetGenerationError(
        "JOB_CANCELLED",
        `Job was cancelled; late results are discarded: ${jobId}`,
      );
    }
    return {
      glb: {
        data: this.fixture,
        sha256: crypto.createHash("sha256").update(this.fixture).digest("hex"),
        size: this.fixture.length,
      },
      previews: [],
      metadata: { providerId: "stub", providerVersion: "1", model: "fixture" },
    };
  }

  private require(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new PetGenerationError("JOB_NOT_FOUND", `Job not found: ${jobId}`);
    }
    return job;
  }
}

function stubInput(): PetModelGenerationInput {
  return {
    frontUrl: "https://stub.invalid/front.png",
    leftUrl: "https://stub.invalid/left.png",
    rightUrl: "https://stub.invalid/right.png",
    rearUrl: "https://stub.invalid/rear.png",
    threeQuarterUrl: "https://stub.invalid/three-quarter.png",
  };
}
