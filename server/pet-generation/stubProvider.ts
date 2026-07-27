import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type PetModelGenerationProvider, PetGenerationError } from "./provider";
import type {
  PetModelGenerationInput,
  GenerationJob,
  GenerationArtifacts,
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
  private jobs = new Map<string, { cancelled: boolean }>();
  private fixture: Buffer;

  constructor(fixturePath = resolve(process.cwd(), "fixtures/1m-cube.glb")) {
    this.fixture = readFileSync(fixturePath);
  }

  async createJob(_input: PetModelGenerationInput): Promise<GenerationJob> {
    const jobId = crypto.randomUUID();
    this.jobs.set(jobId, { cancelled: false });
    return { id: jobId, status: "completed" };
  }

  async getJob(jobId: string): Promise<GenerationJob> {
    const job = this.require(jobId);
    return job.cancelled
      ? { id: jobId, status: "cancelled", reason: "CANCELLED_BY_CALLER" }
      : { id: jobId, status: "completed", progress: 100 };
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
