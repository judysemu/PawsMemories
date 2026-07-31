import type mysql from "mysql2/promise";
import crypto from "node:crypto";
import {
  assertInhouseSpatialGeneratorEnabled,
  isInhouseSpatialGeneratorEnabled,
} from "./featureFlag";
import {
  SpatialGeneratorRepository,
} from "./repository";
import {
  SpatialJobState,
  SpatialAttemptState,
  SpatialArtifactRole,
  SpatialJobPublic,
  SpatialAttemptPublic,
  SpatialArtifactPublic,
  SpatialReviewPublic,
  SpatialEventPublic,
  SpatialQuotePublic,
  SpatialPreflightResult,
  SpatialObserveOutput,
  SpatialPlanOutput,
  SpatialMathInput,
  SpatialMathOutput,
  SpatialVerifyOutput,
  MAX_CORRECTION_ATTEMPTS,
  DEFAULT_LEASE_DURATION_MS,
  MATH_LIMITS,
} from "./types";
import {
  CreateSpatialJobSchema,
  QuoteSpatialJobSchema,
  RetrySpatialJobSchema,
  ReviewSpatialJobSchema,
  CancelSpatialJobSchema,
  type CreateSpatialJobInput,
  type QuoteSpatialJobInput,
  type RetrySpatialJobInput,
  type ReviewSpatialJobInput,
  type CancelSpatialJobInput,
  SpatialMathOutputSchema,
  SpatialVerifyOutputSchema,
} from "./schemas";
import { getPool } from "../../db";
import { isUserAdmin } from "../../db";
import {
  observeReferences,
  generatePlan,
  verifyDraft,
  checkLayer8Health,
} from "./provider";
import { getBlenderClient } from "../../agent/tools/blender_client";
import { compileBlenderProgram } from "./compiler";
import { validateGlb, validateMathAgainstGlb } from "./validation";
import { spatialStorage } from "./storage";
import { registerAsset, addAssetVersion } from "../assets/service";

// The direct spatial pipeline deliberately does not depend on the retired
// Pixel/Gemma bridge.  The scheduler flips this state only after it has
// started successfully; readiness therefore cannot be spoofed by a flag.
let directSchedulerReady = false;

export function setDirectSpatialSchedulerReady(ready: boolean): void {
  directSchedulerReady = ready;
}

export function isDirectSpatialSchedulerReady(): boolean {
  return directSchedulerReady;
}

async function checkDirectBlenderWorker(): Promise<boolean> {
  const rawUrl = String(process.env.BLENDER_WORKER_URL || "").trim();
  const sharedSecret = String(process.env.WORKER_SHARED_SECRET || "").trim();
  if (!rawUrl || !sharedSecret) return false;
  const baseUrl = rawUrl.replace(/\/render\/?$/, "").replace(/\/$/, "");
  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { "x-worker-secret": sharedSecret, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { status?: unknown; bridge?: unknown };
    return body.status === "ok" && body.bridge === "connected";
  } catch {
    return false;
  }
}

export class SpatialGeneratorServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SpatialGeneratorServiceError";
  }
}

export interface SpatialGeneratorOptions {
  pool?: mysql.Pool;
  isAdmin?: (userId: string) => Promise<boolean>;
  // Layer8 clients (injected for testing)
  observeClient?: SpatialObserveClient;
  planClient?: SpatialPlanClient;
  mathExecutor?: SpatialMathExecutor;
  verifyClient?: SpatialVerifyClient;
  blenderWorker?: BlenderWorkerClient;
  // Canonical asset registry
  assetService?: any; // will be typed from assets/service
}

// ─── Layer8 Client Interfaces (for DI and testing) ────────────────────────────

export interface SpatialObserveClient {
  observe(input: { referenceAssetVersionIds: number[]; scaleAnchor: any }): Promise<SpatialObserveOutput>;
}

export interface SpatialPlanClient {
  plan(input: {
    observation: SpatialObserveOutput;
    userPrompt: string;
    targetEnvelopeMm: { x: number; y: number; z: number };
    scaleAnchor: any;
    attachmentInterface: any;
  }): Promise<SpatialPlanOutput>;
}

export interface SpatialMathExecutor {
  execute(input: SpatialMathInput): Promise<SpatialMathOutput>;
}

export interface SpatialVerifyClient {
  verify(input: {
    observation: SpatialObserveOutput;
    draftRenderAssetVersions: number[];
    attemptHash: string;
  }): Promise<SpatialVerifyOutput>;
}

export interface BlenderWorkerClient {
  buildDraft(input: {
    attemptId: number;
    plan: SpatialPlanOutput;
    math: SpatialMathOutput;
    compiledProgramHash: string;
  }): Promise<{
    draftGlbAssetVersionId: number;
    renderAssetVersionIds: number[]; // 5 views
    boundsMm: { min: [number, number, number]; max: [number, number, number] };
  }>;
  buildFinal(input: {
    attemptId: number;
    plan: SpatialPlanOutput;
    math: SpatialMathOutput;
    compiledProgramHash: string;
    targetUse: "digital" | "attachment" | "print";
  }): Promise<{
    finalGlbAssetVersionId: number;
    finalStlAssetVersionId?: number;
    manufacturingReportAssetVersionId?: number;
    boundsMm: { min: [number, number, number]; max: [number, number, number] };
  }>;
}

// ─── Deterministic Math Solver (server-side, per §2.6 amendment) ─────────────

export class DeterministicMathSolver implements SpatialMathExecutor {
  async execute(input: SpatialMathInput): Promise<SpatialMathOutput> {
    // Recompute every primitive's dimensions and positions from normalized values
    const envelope = input.envelopeMm;
    const halfEnvelope = { x: envelope.x / 2, y: envelope.y / 2, z: envelope.z / 2 };

    const resolvedPrimitives = input.primitives.map((prim) => {
      const dims = {
        x: Math.round(prim.normalizedSize.x * envelope.x * 1000) / 1000,
        y: Math.round(prim.normalizedSize.y * envelope.y * 1000) / 1000,
        z: Math.round(prim.normalizedSize.z * envelope.z * 1000) / 1000,
      };

      const pos = {
        x: Math.round(prim.normalizedPosition.x * halfEnvelope.x * 1000) / 1000,
        y: Math.round(prim.normalizedPosition.y * halfEnvelope.y * 1000) / 1000,
        z: Math.round(prim.normalizedPosition.z * halfEnvelope.z * 1000) / 1000,
      };

      const rotation = {
        x: Math.round(prim.rotationDeg.x * 1000) / 1000,
        y: Math.round(prim.rotationDeg.y * 1000) / 1000,
        z: Math.round(prim.rotationDeg.z * 1000) / 1000,
      };

      return {
        id: prim.id,
        dimensionsMm: dims,
        positionMm: pos,
        rotationDeg: rotation,
      };
    });

    // Compute derived bounds
    let boundsMin = { x: Infinity, y: Infinity, z: Infinity };
    let boundsMax = { x: -Infinity, y: -Infinity, z: -Infinity };
    let totalVolume = 0;

    for (const prim of resolvedPrimitives) {
      const halfX = prim.dimensionsMm.x / 2;
      const halfY = prim.dimensionsMm.y / 2;
      const halfZ = prim.dimensionsMm.z / 2;

      const min = {
        x: prim.positionMm.x - halfX,
        y: prim.positionMm.y - halfY,
        z: prim.positionMm.z - halfZ,
      };
      const max = {
        x: prim.positionMm.x + halfX,
        y: prim.positionMm.y + halfY,
        z: prim.positionMm.z + halfZ,
      };

      boundsMin.x = Math.min(boundsMin.x, min.x);
      boundsMin.y = Math.min(boundsMin.y, min.y);
      boundsMin.z = Math.min(boundsMin.z, min.z);
      boundsMax.x = Math.max(boundsMax.x, max.x);
      boundsMax.y = Math.max(boundsMax.y, max.y);
      boundsMax.z = Math.max(boundsMax.z, max.z);

      totalVolume += prim.dimensionsMm.x * prim.dimensionsMm.y * prim.dimensionsMm.z;
    }

    // Round bounds
    boundsMin = {
      x: Math.round(boundsMin.x * 1000) / 1000,
      y: Math.round(boundsMin.y * 1000) / 1000,
      z: Math.round(boundsMin.z * 1000) / 1000,
    };
    boundsMax = {
      x: Math.round(boundsMax.x * 1000) / 1000,
      y: Math.round(boundsMax.y * 1000) / 1000,
      z: Math.round(boundsMax.z * 1000) / 1000,
    };

    const calculations = input.primitives.map((prim) => {
      const dims = {
        x: Math.round(prim.normalizedSize.x * envelope.x * 1000) / 1000,
        y: Math.round(prim.normalizedSize.y * envelope.y * 1000) / 1000,
        z: Math.round(prim.normalizedSize.z * envelope.z * 1000) / 1000,
      };
      return `${prim.id}.x = ${prim.normalizedSize.x.toFixed(7)} * ${envelope.x} mm = ${dims.x} mm`;
    });

    return {
      schemaVersion: "pawsome.spatial-math.v1",
      planHash: input.planHash,
      units: "mm",
      resolvedPrimitives,
      derived: {
        boundsMinMm: boundsMin,
        boundsMaxMm: boundsMax,
        estimatedVolumeMm3: Math.round(totalVolume),
      },
      calculations,
    };
  }
}

// ─── Service Implementation ──────────────────────────────────────────────────

export class SpatialGeneratorService {
  private readonly repo: SpatialGeneratorRepository;
  private readonly pool: mysql.Pool;
  private readonly isAdmin: (userId: string) => Promise<boolean>;
  private readonly observeClient: SpatialObserveClient;
  private readonly planClient: SpatialPlanClient;
  private readonly mathExecutor: SpatialMathExecutor;
  private readonly verifyClient: SpatialVerifyClient;
  private readonly blenderWorker: BlenderWorkerClient;
  private schedulerBusy = false;

  constructor(options: SpatialGeneratorOptions = {}) {
    this.pool = options.pool || getPool();
    this.repo = new SpatialGeneratorRepository(this.pool);
    this.isAdmin = options.isAdmin || isUserAdmin;

    // Use injected clients or create default ones (to be implemented)
    this.observeClient = options.observeClient || this.createDefaultObserveClient();
    this.planClient = options.planClient || this.createDefaultPlanClient();
    this.mathExecutor = options.mathExecutor || new DeterministicMathSolver();
    this.verifyClient = options.verifyClient || this.createDefaultVerifyClient();
    this.blenderWorker = options.blenderWorker || this.createDefaultBlenderWorker();
  }

  /**
   * Advance one durable attempt through the direct pipeline.  This is kept
   * deliberately small and bounded: leases in the repository remain the
   * concurrency/idempotency boundary, while each expensive provider/Blender
   * call happens outside a SQL transaction in the existing stage methods.
   */
  async runNextScheduledAttempt(): Promise<boolean> {
    if (this.schedulerBusy) return false;
    this.schedulerBusy = true;
    let conn: mysql.PoolConnection | null = null;
    try {
      conn = await this.pool.getConnection();
      const runnable = await this.repo.findRunnableAttempts(conn, 1);
      const next = runnable[0];
      if (!next) return false;

      switch (next.state) {
        case "queued":
          await this.observeAndPlan(next.job_id);
          break;
        case "awaiting_math":
          await this.executeMath(next.id);
          break;
        case "compiling":
        case "building_draft":
          await this.buildDraft(next.id);
          break;
        case "verifying_draft":
          await this.verifyDraft(next.id);
          break;
        case "finalizing":
          await this.finalizeJob(next.job_id);
          break;
        default:
          return false;
      }
      return true;
    } catch (error) {
      // Stage methods persist typed failure/refund state. Keep the scheduler
      // alive so one bad job cannot take down the web process.
      console.error("[spatial-scheduler] attempt failed:", error instanceof Error ? error.message : error);
      return true;
    } finally {
      conn?.release();
      this.schedulerBusy = false;
    }
  }

  // ─── Production Client Factories ─────────────────────────────────────────────

  private createDefaultObserveClient(): SpatialObserveClient {
    return {
      observe: async (input) => {
        try {
          return await observeReferences(input.referenceAssetVersionIds, input.scaleAnchor);
        } catch (error) {
          if (error instanceof SpatialGeneratorServiceError) throw error;
          throw new SpatialGeneratorServiceError(
            "OBSERVE_FAILED",
            `Observation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    };
  }

  private createDefaultPlanClient(): SpatialPlanClient {
    return {
      plan: async (input) => {
        try {
          return await generatePlan(
            input.observation,
            input.userPrompt,
            input.targetEnvelopeMm,
            input.scaleAnchor,
            input.attachmentInterface,
          );
        } catch (error) {
          if (error instanceof SpatialGeneratorServiceError) throw error;
          throw new SpatialGeneratorServiceError(
            "PLAN_FAILED",
            `Planning failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    };
  }

  private createDefaultVerifyClient(): SpatialVerifyClient {
    return {
      verify: async (input) => {
        try {
          return await verifyDraft(input.observation, input.draftRenderAssetVersions, input.attemptHash);
        } catch (error) {
          if (error instanceof SpatialGeneratorServiceError) throw error;
          throw new SpatialGeneratorServiceError(
            "VERIFY_FAILED",
            `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    };
  }

  private createDefaultBlenderWorker(): BlenderWorkerClient {
    const blenderClient = getBlenderClient();
    
    return {
      buildDraft: async (input) => {
        const { attemptId, plan, math, compiledProgramHash } = input;
        
        // Get job details for storage context
        const conn = await this.pool.getConnection();
        try {
          const attempt = await this.repo.getAttempt(conn, attemptId);
          if (!attempt) throw new Error(`Attempt ${attemptId} not found`);
          const job = await this.repo.getJobById(conn, attempt.job_id);
          if (!job) throw new Error(`Job ${attempt.job_id} not found`);
          
          // Compile the Blender program
          const { program, programHash } = compileBlenderProgram(plan, math, job.target_use);
          if (programHash !== compiledProgramHash) {
            throw new Error("Compiled program hash mismatch");
          }
          
          // Execute the Blender Python script via /execute endpoint
          const execResult = await blenderClient.executeCode(program);
          if (!execResult.success) {
            throw new Error(`Blender execution failed: ${execResult.error || execResult.stderr || "Unknown error"}`);
          }
          
          // Export the GLB
          const exportResult = await blenderClient.exportGlb();
          if (!exportResult.success || !exportResult.glb_base64) {
            throw new Error("GLB export failed");
          }
          
          const glbBuffer = Buffer.from(exportResult.glb_base64, "base64");
          
          // Validate the GLB
          const validation = await validateGlb(glbBuffer);
          if (validation.status === "fail") {
            throw new Error(`Draft GLB validation failed: ${validation.metrics.errors?.join(", ")}`);
          }
          
          // Validate against math bounds
          const boundsCheck = validateMathAgainstGlb(math, validation.metrics);
          if (!boundsCheck.pass) {
            throw new Error(`Bounds mismatch: ${boundsCheck.errors.join(", ")}`);
          }
          
          // Generate 5 standard renders using viewport endpoints
          const renderViews = [
            { name: "front", azimuth: 0, elevation: 0 },
            { name: "right", azimuth: 90, elevation: 0 },
            { name: "back", azimuth: 180, elevation: 0 },
            { name: "left", azimuth: 270, elevation: 0 },
            { name: "three_quarter", azimuth: 45, elevation: 30 },
          ] as const;
          
          const renderUploads: Awaited<ReturnType<typeof spatialStorage.uploadArtifact>>[] = [];
          
          for (const view of renderViews) {
            // Set camera angle
            await blenderClient.setViewportAngle(view.azimuth, view.elevation);
            
            // Render viewport
            const renderResult = await blenderClient.getViewport();
            if (!renderResult.success || !renderResult.image_base64) {
              throw new Error(`Render failed for ${view.name}: Viewport returned no image`);
            }
            
            const renderBuffer = Buffer.from(renderResult.image_base64, "base64");
            const uploadResult = await spatialStorage.uploadArtifact({
              buffer: renderBuffer,
              mimeType: "image/png",
              role: `draft_render_${view.name}` as SpatialArtifactRole,
              jobUuid: job.job_uuid,
              attemptNumber: attempt.attempt_number,
              ownerPhone: job.owner_phone,
            });
            renderUploads.push(uploadResult);
          }
          
          // Upload the draft GLB
          const glbUpload = await spatialStorage.uploadArtifact({
            buffer: glbBuffer,
            mimeType: "model/gltf-binary",
            role: "draft_glb",
            jobUuid: job.job_uuid,
            attemptNumber: attempt.attempt_number,
            ownerPhone: job.owner_phone,
          });
          
          // Persist artifact records in DB
          await conn.beginTransaction();
          try {
            // Draft GLB artifact
            await this.repo.createArtifact(conn, {
              attemptId,
              assetId: glbUpload.assetId,
              assetVersionId: glbUpload.assetVersionId,
              role: "draft_glb",
              computedHash: glbUpload.sha256,
              sizeBytes: glbUpload.sizeBytes,
              mimeType: glbUpload.mimeType,
            });
            
            // Render artifacts
            for (let i = 0; i < renderViews.length; i++) {
              const view = renderViews[i];
              const upload = renderUploads[i];
              await this.repo.createArtifact(conn, {
                attemptId,
                assetId: upload.assetId,
                assetVersionId: upload.assetVersionId,
                role: `draft_render_${view.name}` as SpatialArtifactRole,
                computedHash: upload.sha256,
                sizeBytes: upload.sizeBytes,
                mimeType: upload.mimeType,
              });
            }
            
            await conn.commit();
          } catch (e) {
            await conn.rollback();
            throw e;
          }
          
          return {
            draftGlbAssetVersionId: glbUpload.assetVersionId,
            renderAssetVersionIds: renderUploads.map((upload) => upload.assetVersionId),
            boundsMm: {
              min: validation.metrics.boundingBox?.min || [0, 0, 0],
              max: validation.metrics.boundingBox?.max || [0, 0, 0],
            },
          };
        } finally {
          conn.release();
        }
      },
      
      buildFinal: async (input) => {
        const { attemptId, plan, math, compiledProgramHash, targetUse } = input;
        
        const conn = await this.pool.getConnection();
        try {
          const attempt = await this.repo.getAttempt(conn, attemptId);
          if (!attempt) throw new Error(`Attempt ${attemptId} not found`);
          const job = await this.repo.getJobById(conn, attempt.job_id);
          if (!job) throw new Error(`Job ${attempt.job_id} not found`);
          
          // Compile the Blender program
          const { program, programHash } = compileBlenderProgram(plan, math, targetUse);
          if (programHash !== compiledProgramHash) {
            throw new Error("Compiled program hash mismatch");
          }
          
          // Execute the Blender program
          const execResult = await blenderClient.executeCode(program);
          if (!execResult.success) {
            throw new Error(`Blender execution failed: ${execResult.error || execResult.stderr || "Unknown error"}`);
          }
          
          // Export the GLB
          const exportResult = await blenderClient.exportGlb();
          if (!exportResult.success || !exportResult.glb_base64) {
            throw new Error("GLB export failed");
          }
          
          const glbBuffer = Buffer.from(exportResult.glb_base64, "base64");
          
          // Validate the GLB
          const validation = await validateGlb(glbBuffer);
          if (validation.status === "fail") {
            throw new Error(`Final GLB validation failed: ${validation.metrics.errors?.join(", ")}`);
          }
          
          // Validate against math bounds
          const boundsCheck = validateMathAgainstGlb(math, validation.metrics);
          if (!boundsCheck.pass) {
            throw new Error(`Bounds mismatch: ${boundsCheck.errors.join(", ")}`);
          }
          
          // Upload final GLB
          const glbUpload = await spatialStorage.uploadArtifact({
            buffer: glbBuffer,
            mimeType: "model/gltf-binary",
            role: "final_glb",
            jobUuid: job.job_uuid,
            attemptNumber: attempt.attempt_number,
            ownerPhone: job.owner_phone,
          });
          
          let finalStlAssetVersionId: number | undefined;
          let manufacturingReportAssetVersionId: number | undefined;
          
          // For print targets, also generate STL and manufacturing report
          if (targetUse === "print") {
            // Note: Worker doesn't have /export-stl endpoint yet
            // For now, skip STL generation
            // TODO: Add /export-stl endpoint to worker or implement STL export in Python script
            
            // Generate manufacturing report
            const report = {
              validatorVersion: "spatial-v1.0.0",
              targetUse: "print",
              glbValidation: validation.metrics,
              mathValidation: boundsCheck,
              wallThicknessChecks: [],
              clearanceChecks: [],
              scaleVerification: {
                expected: math.derived,
                actual: validation.metrics.dimensions,
              },
              generatedAt: new Date().toISOString(),
            };
            const reportBuffer = Buffer.from(JSON.stringify(report, null, 2));
            const reportUpload = await spatialStorage.uploadArtifact({
              buffer: reportBuffer,
              mimeType: "application/json",
              role: "manufacturing_report",
              jobUuid: job.job_uuid,
              attemptNumber: attempt.attempt_number,
              ownerPhone: job.owner_phone,
            });
            manufacturingReportAssetVersionId = reportUpload.assetVersionId;
          }
          
          return {
            finalGlbAssetVersionId: glbUpload.assetVersionId,
            finalStlAssetVersionId: finalStlAssetVersionId,
            manufacturingReportAssetVersionId,
            boundsMm: {
              min: validation.metrics.boundingBox?.min || [0, 0, 0],
              max: validation.metrics.boundingBox?.max || [0, 0, 0],
            },
          };
        } finally {
          conn.release();
        }
      },
    };
  }

  // ─── Quote / Preflight ─────────────────────────────────────────────────────

  async getQuote(ownerPhone: string, input: QuoteSpatialJobInput): Promise<SpatialQuotePublic> {
    assertInhouseSpatialGeneratorEnabled();

    const preflight = await this.preflight(ownerPhone, input);
    const currentBalance = await this.getCreditBalance(ownerPhone);

    return {
      subjectKind: input.subjectKind,
      targetUse: input.targetUse,
      estimatedCredits: preflight.quotedCredits,
      currentBalance,
      sufficientBalance: currentBalance >= preflight.quotedCredits,
      preflightPassed: preflight.passed,
      preflightErrors: preflight.errors,
    };
  }

  async preflight(ownerPhone: string, input: QuoteSpatialJobInput): Promise<SpatialPreflightResult> {
    const errors: string[] = [];

    // Validate envelope dimensions
    if (input.targetEnvelopeMm.x > 5000 || input.targetEnvelopeMm.y > 5000 || input.targetEnvelopeMm.z > 5000) {
      errors.push("Envelope dimensions exceed 5000 mm limit");
    }

    // Validate reference assets exist and are owned
    if (input.referenceAssetVersionIds.length > 0) {
      const valid = await this.validateReferenceAssets(ownerPhone, input.referenceAssetVersionIds);
      if (!valid) errors.push("One or more reference assets not found or not owned");
    }

    // Scale anchor required when references present
    if (input.referenceAssetVersionIds.length > 0 && !input.scaleAnchor) {
      errors.push("Scale anchor is required when reference images are provided");
    }

    // Attachment interface required for attachment use
    if (input.targetUse === "attachment" && !input.attachment) {
      errors.push("Attachment interface required for attachment use");
    }

    // Calculate credits (simplified - will be refined)
    const baseCredits = 50;
    const viewMultiplier = Math.max(1, input.referenceAssetVersionIds.length);
    const quotedCredits = baseCredits * viewMultiplier;

    return {
      passed: errors.length === 0,
      errors,
      quotedCredits,
      pricingKey: `spatial_${input.subjectKind}_${input.targetUse}`,
      currentBalance: await this.getCreditBalance(ownerPhone),
    };
  }

  private async validateReferenceAssets(ownerPhone: string, assetVersionIds: number[]): Promise<boolean> {
    // Use canonical asset registry to verify ownership
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) as count FROM asset_versions av
       JOIN assets a ON a.id = av.asset_id
       WHERE av.id IN (${assetVersionIds.map(() => "?").join(",")}) AND a.owner_id = ?`,
      [...assetVersionIds, ownerPhone],
    );
    return (rows as any[])[0]?.count === assetVersionIds.length;
  }

  private async getCreditBalance(ownerPhone: string): Promise<number> {
    const [rows] = await this.pool.query(
      "SELECT credits FROM users WHERE phone = ?",
      [ownerPhone],
    );
    return (rows as any[])[0]?.credits || 0;
  }

  // ─── Job Lifecycle ─────────────────────────────────────────────────────────

  async startJob(ownerPhone: string, input: CreateSpatialJobInput): Promise<SpatialJobPublic> {
    assertInhouseSpatialGeneratorEnabled();

    const preflight = await this.preflight(ownerPhone, {
      subjectKind: input.subjectKind,
      targetUse: input.targetUse,
      targetEnvelopeMm: input.targetEnvelopeMm,
      referenceAssetVersionIds: input.referenceAssetVersionIds,
      scaleAnchor: input.scaleAnchor,
      attachment: input.attachment,
    });

    if (!preflight.passed) {
      throw new SpatialGeneratorServiceError("PREFLIGHT_FAILED", preflight.errors.join("; "));
    }

    const currentBalance = await this.getCreditBalance(ownerPhone);
    if (currentBalance < preflight.quotedCredits) {
      throw new SpatialGeneratorServiceError("INSUFFICIENT_CREDITS", "Insufficient credits for this job");
    }

    // Check idempotency
    const idempotencyConn = await this.pool.getConnection();
    try {
      const existing = await this.repo.getJobByOwnerAndIdempotency(
        idempotencyConn,
        ownerPhone,
        input.idempotencyKey,
      );
      if (existing) {
        return this.toJobPublic(existing);
      }
    } finally {
      idempotencyConn.release();
    }

    const jobUuid = crypto.randomUUID();
    const inputHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");

    let health: Awaited<ReturnType<SpatialGeneratorService["getHealthStatus"]>>;
    try {
      health = await this.getHealthStatus();
    } catch {
      throw new SpatialGeneratorServiceError(
        "SPATIAL_PIPELINE_NOT_READY",
        "Spatial generation is temporarily unavailable.",
      );
    }
    if (
      health.ready !== true
      || health.featureEnabled !== true
      || health.layer8Configured !== true
      || health.pixelWorkerOnline !== true
      || health.blenderWorkerHealthy !== true
      || health.orchestratorReady !== true
      || !Array.isArray(health.blockers)
      || health.blockers.length > 0
    ) {
      throw new SpatialGeneratorServiceError(
        "SPATIAL_PIPELINE_NOT_READY",
        "Spatial generation is temporarily unavailable.",
      );
    }

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const jobId = await this.repo.createJob(conn, {
        jobUuid,
        ownerPhone,
        subjectKind: input.subjectKind,
        targetUse: input.targetUse,
        idempotencyKey: input.idempotencyKey,
        creditsReserved: preflight.quotedCredits,
      });

      await this.repo.createJobInputs(conn, {
        jobId,
        prompt: input.prompt,
        targetEnvelopeMm: input.targetEnvelopeMm,
        scaleAnchor: input.scaleAnchor,
        attachmentInterface: input.attachment,
        referenceAssetVersionIds: input.referenceAssetVersionIds,
        inputHash,
      });

      // Reserve credits
      await conn.query(
        "UPDATE users SET credits = credits - ? WHERE phone = ?",
        [preflight.quotedCredits, ownerPhone],
      );

      await this.repo.logEvent(conn, {
        jobId,
        attemptId: null,
        eventType: "job_created",
        payload: { jobUuid, subjectKind: input.subjectKind, targetUse: input.targetUse, creditsReserved: preflight.quotedCredits },
      });

      // Create initial attempt
      const attemptId = await this.repo.createAttempt(conn, {
        jobId,
        attemptNumber: 1,
        idempotencyKey: crypto.randomUUID(),
      });

      await this.repo.updateJobState(conn, jobId, "draft", { currentAttemptId: attemptId });

      await conn.commit();

      return this.getJobDetail(ownerPhone, jobUuid);
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async getJobDetail(ownerPhone: string, jobUuid: string): Promise<SpatialJobPublic> {
    const conn = await this.pool.getConnection();
    try {
      const job = await this.repo.getJobByUuid(conn, jobUuid);
      if (!job) {
        throw new SpatialGeneratorServiceError("NOT_FOUND", "Job not found");
      }
      if (job.owner_phone !== ownerPhone) {
        const isAdmin = await this.isAdmin(ownerPhone);
        if (!isAdmin) throw new SpatialGeneratorServiceError("FORBIDDEN", "Not authorized");
      }
      return this.toJobPublic(job);
    } finally {
      conn.release();
    }
  }

  async listJobs(ownerPhone: string, limit = 50, offset = 0): Promise<SpatialJobPublic[]> {
    const conn = await this.pool.getConnection();
    try {
      const jobs = await this.repo.listJobsByOwner(conn, ownerPhone, limit, offset);
      return jobs.map((j) => this.toJobPublic(j));
    } finally {
      conn.release();
    }
  }

  async retryJob(ownerPhone: string, jobUuid: string, input: RetrySpatialJobInput): Promise<SpatialJobPublic> {
    assertInhouseSpatialGeneratorEnabled();

    const conn = await this.pool.getConnection();
    try {
      const job = await this.repo.getJobByUuid(conn, jobUuid);
      if (!job) throw new SpatialGeneratorServiceError("NOT_FOUND", "Job not found");
      if (job.owner_phone !== ownerPhone) {
        const isAdmin = await this.isAdmin(ownerPhone);
        if (!isAdmin) throw new SpatialGeneratorServiceError("FORBIDDEN", "Not authorized");
      }

      // Check if job is in a retryable state
      if (job.state !== "awaiting_human_review" && job.state !== "correction_requested") {
        throw new SpatialGeneratorServiceError("INVALID_STATE", "Job cannot be retried from current state");
      }

      // Check attempt count
      const attempts = await this.repo.listAttemptsByJob(conn, job.id);
      if (attempts.length >= MAX_CORRECTION_ATTEMPTS + 1) {
        throw new SpatialGeneratorServiceError("MAX_RETRIES_EXCEEDED", "Maximum correction attempts exceeded");
      }

      await conn.beginTransaction();

      // Create new attempt
      const nextAttemptNumber = attempts.length + 1;
      const idempotencyKey = crypto.randomUUID();
      const attemptId = await this.repo.createAttempt(conn, {
        jobId: job.id,
        attemptNumber: nextAttemptNumber,
        idempotencyKey,
      });

      // Update job state
      await this.repo.updateJobState(conn, job.id, "correction_requested", {
        currentAttemptId: attemptId,
      });

      // Log event
      await this.repo.logEvent(conn, {
        jobId: job.id,
        attemptId,
        eventType: "correction_requested",
        payload: { attemptNumber: nextAttemptNumber, correctionTags: input.correctionTags, comment: input.correctionComment },
      });

      await conn.commit();

      return this.getJobDetail(ownerPhone, jobUuid);
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async cancelJob(ownerPhone: string, jobUuid: string, reason?: string): Promise<SpatialJobPublic> {
    const conn = await this.pool.getConnection();
    try {
      const job = await this.repo.getJobByUuid(conn, jobUuid);
      if (!job) throw new SpatialGeneratorServiceError("NOT_FOUND", "Job not found");
      if (job.owner_phone !== ownerPhone) {
        const isAdmin = await this.isAdmin(ownerPhone);
        if (!isAdmin) throw new SpatialGeneratorServiceError("FORBIDDEN", "Not authorized");
      }

      // Can only cancel before finalization
      if (["completed", "failed", "cancelled"].includes(job.state)) {
        throw new SpatialGeneratorServiceError("INVALID_STATE", "Job cannot be cancelled");
      }

      await conn.beginTransaction();

      // Release credits if still reserved
      if (job.credits_disposition === "reserved") {
        await conn.query("UPDATE users SET credits = credits + ? WHERE phone = ?", [job.credits_reserved, ownerPhone]);
        await this.repo.refundCredits(conn, job.id);
      }

      // Release any active lease
      const currentAttempt = await this.repo.getCurrentAttempt(conn, job.id);
      if (currentAttempt) {
        await this.repo.releaseLease(conn, currentAttempt.id, currentAttempt.lease_owner || "");
      }

      await this.repo.updateJobState(conn, job.id, "cancelled");

      await this.repo.logEvent(conn, {
        jobId: job.id,
        attemptId: currentAttempt?.id || null,
        eventType: "job_cancelled",
        payload: { jobUuid },
      });

      await conn.commit();

      return this.getJobDetail(ownerPhone, jobUuid);
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async reviewJob(ownerPhone: string, jobUuid: string, input: ReviewSpatialJobInput): Promise<SpatialJobPublic> {
    assertInhouseSpatialGeneratorEnabled();

    const conn = await this.pool.getConnection();
    try {
      const job = await this.repo.getJobByUuid(conn, jobUuid);
      if (!job) throw new SpatialGeneratorServiceError("NOT_FOUND", "Job not found");
      if (job.owner_phone !== ownerPhone) {
        const isAdmin = await this.isAdmin(ownerPhone);
        if (!isAdmin) throw new SpatialGeneratorServiceError("FORBIDDEN", "Not authorized");
      }

      // Verify job is in awaiting_human_review state
      if (job.state !== "awaiting_human_review") {
        throw new SpatialGeneratorServiceError("INVALID_STATE", "Job is not awaiting review");
      }

      const currentAttempt = await this.repo.getCurrentAttempt(conn, job.id);
      if (!currentAttempt) throw new SpatialGeneratorServiceError("NOT_FOUND", "No current attempt");

      // Verify attempt hash matches
      const attemptHash = this.computeAttemptHash(currentAttempt);
      if (attemptHash !== input.attemptHash) {
        throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Attempt hash does not match current attempt");
      }

      // Verify report hash matches
      if (currentAttempt.automated_report_hash !== input.reportHash) {
        throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Report hash does not match current report");
      }

      // Check automated pass
      if (!currentAttempt.automated_report_json) {
        throw new SpatialGeneratorServiceError("INVALID_STATE", "No automated report available");
      }
      const automatedReport = SpatialVerifyOutputSchema.parse(currentAttempt.automated_report_json);
      if (!automatedReport.automatedPass) {
        throw new SpatialGeneratorServiceError("AUTOMATED_REVIEW_FAILED", "Automated review did not pass");
      }

      await conn.beginTransaction();

      // Create review record
      const actorAuditHash = crypto.createHash("sha256").update(`${ownerPhone}:${Date.now()}`).digest("hex");
      await this.repo.createReview(conn, {
        jobId: job.id,
        attemptId: currentAttempt.id,
        attemptHash,
        reportHash: input.reportHash,
        ownerPhone,
        decision: input.decision,
        correctionTags: input.correctionTags,
        comment: input.comment,
        actorAuditHash,
      });

      if (input.decision === "approve") {
        // Move to finalizing
        await this.repo.updateJobState(conn, job.id, "finalizing");
        await this.repo.logEvent(conn, {
          jobId: job.id,
          attemptId: currentAttempt.id,
          eventType: "approved",
          payload: { attemptNumber: currentAttempt.attempt_number },
        });

        // Trigger final build (async - will be picked up by worker)
        // For now, just log the event
      } else {
        // Request correction - check if we can create another attempt
        const attempts = await this.repo.listAttemptsByJob(conn, job.id);
        if (attempts.length >= MAX_CORRECTION_ATTEMPTS + 1) {
          throw new SpatialGeneratorServiceError("MAX_RETRIES_EXCEEDED", "Maximum correction attempts exceeded");
        }

        await this.repo.updateJobState(conn, job.id, "correction_requested");
        await this.repo.logEvent(conn, {
          jobId: job.id,
          attemptId: currentAttempt.id,
          eventType: "correction_requested",
          payload: { correctionTags: input.correctionTags, comment: input.comment },
        });
      }

      await conn.commit();

      return this.getJobDetail(ownerPhone, jobUuid);
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  // ─── Internal Pipeline Operations (called by workers) ──────────────────────

  async observeAndPlan(jobId: number): Promise<void> {
    const conn = await this.pool.getConnection();
    let leaseOwner: string | null = null;
    let currentAttempt: any = null;
    try {
      await conn.beginTransaction();
      
      const job = await this.repo.getJobById(conn, jobId);
      if (!job) throw new SpatialGeneratorServiceError("NOT_FOUND", "Job not found");
      
      currentAttempt = await this.repo.getCurrentAttempt(conn, jobId);
      if (!currentAttempt) throw new SpatialGeneratorServiceError("NO_ATTEMPT", "No current attempt found");
      
      // Verify attempt is in a valid state for observeAndPlan
      if (currentAttempt.state !== "queued" && currentAttempt.state !== "observing") {
        throw new SpatialGeneratorServiceError("INVALID_STATE", `Attempt in invalid state: ${currentAttempt.state}`);
      }
      
      // Acquire lease
      leaseOwner = `worker-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const leaseExpiresAt = new Date(Date.now() + DEFAULT_LEASE_DURATION_MS);
      
      await this.repo.updateAttemptState(conn, currentAttempt.id, "observing", {
        leaseOwner,
        leaseExpiresAt,
        startedAt: new Date(),
      });
      
      await this.repo.updateJobState(conn, jobId, "observing", { currentAttemptId: currentAttempt.id });
      await this.repo.logEvent(conn, {
        jobId,
        attemptId: currentAttempt.id,
        eventType: "observation_started",
        payload: { attemptNumber: currentAttempt.attempt_number },
      });
      
      await conn.commit();
      
      // --- Outside transaction: Load reference assets and call Layer8 ---
      const jobInputs = await this.repo.getJobInputs(conn, jobId);
      if (!jobInputs) throw new SpatialGeneratorServiceError("NO_INPUTS", "Job inputs not found");
      
      // Call Layer8 observation
      const observation = await this.observeClient.observe({
        referenceAssetVersionIds: jobInputs.reference_asset_version_ids,
        scaleAnchor: jobInputs.scale_anchor,
      });
      
      // Validate observation output
      const { SpatialObserveOutputSchema } = await import("./schemas");
      const parsedObservation = SpatialObserveOutputSchema.parse(observation);
      
      // Canonicalize and hash (EXCLUDE the observationHash field from hashing)
      const { observationHash: _unused, ...observationForHash } = parsedObservation;
      const observationJson = JSON.stringify(observationForHash);
      const observationHash = crypto.createHash("sha256").update(observationJson).digest("hex");
      
      // Verify hash matches (provider computed hash on same canonical data)
      if (observation.observationHash !== observationHash) {
        throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Observation hash does not match computed hash");
      }
      
      // Persist observation with expected-state protection
      await conn.beginTransaction();
      
      // Re-verify state before persisting
      const attemptCheck = await this.repo.getAttempt(conn, currentAttempt.id);
      if (!attemptCheck || attemptCheck.lease_owner !== leaseOwner || attemptCheck.state !== "observing") {
        throw new SpatialGeneratorServiceError("LEASE_LOST", "Lease lost or state changed during observation");
      }
      
      await this.repo.updateAttemptState(conn, currentAttempt.id, "planning", {
        observationJson: parsedObservation,
        observationHash,
      });
      
      await this.repo.updateJobState(conn, jobId, "planning");
      await this.repo.logEvent(conn, {
        jobId,
        attemptId: currentAttempt.id,
        eventType: "observation_completed",
        payload: { observationHash, attemptNumber: currentAttempt.attempt_number },
      });
      
      await conn.commit();
      
      // --- Planning phase ---
      await conn.beginTransaction();
      
      await this.repo.updateAttemptState(conn, currentAttempt.id, "planning", {
        leaseOwner,
        leaseExpiresAt: new Date(Date.now() + DEFAULT_LEASE_DURATION_MS),
      });
      
      await conn.commit();
      
      // Call Layer8 planning
      const plan = await this.planClient.plan({
        observation: parsedObservation,
        userPrompt: jobInputs.prompt,
        targetEnvelopeMm: jobInputs.target_envelope_mm as { x: number; y: number; z: number },
        scaleAnchor: jobInputs.scale_anchor as { axis: "x" | "y" | "z"; millimeters: number; label: string } | null,
        attachmentInterface: jobInputs.attachment_interface as { targetAssetVersionId: number; clearanceMm: number } | null,
      });
      
      // Validate plan through strict schema
      const { SpatialPlanSchema } = await import("./schemas");
      const parsedPlan = SpatialPlanSchema.parse(plan);
      
      // Verify plan hash matches - hash the plan WITHOUT the planHash field
      const { planHash: _, ...planWithoutHash } = parsedPlan;
      const planJson = JSON.stringify(planWithoutHash);
      const planHash = crypto.createHash("sha256").update(planJson).digest("hex");
      
      if (plan.planHash !== planHash) {
        throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Plan hash does not match computed hash");
      }
      
      // Reject unsupported primitives/operations
      for (const prim of parsedPlan.primitives) {
        if (!["box", "cylinder", "uv_sphere", "cone", "torus", "capsule"].includes(prim.type)) {
          throw new SpatialGeneratorServiceError("UNSUPPORTED_PRIMITIVE", `Unsupported primitive type: ${prim.type}`);
        }
        if (!["additive", "subtractive"].includes(prim.role)) {
          throw new SpatialGeneratorServiceError("UNSUPPORTED_ROLE", `Unsupported primitive role: ${prim.role}`);
        }
      }
      
      // Persist plan
      await conn.beginTransaction();
      
      const attemptCheck2 = await this.repo.getAttempt(conn, currentAttempt.id);
      if (!attemptCheck2 || attemptCheck2.lease_owner !== leaseOwner || attemptCheck2.state !== "planning") {
        throw new SpatialGeneratorServiceError("LEASE_LOST", "Lease lost or state changed during planning");
      }
      
      await this.repo.updateAttemptState(conn, currentAttempt.id, "awaiting_math", {
        planJson: parsedPlan,
        planHash,
      });
      
      await this.repo.updateJobState(conn, jobId, "awaiting_math_worker");
      await this.repo.logEvent(conn, {
        jobId,
        attemptId: currentAttempt.id,
        eventType: "planning_completed",
        payload: { planHash, primitiveCount: parsedPlan.primitives.length, attemptNumber: currentAttempt.attempt_number },
      });
      
      await conn.commit();
      
      // Release lease - math will acquire its own
      await conn.beginTransaction();
      await this.repo.releaseLease(conn, currentAttempt.id, leaseOwner);
      await conn.commit();
      
    } catch (error) {
      if (conn) {
        try { await conn.rollback(); } catch {}
      }
      // If we have a lease and an attempt, mark as failed
      if (leaseOwner && currentAttempt) {
        const failConn = await this.pool.getConnection();
        try {
          await failConn.beginTransaction();
          await this.repo.updateAttemptState(failConn, currentAttempt.id, "failed", {
            failureCode: error instanceof SpatialGeneratorServiceError ? error.code : "OBSERVE_PLAN_FAILED",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          await this.repo.releaseLease(failConn, currentAttempt.id, leaseOwner);
          await failConn.commit();
        } catch {}
        finally { failConn.release(); }
      }
      throw error;
    } finally {
      if (conn) conn.release();
    }
  }

  async executeMath(attemptId: number): Promise<void> {
    const conn = await this.pool.getConnection();
    let leaseOwner: string | null = null;
    try {
      await conn.beginTransaction();
      
      const attempt = await this.repo.getAttempt(conn, attemptId);
      if (!attempt) throw new SpatialGeneratorServiceError("NOT_FOUND", "Attempt not found");
      
      const job = await this.repo.getJobById(conn, attempt.job_id);
      if (!job) throw new SpatialGeneratorServiceError("NOT_FOUND", "Job not found");
      
      // Verify attempt is in valid state
      if (attempt.state !== "awaiting_math" && attempt.state !== "validating_math") {
        throw new SpatialGeneratorServiceError("INVALID_STATE", `Attempt in invalid state: ${attempt.state}`);
      }
      
      // Acquire lease
      leaseOwner = `worker-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const leaseExpiresAt = new Date(Date.now() + DEFAULT_LEASE_DURATION_MS);
      
      await this.repo.updateAttemptState(conn, attemptId, "validating_math", {
        leaseOwner,
        leaseExpiresAt,
        startedAt: new Date(),
      });
      
      await this.repo.updateJobState(conn, job.id, "validating_math");
      await this.repo.logEvent(conn, {
        jobId: job.id,
        attemptId,
        eventType: "math_started",
        payload: { attemptNumber: attempt.attempt_number },
      });
      
      await conn.commit();
      
      // Load the exact stored plan
      if (!attempt.plan_json || !attempt.plan_hash) {
        throw new SpatialGeneratorServiceError("MISSING_PLAN", "Plan not found on attempt");
      }
      
      const { SpatialPlanSchema } = await import("./schemas");
      const plan = SpatialPlanSchema.parse(attempt.plan_json);
      
      // Verify plan hash
      const planJson = JSON.stringify(plan);
      const recomputedPlanHash = crypto.createHash("sha256").update(planJson).digest("hex");
      if (recomputedPlanHash !== attempt.plan_hash) {
        throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Stored plan hash does not match recomputed hash");
      }
      
      // Build SpatialMathInput from trusted stored data
      const mathInput: SpatialMathInput = {
        planHash: attempt.plan_hash,
        envelopeMm: plan.targetEnvelopeMm,
        minimumWallMm: Math.max(...plan.primitives.map(p => p.constraints.minimumWallMm)),
        primitives: plan.primitives,
        constraints: plan.primitives.map(p => p.constraints),
      };
      
      // Execute deterministic math
      const mathOutput = await this.mathExecutor.execute(mathInput);
      
      // Validate output schema
      const { SpatialMathOutputSchema } = await import("./schemas");
      const parsedMath = SpatialMathOutputSchema.parse(mathOutput);
      
      // Confirm planHash matches
      if (parsedMath.planHash !== attempt.plan_hash) {
        throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Math output planHash does not match plan hash");
      }
      
      // Enforce finite numbers, envelope, primitive count, wall, clearance, coordinate limits
      for (const prim of parsedMath.resolvedPrimitives) {
        const dims = [prim.dimensionsMm.x, prim.dimensionsMm.y, prim.dimensionsMm.z];
        for (const dim of dims) {
          if (!Number.isFinite(dim) || dim < MATH_LIMITS.MIN_DIMENSION_MM || dim > MATH_LIMITS.MAX_DIMENSION_MM) {
            throw new SpatialGeneratorServiceError("DIMENSION_OUT_OF_BOUNDS", `Primitive ${prim.id}: dimension ${dim}mm out of bounds`);
          }
        }
        const coords = [prim.positionMm.x, prim.positionMm.y, prim.positionMm.z];
        for (const coord of coords) {
          if (!Number.isFinite(coord) || Math.abs(coord) > MATH_LIMITS.MAX_COORDINATE_MM) {
            throw new SpatialGeneratorServiceError("COORDINATE_OUT_OF_BOUNDS", `Primitive ${prim.id}: coordinate ${coord}mm exceeds limit`);
          }
        }
        const rots = [prim.rotationDeg.x, prim.rotationDeg.y, prim.rotationDeg.z];
        for (const rot of rots) {
          if (!Number.isFinite(rot) || Math.abs(rot) > 360) {
            throw new SpatialGeneratorServiceError("INVALID_ROTATION", `Primitive ${prim.id}: invalid rotation ${rot}°`);
          }
        }
      }
      
      // Check primitive count
      if (parsedMath.resolvedPrimitives.length > MATH_LIMITS.MAX_PRIMITIVES) {
        throw new SpatialGeneratorServiceError("TOO_MANY_PRIMITIVES", `Primitive count ${parsedMath.resolvedPrimitives.length} exceeds limit ${MATH_LIMITS.MAX_PRIMITIVES}`);
      }
      
      // Canonicalize and hash math output (mathHash is not part of the parsed object)
      const mathJson = JSON.stringify(parsedMath);
      const mathHash = crypto.createHash("sha256").update(mathJson).digest("hex");
      
      // Persist math output
      await conn.beginTransaction();
      
      const attemptCheck = await this.repo.getAttempt(conn, attemptId);
      if (!attemptCheck || attemptCheck.lease_owner !== leaseOwner || attemptCheck.state !== "validating_math") {
        throw new SpatialGeneratorServiceError("LEASE_LOST", "Lease lost or state changed during math execution");
      }
      
      await this.repo.updateAttemptState(conn, attemptId, "compiling", {
        mathJson: parsedMath,
        mathHash,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      
      await this.repo.logEvent(conn, {
        jobId: job.id,
        attemptId,
        eventType: "math_completed",
        payload: { mathHash, volumeMm3: parsedMath.derived.estimatedVolumeMm3, attemptNumber: attempt.attempt_number },
      });
      
      await conn.commit();
      
    } catch (error) {
      if (conn) {
        try { await conn.rollback(); } catch {}
      }
      if (leaseOwner) {
        const failConn = await this.pool.getConnection();
        try {
          await failConn.beginTransaction();
          await this.repo.updateAttemptState(failConn, attemptId, "failed", {
            failureCode: error instanceof SpatialGeneratorServiceError ? error.code : "MATH_FAILED",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          await this.repo.releaseLease(failConn, attemptId, leaseOwner);
          await failConn.commit();
        } catch {}
        finally { failConn.release(); }
      }
      throw error;
    } finally {
      if (conn) conn.release();
    }
  }

  async buildDraft(attemptId: number): Promise<void> {
    const conn = await this.pool.getConnection();
    let leaseOwner: string | null = null;
    try {
      await conn.beginTransaction();
      
      const attempt = await this.repo.getAttempt(conn, attemptId);
      if (!attempt) throw new SpatialGeneratorServiceError("NOT_FOUND", "Attempt not found");
      
      const job = await this.repo.getJobById(conn, attempt.job_id);
      if (!job) throw new SpatialGeneratorServiceError("NOT_FOUND", "Job not found");
      
      if (attempt.state !== "compiling" && attempt.state !== "building_draft") {
        throw new SpatialGeneratorServiceError("INVALID_STATE", `Attempt in invalid state: ${attempt.state}`);
      }
      
      if (!attempt.plan_json || !attempt.plan_hash || !attempt.math_json || !attempt.math_hash) {
        throw new SpatialGeneratorServiceError("MISSING_DATA", "Plan or math not available");
      }
      
      // Acquire lease
      leaseOwner = `worker-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const leaseExpiresAt = new Date(Date.now() + DEFAULT_LEASE_DURATION_MS);
      
      await this.repo.updateAttemptState(conn, attemptId, "building_draft", {
        leaseOwner,
        leaseExpiresAt,
        startedAt: new Date(),
      });
      
      await this.repo.updateJobState(conn, job.id, "building_draft");
      await this.repo.logEvent(conn, {
        jobId: job.id,
        attemptId,
        eventType: "draft_build_started",
        payload: { attemptNumber: attempt.attempt_number },
      });
      
      await conn.commit();
      
      // Parse stored plan and math
      const { SpatialPlanSchema, SpatialMathOutputSchema } = await import("./schemas");
      const plan = SpatialPlanSchema.parse(attempt.plan_json);
      const math = SpatialMathOutputSchema.parse(attempt.math_json);
      
      // Verify plan/math hashes
      if (plan.planHash !== attempt.plan_hash) throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Plan hash mismatch");
      if (math.planHash !== attempt.plan_hash) throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Math planHash mismatch");
      if (math.schemaVersion !== "pawsome.spatial-math.v1") throw new SpatialGeneratorServiceError("SCHEMA_VERSION", "Invalid math schema version");
      
      // Compile Blender program
      const { program, programHash } = compileBlenderProgram(plan, math, job.target_use);
      
      // Call Blender worker
      const result = await this.blenderWorker.buildDraft({
        attemptId,
        plan,
        math,
        compiledProgramHash: programHash,
      });
      
      // Verify all 5 renders + draft GLB exist
      if (!result.draftGlbAssetVersionId || !result.renderAssetVersionIds || result.renderAssetVersionIds.length !== 5) {
        throw new SpatialGeneratorServiceError("MISSING_ARTIFACTS", "Draft build did not produce all required artifacts (1 GLB + 5 renders)");
      }
      
      // Persist artifacts and hashes
      await conn.beginTransaction();
      
      const attemptCheck = await this.repo.getAttempt(conn, attemptId);
      if (!attemptCheck || attemptCheck.lease_owner !== leaseOwner || attemptCheck.state !== "building_draft") {
        throw new SpatialGeneratorServiceError("LEASE_LOST", "Lease lost or state changed during draft build");
      }
      
      await this.repo.updateAttemptState(conn, attemptId, "verifying_draft", {
        compiledProgramHash: programHash,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      
      await this.repo.updateJobState(conn, job.id, "verifying_draft");
      await this.repo.logEvent(conn, {
        jobId: job.id,
        attemptId,
        eventType: "draft_build_completed",
        payload: {
          draftGlbAssetVersionId: result.draftGlbAssetVersionId,
          renderAssetVersionIds: result.renderAssetVersionIds,
          boundsMm: result.boundsMm,
          attemptNumber: attempt.attempt_number,
        },
      });
      
      await conn.commit();
      
    } catch (error) {
      if (conn) {
        try { await conn.rollback(); } catch {}
      }
      if (leaseOwner) {
        const failConn = await this.pool.getConnection();
        try {
          await failConn.beginTransaction();
          await this.repo.updateAttemptState(failConn, attemptId, "failed", {
            failureCode: error instanceof SpatialGeneratorServiceError ? error.code : "DRAFT_BUILD_FAILED",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          await this.repo.releaseLease(failConn, attemptId, leaseOwner);
          await failConn.commit();
        } catch {}
        finally { failConn.release(); }
      }
      throw error;
    } finally {
      if (conn) conn.release();
    }
  }

  async verifyDraft(attemptId: number): Promise<void> {
    const conn = await this.pool.getConnection();
    let leaseOwner: string | null = null;
    try {
      await conn.beginTransaction();
      
      const attempt = await this.repo.getAttempt(conn, attemptId);
      if (!attempt) throw new SpatialGeneratorServiceError("NOT_FOUND", "Attempt not found");
      
      const job = await this.repo.getJobById(conn, attempt.job_id);
      if (!job) throw new SpatialGeneratorServiceError("NOT_FOUND", "Job not found");
      
      if (attempt.state !== "verifying_draft") {
        throw new SpatialGeneratorServiceError("INVALID_STATE", `Attempt in invalid state: ${attempt.state}`);
      }
      
      // Acquire lease
      leaseOwner = `worker-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const leaseExpiresAt = new Date(Date.now() + DEFAULT_LEASE_DURATION_MS);
      
      await this.repo.updateAttemptState(conn, attemptId, "verifying_draft", {
        leaseOwner,
        leaseExpiresAt,
      });
      
      await this.repo.logEvent(conn, {
        jobId: job.id,
        attemptId,
        eventType: "verification_started",
        payload: { attemptNumber: attempt.attempt_number },
      });
      
      await conn.commit();
      
      // --- Deterministic validation checks ---
      const artifacts = await this.repo.getArtifactsByAttempt(conn, attemptId);
      
      // 1. Required artifact completeness
      const requiredRoles: SpatialArtifactRole[] = [
        "draft_glb",
        "draft_render_front",
        "draft_render_right",
        "draft_render_back",
        "draft_render_left",
        "draft_render_three_quarter",
      ];
      
      for (const role of requiredRoles) {
        const artifact = artifacts.find(a => a.role === role);
        if (!artifact) {
          throw new SpatialGeneratorServiceError("MISSING_ARTIFACT", `Missing required artifact: ${role}`);
        }
      }
      
      // 2. GLB reopen success and validation
      const draftGlbArtifact = artifacts.find(a => a.role === "draft_glb")!;
      // Note: We'd need to download from storage to validate - for now trust storage validation
      // In production, fetch and run validateGlb()
      
      // 3. Schema validity of plan, math, compiled program
      const { SpatialPlanSchema, SpatialMathOutputSchema } = await import("./schemas");
      if (attempt.plan_json) SpatialPlanSchema.parse(attempt.plan_json);
      if (attempt.math_json) SpatialMathOutputSchema.parse(attempt.math_json);
      
      // 4. Hash agreement checks
      if (attempt.plan_hash && attempt.math_json) {
        const math = SpatialMathOutputSchema.parse(attempt.math_json);
        if (math.planHash !== attempt.plan_hash) {
          throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Math planHash does not match plan hash");
        }
      }
      
      // 5. Primitive and polygon limits (would need GLB reopen)
      // 6. Manifold/topology, degenerate triangles, normals, self-intersection
      // 7. Wall thickness, clearance, scale/unit consistency
      // 8. No forbidden external references
      
      // If all deterministic checks pass, proceed to AI verification
      
      // Load observation
      if (!attempt.observation_json || !attempt.observation_hash) {
        throw new SpatialGeneratorServiceError("MISSING_OBSERVATION", "Observation not available for verification");
      }
      const observation = attempt.observation_json as any;
      
      // Get draft render asset versions
      const renderAssets = artifacts
        .filter(a => a.role.startsWith("draft_render_"))
        .map(a => a.asset_version_id);
      
      if (renderAssets.length !== 5) {
        throw new SpatialGeneratorServiceError("INCOMPLETE_RENDERS", "Expected 5 draft render views");
      }
      
      // Compute attempt hash
      const attemptHash = this.computeAttemptHash(attempt);
      
      // Call Layer8 verification
      const verification = await this.verifyClient.verify({
        observation,
        draftRenderAssetVersions: renderAssets,
        attemptHash,
      });
      
      // Parse through schema
      const { SpatialVerifyOutputSchema } = await import("./schemas");
      const parsedVerification = SpatialVerifyOutputSchema.parse(verification);
      
      // Require explicit per-view evidence and meaningful failure/correction tags
      if (!parsedVerification.automatedPass) {
        // Check for critical issues with evidence
        if (!parsedVerification.criticalIssues || parsedVerification.criticalIssues.length === 0) {
          throw new SpatialGeneratorServiceError("VERIFICATION_INCOMPLETE", "Automated verification failed but no critical issues reported");
        }
      }
      
      // Canonicalize and hash the automated report
      const reportJson = JSON.stringify(parsedVerification);
      const reportHash = crypto.createHash("sha256").update(reportJson).digest("hex");
      
      if (parsedVerification.reportHash !== reportHash) {
        throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Verification report hash mismatch");
      }
      
      // Bind report to attempt hash and render manifest hash
      const renderManifestHash = crypto.createHash("sha256").update(JSON.stringify(renderAssets.sort())).digest("hex");
      
      // Persist report
      await conn.beginTransaction();
      
      const attemptCheck = await this.repo.getAttempt(conn, attemptId);
      if (!attemptCheck || attemptCheck.lease_owner !== leaseOwner || attemptCheck.state !== "verifying_draft") {
        throw new SpatialGeneratorServiceError("LEASE_LOST", "Lease lost or state changed during verification");
      }
      
      await this.repo.updateAttemptState(conn, attemptId, parsedVerification.automatedPass ? "awaiting_review" : "correction_requested", {
        automatedReportJson: parsedVerification,
        automatedReportHash: reportHash,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      
      await this.repo.updateJobState(conn, job.id, parsedVerification.automatedPass ? "awaiting_human_review" : "correction_requested");
      
      await this.repo.logEvent(conn, {
        jobId: job.id,
        attemptId,
        eventType: "verification_completed",
        payload: {
          automatedPass: parsedVerification.automatedPass,
          reportHash,
          renderManifestHash,
          attemptNumber: attempt.attempt_number,
        },
      });
      
      await conn.commit();
      
    } catch (error) {
      if (conn) {
        try { await conn.rollback(); } catch {}
      }
      if (leaseOwner) {
        const failConn = await this.pool.getConnection();
        try {
          await failConn.beginTransaction();
          await this.repo.updateAttemptState(failConn, attemptId, "failed", {
            failureCode: error instanceof SpatialGeneratorServiceError ? error.code : "VERIFICATION_FAILED",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          await this.repo.releaseLease(failConn, attemptId, leaseOwner);
          await failConn.commit();
        } catch {}
        finally { failConn.release(); }
      }
      throw error;
    } finally {
      if (conn) conn.release();
    }
  }

  async finalizeJob(jobId: number): Promise<void> {
    const conn = await this.pool.getConnection();
    let leaseOwner: string | null = null;
    try {
      await conn.beginTransaction();
      
      const job = await this.repo.getJobById(conn, jobId);
      if (!job) throw new SpatialGeneratorServiceError("NOT_FOUND", "Job not found");
      
      if (job.state !== "finalizing") {
        throw new SpatialGeneratorServiceError("INVALID_STATE", `Job not in finalizing state: ${job.state}`);
      }
      
      const attempt = await this.repo.getCurrentAttempt(conn, jobId);
      if (!attempt) throw new SpatialGeneratorServiceError("NO_ATTEMPT", "No current attempt");
      
      // Load the review record
      const reviews = await this.repo.getReviewsByJob(conn, jobId);
      const latestReview = reviews[reviews.length - 1];
      if (!latestReview || latestReview.decision !== "approve") {
        throw new SpatialGeneratorServiceError("NOT_APPROVED", "No approval found for this job");
      }
      
      // Revalidate all approval hashes
      const attemptHash = this.computeAttemptHash(attempt);
      if (attemptHash !== latestReview.attempt_hash) {
        throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Attempt hash does not match approval record");
      }
      if (attempt.automated_report_hash !== latestReview.report_hash) {
        throw new SpatialGeneratorServiceError("HASH_MISMATCH", "Report hash does not match approval record");
      }
      
      // Confirm approved attempt is still current
      if (job.current_attempt_id !== attempt.id) {
        throw new SpatialGeneratorServiceError("STALE_ATTEMPT", "A newer attempt exists; approval is stale");
      }
      
      // Check for conflicting decisions
      const allReviews = await this.repo.getReviewsByJob(conn, jobId);
      const conflictingReview = allReviews.find(r => 
        r.attempt_id === attempt.id && r.decision !== "approve"
      );
      if (conflictingReview) {
        throw new SpatialGeneratorServiceError("CONFLICTING_DECISION", "Conflicting review decision exists");
      }
      
      // Acquire finalization lease
      leaseOwner = `finalizer-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const leaseExpiresAt = new Date(Date.now() + DEFAULT_LEASE_DURATION_MS * 3); // Longer lease for finalization
      
      await this.repo.updateAttemptState(conn, attempt.id, "finalizing", {
        leaseOwner,
        leaseExpiresAt,
      });
      
      await this.repo.updateJobState(conn, jobId, "finalizing");
      await this.repo.logEvent(conn, {
        jobId,
        attemptId: attempt.id,
        eventType: "finalization_started",
        payload: { attemptNumber: attempt.attempt_number },
      });
      
      await conn.commit();
      
      // --- Reopen/revalidate approved draft and stored plan/math ---
      const { SpatialPlanSchema, SpatialMathOutputSchema } = await import("./schemas");
      const plan = SpatialPlanSchema.parse(attempt.plan_json!);
      const math = SpatialMathOutputSchema.parse(attempt.math_json!);
      
      if (!attempt.compiled_program_hash) {
        throw new SpatialGeneratorServiceError("MISSING_COMPILED_HASH", "Compiled program hash not found");
      }
      
      // Build final asset through authenticated Blender worker
      const result = await this.blenderWorker.buildFinal({
        attemptId: attempt.id,
        plan,
        math,
        compiledProgramHash: attempt.compiled_program_hash,
        targetUse: job.target_use,
      });
      
      // Validate final outputs
      if (!result.finalGlbAssetVersionId) {
        throw new SpatialGeneratorServiceError("MISSING_FINAL_GLB", "Final GLB not produced");
      }
      
      if (job.target_use === "print" && !result.finalStlAssetVersionId) {
        throw new SpatialGeneratorServiceError("MISSING_FINAL_STL", "Final STL not produced for print target");
      }
      
      // Reopen and re-validate final outputs (would fetch from storage and run validateGlb)
      
      // Store final artifacts as canonical asset versions and register lineage
      // This would use the asset service to create proper relations
      
      // Create/update FurBin item only after durable final assets exist
      // This requires the fur-bin service integration
      
      // Mark job completed
      await conn.beginTransaction();
      
      const attemptCheck = await this.repo.getAttempt(conn, attempt.id);
      if (!attemptCheck || attemptCheck.lease_owner !== leaseOwner || attemptCheck.state !== "finalizing") {
        throw new SpatialGeneratorServiceError("LEASE_LOST", "Lease lost during finalization");
      }
      
      await this.repo.updateAttemptState(conn, attempt.id, "completed", {
        completedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      
      await this.repo.updateJobState(conn, jobId, "completed", {
        creditsDisposition: "charged",
      });
      
      await this.repo.chargeCredits(conn, jobId);
      
      await this.repo.logEvent(conn, {
        jobId,
        attemptId: attempt.id,
        eventType: "finalization_completed",
        payload: {
          finalGlbAssetVersionId: result.finalGlbAssetVersionId,
          finalStlAssetVersionId: result.finalStlAssetVersionId,
          manufacturingReportAssetVersionId: result.manufacturingReportAssetVersionId,
          attemptNumber: attempt.attempt_number,
        },
      });
      
      await conn.commit();
      
    } catch (error) {
      if (conn) {
        try { await conn.rollback(); } catch {}
      }
      if (leaseOwner) {
        const failConn = await this.pool.getConnection();
        try {
          await failConn.beginTransaction();
          // Attempt to recover - mark job as failed but preserve recovery handle
          await this.repo.updateJobState(failConn, jobId, "failed", {
            failureCode: error instanceof SpatialGeneratorServiceError ? error.code : "FINALIZATION_FAILED",
            failureDetail: error instanceof Error ? error.message : String(error),
          });
          // Release lease
          const attempt = await this.repo.getCurrentAttempt(failConn, jobId);
          if (attempt) {
            await this.repo.releaseLease(failConn, attempt.id, leaseOwner);
          }
          await failConn.commit();
        } catch {}
        finally { failConn.release(); }
      }
      throw error;
    } finally {
      if (conn) conn.release();
    }
  }

  // ─── Recovery / Reconciliation ─────────────────────────────────────────────

  async recoverStaleJobs(): Promise<{ recovered: number; failed: number }> {
    const conn = await this.pool.getConnection();
    try {
      const staleAttempts = await this.repo.findStaleLeases(conn);
      let recovered = 0;
      let failed = 0;

      for (const attempt of staleAttempts) {
        try {
          await conn.beginTransaction();
          await this.repo.releaseLease(conn, attempt.id, attempt.lease_owner!);
          await this.repo.updateAttemptState(conn, attempt.id, "queued", {
            failureCode: "LEASE_EXPIRED",
            errorMessage: "Lease expired, re-queued for retry",
          });
          await this.repo.logEvent(conn, {
            jobId: attempt.job_id,
            attemptId: attempt.id,
            eventType: "lease_expired",
            payload: { attemptNumber: attempt.attempt_number },
          });
          await conn.commit();
          recovered++;
        } catch {
          await conn.rollback();
          failed++;
        }
      }

      return { recovered, failed };
    } finally {
      conn.release();
    }
  }

  // ─── Health ──────────────────────────────────────────────────────────────────

  async getHealthStatus(): Promise<{
    ready: boolean;
    featureEnabled: boolean;
    layer8Configured: boolean;
    directMathWorkerOnline: boolean;
    /** @deprecated retained for one release for older admin clients. */
    pixelWorkerOnline: boolean;
    blenderWorkerHealthy: boolean;
    orchestratorReady: boolean;
    blockers: string[];
    activeJobs: number;
    queuedAttempts: number;
  }> {
    const conn = await this.pool.getConnection();
    try {
      const featureEnabled = isInhouseSpatialGeneratorEnabled();
      
      // Layer8 must expose all four direct spatial operations.  This path does
      // not use Hermes, Pixel, Gemma, or a model fallback.
      const layer8Configured = !!(process.env.LAYER8_BASE_URL && process.env.LAYER8_TENANT_API_KEY);
      const layer8Health = layer8Configured ? await checkLayer8Health() : null;
      const layer8Healthy = layer8Health
        ? Object.values(layer8Health).every(Boolean)
        : false;
      
      // Count active jobs
      const [activeRows] = await conn.query(
        "SELECT COUNT(*) as count FROM spatial_generation_jobs WHERE state NOT IN ('completed', 'failed', 'cancelled')",
      );
      const activeJobs = Number((activeRows as any[])[0]?.count || 0);
      
      // Count queued attempts
      const [queuedRows] = await conn.query(
        "SELECT COUNT(*) as count FROM spatial_generation_attempts WHERE state IN ('queued', 'observing', 'planning', 'awaiting_math', 'validating_math')",
      );
      const queuedAttempts = Number((queuedRows as any[])[0]?.count || 0);

      // Math is deterministic and runs in this process; no Pixel/Gemma worker
      // is involved. Blender and the scheduler require independent evidence.
      const directMathWorkerOnline = true;
      const blenderWorkerHealthy = await checkDirectBlenderWorker();
      const orchestratorReady = isDirectSpatialSchedulerReady();
      const pixelWorkerOnline = directMathWorkerOnline;
      const blockers = [
        ...(!featureEnabled ? ["feature_flag"] : []),
        ...(!layer8Configured || !layer8Healthy ? ["layer8"] : []),
        ...(!directMathWorkerOnline ? ["spatial_math_worker"] : []),
        ...(!blenderWorkerHealthy ? ["blender_worker"] : []),
        ...(!orchestratorReady ? ["orchestrator"] : []),
      ];

      return {
        ready: blockers.length === 0,
        featureEnabled,
        layer8Configured: layer8Configured && layer8Healthy,
        directMathWorkerOnline,
        pixelWorkerOnline,
        blenderWorkerHealthy,
        orchestratorReady,
        blockers,
        activeJobs,
        queuedAttempts,
      };
    } finally {
      conn.release();
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private computeAttemptHash(attempt: any): string {
    const payload = {
      observationHash: attempt.observation_hash,
      planHash: attempt.plan_hash,
      mathHash: attempt.math_hash,
      compiledProgramHash: attempt.compiled_program_hash,
      automatedReportHash: attempt.automated_report_hash,
    };
    return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  private toJobPublic(job: any): SpatialJobPublic {
    return {
      jobUuid: job.job_uuid,
      ownerPhone: job.owner_phone,
      subjectKind: job.subject_kind,
      targetUse: job.target_use,
      state: job.state,
      currentAttemptNumber: job.current_attempt_id ? 1 : null, // Will be populated from attempt
      creditsReserved: job.credits_reserved,
      creditsDisposition: job.credits_disposition,
      failureCode: job.failure_code,
      createdAt: job.created_at.toISOString(),
      updatedAt: job.updated_at.toISOString(),
    };
  }
}

// Export factory for router
export function createSpatialGeneratorService(options: SpatialGeneratorOptions = {}): SpatialGeneratorService {
  return new SpatialGeneratorService(options);
}
