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
  PetGlbStageKind,
  ProviderJobRecord,
  SubjectProfile,
  TextureQuality,
} from "./types";
import { mergeIdleWalk } from "./animationMerge";
import {
  startPreRigCheck,
  startRig,
  startRetarget,
  startTextureModel,
  pollTripoTask,
} from "../../tripo";
import { meshProfilePolicy, rigTypeForSubject } from "./contracts";

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Map a provider progress reading (0–100, maybe absent) into a sub-range. */
function scale(progress: number | undefined, lo: number, hi: number): number {
  if (progress === undefined) return lo;
  const p = Math.max(0, Math.min(100, progress));
  return Math.round(lo + (p / 100) * (hi - lo));
}

/** Result of polling one Tripo task — same shape upstream and in tests. */
export interface TripoTaskPoll {
  done: boolean;
  glbUrl?: string;
  error?: string;
  progress?: number;
}

/**
 * The Tripo-specific rig + preset-retarget operations the animated pipeline
 * needs, injected so the multi-stage state machine is unit-testable without a
 * live Tripo account. Default implementation wires straight to tripo.ts.
 */
export interface TripoAnimationOps {
  /** animate_rig (UniRig quadruped) on the base model task → rig task handle. */
  startRig(baseModelTaskHandle: string, rigType?: "biped" | "quadruped"): Promise<string>;
  /** animate_retarget preset:idle|walk on the rig task → retarget task handle. */
  startRetarget(
    rigTaskHandle: string,
    animation: "preset:idle" | "preset:walk",
  ): Promise<string>;
  /** Poll any Tripo rig/retarget task. */
  pollTask(taskHandle: string): Promise<TripoTaskPoll>;
}

const defaultAnimationOps: TripoAnimationOps = {
  startRig: (h, rigType = "quadruped") => startRig(h, { rigType }),
  startRetarget: (h, a) => startRetarget(h, a),
  pollTask: (h) => pollTripoTask(h),
};

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
  private readonly animate: boolean;
  private readonly ops: TripoAnimationOps;

  constructor(
    private readonly provider: ModelBuildProvider,
    private readonly store: ProviderJobStore = new InMemoryJobStore(),
    private readonly providerVersion: string = process.env.TRIPO_MODEL_VERSION || "default",
    opts: { animate?: boolean; animationOps?: TripoAnimationOps } = {},
  ) {
    // Default OFF so existing single-shot construction is unchanged; the pet-glb
    // factory opts in. When on, getJob runs base → rig → idle → walk and
    // fetchArtifacts returns ONE merged GLB carrying both idle and walk clips.
    this.animate = opts.animate ?? false;
    this.ops = opts.animationOps ?? defaultAnimationOps;
  }

  /** Tripo keeps its existing submission behavior; no new readiness call is introduced. */
  async preflightForCharge(_stage: Exclude<PetGlbStageKind, "reference">): Promise<void> {}

  async createJob(input: PetModelGenerationInput): Promise<GenerationJob> {
    return this.createBaseJob(input);
  }

  async createBaseJob(input: PetModelGenerationInput): Promise<GenerationJob> {
    // The approved set already matches Tripo's 4-slot canonical contract.
    const providerInput = {
      frontUrl: input.frontUrl,
      leftUrl: input.leftUrl,
      rightUrl: input.rightUrl,
      rearUrl: input.rearUrl,
      threeQuarterUrl: input.threeQuarterUrl,
      geometry: (() => {
        const policy = meshProfilePolicy(input.meshProfile || "hd");
        return {
          texture: false,
          pbr: false,
          modelVersion: policy.modelVersion,
        };
      })(),
    };

    const configHash = this.hashInput(input);
    const result = await this.provider.start(providerInput, configHash);
    const jobId = crypto.randomUUID();

    await this.store.put({
      jobId,
      providerId: result.provider,
      providerVersion: this.providerVersion,
      providerTaskHandle: result.providerTaskHandle,
      // MG-11: the base task IS the generation task, so it seeds the handle
      // that every downstream rig stage must submit to Tripo.
      baseModelTaskHandle: result.providerTaskHandle,
      model: result.model,
      configHash,
      cancelled: false,
      stage: "base",
      createdAt: Date.now(),
    });

    // Provider handle is NOT returned.
    return { id: jobId, status: "pending" };
  }

  async createTextureJob(
    sourceJobId: string,
    options: { styleDirection?: string | null; quality: TextureQuality },
  ): Promise<GenerationJob> {
    const source = await this.requireRecord(sourceJobId);
    const taskHandle = await startTextureModel(source.providerTaskHandle, {
      prompt: options.styleDirection || undefined,
      quality: options.quality,
    });
    return this.persistChainedJob(source, taskHandle, "texture", {
      styleDirection: options.styleDirection || null,
      quality: options.quality,
    });
  }

  /**
   * MG-11: Tripo's rig endpoints take the task id of a 3D GENERATION task, so
   * a chained record must submit its base handle rather than its own — which,
   * after a texture stage, is a `texture_model` handle Tripo will reject.
   */
  private rigSourceHandle(source: ProviderJobRecord): string {
    if (source.stage === "base" || !source.stage) return source.providerTaskHandle;
    if (source.baseModelTaskHandle) return source.baseModelTaskHandle;
    throw new Error(
      `Cannot start a rig stage from a ${source.stage} task without the originating base model task handle`,
    );
  }

  async createRigCheckJob(sourceJobId: string): Promise<GenerationJob> {
    const source = await this.requireRecord(sourceJobId);
    const taskHandle = await startPreRigCheck(this.rigSourceHandle(source));
    return this.persistChainedJob(source, taskHandle, "rig_check", {});
  }

  async createRigJob(sourceJobId: string, subjectProfile: SubjectProfile): Promise<GenerationJob> {
    const source = await this.requireRecord(sourceJobId);
    const rigType = rigTypeForSubject(subjectProfile);
    const taskHandle = await this.ops.startRig(this.rigSourceHandle(source), rigType);
    const job = await this.persistChainedJob(source, taskHandle, "rig", { subjectProfile, rigType, animations: ["idle", "walk"] });
    // A purchased rig is also the source for Tripo's native idle and walk
    // presets. Persisting this handle lets ordinary staged polling continue
    // through rig → idle → walk without another customer approval screen.
    await this.store.update(job.id, { rigTaskHandle: taskHandle });
    return job;
  }

  async getJob(jobId: string): Promise<GenerationJob> {
    const record = await this.requireRecord(jobId);

    // Tombstone: a cancelled job stays queryable and is never re-polled.
    if (record.cancelled) {
      return { id: jobId, status: "cancelled", reason: "CANCELLED_BY_CALLER" };
    }

    if (this.animate || record.rigTaskHandle) return this.advanceAnimatedJob(jobId, record);

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
      ...(poll.capability ? { capability: poll.capability } : {}),
    };
  }

  /**
   * Animated build state machine. Each getJob call advances AT MOST one stage;
   * the caller polls repeatedly (the existing order poll loop). Stages:
   * base (image→model) → rig (animate_rig) → idle (animate_retarget) →
   * walk (animate_retarget) → ready. Every task handle and URL stays in the
   * record and never crosses the boundary; only {id,status,progress,reason}
   * leaves this method.
   */
  private async advanceAnimatedJob(
    jobId: string,
    record: ProviderJobRecord,
  ): Promise<GenerationJob> {
    const processing = (progress: number): GenerationJob => ({
      id: jobId, status: "processing", progress,
    });
    const failed = (): GenerationJob => ({
      id: jobId, status: "failed", reason: "PROVIDER_ERROR",
    });

    switch (record.stage ?? "base") {
      case "base": {
        const poll = await this.provider.poll(record.providerTaskHandle);
        if (poll.error) return failed();
        if (!poll.done) return processing(scale(poll.progress, 0, 20));
        const rigTaskHandle = await this.ops.startRig(record.providerTaskHandle);
        await this.store.update(jobId, { stage: "rig", rigTaskHandle });
        return processing(25);
      }
      case "rig": {
        const poll = await this.ops.pollTask(record.rigTaskHandle!);
        if (poll.error) return failed();
        if (!poll.done) return processing(scale(poll.progress, 25, 45));
        const idleTaskHandle = await this.ops.startRetarget(record.rigTaskHandle!, "preset:idle");
        await this.store.update(jobId, { stage: "idle", idleTaskHandle });
        return processing(50);
      }
      case "idle": {
        const poll = await this.ops.pollTask(record.idleTaskHandle!);
        if (poll.error) return failed();
        if (!poll.done) return processing(scale(poll.progress, 50, 70));
        if (poll.glbUrl) await this.store.update(jobId, { idleGlbUrl: poll.glbUrl });
        const walkTaskHandle = await this.ops.startRetarget(record.rigTaskHandle!, "preset:walk");
        await this.store.update(jobId, { stage: "walk", walkTaskHandle });
        return processing(75);
      }
      case "walk": {
        const poll = await this.ops.pollTask(record.walkTaskHandle!);
        if (poll.error) return failed();
        if (!poll.done) return processing(scale(poll.progress, 75, 95));
        if (poll.glbUrl) await this.store.update(jobId, { walkGlbUrl: poll.glbUrl });
        await this.store.update(jobId, { stage: "ready" });
        return { id: jobId, status: "completed" };
      }
      default: // "ready"
        return { id: jobId, status: "completed" };
    }
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

    if (this.animate || record.rigTaskHandle) return this.fetchAnimatedArtifacts(record, jobId);
    if (record.stage === "rig_check") {
      throw new PetGenerationError("NO_ARTIFACT", "A rig capability check does not produce a GLB");
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
        stage: record.stage || "base",
      },
    };
  }

  /**
   * Animated artifact: download the idle and walk retarget GLBs (SSRF-protected
   * via provider.download) and merge them into ONE GLB carrying both clips.
   * The merged bytes are what the validator sees and what the customer buys.
   */
  private async fetchAnimatedArtifacts(
    record: ProviderJobRecord,
    jobId: string,
  ): Promise<GenerationArtifacts> {
    if (record.stage !== "ready") {
      throw new PetGenerationError("JOB_NOT_COMPLETE", `Animated job not yet complete: ${jobId}`);
    }
    if (!record.idleGlbUrl || !record.walkGlbUrl) {
      throw new PetGenerationError("NO_ARTIFACT", `Missing idle/walk artifact for job: ${jobId}`);
    }

    const [idleBuf, walkBuf] = await Promise.all([
      this.provider.download(record.idleGlbUrl),
      this.provider.download(record.walkGlbUrl),
    ]);
    const merged = await mergeIdleWalk(idleBuf, walkBuf);

    return {
      glb: { data: merged, sha256: sha256(merged), size: merged.length },
      previews: [],
      metadata: {
        providerId: record.providerId,
        providerVersion: record.providerVersion,
        model: record.model,
        configHash: record.configHash,
        threeQuarterViewConsumed: false,
        animated: true,
        animations: ["idle", "walk"],
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

  private async persistChainedJob(
    source: ProviderJobRecord,
    providerTaskHandle: string,
    stage: "texture" | "rig_check" | "rig",
    configuration: Record<string, unknown>,
  ): Promise<GenerationJob> {
    const jobId = crypto.randomUUID();
    const configHash = crypto
      .createHash("sha256")
      .update(JSON.stringify({ source: source.configHash, stage, configuration }))
      .digest("hex");
    await this.store.put({
      jobId,
      providerId: source.providerId,
      providerVersion: stage === "rig"
        ? process.env.TRIPO_RIG_MODEL_VERSION || "v2.5-20260210"
        : source.providerVersion,
      providerTaskHandle,
      // MG-11: carry the originating generation task id down the whole chain.
      baseModelTaskHandle: source.baseModelTaskHandle
        || (source.stage === "base" ? source.providerTaskHandle : undefined),
      model: source.model,
      configHash,
      cancelled: false,
      stage,
      createdAt: Date.now(),
    });
    return { id: jobId, status: "pending" };
  }

  private hashInput(input: PetModelGenerationInput): string {
    const canonical = [
      input.frontUrl,
      input.leftUrl,
      input.rightUrl,
      input.rearUrl,
      input.threeQuarterUrl || "",
    ].join("|");
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }
}
