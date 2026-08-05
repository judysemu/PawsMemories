import crypto from "node:crypto";
import type { ModelBuildProvider, ModelBuildPollResult } from "../model-builds/provider";
import {
  isModelArtifactFinalizer,
  type ModelArtifactFinalizer,
} from "../model-builds/finalizer";
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
  ProviderJobRecord,
  SubjectProfile,
  TextureQuality,
} from "./types";

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Paid-pet adapter for the in-house generation lane.
 *
 * Base creation uses the provider-neutral ModelBuildProvider port. Rig-check,
 * rigging, and animation use the replaceable ModelArtifactFinalizer port.
 * The separate texture stage stays closed because TRELLIS already returns PBR
 * texture; reusing Tripo here would silently make an external call.
 */
export class InHousePetGenerationAdapter implements PetModelGenerationProvider {
  private readonly finalizer: ModelArtifactFinalizer | null;

  constructor(
    private readonly provider: ModelBuildProvider,
    private readonly store: ProviderJobStore = new InMemoryJobStore(),
    private readonly providerVersion: string = process.env.TRELLIS_MODEL_REVISION || "af44b45f2e35a493886929c6d786e563ec68364d",
    finalizer?: ModelArtifactFinalizer,
  ) {
    this.finalizer = finalizer ?? (isModelArtifactFinalizer(provider) ? provider : null);
  }

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
    const source = await this.requireRecord(sourceJobId);
    const finalizer = this.requireFinalizer();
    await finalizer.startFinalization(source.providerTaskHandle);
    return this.persistFinalizationJob(source, "rig_check", { capability: "quadruped" });
  }

  async createRigJob(sourceJobId: string, subjectProfile: SubjectProfile): Promise<GenerationJob> {
    const source = await this.requireRecord(sourceJobId);
    if (subjectProfile !== "pet") {
      throw new PetGenerationError("RIG_TYPE_UNSUPPORTED", "The in-house finalizer currently supports quadruped pets only");
    }
    const finalizer = this.requireFinalizer();
    await finalizer.startFinalization(source.providerTaskHandle);
    return this.persistFinalizationJob(source, "rig", { subjectProfile, animations: ["idle", "walk"] });
  }

  async getJob(jobId: string): Promise<GenerationJob> {
    const record = await this.requireRecord(jobId);
    if (record.cancelled) return { id: jobId, status: "cancelled", reason: "CANCELLED_BY_CALLER" };
    if (record.stage === "rig_check" || record.stage === "rig") {
      const poll = await this.requireFinalizer().pollFinalization(record.providerTaskHandle);
      if (poll.error) return {
        id: jobId,
        status: "failed",
        reason: poll.failureCode || "INHOUSE_FINALIZATION_FAILED",
      };
      if (!poll.done) return { id: jobId, status: "processing", ...(poll.progress !== undefined ? { progress: poll.progress } : {}) };
      return {
        id: jobId,
        status: "completed",
        ...(record.stage === "rig_check"
          ? { capability: { riggable: true, rigType: "quadruped" as const } }
          : {}),
      };
    }
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
    if (record.stage === "rig_check") {
      throw new PetGenerationError("NO_ARTIFACT", "A rig capability check does not produce a customer artifact");
    }
    if (record.stage === "rig") {
      const poll = await this.requireFinalizer().pollFinalization(record.providerTaskHandle);
      if (!poll.done) throw new PetGenerationError("JOB_NOT_COMPLETE", "The in-house rig job is still running");
      if (poll.error) throw new PetGenerationError(poll.failureCode || "INHOUSE_FINALIZATION_FAILED", "The in-house rig job failed");
      const bytes = await this.requireFinalizer().downloadFinal(record.providerTaskHandle);
      return {
        glb: { data: bytes, sha256: sha256(bytes), size: bytes.length },
        previews: [],
        metadata: {
          providerId: record.providerId,
          providerVersion: record.providerVersion,
          model: record.model,
          configHash: record.configHash,
          stage: "rig",
          animated: true,
          animations: ["idle", "walk"],
          pbrPreserved: true,
        },
      };
    }
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

  private requireFinalizer(): ModelArtifactFinalizer {
    if (!this.finalizer) throw this.stageNotReady("Blender rig and animation");
    return this.finalizer;
  }

  private async persistFinalizationJob(
    source: ProviderJobRecord,
    stage: "rig_check" | "rig",
    configuration: Record<string, unknown>,
  ): Promise<GenerationJob> {
    const jobId = crypto.randomUUID();
    const configHash = crypto.createHash("sha256").update(JSON.stringify({
      source: source.configHash,
      stage,
      configuration,
    })).digest("hex");
    await this.store.put({
      jobId,
      providerId: source.providerId,
      providerVersion: this.providerVersion,
      providerTaskHandle: source.providerTaskHandle,
      model: source.model,
      configHash,
      cancelled: false,
      stage,
      createdAt: Date.now(),
    });
    return { id: jobId, status: "pending" };
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
