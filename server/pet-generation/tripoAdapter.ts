import crypto from "node:crypto";
import type {
  ModelBuildProvider,
  ModelBuildPollResult,
} from "../model-builds/provider";
import {
  type PetModelGenerationProvider,
  type ProviderJobStore,
  InMemoryJobStore,
  PetGenerationError,
} from "./provider";
import type {
  PetModelGenerationInput,
  GenerationJob,
  GenerationArtifacts,
  GenerationJobStatus,
} from "./types";

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Wraps the existing three-method ModelBuildProvider port
 * (start / poll / download) behind the four-method provider-neutral
 * interface, per docs/audits/G1_REVIEW_AND_CORRECTIONS.md §3.3.
 *
 * The leak this closes: previously the SERVICE LAYER held `pollResult.glbUrl`
 * and handed it back down to `provider.download()`
 * (server/model-builds/service.ts:435,448,466). Here the URL is resolved
 * during polling, persisted in the job record, and consumed inside
 * fetchArtifacts. It never crosses the boundary upward.
 *
 * The wrapped provider is NOT modified or replaced — the legacy path keeps
 * working; this adds a boundary above it.
 */
export class TripoPetGenerationAdapter implements PetModelGenerationProvider {
  constructor(
    private readonly provider: ModelBuildProvider,
    private readonly store: ProviderJobStore = new InMemoryJobStore(),
    private readonly providerVersion: string = process.env.TRIPO_MODEL_VERSION || "default",
  ) {}

  async createJob(input: PetModelGenerationInput): Promise<GenerationJob> {
    // 5 canonical views -> Tripo's 4-slot contract. threeQuarterUrl is
    // deliberately not forwarded; see types.ts.
    const providerInput = {
      frontUrl: input.frontUrl,
      leftUrl: input.leftUrl,
      rightUrl: input.rightUrl,
      rearUrl: input.rearUrl,
      threeQuarterUrl: input.threeQuarterUrl,
    };

    const configHash = this.hashInput(input);
    const result = await this.provider.start(providerInput, configHash);
    const jobId = crypto.randomUUID();

    await this.store.put({
      jobId,
      providerId: result.provider,
      providerVersion: this.providerVersion,
      providerTaskHandle: result.providerTaskHandle,
      model: result.model,
      configHash,
      cancelled: false,
      createdAt: Date.now(),
    });

    // Provider handle is NOT returned.
    return { id: jobId, status: "pending" };
  }

  async getJob(jobId: string): Promise<GenerationJob> {
    const record = await this.requireRecord(jobId);

    // Tombstone: a cancelled job stays queryable and is never re-polled.
    if (record.cancelled) {
      return { id: jobId, status: "cancelled", reason: "CANCELLED_BY_CALLER" };
    }

    const poll: ModelBuildPollResult = await this.provider.poll(
      record.providerTaskHandle,
    );

    // Capture the URL internally the moment it appears. It stops here.
    if (poll.glbUrl && poll.glbUrl !== record.glbUrl) {
      await this.store.update(jobId, { glbUrl: poll.glbUrl });
    }

    let status: GenerationJobStatus = "processing";
    if (poll.done) status = poll.error ? "failed" : "completed";

    return {
      id: jobId,
      status,
      ...(poll.progress !== undefined ? { progress: poll.progress } : {}),
      ...(poll.error ? { reason: "PROVIDER_ERROR" } : {}),
    };
  }

  /**
   * Local tombstone. The upstream port has no cancel operation, so the record
   * is MARKED cancelled and retained — not deleted. Retention is what allows
   * late provider results to be recognised and discarded, and what keeps
   * getJob() answering "cancelled" instead of "not found".
   */
  async cancelJob(jobId: string): Promise<void> {
    await this.requireRecord(jobId);
    await this.store.update(jobId, { cancelled: true });
  }

  async fetchArtifacts(jobId: string): Promise<GenerationArtifacts> {
    const record = await this.requireRecord(jobId);

    if (record.cancelled) {
      throw new PetGenerationError(
        "JOB_CANCELLED",
        `Job was cancelled; late results are discarded: ${jobId}`,
      );
    }

    let glbUrl = record.glbUrl;
    if (!glbUrl) {
      const poll = await this.provider.poll(record.providerTaskHandle);
      if (!poll.done) {
        throw new PetGenerationError("JOB_NOT_COMPLETE", `Job not yet complete: ${jobId}`);
      }
      if (poll.error) {
        throw new PetGenerationError("PROVIDER_ERROR", `Job failed: ${jobId}`);
      }
      if (!poll.glbUrl) {
        throw new PetGenerationError("NO_ARTIFACT", `No artifact produced: ${jobId}`);
      }
      glbUrl = poll.glbUrl;
      await this.store.update(jobId, { glbUrl });
    }

    // download() retains its SSRF protection (isAllowedUrl,
    // MAX_GLB_DOWNLOAD_BYTES) — still required, just no longer exposed.
    const glbBuffer = await this.provider.download(glbUrl);

    return {
      glb: { data: glbBuffer, sha256: sha256(glbBuffer), size: glbBuffer.length },
      previews: [],
      metadata: {
        providerId: record.providerId,
        providerVersion: record.providerVersion,
        model: record.model,
        configHash: record.configHash,
        threeQuarterViewConsumed: false,
      },
    };
  }

  private async requireRecord(jobId: string) {
    const record = await this.store.get(jobId);
    if (!record) {
      throw new PetGenerationError("JOB_NOT_FOUND", `Job not found: ${jobId}`);
    }
    return record;
  }

  private hashInput(input: PetModelGenerationInput): string {
    const canonical = [
      input.frontUrl,
      input.leftUrl,
      input.rightUrl,
      input.rearUrl,
      input.threeQuarterUrl,
    ].join("|");
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }
}
