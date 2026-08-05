import crypto from "node:crypto";
import type { ModelBuildProvider, ModelBuildPollResult } from "../model-builds/provider";
import { meshProfilePolicy } from "./contracts";
import {
  InMemoryJobStore,
  PetGenerationError,
  type PetModelGenerationProvider,
  type ProviderJobStore,
} from "./provider";
import type {
  GenerationArtifacts,
  GenerationJob,
  GenerationJobStatus,
  PetModelGenerationInput,
  SubjectProfile,
  TextureQuality,
} from "./types";

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Paid-pet adapter for the in-house generation lane.
 *
 * Base creation is live through the provider-neutral ModelBuildProvider port.
 * Texture and rigging deliberately fail closed until their internal worker
 * contracts are wired. Reusing TripoPetGenerationAdapter here would look
 * convenient but would silently call Tripo for those later stages.
 */
export class InHousePetGenerationAdapter implements PetModelGenerationProvider {
  constructor(
    private readonly provider: ModelBuildProvider,
    private readonly store: ProviderJobStore = new InMemoryJobStore(),
    private readonly providerVersion: string = process.env.TRELLIS_MODEL_REVISION || "af44b45f2e35a493886929c6d786e563ec68364d",
  ) {}

  async createJob(input: PetModelGenerationInput): Promise<GenerationJob> {
    return this.createBaseJob(input);
  }

  async createBaseJob(input: PetModelGenerationInput): Promise<GenerationJob> {
    const policy = meshProfilePolicy(input.meshProfile || "hd");
    const configHash = this.hashInput(input);
    const result = await this.provider.start({
      frontUrl: input.frontUrl,
      leftUrl: input.leftUrl,
      rightUrl: input.rightUrl,
      rearUrl: input.rearUrl,
      threeQuarterUrl: input.threeQuarterUrl,
      geometry: {
        faceLimit: policy.faceLimit,
        texture: true,
        pbr: true,
        modelVersion: policy.modelVersion,
        smartLowPoly: policy.smartLowPoly,
        geometryQuality: policy.geometryQuality,
      },
    }, configHash);
    const jobId = crypto.randomUUID();
    await this.store.put({
      jobId,
      providerId: result.provider,
      providerVersion: this.providerVersion,
      providerTaskHandle: result.providerTaskHandle,
      model: result.model,
      configHash,
      cancelled: false,
      stage: "base",
      createdAt: Date.now(),
    });
    return { id: jobId, status: "pending" };
  }

  async createTextureJob(
    sourceJobId: string,
    _options: { styleDirection?: string | null; quality: TextureQuality },
  ): Promise<GenerationJob> {
    await this.requireRecord(sourceJobId);
    throw this.stageNotReady("texture");
  }

  async createRigCheckJob(sourceJobId: string): Promise<GenerationJob> {
    await this.requireRecord(sourceJobId);
    throw this.stageNotReady("rig capability check");
  }

  async createRigJob(sourceJobId: string, _subjectProfile: SubjectProfile): Promise<GenerationJob> {
    await this.requireRecord(sourceJobId);
    throw this.stageNotReady("Blender rig and animation");
  }

  async getJob(jobId: string): Promise<GenerationJob> {
    const record = await this.requireRecord(jobId);
    if (record.cancelled) return { id: jobId, status: "cancelled", reason: "CANCELLED_BY_CALLER" };
    const poll: ModelBuildPollResult = await this.provider.poll(record.providerTaskHandle);
    if (poll.glbUrl && poll.glbUrl !== record.glbUrl) await this.store.update(jobId, { glbUrl: poll.glbUrl });
    let status: GenerationJobStatus = "processing";
    if (poll.done) status = poll.error ? "failed" : "completed";
    return {
      id: jobId,
      status,
      ...(poll.progress !== undefined ? { progress: poll.progress } : {}),
      ...(poll.error ? { reason: poll.failureCode || "PROVIDER_ERROR" } : {}),
    };
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.requireRecord(jobId);
    await this.store.update(jobId, { cancelled: true });
  }

  async fetchArtifacts(jobId: string): Promise<GenerationArtifacts> {
    const record = await this.requireRecord(jobId);
    if (record.cancelled) throw new PetGenerationError("JOB_CANCELLED", "Cancelled jobs cannot deliver artifacts");
    let artifactReference = record.glbUrl;
    if (!artifactReference) {
      const poll = await this.provider.poll(record.providerTaskHandle);
      if (!poll.done) throw new PetGenerationError("JOB_NOT_COMPLETE", "The in-house model job is still running");
      if (poll.error) throw new PetGenerationError(poll.failureCode || "PROVIDER_ERROR", "The in-house model job failed");
      if (!poll.glbUrl) throw new PetGenerationError("NO_ARTIFACT", "The in-house model job produced no artifact");
      artifactReference = poll.glbUrl;
      await this.store.update(jobId, { glbUrl: artifactReference });
    }
    const bytes = await this.provider.download(artifactReference);
    return {
      glb: { data: bytes, sha256: sha256(bytes), size: bytes.length },
      previews: [],
      metadata: {
        providerId: record.providerId,
        providerVersion: record.providerVersion,
        model: record.model,
        configHash: record.configHash,
        stage: "base",
        pbrRequested: true,
        threeQuarterViewConsumed: false,
      },
    };
  }

  private async requireRecord(jobId: string) {
    const record = await this.store.get(jobId);
    if (!record) throw new PetGenerationError("JOB_NOT_FOUND", `Job not found: ${jobId}`);
    return record;
  }

  private stageNotReady(stage: string): PetGenerationError {
    return new PetGenerationError(
      "INHOUSE_STAGE_NOT_READY",
      `The in-house ${stage} stage is not enabled until its worker contract passes end-to-end verification`,
    );
  }

  private hashInput(input: PetModelGenerationInput): string {
    return crypto.createHash("sha256").update(JSON.stringify({
      frontUrl: input.frontUrl,
      leftUrl: input.leftUrl,
      rightUrl: input.rightUrl,
      rearUrl: input.rearUrl,
      threeQuarterUrl: input.threeQuarterUrl || null,
      meshProfile: input.meshProfile || "hd",
      subjectProfile: input.subjectProfile || "pet",
    })).digest("hex");
  }
}
