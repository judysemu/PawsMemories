// MUST be the first import. ESM evaluates all imports before any top-level
// statement, so `dotenv.config()` further down runs too late: any module that
// touches process.env at import time (and getPool() memoises its options on
// first call) would capture an empty config and cache it. Importing
// "dotenv/config" here loads .env during module resolution instead.
import "dotenv/config";
import express from "express";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { z } from "zod";
import compression from "compression";
import path from "path";
// Vite is imported dynamically below — only in dev mode
import { GoogleGenAI, GenerateVideosOperation } from "@google/genai";
import dotenv from "dotenv";
import Stripe from "stripe";
import fs from "fs";
import sharp from "sharp";
import { sendSms } from "./server/sms";
import { sendMail } from "./server/mail";
import rateLimit from "express-rate-limit";
import { initDb, findUserByPhone, findUserByEmail, createUserByEmail, EmailTakenError, completeUserProfile, toPublicUser, reserveCredits, refundReservedCredits, addCredits, getCreditBalance, getCreditHistory, grantPurchasedCredits, getCommunityMemories, addCommunityMemory, setProfilePhoto, addUserPhoto, getUserPhotos, deleteUserPhoto, saveCreation, getCreations, getAllCreations, updateCreation, createJob, updateJobStatus, getJob, getRunningJobs, setCreationVideoUrl, setCreationModelUrl, getDailyVideoCount, isUserAdmin, addPet, getPets, updatePet, deletePet, createAlbum, getAlbums, createAvatar, updateAvatarModel, updateAvatarGenerationStatus, getAvatarById, getAvatars, deleteAvatar, hideAvatar, unhideAvatar, getHiddenAvatars, feedAvatar, waterAvatar, giveTreatToAvatar, getAvatarNeeds, saveAvatarNeeds, getPlacedObjects, addPlacedObject, deletePlacedObject, updateAvatarMultiview, parseMultiview, getPool, claimDailyStreak, claimFreeAvatar, releaseFreeAvatar, claimAchievement, getPetProfileByAvatar, getPetProfileById, upsertPetProfile, savePetState, savePetRigUrls, getSemanticScan, saveSemanticScan, getPetCommands, addPetCommand, getPetButtons, addPetButton, incrementTrainerScore, updatePetSettings, bumpDailyUsage, getSceneActors, addSceneActor, updateSceneActor, deleteSceneActor, getStorageUsage, recordStorageAddHot, recordStorageRemoveHot, purchaseColdStorage, updateUserProfile, checkAndGrantProfileBonus, verifyUserEmail, generateReferralCode, recordReferral, creditReferralIfComplete, getPawprintCategories, getPawprintTemplatesSync, acceptTermsVersion, createVoiceCloneAsset, listVoiceCloneAssets, createPasswordReset, resetPasswordWithToken, insertBimBuild, listBimBuilds, checkDatabaseHealth, closePool } from "./db";
import { isEndpointEnabled, dailyCapFor, withinDailyCap, type PaidEndpoint } from "./server/paidApiGuards";
import {
  ImageGenerationBudgetError,
  rethrowImageGenerationBudgetError,
  reserveImageGenerationCall,
} from "./server/imageGenerationBudget";
import { classifyPetImage, type GenerateFn } from "./server/petClassify";
import { injectMeta } from "./server/seoMeta";
import { semanticScan as runSemanticScan } from "./server/semanticScan";
import { animatorRouter } from "./server/animator/routes.ts";
import { assetsRouter } from "./server/assets/routes";
import { referenceSessionsRouter } from "./server/reference-sessions/routes";
import { generateSignedUrlForVersion } from "./server/assets/access";
import { modelBuildsRouter, modelBuildService } from "./server/model-builds/routes";
import { spatialGeneratorRouter, startSpatialGeneratorScheduler } from "./server/spatial-generator/routes";
import { createPetGenerationRouter, createPetGlbWebhookHandler } from "./server/pet-generation/routes";
import { buildPetGlbDeps } from "./server/pet-generation/wiring";
import { PetGlbService } from "./server/pet-generation/service";
import { createRigPipelineRouter } from "./server/rig-pipeline/routes";
import { RigPipelineService } from "./server/rig-pipeline/service";
import { isRigPipelineV4Enabled } from "./server/rig-pipeline/featureFlag";
import { createFurBinRouter } from "./server/fur-bin/routes";
import { AiVideoScriptSchema, compileEightSecondPrompt, VEO_MOTION_NEGATIVE_PROMPT } from "./server/ai-video/scripts";
import { isModelBuildV3Enabled } from "./server/model-builds/featureFlag";
import { isInhouseSpatialGeneratorEnabled } from "./server/spatial-generator/featureFlag";
import { requireCanonicalAssetsEnabled } from "./server/assets/featureFlag";
import { planWagsBox, getPriorBoxHistory } from "./server/wags/planner";
import { deliverBox, getOwnedWardrobeItems } from "./server/wags/delivery";
import { materializeBoxAssets } from "./server/wags/materializer";
import { RebakeRequestSchema, StylizeRequestSchema, viewsFromAvatarRow } from "./server/textureSchemas";
import type { RebakeLikenessReport } from "./server/textureLikeness";
import {
  MarketplaceAdminError,
  listListingsWithCounts,
  listingPreviews,
  listingAssets,
  createListing,
  updateListing,
  reorderListings,
  mintUploadUrl,
  confirmAsset,
  updateAsset,
} from "./server/marketplaceAdmin";
import {
  publicListings,
  publicListing,
  checkoutDigital,
  getOrderStatus,
  getUserEntitlements,
  digitalDownload
} from "./server/marketplacePublic";
import { ListingQuerySchema } from "./server/marketplaceSchemas";
import { CURRENT_SCHEMA_VERSION } from "./server/migrations/runner";
import { normalizeDerivativeHeightMm, persistStlDerivativeOrResolveWinner } from "./server/marketplaceStl";
import { loadReleaseManifest } from "./server/releaseManifest";
import {
  CreateListingSchema,
  UpdateListingSchema,
  ReorderListingsSchema,
  UploadUrlRequestSchema,
  ConfirmAssetSchema,
  UpdateAssetSchema,
} from "./server/marketplaceSchemas";
import { ANIMATOR_DATA_DIR, resolveWithinWorkspace } from "./server/animator/paths.ts";
import { studioRouter } from "./server/animator/studio_proxy.ts";
import { refundRouter } from "./server/refunds.ts";
import { setRefundReviewGenerate } from "./server/refunds.ts";
import {
  createPetSimApp,
  isPetSimImageRoute,
} from "./server/petSimApp.ts";
import { createProductionHermesApp } from "./server/hermes/app.ts";
import { privacyHtml, termsHtml, smsTermsHtml } from "./server/legal.ts";
import { startWorker as startAnimatorWorker } from "./server/animator/worker.ts";
import { decodeAnimatorOperationMetadata } from "./server/animator/operationMetadata.ts";
import { getOwnedVoicedResult } from "./server/animator/voicedResults.ts";
import { getOwnedRecording } from "./server/animator/recordings.ts";
import { fetchBoundedRemoteBuffer } from "./server/safeRemoteFetch.ts";
import {
  failGenerationJobAndRefundOnce,
  markGenerationJobDoneOnce,
  sweepPendingGenerationRefunds,
} from "./server/generationRefunds.ts";
import { phraseKey } from "./src/three/ar/voice";
import { decayCompliance, pointsForTrial, type TrialType } from "./src/brain";
import { createHash, randomUUID } from "crypto";
import { resolveBreedProfile } from "./server/breedProfiles";
import { decayDrives, DEFAULT_DRIVES, DEFAULT_HORMONES, weightsFromTemperament } from "./src/brain";
import { uploadBase64Image, uploadBinaryFromUrl, fetchUrlAsBase64, uploadBase64Binary } from "./storage";
import { assertPrivateStorageConfig, deletePrivateObject, getPrivateSignedUrl, putPrivateObject, mintObjectKey } from "./storage.private";
import { runBuildPipeline } from "./agent/graph/orchestrator";
import { analyzePetImage, type PetAnalysis } from "./ollama-agent";
import { getBlenderClient } from "./agent/tools/blender_client";
import { startTalkingVideo, pollTalkingVideo, fetchMp4AsDataUrl, isHeyGenHandle } from "./heygen";
import { startImageTo3D, pollImageTo3D, isTripoHandle, startRig, pollTripoTask, isTripoInsufficientCredit, TripoError } from "./tripo";
import { isInHouseOnly, rejectLegacyExternal3dRoute } from "./server/externalGenerativePolicy";
import { checkBudget, needsRetargetFallback, type BakeStats } from "./server/rigBudget";
import { normalizeVideoAspectRatio } from "./server/videoAspectRatio";
import { registerSnapgenRoutes } from "./server/snapgen";
import { SKELETON_CONTRACTS } from "./skeletonContract";
import { TERMS_VERSION } from "./src/legal";
import { avatarGenerationCost, bimModelCost, CREDIT_PRICES, REUSE_DISCOUNT, createModelCost, riggingAddonCost, type BimBuildMode, type RiggingSelection } from "./src/pricing";
import { executeBlenderTool } from "./agent/tools/blender_mcp";
import {
  formatPipelineRecoveryDiagnostic,
  PIPELINE_RIG_MAX_ATTEMPTS,
  PipelineRigRecoveryStore,
  pipelineRiggingSelection,
  type PipelineRigRecoveryContext,
  type RecoveryClaim,
} from "./server/pipeline-rig-recovery";
import { getPipelineSessionByBuildJobId } from "./db";
import { preflightBimModel, type BimModel } from "./src/bim/model";
import { buildAndVerifyShell } from "./server/bim/shell";
import { buildBimPostBuildVerification, buildBimPreBuildVerification } from "./server/bim/verification";
import { isBimV2Enabled } from "./server/bim/featureFlag";
import { BIM_PROPOSAL_SYSTEM_INSTRUCTION, BimProposalRequestSchema, buildBimProposalPrompt, parseBimProposal, validateBimProposalImages } from "./server/bim/proposal";
import { isAtLeastAge } from "./server/accountValidation";
import { PrintUploadValidationError, validatePrintUpload } from "./server/printUploadValidation";
import { WARDROBE_CATALOG, WARDROBE_ITEM_IDS, WAGS_EXCLUSIVE_ITEM_IDS } from "./src/wardrobe/catalog";
import { buildReferencePrompt, turnaroundViewsForType, paletteLockClause, extractPaletteInstruction, buildTextPrompt, geometryToTripo, type TextPromptFields, type ExtendedSubjectClass, getSubjectClassForSpecies, getBuildProfileForSpecies } from "./avatarPrompts";
import { confirmPrintfulOrderIfDraft, createPrintfulOrder, getPrintfulOrder, verifyPrintfulConfiguration } from "./server/printful";
import { printfulCatalogConfigured, searchProducts, listVariants, getTemplateContext, clearCatalogueCache } from "./server/printfulCatalog";
import { handleCustomizeOrderPayment, registerCustomizerBuyerRoutes } from "./server/customizerCheckout";
import {
  CreditPurchaseValidationError,
  createCreditsSessionHandler,
  fulfillCreditPurchaseSession,
  ignoreUnsupportedCheckoutSession,
  retiredAlbumCheckoutHandler,
} from "./server/creditPurchases";
import { pawprintDisplayCatalog, publicPawprintPrintProducts, requirePawprintPrintProduct } from "./server/pawprintProducts";
import { buildFulfillmentReadiness } from "./server/fulfillmentReadiness";
import { buildRandySystemInstruction } from "./server/randy/prompt";
import { RANDY_REGISTRY_VERSION } from "./server/randy/registry";
import { parseRandyModelResponse, RandyChatRequestSchema } from "./server/randy/security";
import { extractShipmentTracking } from "./server/fulfillmentTracking";
import { draftSlantOrder, getSlantOrder, slant3dConfigured, submitSlantOrderIfDraft, uploadSlantFileFromUrl, verifySlant3dConfiguration } from "./server/slant3d";
import { isStationeryV2Enabled } from "./server/stationery-v2/featureFlag";
import { createStationeryV2Production } from "./server/stationery-v2/production";
import { createStationeryV2Router } from "./server/stationery-v2/routes";
import { isWagsV2Enabled } from "./server/wags-v2/featureFlag";
import { createWagsV2Production } from "./server/wags-v2/production";
import { createWagsV2Router } from "./server/wags-v2/routes";
import { triageReferenceImage, triagePasses, correctiveFromTriage, friendlyQualifyError, isClassMismatch, classLabel, type TriageResult } from "./server/imageTriage";
import { objectBuildProfile, humanRigHints } from "./server/subjectProfiles";

// ---------------------------------------------------------------------------
// P3/P4 — Optional rigging stage for create-pipeline model jobs.
// Runs AFTER the static GLB is stored, so a rig failure can never cost the
// user their base model. Refunds only the add-on on fallback. One attempt +
// one retry, both gated by the worker's physics_validate (gravity 9.8 m/s²).
// ---------------------------------------------------------------------------
const pipelineRigLocks = new Set<number>();
const pipelineRigRecovery = new PipelineRigRecoveryStore(getPool);
const PIPELINE_RIG_HEARTBEAT_MS = 60 * 1000;

/**
 * Poll a Veo video operation by its stored operation name.
 *
 * WHY THIS WRAPPER EXISTS
 * -----------------------
 * `ai.operations.getVideosOperation()` does NOT accept a plain `{ name }`
 * object. After fetching the raw payload it calls `operation._fromAPIResponse()`
 * on whatever you handed it — that method lives on the `GenerateVideosOperation`
 * prototype, so an object literal produces:
 *
 *     TypeError: operation._fromAPIResponse is not a function
 *
 * Both video pollers previously passed `{ name } as any`. The `as any` silenced
 * the type error that would have caught this at compile time, so every Veo job
 * died at poll time — see generation_jobs rows 16/19/20. Note the HTTP request
 * succeeds before the throw: the video really was generated and paid for, we
 * just crashed reading the result and then refunded, so the cost was eaten
 * silently on both ends.
 *
 * Passing a real instance keeps the SDK's own parsing (which normalises the
 * mldev vs Vertex response shapes) instead of us hand-rolling it.
 */
function veoOperationHandle(operationName: string): GenerateVideosOperation {
  return Object.assign(new GenerateVideosOperation(), { name: operationName });
}

function logPipelineRecovery(prefix: string, claim: RecoveryClaim): void {
  if (claim.context) {
    console.log(`[PipelineRig ${prefix}] ${formatPipelineRecoveryDiagnostic(claim.context, claim)}`);
  } else {
    console.log(`[PipelineRig ${prefix}] decision=skip reason=${claim.reason}`);
  }
}

function rigAddonForContext(context: PipelineRigRecoveryContext | null): number {
  return context ? riggingAddonCost(pipelineRiggingSelection(context)) : 0;
}

async function rejectPipelineRigRecovery(jobId: number, context: PipelineRigRecoveryContext | null, reason: string, expectedLeaseOwner?: string): Promise<void> {
  const result = await pipelineRigRecovery.finalizeRejected(jobId, reason, rigAddonForContext(context), expectedLeaseOwner);
  console.warn(`[PipelineRig recovery] job=${jobId} finalized=${result.status} reason=${reason} refunded=${result.refunded}`);
}

interface PipelineProviderGate {
  isCreatePipeline: boolean;
  claim: RecoveryClaim | null;
}

async function claimPipelineProviderPoll(jobId: number): Promise<PipelineProviderGate> {
  const context = await pipelineRigRecovery.getContext(jobId);
  if (!context?.sessionId) return { isCreatePipeline: false, claim: null };
  const claim = await pipelineRigRecovery.claimProviderPoll(jobId);
  logPipelineRecovery("provider", claim);
  const concurrentOrTerminal = new Set([
    "active_lease",
    "job_rigging",
    "job_validating",
    "job_done",
    "job_done_static_fallback",
    "job_failed",
  ]);
  if (!claim.eligible && !concurrentOrTerminal.has(claim.reason)) {
    await rejectPipelineRigRecovery(jobId, claim.context, claim.reason);
  }
  return { isCreatePipeline: true, claim };
}

async function finishStoredPipelineModel(jobId: number, providerClaim: RecoveryClaim, modelUrl: string): Promise<'rigging' | 'done' | 'failed'> {
  if (!providerClaim.leaseOwner || !providerClaim.context) return "failed";
  const rigging = pipelineRiggingSelection(providerClaim.context);
  if (!rigging.enabled) {
    const completed = await pipelineRigRecovery.completeWithoutRig(jobId, providerClaim.leaseOwner);
    return completed ? "done" : "failed";
  }
  const prepared = await pipelineRigRecovery.prepareRig(jobId, providerClaim.leaseOwner, modelUrl);
  logPipelineRecovery("prepare", prepared);
  if (!prepared.eligible) {
    if (prepared.reason !== "provider_lease_lost") {
      await rejectPipelineRigRecovery(jobId, prepared.context, prepared.reason, providerClaim.leaseOwner);
    }
    return "failed";
  }
  void runCreatePipelineRigStage(jobId);
  return "rigging";
}

async function runCreatePipelineRigStage(jobId: number): Promise<void> {
  if (pipelineRigLocks.has(jobId)) return;
  pipelineRigLocks.add(jobId);
  let lastContext: PipelineRigRecoveryContext | null = null;
  try {
    let glbBase64: string | null = null;
    let referenceBase64: string | null = null;
    let report: unknown = null;

    while (true) {
      const claim = await pipelineRigRecovery.claimRigAttempt(jobId);
      lastContext = claim.context;
      logPipelineRecovery("claim", claim);
      if (!claim.eligible || !claim.context || !claim.leaseOwner || !claim.attemptNumber) {
        if (!['active_lease', 'job_done', 'job_done_static_fallback', 'job_failed'].includes(claim.reason)) {
          await rejectPipelineRigRecovery(jobId, claim.context, claim.reason);
        }
        return;
      }

      const context = claim.context;
      const attempt = claim.attemptNumber;
      const leaseOwner = claim.leaseOwner;
      const rigging = pipelineRiggingSelection(context);
      let leaseLost = false;
      let heartbeatBusy = false;
      const heartbeat = setInterval(() => {
        if (heartbeatBusy || leaseLost) return;
        heartbeatBusy = true;
        void pipelineRigRecovery.heartbeat(jobId, leaseOwner)
          .then((ok) => { if (!ok) leaseLost = true; })
          .catch((error) => {
            leaseLost = true;
            console.error(`[PipelineRig job ${jobId}] heartbeat failed:`, error?.message || error);
          })
          .finally(() => { heartbeatBusy = false; });
      }, PIPELINE_RIG_HEARTBEAT_MS);
      heartbeat.unref?.();

      try {
        const beforeBuild = await pipelineRigRecovery.verifyRigLease(jobId, leaseOwner);
        if (!beforeBuild.eligible) throw new Error(`Recovery cancelled before Blender call: ${beforeBuild.reason}`);
        if (!glbBase64) glbBase64 = await fetchUrlAsBase64(context.currentModelUrl!);
        if (referenceBase64 === null) {
          const session = await getPipelineSessionByBuildJobId(jobId);
          referenceBase64 = session?.candidate_image_url
            ? await fetchUrlAsBase64(session.candidate_image_url).catch(() => "")
            : "";
        }

    // Derive anatomy from the shared species→profile mapper rather than a
    // hardcoded `species === "human"` test.
    //
    // The old check made every non-human a quadruped, including `other` — which
    // is what the create flow writes for anything that isn't dog or cat. A human
    // was therefore described to the pipeline as a four-legged animal with a tail.
    //
    // WHAT THIS DOES AND DOESN'T FIX. This path rigs via runBuildPipeline (the
    // LLM Blender agent), NOT via Tripo animate_rig + /bake-lod. So petAnalysis
    // here does not select a skeleton or a bonemap — bonemap.human.json is only
    // read by /bake-lod, which this path never calls, and Tripo's "humanoid" rig
    // spec is chosen in startRig(), a different code path. bodyType reaches
    // exactly two places: the plan prompt in agent/graph/nodes/reason.ts, and the
    // `profile` field of physics_validate, which echoes it without branching.
    //
    // Correcting it therefore fixes the only anatomy signal this pipeline has,
    // which is necessary but not sufficient — telling the planner "biped, 2 legs,
    // no tail" instead of "quadruped, 4 legs, tail" is strictly better, but the
    // resulting rig still has to pass the same generic weight/symmetry gates.
    // Deterministic human rigging lives on the Tripo+bonemap path; routing the
    // create flow to it for bipeds is the real fix and is not done here.
    //
    // getBuildProfileForSpecies already handles human, winged, reptile and
    // small_animal; routing through it means birds stop being described as dogs too.
        const session = await getPipelineSessionByBuildJobId(jobId);
        const species = String(session?.species || "dog");
    const buildProfile = getBuildProfileForSpecies(species as ExtendedSubjectClass);
    const isBiped = buildProfile === "human";
    const isWinged = buildProfile === "winged";
        const petAnalysis: PetAnalysis = {
      species,
      breed: session?.breed || "Mixed",
      // A bird is neither a biped nor a quadruped — it stands on two legs and
      // has wings where forelimbs would be. Describing it as a four-legged
      // animal was the same class of error as calling a person one.
      bodyType: isBiped ? "biped" : isWinged ? "winged" : "quadruped",
      estimatedPose: "standing",
      legCount: isBiped || isWinged ? 2 : 4,
      // Humans have no tail; a bird's tail is feathers, not a tail rig chain.
      hasTail: !isBiped && !isWinged,
      hasWings: isWinged,
      bodyProportions: { headSize: "medium", legLength: "medium", bodyLength: "medium", neckLength: "medium" },
      coatColors: ["#C0A080"],
      coatPattern: "solid",
        };

        const buildState = await runBuildPipeline(
          petAnalysis,
          glbBase64,
          async (step, pct, detail) => console.log(`[PipelineRig job ${jobId} attempt ${attempt}] ${step}: ${detail} (${pct}%)`),
          referenceBase64 || null,
          { facialVisemes: !!rigging.facial } // P4: visemes only when purchased
        );
        if (buildState.status !== "completed" || !buildState.riggedGlbBase64) {
          throw new Error(buildState.statusMessage || `Build ended with ${buildState.status}`);
        }
        if (leaseLost) throw new Error("Recovery lease was lost while Blender was running");
        const beforeValidation = await pipelineRigRecovery.verifyRigLease(jobId, leaseOwner);
        if (!beforeValidation.eligible) throw new Error(`Recovery cancelled before quality calls: ${beforeValidation.reason}`);
        // Quality gates: anatomy + physics at 9.8 m/s² (§5.4 known-bug guards).
        const movedToValidation = await pipelineRigRecovery.setRigPhase(jobId, leaseOwner, "validating", `rig_attempt_${attempt}_validating`);
        if (!movedToValidation) throw new Error("Recovery lease was lost before validation");
        const imported = await executeBlenderTool("import_glb", { glb_base64: buildState.riggedGlbBase64 });
        if (!imported.success) throw new Error(imported.error || "rigged GLB re-import failed");
        const beforePhysics = await pipelineRigRecovery.verifyRigLease(jobId, leaseOwner);
        if (!beforePhysics.eligible) throw new Error(`Recovery cancelled before physics validation: ${beforePhysics.reason}`);
        const validation = await executeBlenderTool("physics_validate", {
          profile: petAnalysis.bodyType,
          facial: !!rigging.facial,
        });
        report = validation.data ?? validation;
        const passed = !!(validation.success && (validation.data?.pass ?? (validation as any).pass));
        if (!passed) throw new Error(`Quality gates failed: ${JSON.stringify(report).slice(0, 360)}`);

        const beforeUpload = await pipelineRigRecovery.verifyRigLease(jobId, leaseOwner);
        if (!beforeUpload.eligible) throw new Error(`Recovery cancelled before artifact upload: ${beforeUpload.reason}`);
        const riggedUrl = await uploadBase64Binary(buildState.riggedGlbBase64, "model/gltf-binary");

      // A body rig can pass its quality gates while the facial pass finds no
      // usable viseme targets — facialVisemes.ts reports available:false rather
      // than fabricating mouth shapes. The user paid for the add-on and is not
      // refunded (product decision), so the outcome has to be stated plainly
      // instead of being reported as an unqualified success. The pre-purchase
      // warning in CreateCustomizeScreen is the other half of this contract.
        const facialRequested = !!rigging.facial;
        const facialReport = (report as any)?.facial ?? (report as any)?.visemes ?? null;
        const facialLanded = facialRequested
          ? Boolean(facialReport?.available ?? facialReport?.shapes?.length)
          : null;
        const completionMessage = facialRequested && facialLanded === false
          ? "Body rig applied. Facial rig unavailable — this model returned no usable mouth shapes, so lip-sync falls back to jaw movement."
          : null;
        const completed = await pipelineRigRecovery.completeRig(jobId, leaseOwner, riggedUrl, report, completionMessage);
        if (!completed.eligible) {
          console.warn(`[PipelineRig job ${jobId}] stale result discarded: ${completed.reason}`);
          if (!['lease_lost', 'lease_expired'].includes(completed.reason)) {
            await rejectPipelineRigRecovery(jobId, await pipelineRigRecovery.getContext(jobId), completed.reason, leaseOwner);
          }
          return;
        }

        if (completionMessage) {
        await sendSms(
          context.userPhone,
          `🐾 Paws & Memories: Your rigged 3D model is ready. Heads up — facial rigging couldn't be applied to this model (it animates with jaw movement instead). View it at ${process.env.APP_URL || "your app"}.`,
        );
        } else {
          await sendSms(context.userPhone, `🐾 Paws & Memories: Your rigged 3D model is ready! View it at ${process.env.APP_URL || "your app"}.`);
        }
        return;
      } catch (attemptErr: any) {
        clearInterval(heartbeat);
        const detail = String(attemptErr?.message || attemptErr);
        console.error(`[PipelineRig job ${jobId}] attempt ${attempt} error:`, detail);
        if (leaseLost) return;
        const recorded = await pipelineRigRecovery.recordAttemptFailure(jobId, leaseOwner, detail);
        if (!recorded) return;
        if (attempt >= PIPELINE_RIG_MAX_ATTEMPTS) {
          const fallback = await pipelineRigRecovery.finalizeRejected(
            jobId,
            "Rigging did not pass quality gates; static model delivered and rigging credits refunded.",
            rigAddonForContext(context),
          );
          console.warn(`[PipelineRig job ${jobId}] attempt budget exhausted; finalized=${fallback.status} refunded=${fallback.refunded}`);
          await sendSms(context.userPhone, `🐾 Paws & Memories: Your 3D model is ready as a static model. Rigging didn't pass our quality checks, so those PupCoins were refunded.`);
          return;
        }
      } finally {
        clearInterval(heartbeat);
      }
    }
  } catch (err: any) {
    console.error(`[PipelineRig job ${jobId}] fatal:`, err?.message || err);
    await rejectPipelineRigRecovery(jobId, lastContext, "Rigging stage errored; static model delivered and rigging credits refunded.").catch(() => {});
  } finally {
    pipelineRigLocks.delete(jobId);
  }
}
import {
  signToken,
  requireAuth,
  hashPassword,
  verifyPassword,
  generateResetToken,
  hashResetToken,
  type AuthedRequest,
} from "./auth";

dotenv.config();

// Strip a `data:<mime>;base64,<data>` URL prefix, returning { data, mimeType }.
// Shared by the create-video route and (via a local copy) the pet-sim router.
function splitDataUrl(s: string): { data: string; mimeType: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(s);
  if (m) return { mimeType: m[1], data: m[2] };
  return { mimeType: "image/jpeg", data: s };
}

export function formatReadinessResponse(database: { configured: boolean; healthy: boolean; latencyMs: number; error?: string }, buildInfo: any) {
  if (!database.healthy) {
    if (database.error) {
      console.error("❌ Database readiness check failed:", database.error);
    }
    return {
      statusCode: 503,
      body: {
        status: "not_ready",
        database: {
          configured: database.configured,
          healthy: false,
          latencyMs: database.latencyMs,
          reason: "database_unavailable",
        },
      },
    };
  }
  return {
    statusCode: 200,
    body: {
      status: "ready",
      database: {
        configured: true,
        healthy: true,
        latencyMs: database.latencyMs,
      },
      build: buildInfo,
    },
  };
}

async function startServer() {
  const app = express();
  // API responses are application data, never search-result pages.
  app.use("/api", (_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    next();
  });
  // Gzip/deflate every text response (JSON, JS, CSS, HTML). The main bundle is
  // ~1.7MB raw → ~490KB on the wire. Must be mounted before route/static handlers.
  app.use(compression());
  // Hostinger runs the app behind a reverse proxy (LiteSpeed) which sets
  // X-Forwarded-For. Without this, express-rate-limit throws
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and rate-limits by proxy IP.
  app.set("trust proxy", 1);
  const PORT = Number(process.env.PORT) || 3000;

  // Fix 3: JWT_SECRET startup guard — refuse to start with an insecure empty secret.
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "MY_JWT_SECRET" || process.env.JWT_SECRET.length < 16) {
    console.error("❌ FATAL: JWT_SECRET is missing or too short. Set a long random string in your .env file.");
    process.exit(1);
  }

  // Private customer assets must never degrade to metadata-only records. Every
  // production process validates the split private-bucket boundary before
  // opening its listener.
  if (process.env.NODE_ENV === "production") {
    assertPrivateStorageConfig();
  }

  // The Hostinger launcher opens the socket before this large bundle loads, then
  // hands it to Express. Other environments continue to listen normally.
  type HostingerBootstrap = {
    server: HttpServer;
    handler: (req: IncomingMessage, res: ServerResponse) => void;
  };
  const bootstrapGlobal = globalThis as typeof globalThis & {
    __PAWSOME_HOSTINGER_BOOTSTRAP__?: HostingerBootstrap;
  };
  const bootstrap = bootstrapGlobal.__PAWSOME_HOSTINGER_BOOTSTRAP__;
  let httpServer: HttpServer;
  if (bootstrap) {
    httpServer = bootstrap.server;
    httpServer.removeListener("request", bootstrap.handler);
    httpServer.on("request", app);
    delete bootstrapGlobal.__PAWSOME_HOSTINGER_BOOTSTRAP__;
    console.log(`Server adopted Hostinger bootstrap listener on port ${PORT}`);
  } else {
    httpServer = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  }

  try {
    // Initialize the user database (creates the users table if needed).
    await initDb();
  } catch (error) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    throw error;
  }

  let manifestData: any = null;
  try {
    const baseDir = typeof __dirname !== "undefined" ? __dirname : process.cwd();
    const candidatePaths = [
      path.join(process.cwd(), "release-manifest.json"),
      path.join(process.cwd(), "dist", "release-manifest.json"),
      path.join(baseDir, "release-manifest.json"),
      path.join(baseDir, "..", "release-manifest.json"),
      path.join(baseDir, "dist", "release-manifest.json"),
    ];
    manifestData = loadReleaseManifest(candidatePaths, { production: process.env.NODE_ENV === "production" });
  } catch (manifestErr) {
    if (process.env.NODE_ENV === "production") throw manifestErr;
    console.warn("⚠️ Could not load release manifest provenance:", manifestErr);
  }

  const buildInfo = {
    version: process.env.npm_package_version || "0.0.0",
    commit: process.env.APP_COMMIT_SHA || process.env.SOURCE_COMMIT || manifestData?.commit || "unknown",
    branch: process.env.APP_BRANCH || manifestData?.branch || "unknown",
    builtAt: process.env.APP_BUILD_TIME || manifestData?.builtAt || "unknown",
    schemaVersion: manifestData?.schemaVersion ?? CURRENT_SCHEMA_VERSION,
  };

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/readyz", async (_req, res) => {
    const database = await checkDatabaseHealth();
    const formatted = formatReadinessResponse(database, buildInfo);
    return res.status(formatted.statusCode).json(formatted.body);
  });

  app.get("/version", (_req, res) => {
    res.json(buildInfo);
  });

  // Reaper: recover avatars stranded in an intermediate generation state.
  // The build runs as fire-and-forget work; if the process is recycled mid-build
  // a row can freeze in rigging/retargeting/baking_*, after which the status
  // endpoint reports "generating" forever and /retry used to refuse. This flips
  // stale rows to a terminal state: "done" if a model was already produced,
  // otherwise "failed" (which is retryable). Threshold is generous so it never
  // touches a genuinely in-progress build.
  async function reapStuckAvatars() {
    try {
      const [result]: any = await getPool().query(
        `UPDATE avatars
            SET generation_status = CASE WHEN model_url IS NOT NULL AND model_url <> '' THEN 'done' ELSE 'failed' END,
                generation_error  = CASE WHEN model_url IS NOT NULL AND model_url <> '' THEN generation_error
                                         ELSE 'Generation stalled and was auto-recovered by the reaper.' END
          WHERE generation_status IN ('rigging','retargeting','baking_clips','baking_sprites')
            AND created_at < (NOW() - INTERVAL 45 MINUTE)`
      );
      if (result?.affectedRows) {
        console.log(`[Reaper] Recovered ${result.affectedRows} stalled avatar(s).`);
      }
    } catch (err: any) {
      console.warn(`[Reaper] Failed to reap stuck avatars: ${err?.message || err}`);
    }
  }
  reapStuckAvatars();
  setInterval(reapStuckAvatars, 5 * 60 * 1000);

  // Initialize Stripe client safely
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let stripe: Stripe | null = null;
  if (stripeSecretKey && stripeSecretKey !== "MY_STRIPE_SECRET_KEY" && stripeSecretKey !== "") {
    stripe = new Stripe(stripeSecretKey);
  } else {
    console.warn("⚠️ STRIPE_SECRET_KEY is missing or invalid. Stripe-backed purchases are unavailable.");
  }

  // A paid print must never depend on a single webhook delivery. Reclaim a
  // stale submission and retry any payment-received Slant order idempotently.
  async function recoverPaidSlantOrders() {
    if (!slant3dConfigured()) return;
    try {
      await getPool().query(
        `UPDATE print_orders SET status = 'payment_received'
         WHERE provider = 'slant3d' AND status = 'submitting' AND updated_at < (NOW() - INTERVAL 10 MINUTE)`,
      );
      const [rows] = await getPool().query(
        `SELECT id, provider_pack_id FROM print_orders
         WHERE provider = 'slant3d' AND status = 'payment_received' ORDER BY updated_at ASC LIMIT 10`,
      ) as any;
      for (const row of rows as Array<{ id: number; provider_pack_id: string }>) {
        const [claimed] = await getPool().query(
          `UPDATE print_orders SET status = 'submitting' WHERE id = ? AND status = 'payment_received'`,
          [row.id],
        ) as any;
        if (!claimed?.affectedRows) continue;
        try {
          const processed = await submitSlantOrderIfDraft(String(row.provider_pack_id));
          const status = String(processed?.data?.status || processed?.data?.order?.status || "paid").toLowerCase();
          await getPool().query(
            `UPDATE print_orders SET status = ?, provider_payload_json = ? WHERE id = ?`,
            [status, JSON.stringify(processed?.data || processed || {}), row.id],
          );
        } catch (error: any) {
          console.error(`[Slant 3D recovery] Order ${row.id} failed:`, error?.message || error);
          await getPool().query(`UPDATE print_orders SET status = 'payment_received' WHERE id = ?`, [row.id]);
        }
      }
      const [activeRows] = await getPool().query(
        `SELECT id, provider_pack_id FROM print_orders
         WHERE provider = 'slant3d'
           AND status NOT IN ('awaiting_payment','payment_setup_failed','payment_received','submitting','fulfilled','failed','canceled','cancelled')
           AND updated_at < (NOW() - INTERVAL 4 MINUTE)
         ORDER BY updated_at ASC LIMIT 20`,
      ) as any;
      for (const row of activeRows as Array<{ id: number; provider_pack_id: string }>) {
        try {
          const current = await getSlantOrder(String(row.provider_pack_id));
          const status = String(current?.data?.status || current?.data?.order?.status || "processing").toLowerCase();
          await getPool().query(
            `UPDATE print_orders SET status = ?, provider_payload_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [status, JSON.stringify(current?.data || current || {}), row.id],
          );
        } catch (error: any) {
          console.warn(`[Slant 3D status] Order ${row.id} refresh failed:`, error?.message || error);
        }
      }
    } catch (error: any) {
      console.warn("[Slant 3D recovery] Sweep failed:", error?.message || error);
    }
  }
  void recoverPaidSlantOrders();
  setInterval(() => void recoverPaidSlantOrders(), 5 * 60 * 1000);

  async function recoverPaidPrintfulOrders() {
    if (!process.env.PRINTFUL_API_KEY) return;
    try {
      await getPool().query(
        `UPDATE pawprint_print_orders SET status = 'payment_received'
         WHERE status = 'submitting' AND updated_at < (NOW() - INTERVAL 10 MINUTE)`,
      );
      const [retryRows] = await getPool().query(
        `SELECT id, provider_order_id FROM pawprint_print_orders
         WHERE status = 'payment_received' ORDER BY updated_at ASC LIMIT 10`,
      ) as any;
      for (const row of retryRows as Array<{ id: number; provider_order_id: string }>) {
        const [claimed] = await getPool().query(
          `UPDATE pawprint_print_orders SET status = 'submitting' WHERE id = ? AND status = 'payment_received'`,
          [row.id],
        ) as any;
        if (!claimed?.affectedRows) continue;
        try {
          const confirmed = await confirmPrintfulOrderIfDraft(String(row.provider_order_id));
          await getPool().query(
            `UPDATE pawprint_print_orders SET status = ?, provider_payload_json = ? WHERE id = ?`,
            [String(confirmed?.status || "pending").toLowerCase(), JSON.stringify(confirmed || {}), row.id],
          );
        } catch (error: any) {
          console.error(`[Printful recovery] Order ${row.id} failed:`, error?.message || error);
          await getPool().query(`UPDATE pawprint_print_orders SET status = 'payment_received' WHERE id = ?`, [row.id]);
        }
      }
      const [activeRows] = await getPool().query(
        `SELECT id, provider_order_id FROM pawprint_print_orders
         WHERE status NOT IN ('awaiting_payment','payment_setup_failed','payment_received','submitting','fulfilled','failed','canceled','cancelled','draft')
           AND updated_at < (NOW() - INTERVAL 4 MINUTE)
         ORDER BY updated_at ASC LIMIT 20`,
      ) as any;
      for (const row of activeRows as Array<{ id: number; provider_order_id: string }>) {
        try {
          const current = await getPrintfulOrder(String(row.provider_order_id));
          await getPool().query(
            `UPDATE pawprint_print_orders SET status = ?, provider_payload_json = ? WHERE id = ?`,
            [String(current?.status || "processing").toLowerCase(), JSON.stringify(current || {}), row.id],
          );
        } catch (error: any) {
          console.warn(`[Printful status] Order ${row.id} refresh failed:`, error?.message || error);
        }
      }
    } catch (error: any) {
      console.warn("[Printful recovery] Sweep failed:", error?.message || error);
    }
  }
  void recoverPaidPrintfulOrders();
  setInterval(() => void recoverPaidPrintfulOrders(), 5 * 60 * 1000);

  // Raw-body authenticated v2 webhooks must be mounted before the global JSON
  // parser. Production factories are constructed only when their dark-launch
  // flags are explicitly enabled, so missing rollout secrets cannot break the
  // legacy application.
  if (isWagsV2Enabled()) {
    const wagsV2 = createWagsV2Production();
    app.use("/api/wags-v2", createWagsV2Router({
      service: wagsV2.service,
      resolveOwnerUuid: wagsV2.resolveOwnerUuid,
    }));
  }
  if (isStationeryV2Enabled()) {
    const stationeryV2 = createStationeryV2Production();
    app.use("/api/stationery-v2", createStationeryV2Router(
      stationeryV2.service,
      stationeryV2.routerDependencies,
    ));
  }

  // Stripe Webhook Route (must be registered BEFORE global express.json body parser)
  app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    
    if (!stripe || !stripeWebhookSecret) {
      console.warn("Stripe or Stripe Webhook Secret not configured. Webhook ignored.");
      return res.status(400).send("Webhook secret not configured");
    }

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig as string, stripeWebhookSecret);
    } catch (err: any) {
      console.error(`Webhook signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const handleSuccessfulPayment = async (session: Stripe.Checkout.Session) => {
      const metadata = session.metadata || {};

      if (metadata.type === "credit_purchase") {
        const result = await fulfillCreditPurchaseSession(session, undefined, grantPurchasedCredits);
        if (!result.applied) {
          console.log(`↩︎ Session ${session.id} already credited; webhook skipping.`);
        } else {
          console.log(`✅ Added ${result.credits} credits to ${metadata.userPhone} via Stripe purchase.`);
        }
      } else if (metadata.type === "pawprint_print_order" && metadata.printOrderId && metadata.userPhone) {
        const printOrderId = Number(metadata.printOrderId);
        const [claimed] = await getPool().query(
          `UPDATE pawprint_print_orders SET status = 'submitting', updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_phone = ? AND status IN ('awaiting_payment', 'payment_received')`,
          [printOrderId, metadata.userPhone],
        ) as any;
        if (!claimed?.affectedRows) {
          console.log(`↩︎ Printful Pawprint order ${printOrderId} already submitted or in progress.`);
          return;
        }
        const [rows] = await getPool().query(
          `SELECT provider_order_id FROM pawprint_print_orders WHERE id = ? AND user_phone = ? LIMIT 1`,
          [printOrderId, metadata.userPhone],
        ) as any;
        const providerOrderId = String(rows?.[0]?.provider_order_id || "");
        if (!providerOrderId) throw new Error(`Pawprint print order ${printOrderId} has no Printful order ID.`);
        try {
          const confirmed = await confirmPrintfulOrderIfDraft(providerOrderId);
          const status = String(confirmed?.status || "pending").toLowerCase();
          await getPool().query(
            `UPDATE pawprint_print_orders SET status = ?, provider_payload_json = ? WHERE id = ?`,
            [status, JSON.stringify(confirmed || {}), printOrderId],
          );
        } catch (error) {
          await getPool().query(`UPDATE pawprint_print_orders SET status = 'payment_received' WHERE id = ?`, [printOrderId]);
          throw error;
        }
      } else if (metadata.type === "customize_order" && metadata.customizeOrderId && metadata.userPhone) {
        // Marketplace Product Customizer P1 — mirrors pawprint_print_order exactly.
        await handleCustomizeOrderPayment(metadata as Record<string, string>);
      } else if (metadata.type === "slant3d_print_order" && metadata.printOrderId && metadata.userPhone) {
        const printOrderId = Number(metadata.printOrderId);
        const [claimed] = await getPool().query(
          `UPDATE print_orders SET status = 'submitting', updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_phone = ? AND status IN ('awaiting_payment', 'payment_received')`,
          [printOrderId, metadata.userPhone],
        ) as any;
        if (!claimed?.affectedRows) {
          console.log(`↩︎ Slant 3D print order ${printOrderId} already submitted or in progress.`);
          return;
        }
        const [rows] = await getPool().query(
          `SELECT provider_pack_id FROM print_orders WHERE id = ? AND user_phone = ? LIMIT 1`,
          [printOrderId, metadata.userPhone],
        ) as any;
        const publicOrderId = String(rows?.[0]?.provider_pack_id || "");
        if (!publicOrderId) throw new Error(`Slant 3D print order ${printOrderId} has no provider order ID.`);
        try {
          const processed = await submitSlantOrderIfDraft(publicOrderId);
          const providerStatus = String(processed?.data?.status || processed?.data?.order?.status || "paid").toLowerCase();
          await getPool().query(
            `UPDATE print_orders SET status = ?, provider_payload_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [providerStatus, JSON.stringify(processed?.data || processed || {}), printOrderId],
          );
        } catch (error) {
          await getPool().query(`UPDATE print_orders SET status = 'payment_received' WHERE id = ?`, [printOrderId]);
          throw error;
        }
      } else if (metadata.type === "marketplace_digital" && metadata.digitalOrderId && metadata.userPhone && metadata.listingId) {
        const digitalOrderId = Number(metadata.digitalOrderId);
        
        // 1. Mark order as paid
        await getPool().query(
          `UPDATE marketplace_digital_orders 
           SET status = 'paid', stripe_payment_intent = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [typeof session.payment_intent === 'string' ? session.payment_intent : null, digitalOrderId]
        );

        // 2. Grant entitlement idempotently
        const [oRows] = await getPool().query(
          `SELECT asset_id FROM marketplace_digital_orders WHERE id = ? LIMIT 1`,
          [digitalOrderId]
        ) as any;
        
        if (oRows && oRows.length > 0) {
          await getPool().query(
            `INSERT INTO marketplace_entitlements (user_phone, listing_id, asset_id, digital_order_id, granted_reason)
             VALUES (?, ?, ?, ?, 'purchase')
             ON DUPLICATE KEY UPDATE id = id`,
            [metadata.userPhone, metadata.listingId, oRows[0].asset_id, digitalOrderId]
          );
          console.log(`✅ Granted marketplace entitlement for listing ${metadata.listingId} to ${metadata.userPhone}.`);
        }
      } else {
        ignoreUnsupportedCheckoutSession(session);
      }
    };

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        console.log(`Checkout session completed: ${session.id}, status: ${session.payment_status}`);
        if (session.payment_status === "paid") {
          await handleSuccessfulPayment(session);
        }
      } else if (event.type === "checkout.session.async_payment_succeeded") {
        const session = event.data.object as Stripe.Checkout.Session;
        console.log(`Async payment succeeded: ${session.id}`);
        await handleSuccessfulPayment(session);
      } else if (event.type === "invoice.paid") {
        // Wags monthly renewal — update period dates and queue a new box plan
        const invoice = event.data.object as any;
        const stripeSubId: string = invoice.subscription ?? "";
        if (!stripeSubId) { res.json({ received: true }); return; }

        const [subRows]: any = await getPool().query(
          `SELECT id, user_phone, pet_id, species, tier, billing_period
           FROM wardrobe_wags_subscriptions WHERE stripe_subscription_id = ? LIMIT 1`,
          [stripeSubId],
        );
        if (!subRows?.length) { res.json({ received: true }); return; }
        const sub = subRows[0];

        // Update period dates from the invoice
        const periodStart = invoice.period_start ? new Date(invoice.period_start * 1000).toISOString().slice(0, 10) : null;
        const periodEnd   = invoice.period_end   ? new Date(invoice.period_end   * 1000).toISOString().slice(0, 10) : null;
        if (periodStart && periodEnd) {
          await getPool().query(
            `UPDATE wardrobe_wags_subscriptions
             SET current_period_start = ?, current_period_end = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [periodStart, periodEnd, sub.id],
          );
        }

        // Determine box month (YYYY-MM from period start)
        const boxMonth = (periodStart ?? new Date().toISOString()).slice(0, 7);

        // Skip if a box already exists for this month
        const [existingBox]: any = await getPool().query(
          `SELECT id FROM wardrobe_wags_boxes WHERE subscription_id = ? AND box_month = ? LIMIT 1`,
          [sub.id, boxMonth],
        );
        if (existingBox?.length) { res.json({ received: true }); return; }

        // Look up pet profile for the avatar to get breed details
        const [petRows]: any = await getPool().query(
          `SELECT name, kind FROM pets WHERE id = ? LIMIT 1`,
          [sub.pet_id],
        );
        const pet = petRows?.[0];

        // Create pending_review box then plan it in the background
        const [insertResult]: any = await getPool().query(
          `INSERT INTO wardrobe_wags_boxes (subscription_id, user_phone, box_month, status)
           VALUES (?, ?, ?, 'pending_review')`,
          [sub.id, sub.user_phone, boxMonth],
        );
        const boxId: number = insertResult.insertId;

        // Fire-and-forget Gemini planning — don't block the webhook response
        (async () => {
          try {
            const { previous_themes, previous_item_titles } = await getPriorBoxHistory(sub.id, getPool());
            const plan = await planWagsBox({
              box_month: boxMonth,
              tier: sub.tier,
              pet_species: sub.species,
              pet_breed: null,   // Phase 3.5: attach from pet_profiles
              pet_name: pet?.name ?? null,
              previous_themes,
              previous_item_titles,
            });
            await getPool().query(
              `UPDATE wardrobe_wags_boxes SET plan_json = ? WHERE id = ?`,
              [JSON.stringify(plan), boxId],
            );
            console.log(`[Wags] Box ${boxId} planned for subscription ${sub.id} (${boxMonth}).`);
          } catch (planErr: any) {
            console.error(`[Wags] Box ${boxId} planning failed:`, planErr?.message || planErr);
          }
        })();
      } else if (event.type === "customer.subscription.deleted") {
        // Wags cancellation — mark subscription as cancelled
        const stripeSub = event.data.object as any;
        await getPool().query(
          `UPDATE wardrobe_wags_subscriptions
           SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE stripe_subscription_id = ?`,
          [stripeSub.id],
        ).catch((e: any) => console.error("[Wags] cancel sync failed:", e?.message));
      }
    } catch (error: any) {
      console.error("Stripe fulfillment webhook failed:", error?.message || error);
      return res.status(500).json({ received: false, error: "Fulfillment submission failed." });
    }

    res.json({ received: true });
  });

  // Content Security Policy — strict but permits what the app needs
  app.use((_req, res, next) => {
    const bucketEndpointUrl = new URL(process.env.MEDIA_BUCKET_URL || "https://example.invalid");
    const bucketOrigin = bucketEndpointUrl.origin;
    // storage.ts builds public URLs virtual-host style: https://<bucket>.<endpoint-host>/...
    // That is a DIFFERENT origin from the raw endpoint, so both must be allowed or
    // every GLB fetch (model-viewer, GLTFLoader) is blocked by connect-src
    // ("TypeError: Failed to fetch" in the browser, avatar never renders).
    const bucketPublicOrigin = process.env.MEDIA_BUCKET_NAME
      ? `${bucketEndpointUrl.protocol}//${process.env.MEDIA_BUCKET_NAME}.${bucketEndpointUrl.host}`
      : bucketOrigin;
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://maps.googleapis.com https://maps.google.com https://*.googleapis.com https://ajax.googleapis.com https://cdn.jsdelivr.net",
        // ajax.googleapis.com serves <model-viewer>; cdn.jsdelivr.net serves the 8th Wall AR engine.
        "script-src-elem 'self' 'unsafe-inline' https://maps.googleapis.com https://maps.google.com https://ajax.googleapis.com https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://maps.googleapis.com",
        "worker-src 'self' blob:",
        `img-src 'self' blob: data: https: http://localhost:*`,
        `media-src 'self' blob: ${bucketOrigin} ${bucketPublicOrigin}`,
        // blob:/data: needed by model-viewer for AR (USDZ/scene-viewer export) and texture loading.
        `connect-src 'self' blob: data: https://maps.googleapis.com https://*.googleapis.com https://maps.google.com https://cdn.jsdelivr.net ${bucketOrigin} ${bucketPublicOrigin}`,
        "font-src 'self' https://fonts.gstatic.com data:",
        "frame-src 'self' https://*.google.com https://js.stripe.com",
      ].join("; ")
    );
    next();
  });

  app.use(await createProductionHermesApp());

  const defaultJsonParser = express.json({ limit: "1mb" });
  const uploadJsonParser = express.json({ limit: "50mb" });
  const largeJsonRoutes = new Set([
    "/api/avatars",
    "/api/image-to-3d",
    "/api/text-to-reference",
    "/api/pawprints/generate",
    "/api/profile/photo",
    "/api/profile/photos",
    "/api/bim/import-ifc",
    "/api/bim/propose",
    "/api/create-pipeline/generate-reference",
    "/api/reference-sessions/create",
    "/api/reference-sessions/replace-source",
    "/api/print-uploads",
  ]);
  app.use((req, res, next) => {
    // The exact production pet-sim app is mounted after its provider adapters
    // are constructed. Preserve its request stream for its scoped 6 MiB parser.
    if (isPetSimImageRoute(req.path)) return next();
    if (largeJsonRoutes.has(req.path)) return uploadJsonParser(req, res, next);
    return defaultJsonParser(req, res, next);
  });
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Canonical assets are dark-launched. Keep the entire surface unavailable
  // unless enabled server-side, and never mount it outside the normal JWT gate.
  app.use("/api/assets", requireCanonicalAssetsEnabled, requireAuth, assetsRouter);
  app.use("/api/reference-sessions", requireAuth, referenceSessionsRouter);
  app.use("/api/model-builds", requireAuth, modelBuildsRouter);
  app.use("/api/spatial-generator", requireAuth, spatialGeneratorRouter);
  app.use("/api/rig-pipeline", requireAuth, createRigPipelineRouter(getPool));
  app.use("/api/fur-bin", createFurBinRouter(getPool, { isAdmin: isUserAdmin }));

  // ── Paid pet GLB (CUSTOM_RIGGED_PET_GLB_V1) ────────────────────────────────
  // The production pet builder is always mounted. Deps are still built lazily
  // here so DB-disabled tooling does not construct eager singletons.
    const petGlbDeps = await buildPetGlbDeps(getPool, isUserAdmin);
    app.use("/api/pet-glb", requireAuth, createPetGenerationRouter(petGlbDeps));
    // Stripe is not a user — the webhook mounts outside requireAuth and needs
    // the raw body for signature verification.
    app.post(
      "/api/pet-glb/webhook",
      express.raw({ type: "application/json" }),
      createPetGlbWebhookHandler(petGlbDeps),
    );
    const petGlbRecovery = new PetGlbService(petGlbDeps);
    let petGlbRecoveryActive = false;
    const sweepPetGlbRecovery = async () => {
      if (petGlbRecoveryActive) return;
      petGlbRecoveryActive = true;
      try {
        const result = await petGlbRecovery.sweepStaleStages();
        if (result.claimed > 0) {
          console.log(`[pet-glb recovery] inspected=${result.inspected} claimed=${result.claimed} resumed=${result.resumed} active=${result.active} refunded=${result.refunded} retryable=${result.retryableErrors}`);
        }
      } catch (error: any) {
        console.error("[pet-glb recovery] sweep failed:", error?.message || error);
      } finally {
        petGlbRecoveryActive = false;
      }
    };
    void sweepPetGlbRecovery();
    setInterval(() => void sweepPetGlbRecovery(), 60 * 1000).unref();
    console.log("[pet-glb] mounted at /api/pet-glb");
  if (isModelBuildV3Enabled()) {
    // MG-1: recovery must run on a recurring interval, not only at startup.
    // A process recycle that kills a build worker mid-job leaves the lease to
    // expire with nothing ever calling recovery again, stranding the job in
    // processing/downloading/validating with credits already charged.
    let modelBuildRecoveryActive = false;
    const sweepModelBuildRecovery = async () => {
      if (modelBuildRecoveryActive) return;
      modelBuildRecoveryActive = true;
      try {
        await modelBuildService.recoverStaleBuilds();
      } catch (error: any) {
        console.error("[model-build recovery] sweep failed:", error?.message || error);
      } finally {
        modelBuildRecoveryActive = false;
      }
    };
    void sweepModelBuildRecovery();
    setInterval(() => void sweepModelBuildRecovery(), 60 * 1000).unref();
  }
  if (isRigPipelineV4Enabled()) {
    // MG-1: same recurring sweep for the V4 rig pipeline.
    const rigRecoveryService = new RigPipelineService(getPool);
    let rigRecoveryActive = false;
    const sweepRigPipelineRecovery = async () => {
      if (rigRecoveryActive) return;
      rigRecoveryActive = true;
      try {
        await rigRecoveryService.recoverStaleRigJobs();
      } catch (error: any) {
        console.error("[rig-pipeline recovery] sweep failed:", error?.message || error);
      } finally {
        rigRecoveryActive = false;
      }
    };
    void sweepRigPipelineRecovery();
    setInterval(() => void sweepRigPipelineRecovery(), 60 * 1000).unref();
  }
  if (isInhouseSpatialGeneratorEnabled()) {
    startSpatialGeneratorScheduler();
    console.log("[spatial-generator] Direct scheduler enabled - health check available at /api/spatial-generator/health");
  }

  app.post("/api/bim/import-ifc", requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (typeof req.body?.ifcBase64 !== "string") return res.status(400).json({ error: "Choose an IFC file to import." });
      const result = await getBlenderClient().convertIfc(req.body.ifcBase64);
      res.json(result);
    } catch (err: any) {
      console.error("[BIM] IFC import failed:", err.message);
      res.status(422).json({ error: err.message || "IFC import failed." });
    }
  });

  app.post("/api/bim/preflight", requireAuth, async (req: AuthedRequest, res) => {
    const mode = req.body?.mode as BimBuildMode;
    if (!req.body?.model || !["shell", "ifc"].includes(mode)) return res.status(400).json({ error: "Choose Shell or IFC and provide a model." });
    const verification = isBimV2Enabled()
      ? buildBimPreBuildVerification(req.body.model as BimModel, mode, req.body.calibration)
      : preflightBimModel(req.body.model as BimModel);
    res.status(verification.passed ? 200 : 422).json({ verification, mode, price: bimModelCost(mode) });
  });

  app.post("/api/bim/build", requireAuth, async (req: AuthedRequest, res) => {
    let creditReservationId: string | null = null;
    try {
      const mode = req.body?.mode as BimBuildMode;
      if (!req.body?.model || typeof req.body.model !== "object" || !["shell", "ifc"].includes(mode)) return res.status(400).json({ error: "Choose Shell or IFC and provide a model." });
      const model = req.body.model as BimModel;

      // The server repeats preflight even when the UI already passed it. No charge or build occurs before this gate.
      const basePreflight = preflightBimModel(model);
      const accuracyPreflight = isBimV2Enabled()
        ? buildBimPreBuildVerification(model, mode, req.body.calibration)
        : null;
      const preflight = accuracyPreflight || basePreflight;
      if (!preflight.passed) return res.status(422).json({ error: "Pre-build verification failed.", preflight });

      const userPhone = req.user!.phone;
      const isAdmin = await isUserAdmin(userPhone);
      const price = bimModelCost(mode);
      if (!isAdmin) {
        creditReservationId = await reserveCredits(userPhone, price, `bim_${mode}_build`);
        if (!creditReservationId) return res.status(402).json({ error: `You need ${price} credits for this ${mode === "ifc" ? "IFC/BIM model" : "Shell model"}.`, price });
      }

      // Persist verified artifacts to the Backblaze bucket so users can
      // re-download from "My models". Persistence is best-effort: a storage
      // outage must never fail a build the user already paid for.
      const persistBuild = async (artifacts: { glbBase64?: string; ifcBase64?: string; sidecar?: unknown; elementCount: number }) => {
        try {
          const glbUrl = artifacts.glbBase64 ? await uploadBase64Binary(artifacts.glbBase64, "model/gltf-binary", "bim/glb") : null;
          const ifcUrl = artifacts.ifcBase64 ? await uploadBase64Binary(artifacts.ifcBase64, "application/x-step", "bim/ifc") : null;
          const sidecarUrl = artifacts.sidecar ? await uploadBase64Binary(Buffer.from(JSON.stringify(artifacts.sidecar)).toString("base64"), "application/json", "bim/sidecars") : null;
          const record = {
            id: crypto.randomUUID(), userPhone, name: model.name || "Scaled building", mode, price,
            glbUrl, ifcUrl, sidecarUrl, elementCount: artifacts.elementCount,
            sizeBytes: Math.round(((artifacts.glbBase64?.length || 0) + (artifacts.ifcBase64?.length || 0)) * 0.75),
          };
          await insertBimBuild(record);
          return record;
        } catch (persistErr: any) {
          console.error("[BIM] build persisted delivery-only (storage failed):", persistErr?.message || persistErr);
          return null;
        }
      };

      if (mode === "shell") {
        const shell = await buildAndVerifyShell(model);
        const shellBounds = shell.verification.bounds as { min: number[]; max: number[] } | null;
        const shellSize = shellBounds ? shellBounds.max.map((value, axis) => value - shellBounds.min[axis]) : [];
        const accuracyPostBuild = accuracyPreflight ? buildBimPostBuildVerification("shell", accuracyPreflight, {
          format: "glb-shell",
          bounds: shellBounds ? { min: shellBounds.min as any, max: shellBounds.max as any } : null,
          dimensionsMeters: shellSize.length === 3 ? { width: shellSize[0], height: shellSize[1], depth: shellSize[2] } : undefined,
          geometryValid: shell.verification.passed === true,
        }) : null;
        if (accuracyPostBuild && !accuracyPostBuild.passed) throw new Error("Shell failed calibrated post-build verification");
        const saved = await persistBuild({ glbBase64: shell.glbBase64, elementCount: model.elements.length });
        return res.json({ success: true, mode, price, preflight, postBuild: accuracyPostBuild || shell.verification, glb_base64: shell.glbBase64, saved, balance: await getCreditBalance(userPhone) });
      }

      const workerModel = accuracyPreflight?.coordinateReference
        ? { ...model, coordinateReference: accuracyPreflight.coordinateReference }
        : model;
      const result = await getBlenderClient().exportIfc(workerModel as any);
      const semanticElements = result.sidecar?.elements || [];
      const intendedDimensions = basePreflight.bounds
        ? basePreflight.bounds.max.map((value, axis) => value - basePreflight.bounds!.min[axis]).sort((a, b) => a - b)
        : [];
      const builtDimensions = [...(result.sidecar?.glbBounds?.dimensions || [])].sort((a: number, b: number) => a - b);
      const dimensionsWithinTolerance = intendedDimensions.length === 3 && builtDimensions.length === 3
        && intendedDimensions.every((value, axis) => Math.abs(builtDimensions[axis] - value) <= Math.max(0.25, value * 0.02));
      const postBuild = {
        stage: "post-build",
        format: "ifc4-bim",
        passed: result.exportReport?.schema === "IFC4"
          && result.exportReport?.exportedElementCount === model.elements.length
          && result.sidecar?.elementCount === model.elements.length
          && semanticElements.every((item: any) => item.globalId)
          && dimensionsWithinTolerance,
        schema: result.exportReport?.schema,
        elementCount: result.sidecar?.elementCount,
        globalIdsVerified: semanticElements.filter((item: any) => item.globalId).length,
        geometryElements: semanticElements.filter((item: any) => item.hasGeometry).length,
        sourceHash: result.sidecar?.sourceHash,
        intendedDimensions,
        builtDimensions,
        dimensionsWithinTolerance,
      };
      if (!postBuild.passed) throw new Error("IFC failed post-build semantic verification");
      const glbDimensions = result.sidecar?.glbBounds?.dimensions || [];
      const accuracyPostBuild = accuracyPreflight ? buildBimPostBuildVerification("ifc", accuracyPreflight, {
        format: "ifc4-bim",
        bounds: result.sidecar?.glbBounds || null,
        dimensionsMeters: glbDimensions.length === 3 ? { width: glbDimensions[0], height: glbDimensions[1], depth: glbDimensions[2] } : undefined,
        schema: result.sidecar?.schema || result.exportReport?.schema,
        sourceUnit: result.sidecar?.sourceUnit,
        metersPerUnit: result.sidecar?.metersPerUnit,
        elementCount: result.sidecar?.elementCount,
        globalIdCount: result.sidecar?.globalIdCount,
        uniqueGlobalIdCount: result.sidecar?.uniqueGlobalIdCount,
        relationshipCount: result.sidecar?.relationshipCount,
        voidRelationshipCount: result.sidecar?.voidRelationshipCount,
        fillingRelationshipCount: result.sidecar?.fillingRelationshipCount,
        propertySetElementCount: result.sidecar?.propertySetElementCount,
        storeyCount: result.sidecar?.storeyCount,
        coordinateReference: result.sidecar?.coordinateReference,
        placementsFinite: result.sidecar?.placementsFinite,
        roundTripPassed: result.exportReport?.roundTripPassed,
        proxyCount: result.sidecar?.proxyCount,
      }) : null;
      if (accuracyPostBuild && !accuracyPostBuild.passed) throw new Error("IFC failed calibrated round-trip verification");
      const saved = await persistBuild({ glbBase64: result.glb_base64, ifcBase64: result.ifc_base64, sidecar: result.sidecar, elementCount: model.elements.length });
      res.json({ ...result, mode, price, preflight, postBuild: accuracyPostBuild || postBuild, saved, balance: await getCreditBalance(userPhone) });
    } catch (err: any) {
      let refundPending = false;
      if (creditReservationId) {
        try {
          await refundReservedCredits(creditReservationId);
          creditReservationId = null;
        } catch (refundError) {
          refundPending = true;
          console.error("[BIM] refund failed:", refundError);
        }
      }
      console.error("[BIM] verified build failed:", err.message);
      const disposition = refundPending ? "The automatic credit return is pending support reconciliation." : "Credits were returned.";
      res.status(refundPending ? 500 : 422).json({ error: `${err.message || "Model build failed."} ${disposition}`, refundPending });
    }
  });

  // Saved verified builds for the "My models" re-download list.
  app.get("/api/bim/builds", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const builds = await listBimBuilds(req.user!.phone);
      res.json({ builds });
    } catch (err: any) {
      console.error("[GET /api/bim/builds] Error:", err?.message || err);
      res.json({ builds: [] }); // degrade gracefully — never block the builder UI
    }
  });

  app.post("/api/bim/export-ifc", requireAuth, (_req, res) => res.status(410).json({ error: "Use the verified BIM build flow." }));

  const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: "Too many requests from this IP, please try again after a minute" } });
  const bimProposalLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, message: { error: "Too many building proposal requests; please wait one minute." } });
  const randyChatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: "Randy needs a short pause; please wait one minute." } });
  const printUploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: any) => req.user?.phone || "unauthenticated",
    message: { success: false, error: "Too many model uploads. Please try again later." },
  });
  app.use("/api/auth/login", authLimiter);
  app.use("/api/auth/signup", authLimiter);
  app.use("/api/create-video", authLimiter);

  // SnapGen (pic-to-3D storefront) routes — see server/snapgen.ts
  registerSnapgenRoutes(app);

  // GUARD RULE (§6.1): Any authentication guard mounted on a shared prefix
  // (like "/api") MUST be strictly path-scoped to the namespaces it intends to protect.
  // Do NOT mount a blanket `requireAuth` on "/api" or you will inadvertently block
  // public routes (like /api/auth/login and /api/auth/signup). Furthermore, ensure
  // public routes are registered BEFORE any shared-prefix catch-all or guard to ensure
  // they remain reachable regardless of registration order.
  // 
  // Guard every Animator route, including legacy aliases. The router remains
  // mounted on /api so unrelated public /api routes are not intercepted.
  const animatorAliasPrefixes = [
    "/animator", "/scenes", "/rig", "/retarget", "/repurpose",
    "/lipsync", "/reconstruct", "/bake", "/rig-profiles",
  ];
  app.use(
    "/api",
    (req, res, next) => {
      if (animatorAliasPrefixes.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
        return requireAuth(req as AuthedRequest, res, next);
      }
      return next();
    },
    animatorRouter
  );

  // Studio AI Animation Pipeline — proxy /api/studio/* → Python FastAPI on port 8001
  app.use(
    "/api/studio",
    (req, res, next) => requireAuth(req as AuthedRequest, res, next),
    studioRouter
  );

  app.use(
    "/api",
    (req, res, next) => {
      if (req.path.startsWith("/refunds") || req.path.startsWith("/admin/refunds")) {
        return requireAuth(req as AuthedRequest, res, next);
      }
      return next();
    },
    refundRouter
  );

  app.use(
    "/api/refunds",
    (req, res, next) => requireAuth(req as AuthedRequest, res, next),
    refundRouter
  );

  // Tenant animator artifacts are never exposed through a directory-wide
  // static mount. Public curated sounds live under dist/public and are served
  // by the normal SPA static layer later.
  app.get("/animator-files/originals/:assetId/:filename", requireAuth, (req: AuthedRequest, res) => {
    try {
      const assetId = z.string().uuid().parse(req.params.assetId);
      const filename = z.string().regex(/^[A-Za-z0-9_.-]+\.(?:glb|gltf)$/).parse(req.params.filename);
      const metadataPath = resolveWithinWorkspace(`originals/${assetId}/metadata.json`);
      if (!fs.existsSync(metadataPath)) return res.status(404).json({ error: "Asset not found." });
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (metadata.userPhone !== req.user!.phone || metadata.originalFilename !== filename) {
        return res.status(403).json({ error: "Forbidden" });
      }
      return res.sendFile(resolveWithinWorkspace(`originals/${assetId}/${filename}`));
    } catch {
      return res.status(404).json({ error: "Asset not found." });
    }
  });
  app.get("/animator-files/outputs/:assetId/:filename", requireAuth, (req: AuthedRequest, res) => {
    try {
      const assetId = z.string().uuid().parse(req.params.assetId);
      const filename = z.string().regex(/^[A-Za-z0-9_.-]+\.(?:glb|gltf)$/).parse(req.params.filename);
      const metadataPath = resolveWithinWorkspace(`originals/${assetId}/metadata.json`);
      if (!fs.existsSync(metadataPath)) return res.status(404).json({ error: "Output not found." });
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (metadata.userPhone !== req.user!.phone) return res.status(403).json({ error: "Forbidden" });
      return res.sendFile(resolveWithinWorkspace(`outputs/${assetId}/${filename}`));
    } catch {
      return res.status(404).json({ error: "Output not found." });
    }
  });
  app.get("/animator-files/recordings/:filename", requireAuth, (req: AuthedRequest, res) => {
    const parsed = /^([0-9a-f-]{36})\.(webm|mp4)$/i.exec(String(req.params.filename));
    if (!parsed) return res.status(404).json({ error: "Recording not found." });
    const recording = getOwnedRecording(parsed[1], req.user!.phone);
    if (!recording || recording.fileName !== req.params.filename) return res.status(404).json({ error: "Recording not found." });
    return res.sendFile(resolveWithinWorkspace(`recordings/${recording.fileName}`));
  });
  app.get("/animator-files/screenshots/:filename", requireAuth, (req: AuthedRequest, res) => {
    const ownerKey = req.user!.phone.replace(/[^A-Za-z0-9]/g, "");
    const filename = String(req.params.filename);
    if (!new RegExp(`^screenshot_[0-9]+_${ownerKey}\\.png$`).test(filename)) {
      return res.status(404).json({ error: "Screenshot not found." });
    }
    try { return res.sendFile(resolveWithinWorkspace(`screenshots/${filename}`)); }
    catch { return res.status(404).json({ error: "Screenshot not found." }); }
  });
  
  if (process.env.ANIMATOR_WORKER_ENABLED !== "false") {
    startAnimatorWorker();
  }

  // requireAuth so req.user is populated for the key. (H2)
  const paidLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: any) => req.user?.phone || "anon",
    message: { error: "Too many requests. Please slow down and try again in a minute." },
  });
  /**
   * Kill-switch + per-user daily-cap guard for a paid AR endpoint (H2/H7).
   * Returns true if the caller may proceed. Call AFTER cache/ownership checks
   * so cached hits and validation failures never consume paid quota.
   */
  const guardPaidCall = async (
    ep: PaidEndpoint,
    req: AuthedRequest,
    res: express.Response,
  ): Promise<boolean> => {
    if (!isEndpointEnabled(ep)) {
      res.status(503).json({ error: "This feature is temporarily unavailable. Please try again later.", endpoint: ep });
      return false;
    }
    const used = await bumpDailyUsage(req.user!.phone, ep);
    if (!withinDailyCap(ep, used)) {
      const cap = dailyCapFor(ep);
      res.status(429).json({ error: `Daily limit reached (${cap}/day for ${ep}). Please try again tomorrow.`, endpoint: ep, cap });
      return false;
    }
    return true;
  };

  // ---------------------------------------------------------------------------
  // Authentication: email/password + session tokens (JWT)
  // ---------------------------------------------------------------------------

  // Step 1: create an account with email + password (profile still incomplete).
  app.post("/api/auth/signup", async (req, res) => {
    try {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const password = String(req.body?.password || "");
      const confirmPassword = String(req.body?.confirmPassword || "");
      const acceptedTerms = req.body?.acceptedTerms === true;

      if (!email || !password || !confirmPassword) {
        return res.status(400).json({ error: "Email, password, and confirmation are required." });
      }
      if (!acceptedTerms) {
        return res.status(400).json({ error: "Please agree to the Terms and Privacy Policy before creating your account." });
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ error: "Please enter a valid email address." });
      }
      if (password !== confirmPassword) {
        return res.status(400).json({ error: "Passwords do not match." });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters." });
      }

      const passwordHash = hashPassword(password);
      const user = await createUserByEmail(email, passwordHash, TERMS_VERSION);
      const token = signToken({ phone: user.phone, uid: user.id });
      res.json({ success: true, token, user: toPublicUser(user, TERMS_VERSION) });
    } catch (err: any) {
      if (err instanceof EmailTakenError) {
        return res.status(409).json({ error: err.message });
      }
      console.error("signup error:", err?.message || err);
      res.status(500).json({ error: "Could not create your account. Please try again." });
    }
  });

  // Step 2: required profile setup (name, birthdate, city, pets). The first
  // avatar is free; no sign-up PupCoins are issued.
  app.post("/api/auth/complete-profile", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const fullName = String(req.body?.fullName || "").trim();
      const birthdate = String(req.body?.birthdate || "");
      const city = String(req.body?.city || "").trim();

      if (!fullName || !birthdate || !city) {
        return res.status(400).json({ error: "Full name, birthdate, and city are required." });
      }

      if (!isAtLeastAge(birthdate, 13)) {
         return res.status(400).json({ error: "You must be at least 13 years old to use Paws & Memories." });
      }

      const user = await completeUserProfile(req.user!.phone, fullName, birthdate, city);

      const pets = req.body?.pets;
      if (Array.isArray(pets)) {
        for (const pet of pets) {
          if (pet.name && pet.kind) {
            await addPet(req.user!.phone, pet.name, pet.kind);
          }
        }
      }

      if (user.profile_complete) await claimDailyStreak(req.user!.phone);
      const refreshed = await findUserByPhone(req.user!.phone);
      res.json({ success: true, user: toPublicUser(refreshed, TERMS_VERSION) });
    } catch (err: any) {
      console.error("complete-profile error:", err?.message || err);
      res.status(500).json({ error: "Could not save your profile. Please try again." });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const password = String(req.body?.password || "");
      if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

      // ORDER BY id makes the lookup deterministic even if legacy duplicate-email rows still exist.
      const [rows] = await getPool().query("SELECT * FROM users WHERE email = ? ORDER BY id LIMIT 1", [email]) as any;
      if (!rows || rows.length === 0) {
        return res.status(401).json({ error: "Invalid email or password." });
      }
      const user = rows[0];
      if (!user.password_hash || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: "Invalid email or password." });
      }

      const token = signToken({ phone: user.phone, uid: user.id });
      if (user.profile_complete) await claimDailyStreak(user.phone);
      const refreshed = await findUserByPhone(user.phone);
      res.json({ success: true, token, user: toPublicUser(refreshed, TERMS_VERSION) });
    } catch (err: any) {
      console.error("login error:", err);
      res.status(500).json({ error: "Login failed. Please try again." });
    }
  });

  // --- Password reset (self-serve, email link via Resend) ------------------
  app.use("/api/auth/forgot-password", authLimiter);
  app.use("/api/auth/reset-password", authLimiter);

  app.post("/api/auth/forgot-password", async (req, res) => {
    // Always respond with the same generic 200 — never reveal whether an email
    // is registered (prevents account enumeration).
    const generic = { success: true, message: "If that email is registered, a reset link is on its way." };
    try {
      const email = String(req.body?.email || "").trim().toLowerCase();
      if (email) {
        const user = await findUserByEmail(email);
        if (user) {
          const { raw, hash } = generateResetToken();
          const expiresAt = new Date(Date.now() + 45 * 60 * 1000); // 45 minutes
          await createPasswordReset(user.phone, hash, expiresAt);
          const appUrl = process.env.APP_URL || "https://pawsome3d.com";
          const link = `${appUrl}/reset-password?token=${raw}`;
          await sendMail({
            to: email,
            subject: "Reset your Pawsome3D password",
            html: `<div style="font-family:system-ui,Arial,sans-serif;line-height:1.6">
              <h2>Reset your Pawsome3D password</h2>
              <p>We received a request to reset your password. Click the button below to choose a new one.</p>
              <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#442a22;color:#fff;border-radius:8px;text-decoration:none">Choose a new password</a></p>
              <p style="color:#666;font-size:13px">This link expires in 45 minutes and can be used once. If you didn't request this, you can safely ignore this email.</p>
            </div>`,
            replyTo: "rob@stelar.host",
          });
        }
      }
    } catch (err: any) {
      console.error("forgot-password error:", err?.message || err);
    }
    return res.json(generic);
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const token = String(req.body?.token || "");
      const newPassword = String(req.body?.newPassword || "");
      if (!token || !newPassword) {
        return res.status(400).json({ error: "Token and new password are required." });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters." });
      }
      const reset = await resetPasswordWithToken(hashResetToken(token), hashPassword(newPassword));
      if (!reset) {
        return res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });
      }
      return res.json({ success: true, message: "Your password has been updated. You can now sign in." });
    } catch (err: any) {
      console.error("reset-password error:", err?.message || err);
      return res.status(500).json({ error: "Could not reset your password. Please try again." });
    }
  });

  app.post("/api/auth/accept-terms", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const user = await acceptTermsVersion(req.user!.phone, TERMS_VERSION);
      res.json({ success: true, user: toPublicUser(user, TERMS_VERSION) });
    } catch (err: any) {
      console.error("accept-terms error:", err?.message || err);
      res.status(500).json({ error: "Could not save your acceptance. Please try again." });
    }
  });

  // Public per-site config. `deployTarget` tells the frontend which experience
  // this deployment serves: "main" (pawsome3d.com) or "warehouse" (mypets.cc).
  app.get("/api/config", (_req, res) => {
    res.json({
      deployTarget: process.env.DEPLOY_TARGET || "main",
      termsVersion: TERMS_VERSION,
      // Address the 3D-print request form emails to. Falls back to the admin email.
      printEmail: process.env.PRINT_REQUEST_EMAIL || process.env.ADMIN_EMAIL || "",
    });
  });

  // Upload a model file for a 3D-print request. Accepts a base64 data URL, mirrors
  // it to object storage, and returns a durable URL to include in the request
  // email. (GLB/OBJ/STL supported; the client caps size before sending.)
  app.post("/api/print-uploads", requireAuth, printUploadLimiter, async (req: AuthedRequest, res) => {
    try {
      const { fileBase64, mime } = req.body || {};
      const validated = validatePrintUpload(fileBase64, mime);
      const dailyCount = await bumpDailyUsage(req.user!.phone, "print_upload");
      if (dailyCount > 20) {
        return res.status(429).json({ success: false, error: "Today's model upload limit has been reached." });
      }
      const url = await uploadBase64Binary(validated.base64, validated.mime, "print-requests");
      res.json({ success: true, url });
    } catch (err: any) {
      if (err instanceof PrintUploadValidationError) {
        return res.status(400).json({ success: false, error: err.message });
      }
      console.error("[POST /api/print-uploads] Error:", err?.message || err);
      res.status(500).json({ success: false, error: "Upload failed." });
    }
  });

  app.get("/api/me", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const user = await findUserByPhone(req.user!.phone);
      if (!user) return res.status(404).json({ error: "User not found." });
      res.json({ user: toPublicUser(user, TERMS_VERSION) });
    } catch (err: any) {
      console.error("me error:", err?.message || err);
      res.status(500).json({ error: "Could not load your account." });
    }
  });

  // Help & Support — submits a support request email to rob@stelar.host.
  app.post("/api/help", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { message } = req.body || {};
      if (!message || typeof message !== "string" || message.trim().length < 10) {
        return res.status(400).json({ error: "Please describe your issue (at least 10 characters)." });
      }
      const user = await findUserByPhone(req.user!.phone);
      const userName = user?.full_name || "Unknown";
      const userEmail = user?.email || "no-email";
      const emailSent = await sendMail({
        to: "rob@stelar.host",
        subject: `[Pawsome3D Help] ${userName} needs support`,
        html: `<h2>Support Request</h2>
<p><strong>User:</strong> ${userName} (${userEmail})</p>
<p><strong>Message:</strong></p>
<p>${message.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`,
        replyTo: userEmail,
      });
      if (emailSent) {
        res.json({ success: true, message: "Your support request has been sent. We'll get back to you soon!" });
      } else {
        // Fallback: return a mailto link if mailer is unconfigured
        res.json({
          success: true,
          mailto: `mailto:rob@stelar.host?subject=${encodeURIComponent(`[Pawsome3D Help] ${userName}`)}&body=${encodeURIComponent(message)}`,
          message: "Email system is offline. Please email rob@stelar.host directly.",
        });
      }
    } catch (err: any) {
      console.error("[POST /api/help] Error:", err?.message || err);
      res.status(500).json({ error: "Could not send support request. Please email rob@stelar.host directly." });
    }
  });

  // Storage accounting: usage, purchase cold storage
  const GB = 1024 * 1024 * 1024;
  const HOT_LIMIT = 50 * 1024 * 1024; // 50 MB

  app.get("/api/storage/usage", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const usage = await getStorageUsage(req.user!.phone);
      res.json(usage);
    } catch (err: any) {
      console.error("[GET /api/storage/usage] Error:", err?.message || err);
      res.status(500).json({ error: "Could not load storage usage." });
    }
  });

  app.post("/api/storage/purchase-gb", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { requestId } = req.body || {};
      if (!requestId || typeof requestId !== "string") {
        return res.status(400).json({ error: "requestId is required for idempotency." });
      }
      const result = await purchaseColdStorage(req.user!.phone, requestId);
      if (!result.success) {
        return res.status(402).json({ error: result.error || "Could not purchase storage." });
      }
      const usage = await getStorageUsage(req.user!.phone);
      const user = await findUserByPhone(req.user!.phone);
      res.json({ success: true, usage, user: toPublicUser(user) });
    } catch (err: any) {
      console.error("[POST /api/storage/purchase-gb] Error:", err?.message || err);
      res.status(500).json({ error: "Could not complete storage purchase." });
    }
  });

  app.get("/api/voice-clones", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const assets = await listVoiceCloneAssets(req.user!.phone);
      res.json({ assets });
    } catch (err: any) {
      console.error("[GET /api/voice-clones] Error:", err?.message || err);
      res.status(500).json({ error: "Could not load voice clone files." });
    }
  });

  app.post("/api/voice-clones", requireAuth, async (req: AuthedRequest, res) => {
    let creditReservationId: string | null = null;
    try {
      const name = String(req.body?.name || "Voice clone").trim().slice(0, 120);
      const audioBase64 = String(req.body?.audioBase64 || "");
      const mimeType = String(req.body?.mimeType || "");
      const voiceConsent = req.body?.voiceConsent === true;
      if (!voiceConsent) {
        return res.status(422).json({ error: "Voice clone consent is required before we can save this voice." });
      }
      if (!audioBase64 || !mimeType.startsWith("audio/")) {
        return res.status(400).json({ error: "Please upload an audio file." });
      }
      const rawBase64 = audioBase64.startsWith("data:") ? audioBase64.split(",")[1] || "" : audioBase64;
      const bytes = Buffer.byteLength(rawBase64, "base64");
      if (bytes <= 0 || bytes > 25 * 1024 * 1024) {
        return res.status(400).json({ error: "Voice files must be audio and 25 MB or smaller." });
      }
      const isAdmin = await isUserAdmin(req.user!.phone);
      if (!isAdmin) {
        creditReservationId = await reserveCredits(req.user!.phone, CREDIT_PRICES.VOICE_CLONE, "voice_clone");
        if (!creditReservationId) {
          return res.status(402).json({ error: `You need ${CREDIT_PRICES.VOICE_CLONE} credits to create a voice clone.` });
        }
      }
      const audioUrl = await uploadBase64Binary(audioBase64, mimeType, "sounds/voice-clones");
      const usage = await recordStorageAddHot(req.user!.phone, bytes);
      const asset = await createVoiceCloneAsset(req.user!.phone, {
        name: name || "Voice clone",
        audioUrl,
        mimeType,
        bytes,
        voiceConsent: true,
      });
      const user = await findUserByPhone(req.user!.phone);
      res.status(201).json({ success: true, asset, storage: usage, user: toPublicUser(user, TERMS_VERSION) });
    } catch (err: any) {
      if (creditReservationId) {
        try { await refundReservedCredits(creditReservationId); } catch {}
      }
      console.error("[POST /api/voice-clones] Error:", err?.message || err);
      res.status(500).json({ error: "Could not save the voice clone. Your credits were returned." });
    }
  });

  // Profile — get full profile data
  app.get("/api/profile", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const user = await findUserByPhone(req.user!.phone);
      if (!user) return res.status(404).json({ error: "User not found." });
      const usage = await getStorageUsage(req.user!.phone);
      const history = await getCreditHistory(req.user!.phone, 25);
      const publicUser = toPublicUser(user, TERMS_VERSION);
      // Generate referral code if not set
      if (!publicUser.referralCode) {
        const code = await generateReferralCode(req.user!.phone);
        publicUser.referralCode = code;
      }
      res.json({
        user: publicUser,
        storage: usage,
        creditHistory: history,
      });
    } catch (err: any) {
      console.error("[GET /api/profile] Error:", err?.message || err);
      res.status(500).json({ error: "Could not load profile." });
    }
  });

  // Profile — update editable fields
  app.patch("/api/profile", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { fullName, bio, city, zip, notificationPrefs } = req.body || {};
      await updateUserProfile(req.user!.phone, { fullName, bio, city, zip, notificationPrefs });
      // Check if ZIP was added (triggers profile bonus check)
      if (zip) await checkAndGrantProfileBonus(req.user!.phone);
      const user = await findUserByPhone(req.user!.phone);
      res.json({ success: true, user: toPublicUser(user, TERMS_VERSION) });
    } catch (err: any) {
      console.error("[PATCH /api/profile] Error:", err?.message || err);
      res.status(500).json({ error: "Could not update profile." });
    }
  });

  // Profile — request data export
  app.post("/api/profile/request-data", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const user = await findUserByPhone(req.user!.phone);
      const userName = user?.full_name || "User";
      const userEmail = user?.email || "no-email";
      await sendMail({
        to: "rob@stelar.host",
        subject: `[Pawsome3D] Data Export Request — ${userName}`,
        html: `<h2>Data Export Request</h2><p>User: ${userName} (${userEmail})</p><p>Phone key: ${req.user!.phone}</p>`,
        replyTo: userEmail,
      });
      res.json({ success: true, message: "Data export request submitted. You'll hear from us shortly." });
    } catch (err: any) {
      console.error("[POST /api/profile/request-data] Error:", err?.message || err);
      res.status(500).json({ error: "Could not submit request." });
    }
  });

  // Profile — request account deletion
  app.post("/api/profile/request-delete", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const user = await findUserByPhone(req.user!.phone);
      const userName = user?.full_name || "User";
      const userEmail = user?.email || "no-email";
      await sendMail({
        to: "rob@stelar.host",
        subject: `[Pawsome3D] Account Deletion Request — ${userName}`,
        html: `<h2>Account Deletion Request</h2><p>User: ${userName} (${userEmail})</p><p>Phone key: ${req.user!.phone}</p>`,
        replyTo: userEmail,
      });
      res.json({ success: true, message: "Deletion request submitted. We'll process it within 30 days." });
    } catch (err: any) {
      console.error("[POST /api/profile/request-delete] Error:", err?.message || err);
      res.status(500).json({ error: "Could not submit request." });
    }
  });

  // Referral — get my code and stats
  app.get("/api/referral", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const code = await generateReferralCode(req.user!.phone);
      const [refs] = await getPool().query(
        `SELECT COUNT(*) AS c FROM referrals WHERE referrer_phone = ? AND credited_at IS NOT NULL`,
        [req.user!.phone]
      ) as any;
      res.json({
        code,
        link: `/r/${code}`,
        totalReferrals: refs?.[0]?.c || 0,
      });
    } catch (err: any) {
      console.error("[GET /api/referral] Error:", err?.message || err);
      res.status(500).json({ error: "Could not load referral info." });
    }
  });

  // Capture referral at signup
  app.post("/api/referral/claim", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { code } = req.body || {};
      if (!code || typeof code !== "string") return res.status(400).json({ error: "Referral code required." });
      await recordReferral(code, req.user!.phone);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[POST /api/referral/claim] Error:", err?.message || err);
      res.status(500).json({ error: "Could not record referral." });
    }
  });

  // Share reward claim
  app.post("/api/share/claim", requireAuth, async (req: AuthedRequest, res) => {
    return res.status(410).json({
      success: false,
      error: "Share rewards are disabled because a browser share cannot be independently verified.",
    });
  });

  // Per-user wardrobe catalog and selections
  app.get("/api/wardrobe", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT item_id FROM wardrobe_selections WHERE user_phone = ? ORDER BY created_at ASC`,
        [req.user!.phone],
      ) as any;
      res.json({ catalog: WARDROBE_CATALOG, selected: rows.map((row: any) => row.item_id) });
    } catch (error: any) {
      console.error("[wardrobe] read failed:", error?.message || error);
      res.status(500).json({ error: "Could not load the wardrobe." });
    }
  });

  app.put("/api/wardrobe", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const requested: unknown[] = Array.isArray(req.body?.selected) ? req.body.selected : [];
      const selected: string[] = [...new Set(requested.filter((id): id is string => typeof id === "string"))];
      if (selected.length > 15) return res.status(400).json({ error: "Choose at most 15 wardrobe items." });
      if (selected.some((id) => !WARDROBE_ITEM_IDS.has(id))) return res.status(400).json({ error: "Unknown wardrobe item." });
      const selectedExclusive = selected.filter((id) => WAGS_EXCLUSIVE_ITEM_IDS.has(id));
      if (selectedExclusive.length) {
        const ownedExclusive = await getOwnedWardrobeItems(getPool(), req.user!.phone);
        if (selectedExclusive.some((id) => !ownedExclusive.has(id))) {
          return res.status(403).json({ error: "This Wags wardrobe item has not been delivered to this account." });
        }
      }
      const connection = await getPool().getConnection();
      try {
        await connection.beginTransaction();
        await connection.query(`DELETE FROM wardrobe_selections WHERE user_phone = ?`, [req.user!.phone]);
        for (const id of selected) {
          await connection.query(`INSERT INTO wardrobe_selections (user_phone, item_id) VALUES (?, ?)`, [req.user!.phone, id]);
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      res.json({ selected });
    } catch (error: any) {
      console.error("[wardrobe] save failed:", error?.message || error);
      res.status(500).json({ error: "Could not save the wardrobe." });
    }
  });

  // ── Pet Health API (H1) ───────────────────────────────────────────────────
  // GET /api/health/:avatarId — profile + live vitals + last 60 log entries
  app.get("/api/health/:avatarId", requireAuth, async (req: AuthedRequest, res) => {
    const avatarId = Number(req.params.avatarId);
    if (!avatarId) return res.status(400).json({ error: "Invalid avatar id." });
    try {
      // Ownership check
      const [avRows]: any = await getPool().query(
        "SELECT id, name, image_url, animal_type, breed, food_level, water_level, needs_json FROM avatars WHERE id = ? AND user_phone = ? LIMIT 1",
        [avatarId, req.user!.phone]
      );
      if (!avRows?.length) return res.status(404).json({ error: "Avatar not found." });
      const avatar = avRows[0];

      const [profRows]: any = await getPool().query(
        "SELECT * FROM pet_health_profiles WHERE avatar_id = ? LIMIT 1",
        [avatarId]
      );
      const profile = profRows?.[0] ?? null;

      const [logRows]: any = await getPool().query(
        `SELECT * FROM pet_health_logs WHERE avatar_id = ? ORDER BY logged_at DESC, id DESC LIMIT 60`,
        [avatarId]
      );

      // Parse live needs from needs_json
      let needs: any = null;
      try {
        const raw = avatar.needs_json;
        needs = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
      } catch { /* ignored */ }

      res.json({
        avatar: {
          id: avatar.id,
          name: avatar.name,
          image_url: avatar.image_url,
          animal_type: avatar.animal_type,
          breed: avatar.breed,
        },
        vitals: {
          food:      needs?.food      ?? avatar.food_level  ?? 100,
          water:     needs?.water     ?? avatar.water_level ?? 100,
          energy:    needs?.energy    ?? 80,
          happiness: needs?.happiness ?? 80,
          bladder:   needs?.bladder   ?? 0,
          bowel:     needs?.bowel     ?? 0,
        },
        profile: profile ? {
          birthday:             profile.birthday,
          weight_kg:            profile.weight_kg != null ? Number(profile.weight_kg) : null,
          weight_unit:          profile.weight_unit,
          target_weight_kg:     profile.target_weight_kg != null ? Number(profile.target_weight_kg) : null,
          body_condition_score: profile.body_condition_score,
          sterilized:           !!profile.sterilized,
          microchip_id:         profile.microchip_id,
          vet_name:             profile.vet_name,
          vet_phone:            profile.vet_phone,
          vet_email:            profile.vet_email,
          next_vet_visit:       profile.next_vet_visit,
          next_vaccine_due:     profile.next_vaccine_due,
          insurance_provider:   profile.insurance_provider,
          notes:                profile.notes,
        } : null,
        logs: (logRows ?? []).map((r: any) => ({
          id:                   r.id,
          log_type:             r.log_type,
          logged_at:            r.logged_at,
          weight_kg:            r.weight_kg != null ? Number(r.weight_kg) : null,
          body_condition_score: r.body_condition_score,
          value_numeric:        r.value_numeric != null ? Number(r.value_numeric) : null,
          value_text:           r.value_text,
          notes:                r.notes,
          created_at:           r.created_at,
        })),
      });
    } catch (err: any) {
      console.error("[GET /api/health/:avatarId]", err?.message ?? err);
      res.status(500).json({ error: "Could not load health data." });
    }
  });

  // POST /api/health/:avatarId/profile — upsert health profile
  app.post("/api/health/:avatarId/profile", requireAuth, async (req: AuthedRequest, res) => {
    const avatarId = Number(req.params.avatarId);
    if (!avatarId) return res.status(400).json({ error: "Invalid avatar id." });
    try {
      const [avRows]: any = await getPool().query(
        "SELECT id FROM avatars WHERE id = ? AND user_phone = ? LIMIT 1",
        [avatarId, req.user!.phone]
      );
      if (!avRows?.length) return res.status(404).json({ error: "Avatar not found." });

      const {
        birthday, weight_kg, weight_unit, target_weight_kg,
        body_condition_score, sterilized, microchip_id,
        vet_name, vet_phone, vet_email,
        next_vet_visit, next_vaccine_due, insurance_provider, notes,
      } = req.body ?? {};

      await getPool().query(
        `INSERT INTO pet_health_profiles
           (avatar_id, user_phone, birthday, weight_kg, weight_unit, target_weight_kg,
            body_condition_score, sterilized, microchip_id,
            vet_name, vet_phone, vet_email,
            next_vet_visit, next_vaccine_due, insurance_provider, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           birthday              = COALESCE(VALUES(birthday), birthday),
           weight_kg             = COALESCE(VALUES(weight_kg), weight_kg),
           weight_unit           = COALESCE(VALUES(weight_unit), weight_unit),
           target_weight_kg      = COALESCE(VALUES(target_weight_kg), target_weight_kg),
           body_condition_score  = COALESCE(VALUES(body_condition_score), body_condition_score),
           sterilized            = COALESCE(VALUES(sterilized), sterilized),
           microchip_id          = COALESCE(VALUES(microchip_id), microchip_id),
           vet_name              = COALESCE(VALUES(vet_name), vet_name),
           vet_phone             = COALESCE(VALUES(vet_phone), vet_phone),
           vet_email             = COALESCE(VALUES(vet_email), vet_email),
           next_vet_visit        = COALESCE(VALUES(next_vet_visit), next_vet_visit),
           next_vaccine_due      = COALESCE(VALUES(next_vaccine_due), next_vaccine_due),
           insurance_provider    = COALESCE(VALUES(insurance_provider), insurance_provider),
           notes                 = COALESCE(VALUES(notes), notes)`,
        [
          avatarId, req.user!.phone,
          birthday ?? null, weight_kg ?? null,
          weight_unit ?? "lb", target_weight_kg ?? null,
          body_condition_score ?? null, sterilized ? 1 : 0, microchip_id ?? null,
          vet_name ?? null, vet_phone ?? null, vet_email ?? null,
          next_vet_visit ?? null, next_vaccine_due ?? null,
          insurance_provider ?? null, notes ?? null,
        ]
      );
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[POST /api/health/:avatarId/profile]", err?.message ?? err);
      res.status(500).json({ error: "Could not save health profile." });
    }
  });

  // POST /api/health/:avatarId/log — add a health log entry
  app.post("/api/health/:avatarId/log", requireAuth, async (req: AuthedRequest, res) => {
    const avatarId = Number(req.params.avatarId);
    if (!avatarId) return res.status(400).json({ error: "Invalid avatar id." });
    const VALID_LOG_TYPES = ["weight","body_condition","vet_visit","vaccine","medication","symptom","note","dental","grooming"];
    const { log_type, logged_at, weight_kg, body_condition_score, value_numeric, value_text, notes } = req.body ?? {};
    if (!log_type || !VALID_LOG_TYPES.includes(log_type)) return res.status(400).json({ error: "Valid log_type required." });
    if (!logged_at) return res.status(400).json({ error: "logged_at (YYYY-MM-DD) required." });
    try {
      const [avRows]: any = await getPool().query(
        "SELECT id FROM avatars WHERE id = ? AND user_phone = ? LIMIT 1",
        [avatarId, req.user!.phone]
      );
      if (!avRows?.length) return res.status(404).json({ error: "Avatar not found." });

      const [ins]: any = await getPool().query(
        `INSERT INTO pet_health_logs
           (avatar_id, user_phone, log_type, logged_at, weight_kg, body_condition_score,
            value_numeric, value_text, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          avatarId, req.user!.phone, log_type, logged_at,
          weight_kg ?? null, body_condition_score ?? null,
          value_numeric ?? null, value_text ?? null, notes ?? null,
        ]
      );
      // If weight log, mirror to health profile as current weight
      if (log_type === "weight" && weight_kg != null) {
        await getPool().query(
          `INSERT INTO pet_health_profiles (avatar_id, user_phone, weight_kg)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE weight_kg = VALUES(weight_kg)`,
          [avatarId, req.user!.phone, weight_kg]
        );
      }
      // If BCS log, mirror to profile
      if (log_type === "body_condition" && body_condition_score != null) {
        await getPool().query(
          `INSERT INTO pet_health_profiles (avatar_id, user_phone, body_condition_score)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE body_condition_score = VALUES(body_condition_score)`,
          [avatarId, req.user!.phone, body_condition_score]
        );
      }
      res.json({ ok: true, id: ins.insertId });
    } catch (err: any) {
      console.error("[POST /api/health/:avatarId/log]", err?.message ?? err);
      res.status(500).json({ error: "Could not save health log." });
    }
  });

  // DELETE /api/health/:avatarId/log/:logId — delete a log entry
  app.delete("/api/health/:avatarId/log/:logId", requireAuth, async (req: AuthedRequest, res) => {
    const avatarId = Number(req.params.avatarId);
    const logId    = Number(req.params.logId);
    if (!avatarId || !logId) return res.status(400).json({ error: "Invalid ids." });
    try {
      await getPool().query(
        "DELETE FROM pet_health_logs WHERE id = ? AND avatar_id = ? AND user_phone = ?",
        [logId, avatarId, req.user!.phone]
      );
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: "Could not delete log." });
    }
  });

  // GET /api/health/:avatarId/history?days=90 — time-series for charting
  app.get("/api/health/:avatarId/history", requireAuth, async (req: AuthedRequest, res) => {
    const avatarId = Number(req.params.avatarId);
    const days = Math.min(Number(req.query.days ?? 90), 365);
    if (!avatarId) return res.status(400).json({ error: "Invalid avatar id." });
    try {
      const [avRows]: any = await getPool().query(
        "SELECT id FROM avatars WHERE id = ? AND user_phone = ? LIMIT 1",
        [avatarId, req.user!.phone]
      );
      if (!avRows?.length) return res.status(404).json({ error: "Avatar not found." });
      const [rows]: any = await getPool().query(
        `SELECT log_type, logged_at, weight_kg, body_condition_score, value_numeric, value_text
         FROM pet_health_logs
         WHERE avatar_id = ? AND user_phone = ?
           AND logged_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         ORDER BY logged_at ASC, id ASC`,
        [avatarId, req.user!.phone, days]
      );
      res.json({ history: rows ?? [] });
    } catch (err: any) {
      console.error("[GET /api/health/:avatarId/history]", err?.message ?? err);
      res.status(500).json({ error: "Could not load history." });
    }
  });

  // ── Fido's Styles: project settings CRUD ──────────────────────────────────
  // GET /api/fidos/projects?avatar_id=N  — load settings for a specific avatar
  app.get("/api/fidos/projects", requireAuth, async (req: AuthedRequest, res) => {
    const avatarId = Number(req.query.avatar_id);
    if (!avatarId) return res.status(400).json({ error: "avatar_id required." });
    try {
      const [rows]: any = await getPool().query(
        `SELECT id, avatar_id, settings_json FROM fidos_projects WHERE user_phone = ? AND avatar_id = ? LIMIT 1`,
        [req.user!.phone, avatarId],
      );
      if (!rows?.length) return res.json(null);
      const row = rows[0];
      res.json({ id: row.id, avatar_id: row.avatar_id, settings_json: typeof row.settings_json === "string" ? JSON.parse(row.settings_json) : row.settings_json });
    } catch (err: any) {
      console.error("[fidos/projects GET]", err?.message || err);
      res.status(500).json({ error: "Could not load project." });
    }
  });

  // POST /api/fidos/projects — create a new project record
  app.post("/api/fidos/projects", requireAuth, async (req: AuthedRequest, res) => {
    const { avatar_id, settings_json } = req.body ?? {};
    if (!avatar_id) return res.status(400).json({ error: "avatar_id required." });
    const settings = (typeof settings_json === "object" && settings_json !== null) ? settings_json : {};
    try {
      const [result]: any = await getPool().query(
        `INSERT INTO fidos_projects (user_phone, avatar_id, settings_json)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json), updated_at = CURRENT_TIMESTAMP`,
        [req.user!.phone, Number(avatar_id), JSON.stringify(settings)],
      );
      const insertId = result.insertId || null;
      // On DUPLICATE KEY UPDATE insertId may be 0; re-fetch the row id
      if (!insertId) {
        const [rows]: any = await getPool().query(
          `SELECT id FROM fidos_projects WHERE user_phone = ? AND avatar_id = ? LIMIT 1`,
          [req.user!.phone, Number(avatar_id)],
        );
        return res.json({ id: rows?.[0]?.id ?? null, avatar_id: Number(avatar_id) });
      }
      res.json({ id: insertId, avatar_id: Number(avatar_id) });
    } catch (err: any) {
      console.error("[fidos/projects POST]", err?.message || err);
      res.status(500).json({ error: "Could not save project." });
    }
  });

  // PATCH /api/fidos/projects/:id — update settings for an existing project
  app.patch("/api/fidos/projects/:id", requireAuth, async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid project id." });
    const { settings_json } = req.body ?? {};
    if (typeof settings_json !== "object" || settings_json === null) return res.status(400).json({ error: "settings_json must be an object." });
    try {
      const [result]: any = await getPool().query(
        `UPDATE fidos_projects SET settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_phone = ?`,
        [JSON.stringify(settings_json), id, req.user!.phone],
      );
      if (!result.affectedRows) return res.status(404).json({ error: "Project not found." });
      res.json({ id, settings_json });
    } catch (err: any) {
      console.error("[fidos/projects PATCH]", err?.message || err);
      res.status(500).json({ error: "Could not update project." });
    }
  });

  // ── Wardrobe Wags: subscription endpoints (W1) ─────────────────────────────
  // POST /api/wags/subscribe — legacy checkout is fail-closed. It could create
  // recurring Stripe billing before the durable local ownership/idempotency
  // record existed. New checkout belongs to the Wags v2 service.
  app.post("/api/wags/subscribe", requireAuth, async (req: AuthedRequest, res) => {
    return res.status(410).json({
      error: "This Wags checkout has been retired while the upgraded subscription flow is activated.",
      code: "LEGACY_WAGS_CHECKOUT_RETIRED",
    });

    /* c8 ignore start -- retained only for legacy data-flow reference */
    if (!stripe) return res.status(503).json({ error: "Payments not configured." });
    const { pet_id, species, tier, billing_period, payment_method_id } = req.body ?? {};
    if (!pet_id || !species || !tier || !billing_period || !payment_method_id)
      return res.status(400).json({ error: "pet_id, species, tier, billing_period, payment_method_id are required." });
    if (!["dog","cat"].includes(species)) return res.status(400).json({ error: "species must be dog or cat." });
    if (!["basic","plus"].includes(tier)) return res.status(400).json({ error: "tier must be basic or plus." });
    if (!["monthly","annual"].includes(billing_period)) return res.status(400).json({ error: "billing_period must be monthly or annual." });

    const priceIdKey =
      tier === "basic" && billing_period === "monthly" ? "WAGS_BASIC_MONTHLY_PRICE_ID" :
      tier === "basic" && billing_period === "annual"  ? "WAGS_BASIC_ANNUAL_PRICE_ID"  :
      tier === "plus"  && billing_period === "monthly" ? "WAGS_PLUS_MONTHLY_PRICE_ID"  :
                                                          "WAGS_PLUS_ANNUAL_PRICE_ID";
    const priceId = process.env[priceIdKey];
    if (!priceId) return res.status(503).json({ error: `Stripe price for ${tier}/${billing_period} is not configured (${priceIdKey}).` });

    try {
      // Find or create Stripe customer
      const [userRows]: any = await getPool().query(
        "SELECT stripe_customer_id FROM users WHERE phone = ? LIMIT 1",
        [req.user!.phone],
      );
      let customerId: string = userRows?.[0]?.stripe_customer_id || "";
      if (!customerId) {
        // Look up email from DB since it isn't on the JWT payload
        const [meRows]: any = await getPool().query("SELECT email FROM users WHERE phone = ? LIMIT 1", [req.user!.phone]);
        const userEmail: string | undefined = meRows?.[0]?.email ?? undefined;
        const customer = await stripe.customers.create({
          email: userEmail,
          metadata: { user_phone: req.user!.phone },
        });
        customerId = customer.id;
        await getPool().query("UPDATE users SET stripe_customer_id = ? WHERE phone = ?", [customerId, req.user!.phone]);
      }
      // Attach payment method
      await stripe.paymentMethods.attach(payment_method_id, { customer: customerId });
      await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: payment_method_id } });

      // Create subscription (cast to any to access period fields not always typed by SDK version)
      const sub = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        expand: ["latest_invoice.payment_intent"],
        metadata: { user_phone: req.user!.phone, pet_id: String(pet_id), tier, billing_period, species },
      }) as any;

      const periodStart = new Date(sub.current_period_start * 1000).toISOString().slice(0, 10);
      const periodEnd   = new Date(sub.current_period_end   * 1000).toISOString().slice(0, 10);

      await getPool().query(
        `INSERT INTO wardrobe_wags_subscriptions
           (user_phone, pet_id, species, tier, billing_period, stripe_subscription_id, stripe_customer_id,
            status, current_period_start, current_period_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [req.user!.phone, Number(pet_id), species, tier, billing_period, sub.id, customerId, periodStart, periodEnd],
      );

      res.json({ subscription_id: sub.id, status: sub.status });
    } catch (err: any) {
      console.error("[wags/subscribe]", err?.message || err);
      res.status(500).json({ error: err.message || "Could not create subscription." });
    }
    /* c8 ignore stop */
  });

  // POST /api/wags/cancel — cancel a Wags subscription at period end
  app.post("/api/wags/cancel", requireAuth, async (req: AuthedRequest, res) => {
    if (!stripe) return res.status(503).json({ error: "Payments not configured." });
    const { subscription_id } = req.body ?? {};
    if (!subscription_id) return res.status(400).json({ error: "subscription_id required." });
    try {
      // Verify ownership
      const [rows]: any = await getPool().query(
        "SELECT id FROM wardrobe_wags_subscriptions WHERE stripe_subscription_id = ? AND user_phone = ? LIMIT 1",
        [subscription_id, req.user!.phone],
      );
      if (!rows?.length) return res.status(404).json({ error: "Subscription not found." });

      await stripe.subscriptions.update(subscription_id, { cancel_at_period_end: true });
      await getPool().query(
        "UPDATE wardrobe_wags_subscriptions SET cancel_at_period_end = 1 WHERE stripe_subscription_id = ? AND user_phone = ?",
        [subscription_id, req.user!.phone],
      );
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[wags/cancel]", err?.message || err);
      res.status(500).json({ error: err.message || "Could not cancel subscription." });
    }
  });

  // GET /api/wags/subscriptions — list the user's Wags subscriptions
  app.get("/api/wags/subscriptions", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const [rows]: any = await getPool().query(
        `SELECT id, pet_id, species, tier, billing_period, stripe_subscription_id,
                status, current_period_start, current_period_end,
                cancel_at_period_end, cancelled_at, created_at
         FROM wardrobe_wags_subscriptions WHERE user_phone = ? ORDER BY created_at DESC`,
        [req.user!.phone],
      );
      res.json({ subscriptions: rows ?? [] });
    } catch (err: any) {
      console.error("[wags/subscriptions GET]", err?.message || err);
      res.status(500).json({ error: "Could not load subscriptions." });
    }
  });

  // GET /api/wags/boxes — the user's Wags Inbox. Delivered boxes include their
  // items; boxes still in curation appear as teasers with no contents, so the
  // subscriber can see next month is coming without spoiling the reveal.
  app.get("/api/wags/boxes", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const [boxes]: any = await getPool().query(
        `SELECT b.id, b.box_month, b.status, b.delivered_at, b.opened_at, b.created_at,
                s.tier, s.species
         FROM wardrobe_wags_boxes b
         JOIN wardrobe_wags_subscriptions s ON s.id = b.subscription_id
         WHERE b.user_phone = ? AND b.status IN ('pending_review','approved','delivered','delivered_flagged','reviewed_ok')
         ORDER BY b.box_month DESC
         LIMIT 36`,
        [req.user!.phone],
      );
      const deliveredIds = (boxes as any[])
        .filter((b) => ["delivered", "delivered_flagged", "reviewed_ok"].includes(String(b.status)))
        .map((b) => b.id);
      let itemsByBox: Record<number, any[]> = {};
      if (deliveredIds.length) {
        const [items]: any = await getPool().query(
          `SELECT box_id, slot, wardrobe_item_id, entitlement_type, credit_amount,
                  title, description, personalization_note, asset_url, asset_status
           FROM wardrobe_wags_box_items WHERE box_id IN (?) ORDER BY id`,
          [deliveredIds],
        );
        for (const item of items as any[]) {
          (itemsByBox[item.box_id] ||= []).push(item);
        }
      }
      res.json({
        boxes: (boxes as any[]).map((b) => ({
          ...b,
          // Curation states collapse to a single teaser status client-side.
          status: ["delivered", "delivered_flagged", "reviewed_ok"].includes(String(b.status)) ? "delivered" : "curating",
          items: itemsByBox[b.id] ?? [],
        })),
      });
    } catch (err: any) {
      console.error("[wags/boxes GET]", err?.message || err);
      res.status(500).json({ error: "Could not load your Wags boxes." });
    }
  });

  // POST /api/wags/boxes/:id/open — record the one-time unboxing reveal.
  app.post("/api/wags/boxes/:id/open", requireAuth, async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid box id." });
    try {
      await getPool().query(
        `UPDATE wardrobe_wags_boxes SET opened_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_phone = ? AND opened_at IS NULL
           AND status IN ('delivered','delivered_flagged','reviewed_ok')`,
        [id, req.user!.phone],
      );
      res.json({ id, opened: true });
    } catch (err: any) {
      console.error("[wags/boxes open]", err?.message || err);
      res.status(500).json({ error: "Could not open the box." });
    }
  });

  // GET /api/wags/wardrobe — wardrobe item ids unlocked through Wags boxes.
  // Fido's Styles uses this to unlock exclusive items in the wardrobe panel.
  app.get("/api/wags/wardrobe", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const owned = await getOwnedWardrobeItems(getPool() as any, req.user!.phone);
      res.json({ owned: [...owned] });
    } catch (err: any) {
      console.error("[wags/wardrobe GET]", err?.message || err);
      res.status(500).json({ error: "Could not load wardrobe entitlements." });
    }
  });

  // ==========================================================================
  // Texture re-bake (UV_TEXTURE_GENERATION_PLAN.md UV8 — likeness repair).
  // Re-projects the avatar's approved reference views onto its mesh and bakes
  // a fresh base-color atlas on the Blender worker. No generation step; the
  // user's own approved views are the ground truth, so no credit charge —
  // this repairs what they already paid to create. Rate-limited + idempotent.
  // ==========================================================================

  // POST /api/texture/rebake — start a re-bake for an avatar the user owns.
  app.post("/api/texture/rebake", requireAuth, paidLimiter, async (req: AuthedRequest, res) => {
    try {
      const idempotencyKey = String(req.header("Idempotency-Key") || "").trim().slice(0, 128);
      if (!idempotencyKey) return res.status(400).json({ error: "An idempotency key is required." });

      const parsed = RebakeRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
      }
      const workerUrl = String(process.env.BLENDER_WORKER_URL || "").replace(/\/render$/, "").replace(/\/$/, "");
      if (!workerUrl || !process.env.WORKER_SHARED_SECRET) {
        return res.status(503).json({ error: "Texture re-bake is not configured." });
      }

      const phone = req.user!.phone;
      const [existing]: any = await getPool().query(
        `SELECT id, status, result_model_url FROM texture_jobs WHERE user_phone = ? AND idempotency_key = ? LIMIT 1`,
        [phone, idempotencyKey],
      );
      if (existing?.[0]) {
        return res.json({ jobId: existing[0].id, status: existing[0].status, resultUrl: existing[0].result_model_url, idempotent: true });
      }

      const [avatarRows]: any = await getPool().query(
        `SELECT id, image_url, model_url, rigged_model_url, multiview_json
         FROM avatars WHERE id = ? AND user_phone = ? LIMIT 1`,
        [parsed.data.avatar_id, phone],
      );
      const avatar = avatarRows?.[0];
      if (!avatar) return res.status(404).json({ error: "Avatar not found." });
      const sourceModelUrl = avatar.rigged_model_url || avatar.model_url;
      if (!sourceModelUrl) return res.status(422).json({ error: "This avatar has no 3D model yet." });

      const views = viewsFromAvatarRow(avatar);
      if (!views) return res.status(422).json({ error: "This avatar has no reference views to re-bake from." });

      const jobId = randomUUID();
      await getPool().query(
        `INSERT INTO texture_jobs (id, user_phone, avatar_id, status, source_model_url, idempotency_key)
         VALUES (?, ?, ?, 'processing', ?, ?)`,
        [jobId, phone, avatar.id, sourceModelUrl, idempotencyKey],
      );
      res.status(202).json({ jobId, status: "processing" });

      // Background: worker round-trip, upload, job update. The response has
      // already gone out; the client polls GET /api/texture/jobs/:id.
      (async () => {
        try {
          const workerRes = await fetch(`${workerUrl}/texture/rebake`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-worker-secret": process.env.WORKER_SHARED_SECRET || "",
            },
            body: JSON.stringify({
              glb_url: sourceModelUrl,
              views,
              texture_size: parsed.data.texture_size || 1024,
            }),
            signal: AbortSignal.timeout(600_000),
          });
          const result: any = await workerRes.json().catch(() => ({}));
          if (!workerRes.ok || !result?.success || !result?.glb_base64) {
            throw new Error(result?.error || `Worker returned ${workerRes.status}`);
          }
          // Result GLB → public media bucket (same tier as look variations —
          // it is the user's own deliverable, not a purchasable source asset).
          const resultUrl = await uploadBase64Binary(result.glb_base64, "model/gltf-binary", "rebaked-models");

          // UV8 acceptance gate. The worker's stats say the bake RAN (coverage,
          // views used, materials retargeted); none of them say it HELPED.
          // Scoring palette distance to the user's own reference photos before
          // and after is the plan's literal "done when" condition, and running
          // it here rather than only in fixtures means every production re-bake
          // reports whether it actually improved likeness.
          //
          // Deliberately after the upload and wrapped so it can never fail the
          // job: the deliverable already exists and is already stored. Losing a
          // good bake because a PNG decode threw would be a strictly worse
          // outcome than losing the metric.
          let likeness: RebakeLikenessReport = {
            before: null, after: null, delta: null, improved: null, note: "not scored",
          };
          try {
            const { scoreRebake } = await import("./server/textureLikeness");
            const fetchBuf = async (url: string) => {
              const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
              if (!r.ok) throw new Error(`${r.status} fetching ${url.slice(0, 80)}`);
              return Buffer.from(await r.arrayBuffer());
            };
            const [originalGlb, refImages] = await Promise.all([
              fetchBuf(sourceModelUrl),
              Promise.all(
                Object.values(views)
                  .filter((u): u is string => typeof u === "string")
                  .map((u) => fetchBuf(u).catch(() => null)),
              ).then((b) => b.filter((x): x is Buffer => x !== null)),
            ]);
            const rebakedGlb = Buffer.from(result.glb_base64, "base64");
            likeness = await scoreRebake(originalGlb, rebakedGlb, refImages);
            if (likeness.improved === false) {
              // Not an error — a faithful re-bake of an already-good texture can
              // legitimately move sideways. Logged so a systematic regression is
              // visible without having to query stats_json.
              console.warn(
                `[texture/rebake ${jobId}] likeness did not improve: ` +
                  `before=${likeness.before} after=${likeness.after}`,
              );
            }
          } catch (scoreErr: any) {
            likeness = {
              before: null, after: null, delta: null, improved: null,
              note: `scoring skipped: ${String(scoreErr?.message || scoreErr).slice(0, 160)}`,
            };
          }

          await getPool().query(
            `UPDATE texture_jobs SET status = 'completed', result_model_url = ?, stats_json = ? WHERE id = ?`,
            [resultUrl, JSON.stringify({ ...(result.stats ?? {}), likeness }), jobId],
          );
        } catch (err: any) {
          const message = String(err?.message || err).slice(0, 400);
          console.error(`[texture/rebake ${jobId}]`, message);
          await getPool().query(
            `UPDATE texture_jobs SET status = 'failed', error = ? WHERE id = ?`,
            [message, jobId],
          ).catch(() => {});
        }
      })();
    } catch (err: any) {
      console.error("[texture/rebake POST]", err?.message || err);
      res.status(500).json({ error: "Could not start the texture re-bake." });
    }
  });
  // POST /api/texture/jobs — Start a stylization texture job (UV6)
  //
  // QUARANTINED. Disabled by default; set TEXTURE_STYLIZE_ENABLED=true to lift.
  //
  // The handler below is written against infrastructure that does not exist.
  // Verified against the running database and the worker's route table:
  //
  //   1. It debits `user_credits` and writes `credit_ledger`. Neither table
  //      exists. This app bills through `users.credits` + `credit_transactions`
  //      via the transactional wallet helpers in db.ts. The query throws
  //      ER_NO_SUCH_TABLE, so today the route 500s — which is the only reason
  //      it has never actually taken money for an impossible job.
  //   2. It calls the worker at /texture/render-views and /texture/bake.
  //      The worker exposes neither; the only texture route is /texture/rebake.
  //      (UV2 adds render-views — see UV_TEXTURE_COMPLETION_PLAN.md.)
  //   3. Its Gemini call passes no source image, making it text-to-image, not
  //      the low-strength img2img the plan's D2 requires. `identity_strength`
  //      is concatenated into a prompt string and otherwise unused, so the
  //      likeness guarantee it names is not enforced anywhere.
  //   4. Its INSERT INTO creations uses columns (id, avatar_id, type, title,
  //      status) that are not on that table.
  //
  // The gate returns before any credit, database, or provider work. A route
  // that cannot succeed must not be able to bill, and must say so plainly
  // rather than surfacing a 500 the caller has to guess at.
  const TEXTURE_STYLIZE_ENABLED =
    String(process.env.TEXTURE_STYLIZE_ENABLED || "").toLowerCase() === "true";

  app.post("/api/texture/jobs", requireAuth, async (req: AuthedRequest, res) => {
    if (!TEXTURE_STYLIZE_ENABLED) {
      return res.status(503).json({
        error:
          "Coat restyling is not available yet. Texture repair (re-bake from your photos) is available now.",
        feature: "texture_stylize",
        available: false,
      });
    }
    try {
      const idempotencyKey = String(req.header("Idempotency-Key") || "").trim().slice(0, 128);
      if (!idempotencyKey) return res.status(400).json({ error: "An idempotency key is required." });

      const parsed = StylizeRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
      }

      const { avatar_id, prompt, tier, identity_strength } = parsed.data;
      const phone = req.user!.phone;

      // 1. Idempotency Check
      const [existing]: any = await getPool().query(
        `SELECT id, status, result_model_url FROM texture_jobs WHERE user_phone = ? AND idempotency_key = ? LIMIT 1`,
        [phone, idempotencyKey],
      );
      if (existing?.[0]) {
        return res.json({ jobId: existing[0].id, status: existing[0].status, resultUrl: existing[0].result_model_url, idempotent: true });
      }

      // 2. Avatar Ownership & Model Resolution
      const [avatarRows]: any = await getPool().query(
        `SELECT id, image_url, model_url, rigged_model_url FROM avatars WHERE id = ? AND user_phone = ? LIMIT 1`,
        [avatar_id, phone],
      );
      const avatar = avatarRows?.[0];
      if (!avatar) return res.status(404).json({ error: "Avatar not found." });
      const sourceModelUrl = avatar.rigged_model_url || avatar.model_url;
      if (!sourceModelUrl) return res.status(422).json({ error: "This avatar has no 3D model yet." });

      // 3. Deduct Credits
      const { CREDIT_PRICES } = await import("./src/pricing.js").catch(() => import("./src/pricing.ts"));
      // Map tier to pricing (e.g. standard hermes looks pricing)
      const cost = tier === "draft" ? 2 : tier === "studio" ? 20 : 8; 
      
      const conn = await getPool().getConnection();
      try {
        await conn.beginTransaction();
        const [walletRows]: any = await conn.query(`SELECT balance FROM user_credits WHERE user_phone = ? FOR UPDATE`, [phone]);
        const currentBalance = walletRows?.[0]?.balance ?? 0;
        if (currentBalance < cost) {
          await conn.rollback();
          conn.release();
          return res.status(402).json({ error: "Insufficient credits.", required: cost, balance: currentBalance });
        }
        await conn.query(
          `INSERT INTO credit_ledger (user_phone, amount, reason, reference_id) VALUES (?, ?, ?, ?)`,
          [phone, -cost, `texture_job_${tier}`, idempotencyKey],
        );
        await conn.query(
          `UPDATE user_credits SET balance = balance - ? WHERE user_phone = ?`,
          [cost, phone],
        );
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        conn.release();
        throw err;
      }
      conn.release();

      // 4. Create Job Record
      const jobId = randomUUID();
      await getPool().query(
        `INSERT INTO texture_jobs (id, user_phone, avatar_id, job_type, status, source_model_url, prompt, tier, identity_strength, idempotency_key)
         VALUES (?, ?, ?, 'stylize', 'queued', ?, ?, ?, ?, ?)`,
        [jobId, phone, avatar.id, sourceModelUrl, prompt, tier, identity_strength, idempotencyKey],
      );

      res.status(202).json({ jobId, status: "queued", cost });

      // 5. Hand off to background orchestrator
      import("./server/textureJob.js").catch(() => import("./server/textureJob.ts")).then(({ processStylizationJob }) => {
        processStylizationJob(jobId, phone, avatar.id, sourceModelUrl, prompt, tier, identity_strength);
      }).catch(err => {
        console.error("Failed to load textureJob module:", err);
      });

    } catch (err: any) {
      console.error("[texture/jobs POST]", err?.message || err);
      res.status(500).json({ error: "Could not start the texture job." });
    }
  });


  // GET /api/texture/jobs/:id — poll a re-bake job (owner only).
  app.get("/api/texture/jobs/:id", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const [rows]: any = await getPool().query(
        `SELECT id, avatar_id, status, result_model_url, stats_json, error, created_at, updated_at
         FROM texture_jobs WHERE id = ? AND user_phone = ? LIMIT 1`,
        [String(req.params.id), req.user!.phone],
      );
      const job = rows?.[0];
      if (!job) return res.status(404).json({ error: "Job not found." });
      res.json({
        jobId: job.id,
        avatarId: job.avatar_id,
        status: job.status,
        resultUrl: job.result_model_url,
        stats: typeof job.stats_json === "string" ? JSON.parse(job.stats_json) : job.stats_json,
        error: job.error,
      });
    } catch (err: any) {
      console.error("[texture/jobs GET]", err?.message || err);
      res.status(500).json({ error: "Could not load the job." });
    }
  });

  // GET /api/texture/jobs — the user's recent re-bakes (Fur Bin variants list).
  app.get("/api/texture/jobs", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const [rows]: any = await getPool().query(
        `SELECT id, avatar_id, status, result_model_url, created_at
         FROM texture_jobs WHERE user_phone = ? ORDER BY created_at DESC LIMIT 50`,
        [req.user!.phone],
      );
      res.json({ jobs: rows ?? [] });
    } catch (err: any) {
      console.error("[texture/jobs list]", err?.message || err);
      res.status(500).json({ error: "Could not load texture jobs." });
    }
  });

  // ── Wags admin endpoints (admin only) ─────────────────────────────────────
  // GET /api/admin/wags/boxes — list all boxes with subscription + user details
  app.get("/api/admin/wags/boxes", requireAuth, async (req: AuthedRequest, res) => {
    if (!req.user || !await isUserAdmin(req.user.phone)) return res.status(403).json({ error: "Admin only." });
    const statusFilter = req.query.status as string | undefined;
    const limitVal = Math.min(Number(req.query.limit ?? 50), 200);
    const offsetVal = Number(req.query.offset ?? 0);
    try {
      const where = statusFilter ? `WHERE b.status = ?` : `WHERE 1=1`;
      const params: any[] = statusFilter ? [statusFilter, limitVal, offsetVal] : [limitVal, offsetVal];
      const [rows]: any = await getPool().query(
        `SELECT
           b.id, b.subscription_id, b.user_phone, b.box_month, b.status,
           b.plan_json, b.admin_notes, b.reviewed_by, b.reviewed_at, b.delivered_at, b.created_at,
           s.tier, s.billing_period, s.species, s.pet_id,
           s.current_period_start, s.current_period_end
         FROM wardrobe_wags_boxes b
         JOIN wardrobe_wags_subscriptions s ON s.id = b.subscription_id
         ${where}
         ORDER BY b.created_at DESC
         LIMIT ? OFFSET ?`,
        params,
      );
      // Parse plan_json for each row
      const boxes = (rows ?? []).map((row: any) => ({
        ...row,
        plan_json: typeof row.plan_json === "string" ? JSON.parse(row.plan_json) : row.plan_json,
      }));
      res.json({ boxes });
    } catch (err: any) {
      console.error("[admin/wags/boxes GET]", err?.message || err);
      res.status(500).json({ error: "Could not load boxes." });
    }
  });

  // POST /api/admin/wags/boxes/:subscriptionId/plan — (re-)plan a box with Gemini
  app.post("/api/admin/wags/boxes/:subscriptionId/plan", requireAuth, async (req: AuthedRequest, res) => {
    if (!req.user || !await isUserAdmin(req.user.phone)) return res.status(403).json({ error: "Admin only." });
    const subscriptionId = Number(req.params.subscriptionId);
    const boxMonth: string = req.body?.box_month ?? new Date().toISOString().slice(0, 7);
    if (!subscriptionId) return res.status(400).json({ error: "subscriptionId required." });
    try {
      const [subRows]: any = await getPool().query(
        `SELECT id, user_phone, pet_id, species, tier FROM wardrobe_wags_subscriptions WHERE id = ? LIMIT 1`,
        [subscriptionId],
      );
      if (!subRows?.length) return res.status(404).json({ error: "Subscription not found." });
      const sub = subRows[0];

      const [petRows]: any = await getPool().query(
        `SELECT name FROM pets WHERE id = ? AND user_phone = ? LIMIT 1`,
        [sub.pet_id, sub.user_phone],
      );
      const petName = petRows?.[0]?.name ?? null;

      const { previous_themes, previous_item_titles } = await getPriorBoxHistory(subscriptionId, getPool());
      const plan = await planWagsBox({
        box_month: boxMonth,
        tier: sub.tier,
        pet_species: sub.species,
        pet_breed: null,
        pet_name: petName,
        previous_themes,
        previous_item_titles,
      });

      // Upsert the box row
      const [existing]: any = await getPool().query(
        `SELECT id FROM wardrobe_wags_boxes WHERE subscription_id = ? AND box_month = ? LIMIT 1`,
        [subscriptionId, boxMonth],
      );
      if (existing?.length) {
        await getPool().query(
          `UPDATE wardrobe_wags_boxes SET plan_json = ?, status = 'pending_review', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [JSON.stringify(plan), existing[0].id],
        );
        res.json({ box_id: existing[0].id, plan });
      } else {
        const [result]: any = await getPool().query(
          `INSERT INTO wardrobe_wags_boxes (subscription_id, user_phone, box_month, status, plan_json)
           VALUES (?, ?, ?, 'pending_review', ?)`,
          [subscriptionId, sub.user_phone, boxMonth, JSON.stringify(plan)],
        );
        res.json({ box_id: result.insertId, plan });
      }
    } catch (err: any) {
      console.error("[admin/wags/plan]", err?.message || err);
      res.status(500).json({ error: err.message || "Planning failed." });
    }
  });

  // BO-3: provider wiring for the Wags slot materializer. Image generation
  // reuses the shared Gemini chain (hoisted async function declaration) and
  // storage reuses the standard B2 uploader.
  const makeWagsMaterializerDeps = (operatorPhone: string) => ({
    generateImage: (prompt: string, label: string) =>
      generateImageWithFallback([{ text: prompt }], label, operatorPhone),
    uploadImage: (dataUrl: string) => uploadBase64Image(dataUrl),
  });

  // POST /api/admin/wags/boxes/:id/materialize — regenerate failed/pending
  // slot assets for an approved box (idempotent: generated slots are skipped).
  app.post("/api/admin/wags/boxes/:id/materialize", requireAuth, async (req: AuthedRequest, res) => {
    if (!req.user || !await isUserAdmin(req.user.phone)) return res.status(403).json({ error: "Admin only." });
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid box id." });
    try {
      const result = await materializeBoxAssets(getPool(), makeWagsMaterializerDeps(req.user.phone), id);
      res.json(result);
    } catch (err: any) {
      console.error("[admin/wags materialize]", err?.message || err);
      res.status(400).json({ error: String(err?.message || "Could not materialize box assets.").slice(0, 200) });
    }
  });

  // PATCH /api/admin/wags/boxes/:id — approve or reject a box
  app.patch("/api/admin/wags/boxes/:id", requireAuth, async (req: AuthedRequest, res) => {
    if (!req.user || !await isUserAdmin(req.user.phone)) return res.status(403).json({ error: "Admin only." });
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid box id." });
    const { action, admin_notes } = req.body ?? {};
    if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "action must be approve or reject." });

    const newStatus = action === "approve" ? "approved" : "rejected";
    try {
      const [result]: any = await getPool().query(
        `UPDATE wardrobe_wags_boxes
         SET status = ?, admin_notes = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status IN ('pending_review', 'rejected', 'approved')`,
        [newStatus, admin_notes ?? null, req.user.phone, id],
      );
      if (!result.affectedRows) return res.status(404).json({ error: "Box not found or already delivered." });

      // W3 + BO-3: approval delivers item rows and grants entitlements, then
      // kicks the asset materializer in the background. The box flips to
      // 'delivered' only when every generative slot has a stored asset — the
      // subscriber never opens a box with missing paid content.
      if (action === "approve") {
        const [boxRows]: any = await getPool().query(
          `SELECT id, user_phone, plan_json FROM wardrobe_wags_boxes WHERE id = ? LIMIT 1`,
          [id],
        );
        const boxRow = boxRows?.[0];
        const plan = boxRow?.plan_json
          ? (typeof boxRow.plan_json === "string" ? JSON.parse(boxRow.plan_json) : boxRow.plan_json)
          : null;
        const delivery = await deliverBox(getPool(), { id, user_phone: boxRow.user_phone, plan_json: plan }, { finalizeStatus: false });
        void materializeBoxAssets(getPool(), makeWagsMaterializerDeps(req.user.phone), id)
          .then((result) => console.log(`[wags materializer] box ${id}: generated=${result.generated} failed=${result.failed} skipped=${result.skipped} delivered=${result.delivered}`))
          .catch((err) => console.error(`[wags materializer] box ${id} failed:`, err?.message || err));
        return res.json({ id, status: "materializing", delivery });
      }
      res.json({ id, status: newStatus });
    } catch (err: any) {
      console.error("[admin/wags/boxes PATCH]", err?.message || err);
      res.status(500).json({ error: "Could not update box." });
    }
  });

  // ==========================================================================
  // Phase 3 — admin catalog manager (/admin/marketplace).
  // Route glue only: all logic lives in server/marketplaceAdmin.ts where it is
  // unit-testable. Every endpoint is admin-gated server-side; the client gate
  // in MarketplaceAdminScreen is cosmetic.
  // ==========================================================================

  /** Shared guard + error mapping for the marketplace admin routes. */
  const requireMarketplaceAdmin = async (req: AuthedRequest, res: any): Promise<boolean> => {
    if (!req.user || !await isUserAdmin(req.user.phone)) {
      res.status(403).json({ error: "Admin only." });
      return false;
    }
    return true;
  };
  const sendAdminError = (res: any, err: any, fallback: string) => {
    if (err instanceof MarketplaceAdminError) return res.status(err.status).json({ error: err.message });
    console.error("[admin/marketplace]", err?.message || err);
    return res.status(500).json({ error: fallback });
  };

  // --- PUBLIC MARKETPLACE & DIGITAL PURCHASE ---
  
  app.get("/api/marketplace/listings", async (req, res) => {
    const parsed = ListingQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    try {
      res.json(await publicListings(getPool() as any, parsed.data));
    } catch (err: any) {
      console.error("[marketplace public]", err?.message || err);
      res.status(500).json({ error: "Could not load listings." });
    }
  });

  app.get("/api/marketplace/listings/:uuid", async (req, res) => {
    try {
      const listing = await publicListing(getPool() as any, String(req.params.uuid));
      if (!listing) return res.status(404).json({ error: "Listing not found." });
      res.json({ listing });
    } catch (err: any) {
      console.error("[marketplace public]", err?.message || err);
      res.status(500).json({ error: "Could not load listing." });
    }
  });

  app.post("/api/marketplace/listings/:uuid/checkout", requireAuth, paidLimiter, async (req: AuthedRequest, res) => {
    const idempotencyKey = String(req.header("Idempotency-Key") || "").trim().slice(0, 128);
    if (!idempotencyKey) return res.status(400).json({ error: "An idempotency key is required." });
    
    try {
      const result = await checkoutDigital(getPool() as any, req.user!.phone, String(req.params.uuid), idempotencyKey, stripe, process.env.APP_URL);
      res.json({ checkoutUrl: result.checkoutUrl });
    } catch (err: any) {
      if (err.status) res.status(err.status);
      else res.status(500);
      res.json({ error: err.message || "Checkout failed." });
    }
  });

  app.get("/api/marketplace/listings/:uuid/download", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const signed = await digitalDownload(getPool() as any, req.user!.phone, String(req.params.uuid));
      res.json(signed);
    } catch (err: any) {
      if (err.status) res.status(err.status);
      else res.status(500);
      res.json({ error: err.message || "Download failed." });
    }
  });

  app.get("/api/marketplace/orders/:id", requireAuth, async (req: AuthedRequest, res) => {
    try {
      res.json(await getOrderStatus(getPool() as any, req.user!.phone, Number(req.params.id)));
    } catch (err: any) {
      res.status(404).json({ error: err.message || "Not found" });
    }
  });

  app.get("/api/marketplace/entitlements", requireAuth, async (req: AuthedRequest, res) => {
    try {
      res.json({ entitlements: await getUserEntitlements(getPool() as any, req.user!.phone) });
    } catch (err: any) {
      res.status(500).json({ error: "Could not load entitlements." });
    }
  });

  // --- ADMIN MARKETPLACE ---

  app.get("/api/admin/marketplace/listings", requireAuth, async (req: AuthedRequest, res) => {
    if (!await requireMarketplaceAdmin(req, res)) return;
    try {
      const listings = await listListingsWithCounts(getPool() as any, {
        status: req.query.status ? String(req.query.status) : undefined,
        limit: Number(req.query.limit ?? 50),
        offset: Number(req.query.offset ?? 0),
      });
      res.json({ listings });
    } catch (err: any) { sendAdminError(res, err, "Could not load listings."); }
  });

  app.get("/api/admin/marketplace/listings/:id/previews", requireAuth, async (req: AuthedRequest, res) => {
    if (!await requireMarketplaceAdmin(req, res)) return;
    try {
      res.json({ previews: await listingPreviews(getPool() as any, Number(req.params.id)) });
    } catch (err: any) { sendAdminError(res, err, "Could not load previews."); }
  });

  // ── Product customizer P0: Printful catalogue browse ───────────────────────
  // Admin-only. Surfaces products/variants and the authoritative print-file
  // geometry the admin needs to author a placement template. See
  // MARKETPLACE_CUSTOMIZER_SPEC.md and server/printfulCatalog.ts.
  app.get("/api/admin/customizer/products", requireAuth, async (req: AuthedRequest, res) => {
    if (!await requireMarketplaceAdmin(req, res)) return;
    if (!printfulCatalogConfigured()) {
      return res.status(503).json({ error: "Printful is not configured (set PRINTFUL_API_KEY)." });
    }
    try {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      res.json({ products: await searchProducts(q) });
    } catch (err: any) { sendAdminError(res, err, "Could not load the Printful catalogue."); }
  });

  app.get("/api/admin/customizer/products/:productId/variants", requireAuth, async (req: AuthedRequest, res) => {
    if (!await requireMarketplaceAdmin(req, res)) return;
    if (!printfulCatalogConfigured()) {
      return res.status(503).json({ error: "Printful is not configured (set PRINTFUL_API_KEY)." });
    }
    try {
      res.json({ variants: await listVariants(Number(req.params.productId)) });
    } catch (err: any) { sendAdminError(res, err, "Could not load variants."); }
  });

  // The print-file geometry that governs composite resolution for one variant.
  app.get("/api/admin/customizer/products/:productId/variants/:variantId/template", requireAuth, async (req: AuthedRequest, res) => {
    if (!await requireMarketplaceAdmin(req, res)) return;
    if (!printfulCatalogConfigured()) {
      return res.status(503).json({ error: "Printful is not configured (set PRINTFUL_API_KEY)." });
    }
    try {
      res.json(await getTemplateContext(Number(req.params.productId), Number(req.params.variantId)));
    } catch (err: any) { sendAdminError(res, err, "Could not load the print template."); }
  });

  // Manual cache bust after the owner changes products in Printful.
  app.post("/api/admin/customizer/refresh", requireAuth, async (req: AuthedRequest, res) => {
    if (!await requireMarketplaceAdmin(req, res)) return;
    clearCatalogueCache();
    res.json({ success: true });
  });

  // ── Customizer P1: admin product management + buyer checkout ──────────────
  // (server/customizerCheckout.ts — pure functions exported for tests)
  registerCustomizerBuyerRoutes(app, { stripe, requireAuth, paidLimiter, requireMarketplaceAdmin });

  app.get("/api/admin/marketplace/listings/:id/assets", requireAuth, async (req: AuthedRequest, res) => {
    if (!await requireMarketplaceAdmin(req, res)) return;
    try {
      res.json(await listingAssets(getPool() as any, Number(req.params.id)));
    } catch (err: any) { sendAdminError(res, err, "Could not load assets."); }
  });

  app.post("/api/admin/marketplace/listings", requireAuth, async (req: AuthedRequest, res) => {
    if (!await requireMarketplaceAdmin(req, res)) return;
    const parsed = CreateListingSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    try {
      res.status(201).json(await createListing(getPool() as any, req.user!.phone, parsed.data));
    } catch (err: any) { sendAdminError(res, err, "Could not create the listing."); }
  });

  app.patch("/api/admin/marketplace/listings/:id", requireAuth, async (req: AuthedRequest, res) => {
    if (!await requireMarketplaceAdmin(req, res)) return;
    const parsed = UpdateListingSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    try {
      await updateListing(getPool() as any, Number(req.params.id), parsed.data);
      res.json({ id: Number(req.params.id), updated: true });
    } catch (err: any) { sendAdminError(res, err, "Could not update the listing."); }
  });

  app.post("/api/admin/marketplace/listings/:id/reorder", requireAuth, async (req: AuthedRequest, res) => {
    if (!await requireMarketplaceAdmin(req, res)) return;
    const parsed = ReorderListingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    try {
      await reorderListings(getPool() as any, parsed.data.order);
      res.json({ reordered: parsed.data.order.length });
    } catch (err: any) { sendAdminError(res, err, "Could not reorder listings."); }
  });

  app.post("/api/admin/marketplace/upload-url", requireAuth, async (req: AuthedRequest, res) => {
    if (!await requireMarketplaceAdmin(req, res)) return;
    const parsed = UploadUrlRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    try {
      res.json(await mintUploadUrl(getPool() as any, parsed.data));
    } catch (err: any) { sendAdminError(res, err, "Could not create an upload URL."); }
  });

  app.post("/api/admin/marketplace/assets", requireAuth, async (req: AuthedRequest, res) => {
    if (!await requireMarketplaceAdmin(req, res)) return;
    const parsed = ConfirmAssetSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    try {
      res.status(201).json(await confirmAsset(getPool() as any, parsed.data));
    } catch (err: any) { sendAdminError(res, err, "Could not confirm the asset."); }
  });

  app.patch("/api/admin/marketplace/assets/:id", requireAuth, async (req: AuthedRequest, res) => {
    if (!await requireMarketplaceAdmin(req, res)) return;
    const parsed = UpdateAssetSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    try {
      await updateAsset(getPool() as any, Number(req.params.id), parsed.data);
      res.json({ id: Number(req.params.id), updated: true });
    } catch (err: any) { sendAdminError(res, err, "Could not update the asset."); }
  });

  app.get("/api/pawprints/templates", (_req, res) => {
    const categories = getPawprintCategories();
    const templates = getPawprintTemplatesSync();
    res.json({ categories, templates });
  });

  app.post("/api/pawprints/generate", requireAuth, paidLimiter, async (req: AuthedRequest, res) => {
    let creditReservationId: string | null = null;
    let pawprintPrice: number = CREDIT_PRICES.PAWPRINT;
    try {
      const idempotencyKey = String(req.header("Idempotency-Key") || req.body?.idempotencyKey || "").trim().slice(0, 120);
      if (!idempotencyKey) return res.status(400).json({ error: "An idempotency key is required." });

      const [existing] = await getPool().query(
        `SELECT id, image_url, creation_id FROM pawprint_assets WHERE user_phone = ? AND idempotency_key = ? LIMIT 1`,
        [req.user!.phone, idempotencyKey]
      ) as any;
      if (existing?.[0]) {
        return res.json({ pawprintId: existing[0].id, url: existing[0].image_url, creationId: existing[0].creation_id, idempotent: true });
      }

      const category = String(req.body?.category || "").trim();
      const layoutId = String(req.body?.layoutId || req.body?.templateId || "").trim();
      const mode = String(req.body?.mode || "single_pet").trim();
      
      if (mode === "owner_pet") {
        pawprintPrice = CREDIT_PRICES.PAWPRINT_OWNER_PET;
      } else if (mode === "multi_pet") {
        pawprintPrice = CREDIT_PRICES.PAWPRINT_MULTI_PET;
      }
      
      const fields = req.body?.fields && typeof req.body.fields === "object" ? req.body.fields as Record<string, string> : {};
      const customName = String(req.body?.customName || "").trim().slice(0, 80);
      const customMessage = String(req.body?.customMessage || "").trim().slice(0, 300);
      const template = getPawprintTemplatesSync(category).find((t) => t.layoutId === layoutId);
      if (!template) return res.status(400).json({ error: "Please choose a valid Pawprint template." });

      const allowed = new Set(template.fieldSchema.map((field) => field.key));
      for (const key of Object.keys(fields)) {
        if (!allowed.has(key)) return res.status(400).json({ error: `Unknown field: ${key}` });
      }
      for (const field of template.fieldSchema) {
        const value = String(fields[field.key] || "").trim();
        if (field.type === "image") {
          const media = value || String(req.body?.photoBase64 || "");
          const mediaList = Array.isArray(req.body?.photoBase64List) ? req.body.photoBase64List : (media ? [media] : []);
          if (mediaList.length > 0 && !mediaList.every(m => /^data:image\/(png|jpe?g|webp);base64,/i.test(m))) {
            return res.status(400).json({ error: `${field.label} must be image files.` });
          }
        } else if (value.length > (field.maxLength || 120)) {
          return res.status(400).json({ error: `${field.label} is too long.` });
        }
      }

      // Subject reuse: if the user picks a prior generated image of the same
      // subject, reuse it as the background (skip fresh image generation) at 20% off.
      const reuseCreationId = Number(req.body?.reuseCreationId) || 0;
      let reuseImageUrl = "";
      if (reuseCreationId > 0) {
        const mine = await getCreations(req.user!.phone); // scoped to this user
        const src = mine.find((c: any) => c.id === reuseCreationId && c.image_url);
        if (!src) return res.status(400).json({ error: "That image isn't available to reuse." });
        reuseImageUrl = src.image_url as string;
      }
      pawprintPrice = reuseImageUrl
        ? Math.round(pawprintPrice * (1 - REUSE_DISCOUNT))
        : pawprintPrice;

      const isAdmin = await isUserAdmin(req.user!.phone);
      if (!isAdmin) {
        creditReservationId = await reserveCredits(req.user!.phone, pawprintPrice, "pawprint_generation");
        if (!creditReservationId) {
          return res.status(402).json({ error: `You need ${pawprintPrice} PupCoins to create a Pawprint.` });
        }
      }

      let sourceBuffer: Buffer;
      if (category === "historic_portraits") {
        const identityImages: string[] = Array.isArray(req.body?.photoBase64List) && req.body.photoBase64List.length > 0
          ? req.body.photoBase64List
          : [String(req.body?.photoBase64 || "")].filter(img => img !== "");
        if (identityImages.length === 0 || !identityImages.every(img => /^data:image\/(png|jpe?g|webp);base64,/i.test(img))) {
          if (creditReservationId) {
            await refundReservedCredits(creditReservationId);
            creditReservationId = null;
          }
          return res.status(400).json({ error: "Choose the pet photo(s) to use in this historic portrait." });
        }
        const inlineParts = identityImages.map(img => {
          const identity = splitDataUrl(img);
          return { inlineData: { data: identity.data, mimeType: identity.mimeType } };
        });
        
        const isDuo = template.layoutId.startsWith("duo-") || template.category === "landmarks";
        const historicPrompt = [
          isDuo ? "The uploaded images are the identity references for the customer's subjects (owner/pet or two pets)." : "The uploaded image is the identity reference for the customer's pet.",
          "Preserve the exact species, faces, eye color, ear shape, muzzle, coat length, coat pattern, markings, proportions, and expressions of ALL subjects in the references.",
          template.imagePromptTemplate,
          "Create one finished vertical 4:5 portrait with the subjects facing the viewer.",
          "Do not include captions, names, logos, watermarks, signatures, random text, extra limbs, or floating paws. Keep the subjects naturally placed.",
        ].join(" ");
        
        const generated = await generateImageWithFallback(
          [...inlineParts, { text: historicPrompt }],
          "historic-pawprint-reference",
          req.user!.phone,
          undefined,
          "4:5",
        );
        const generatedMatch = generated && /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(generated);
        if (!generatedMatch) throw new Error("Historic portrait generation returned no image.");
        sourceBuffer = Buffer.from(generatedMatch[2], "base64");
      } else {
        // Standard Pawprints remain a manual stationery editor. The browser
        // composites the user's exact text and photo before submitting it.
        const renderedImage = String(req.body?.renderedImage || req.body?.renderedPng || "");
        const renderedMatch = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(renderedImage);
        if (!renderedMatch) {
          if (creditReservationId) {
            await refundReservedCredits(creditReservationId);
            creditReservationId = null;
          }
          return res.status(400).json({ error: "Choose a finished Pawprint variation before saving." });
        }
        sourceBuffer = Buffer.from(renderedMatch[2], "base64");
      }
      if (sourceBuffer.length < 1_000 || sourceBuffer.length > 15 * 1024 * 1024) {
        throw new Error("Rendered Pawprint size is invalid.");
      }
      const sharpInputOptions = {
        failOn: "error" as const,
        limitInputPixels: 16_000_000,
        sequentialRead: true,
      };
      const metadata = await sharp(sourceBuffer, sharpInputOptions).metadata();
      if (!metadata.width || !metadata.height || metadata.width < 600 || metadata.height < 600 || metadata.width > 4_000 || metadata.height > 4_000) {
        throw new Error("Rendered Pawprint dimensions are invalid.");
      }
      const finalBuffer = await sharp(sourceBuffer, sharpInputOptions)
        .rotate()
        .resize(2400, 3000, { fit: "cover" })
        .webp({ quality: 92, effort: 4, smartSubsample: true })
        .toBuffer();
      const title = customName || String(fields.petName || fields.name || "Pawprint").slice(0, 80);
      const finalDataUrl = `data:image/webp;base64,${finalBuffer.toString("base64")}`;
      const finalUrl = await uploadBase64Image(finalDataUrl, "pawprints");
      await recordStorageAddHot(req.user!.phone, finalBuffer.length);
      const creationId = await saveCreation({
        user_phone: req.user!.phone,
        media_type: "still",
        style: "Artistic",
        backdrop_kind: "preset",
        preset_name: "pawprint",
        image_url: finalUrl,
        pet_name: title,
      });
      const [inserted] = await getPool().query(
        `INSERT INTO pawprint_assets
           (user_phone, idempotency_key, template_id, category, layout_id, image_url, creation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.user!.phone, idempotencyKey, `${category}:${layoutId}`, category, layoutId, finalUrl, creationId]
      ) as any;
      const user = await findUserByPhone(req.user!.phone);
      res.status(201).json({ pawprintId: inserted.insertId, url: finalUrl, creationId, user: toPublicUser(user, TERMS_VERSION) });
    } catch (err: any) {
      if (creditReservationId) {
        try { await refundReservedCredits(creditReservationId); } catch {}
      }
      console.error("[POST /api/pawprints/generate] Error:", err?.message || err);
      res.status(500).json({ error: "Could not create the Pawprint. Your credits were returned." });
    }
  });

  // Send a saved Pawprint digitally. The recipient pays nothing; the email
  // includes the authoritative Pawprint price so shared links remain clear.
  app.post("/api/pawprints/send", requireAuth, paidLimiter, async (req: AuthedRequest, res) => {
    try {
      const creationId = Number(req.body?.creationId);
      const recipient = String(req.body?.email || "").trim().toLowerCase();
      if (!Number.isInteger(creationId) || creationId <= 0) return res.status(400).json({ error: "A saved Pawprint is required." });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return res.status(400).json({ error: "Enter a valid recipient email." });
      const creation = (await getCreations(req.user!.phone)).find((item: any) => Number(item.id) === creationId && item.image_url);
      if (!creation) return res.status(404).json({ error: "That Pawprint is not in your FurBin." });
      const esc = (value: string) => value.replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] || char));
      const sender = await findUserByPhone(req.user!.phone);
      const senderName = esc(sender?.full_name || "A friend");
      const imageUrl = esc(String(creation.image_url));
      const sent = await sendMail({
        to: recipient,
        subject: `${senderName} sent you a Pawsome3D Pawprint`,
        html: `<div style="font-family:system-ui,Arial,sans-serif;line-height:1.6"><h2>A Pawprint from ${senderName}</h2><p>Here is a keepsake made in Pawsome3D.</p><p><img src="${imageUrl}" alt="Pawprint" style="max-width:100%;border-radius:12px" /></p><p><a href="${imageUrl}">Open the Pawprint</a></p><p style="color:#666;font-size:13px">Pawprint creation price: ${CREDIT_PRICES.PAWPRINT} PupCoins.</p></div>`,
        replyTo: sender?.email || undefined,
      });
      if (!sent) return res.status(503).json({ error: "Email delivery is not configured yet. Add RESEND_API_KEY and MAIL_FROM." });
      res.json({ success: true, pricePupCoins: CREDIT_PRICES.PAWPRINT });
    } catch (error: any) {
      console.error("[POST /api/pawprints/send] Error:", error?.message || error);
      res.status(500).json({ error: "Could not send the Pawprint." });
    }
  });

  app.get("/api/pawprints/print-products", (_req, res) => {
    const products = publicPawprintPrintProducts();
    const storageConfigured = Boolean(
      process.env.MEDIA_BUCKET_NAME && process.env.MEDIA_BUCKET_URL
      && process.env.MEDIA_BUCKET_KEY && process.env.MEDIA_BUCKET_SECRET,
    );
    const available = Boolean(products.length > 0 && process.env.PRINTFUL_API_KEY && stripe && storageConfigured);

    // Blockers name the missing dependency, never its value. This is what turns
    // "printing is unavailable" from a dead end into something an operator can
    // act on — the previous version returned an empty array with no reason, so
    // a deployment missing only its variant IDs looked identical to one with no
    // Printful account at all.
    const blockers: string[] = [];
    if (!process.env.PRINTFUL_API_KEY) blockers.push("printful_api_key");
    if (!products.length) blockers.push("pawprint_print_products");
    if (!stripe) blockers.push("stripe");
    if (!storageConfigured) blockers.push("media_storage");

    res.json({
      provider: "printful",
      configured: products.length > 0,
      available,
      // Always a non-empty list so the studio can render real formats instead of
      // silently collapsing the whole physical-print section.
      products: pawprintDisplayCatalog(),
      blockers,
      orderMode: "payment",
    });
  });

  // Public capability flags let the studios disable fulfillment controls until
  // every server-side dependency is present. No key names or secret values are
  // exposed to the browser.
  app.get("/api/fulfillment/readiness", (_req, res) => {
    const storageConfigured = Boolean(
      process.env.MEDIA_BUCKET_NAME && process.env.MEDIA_BUCKET_URL
      && process.env.MEDIA_BUCKET_KEY && process.env.MEDIA_BUCKET_SECRET,
    );
    const workerConfigured = Boolean(process.env.BLENDER_WORKER_URL && process.env.WORKER_SHARED_SECRET);
    const pawprintProducts = publicPawprintPrintProducts();
    const readiness = buildFulfillmentReadiness({
      stripeConfigured: Boolean(stripe),
      slantConfigured: slant3dConfigured(),
      printfulConfigured: Boolean(process.env.PRINTFUL_API_KEY),
      pawprintProductCount: pawprintProducts.length,
      storageConfigured,
      workerConfigured,
    });

    // Dependency names only — no key names, no values. Lets the Print Shop tell
    // a customer "coming soon" while an admin reading the same payload can see
    // precisely which dependency is absent.
    const modelBlockers: string[] = [];
    if (!slant3dConfigured()) modelBlockers.push("slant3d_credentials");
    if (!stripe) modelBlockers.push("stripe");
    if (!storageConfigured) modelBlockers.push("media_storage");
    if (!workerConfigured) modelBlockers.push("blender_worker");

    const pawprintBlockers: string[] = [];
    if (!process.env.PRINTFUL_API_KEY) pawprintBlockers.push("printful_api_key");
    if (!pawprintProducts.length) pawprintBlockers.push("pawprint_print_products");
    if (!stripe) pawprintBlockers.push("stripe");
    if (!storageConfigured) pawprintBlockers.push("media_storage");

    res.json({
      modelPrinting: { ...readiness.modelPrinting, blockers: modelBlockers },
      pawprintPrinting: { ...readiness.pawprintPrinting, blockers: pawprintBlockers },
    });
  });

  app.get("/api/admin/fulfillment/verify", requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (!(await isUserAdmin(req.user!.phone))) {
        return res.status(403).json({ error: "Admin access required." });
      }
      const storage = Boolean(
        process.env.MEDIA_BUCKET_NAME && process.env.MEDIA_BUCKET_URL
        && process.env.MEDIA_BUCKET_KEY && process.env.MEDIA_BUCKET_SECRET,
      );
      const stripeReady = Boolean(stripe && stripeWebhookSecret);
      const products = publicPawprintPrintProducts();
      const workerUrl = String(process.env.BLENDER_WORKER_URL || "").replace(/\/render$/, "").replace(/\/$/, "");

      const slantCheck = slant3dConfigured()
        ? verifySlant3dConfiguration()
        : Promise.reject(new Error("not configured"));
      const printfulCheck = process.env.PRINTFUL_API_KEY
        ? verifyPrintfulConfiguration()
        : Promise.reject(new Error("not configured"));
      const workerCheck = workerUrl && process.env.WORKER_SHARED_SECRET
        ? fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(15_000) }).then(async (response) => {
            if (!response.ok) throw new Error("worker unavailable");
            const body: any = await response.json().catch(() => ({}));
            return { reachable: true, bridgeConnected: body?.bridge === "connected", blenderVersion: body?.blenderVersion || null };
          })
        : Promise.reject(new Error("not configured"));

      const [slant, printful, worker] = await Promise.allSettled([slantCheck, printfulCheck, workerCheck]);
      const slantResult = slant.status === "fulfilled" ? slant.value : null;
      const printfulResult = printful.status === "fulfilled" ? printful.value : null;
      const workerResult = worker.status === "fulfilled" ? worker.value : null;

      // Surface *why* a vendor check failed. A rejected check previously
      // collapsed to a bare `ready: false`, which cannot distinguish "no API key
      // set" from "key set but rejected by the vendor" from "vendor timed out" —
      // three problems with three different fixes.
      const reasonFor = (settled: PromiseSettledResult<unknown>): string | null =>
        settled.status === "rejected"
          ? String((settled.reason as any)?.message || settled.reason || "check failed").slice(0, 300)
          : null;

      // Missing env vars are reported by name because this route is admin-only
      // and already behind isUserAdmin. Values are never echoed.
      const missingPrintful: string[] = [];
      if (!process.env.PRINTFUL_API_KEY) missingPrintful.push("PRINTFUL_API_KEY");
      if (!products.length) missingPrintful.push("PAWPRINT_PRINT_PRODUCTS_JSON (or PRINTFUL_PAWPRINT_VARIANT_ID)");

      const missingSlant: string[] = [];
      if (!process.env.SLANT3D_API_KEY) missingSlant.push("SLANT3D_API_KEY");
      if (!process.env.SLANT3D_PLATFORM_ID) missingSlant.push("SLANT3D_PLATFORM_ID");
      if (!process.env.SLANT3D_DEFAULT_FILAMENT_ID) missingSlant.push("SLANT3D_DEFAULT_FILAMENT_ID");

      const checks = {
        stripe: {
          ready: stripeReady,
          missingEnv: [
            ...(stripe ? [] : ["STRIPE_SECRET_KEY"]),
            ...(stripeWebhookSecret ? [] : ["STRIPE_WEBHOOK_SECRET"]),
          ],
        },
        storage: {
          ready: storage,
          missingEnv: ["MEDIA_BUCKET_NAME", "MEDIA_BUCKET_URL", "MEDIA_BUCKET_KEY", "MEDIA_BUCKET_SECRET"]
            .filter((name) => !process.env[name]),
        },
        slant3d: {
          ready: Boolean(slantResult?.authenticated && slantResult.platformValid && slantResult.filamentValid && slantResult.filamentAvailable),
          missingEnv: missingSlant,
          error: reasonFor(slant),
          ...(slantResult || {}),
        },
        printful: {
          ready: Boolean(printfulResult?.authenticated && printfulResult.ordersReadable && products.length > 0),
          productCount: products.length,
          missingEnv: missingPrintful,
          error: reasonFor(printful),
          ...(printfulResult || {}),
        },
        blenderWorker: {
          ready: Boolean(workerResult?.reachable && workerResult.bridgeConnected),
          error: reasonFor(worker),
          ...(workerResult || {}),
        },
      };
      res.json({
        ready: Object.values(checks).every((check) => check.ready),
        checks,
        mutatingRequestsMade: false,
      });
    } catch (error: any) {
      console.error("Fulfillment verification failed:", error?.message || error);
      res.status(500).json({ error: "Fulfillment verification could not be completed." });
    }
  });

  app.get("/api/pawprints/print-orders", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT id, creation_id, provider, product_code, provider_order_id, print_file_url,
                quantity, price_cents, provider_cost_cents, retail_price_cents, checkout_url,
                provider_payload_json, status, created_at, updated_at
         FROM pawprint_print_orders WHERE user_phone = ? ORDER BY created_at DESC LIMIT 100`,
        [req.user!.phone],
      ) as any;
      const orders = rows.map((row: any) => {
        const { provider_payload_json, ...safe } = row;
        return { ...safe, tracking: extractShipmentTracking(provider_payload_json) };
      });
      res.json({ success: true, orders });
    } catch (error: any) {
      console.error("[GET /api/pawprints/print-orders] Error:", error?.message || error);
      res.status(500).json({ error: "Could not load Pawprint print orders." });
    }
  });

  app.post("/api/pawprints/printful-order", requireAuth, paidLimiter, async (req: AuthedRequest, res) => {
    let preparedOrderId: number | null = null;
    try {
      if (!stripe) return res.status(503).json({ error: "Stripe checkout is not configured for physical orders." });
      const schema = z.object({
        creationId: z.number().int().positive(),
        productCode: z.string().min(1).max(48),
        quantity: z.number().int().min(1).max(10).default(1),
        recipient: z.object({
          name: z.string().trim().min(2).max(120),
          email: z.string().trim().email().max(200),
          address1: z.string().trim().min(3).max(200),
          city: z.string().trim().min(2).max(80),
          state_code: z.string().trim().max(10).optional(),
          country_code: z.string().trim().length(2).transform((value) => value.toUpperCase()),
          zip: z.string().trim().min(2).max(20),
        }),
      });
      const input = schema.parse(req.body);
      const idempotencyKey = String(req.header("Idempotency-Key") || "").trim().slice(0, 128);
      if (!idempotencyKey) return res.status(400).json({ error: "An idempotency key is required." });
      const product = requirePawprintPrintProduct(input.productCode);
      const creationId = input.creationId;
      const creation = (await getCreations(req.user!.phone)).find((item: any) => Number(item.id) === creationId && item.image_url);
      if (!creation) return res.status(404).json({ error: "That Pawprint is not in your FurBin." });

      const [existingRows] = await getPool().query(
        `SELECT id, provider_order_id, status, product_code, quantity, price_cents, print_file_url,
                retail_price_cents, checkout_url
         FROM pawprint_print_orders WHERE user_phone = ? AND idempotency_key = ? LIMIT 1`,
        [req.user!.phone, idempotencyKey],
      ) as any;
      if (existingRows?.[0]) return res.json({ success: true, idempotent: true, order: existingRows[0], checkoutUrl: existingRows[0].checkout_url });

      // Preserve the saved FurBin image and produce a separate 300-DPI PNG
      // derivative sized for the selected physical product.
      const sourceResponse = await fetch(String(creation.image_url), { signal: AbortSignal.timeout(30_000) });
      if (!sourceResponse.ok) throw new Error("The saved Pawprint print file could not be opened.");
      const sourceBuffer = Buffer.from(await sourceResponse.arrayBuffer());
      if (sourceBuffer.byteLength > 30 * 1024 * 1024) throw new Error("The saved Pawprint print file is too large.");
      const printBuffer = await sharp(sourceBuffer)
        .resize({ width: Math.round(product.widthIn * 300), height: Math.round(product.heightIn * 300), fit: "contain", background: "#ffffff" })
        .png({ compressionLevel: 9 })
        .toBuffer();
      const printFileUrl = await uploadBase64Binary(printBuffer.toString("base64"), "image/png", "pawprints-print");
      const externalId = `pawprint-${createHash("sha256").update(`${req.user!.phone}:${idempotencyKey}`).digest("hex").slice(0, 32)}`;
      const order = await createPrintfulOrder({
        recipient: {
          name: input.recipient.name,
          email: input.recipient.email,
          address1: input.recipient.address1,
          city: input.recipient.city,
          state_code: input.recipient.state_code || undefined,
          country_code: String(input.recipient.country_code || "US").toUpperCase(),
          zip: input.recipient.zip,
        },
        imageUrl: printFileUrl,
        variantId: product.variantId,
        templateId: product.templateId,
        quantity: input.quantity,
        externalId,
      });
      const currentOrder = order.costs?.total ? order : await getPrintfulOrder(order.id);
      const providerCurrency = String(currentOrder?.costs?.currency || "USD").toUpperCase();
      if (providerCurrency !== "USD") {
        throw new Error(`Printful returned ${providerCurrency} pricing, but checkout is configured for USD.`);
      }
      const providerCost = Number(currentOrder?.costs?.total || 0);
      if (!Number.isFinite(providerCost) || providerCost <= 0) {
        throw new Error("Printful is still calculating this order. Try again after the print file finishes processing.");
      }
      const providerCostCents = Math.ceil(providerCost * 100);
      const markupPercent = Math.max(0, Number(process.env.FULFILLMENT_MARKUP_PERCENT || 80));
      const minimumMarginCents = Math.max(0, Number(process.env.FULFILLMENT_MIN_MARGIN_CENTS || 500));
      const desiredRetailTotal = Math.max(
        Number(product.priceCents || 0) * input.quantity,
        providerCostCents + minimumMarginCents,
        Math.ceil(providerCostCents * (1 + markupPercent / 100)),
      );
      const retailUnitPriceCents = Math.ceil(desiredRetailTotal / input.quantity);
      const retailPriceCents = retailUnitPriceCents * input.quantity;
      const [inserted] = await getPool().query(
        `INSERT INTO pawprint_print_orders
          (user_phone, creation_id, provider, product_code, provider_order_id, print_file_url,
           recipient_json, quantity, price_cents, provider_cost_cents, retail_price_cents,
           provider_payload_json, status, idempotency_key)
         VALUES (?, ?, 'printful', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?)
         ON DUPLICATE KEY UPDATE provider_order_id = VALUES(provider_order_id), status = VALUES(status), updated_at = CURRENT_TIMESTAMP`,
        [req.user!.phone, creationId, product.code, order.id, printFileUrl, JSON.stringify(input.recipient),
          input.quantity, product.priceCents || null, providerCostCents, retailPriceCents,
          JSON.stringify(currentOrder || order), idempotencyKey],
      ) as any;
      preparedOrderId = Number(inserted.insertId);
      const appUrl = process.env.APP_URL || "http://localhost:3000";
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: { name: product.label, description: `${product.description} · printed and shipped by Printful`, images: [printFileUrl] },
            unit_amount: retailUnitPriceCents,
          },
          quantity: input.quantity,
        }],
        customer_email: input.recipient.email,
        mode: "payment",
        metadata: { type: "pawprint_print_order", printOrderId: String(preparedOrderId), userPhone: req.user!.phone, printfulOrderId: order.id },
        success_url: `${appUrl}/pawprints?print_success=true&order_id=${preparedOrderId}`,
        cancel_url: `${appUrl}/pawprints?print_cancelled=true&order_id=${preparedOrderId}`,
      });
      await getPool().query(
        `UPDATE pawprint_print_orders SET checkout_url = ?, stripe_session_id = ? WHERE id = ?`,
        [session.url, session.id, preparedOrderId],
      );
      res.status(201).json({ success: true, checkoutUrl: session.url, retailPriceCents, order: { ...order, productCode: product.code, printFileUrl } });
    } catch (error: any) {
      if (preparedOrderId) {
        try { await getPool().query(`UPDATE pawprint_print_orders SET status = 'payment_setup_failed' WHERE id = ?`, [preparedOrderId]); } catch {}
      }
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message || "Check the shipping information." });
      const message = error?.message || "Could not create the Printful order.";
      if (/not configured/i.test(message)) return res.status(503).json({ error: message });
      console.error("[POST /api/pawprints/printful-order] Error:", message);
      res.status(502).json({ error: message });
    }
  });

  app.post("/api/streak/claim", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const result = await claimDailyStreak(req.user!.phone);
      const user = await findUserByPhone(req.user!.phone);
      // LIVE-2 (2026-08-04 deployment review): the client fires this once per
      // page load, so for every visit after the first each day the browser
      // logged a red 400 and error monitoring recorded a client fault. Already
      // having claimed today is the expected, benign, idempotent outcome — not
      // a malformed request. Report it as a successful no-op and let the client
      // branch on `alreadyClaimed`.
      if (!result.success) {
        return res.json({
          success: true,
          alreadyClaimed: true,
          message: "Streak already claimed today",
          user: toPublicUser(user),
        });
      }
      res.json({ success: true, alreadyClaimed: false, user: toPublicUser(user) });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to claim streak" });
    }
  });

  app.post("/api/achievements/claim", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const id = typeof req.body?.id === "string" ? req.body.id : "";
      const result = await claimAchievement(req.user!.phone, id);
      if (!result.success) {
        const status = result.reason === "unknown" ? 400 : result.reason === "ineligible" ? 403 : 409;
        const error = result.reason === "unknown"
          ? "Unknown achievement."
          : result.reason === "ineligible"
            ? "Achievement completion is not proven by server records."
            : "Achievement already claimed.";
        return res.status(status).json({ success: false, error });
      }
      const user = await findUserByPhone(req.user!.phone);
      res.json({ success: true, reward: result.reward, user: toPublicUser(user) });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to claim achievement" });
    }
  });

  // Redirect-confirm fallback: after Stripe checkout, the browser lands on
  // success_url with ?session_id=. This verifies the session server-side and
  // credits it if the webhook hasn't already — so a misconfigured/failed webhook
  // can never silently swallow a purchase. The shared transaction uses the
  // Stripe session ID as its durable idempotency key.
  app.get("/api/credits/confirm", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const sessionId = req.query.session_id as string;
      if (!sessionId) return res.status(400).json({ success: false, error: "Missing session_id" });
      if (!stripe) {
        return res.status(503).json({ success: false, error: "Credit purchases are temporarily unavailable." });
      }
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const result = await fulfillCreditPurchaseSession(session, req.user!.phone, grantPurchasedCredits);
      if (!result.applied) {
        return res.json({ success: true, alreadyCredited: true, balance: result.balance });
      }
      res.json({ success: true, credited: result.credits, balance: result.balance });
    } catch (err: any) {
      if (err instanceof CreditPurchaseValidationError) {
        return res.status(400).json({ success: false, error: "Session not eligible for crediting." });
      }
      res.status(500).json({ success: false, error: "Failed to confirm purchase." });
    }
  });

  // Credit transaction history — powers spend tracking / the Profile ledger.
  app.get("/api/credits/history", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const history = await getCreditHistory(req.user!.phone, 25);
      res.json({ history });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to load credit history" });
    }
  });

  // Sharing remains available, but browser-reported completion is not payment
  // evidence and therefore cannot mint wallet credits.
  app.post("/api/credits/reward", requireAuth, async (req: AuthedRequest, res) => {
    return res.status(410).json({
      success: false,
      error: "Share rewards are disabled because a browser share cannot be independently verified.",
    });
  });

  // ---------------------------------------------------------------------------
  // Community endpoints (Local Info + Memory Board). All degrade gracefully so
  // the Community page never breaks if an upstream API is down or unconfigured.
  // ---------------------------------------------------------------------------

  const weatherCodeToText = (code: number): string => {
    const m: Record<number, string> = {
      0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
      45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
      61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow", 73: "Snow",
      75: "Heavy snow", 80: "Rain showers", 81: "Rain showers", 82: "Violent showers",
      95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ hail",
    };
    return m[code] ?? "—";
  };

  // Nearby parks via Google Places Nearby Search (server key).
  app.get("/api/community/parks", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { lat, lng } = req.query;
      const key = process.env.GOOGLE_MAPS_API_KEY_SERVER;
      if (!lat || !lng || !key) return res.json({ parks: [] });
      const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=6000&type=park&key=${key}`;
      const r = await fetch(url);
      const j: any = await r.json().catch(() => ({}));
      const parks = (j.results || []).slice(0, 8).map((p: any) => ({
        name: p.name,
        address: p.vicinity || "",
        rating: p.rating ?? null,
        open: p.opening_hours?.open_now ?? null,
      }));
      res.json({ parks });
    } catch {
      res.json({ parks: [] });
    }
  });

  // Weather: try Google Weather API, fall back to free open-meteo so it always renders.
  app.get("/api/community/weather", requireAuth, async (req: AuthedRequest, res) => {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.json({ weather: null });
    const key = process.env.GOOGLE_MAPS_API_KEY_SERVER;
    if (key) {
      try {
        const gUrl = `https://weather.googleapis.com/v1/currentConditions:lookup?key=${key}&location.latitude=${lat}&location.longitude=${lng}`;
        const r = await fetch(gUrl);
        if (r.ok) {
          const j: any = await r.json();
          const tempC = j?.temperature?.degrees;
          if (typeof tempC === "number") {
            return res.json({ weather: {
              tempC: Math.round(tempC),
              tempF: Math.round(tempC * 9 / 5 + 32),
              condition: j?.weatherCondition?.description?.text || "—",
              source: "google",
            } });
          }
        }
      } catch { /* fall through to open-meteo */ }
    }
    try {
      const oUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code`;
      const r = await fetch(oUrl);
      const j: any = await r.json();
      const t = j?.current?.temperature_2m;
      if (typeof t === "number") {
        return res.json({ weather: {
          tempC: Math.round(t),
          tempF: Math.round(t * 9 / 5 + 32),
          condition: weatherCodeToText(j?.current?.weather_code),
          source: "open-meteo",
        } });
      }
    } catch { /* ignore */ }
    res.json({ weather: null });
  });

  // Pet-related recall news via openFDA food enforcement (free, no key).
  app.get("/api/community/recalls", requireAuth, async (_req: AuthedRequest, res) => {
    try {
      const url = `https://api.fda.gov/food/enforcement.json?search=product_description:(pet+dog+cat+animal)&sort=recall_initiation_date:desc&limit=8`;
      const r = await fetch(url);
      const j: any = await r.json().catch(() => ({}));
      const recalls = (j.results || []).map((x: any) => ({
        product: (x.product_description || "Pet product").slice(0, 160),
        reason: (x.reason_for_recall || "").slice(0, 200),
        company: x.recalling_firm || "",
        date: x.recall_initiation_date || "",
        classification: x.classification || "",
      }));
      res.json({ recalls });
    } catch {
      res.json({ recalls: [] });
    }
  });

  // Community memory board: list + upload.
  app.get("/api/community/memories", requireAuth, async (_req: AuthedRequest, res) => {
    try {
      res.json({ memories: await getCommunityMemories(30) });
    } catch {
      res.json({ memories: [] });
    }
  });

  app.post("/api/community/memories", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { image, caption } = req.body || {};
      if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
        return res.status(400).json({ error: "A photo is required." });
      }
      const imageUrl = await uploadBase64Image(image);
      const id = await addCommunityMemory(req.user!.phone, imageUrl, typeof caption === "string" ? caption : null);
      res.json({ success: true, memory: { id, image_url: imageUrl, caption: caption || null } });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to share memory." });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene Backgrounds (Phase 5)
  // ---------------------------------------------------------------------------
  app.post("/api/scenes/backgrounds", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { type, locationUrl, uploadDataUrl, prompt } = req.body;
      let finalDataUrl: string | null = null;
      
      if (type === "location" && locationUrl) {
        // e.g. from /api/landmarks
        finalDataUrl = await fetchUrlAsBase64(locationUrl);
      } else if (type === "upload" && uploadDataUrl) {
        if (!uploadDataUrl.startsWith("data:image")) {
          return res.status(400).json({ error: "Invalid image data url" });
        }
        finalDataUrl = uploadDataUrl;
      } else if (type === "prompt" && prompt) {
        finalDataUrl = await generateImageWithFallback(
          [{ text: prompt }],
          "scene-background",
          req.user!.phone,
        );
      } else {
        return res.status(400).json({ error: "Valid type (location|upload|prompt) and payload required" });
      }

      if (!finalDataUrl) {
        return res.status(500).json({ error: "Failed to resolve background image" });
      }

      // Save to local scenes/backgrounds + mirror to B2 via uploadBase64Image
      const imageUrl = await uploadBase64Image(finalDataUrl);
      const bgId = require("uuid").v4();
      
      // We also store it in the workspace for consistency
      const match = finalDataUrl.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
      if (match) {
        const { resolveWithinWorkspace } = require("./server/animator/paths.ts");
        const fs = require("fs");
        const ext = match[1].includes("png") ? ".png" : ".jpg";
        const localPath = resolveWithinWorkspace(`scenes/backgrounds/${bgId}${ext}`);
        fs.writeFileSync(localPath, Buffer.from(match[2], "base64"));
      }

      res.json({ success: true, bgId, imageUrl });
    } catch (err: any) {
      const status = err instanceof ImageGenerationBudgetError
        ? (err.code === "IMAGE_GENERATION_USER_CAP" ? 429 : 503)
        : 500;
      res.status(status).json({ error: err.message || "Failed to prepare background", code: err?.code });
    }
  });


  // ---------------------------------------------------------------------------
  // User photo library: profile thumbnail + add/remove gallery.
  // ---------------------------------------------------------------------------

  // Set (or replace) the profile thumbnail. Also files it into the photo library.
  app.post("/api/profile/photo", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { image } = req.body || {};
      if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
        return res.status(400).json({ error: "A photo is required." });
      }
      const url = await uploadBase64Image(image);
      await setProfilePhoto(req.user!.phone, url);
      await addUserPhoto(req.user!.phone, url, "profile");
      const user = await findUserByPhone(req.user!.phone);
      res.json({ success: true, user: toPublicUser(user) });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to update profile photo." });
    }
  });

  app.get("/api/profile/photos", requireAuth, async (req: AuthedRequest, res) => {
    try {
      res.json({ photos: await getUserPhotos(req.user!.phone) });
    } catch {
      res.json({ photos: [] });
    }
  });

  app.post("/api/profile/photos", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { image } = req.body || {};
      if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
        return res.status(400).json({ error: "A photo is required." });
      }
      const url = await uploadBase64Image(image);
      const id = await addUserPhoto(req.user!.phone, url, "upload");
      res.json({ success: true, photo: { id, image_url: url, source: "upload" } });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to add photo." });
    }
  });

  app.delete("/api/profile/photos/:id", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const ok = await deleteUserPhoto(Number(req.params.id), req.user!.phone);
      res.json({ success: ok });
    } catch {
      res.status(500).json({ success: false, error: "Failed to delete photo." });
    }
  });

  // --- Pets Endpoints ---
  app.get("/api/pets", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const pets = await getPets(req.user!.phone);
      res.json({ pets });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch pets." });
    }
  });

  app.post("/api/pets", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { name, kind } = req.body;
      if (!name || !kind) return res.status(400).json({ error: "Name and kind required." });
      const id = await addPet(req.user!.phone, name, kind);
      res.json({ success: true, id });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to add pet." });
    }
  });

  app.put("/api/pets/:id", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { name, kind } = req.body;
      const success = await updatePet(Number(req.params.id), req.user!.phone, name, kind);
      res.json({ success });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to update pet." });
    }
  });

  app.delete("/api/pets/:id", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const success = await deletePet(Number(req.params.id), req.user!.phone);
      res.json({ success });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to delete pet." });
    }
  });

  // --- Avatar Endpoints ---
  app.get("/api/avatars", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const avatars = await getAvatars(req.user!.phone);
      res.json({ avatars });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch avatars." });
    }
  });

  /**
   * Layer 1 of avatar generation: fuse one or more pet photos into a single
   * hyper-realistic reference image (standing on all 4 legs, facing forward,
   * slight panting expression) that is then fed to the image-to-3D pipeline.
   * Returns a data URL, or null if generation fails (caller falls back to first photo).
   */
  /**
   * COLOR-COORDINATION LOCK. Extract a short, explicit palette descriptor from
   * the approved front view and inject it verbatim into every turnaround prompt
   * so all four views share exactly the same colours. Colour drift between views
   * is the #1 failure mode of multiview-to-3D, producing muddy/striped textures.
   */
  async function extractPalette(frontDataUrl: string, type: ExtendedSubjectClass): Promise<string | null> {
    const m = frontDataUrl.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
    if (!m) return null;
    const part = { inlineData: { data: m[2], mimeType: m[1] } };
    const instruction = extractPaletteInstruction(type);
    for (const model of TEXT_MODELS) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: { parts: [part, { text: instruction }] },
        });
        const text = (response.text || "").trim().replace(/\s+/g, " ");
        if (text) return text.slice(0, 300);
      } catch (err) {
        console.warn(`[palette] ${model} failed:`, err);
      }
    }
    return null;
  }

  /**
   * Best-first TEXT model chain, used by extractPalette. Previously hardcoded as
   * ["gemini-3.1-flash-lite"] while GEMINI_TEXT_FALLBACK_MODEL
   * was declared in .env.example but read nowhere (GEMINI_CALL_AUDIT.md §4.1).
   * Defaults preserve the exact previous behaviour; the env var now works.
   */
  // Only include the fallback when explicitly set — no default so the chain
  // stays single-model (gemini-3.1-flash-lite) unless an operator opts in.
  // appears unless the operator deliberately opts in.
  const TEXT_MODELS: string[] = [
    (process.env.GEMINI_TEXT_MODEL || "gemini-3.1-flash-lite").trim(),
    process.env.GEMINI_TEXT_FALLBACK_MODEL?.trim() ?? "",
  ].filter(Boolean);

  // Best-first image model chain (Nano Banana family, per ai.google.dev/models).
  //  - gemini-3-pro-image          = Nano Banana Pro    (state-of-the-art, studio 4K) → best quality
  //  - gemini-3.1-flash-image      = Nano Banana 2      (fast, production-scale)
  //  - gemini-3.1-flash-lite-image = Nano Banana 2 Lite (ultra-low latency / cost)
  // Override without a redeploy via GEMINI_IMAGE_MODELS (comma-separated).
  const currentImageModelChain = (raw: string): string[] => {
    const configured = raw
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean)
      // Gemini 2.x image names are retired from this production boundary.
      .filter((model) => !/^gemini-2\./i.test(model));
    return configured.length > 0 ? configured : ["gemini-3.1-flash-image"];
  };
  const IMAGE_MODELS: string[] = currentImageModelChain(
    process.env.GEMINI_IMAGE_MODELS ||
      "gemini-3-pro-image,gemini-3.1-flash-image,gemini-3.1-flash-lite-image",
  );

  /**
   * Per-tier image model chains for Fido's Styles quality tiers. Each falls back
   * to the shared IMAGE_MODELS chain when unset, so tiers degrade to current
   * behaviour rather than failing. Same comma-separated override contract as
   * GEMINI_IMAGE_MODELS — see GEMINI_CALL_AUDIT.md §4.5.
   */
  const IMAGE_MODELS_BY_TIER: Record<"draft" | "standard" | "studio", string[]> = {
    draft: currentImageModelChain(
      process.env.GEMINI_IMAGE_MODELS_DRAFT ||
        "gemini-3.1-flash-lite-image,gemini-3.1-flash-image",
    ),
    standard: currentImageModelChain(
      process.env.GEMINI_IMAGE_MODELS_STANDARD || "gemini-3.1-flash-image",
    ),
    studio: currentImageModelChain(
      process.env.GEMINI_IMAGE_MODELS_STUDIO ||
        "gemini-3-pro-image,gemini-3.1-flash-image",
    ),
  };
  void IMAGE_MODELS_BY_TIER; // wired by the Fido's Styles workspace (spec §6.5)

  /**
   * Generate one image from parts with model fallback; returns a data URL or null.
   *
   * CRITICAL: image output from `generateContent` requires
   * `config.responseModalities` to include "IMAGE" — without it the model returns
   * TEXT only, no inlineData part, and the whole avatar pipeline silently produces
   * nothing (and never uploads to Backblaze). The active 3.x image models receive
   * the same square image configuration.
   */
  async function generateImageWithFallback(
    parts: any[],
    label: string,
    userPhone: string,
    errRef?: { code?: number | string; message?: string; quota?: boolean },
    aspectRatio: "1:1" | "4:5" = "1:1",
  ): Promise<string | null> {
    for (const model of IMAGE_MODELS) {
      try {
        // Reserve one durable budget unit for each actual image-model request,
        // including fallbacks. Admins are included because provider spend is
        // independent of PupCoin billing.
        await reserveImageGenerationCall(userPhone);
        const response = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          // responseModalities MUST include IMAGE or the model returns text only.
          // All current Nano Banana models honour imageConfig.aspectRatio.
          config: {
            responseModalities: ["IMAGE", "TEXT"],
            imageConfig: { aspectRatio },
          },
        });
        const cand: any = response.candidates?.[0];
        const outParts: any[] = cand?.content?.parts || [];
        for (const part of outParts) {
          if (part.inlineData?.data) {
            const mt = part.inlineData.mimeType || "image/png";
            return `data:${mt};base64,${part.inlineData.data}`;
          }
        }
        // No image part — surface WHY so this never fails silently again.
        const finish = cand?.finishReason || "unknown";
        const block = (response as any)?.promptFeedback?.blockReason;
        let txt = "";
        try { txt = (response.text || "").slice(0, 160); } catch { /* no text accessor */ }
        console.warn(`[${label}] ${model} returned no image part (finishReason=${finish}${block ? ", block=" + block : ""}). text="${txt}"`);
        if (errRef) errRef.message = `no image part from ${model} (finishReason=${finish}${block ? ", block=" + block : ""})`;
      } catch (err: any) {
        if (err instanceof ImageGenerationBudgetError) throw err;
        const msg = err?.message || String(err);
        const code = err?.status ?? err?.code;
        const quota = /RESOURCE_EXHAUSTED|resource_?exhausted|depleted|quota|too_many_requests|\b429\b/i.test(msg) || code === 429;
        if (errRef) { errRef.code = code; errRef.message = msg; errRef.quota = errRef.quota || quota; }
        console.warn(`[${label}] ${model} failed:`, msg);
      }
    }
    console.error(`[${label}] all image models failed to return an image.`);
    return null;
  }

  /**
   * Generate the full turnaround (left side, back, right side) from the front
   * view, with the palette lock injected so all four views stay colour-matched.
   * Returns whatever views succeeded — the Tripo caller degrades gracefully.
   */
  async function generateTurnaroundViews(
    frontDataUrl: string,
    palette: string | null,
    type: ExtendedSubjectClass,
    userPhone: string,
  ): Promise<Partial<Record<"left" | "back" | "right", string>>> {
    const m = frontDataUrl.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
    if (!m) return {};
    const frontPart = { inlineData: { data: m[2], mimeType: m[1] } };
    const lock = paletteLockClause(type, palette);
    const views = turnaroundViewsForType(type);
    const results = await Promise.all(
      views.map(async ({ view, prompt }) => {
        const img = await generateImageWithFallback(
          [frontPart, { text: prompt + lock + " Respond with only the generated image." }],
          `turnaround:${view}`,
          userPhone,
        );
        return [view, img] as const;
      })
    );
    const out: Partial<Record<"left" | "back" | "right", string>> = {};
    for (const [view, img] of results) if (img) out[view] = img;
    return out;
  }

  async function generatePetReferenceImage(
    photos: string[],
    accent: string | null | undefined,
    type: ExtendedSubjectClass,
    hasFacePhoto?: boolean,
    extra?: string,
    userPhone?: string,
    errRef?: { code?: number | string; message?: string; quota?: boolean },
    style?: string | null,
    subjectSubtype?: string | null,
  ): Promise<string | null> {
    const imageParts: any[] = [];
    photos.forEach((p, idx) => {
      const matches = p.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
      if (!matches || matches.length < 3) return;

      // Label each image part so Gemini knows its role
      if (hasFacePhoto && idx === 0) {
        imageParts.push({ text: `[FACE CLOSE-UP]: Use this as the primary reference for facial features.` });
      } else {
        const photoNum = hasFacePhoto ? idx : idx + 1;
        imageParts.push({ text: `[REFERENCE PHOTO ${photoNum}]: Additional angle for body, proportions, and details.` });
      }
      imageParts.push({ inlineData: { data: matches[2], mimeType: matches[1] } });
    });

    if (imageParts.length === 0) return null;

    const corrective = (extra || "").trim();
    const referencePrompt = buildReferencePrompt(type, accent, hasFacePhoto, photos.length, style, subjectSubtype)
      + (corrective ? ` IMPORTANT — fix these issues from the previous attempt: ${corrective}.` : "");
    // Route through the shared helper so the responseModalities fix + failure
    // logging apply identically to every image path in the pipeline.
    if (!userPhone) throw new Error("Authenticated image-generation owner is required.");
    return generateImageWithFallback([...imageParts, { text: referencePrompt }], "referenceImage", userPhone, errRef);
  }

  app.post("/api/avatars", requireAuth, paidLimiter, async (req: AuthedRequest, res) => {
    let creditReservationId: string | null = null;
    let freeAvatarClaimed = false;
    try {
      const { name, photo, photos, palette, avatar_type, face_photo, input_mode, subject, detail, texture, style, lighting, selection_mode, subject_subtype } = req.body;
      // Defensive: accept either camelCase or snake_case so a frontend mismatch can't silently break text mode.
      const inputMode: "image" | "text" = (input_mode ?? req.body.inputMode) === "text" ? "text" : "image";
      const avatarTypeRaw = avatar_type ?? req.body.avatarType;
      const selectionMode: "auto" | "manual" = selection_mode === "auto" ? "auto" : "manual";
      const subjectSubtype = typeof subject_subtype === "string" ? subject_subtype.trim().slice(0, 40) : "";
      const facePhotoRaw = face_photo ?? req.body.facePhoto;
      // Normalize the UI type to a canonical ExtendedSubjectClass ('dog' == animal).
      let avatarType: ExtendedSubjectClass = (avatarTypeRaw as any);
      // Accept new multi-photo payload; keep backward compat with single `photo`.
      const photoList: string[] = Array.isArray(photos) && photos.length > 0
        ? photos.filter((p: unknown) => typeof p === "string" && p.length > 0)
        : (photo ? [photo] : []);
      // Optional UI-selected accent palette for colour coordination.
      const accent: string | null = typeof palette === "string" && palette ? palette : null;
      // Dedicated face photo from the face upload slot
      const hasFacePhoto: boolean = typeof facePhotoRaw === "string" && facePhotoRaw.length > 0;

      if (!name) {
        return res.status(400).json({ error: "Name is required." });
      }

      // Input validation up-front (before any paid image generation).
      if (inputMode === "text") {
        if (!subject || typeof subject !== "string" || subject.trim().length < 2) {
          return res.status(400).json({ error: "Describe what to make (a short subject phrase)." });
        }
        if (subject.length > 600) {
          return res.status(400).json({ error: "Subject description is too long (max 600 characters)." });
        }
      } else {
        if (photoList.length === 0) {
          return res.status(400).json({ error: "At least one photo required." });
        }
        if (photoList.length > 6) {
          return res.status(400).json({ error: "Maximum 6 photos per avatar (1 face + 5 body)." });
        }
      }

      // The customer-gated Pet GLB builder owns new model creation once it is
      // enabled. Reject stale legacy clients before any Gemini image request;
      // the old route could otherwise fan one click into 4-6 Pro image calls
      // and only discover the migration after that provider spend.
      {
        return res.status(410).json({
          error: "Legacy avatar creation has moved to the customer-gated Create flow.",
          code: "LEGACY_AVATAR_DISABLED",
        });
      }

      let autoDetection: TriageResult | null = null;
      if (selectionMode === "auto") {
        if (inputMode === "image" && photoList[0]) {
          try {
            const { data, mimeType } = splitDataUrl(photoList[0]);
            autoDetection = await triageReferenceImage(classifyGenerate, { imageBase64: data, mimeType, userType: "dog" });
            avatarType = autoDetection.subjectClass;
          } catch (error: any) {
            console.warn("[POST /api/avatars] Auto Detect preflight unavailable; using animal workflow:", error?.message || error);
          }
        } else if (inputMode === "text") {
          const words = String(subject || "").toLowerCase();
          if (/\b(person|human|man|woman|boy|girl|child|presenter|character)\b/.test(words)) avatarType = "human";
          else if (/\b(chair|table|car|vehicle|building|house|toy|object|food|plant|tool|machine|prop|statue)\b/.test(words)) avatarType = "object";
        }
      }

      const avatarCost = avatarGenerationCost(getSubjectClassForSpecies(avatarType), inputMode);
      let payableAvatarCost = avatarCost;

      const isAdmin = await isUserAdmin(req.user!.phone);

      // Phase 9 — hard model cap. Non-admin users may keep at most MODEL_CAP
      // models on pawsome3d.com. (Cold-storage/warehouse offload to mypets.cc is
      // a future phase; for now the limit is total models, checked before any
      // credit charge or generation work so a capped user isn't billed.)
      if (!isAdmin) {
        const MODEL_CAP = Number(process.env.MODEL_CAP) || 5;
        const existingAvatars = await getAvatars(req.user!.phone);
        if (existingAvatars.length >= MODEL_CAP) {
          return res.status(403).json({
            success: false,
            error: `You've reached your ${MODEL_CAP}-model limit. Delete a model before creating a new one.`,
            code: "MODEL_CAP_REACHED",
          });
        }
      }

      if (!isAdmin) {
        freeAvatarClaimed = await claimFreeAvatar(req.user!.phone);
        if (freeAvatarClaimed) payableAvatarCost = 0;
      }

      if (!isAdmin) {
        const balance = await getCreditBalance(req.user!.phone);
        if (balance < payableAvatarCost) {
          return res.status(402).json({ error: `Insufficient PupCoins. You need ${payableAvatarCost} PupCoins.` });
        }
      }

      let finalImageUrl = "";
      let viewSet: { left?: string; back?: string; right?: string } | undefined;
      let usedReferenceImage = false;

      // ── Step 1–3: generate an AI reference image → SAVE it to Backblaze →
      // QUALIFY the saved image (score) → only a passing image proceeds to Tripo.
      // Up to 2 regenerations (3 attempts total). We NEVER silently ship the raw
      // uploaded photo: if the AI image can't be generated we stop with a clear
      // error and no credits are deducted (they're only deducted after a pass).
      const MAX_ATTEMPTS = 3;
      let triage: TriageResult | null = null;
      let chosenImage: string | null = null;     // the passing AI-generated data URL
      let chosenUrl: string | null = null;        // its Backblaze URL
      let corrective = "";
      const imgErr: { code?: number | string; message?: string; quota?: boolean } = {};

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Produce a candidate AI image (front-facing 3D render).
        let candidate: string | null;
        if (inputMode === "text") {
          const fields: TextPromptFields = { subject, style, lighting, corrective };
          candidate = await generateImageWithFallback(
            [{ text: buildTextPrompt(fields) }],
            "text-to-reference",
            req.user!.phone,
            imgErr,
          );
        } else {
          candidate = await generatePetReferenceImage(
            photoList,
            accent,
            avatarType,
            hasFacePhoto,
            corrective,
            req.user!.phone,
            imgErr,
            style,
            subjectSubtype,
          );
        }

        if (!candidate) {
          // AI generation failed. Quota/billing errors won't recover on retry — stop early.
          if (imgErr.quota || attempt >= MAX_ATTEMPTS) break;
          continue;
        }

        // SAVE the generated image to Backblaze FIRST, so every AI render is
        // persisted (and inspectable) before we score it.
        let uploadedUrl: string | null = null;
        try {
          uploadedUrl = candidate.startsWith("data:image") ? await uploadBase64Image(candidate) : candidate;
        } catch (e: any) {
          console.warn("[POST /api/avatars] could not upload candidate image:", e?.message || e);
        }

        // QUALIFY + auto-detect in one vision call. If the QA call itself fails
        // (LLM unavailable), don't block generation — accept the saved candidate.
        try {
          const { data, mimeType } = splitDataUrl(candidate);
          triage = await triageReferenceImage(classifyGenerate, { imageBase64: data, mimeType, userType: avatarType });
        } catch (e: any) {
          console.warn("[POST /api/avatars] triage unavailable; accepting candidate:", e?.message || e);
          triage = null;
          chosenImage = candidate;
          chosenUrl = uploadedUrl;
          usedReferenceImage = true;
          break;
        }

        if (triagePasses(triage)) {
          chosenImage = candidate;
          chosenUrl = uploadedUrl;
          usedReferenceImage = true;
          break;
        }
        // Failed QA → build corrective guidance and regenerate.
        corrective = correctiveFromTriage(triage);
        console.log(`[POST /api/avatars] QA attempt ${attempt} rejected (score ${triage.qualify.score}); corrective: ${corrective}`);
      }

      // No usable AI image was produced.
      if (!chosenImage) {
        // (a) all attempts generated an image but failed QA → quality rejection.
        if (triage && !triagePasses(triage)) {
          return res.status(422).json({ error: friendlyQualifyError(triage), code: "IMAGE_QUALITY_REJECTED" });
        }
        // (b) the AI image model itself failed. Distinguish quota/billing so the
        // operator sees the real cause (top up the Gemini API billing account).
        if (imgErr.quota) {
          console.error("[POST /api/avatars] Gemini image generation quota/billing exhausted:", imgErr.message);
          return res.status(503).json({
            error: "AI image generation is temporarily unavailable (image model quota/billing exhausted). Please try again later.",
            code: "IMAGE_QUOTA_EXHAUSTED",
          });
        }
        return res.status(502).json({
          error: "Could not generate an AI image. Please try again with a clearer photo or a more descriptive prompt.",
          code: "IMAGE_GENERATION_FAILED",
        });
      }

      // ── Auto-detection soft-switch: if the detected class disagrees with what
      // the user picked (high confidence), switch and tell them.
      let detectNotice: string | undefined;
      if (triage && isClassMismatch(triage, avatarType)) {
        const detected = triage.subjectClass;
        detectNotice = selectionMode === "manual"
          ? `We detected a ${classLabel(detected)}, but kept your selected ${classLabel(avatarType)} workflow. Use Auto Detect on a new build if you want detection to choose instead.`
          : `Auto Detect initially chose ${classLabel(avatarType)}. The finished reference looked more like ${classLabel(detected)}, so we kept the original detected workflow to avoid silently rebuilding it as another type.`;
        console.log(`[POST /api/avatars] class mismatch: selected=${avatarType} detected=${detected} (${triage.classConfidence}) — selection remains authoritative.`);
      }

      // ── Layer 1.5: COLOR-COORDINATION LOCK + multiview turnaround. Animals only
      // (dogs); humans stay single-image (intentional), objects default to single-image.
      if (avatarType === 'dog' && chosenImage.startsWith("data:image")) {
        try {
          const paletteStr = usedReferenceImage ? await extractPalette(chosenImage, avatarType) : null;
          const rawViews = await generateTurnaroundViews(
            chosenImage,
            paletteStr,
            avatarType,
            req.user!.phone,
          );
          const uploaded: { left?: string; back?: string; right?: string } = {};
          for (const key of ["left", "back", "right"] as const) {
            const v = rawViews[key];
            if (v) uploaded[key] = v.startsWith("data:image") ? await uploadBase64Image(v) : v;
          }
          if (Object.keys(uploaded).length) viewSet = uploaded;
        } catch (e: any) {
          rethrowImageGenerationBudgetError(e);
          console.warn("[POST /api/avatars] Turnaround/multiview generation skipped:", e?.message || e);
        }
      }

      // Reuse the Backblaze URL from the save-then-score step (upload once).
      finalImageUrl = chosenUrl || (chosenImage.startsWith("data:image") ? await uploadBase64Image(chosenImage) : chosenImage);

      // Persist uploaded photos to the user's library (image mode only). Fire-and-forget.
      if (inputMode !== "text" && photoList.length) {
        const phoneForPhotos = req.user!.phone;
        (async () => {
          for (const p of photoList) {
            try {
              const purl = p.startsWith("data:image") ? await uploadBase64Image(p) : p;
              await addUserPhoto(phoneForPhotos, purl, "avatar_builder");
            } catch (e: any) {
              console.warn("[avatar photos] could not persist an uploaded photo:", e?.message || e);
            }
          }
        })();
      }

      const geo = (detail || texture) ? geometryToTripo(detail, texture) : undefined;

      // Deduct credits ONLY now that we have a qualified image and are starting Tripo.
      if (!isAdmin && payableAvatarCost > 0) {
        creditReservationId = await reserveCredits(req.user!.phone, payableAvatarCost, "avatar_generation");
        if (!creditReservationId) return res.status(402).json({ error: `Insufficient PupCoins. You need ${payableAvatarCost} PupCoins.` });
      }

      // Compact analysis record persisted for the build/rig stage (§8 "memory").
      const generationAnalysis = {
            outputStyle: typeof style === "string" && style ? style : "auto",
            selectionMode,
            subjectSubtype: subjectSubtype || undefined,
            autoDetectedClass: autoDetection?.subjectClass,
            ...(triage ? {
            subjectClass: avatarType,
            detected: triage.subjectClass,
            classConfidence: triage.classConfidence,
            species: triage.species || (avatarType === 'human' ? 'human' : undefined),
            breed: triage.breed || undefined,
            breedConfidence: triage.breedConfidence,
            bodyType: triage.bodyType,
            legCount: triage.legCount,
            hasTail: triage.hasTail,
            coatColors: triage.coatColors,
            coatPattern: triage.coatPattern,
            objectCategory: avatarType === 'object'
              ? ({ structure: "structure", plant: "plant", food: "food", part: "part", vehicle: "prop", collectible: "prop", prop: "prop" } as Record<string, string>)[subjectSubtype] || triage.objectCategory
              : undefined,
            objectCategoryConfidence: avatarType === 'object' ? triage.objectCategoryConfidence : undefined,
            humanAnatomy: avatarType === 'human' ? triage.humanAnatomy : undefined,
            qualify: triage.qualify,
            } : { subjectClass: avatarType }),
          };

      // Layer 2: start Tripo3D generation (multiview when turnaround views exist).
      const handle = await startImageTo3D({ imageUrl: finalImageUrl, views: viewSet, geometry: geo });
      const avatarId = await createAvatar(req.user!.phone, name, finalImageUrl, handle, {
        avatar_type: avatarType,
        breed: triage?.breed || (avatarType === "dog" && subjectSubtype ? subjectSubtype : undefined),
        generation_analysis: generationAnalysis,
      });
      if (viewSet) {
        try { await updateAvatarMultiview(avatarId, viewSet); }
        catch (e: any) { console.warn("[POST /api/avatars] could not persist multiview views:", e?.message || e); }
      }

      res.json({ avatarId, status: "pending", referenceImageUrl: finalImageUrl, usedReferenceImage, avatarType, notice: detectNotice, chargedCredits: payableAvatarCost });
    } catch (err: any) {
      if (creditReservationId) {
        try { await refundReservedCredits(creditReservationId); } catch {}
      }
      if (freeAvatarClaimed) {
        try { await releaseFreeAvatar(req.user!.phone); } catch {}
      }
      if (err instanceof ImageGenerationBudgetError) {
        return res.status(err.code === "IMAGE_GENERATION_USER_CAP" ? 429 : 503).json({
          error: err.message,
          code: err.code,
        });
      }
      if (isTripoInsufficientCredit(err)) {
        console.error("[Tripo] Platform account out of credits — top up TRIPO_API_KEY account");
        return res.status(503).json({
          error: "3D generation is temporarily unavailable. Please try again later.",
          code: "GENERATION_SERVICE_UNAVAILABLE"
        });
      }
      console.error("[POST /api/avatars] Error creating avatar:", err);
      res.status(500).json({ error: "Failed to create avatar. Please try again." });
    }
  });

  const avatarBuildLocks = new Set<number>();

  // Fix 4 (durability): auto-resume builds that were interrupted mid-flight.
  // The build runs in-process as fire-and-forget work, so a Hostinger process
  // recycle kills it after the mesh is done but before the model is saved,
  // leaving the row in a build-phase status forever. This sweep detects that
  // exact fingerprint — a post-mesh status (rigging/retargeting/baking_*) with
  // the Tripo handle already consumed (meshy_handle NULL), no model yet, aged
  // past the point a healthy build would take, and NOT locked in this process —
  // and restarts the pipeline from Tripo (same path as /retry). The 45-minute
  // reaper above remains the terminal backstop if resumes keep failing.
  // MG-9: hard ceiling on automated re-submissions per avatar. Each resume
  // spends real Tripo credits, so the sweep gets a small budget and then defers
  // to the 45-minute reaper / the user's explicit /retry.
  const MAX_LEGACY_RESUME_ATTEMPTS = 2;

  async function resumeStalledBuilds() {
    // PHASE BO-0: retired when MODEL_BUILD_V3_ENABLED is true
    if (isModelBuildV3Enabled()) return;
    let rows: any[] = [];
    try {
      const [result]: any = await getPool().query(
        `SELECT id, image_url, multiview_json, avatar_type FROM avatars
          WHERE generation_status IN ('rigging','retargeting','baking_clips','baking_sprites')
            AND (meshy_handle IS NULL OR meshy_handle = '')
            AND model_url IS NULL
            AND created_at < (NOW() - INTERVAL 12 MINUTE)
            AND created_at > (NOW() - INTERVAL 45 MINUTE)`
      );
      rows = Array.isArray(result) ? result : [];
    } catch (err: any) {
      console.warn(`[Resume] sweep query failed: ${err?.message || err}`);
      return;
    }

    for (const row of rows) {
      const avatarId = Number(row.id);
      if (avatarBuildLocks.has(avatarId)) continue; // actively building in this process
      if (!row.image_url) continue;                 // nothing to restart from

      // MG-9: claim a resume slot atomically BEFORE calling startImageTo3D.
      // Without this, every 3-minute pass (and every process recycle) could
      // submit a brand-new Tripo task for the same avatar and spend platform
      // credits again. The conditional UPDATE is the idempotency record: only
      // the pass that actually increments the counter is allowed to submit.
      let resumeClaimed = false;
      try {
        const [claim]: any = await getPool().query(
          `UPDATE avatars
              SET resume_attempts = resume_attempts + 1
            WHERE id = ?
              AND resume_attempts < ?
              AND model_url IS NULL
              AND (meshy_handle IS NULL OR meshy_handle = '')
              AND generation_status IN ('rigging','retargeting','baking_clips','baking_sprites')`,
          [avatarId, MAX_LEGACY_RESUME_ATTEMPTS],
        );
        resumeClaimed = Number(claim?.affectedRows || 0) > 0;
      } catch (err: any) {
        console.warn(`[Resume] Could not claim resume slot for avatar ${avatarId}: ${err?.message || err}`);
        continue;
      }
      if (!resumeClaimed) continue; // budget spent, or another worker won the claim

      try {
        let imageUrl: string = row.image_url;
        if (imageUrl.startsWith("data:image")) {
          imageUrl = await uploadBase64Image(imageUrl);
          await getPool().query(`UPDATE avatars SET image_url = ? WHERE id = ?`, [imageUrl, avatarId]);
        }
        let views = parseMultiview(row.multiview_json) || undefined;
        if (row.avatar_type === 'human') {
          views = undefined;
        }
        const handle = await startImageTo3D({ imageUrl, views });
        await getPool().query(
          `UPDATE avatars SET meshy_handle = ?, generation_status = 'pending', generation_error = NULL WHERE id = ?`,
          [handle, avatarId]
        );
        console.log(`[Resume] Restarted stalled build for avatar ${avatarId}`);
      } catch (err: any) {
        console.warn(`[Resume] Could not restart avatar ${avatarId}: ${err?.message || err}`);
      }
    }
  }
  if (!isModelBuildV3Enabled() && !isInHouseOnly()) {
    resumeStalledBuilds();
    setInterval(resumeStalledBuilds, 3 * 60 * 1000);
  }

  app.get("/api/avatars/:id/status", requireAuth, rejectLegacyExternal3dRoute, async (req: AuthedRequest, res) => {
    try {
      const avatarId = Number(req.params.id);
      const avatar = await getAvatarById(avatarId, req.user!.phone);
      if (!avatar) return res.status(404).json({ error: "Avatar not found" });

      if (["done", "done_static_fallback", "failed"].includes(avatar.generation_status)) {
        return res.json({ 
          status: avatar.generation_status,
          model_url: avatar.model_url,
          sprite_sheet_url: avatar.sprite_sheet_url
        });
      }

      // Check Tripo3D for status
      if (avatar.meshy_handle) {
        const poll = await pollImageTo3D(avatar.meshy_handle);
        if (poll.done && !poll.error) {
          if (avatarBuildLocks.has(avatarId)) {
            return res.json({ status: "rigging" });
          }
          avatarBuildLocks.add(avatarId);
          await getPool().query(`UPDATE avatars SET meshy_handle = NULL WHERE id = ?`, [avatarId]);

          const avatarPhone = req.user!.phone;
          const originalImageUrl = avatar.image_url;
          const glbUrl = poll.glbUrl!;

          // ── STATIC OBJECT: no rig, no brain, no clips. Persist the raw GLB and
          // mark done. (The UI promises "static GLB, no rigging" for objects.)
          // The build now BRANCHES on the detected object sub-category: a
          // blueprint is a 2D plan (not reconstructable) and is failed cleanly;
          // every other kind stores a placement/orientation profile alongside
          // the mesh so the AR/3D scene knows how to place it.
          if (avatar.avatar_type === 'object') {
            (async () => {
              try {
                const gaObj: any = avatar.generation_analysis
                  ? (typeof avatar.generation_analysis === "string" ? JSON.parse(avatar.generation_analysis) : avatar.generation_analysis)
                  : null;
                const profile = objectBuildProfile(gaObj?.objectCategory);

                if (!profile.reconstructable) {
                  console.log(`[Avatar ${avatarId}] Object rejected as non-reconstructable (${profile.category}).`);
                  await updateAvatarGenerationStatus(avatarId, "failed", profile.reason || "This subject can't be built as a 3D object.");
                  return;
                }

                let finalModelUrl: string;
                try {
                  finalModelUrl = await uploadBinaryFromUrl(glbUrl, "model/gltf-binary");
                } catch (e: any) {
                  console.error(`[Avatar ${avatarId}] Failed to mirror object GLB:`, e?.message || e);
                  await updateAvatarGenerationStatus(avatarId, "failed", "Failed to mirror model to durable storage (retryable).");
                  return;
                }
                await updateAvatarModel(avatarId, avatarPhone, finalModelUrl, "", {
                  subjectClass: "object",
                  objectProfile: profile,
                });
                await updateAvatarGenerationStatus(avatarId, "done");
                console.log(`[Avatar ${avatarId}] Static ${profile.label} stored (no rigging; placement=${profile.placement}, enterable=${profile.enterable}).`);
              } catch (err: any) {
                console.error(`[Avatar ${avatarId} Object Error]`, err);
                await updateAvatarGenerationStatus(avatarId, "failed", err.message || "Failed to store static model");
              } finally {
                avatarBuildLocks.delete(avatarId);
              }
            })();
            return res.json({ status: "rigging" });
          }

          await updateAvatarGenerationStatus(avatarId, "rigging");

          if (isModelBuildV3Enabled()) {
            // BO-0: V3 is live — persist the paid Tripo GLB as a static model
            // and mark done. The user paid for Tripo generation; we must not
            // refund or fail them. The legacy rig pipeline is skipped.
            console.log(`[Avatar ${avatarId}] MODEL_BUILD_V3_ENABLED=true, persisting static GLB, skipping rig pipeline`);
            let modelUrl: string;
            try {
              modelUrl = await uploadBinaryFromUrl(glbUrl, "model/gltf-binary");
            } catch (e: any) {
              console.error(`[Avatar ${avatarId}] Failed to mirror GLB to durable storage:`, e?.message || e);
              await updateAvatarGenerationStatus(avatarId, "failed", "Failed to store model");
              avatarBuildLocks.delete(avatarId);
              return res.json({ status: "failed", error: "Failed to store model" });
            }
            await updateAvatarModel(avatarId, avatarPhone, modelUrl, "", {});
            await updateAvatarGenerationStatus(avatarId, "done");
            avatarBuildLocks.delete(avatarId);
            return res.json({ status: "done", model_url: modelUrl });
          }
          // Spawn background agent pipeline
          (async () => {
             try {
                 if (!originalImageUrl) {
                    throw new Error("Missing original image URL for this avatar.");
                 }
                 if (!glbUrl) {
                    throw new Error("Missing GLB URL from 3D generation API.");
                 }
                 
                 const originalImageBase64 = await fetchUrlAsBase64(originalImageUrl);
                 const glbBase64 = await fetchUrlAsBase64(glbUrl);

                 // §8 "memory": prefer the triage record captured at generation time
                 // (detection + anatomy) so we don't pay for a second vision analysis.
                 // Fall back to analyzePetImage only when no usable triage exists.
                 const ga: any = avatar.generation_analysis
                   ? (typeof avatar.generation_analysis === "string" ? JSON.parse(avatar.generation_analysis) : avatar.generation_analysis)
                   : null;
                 let petAnalysis: PetAnalysis;
                 if (ga && (ga.bodyType || ga.species)) {
                    petAnalysis = {
                       species: ga.species || (avatar.avatar_type === 'human' ? 'human' : 'dog'),
                       breed: ga.breed || avatar.breed || "Mixed",
                       bodyType: ga.bodyType && ga.bodyType !== 'static' ? ga.bodyType : (avatar.avatar_type === 'human' ? 'biped' : 'quadruped'),
                       estimatedPose: "standing",
                       legCount: Number.isFinite(ga.legCount) && ga.legCount > 0 ? ga.legCount : (avatar.avatar_type === 'human' ? 2 : 4),
                       hasTail: !!ga.hasTail && avatar.avatar_type !== 'human',
                       hasWings: ga.bodyType === 'winged',
                       bodyProportions: { headSize: "medium", legLength: "medium", bodyLength: "medium", neckLength: "medium" },
                       coatColors: Array.isArray(ga.coatColors) && ga.coatColors.length ? ga.coatColors : ["#C0A080"],
                       coatPattern: ga.coatPattern || "solid",
                    };
                 } else {
                    petAnalysis = await analyzePetImage(originalImageBase64);
                 }
                 // Carry a persisted "Fix the vibe" restyle hint into the material/
                 // texture step so a regeneration biases toward the softer look.
                 if (ga?.styleHint) {
                    petAnalysis = { ...petAnalysis, coatPattern: `${petAnalysis.coatPattern || "solid"} — ${ga.styleHint}` };
                 }
                 // Human anatomy audit → rig hints. Canonical figures are safe to
                 // articulate (e.g. finger rigging); anomalies (a missing eye, a
                 // six-fingered hand the generator slipped through) are logged and
                 // carried into the build metadata so the rig stage can play safe.
                 let humanRig: ReturnType<typeof humanRigHints> | null = null;
                 if (avatar.avatar_type === 'human') {
                    petAnalysis = { ...petAnalysis, species: 'human', bodyType: 'biped', legCount: 2, hasTail: false };
                    humanRig = humanRigHints(ga?.humanAnatomy);
                    if (!humanRig.canonical) {
                       console.warn(`[Avatar ${avatarId}] Human anatomy anomalies: ${humanRig.anomalies.join("; ")} — fingerRig=${humanRig.fingerRig}`);
                    }
                 }

                 const buildState = await runBuildPipeline(
                   petAnalysis,
                   glbBase64,
                   async (step, pct, detail) => {
                      // Fire-and-forget progress log
                      console.log(`[Avatar ${avatarId}] ${step}: ${detail} (${pct}%)`);
                   },
                   originalImageBase64
                );
                
                if (buildState.status === "failed") {
                   await updateAvatarGenerationStatus(avatarId, "failed", buildState.statusMessage);
                } else if (buildState.status === "completed") {
                   let finalModelUrl: string;
                   if (buildState.riggedGlbBase64) {
                      finalModelUrl = await uploadBase64Binary(buildState.riggedGlbBase64, "model/gltf-binary");
                   } else {
                      finalModelUrl = await uploadBinaryFromUrl(glbUrl, "model/gltf-binary");
                   }
                   const modelMetadata = humanRig
                      ? { ...(buildState.animationMetadata || {}), humanRig }
                      : (buildState.animationMetadata || {});
                   // Model Builder stores one clean reference image and one GLB.
                   // Sprite/contact sheets belong to animation tooling and are
                   // deliberately never uploaded or attached to avatar records.
                   await updateAvatarModel(avatarId, avatarPhone, finalModelUrl, "", modelMetadata);

                   // Mark the avatar done as soon as its static model is saved.
                   await updateAvatarGenerationStatus(avatarId, "done");

                   // Skeletal clip baking (Phase 5) is intentionally disabled: the baked-in
                   // animations did not ship reliably, so avatars now ship as static,
                   // clip-free GLBs. In-app procedural motion (AvatarModel.tsx) is unaffected.
                }
             } catch (err: any) {
                console.error(`[Avatar ${avatarId} Agent Error]`, err);
                await updateAvatarGenerationStatus(avatarId, "failed", err.message || "Unknown error in background agent");
             } finally {
                avatarBuildLocks.delete(avatarId);
             }
          })();

          return res.json({ status: "rigging" });
        } else if (poll.done && poll.error) {
          await updateAvatarGenerationStatus(avatarId, "failed", poll.error);
          return res.json({ status: "failed", error: "Generation failed" });
        } else {
          return res.json({ status: "pending" });
        }
      }

      res.json({ status: avatar.generation_status });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to poll avatar status." });
    }
  });

  app.post("/api/avatars/:id/retry", requireAuth, rejectLegacyExternal3dRoute, async (req: AuthedRequest, res) => {
    let creditReservationId: string | null = null;
    try {
      const avatarId = Number(req.params.id);
      const avatar = await getAvatarById(avatarId, req.user!.phone);
      if (!avatar) return res.status(404).json({ error: "Avatar not found" });

      // Allow retry from terminal states (failed/done) AND from the post-mesh
      // intermediate states, so a user can recover a stalled avatar without
      // waiting for the reaper. Only block during active mesh generation.
      const retryableStatuses = ["failed", "done", "rigging", "retargeting", "baking_clips", "baking_sprites"];
      if (!retryableStatuses.includes(avatar.generation_status)) {
         return res.status(400).json({ error: "Avatar is currently generating" });
      }

      const isAdmin = await isUserAdmin(req.user!.phone);
      const retryCount = Number((avatar as any).retry_count || 0);
      const retryCost = retryCount === 0 ? CREDIT_PRICES.FIRST_REGENERATION : CREDIT_PRICES.ADDITIONAL_REGENERATION;
      if (!isAdmin && retryCost > 0) {
        creditReservationId = await reserveCredits(req.user!.phone, retryCost, "avatar_regeneration");
        if (!creditReservationId) return res.status(402).json({ error: `You need ${retryCost} credits for another regeneration.` });
      }

      // Optional "Fix the vibe" restyle: attach the chosen softer-look preset to
      // this regeneration so the style is persisted and carried into the build
      // pipeline (read back from generation_analysis when petAnalysis is built).
      const STYLE_HINTS: Record<string, string> = {
        pixar_soft: "friendlier rounded features, softer eyes, less realism",
        clay: "warm clay texture, handmade, gentle surface detail",
        watercolor: "soft watercolor wash, lower contrast, tender expression",
        cartoon_eyes: "larger brighter eyes, cute highlights, less uncanny gaze",
        fur_fluff: "fluffier fur silhouette, soft face mask, cozy styling",
        soft_focus: "gentle focus, reduced shine, calmer face proportions",
      };
      const stylePreset = typeof req.body?.stylePreset === "string" ? req.body.stylePreset : null;
      if (stylePreset && STYLE_HINTS[stylePreset]) {
        try {
          const ga = avatar.generation_analysis
            ? (typeof avatar.generation_analysis === "string" ? JSON.parse(avatar.generation_analysis) : avatar.generation_analysis)
            : {};
          const merged = { ...ga, stylePreset, styleHint: STYLE_HINTS[stylePreset] };
          await getPool().query(
            `UPDATE avatars SET generation_analysis = ? WHERE id = ? AND user_phone = ?`,
            [JSON.stringify(merged), avatarId, req.user!.phone]
          );
        } catch (styleErr: any) {
          console.warn(`[Avatar ${avatarId}] Could not persist style preset: ${styleErr?.message || styleErr}`);
        }
      }

      // Reset status and error
      await updateAvatarGenerationStatus(avatarId, "pending", null);

      // Re-trigger the background generation job with Tripo3D
      if (avatar.image_url) {
        let finalImageUrl = avatar.image_url;
        if (finalImageUrl.startsWith("data:image")) {
           finalImageUrl = await uploadBase64Image(finalImageUrl);
           // Also update the avatar image_url in DB if it was base64
           await getPool().query(`UPDATE avatars SET image_url = ? WHERE id = ?`, [finalImageUrl, avatarId]);
        }
        let views = parseMultiview((avatar as any).multiview_json) || undefined;
        if (avatar.avatar_type === 'human') {
          views = undefined;
        }
        const handle = await startImageTo3D({ imageUrl: finalImageUrl, views });
        await getPool().query(
          `UPDATE avatars SET meshy_handle = ?, retry_count = retry_count + 1 WHERE id = ? AND user_phone = ?`,
          [handle, avatarId, req.user!.phone]
        );
      } else {
        return res.status(400).json({ error: "Original photo not available for retry" });
      }

      const user = await findUserByPhone(req.user!.phone);
      res.json({ success: true, status: "pending", chargedCredits: retryCost, user: toPublicUser(user, TERMS_VERSION) });
    } catch (err: any) {
      if (creditReservationId) {
        try { await refundReservedCredits(creditReservationId); } catch {}
      }
      console.error("[POST /api/avatars/:id/retry] Error retrying avatar:", err);
      res.status(500).json({ error: err.message || "Failed to retry avatar generation." });
    }
  });

  // Delete an avatar from the user's roster (owner-scoped). Removes the DB row;
  // storage files are not touched. Frees a slot under the model cap and clears
  // orphaned rows whose GLBs were already deleted from storage.
  /**
   * Remove a model from the user's roster.
   *
   * This is a soft hide, not a row delete. The old behaviour destroyed the
   * avatar row while leaving the GLB in object storage — orphaned bytes that
   * were still billed, could no longer be reclaimed, and left the user with no
   * way to undo. `?purge=1` is retained for the admin/cleanup path that really
   * does want the row gone (orphans whose storage was already deleted).
   */
  app.delete("/api/avatars/:id", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ success: false, error: "Invalid avatar id." });
      }
      const purge = req.query.purge === "1" && (await isUserAdmin(req.user!.phone));
      const success = purge
        ? await deleteAvatar(id, req.user!.phone)
        : await hideAvatar(id, req.user!.phone);
      if (!success) return res.status(404).json({ success: false, error: "Model not found." });
      res.json({ success: true, hidden: !purge });
    } catch (err: any) {
      console.error("[DELETE /api/avatars/:id] Error:", err?.message || err);
      res.status(500).json({ success: false, error: "Failed to remove model." });
    }
  });

  /** Models the user has removed from their roster but not purged. */
  app.get("/api/avatars/hidden", requireAuth, async (req: AuthedRequest, res) => {
    try {
      res.json({ success: true, avatars: await getHiddenAvatars(req.user!.phone) });
    } catch (err: any) {
      console.error("[GET /api/avatars/hidden] Error:", err?.message || err);
      res.status(500).json({ success: false, error: "Failed to load removed models." });
    }
  });

  /** Undo a removal — puts the model back on the roster. */
  app.post("/api/avatars/:id/restore", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ success: false, error: "Invalid avatar id." });
      }
      const success = await unhideAvatar(id, req.user!.phone);
      if (!success) return res.status(404).json({ success: false, error: "Removed model not found." });
      res.json({ success: true });
    } catch (err: any) {
      console.error("[POST /api/avatars/:id/restore] Error:", err?.message || err);
      res.status(500).json({ success: false, error: "Failed to restore model." });
    }
  });

  app.post("/api/avatars/:id/feed", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const success = await feedAvatar(Number(req.params.id), req.user!.phone);
      res.json({ success });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to feed avatar." });
    }
  });

  app.post("/api/avatars/:id/water", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const success = await waterAvatar(Number(req.params.id), req.user!.phone);
      res.json({ success });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to water avatar." });
    }
  });

  app.post("/api/avatars/:id/treat", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const success = await giveTreatToAvatar(Number(req.params.id), req.user!.phone);
      res.json({ success });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to give treat." });
    }
  });

  // --- Living avatar: needs state & commands (Phase 2) ---------------------

  // Returns the stored needs snapshot (client applies offline decay from lastSeen).
  app.get("/api/avatars/:id/state", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const needs = await getAvatarNeeds(Number(req.params.id), req.user!.phone);
      if (!needs) return res.status(404).json({ error: "Avatar not found." });
      res.json({ needs });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to load avatar state." });
    }
  });

  // Persists the current needs snapshot.
  app.patch("/api/avatars/:id/state", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { needs } = req.body || {};
      if (!needs || typeof needs !== "object") {
        return res.status(400).json({ error: "needs object required." });
      }
      const success = await saveAvatarNeeds(Number(req.params.id), req.user!.phone, needs);
      res.json({ success });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to save avatar state." });
    }
  });

  // Logs a user-issued command (telemetry / ambient awareness). Execution is client-side.
  app.post("/api/avatars/:id/command", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { action } = req.body || {};
      if (!action || typeof action !== "string") {
        return res.status(400).json({ error: "action required." });
      }
      console.log(`[command] avatar ${req.params.id} <- ${action} (user ${req.user!.phone})`);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to log command." });
    }
  });

  // --- Placed objects (Phase 3) -------------------------------------------

  app.get("/api/avatars/:id/objects", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const objects = await getPlacedObjects(Number(req.params.id), req.user!.phone);
      res.json({ objects });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to load objects." });
    }
  });

  app.post("/api/avatars/:id/objects", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { id, kind, position, rotationY, scale } = req.body || {};
      if (!id || !kind || !Array.isArray(position) || position.length !== 3) {
        return res.status(400).json({ error: "id, kind and position[3] required." });
      }
      const ok = await addPlacedObject(Number(req.params.id), req.user!.phone, {
        id: String(id),
        kind: String(kind),
        position: [Number(position[0]), Number(position[1]), Number(position[2])],
        rotationY: Number(rotationY) || 0,
        scale: Number(scale) || 1,
      });
      res.json({ success: ok });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to place object." });
    }
  });

  app.delete("/api/avatars/:id/objects/:objectId", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const ok = await deletePlacedObject(req.params.objectId, req.user!.phone);
      res.json({ success: ok });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to remove object." });
    }
  });

  // --- AR Cast / Companions (Phase 5) -------------------------------------------

  app.get("/api/ar/:avatarId/cast", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const actors = await getSceneActors(Number(req.params.avatarId), req.user!.phone);
      res.json({ actors });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to load cast." });
    }
  });

  app.post("/api/ar/:avatarId/cast", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { id, sourceAvatarId, transform, selectedClip } = req.body || {};
      if (!id || !sourceAvatarId || !transform) {
        return res.status(400).json({ error: "id, sourceAvatarId and transform required." });
      }
      const ok = await addSceneActor(Number(req.params.avatarId), req.user!.phone, {
        id: String(id),
        sourceAvatarId: Number(sourceAvatarId),
        transform,
        selectedClip: selectedClip ? String(selectedClip) : undefined,
      });
      res.json({ success: ok });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to add cast member." });
    }
  });

  app.put("/api/ar/:avatarId/cast/:actorId", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { transform, selectedClip } = req.body || {};
      const ok = await updateSceneActor(
        req.params.actorId,
        req.user!.phone,
        transform,
        selectedClip ? String(selectedClip) : undefined
      );
      res.json({ success: ok });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to update cast member." });
    }
  });

  app.delete("/api/ar/:avatarId/cast/:actorId", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const ok = await deleteSceneActor(req.params.actorId, req.user!.phone);
      res.json({ success: ok });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to remove cast member." });
    }
  });

  // Initialize Gemini API.
  // Previously this silently fell back to the literal "placeholder-key", so a
  // missing key surfaced as an opaque 4xx from Google at request time instead of
  // a clear boot failure (GEMINI_CALL_AUDIT.md §4.3). Production now fails fast;
  // dev and test keep the sentinel so the server still boots for offline work
  // and for suites that inject mocks.
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    const message =
      "GEMINI_API_KEY is not set. Every Gemini-backed route (avatars, creations, " +
      "video, classify, Randy) will fail.";
    if (process.env.NODE_ENV === "production") {
      throw new Error(message);
    }
    console.warn(`⚠️ ${message} Continuing with a placeholder key (NODE_ENV=${process.env.NODE_ENV || "undefined"}).`);
  }
  const ai = new GoogleGenAI({
    apiKey: apiKey || "placeholder-key",
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
      retryOptions: { attempts: 1 },
    }
  });

  app.post("/api/bim/propose", requireAuth, bimProposalLimiter, async (req: AuthedRequest, res) => {
    if (!isBimV2Enabled()) return res.status(404).json({ error: "Calibrated building proposals are not enabled." });
    const parsedRequest = BimProposalRequestSchema.safeParse(req.body);
    if (!parsedRequest.success) {
      return res.status(400).json({ error: parsedRequest.error.issues[0]?.message || "Invalid calibrated proposal request." });
    }
    try {
      const request = parsedRequest.data;
      await validateBimProposalImages(request.images, async (bytes) => sharp(bytes, { limitInputPixels: 40_000_000 }).metadata());
      const parts: any[] = request.images.map((image) => ({ inlineData: { data: image.data, mimeType: image.mimeType } }));
      parts.push({ text: buildBimProposalPrompt(request) });
      const response = await ai.models.generateContent({
        model: (process.env.BIM_PROPOSAL_MODEL || "gemini-3.1-flash-lite").trim(),
        contents: { parts },
        config: { temperature: 0.1, responseMimeType: "application/json", systemInstruction: BIM_PROPOSAL_SYSTEM_INSTRUCTION },
      });
      const proposal = parseBimProposal(response.text, request);
      return res.json({ success: true, ...proposal, generatedFrom: request.calibration.sourceKind });
    } catch (error: any) {
      console.error("[BIM] calibrated proposal failed:", error?.message || error);
      return res.status(422).json({ error: error?.message || "The building proposal could not be validated." });
    }
  });

  // --- AR virtual-pet simulator (AR_PET_SIM_SPEC, milestone AR2) -------------
  // The three paid simulator routes (classify / rig / semantic-scan) now live in
  // the shared `createPetSimRouter` factory (server/petSimRouter.ts) so the
  // SAME production route handlers are exercised by the contract test suite
  // with injected fakes. Real providers are wired here.

  // Gemini-backed generate fn injected into the (provider-agnostic) classify core.
  const classifyGenerate: GenerateFn = async ({ prompt, imageBase64, mimeType, temperature }) => {
    const part = { inlineData: { data: imageBase64, mimeType } };
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_TEXT_MODEL || "gemini-3.1-flash-lite",
      contents: { parts: [part, { text: prompt }] },
      config: { temperature, responseMimeType: "application/json" },
    });
    return (response.text || "").trim();
  };
  setRefundReviewGenerate(classifyGenerate);

  // Blender-worker bake-lod adapter (real provider for the rig route).
  const bakeLod = async (
    opts: { glbUrl: string; avatarType?: string },
    headers: Record<string, string>,
  ): Promise<{ glb_base64?: string; stats?: any; error?: string }> => {
    const workerUrl = (process.env.BLENDER_WORKER_URL || "http://localhost:10000").replace(/\/render$/, "");
    const res = await fetch(`${workerUrl}/bake-lod`, {
      method: "POST",
      headers,
      body: JSON.stringify({ glb_url: opts.glbUrl, avatar_type: opts.avatarType }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { error: body.error || `worker returned HTTP ${res.status}` };
    }
    return body;
  };

  // Production dependency wiring for the shared pet-sim router.
  const dbMod = await import("./db");
  const PROD_PETSIM_DEPS = {
    db: {
      getAvatarById: dbMod.getAvatarById,
      getPetProfileByAvatar: dbMod.getPetProfileByAvatar,
      upsertPetProfile: dbMod.upsertPetProfile,
      getPetProfileById: dbMod.getPetProfileById,
      bumpDailyUsage: dbMod.bumpDailyUsage,
      getSemanticScan: dbMod.getSemanticScan,
      saveSemanticScan: dbMod.saveSemanticScan,
      getAvatarByIdForRig: dbMod.getAvatarById,
      savePetRigUrls: dbMod.savePetRigUrls,
      setAvatarGenerationFailed: async (id: number, err: string) =>
        dbMod.getPool().query(
          `UPDATE avatars SET generation_status = 'failed', generation_error = ? WHERE id = ?`,
          [err, id],
        ),
    } as any,
    providers: {
      classify: ({ imageBase64, mimeType }) =>
        classifyPetImage(classifyGenerate, { imageBase64, mimeType }),
      semanticScan: ({ imageBase64, mimeType }) =>
        runSemanticScan(classifyGenerate, { imageBase64, mimeType }),
      startRig: (genTaskId: string, opts: { avatarType?: string }) =>
        startRig(genTaskId, opts as any),
      pollTripoUntilDone: (handle: string, tries?: number, delayMs?: number) =>
        pollTripoUntilDone(handle, tries, delayMs),
      uploadBinaryFromUrl: (url: string, mime: string) => uploadBinaryFromUrl(url, mime),
      uploadBase64Binary: (b64: string, mime: string) => uploadBase64Binary(b64, mime),
      bakeLod,
    },
    paidLimiter,
  };

  // Mount the shared pet-simulator router (classify / rig / semantic-scan).
  app.use(createPetSimApp(PROD_PETSIM_DEPS));

  // NOTE: POST /api/pets/classify is now served by the shared pet-sim router
  // mounted through createPetSimApp(PROD_PETSIM_DEPS) above.

  // GET /api/pets/:id/state — drives/hormones/weights with offline decay applied.
  app.get("/api/pets/:id/state", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const pet = await getPetProfileById(Number(req.params.id), req.user!.phone);
      if (!pet) return res.status(404).json({ error: "Pet not found." });

      const drives = pet.drives || { ...DEFAULT_DRIVES };
      const hormones = pet.hormones || { ...DEFAULT_HORMONES };
      const pt = (pet.temperament || {}) as Record<string, number>;
      const weights =
        pet.personality_weights ||
        weightsFromTemperament({
          energy: Number(pt.energy) || 0.5,
          sociability: Number(pt.sociability) || 0.5,
          stubbornness: Number(pt.stubbornness) || 0.5,
          foodMotivation: Number(pt.foodMotivation) || 0.5,
          vocality: Number(pt.vocality) || 0.5,
        });

      // Offline decay from updated_at, capped at 24h (mirrors needs.ts offline sync).
      const last = new Date(pet.updated_at).getTime();
      const elapsedSec = Number.isFinite(last)
        ? Math.min(Math.max(0, (Date.now() - last) / 1000), 24 * 3600)
        : 0;
      const bp = resolveBreedProfile(pet.breed || undefined, pet.size_class || "medium");
      const decayed = decayDrives(drives, elapsedSec, {
        decay: bp.decay,
        exerciseNeed: bp.exerciseNeed,
        complianceBase: bp.complianceBase,
        scale: bp.scale,
      });

      res.json({
        drives: decayed,
        hormones,
        weights,
        trainer_score: pet.trainer_score,
        life_stage: pet.life_stage,
        aging_mode: pet.aging_mode,
        mortality_enabled: !!pet.mortality_enabled,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to load pet state." });
    }
  });

  // PATCH /api/pets/:id/state — persist client brain state (offline-aware sync).
  app.patch("/api/pets/:id/state", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { drives, hormones, weights, trainer_score } = req.body || {};
      if (drives != null && typeof drives !== "object") {
        return res.status(400).json({ error: "drives must be an object." });
      }
      if (hormones != null && typeof hormones !== "object") {
        return res.status(400).json({ error: "hormones must be an object." });
      }
      const ok = await savePetState(Number(req.params.id), req.user!.phone, {
        drives,
        hormones,
        personality_weights: weights,
        trainer_score: typeof trainer_score === "number" ? trainer_score : undefined,
      });
      if (!ok) return res.status(404).json({ error: "Pet not found." });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to save pet state." });
    }
  });

  // Poll a Tripo task (rig/retarget/gen) until done or the deadline passes.
  //
  // MG-10: pollTripoTask throws TripoError on a rate limit (code 2000 / HTTP
  // 429) or any non-zero response code. This loop had no try/catch, so one
  // transient 429 aborted the entire poll and failed a task that was still
  // running. It also had a 60 x 5s = 5 minute ceiling, far too short for rig
  // and retarget tasks. Retryable errors are now swallowed and retried against
  // a wall-clock deadline, mirroring the V3 pollProviderWithLease pattern.
  const pollTripoUntilDone = async (handle: string, tries = 240, delayMs = 5000) => {
    const deadline = Date.now() + tries * delayMs;
    let consecutiveErrors = 0;
    let lastError = "Tripo task timed out.";

    for (let i = 0; i < tries && Date.now() < deadline; i++) {
      try {
        const r = await pollTripoTask(handle);
        consecutiveErrors = 0;
        if (r.done) return r;
      } catch (err: any) {
        consecutiveErrors += 1;
        lastError = err?.message || String(err);
        const retryable = err instanceof TripoError
          ? (err.retryable || err.status >= 500)
          : true;
        if (!retryable || consecutiveErrors >= 10) {
          return { done: true, error: lastError, failureCode: "PROVIDER_POLL_FAILED" } as Awaited<ReturnType<typeof pollTripoTask>>;
        }
        // Back off harder while the provider is throttling us.
        await new Promise((resolve) => setTimeout(resolve, delayMs * Math.min(consecutiveErrors, 4)));
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return { done: false, error: "Tripo task timed out." } as Awaited<ReturnType<typeof pollTripoTask>>;
  };

  // NOTE: POST /api/pets/:id/rig is now served by the shared pet-sim router
  // mounted through createPetSimApp(PROD_PETSIM_DEPS) above.
  // It stays disabled unless PETSIM_RIG_ENABLED === "true" (P0 containment).

  // POST /api/ar/semantic-scan — AR_PET_SIM_SPEC §6.4
  // NOTE: POST /api/ar/semantic-scan is now served by the shared pet-sim router
  // mounted through createPetSimApp(PROD_PETSIM_DEPS) above.

  // GET /api/pets/:id/commands — learned voice commands, with forgetting decay
  // applied to compliance from last_reinforced (§7.2).
  app.get("/api/pets/:id/commands", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const petId = Number(req.params.id);
      const pet = await getPetProfileById(petId, req.user!.phone);
      if (!pet) return res.status(404).json({ error: "Pet not found." });
      const rows = await getPetCommands(petId, req.user!.phone);
      const now = Date.now();
      const commands = rows.map((c: any) => {
        const last = c.last_reinforced ? new Date(c.last_reinforced).getTime() : now;
        const days = Math.max(0, (now - last) / 86_400_000);
        return { ...c, compliance: decayCompliance(Number(c.compliance), days) };
      });
      res.json({ commands });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to load commands." });
    }
  });

  // POST /api/pets/:id/commands — teach a command. Body { phrase, action,
  // samples?: string[] }. Server computes phonetic keys from the samples (or the
  // phrase) so client + server stay consistent.
  app.post("/api/pets/:id/commands", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const petId = Number(req.params.id);
      const pet = await getPetProfileById(petId, req.user!.phone);
      if (!pet) return res.status(404).json({ error: "Pet not found." });
      const { phrase, action, samples } = req.body || {};
      if (typeof phrase !== "string" || !phrase.trim() || typeof action !== "string") {
        return res.status(400).json({ error: "phrase and action are required." });
      }
      const src: string[] = Array.isArray(samples) && samples.length ? samples : [phrase];
      const keys = Array.from(new Set(src.map((s) => phraseKey(String(s))).filter(Boolean)));
      const id = await addPetCommand(petId, { phrase, metaphone_keys: keys, action });
      res.json({ id, phrase, action, metaphone_keys: keys, compliance: 0.5 });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to save command." });
    }
  });

  // GET /api/pets/:id/buttons — spatial speech buttons.
  app.get("/api/pets/:id/buttons", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const petId = Number(req.params.id);
      const pet = await getPetProfileById(petId, req.user!.phone);
      if (!pet) return res.status(404).json({ error: "Pet not found." });
      res.json({ buttons: await getPetButtons(petId, req.user!.phone) });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to load buttons." });
    }
  });

  // POST /api/pets/:id/buttons — create a button. Body { label, audioBase64|audioUrl,
  // linkedAction?, anchor }. Audio is uploaded to B2.
  app.post("/api/pets/:id/buttons", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const petId = Number(req.params.id);
      const pet = await getPetProfileById(petId, req.user!.phone);
      if (!pet) return res.status(404).json({ error: "Pet not found." });
      const { label, audioBase64, audioUrl, linkedAction, anchor } = req.body || {};
      if (typeof label !== "string" || !label.trim()) {
        return res.status(400).json({ error: "label is required." });
      }
      let storedAudioUrl = "";
      if (typeof audioBase64 === "string" && audioBase64) {
        storedAudioUrl = await uploadBase64Binary(audioBase64, "audio/webm");
      } else if (typeof audioUrl === "string" && audioUrl) {
        storedAudioUrl = await uploadBinaryFromUrl(audioUrl, "audio/webm");
      } else {
        return res.status(400).json({ error: "audioBase64 or audioUrl required." });
      }
      const id = await addPetButton(petId, {
        label,
        audio_url: storedAudioUrl,
        linked_action: typeof linkedAction === "string" ? linkedAction : null,
        anchor: anchor || {},
      });
      res.json({ id, label, audio_url: storedAudioUrl, linked_action: linkedAction ?? null, anchor: anchor || {} });
    } catch (err: any) {
      console.error("[pets/buttons] failed:", err?.message || err);
      res.status(500).json({ error: "Failed to save button." });
    }
  });

  // POST /api/trials/:type/result — AR_PET_SIM_SPEC §7.4
  // Award trainer points + credits for a completed disc/agility trial.
  app.post("/api/trials/:type/result", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const type = req.params.type as TrialType;
      if (type !== "disc" && type !== "agility") {
        return res.status(400).json({ error: "Unknown trial type." });
      }
      const { petId, catches, score } = req.body || {};
      const pet = await getPetProfileById(Number(petId), req.user!.phone);
      if (!pet) return res.status(404).json({ error: "Pet not found." });

      const points = pointsForTrial(type, {
        catches: Number(catches) || 0,
        score: Number(score) || 0,
      });
      const trainerScore = await incrementTrainerScore(Number(petId), req.user!.phone, points);
      // Client-submitted scores are useful for play feedback but are not trusted
      // wallet evidence. Credits stay disabled until a signed server session
      // records the trial events and final score.
      const credits = 0;

      res.json({ type, points, trainerScore, credits });
    } catch (err: any) {
      console.error("[trials/result] failed:", err?.message || err);
      res.status(500).json({ error: "Failed to record trial result." });
    }
  });

  // PATCH /api/pets/:id/settings — aging/mortality settings (§4.6; OFF by default).
  app.patch("/api/pets/:id/settings", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const petId = Number(req.params.id);
      const pet = await getPetProfileById(petId, req.user!.phone);
      if (!pet) return res.status(404).json({ error: "Pet not found." });
      const { aging_mode, mortality_enabled, life_stage } = req.body || {};
      if (aging_mode != null && !["off", "slow", "realistic"].includes(aging_mode)) {
        return res.status(400).json({ error: "aging_mode must be off|slow|realistic." });
      }
      if (life_stage != null && !["puppy", "adult", "senior"].includes(life_stage)) {
        return res.status(400).json({ error: "life_stage must be puppy|adult|senior." });
      }
      const ok = await updatePetSettings(petId, req.user!.phone, {
        aging_mode,
        mortality_enabled: typeof mortality_enabled === "boolean" ? mortality_enabled : undefined,
        life_stage,
      });
      res.json({ success: ok });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to update settings." });
    }
  });

  // API route to create custom styled pet images using Imagen or Gemini
  app.get("/api/inspiration", async (req, res) => {
    try {
      // 1. Fetch live random dog photo
      let dogImageUrl = "";
      let breedName = "Charming Pet";
      let imageFetchSuccess = false;
      let dogError = "";

      try {
        const dogRes = await fetch("https://dog.ceo/api/breeds/image/random", { signal: AbortSignal.timeout(5000) });
        if (dogRes.ok) {
          const dogData = (await dogRes.json()) as { message: string; status: string };
          if (dogData && dogData.status === "success") {
            dogImageUrl = dogData.message;
            imageFetchSuccess = true;
            // Parse breed name out of url e.g. /breeds/husky/...
            const breedMatch = dogImageUrl.match(/\/breeds\/([^/]+)\//);
            if (breedMatch && breedMatch[1]) {
              breedName = breedMatch[1]
                .split("-")
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .reverse()
                .join(" ");
            }
          } else {
            dogError = "Invalid structure returned from Dog CEO API.";
          }
        } else {
          dogError = `Dog CEO API returned status ${dogRes.status}`;
        }
      } catch (err: any) {
        dogError = err.message || "Network timeout / connection failure";
      }

      // If Dog API failed, let's fallback to free Cat API search
      if (!imageFetchSuccess) {
        try {
          const catRes = await fetch("https://api.thecatapi.com/v1/images/search", { signal: AbortSignal.timeout(4000) });
          if (catRes.ok) {
            const catData = (await catRes.json()) as Array<{ url: string }>;
            if (catData && catData[0]?.url) {
              dogImageUrl = catData[0].url;
              breedName = "Dreamy Cat Companion";
              imageFetchSuccess = true;
            }
          }
        } catch (catErr: any) {
          console.warn("Cat fallback API also failed:", catErr);
        }
      }

      // 2. Fetch live fun dog fact
      let petFact = "Every single pet photo tells a story of unconditional love and companionship.";
      let factFetchSuccess = false;
      let factError = "";

      try {
        const factRes = await fetch("https://dogapi.dog/api/v2/facts", { signal: AbortSignal.timeout(4000) });
        if (factRes.ok) {
          const factData = (await factRes.json()) as { data: Array<{ attributes: { body: string } }> };
          if (factData && factData.data && factData.data[0]?.attributes?.body) {
            petFact = factData.data[0].attributes.body;
            factFetchSuccess = true;
          } else {
            factError = "Invalid body structure from dogapi.dog";
          }
        } else {
          factError = `dogapi.dog API returned status ${factRes.status}`;
        }
      } catch (err: any) {
        factError = err.message || "Fact server timeout";
      }

      // Final JSON response with complete status information
      res.json({
        success: true,
        imageUrl: dogImageUrl || "https://images.unsplash.com/photo-1543466835-00a7907e9de1?auto=format&fit=crop&q=80&w=600",
        breed: breedName,
        fact: petFact,
        metadata: {
          dogApiStatus: imageFetchSuccess ? "online" : "error",
          dogApiDetail: dogError || null,
          factApiStatus: factFetchSuccess ? "online" : "error",
          factApiDetail: factError || null,
          timestamp: new Date().toISOString()
        }
      });
    } catch (globalErr: any) {
      console.error("Inspiration API error:", globalErr);
      res.status(500).json({
        success: false,
        error: "Failed to query core external public APIs."
      });
    }
  });

  // API route to create custom styled pet images using Imagen or Gemini
  // Credit store — live Stripe only. Missing Stripe fails closed with 503.
  app.post(
    "/api/create-credits-session",
    requireAuth,
    createCreditsSessionHandler({
      stripe,
      appUrl: process.env.APP_URL || "http://localhost:3000",
    }),
  );

  // Street View Coverage Check Endpoint (Phase 1.2)
  app.get("/api/streetview/coverage", requireAuth, async (req, res) => {
    try {
      const { lat, lng } = req.query;
      if (!lat || !lng) {
        return res.status(400).json({ success: false, error: "lat and lng are required" });
      }
      if (!process.env.GOOGLE_MAPS_API_KEY_SERVER) {
        return res.status(500).json({ success: false, error: "Google Maps Server API key not configured" });
      }
      
      const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${process.env.GOOGLE_MAPS_API_KEY_SERVER}`;
      const response = await fetch(url);
      const data = await response.json();
      
      res.json({ success: true, data });
    } catch (err: any) {
      console.error("Street view coverage check error:", err);
      res.status(500).json({ success: false, error: "Failed to check street view coverage" });
    }
  });

  app.get("/api/landmarks", requireAuth, async (req, res) => {
    try {
      const city = String(req.query.city || "");
      if (!city) return res.json({ landmarks: [] });
      if (!process.env.GOOGLE_MAPS_API_KEY_SERVER) return res.json({ landmarks: [] });
      
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=top+famous+landmarks+in+${encodeURIComponent(city)}&key=${process.env.GOOGLE_MAPS_API_KEY_SERVER}`;
      const response = await fetch(url);
      const data = await response.json();
      
      const landmarks = (data.results || []).slice(0, 5).map((r: any) => ({
        name: r.name,
        lat: r.geometry?.location?.lat,
        lng: r.geometry?.location?.lng,
        photoReference: r.photos?.[0]?.photo_reference
      }));
      res.json({ landmarks });
    } catch (err: any) {
      res.json({ landmarks: [] });
    }
  });

  app.post("/api/create-creation", requireAuth, async (req, res) => {
    let creditReservationId: string | null = null;
    try {
      if (!apiKey || apiKey === "placeholder-key" || apiKey === "MY_GEMINI_API_KEY") {
        throw new Error("Missing or invalid GEMINI_API_KEY. Please configure your Gemini API key in the AI Studio Secrets panel.");
      }

      const authedReq = req as AuthedRequest;
      const userPhone = authedReq.user!.phone;
      const GENERATION_COST = CREDIT_PRICES.HD_IMAGE;

      // Fix 2: Server-side credit check + atomic deduction before calling AI
      // Admin bypass: skip credit checks for developer phone number
      const isAdmin = await isUserAdmin(userPhone);
      if (!isAdmin) {
        const currentBalance = await getCreditBalance(userPhone);
        if (currentBalance < GENERATION_COST) {
          return res.status(402).json({
            success: false,
            error: `Insufficient PupCoins. You need ${GENERATION_COST} PupCoins but only have ${currentBalance}. Purchase more PupCoins to continue.`
          });
        }
        creditReservationId = await reserveCredits(userPhone, GENERATION_COST, "hd_image_generation");
        if (!creditReservationId) {
          return res.status(402).json({ success: false, error: `Insufficient PupCoins. You need ${GENERATION_COST} PupCoins.` });
        }
      }

      const { style, background, photo, breed, name, brightness, contrast, location } = req.body;
      
      let promptText = "";
      if (brightness > 70) promptText += ` Use very bright, high-key lighting.`;
      else if (brightness < 30) promptText += ` Use moody, low-key dramatic lighting.`;
      if (contrast > 70) promptText += ` High contrast, punchy colors.`;
      else if (contrast < 30) promptText += ` Soft, low-contrast, pastel tones.`;

      if (name) {
        promptText += `The pet is a lovely animal named ${name}. `;
      }
      if (breed) {
        promptText += `The breed is a beautiful ${breed}. `;
      } else {
        promptText += `The pet is a charming dog or cat. `;
      }

      // Match the style guidelines from the design spec
      if (style === "Clay") {
        promptText += `styled in high-quality claymation / clay-render / clay model illustration with visible tactile clay textures. Whimsical and charming. `;
      } else if (style === "Sketch") {
        promptText += `delicate charcoal and pencil sketch style with expressive artistic hand-drawn strokes and fine paper texture visible, high-end fine art. `;
      } else if (style === "Artistic" || style === "Watercolor") {
        promptText += `magical, dreamy watercolor painting style with beautiful color bleed, soft sage green, morning glow, and warm terracotta pastel tones. `;
      } else if (style === "Anime") {
        promptText += `styled in beautiful vibrant Japanese anime art style, resembling Studio Ghibli, with lush colorful backgrounds and highly expressive bright eyes. `;
      } else if (style === "3D") {
        promptText += `styled as a cute Pixar-like 3D computer graphics render, high fidelity, soft rim lighting, highly detailed and expressive. `;
      } else if (style === "Retro") {
        promptText += `styled in 1980s retro synthwave aesthetic, neon colors, lo-fi VHS tape grain, nostalgic vintage look. `;
      } else { // Realistic
        promptText += `hyper-realistic professional pet portrait, captured in a sun-drenched atmosphere with golden hour light and soft focus scenic bokeh. `;
      }

      if (background === "Canyon") {
        promptText += `The pet is sitting in front of the majestic Grand Canyon National Park with its vast layered reddish-orange cliffs, dramatic canyon valley, and a flowing green river far below under a glowing warm morning sun. `;
      } else if (background === "Paris") {
        promptText += `The pet is sitting in a Paris park with the beautiful Eiffel Tower visible in the background, surrounded by blossoming pink cherry blossoms with delicate petals falling. `;
      } else if (background === "Cabin") {
        promptText += `The pet is in front of a cozy warm-lit rustic wooden log cabin in a snowy evergreen pine forest, with a brilliant magical aurora borealis green and colorful northern lights glowing in the night sky. `;
      } else if (background === "Rocky") {
        promptText += `The pet is standing next to the famous Rocky Balboa boxing statue in Philadelphia, in front of the grand steps of the steps of the Philadelphia Museum of Art, triumphant and heroic. `;
      } else {
        promptText += `The setting is a lush sun-drenched green flower garden during golden hour with sparkling wildflowers and beautiful bokeh effects. `;
      }

      promptText += ` The image must convey an empathetic, nostalgic, warm, and highly nurturing aesthetic, like a cherished digital heirloom memory. Fully centered, perfectly composed, high detail.`;

      // Phase 1.3: Custom Street View Backdrop Handling
      let backdropPart = null;
      if (location?.lat && location?.lng && process.env.GOOGLE_MAPS_API_KEY_SERVER) {
        try {
          const svUrl = `https://maps.googleapis.com/maps/api/streetview?size=1024x1024&location=${location.lat},${location.lng}&heading=${location.heading || 0}&pitch=${location.pitch || 0}&fov=${location.fov || 90}&key=${process.env.GOOGLE_MAPS_API_KEY_SERVER}`;
          const svRes = await fetch(svUrl);
          if (svRes.ok) {
            const buffer = await svRes.arrayBuffer();
            const bgBase64 = Buffer.from(buffer).toString("base64");
            backdropPart = {
              inlineData: {
                data: bgBase64,
                mimeType: "image/jpeg",
              },
            };
            promptText += ` Composite the pet naturally into this real location backdrop (${location.placeLabel || 'the specified location'}), matching its lighting and perspective, rendered in the ${style} style.`;
          }
        } catch (err) {
          console.warn("Street View fetch failed, falling back to text-only background:", err);
        }
      }

      // If photo is provided (base64)
      if (photo && photo.startsWith("data:image")) {
        const matches = photo.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
        if (!matches || matches.length < 3) {
          throw new Error("Invalid base64 image format");
        }
        const mimeType = matches[1];
        const base64Data = matches[2];

        // Restyle via the IMAGE_MODELS chain (same fallback machinery as avatar
        // generation). generateImageWithFallback handles all error logging and
        // model-iteration internally; null means every model failed → fall through.
        const restyParts = [
          { inlineData: { data: base64Data, mimeType: mimeType } },
          ...(backdropPart ? [backdropPart] : []),
          {
            text: `Please restyle and merge this pet's appearance into a new image matching this prompt description: ${promptText}. Ensure the pet's core features (dog/cat/fur patterns) are recognizable but beautifully rendered in the requested artistic style and background. Respond with only the generated image.`,
          },
        ];
        const generatedBase64 = await generateImageWithFallback(
          restyParts,
          "create-creation-restyle",
          userPhone,
        );

        if (generatedBase64) {
          // Phase 2: Upload to object storage
          let finalImageUrl = generatedBase64;
          try {
            finalImageUrl = await uploadBase64Image(generatedBase64);
          } catch (uploadErr) {
            console.error("Failed to upload to object storage, falling back to base64:", uploadErr);
          }

          // Phase 1.3: Save to database for persistent album
          const creationId = await saveCreation({
            user_phone: userPhone,
            media_type: 'still',
            style,
            backdrop_kind: location ? 'streetview' : 'preset',
            preset_name: location ? null : background,
            sv_lat: location?.lat || null,
            sv_lng: location?.lng || null,
            sv_heading: location?.heading || null,
            sv_pitch: location?.pitch || null,
            sv_fov: location?.fov || null,
            place_label: location?.placeLabel || null,
            image_url: finalImageUrl,
          });

          return res.json({ success: true, imageUrl: finalImageUrl, creationId, mode: "transform" });
        }
      }

      // Fresh generation using imagen model
      try {
        await reserveImageGenerationCall(userPhone);
        const response = await ai.models.generateImages({
          model: 'imagen-4.0-generate-001',
          prompt: promptText,
          config: {
            numberOfImages: 1,
            outputMimeType: 'image/jpeg',
            aspectRatio: '1:1',
          },
        });
        const base64Bytes = response.generatedImages?.[0]?.image?.imageBytes;
        if (!base64Bytes) throw new Error("No image generated by Imagen");
        
        const generatedBase64 = `data:image/jpeg;base64,${base64Bytes}`;
        // Phase 2: Upload to object storage
        let finalImageUrl = generatedBase64;
        try {
          finalImageUrl = await uploadBase64Image(generatedBase64);
        } catch (uploadErr) {
          console.error("Failed to upload to object storage, falling back to base64:", uploadErr);
        }
        
        // Phase 1.3: Save to database for persistent album
        const creationId = await saveCreation({
          user_phone: userPhone,
          media_type: 'still',
          style,
          backdrop_kind: location ? 'streetview' : 'preset',
          preset_name: location ? null : background,
          sv_lat: location?.lat || null,
          sv_lng: location?.lng || null,
          sv_heading: location?.heading || null,
          sv_pitch: location?.pitch || null,
          sv_fov: location?.fov || null,
          place_label: location?.placeLabel || null,
          image_url: finalImageUrl,
        });
        
        return res.json({ success: true, imageUrl: finalImageUrl, creationId, mode: "generate" });
      } catch (e: any) {
        rethrowImageGenerationBudgetError(e);
        // Imagen failed — fall back to the same IMAGE_MODELS generateContent chain
        // used for avatar generation. TEXT_MODELS is not appropriate here because
        // this path needs image output, not text (GEMINI_CALL_AUDIT.md §4.2).
        console.error("Imagen model error, trying IMAGE_MODELS generateContent fallback:", e);

        const generatedBase64 = await generateImageWithFallback(
          [{ text: `Generate a beautiful artistic image matching this prompt: ${promptText}` }],
          "create-creation-imagen-fallback",
          userPhone,
        );

        if (generatedBase64) {
          let finalImageUrl = generatedBase64;
          try {
            finalImageUrl = await uploadBase64Image(generatedBase64);
          } catch (uploadErr) {
            console.error("Failed to upload to object storage, falling back to base64:", uploadErr);
          }

          // Phase 1.3: Save to database for persistent album (fallback path)
          const creationId = await saveCreation({
            user_phone: userPhone,
            media_type: 'still',
            style,
            backdrop_kind: location ? 'streetview' : 'preset',
            preset_name: location ? null : background,
            sv_lat: location?.lat || null,
            sv_lng: location?.lng || null,
            sv_heading: location?.heading || null,
            sv_pitch: location?.pitch || null,
            sv_fov: location?.fov || null,
            place_label: location?.placeLabel || null,
            image_url: finalImageUrl,
          });

          return res.json({ success: true, imageUrl: finalImageUrl, creationId, mode: "fallback" });
        }

        throw new Error("All image generation methods failed.");
      }
    } catch (err: any) {
      if (creditReservationId) {
        try { await refundReservedCredits(creditReservationId); } catch {}
      }
      console.error("create-creation error:", err);
      const status = err instanceof ImageGenerationBudgetError
        ? (err.code === "IMAGE_GENERATION_USER_CAP" ? 429 : 503)
        : 500;
      res.status(status).json({
        success: false,
        error: err.message || "Failed to generate memory.",
        code: err?.code,
      });
    }
  });

  // The visible album product is Coming Soon. Keep its retired checkout closed.
  app.post("/api/create-checkout-session", requireAuth, retiredAlbumCheckoutHandler);

  // --- Albums Endpoints ---
  app.get("/api/albums", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const albums = await getAlbums(req.user!.phone);
      // Map to frontend expected shape
      const formattedAlbums = albums.map((a: any) => ({
        id: a.id.toString(),
        name: a.name,
        imageUrl: a.cover_url || "https://images.unsplash.com/photo-1548199973-03cce0bbc87b?q=80&w=600&auto=format&fit=crop",
        itemCount: a.itemCount || 0
      }));
      res.json({ success: true, albums: formattedAlbums });
    } catch (err: any) {
      console.error("Error fetching albums:", err);
      res.status(500).json({ success: false, error: "Failed to fetch albums." });
    }
  });

  app.post("/api/albums", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ success: false, error: "Album name required" });
      const album = await createAlbum(req.user!.phone, name);
      res.json({ 
        success: true, 
        album: {
          id: album.id.toString(),
          name: album.name,
          imageUrl: "https://images.unsplash.com/photo-1548199973-03cce0bbc87b?q=80&w=600&auto=format&fit=crop",
          itemCount: 0
        }
      });
    } catch (err: any) {
      console.error("Error creating album:", err);
      res.status(500).json({ success: false, error: "Failed to create album." });
    }
  });

  // Phase 1.3: Persistent Album Endpoints
  app.get("/api/creations", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const creations = await getCreations(req.user!.phone);
      res.json({ success: true, creations });
    } catch (err: any) {
      console.error("Error fetching creations:", err);
      res.status(500).json({ success: false, error: "Failed to fetch creations." });
    }
  });

  // Unified model library: new create-pipeline models plus every legacy avatar
  // model already persisted in Backblaze. Source IDs remain explicit so print
  // preparation and future edits cannot target the wrong table.
  app.get("/api/models/library", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const phone = req.user!.phone;
      const [creationRows] = await getPool().query(
        `SELECT c.id, 'creation' AS source_type, c.pet_name AS name, c.pet_breed AS breed,
                c.image_url, c.model_url, NULL AS rigged_model_url, c.created_at,
                CASE WHEN c.model_url IS NULL THEN 'building' ELSE 'done' END AS status,
                COALESCE(gj.canonical_asset_uuid, '') AS canonical_asset_uuid,
                CASE
                  WHEN gj.generation_refunded_at IS NOT NULL THEN 'refunded'
                  WHEN gj.rig_refunded_at IS NOT NULL THEN 'refunded'
                  WHEN gj.credits_reserved > 0 AND c.model_url IS NOT NULL THEN 'charged'
                  WHEN c.model_url IS NULL THEN 'not_charged'
                  ELSE 'not_charged'
                END AS billing_disposition,
                gj.recovery_reason AS failure_code
         FROM creations c
         LEFT JOIN generation_jobs gj ON gj.creation_id = c.id
         WHERE c.user_phone = ? AND c.media_type = 'model'`,
        [phone]
      ) as any;
      const [avatarRows] = await getPool().query(
        `SELECT a.id, 'avatar' AS source_type, a.name, a.breed, a.image_url, a.model_url,
                a.rigged_model_url, a.created_at, a.generation_status AS status,
                '' AS canonical_asset_uuid,
                CASE
                  WHEN a.generation_status = 'done' THEN 'charged'
                  WHEN a.generation_status = 'done_static_fallback' THEN 'charged'
                  WHEN a.generation_status = 'failed' THEN 'refunded'
                  ELSE 'not_charged'
                END AS billing_disposition,
                a.generation_error AS failure_code
         FROM avatars a
         WHERE a.user_phone = ? AND (a.model_url IS NOT NULL OR a.rigged_model_url IS NOT NULL)`,
        [phone]
      ) as any;
      const [petGlbRows] = await getPool().query(
        `SELECT p.id, 'pet_glb_order' AS source_type,
                CONCAT('Custom ', COALESCE(p.subject_profile, 'pet'), ' model') AS name,
                NULL AS breed, NULL AS image_url, NULL AS rigged_model_url,
                NULL AS model_url, p.created_at, p.state AS status,
                a.asset_uuid AS canonical_asset_uuid,
                a.id AS asset_id, av.id AS version_id, a.owner_id, a.asset_type, a.visibility, a.status AS asset_status,
                av.version_number, av.sha256, av.mime_type, av.size_bytes, av.bucket, av.object_key,
                av.metadata, av.source_provider, av.license, av.commercial_use_eligible
         FROM pet_glb_orders p
         INNER JOIN assets a ON a.id = p.asset_id
         INNER JOIN asset_versions av ON av.id = p.approved_version_id
         LEFT JOIN fur_bin_items fbi ON fbi.owner_id = p.owner_phone AND fbi.asset_id = a.id
         WHERE p.owner_phone = ? AND p.approved_version_id IS NOT NULL
           AND p.state IN ('approved', 'delivered')
           AND (fbi.id IS NULL OR fbi.status != 'deleted')`,
        [phone],
      ) as any;
      const petModels = await Promise.all((petGlbRows || []).map(async (row: any) => {
        try {
          return {
            ...row,
            model_url: await generateSignedUrlForVersion({
              id: Number(row.asset_id), asset_uuid: row.canonical_asset_uuid, owner_id: row.owner_id,
              asset_type: row.asset_type, visibility: row.visibility, status: row.asset_status,
              current_version_id: Number(row.version_id), created_at: new Date(), updated_at: new Date(),
            }, {
              id: Number(row.version_id), asset_id: Number(row.asset_id), version_number: Number(row.version_number),
              sha256: row.sha256, mime_type: row.mime_type, size_bytes: Number(row.size_bytes), bucket: row.bucket,
              object_key: row.object_key, metadata: row.metadata, source_provider: row.source_provider,
              license: row.license, commercial_use_eligible: Boolean(row.commercial_use_eligible), created_at: new Date(),
            }, phone),
          };
        } catch {
          return null;
        }
      }));
      const seen = new Set<string>();
      const models = [...creationRows, ...avatarRows, ...petModels.filter(Boolean)]
        .filter((item: any) => {
          const url = item.rigged_model_url || item.model_url;
          if (!url || seen.has(url)) return false;
          seen.add(url);
          return true;
        })
        .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      res.json({ success: true, models });
    } catch (err: any) {
      console.error("Model library error:", err);
      res.status(500).json({ success: false, error: "Failed to load your model library." });
    }
  });

  const PrintPrepareSchema = z.object({
    sourceType: z.enum(["creation", "avatar", "pet_glb_order"]),
    sourceId: z.number().int().positive(),
    targetHeightMm: z.number().min(25).max(300),
    recipient: z.object({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().email().max(200),
      line1: z.string().trim().min(3).max(200),
      line2: z.string().trim().max(200).optional(),
      city: z.string().trim().min(2).max(80),
      state: z.string().trim().min(1).max(40),
      zip: z.string().trim().min(2).max(20),
      country: z.string().trim().length(2).transform((value) => value.toUpperCase()),
    }),
  });

  app.post("/api/print/slant3d/checkout", requireAuth, paidLimiter, async (req: AuthedRequest, res) => {
    let preparedOrderId: number | null = null;
    try {
      const input = PrintPrepareSchema.parse(req.body);
      const phone = req.user!.phone;
      if (!slant3dConfigured()) return res.status(503).json({ success: false, error: "Slant 3D printing is not configured." });
      if (!stripe) return res.status(503).json({ success: false, error: "Stripe checkout is not configured for physical orders." });
      const idempotencyKey = String(req.header("Idempotency-Key") || "").trim().slice(0, 128);
      if (!idempotencyKey) return res.status(400).json({ success: false, error: "An idempotency key is required." });
      const [existingRows] = await getPool().query(
        `SELECT id, provider_pack_id, stl_url, target_height_mm, dimensions_json, topology_json,
                checkout_url, retail_price_cents, status
         FROM print_orders WHERE user_phone = ? AND idempotency_key = ? LIMIT 1`,
        [phone, idempotencyKey],
      ) as any;
      if (existingRows?.[0]) {
        const existing = existingRows[0];
        if (existing.checkout_url) return res.json({ success: true, idempotent: true, order: existing, checkoutUrl: existing.checkout_url });
        if (!existing.retail_price_cents) return res.status(409).json({ success: false, error: "This print quote could not be resumed. Start a new quote." });
        const appUrl = process.env.APP_URL || "http://localhost:3000";
        const resumed = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [{ price_data: { currency: "usd", product_data: { name: `Pawsome3D custom ${Math.round(Number(existing.target_height_mm))} mm figurine`, description: "Prepared, quality checked, printed, and shipped by Slant 3D." }, unit_amount: Number(existing.retail_price_cents) }, quantity: 1 }],
          customer_email: input.recipient.email,
          mode: "payment",
          metadata: { type: "slant3d_print_order", printOrderId: String(existing.id), userPhone: phone, slantOrderId: String(existing.provider_pack_id) },
          success_url: `${appUrl}/fur-bin?print_success=true&order_id=${existing.id}`,
          cancel_url: `${appUrl}/fur-bin?print_cancelled=true&order_id=${existing.id}`,
        });
        await getPool().query(`UPDATE print_orders SET checkout_url = ?, stripe_session_id = ?, status = 'awaiting_payment' WHERE id = ?`, [resumed.url, resumed.id, existing.id]);
        return res.json({ success: true, idempotent: true, order: existing, checkoutUrl: resumed.url });
      }
      let modelUrl: string | null = null;
      if (input.sourceType === "pet_glb_order") {
        const [rows] = await getPool().query(
          `SELECT p.id, p.approved_version_id, a.id AS asset_id, a.asset_uuid, a.owner_id,
                  a.asset_type, a.visibility, a.status AS asset_status, av.version_number,
                  av.sha256, av.mime_type, av.size_bytes, av.bucket, av.object_key, av.metadata,
                  av.source_provider, av.license, av.commercial_use_eligible
           FROM pet_glb_orders p
           INNER JOIN assets a ON a.id = p.asset_id
           INNER JOIN asset_versions av ON av.id = p.approved_version_id
           WHERE p.id = ? AND p.owner_phone = ? AND p.state IN ('approved', 'delivered') LIMIT 1`,
          [input.sourceId, phone],
        ) as any;
        const source = rows?.[0];
        if (source) {
          modelUrl = await generateSignedUrlForVersion({
            id: Number(source.asset_id), asset_uuid: source.asset_uuid, owner_id: source.owner_id,
            asset_type: source.asset_type, visibility: source.visibility, status: source.asset_status,
            current_version_id: Number(source.approved_version_id), created_at: new Date(), updated_at: new Date(),
          }, {
            id: Number(source.approved_version_id), asset_id: Number(source.asset_id), version_number: Number(source.version_number),
            sha256: source.sha256, mime_type: source.mime_type, size_bytes: Number(source.size_bytes), bucket: source.bucket,
            object_key: source.object_key, metadata: source.metadata, source_provider: source.source_provider,
            license: source.license, commercial_use_eligible: Boolean(source.commercial_use_eligible), created_at: new Date(),
          }, phone);
        }
      } else {
        const table = input.sourceType === "creation" ? "creations" : "avatars";
        const [rows] = await getPool().query(
          `SELECT id, model_url${input.sourceType === "avatar" ? ", rigged_model_url" : ""}
           FROM ${table} WHERE id = ? AND user_phone = ? LIMIT 1`,
          [input.sourceId, phone]
        ) as any;
        const source = rows?.[0];
        modelUrl = source?.rigged_model_url || source?.model_url || null;
      }
      if (!modelUrl) return res.status(404).json({ success: false, error: "That model is not ready or does not belong to you." });

      const workerUrl = String(process.env.BLENDER_WORKER_URL || "").replace(/\/render$/, "").replace(/\/$/, "");
      if (!workerUrl) return res.status(503).json({ success: false, error: "Print preparation is not configured." });
      const preparedResponse = await fetch(`${workerUrl}/prepare-print`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-worker-secret": process.env.WORKER_SHARED_SECRET || "",
        },
        body: JSON.stringify({ glb_url: modelUrl, target_height_mm: input.targetHeightMm }),
        signal: AbortSignal.timeout(600_000),
      });
      const prepared: any = await preparedResponse.json().catch(() => ({}));
      if (!preparedResponse.ok || !prepared?.success) {
        return res.status(422).json({ success: false, error: prepared?.error || "The model could not be prepared for printing." });
      }
      if (!prepared.printable) {
        return res.status(422).json({
          success: false,
          error: "This mesh needs repair before manufacturing.",
          dimensionsMm: prepared.dimensions_mm,
          topology: prepared.topology,
        });
      }

      const stlUrl = await uploadBase64Binary(prepared.stl_base64, "model/stl", "print-ready");
      const ownerId = createHash("sha256").update(`pawsome3d:${phone}`).digest("hex").slice(0, 32);
      const slantFile = await uploadSlantFileFromUrl({
        stlUrl,
        name: `pawsome3d-${input.sourceType}-${input.sourceId}-${Math.round(input.targetHeightMm)}mm`,
        ownerId,
      });
      const draft = await draftSlantOrder({
        publicFileServiceId: slantFile.publicFileServiceId,
        address: {
          name: input.recipient.name,
          email: input.recipient.email,
          line1: input.recipient.line1,
          line2: input.recipient.line2,
          city: input.recipient.city,
          state: input.recipient.state,
          zip: input.recipient.zip,
          country: String(input.recipient.country || "US"),
        },
        ownerId,
        itemName: `Pawsome3D custom ${Math.round(input.targetHeightMm)} mm figurine`,
      });
      const providerCostCents = Math.max(1, Math.ceil(draft.totals.totalCost * 100));
      const markupPercent = Math.max(0, Number(process.env.FULFILLMENT_MARKUP_PERCENT || 80));
      const minimumMarginCents = Math.max(0, Number(process.env.FULFILLMENT_MIN_MARGIN_CENTS || 500));
      const retailPriceCents = Math.max(
        providerCostCents + minimumMarginCents,
        Math.ceil(providerCostCents * (1 + markupPercent / 100)),
      );
      const [inserted] = await getPool().query(
        `INSERT INTO print_orders
          (user_phone, source_type, source_id, provider, provider_pack_id, provider_file_id,
           stl_url, target_height_mm, dimensions_json, topology_json, idempotency_key,
           provider_cost_cents, retail_price_cents, provider_payload_json, status)
         VALUES (?, ?, ?, 'slant3d', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment')`,
        [phone, input.sourceType, input.sourceId, draft.publicId, slantFile.publicFileServiceId,
          stlUrl, input.targetHeightMm, JSON.stringify(prepared.dimensions_mm), JSON.stringify(prepared.topology),
          idempotencyKey, providerCostCents, retailPriceCents, JSON.stringify(draft.raw)],
      ) as any;
      const printOrderId = Number(inserted.insertId);
      preparedOrderId = printOrderId;
      const appUrl = process.env.APP_URL || "http://localhost:3000";
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: {
              name: `Pawsome3D custom ${Math.round(input.targetHeightMm)} mm figurine`,
              description: "Prepared, quality checked, printed, and shipped by Slant 3D.",
            },
            unit_amount: retailPriceCents,
          },
          quantity: 1,
        }],
        customer_email: input.recipient.email,
        mode: "payment",
        metadata: {
          type: "slant3d_print_order",
          printOrderId: String(printOrderId),
          userPhone: phone,
          slantOrderId: draft.publicId,
        },
        success_url: `${appUrl}/fur-bin?print_success=true&order_id=${printOrderId}`,
        cancel_url: `${appUrl}/fur-bin?print_cancelled=true&order_id=${printOrderId}`,
      });
      await getPool().query(
        `UPDATE print_orders SET checkout_url = ?, stripe_session_id = ? WHERE id = ?`,
        [session.url, session.id, printOrderId],
      );
      res.json({
        success: true,
        checkoutUrl: session.url,
        orderId: printOrderId,
        providerOrderId: draft.publicId,
        stlUrl,
        dimensionsMm: prepared.dimensions_mm,
        topology: prepared.topology,
        providerCostCents,
        retailPriceCents,
      });
    } catch (err: any) {
      if (preparedOrderId) {
        try { await getPool().query(`UPDATE print_orders SET status = 'payment_setup_failed' WHERE id = ?`, [preparedOrderId]); } catch {}
      }
      if (err instanceof z.ZodError) return res.status(400).json({ success: false, error: err.issues[0]?.message || "Invalid print request." });
      const message = err?.message || "Could not start the print checkout.";
      console.error("Slant 3D print checkout error:", message);
      res.status(/not configured/i.test(message) ? 503 : 502).json({ success: false, error: message });
    }
  });

  app.post("/api/marketplace/listings/:uuid/print/checkout", requireAuth, paidLimiter, async (req: AuthedRequest, res) => {
    let preparedOrderId: number | null = null;
    try {
      const input = PrintPrepareSchema.parse(req.body);
      const phone = req.user!.phone;
      const listingUuid = req.params.uuid;
      
      if (!slant3dConfigured()) return res.status(503).json({ success: false, error: "Slant 3D printing is not configured." });
      if (!stripe) return res.status(503).json({ success: false, error: "Stripe checkout is not configured for physical orders." });
      const idempotencyKey = String(req.header("Idempotency-Key") || "").trim().slice(0, 128);
      if (!idempotencyKey) return res.status(400).json({ success: false, error: "An idempotency key is required." });
      
      const [existingRows] = await getPool().query(
        `SELECT id, provider_pack_id, stl_url, target_height_mm, dimensions_json, topology_json,
                checkout_url, retail_price_cents, status
         FROM print_orders WHERE user_phone = ? AND idempotency_key = ? LIMIT 1`,
        [phone, idempotencyKey],
      ) as any;
      if (existingRows?.[0]) {
        const existing = existingRows[0];
        if (existing.checkout_url) return res.json({ success: true, idempotent: true, order: existing, checkoutUrl: existing.checkout_url });
        if (!existing.retail_price_cents) return res.status(409).json({ success: false, error: "This print quote could not be resumed. Start a new quote." });
        const appUrl = process.env.APP_URL || "http://localhost:3000";
        const resumed = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [{ price_data: { currency: "usd", product_data: { name: `Pawsome3D custom ${Math.round(Number(existing.target_height_mm))} mm figurine`, description: "Prepared, quality checked, printed, and shipped by Slant 3D." }, unit_amount: Number(existing.retail_price_cents) }, quantity: 1 }],
          customer_email: input.recipient.email,
          mode: "payment",
          metadata: { type: "slant3d_print_order", printOrderId: String(existing.id), userPhone: phone, slantOrderId: String(existing.provider_pack_id) },
          success_url: `${appUrl}/fur-bin?print_success=true&order_id=${existing.id}`,
          cancel_url: `${appUrl}/fur-bin?print_cancelled=true&order_id=${existing.id}`,
        });
        await getPool().query(`UPDATE print_orders SET checkout_url = ?, stripe_session_id = ?, status = 'awaiting_payment' WHERE id = ?`, [resumed.url, resumed.id, existing.id]);
        return res.json({ success: true, idempotent: true, order: existing, checkoutUrl: resumed.url });
      }

      // 1. Resolve listing and check bounds
      const [lRows] = await getPool().query(
        `SELECT id, name, status, print_size_min_mm, print_size_max_mm 
         FROM marketplace_listings WHERE uuid = ? AND status = 'published' LIMIT 1`,
        [listingUuid]
      ) as any;
      const listing = lRows?.[0];
      if (!listing) return res.status(404).json({ success: false, error: "Listing not found or not published." });
      
      const targetMm = normalizeDerivativeHeightMm(input.targetHeightMm);
      const minMm = listing.print_size_min_mm ? Number(listing.print_size_min_mm) : 25;
      const maxMm = listing.print_size_max_mm ? Number(listing.print_size_max_mm) : 300;
      if (targetMm < minMm || targetMm > maxMm) {
        return res.status(422).json({ success: false, error: `Requested height must be between ${minMm} and ${maxMm} mm.` });
      }

      // 2. Resolve private source GLB
      const [aRows] = await getPool().query(
        `SELECT id, object_key FROM marketplace_assets WHERE listing_id = ? AND kind = 'source_glb' AND status = 'active' LIMIT 1`,
        [listing.id]
      ) as any;
      if (!aRows || aRows.length === 0) return res.status(404).json({ success: false, error: "Listing has no active 3D model." });
      
      // 3. See if we have a cached STL derivative for this exact target height
      const [stlRows] = await getPool().query(
        `SELECT object_key, size_bytes FROM marketplace_assets WHERE listing_id = ? AND kind = 'stl_derivative' AND status = 'active' AND derivative_height_mm = ? LIMIT 1`,
        [listing.id, targetMm]
      ) as any;

      let stlUrl = "";
      let stlObjectKey = "";
      let dimensionsMm = { x: 0, y: 0, z: targetMm };
      let topology = { faces: 0, vertices: 0, manifold: true };

      if (stlRows && stlRows.length > 0) {
        stlObjectKey = String(stlRows[0].object_key);
        const signedStl = await getPrivateSignedUrl(stlObjectKey);
        stlUrl = signedStl.url;
        // Ideally we store dimensions and topology on the asset, but let's just make it up or assume they aren't strictly required for pricing. Wait, dimensions/topology are saved in `print_orders` and returned to UI.
        // I will just leave them as placeholders if cached, since pricing uses Slant3D's API output.
      } else {
        const workerUrl = String(process.env.BLENDER_WORKER_URL || "").replace(/\/render$/, "").replace(/\/$/, "");
        if (!workerUrl) return res.status(503).json({ success: false, error: "Print preparation is not configured." });
        
        const signedGlb = await getPrivateSignedUrl(String(aRows[0].object_key));
        
        const preparedResponse = await fetch(`${workerUrl}/prepare-print`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-worker-secret": process.env.WORKER_SHARED_SECRET || "",
          },
          body: JSON.stringify({ glb_url: signedGlb.url, target_height_mm: targetMm }),
          signal: AbortSignal.timeout(600_000),
        });
        const prepared: any = await preparedResponse.json().catch(() => ({}));
        if (!preparedResponse.ok || !prepared?.success) {
          return res.status(422).json({ success: false, error: prepared?.error || "The model could not be prepared for printing." });
        }
        if (!prepared.printable) {
          return res.status(422).json({
            success: false,
            error: "This mesh needs repair before manufacturing.",
            dimensionsMm: prepared.dimensions_mm,
            topology: prepared.topology,
          });
        }
        
        dimensionsMm = prepared.dimensions_mm;
        topology = prepared.topology;
        
        // Save to private bucket as stl_derivative
        const stlBuffer = Buffer.from(prepared.stl_base64, "base64");
        stlObjectKey = mintObjectKey(listingUuid, "model/stl");
        const storedStl = await putPrivateObject(stlObjectKey, stlBuffer, "model/stl");

        const persisted = await persistStlDerivativeOrResolveWinner({
          db: getPool(),
          deleteObject: deletePrivateObject,
          listingId: listing.id,
          assetUuid: randomUUID(),
          stored: storedStl,
          targetHeightMm: targetMm,
        });
        stlObjectKey = persisted.objectKey;
        
        const signedStl = await getPrivateSignedUrl(stlObjectKey);
        stlUrl = signedStl.url;
      }

      // 4. Draft Slant 3D order
      const ownerId = createHash("sha256").update(`pawsome3d:${phone}`).digest("hex").slice(0, 32);
      const slantFile = await uploadSlantFileFromUrl({
        stlUrl,
        name: `pawsome3d-marketplace-${listing.id}-${Math.round(targetMm)}mm`,
        ownerId,
      });
      const draft = await draftSlantOrder({
        publicFileServiceId: slantFile.publicFileServiceId,
        address: {
          name: input.recipient.name,
          email: input.recipient.email,
          line1: input.recipient.line1,
          line2: input.recipient.line2,
          city: input.recipient.city,
          state: input.recipient.state,
          zip: input.recipient.zip,
          country: String(input.recipient.country || "US"),
        },
        ownerId,
        itemName: `Pawsome3D custom ${Math.round(targetMm)} mm figurine`,
      });
      
      const providerCostCents = Math.max(1, Math.ceil(draft.totals.totalCost * 100));
      const markupPercent = Math.max(0, Number(process.env.FULFILLMENT_MARKUP_PERCENT || 80));
      const minimumMarginCents = Math.max(0, Number(process.env.FULFILLMENT_MIN_MARGIN_CENTS || 500));
      const retailPriceCents = Math.max(
        providerCostCents + minimumMarginCents,
        Math.ceil(providerCostCents * (1 + markupPercent / 100)),
      );
      
      const [inserted] = await getPool().query(
        `INSERT INTO print_orders
          (user_phone, source_type, source_id, provider, provider_pack_id, provider_file_id,
           stl_url, target_height_mm, dimensions_json, topology_json, idempotency_key,
           provider_cost_cents, retail_price_cents, provider_payload_json, status)
         VALUES (?, 'marketplace_listing', ?, 'slant3d', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment')`,
        [phone, listing.id, draft.publicId, slantFile.publicFileServiceId,
          stlObjectKey, targetMm, JSON.stringify(dimensionsMm), JSON.stringify(topology),
          idempotencyKey, providerCostCents, retailPriceCents, JSON.stringify(draft.raw)],
      ) as any;
      const printOrderId = Number(inserted.insertId);
      preparedOrderId = printOrderId;
      const appUrl = process.env.APP_URL || "http://localhost:3000";
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: {
              name: `Pawsome3D custom ${Math.round(targetMm)} mm figurine`,
              description: "Prepared, quality checked, printed, and shipped by Slant 3D.",
            },
            unit_amount: retailPriceCents,
          },
          quantity: 1,
        }],
        customer_email: input.recipient.email,
        mode: "payment",
        metadata: {
          type: "slant3d_print_order",
          printOrderId: String(printOrderId),
          userPhone: phone,
          slantOrderId: draft.publicId,
        },
        success_url: `${appUrl}/fur-bin?print_success=true&order_id=${printOrderId}`,
        cancel_url: `${appUrl}/fur-bin?print_cancelled=true&order_id=${printOrderId}`,
      });
      await getPool().query(
        `UPDATE print_orders SET checkout_url = ?, stripe_session_id = ? WHERE id = ?`,
        [session.url, session.id, printOrderId],
      );
      res.json({
        success: true,
        checkoutUrl: session.url,
        orderId: printOrderId,
        providerOrderId: draft.publicId,
        stlUrl: stlObjectKey,
        dimensionsMm,
        topology,
        providerCostCents,
        retailPriceCents,
      });
    } catch (err: any) {
      if (preparedOrderId) {
        try { await getPool().query(`UPDATE print_orders SET status = 'payment_setup_failed' WHERE id = ?`, [preparedOrderId]); } catch {}
      }
      if (err instanceof z.ZodError) return res.status(400).json({ success: false, error: err.issues[0]?.message || "Invalid print request." });
      const message = err?.message || "Could not start the print checkout.";
      console.error("Marketplace Slant 3D print checkout error:", message);
      res.status(/not configured/i.test(message) ? 503 : 502).json({ success: false, error: message });
    }
  });

  app.get("/api/print/orders", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT id, source_type, source_id, provider, provider_pack_id, provider_file_id, stl_url, target_height_mm,
                dimensions_json, topology_json, checkout_url, provider_cost_cents, retail_price_cents,
                provider_payload_json, status, created_at, updated_at
         FROM print_orders WHERE user_phone = ? ORDER BY created_at DESC LIMIT 100`,
        [req.user!.phone],
      ) as any;
      const orders = rows.map((row: any) => {
        const { provider_payload_json, ...safe } = row;
        return { ...safe, tracking: extractShipmentTracking(provider_payload_json) };
      });
      res.json({ success: true, orders });
    } catch (error: any) {
      console.error("Print order list error:", error?.message || error);
      res.status(500).json({ success: false, error: "Could not load print orders." });
    }
  });

  app.get("/api/print/orders/:id/status", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const orderId = Number(req.params.id);
      if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ success: false, error: "Invalid print order." });
      const [rows] = await getPool().query(
        `SELECT id, provider_pack_id, checkout_url, status FROM print_orders WHERE id = ? AND user_phone = ? LIMIT 1`,
        [orderId, req.user!.phone],
      ) as any;
      const order = rows?.[0];
      if (!order) return res.status(404).json({ success: false, error: "Print order not found." });
      if (!order.provider_pack_id) return res.json({ success: true, order });
      const providerOrder = await getSlantOrder(String(order.provider_pack_id));
      const status = String(providerOrder?.data?.status || providerOrder?.data?.order?.status || order.status).toLowerCase();
      const providerPayload = providerOrder?.data || providerOrder || {};
      await getPool().query(`UPDATE print_orders SET status = ?, provider_payload_json = ? WHERE id = ?`, [status, JSON.stringify(providerPayload), orderId]);
      res.json({ success: true, order: { ...order, status, tracking: extractShipmentTracking(providerPayload) } });
    } catch (error: any) {
      const message = error?.message || "Could not refresh the print order.";
      console.error("Print order status error:", message);
      res.status(/not configured/i.test(message) ? 503 : 502).json({ success: false, error: message });
    }
  });

  app.get("/api/admin/creations", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const isAdmin = await isUserAdmin(req.user!.phone);
      if (!isAdmin) {
         return res.status(403).json({ success: false, error: "Unauthorized. Admin only." });
      }
      const creations = await getAllCreations();
      res.json({ success: true, creations });
    } catch (err: any) {
      console.error("Error fetching admin creations:", err);
      res.status(500).json({ success: false, error: "Failed to fetch creations." });
    }
  });

  app.put("/api/creations/:id", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { sort_order, style, backdrop_kind, preset_name, sv_lat, sv_lng, sv_heading, sv_pitch, sv_fov, place_label, album_id } = req.body;
      
      const updates: any = {};
      if (sort_order !== undefined) updates.sort_order = sort_order;
      if (style !== undefined) updates.style = style;
      if (backdrop_kind !== undefined) updates.backdrop_kind = backdrop_kind;
      if (preset_name !== undefined) updates.preset_name = preset_name;
      if (sv_lat !== undefined) updates.sv_lat = sv_lat;
      if (sv_lng !== undefined) updates.sv_lng = sv_lng;
      if (sv_heading !== undefined) updates.sv_heading = sv_heading;
      if (sv_pitch !== undefined) updates.sv_pitch = sv_pitch;
      if (sv_fov !== undefined) updates.sv_fov = sv_fov;
      if (place_label !== undefined) updates.place_label = place_label;
      
      if (album_id !== undefined && album_id !== null) {
        const [albumRows] = await getPool().query(
          "SELECT id FROM albums WHERE id = ? AND user_phone = ? LIMIT 1",
          [album_id, req.user!.phone]
        ) as any;
        if (!albumRows.length) {
          return res.status(403).json({ success: false, error: "Album not found or not yours." });
        }
        updates.album_id = album_id;
      } else if (album_id === null) {
        updates.album_id = null;
      }

      const success = await updateCreation(id, req.user!.phone, updates);
      if (!success) {
        return res.status(404).json({ success: false, error: "Creation not found or unauthorized." });
      }
      res.json({ success: true });
    } catch (err: any) {
      console.error("Error updating creation:", err);
      res.status(500).json({ success: false, error: "Failed to update creation." });
    }
  });

  async function userOwnsCreationMediaUrl(phone: string, url: string): Promise<boolean> {
    const [rows] = await getPool().query(
      `SELECT id FROM creations
        WHERE user_phone = ?
          AND (image_url = ? OR video_url = ? OR model_url = ? OR rigged_model_url = ?)
        LIMIT 1`,
      [phone, url, url, url, url],
    ) as any;
    return Array.isArray(rows) && rows.length === 1;
  }

  function configuredMediaOrigins(): string[] {
    const endpoint = process.env.MEDIA_BUCKET_URL;
    const bucket = process.env.MEDIA_BUCKET_NAME;
    if (!endpoint || !bucket) return [];
    const url = new URL(endpoint);
    return [url.origin, `${url.protocol}//${bucket}.${url.host}`];
  }

  // Owner-scoped bounded download, not a general-purpose URL proxy.
  app.get("/api/download", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const url = String(req.query.url || "");
      if (!url) return res.status(400).send("Missing url parameter");
      if (!await userOwnsCreationMediaUrl(req.user!.phone, url)) return res.status(403).send("URL not owned");
      const fetched = await fetchBoundedRemoteBuffer(url, {
        allowedOrigins: configuredMediaOrigins(),
        maxBytes: 100 * 1024 * 1024,
        timeoutMs: 20_000,
        allowedContentTypes: ["image/*", "video/*", "model/*", "application/octet-stream"],
      });
      res.setHeader("Content-Type", fetched.contentType);
      res.setHeader("Content-Disposition", "attachment");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(fetched.buffer);
    } catch (err: any) {
      console.error("Download proxy error:", err);
      res.status(500).send("Download failed");
    }
  });

  // Phase 3 & 4: Veo Video Generation Endpoints
  const VIDEO_COST = CREDIT_PRICES.ANIMATED_VIDEO;
  const MAX_DAILY_VIDEOS = 5;

  app.post("/api/create-video", requireAuth, async (req: AuthedRequest, res) => {
    let creditReservationId: string | null = null;
    try {
      const { creationId } = req.body || {};
      const aspectRatio = normalizeVideoAspectRatio(req.body?.aspectRatio);
      if (!creationId) return res.status(400).json({ success: false, error: "creationId is required" });
      const scriptResult = AiVideoScriptSchema.safeParse(req.body?.script);
      if (!scriptResult.success) {
        return res.status(400).json({
          success: false,
          error: "Choose a complete 8-second script with setting, characters, motion, stage directions, lighting, filter, and camera direction.",
        });
      }
      const script = scriptResult.data;
      const compiledPrompt = compileEightSecondPrompt(script);
      const providerModel = process.env.AI_VIDEO_MODEL || "veo-3.1-fast-generate-preview";

      const userPhone = req.user!.phone;
      const isAdmin = await isUserAdmin(userPhone);
      
      // Phase 4: Rate limit check (Admin bypass)
      if (!isAdmin) {
        const dailyCount = await getDailyVideoCount(userPhone);
        if (dailyCount >= MAX_DAILY_VIDEOS) {
          return res.status(429).json({ success: false, error: `Daily video limit reached (${MAX_DAILY_VIDEOS}/day). Please try again tomorrow.` });
        }
        
        // 1. Check balance
        const balance = await getCreditBalance(userPhone);
        if (balance < VIDEO_COST) {
          return res.status(402).json({ success: false, error: `Insufficient PupCoins. You need ${VIDEO_COST} PupCoins.` });
        }
      }

      // 2. Fetch creation to get the image
      const creations = await getCreations(userPhone);
      const creation = creations.find((c: any) => c.id === creationId);
      if (!creation || !creation.image_url) {
        return res.status(404).json({ success: false, error: "Creation not found or has no image." });
      }

      // 3. Deduct credits upfront (Admin bypass: skip deduction)
      if (!isAdmin) {
        creditReservationId = await reserveCredits(userPhone, VIDEO_COST, "animated_video");
        if (!creditReservationId) return res.status(402).json({ success: false, error: `Insufficient PupCoins. You need ${VIDEO_COST} PupCoins.` });
      }

      // 4. Prepare image bytes (fetch from URL if needed, or parse base64)
      let imageBytes = "";
      let mimeType = "image/jpeg";
      if (creation.image_url.startsWith("data:image")) {
        const matches = creation.image_url.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
        if (matches) {
          mimeType = matches[1];
          imageBytes = matches[2];
        }
      } else {
        // Fetch from object storage URL
        const imgRes = await fetch(creation.image_url);
        if (!imgRes.ok) {
          throw new Error(`Could not fetch the source image (${imgRes.status}). Please try another image.`);
        }
        const fetchedMimeType = imgRes.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
        if (!fetchedMimeType?.startsWith("image/")) {
          throw new Error("The selected creation is not a usable image. Please choose a PNG, JPEG, or WebP image.");
        }
        mimeType = fetchedMimeType;
        const buffer = await imgRes.arrayBuffer();
        imageBytes = Buffer.from(buffer).toString("base64");
      }

      // 5. Start Veo operation
      const op = await ai.models.generateVideos({
        model: providerModel,
        prompt: compiledPrompt,
        image: { imageBytes, mimeType },
        // Veo 3 generates native sound. Its public API does not accept the old
        // generateAudio flag, so sound and the optional short voice line are
        // directed through the structured prompt.
        //
        // VG-1: the config previously carried only aspectRatio/duration/count
        // and omitted every motion-quality lever the API exposes. Veo has no
        // dedicated camera-motion parameter — motion comes from the prompt and
        // is constrained by the negative prompt — so an empty negativePrompt
        // left nothing steering the model away from frozen, stiff output. This
        // is the single highest-impact fix for "stiff and rigid" videos.
        config: {
          aspectRatio,
          durationSeconds: 8,
          numberOfVideos: 1,
          enhancePrompt: true,
          negativePrompt: VEO_MOTION_NEGATIVE_PROMPT,
          // Fur Reels animates a customer's pet, never a person.
          personGeneration: "dont_allow",
        },
      });

      const operationName = (op as any).name || (op as any).operation?.name;
      if (!operationName) throw new Error("Failed to get operation name from Veo");

      // 6. Create job in DB
      const jobId = await createJob({
        user_phone: userPhone,
        creation_id: creationId,
        kind: "video",
        credits_reserved: creditReservationId ? VIDEO_COST : 0,
        credit_debit_correlation_id: creditReservationId,
        operation_name: operationName,
      });
      creditReservationId = null; // durable job now owns any refund decision

      await getPool().query(
        `INSERT INTO ai_video_requests
          (job_id, template_id, script_json, compiled_prompt, duration_seconds,
           aspect_ratio, generate_audio, voice_text, voice_id, provider, provider_model)
         VALUES (?, ?, ?, ?, 8, ?, TRUE, ?, NULL, 'veo', ?)`,
        [
          jobId,
          script.templateId || null,
          JSON.stringify(script),
          compiledPrompt,
          aspectRatio,
          script.voiceText || null,
          providerModel,
        ],
      );

      res.status(202).json({ success: true, jobId, status: "queued" });
    } catch (err: any) {
      if (creditReservationId) {
        try { await refundReservedCredits(creditReservationId); } catch {}
      }
      console.error("Error creating video:", err);
      res.status(500).json({ success: false, error: err.message || "Failed to start video generation." });
    }
  });

  // HeyGen "talking pet" video generation. Mirrors /api/create-video but uses
  // HeyGen's photo-avatar (talking photo) pipeline instead of Veo. Reuses the
  // same generation_jobs table + credit/rate-limit logic; the HeyGen video_id
  // is stored in operation_name with a "heygen:" prefix so the shared pollers
  // can route it correctly.
  app.post("/api/create-talking-video", requireAuth, async (req: AuthedRequest, res) => {
    let creditReservationId: string | null = null;
    try {
      const { creationId, script, voiceId } = req.body;
      if (!creationId) return res.status(400).json({ success: false, error: "creationId is required" });
      if (!script || !String(script).trim()) {
        return res.status(400).json({ success: false, error: "script is required (what the pet should say)." });
      }

      const userPhone = req.user!.phone;
      const isAdmin = await isUserAdmin(userPhone);

      // Rate limit + balance check (Admin bypass) — same rules as Veo video.
      if (!isAdmin) {
        const dailyCount = await getDailyVideoCount(userPhone);
        if (dailyCount >= MAX_DAILY_VIDEOS) {
          return res.status(429).json({ success: false, error: `Daily video limit reached (${MAX_DAILY_VIDEOS}/day). Please try again tomorrow.` });
        }
        const balance = await getCreditBalance(userPhone);
        if (balance < CREDIT_PRICES.LIP_SYNC_30_SECONDS) {
          return res.status(402).json({ success: false, error: `Insufficient PupCoins. You need ${CREDIT_PRICES.LIP_SYNC_30_SECONDS} PupCoins.` });
        }
      }

      // Fetch creation to get the image.
      const creations = await getCreations(userPhone);
      const creation = creations.find((c: any) => c.id === creationId);
      if (!creation || !creation.image_url) {
        return res.status(404).json({ success: false, error: "Creation not found or has no image." });
      }

      // Deduct credits upfront (Admin bypass: skip deduction).
      if (!isAdmin) {
        creditReservationId = await reserveCredits(userPhone, CREDIT_PRICES.LIP_SYNC_30_SECONDS, "lip_sync");
        if (!creditReservationId) return res.status(402).json({ success: false, error: `Insufficient PupCoins. You need ${CREDIT_PRICES.LIP_SYNC_30_SECONDS} PupCoins.` });
      }

      // Prepare image bytes (parse base64 data URL, or fetch from storage URL).
      let imageBuffer: Buffer;
      let mimeType = "image/jpeg";
      if (creation.image_url.startsWith("data:image")) {
        const matches = creation.image_url.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
        if (!matches) {
          if (creditReservationId) {
            await refundReservedCredits(creditReservationId);
            creditReservationId = null;
          }
          return res.status(400).json({ success: false, error: "Invalid creation image data." });
        }
        mimeType = matches[1];
        imageBuffer = Buffer.from(matches[2], "base64");
      } else {
        const imgRes = await fetch(creation.image_url);
        imageBuffer = Buffer.from(await imgRes.arrayBuffer());
        const ct = imgRes.headers.get("content-type");
        if (ct && ct.startsWith("image/")) mimeType = ct;
      }

      // Start HeyGen generation. On failure, refund the reserved credits.
      let handle: string;
      try {
        handle = await startTalkingVideo({
          imageBuffer,
          mimeType,
          script: String(script),
          voiceId: voiceId || undefined,
        });
      } catch (genErr: any) {
        if (creditReservationId) {
          await refundReservedCredits(creditReservationId);
          creditReservationId = null;
        }
        console.error("HeyGen start error:", genErr);
        return res.status(502).json({ success: false, error: genErr.message || "Failed to start talking video." });
      }

      // Create job in DB (kind 'video', handle stored with heygen: prefix).
      const jobId = await createJob({
        user_phone: userPhone,
        creation_id: creationId,
        kind: "video",
        credits_reserved: creditReservationId ? CREDIT_PRICES.LIP_SYNC_30_SECONDS : 0,
        credit_debit_correlation_id: creditReservationId,
        operation_name: handle,
      });
      creditReservationId = null; // durable job now owns any refund decision

      res.status(202).json({ success: true, jobId, status: "queued" });
    } catch (err: any) {
      if (creditReservationId) {
        try { await refundReservedCredits(creditReservationId); } catch {}
      }
      console.error("Error creating talking video:", err);
      res.status(500).json({ success: false, error: err.message || "Failed to start talking video generation." });
    }
  });


  // ---------------------------------------------------------------------------
  // Create Pipeline (Phase 2)
  // ---------------------------------------------------------------------------

  app.post("/api/create-pipeline/generate-reference", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { sessionId, species, breed, petName, intent, style, inputPhotoUrl } = req.body;
      const userPhone = req.user!.phone;

      // Text-to-model. generatePetReferenceImage has always accepted a free-text
      // `extra` describing the subject, and the original create dialog used it;
      // the newer create flow simply stopped sending one, which stranded a
      // working paid path. Bounded to 500 chars to match the client field.
      const referenceMode: "image" | "text" = req.body.inputMode === "text" ? "text" : "image";
      const textPrompt = String(req.body.textPrompt || "").trim().slice(0, 500);
      if (referenceMode === "text" && !textPrompt) {
        return res.status(400).json({ success: false, error: "A description is required to generate from text." });
      }
      
      let id = sessionId;
      if (!id) {
        const { randomUUID } = await import("crypto");
        id = randomUUID();
      }
      
      const { getCreatePipelineSession, upsertCreatePipelineSession } = await import("./db");
      
      let session = await getCreatePipelineSession(id, userPhone);
      if (session && session.status !== "draft" && session.status !== "reference_ready") {
        return res.status(400).json({ success: false, error: "Session is no longer editable." });
      }

      // We need to generate a candidate image. Re-using generatePetReferenceImage
      // (This will act as the "real" image generator for Phase 2).
      let candidateUrl = null;
      try {
        if (referenceMode === "text") {
          // Text mode needs a different generator, not the same one with an
          // empty photo array. generatePetReferenceImage bails at its first
          // guard when there are no image parts:
          //     if (imageParts.length === 0) return null;   (server.ts ~3618)
          // so passing [] would fail 100% of the time regardless of how good
          // the description is. This mirrors /api/text-to-reference, which is
          // the already-working text→image path.
          const fields: TextPromptFields = { subject: textPrompt, style: style || "Realistic" };
          candidateUrl = await generateImageWithFallback(
            [{ text: buildTextPrompt(fields) }],
            "create-pipeline-text-reference",
            userPhone,
          );
        } else {
          const photos = inputPhotoUrl ? [inputPhotoUrl] : [];
          candidateUrl = await generatePetReferenceImage(
            photos,
            intent || null,
            species as ExtendedSubjectClass,
            !!inputPhotoUrl,
            "",
            userPhone,
            {},
            style || "Realistic",
            breed || null
          );
        }
      } catch (genErr: any) {
        console.error("Reference generation error:", genErr);
        const status = genErr instanceof ImageGenerationBudgetError
          ? (genErr.code === "IMAGE_GENERATION_USER_CAP" ? 429 : 503)
          : 500;
        return res.status(status).json({
          success: false,
          error: genErr instanceof ImageGenerationBudgetError
            ? genErr.message
            : "Failed to generate candidate image. No PupCoins were deducted.",
          code: genErr?.code,
        });
      }

      if (!candidateUrl) {
         return res.status(500).json({ success: false, error: "Failed to generate candidate image. No PupCoins were deducted." });
      }

      // Convert Data URI to public URL if needed, similar to create-3d-model
      if (candidateUrl.startsWith("data:image")) {
        try {
          candidateUrl = await uploadBase64Image(candidateUrl);
        } catch (upErr: any) {
          return res.status(502).json({ success: false, error: "Could not persist candidate image." });
        }
      }

      const newSession = {
        id,
        user_phone: userPhone,
        species,
        breed: breed || null,
        pet_name: petName || null,
        intent: intent || null,
        style: style || null,
        input_photo_url: inputPhotoUrl || null,
        candidate_image_url: candidateUrl,
        customization_state: session?.customization_state || null,
        validation_state: session?.validation_state || null,
        status: "reference_ready" as const,
        idempotency_key: session?.idempotency_key || null,
        build_job_id: session?.build_job_id || null,
      };

      await upsertCreatePipelineSession(newSession);

      res.json({ success: true, sessionId: id, candidateUrl });
    } catch (err: any) {
      console.error("Error in generate-reference:", err);
      res.status(500).json({ success: false, error: "Failed to process reference generation." });
    }
  });

  app.post("/api/create-pipeline/remake-reference", requireAuth, async (req: AuthedRequest, res) => {
    // Exact same logic, handled by frontend calling generate-reference with sessionId
    res.status(400).json({ success: false, error: "Use generate-reference with an existing sessionId." });
  });

  app.post("/api/create-pipeline/update", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { sessionId, customizationState, validationState } = req.body;
      const userPhone = req.user!.phone;
      if (!sessionId) {
        return res.status(400).json({ success: false, error: "Missing sessionId" });
      }

      const { getCreatePipelineSession, upsertCreatePipelineSession } = await import("./db");
      const session = await getCreatePipelineSession(sessionId, userPhone);
      if (!session) {
        return res.status(404).json({ success: false, error: "Session not found." });
      }

      // Merge states safely
      if (customizationState) {
        session.customization_state = { ...(session.customization_state || {}), ...customizationState };
      }
      if (validationState) {
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(JSON.stringify(session.customization_state || {})).digest('hex');
        const vState = { ...validationState, _customizationHash: hash };
        session.validation_state = JSON.stringify(vState); // We store it as a string
      }

      await upsertCreatePipelineSession(session);
      return res.json({ success: true, session });
    } catch (err: any) {
      console.error("Pipeline update error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  const ValidationSchema = z.object({
    isPrintable: z.boolean(),
    errors: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
  });

  app.post("/api/create-pipeline/approve", requireAuth, rejectLegacyExternal3dRoute, async (req: AuthedRequest, res) => {
    try {
      const { sessionId, idempotencyKey } = req.body;
      const userPhone = req.user!.phone;
      if (!sessionId || !idempotencyKey) {
        return res.status(400).json({ success: false, error: "Missing sessionId or idempotencyKey" });
      }

      const { 
        reservePipelineSessionForBuild, 
        commitPipelineSessionBuild, 
        markPipelineSessionRecoveryRequired, 
        releasePipelineSessionReservation,
        getCreatePipelineSession
      } = await import("./db");
      
      const session = await getCreatePipelineSession(sessionId, userPhone);
      if (!session) {
        return res.status(404).json({ success: false, error: "Session not found." });
      }

      if (!session.customization_state) {
        return res.status(400).json({ success: false, error: "Missing customization state." });
      }
      if (!session.candidate_image_url) {
        return res.status(400).json({ success: false, error: "Missing candidate image." });
      }
      if (session.status !== 'reference_ready' && session.status !== 'build_starting') {
        return res.status(400).json({ success: false, error: "Session is not ready for approval." });
      }

      // Validate the validation state
      let validation;
      try {
        if (!session.validation_state) throw new Error("No validation state");
        const rawValidation = JSON.parse(session.validation_state);
        
        const crypto = require('crypto');
        const expectedHash = crypto.createHash('md5').update(JSON.stringify(session.customization_state)).digest('hex');
        if (rawValidation._customizationHash !== expectedHash) {
          throw new Error("Stale validation state");
        }

        validation = ValidationSchema.parse(rawValidation);
      } catch (e: any) {
        return res.status(400).json({ success: false, error: "Validation state is missing, invalid, or stale. Please re-validate." });
      }
      
      if (!validation.isPrintable) {
        return res.status(400).json({ success: false, error: "Model is not printable. Please fix validation errors." });
      }

      // Authoritative price: base model + optional rigging add-ons chosen on
      // the customize screen (P3/P4). The client shows the same computation;
      // the server total is the one that gets reserved.
      const MODEL_COST = createModelCost(session.customization_state?.rigging as RiggingSelection | undefined);
      const pipelineOwnerIsAdmin = await isUserAdmin(userPhone);

      // 1. Reserve
      const reserveResult = await reservePipelineSessionForBuild(sessionId, userPhone, idempotencyKey, MODEL_COST);
      
      if (!reserveResult.success) {
        if (reserveResult.alreadyReservedOrBuilding) {
           return res.json({ success: true, message: "Already approved", status: reserveResult.sessionRow?.status, jobId: reserveResult.sessionRow?.build_job_id });
        }
        return res.status(reserveResult.error === "Insufficient PupCoins." ? 402 : 409).json({ success: false, error: reserveResult.error });
      }

      // 2. External Provider Start (Tripo / Meshy)
      let handle: string;
      try {
        handle = await startImageTo3D({ imageUrl: session.candidate_image_url! });
      } catch (genErr: any) {
        console.error("External provider start failed:", genErr);
        await releasePipelineSessionReservation(sessionId, userPhone, MODEL_COST);
        return res.status(503).json({ success: false, error: "3D generation is temporarily unavailable. PupCoins have been refunded." });
      }

      // 3. Commit the job to database
      const creationData = {
        style: session.style || 'Realistic',
        image_url: session.candidate_image_url,
        pet_name: session.pet_name,
        pet_breed: session.breed
      };

      const commitResult = await commitPipelineSessionBuild(sessionId, userPhone, {
        // generation_jobs.kind is constrained to still/video/model; the
        // provider task handle is stored separately as operation_name.
        kind: 'model',
        credits_reserved: pipelineOwnerIsAdmin ? 0 : MODEL_COST,
        operation_name: handle
      }, creationData);

      if (!commitResult.success) {
        // We failed to finalize the DB transaction, but the external provider has already been called!
        // We MUST NOT refund the user automatically or they get a free model.
        // We MUST escalate to recovery_required and save the provider handle.
        await markPipelineSessionRecoveryRequired(sessionId, userPhone, handle);
        return res.status(500).json({ success: false, error: "Failed to finalize job state. Support has been notified." });
      }

      return res.json({ success: true, message: "Build started", status: "building" });
    } catch (err: any) {
      console.error("Pipeline approve error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Meshy "3D pet figurine" generation. Mirrors /api/create-video but uses
  // Meshy's image-to-3D pipeline. Reuses the same generation_jobs table +
  // credit/rate-limit logic; the Meshy task id is stored in operation_name with
  // a "meshy:" prefix so the shared pollers route it correctly. Output is a GLB
  // model stored on the creation's model_url (media_type 'model').
  const MODEL_COST = CREDIT_PRICES.STATIC_3D_PHOTO;
  app.post("/api/create-3d-model", requireAuth, rejectLegacyExternal3dRoute, async (req: AuthedRequest, res) => {
    let creditReservationId: string | null = null;
    try {
      const { creationId } = req.body;
      if (!creationId) return res.status(400).json({ success: false, error: "creationId is required" });

      const userPhone = req.user!.phone;
      const isAdmin = await isUserAdmin(userPhone);

      // Balance check (Admin bypass). Reuses the daily video cap as a global
      // generation cap so we don't add a separate counter.
      if (!isAdmin) {
        const dailyCount = await getDailyVideoCount(userPhone);
        if (dailyCount >= MAX_DAILY_VIDEOS) {
          return res.status(429).json({ success: false, error: `Daily generation limit reached (${MAX_DAILY_VIDEOS}/day). Please try again tomorrow.` });
        }
        const balance = await getCreditBalance(userPhone);
        if (balance < MODEL_COST) {
          return res.status(402).json({ success: false, error: `Insufficient PupCoins. You need ${MODEL_COST} PupCoins.` });
        }
      }

      // Fetch creation to get the image.
      const creations = await getCreations(userPhone);
      const creation = creations.find((c: any) => c.id === creationId);
      if (!creation || !creation.image_url) {
        return res.status(404).json({ success: false, error: "Creation not found or has no image." });
      }

      // Meshy needs a PUBLIC image URL. If the creation image is still a base64
      // data URL, push it to object storage first so Meshy can fetch it.
      let publicImageUrl = creation.image_url as string;
      if (publicImageUrl.startsWith("data:image")) {
        try {
          publicImageUrl = await uploadBase64Image(publicImageUrl);
        } catch (upErr: any) {
          return res.status(502).json({ success: false, error: "Could not prepare image for 3D conversion." });
        }
      }

      if (!isAdmin) {
        creditReservationId = await reserveCredits(userPhone, MODEL_COST, "static_3d_photo");
        if (!creditReservationId) return res.status(402).json({ success: false, error: `Insufficient PupCoins. You need ${MODEL_COST} PupCoins.` });
      }

      // Start Tripo/Meshy generation first.
      let handle: string;
      try {
        handle = await startImageTo3D({ imageUrl: publicImageUrl });
      } catch (genErr: any) {
        if (creditReservationId) {
          await refundReservedCredits(creditReservationId);
          creditReservationId = null;
        }
        console.error("Tripo/Meshy start error:", genErr);
        if (isTripoInsufficientCredit(genErr)) {
          return res.status(503).json({
            success: false,
            error: "3D generation is temporarily unavailable. Please try again later.",
            code: "GENERATION_SERVICE_UNAVAILABLE"
          });
        }
        return res.status(502).json({ success: false, error: "Failed to start 3D model generation. Please try again later." });
      }

      // Create job in DB (kind 'model', handle stored with meshy: prefix).
      const jobId = await createJob({
        user_phone: userPhone,
        creation_id: creationId,
        kind: "model",
        credits_reserved: creditReservationId ? MODEL_COST : 0,
        credit_debit_correlation_id: creditReservationId,
        operation_name: handle,
      });
      creditReservationId = null; // durable job now owns any refund decision

      res.status(202).json({ success: true, jobId, status: "queued" });
    } catch (err: any) {
      if (creditReservationId) {
        try { await refundReservedCredits(creditReservationId); } catch {}
      }
      console.error("Error creating 3D model:", err);
      res.status(500).json({ success: false, error: err.message || "Failed to start 3D model generation." });
    }
  });

  // ---------------------------------------------------------------------------
  // Generic Image-to-3D utility: any arbitrary image → GLB download.
  // Bypasses all pet-specific AI (no generatePetReferenceImage, no turnaround
  // generation). Users supply their own image + optional multiview shots.
  // Reuses the same credit/cap guards as create-3d-model.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // POST /api/text-to-reference
  // Turns a structured text prompt (subject + 3D-safe style/framing/angle/
  // lighting dropdowns) into a single clean reference IMAGE via Gemini. That
  // image is returned to the client, previewed, then fed into the UNCHANGED
  // /api/image-to-3d pipeline. This step only spends image-gen budget, so the
  // user can preview before committing the 400-credit mesh generation.
  // ---------------------------------------------------------------------------
  app.post("/api/text-to-reference", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { subject, style, framing, angle, lighting } = req.body || {};
      if (!subject || typeof subject !== "string" || subject.trim().length < 2) {
        return res.status(400).json({ success: false, error: "Describe what to make (a short subject phrase)." });
      }
      if (subject.length > 600) {
        return res.status(400).json({ success: false, error: "Subject description is too long (max 600 characters)." });
      }

      const fields: TextPromptFields = { subject, style, framing, angle, lighting };
      const prompt = buildTextPrompt(fields);

      const image = await generateImageWithFallback(
        [{ text: prompt }],
        "text-to-reference",
        req.user!.phone,
      );
      if (!image) {
        return res.status(502).json({ success: false, error: "Could not generate a reference image. Try rephrasing the subject." });
      }

      // Return the data URL for preview; the client sends it to /api/image-to-3d next.
      res.json({ success: true, image, prompt });
    } catch (err: any) {
      console.error("[text-to-reference] Error:", err);
      const status = err instanceof ImageGenerationBudgetError
        ? (err.code === "IMAGE_GENERATION_USER_CAP" ? 429 : 503)
        : 500;
      res.status(status).json({
        success: false,
        error: err?.message || "Failed to generate reference image.",
        code: err?.code,
      });
    }
  });

  app.post("/api/image-to-3d", requireAuth, rejectLegacyExternal3dRoute, async (req: AuthedRequest, res) => {
    let creditReservationId: string | null = null;
    try {
      const { image, multiview, geometry } = req.body || {};
      if (!image || typeof image !== "string") {
        return res.status(400).json({ success: false, error: "An image (base64 data URL or public URL) is required." });
      }
      // Optional geometry overrides from the text-to-3D UI: { detail, texture }.
      const geo = geometry && typeof geometry === "object"
        ? geometryToTripo(geometry.detail, geometry.texture)
        : undefined;

      const userPhone = req.user!.phone;
      const isAdmin = await isUserAdmin(userPhone);

      // Credit/cap guards — same as create-3d-model
      if (!isAdmin) {
        const dailyCount = await getDailyVideoCount(userPhone);
        if (dailyCount >= MAX_DAILY_VIDEOS) {
          return res.status(429).json({ success: false, error: `Daily generation limit reached (${MAX_DAILY_VIDEOS}/day). Please try again tomorrow.` });
        }
        const balance = await getCreditBalance(userPhone);
        if (balance < MODEL_COST) {
          return res.status(402).json({ success: false, error: `Insufficient PupCoins. You need ${MODEL_COST} PupCoins.` });
        }
      }

      // Ensure we have a public URL for Tripo
      let publicImageUrl = image;
      if (publicImageUrl.startsWith("data:image")) {
        try {
          publicImageUrl = await uploadBase64Image(publicImageUrl);
        } catch (upErr: any) {
          return res.status(502).json({ success: false, error: "Could not prepare image for 3D conversion." });
        }
      }

      // Process optional multiview images (user-supplied left/back/right)
      let views: { left?: string; back?: string; right?: string } | undefined;
      if (multiview && typeof multiview === "object") {
        const uploaded: { left?: string; back?: string; right?: string } = {};
        for (const key of ["left", "back", "right"] as const) {
          const v = multiview[key];
          if (v && typeof v === "string") {
            uploaded[key] = v.startsWith("data:image") ? await uploadBase64Image(v) : v;
          }
        }
        if (Object.keys(uploaded).length > 0) views = uploaded;
      }

      if (!isAdmin) {
        creditReservationId = await reserveCredits(userPhone, MODEL_COST, "static_3d_photo");
        if (!creditReservationId) return res.status(402).json({ success: false, error: `Insufficient PupCoins. You need ${MODEL_COST} PupCoins.` });
      }

      // Start Tripo generation directly — no pet AI reference image step
      let handle: string;
      try {
        handle = await startImageTo3D({ imageUrl: publicImageUrl, views, geometry: geo });
      } catch (genErr: any) {
        if (creditReservationId) {
          await refundReservedCredits(creditReservationId);
          creditReservationId = null;
        }
        console.error("[image-to-3d] Tripo start error:", genErr);
        if (isTripoInsufficientCredit(genErr)) {
          return res.status(503).json({
            success: false,
            error: "3D generation is temporarily unavailable. Please try again later.",
            code: "GENERATION_SERVICE_UNAVAILABLE"
          });
        }
        return res.status(502).json({ success: false, error: "Failed to start 3D generation. Please try again later." });
      }

      // Create job in DB (kind 'model', reuse the same jobs table)
      const jobId = await createJob({
        user_phone: userPhone,
        creation_id: null as any, // no creation for arbitrary images
        kind: "model",
        credits_reserved: creditReservationId ? MODEL_COST : 0,
        credit_debit_correlation_id: creditReservationId,
        operation_name: handle,
      });
      creditReservationId = null; // durable job now owns any refund decision

      console.log(`[image-to-3d] Job ${jobId} started for user ${userPhone} (handle: ${handle})`);
      res.status(202).json({ success: true, jobId, status: "queued" });
    } catch (err: any) {
      if (creditReservationId) {
        try { await refundReservedCredits(creditReservationId); } catch {}
      }
      console.error("[image-to-3d] Error:", err);
      res.status(500).json({ success: false, error: err.message || "Failed to start 3D generation." });
    }
  });

  // Status alias — delegates to the existing /api/jobs/:id poller which already
  // handles Tripo handles. This gives the image-to-3d UI a clean URL.
  app.get("/api/image-to-3d/:jobId/status", requireAuth, rejectLegacyExternal3dRoute, async (req: AuthedRequest, res) => {
    try {
      const jobId = parseInt(req.params.jobId, 10);
      const job = await getJob(jobId, req.user!.phone);
      if (!job) return res.status(404).json({ success: false, error: "Job not found" });

      const videoStaleMs = Number(process.env.VIDEO_JOB_STALE_MS) || 20 * 60 * 1000;
      if (job.kind === "video" && ["queued", "running"].includes(job.status)
        && Date.now() - new Date(job.created_at).getTime() > videoStaleMs) {
        await failGenerationJobAndRefundOnce(getPool(), job.id, "Video generation timed out before a durable file was returned.");
        return res.json({ success: true, status: "failed", video_url: null, error: "Video generation timed out. Your PupCoins were returned." });
      }

      if ((job.status === "running" || job.status === "queued") && job.operation_name && isTripoHandle(job.operation_name)) {
        try {
          const poll = await pollTripoTask(job.operation_name);
          if (poll.done && !poll.error) {
            // Mirror the provider's (temporary) GLB URL into our own Backblaze
            // bucket so the stored model_url stays valid after the provider link
            // expires. Matches the /api/jobs poller and AR bake path, which both
            // call uploadBinaryFromUrl. Storing the raw Tripo URL here caused
            // models to 404 once the provider expired the link.
            if (poll.glbUrl) {
              let durableUrl: string;
              try {
                durableUrl = await uploadBinaryFromUrl(poll.glbUrl, "model/gltf-binary");
              } catch (mirrorErr) {
                console.error(`[image-to-3d] Failed to mirror GLB for job ${jobId}:`, mirrorErr);
                await failGenerationJobAndRefundOnce(getPool(), jobId, "Failed to mirror model to durable storage (retryable).");
                return res.json({ status: "failed", error: "Failed to mirror model — retryable" });
              }
              if (!await markGenerationJobDoneOnce(getPool(), jobId)) {
                const current = await getJob(jobId, req.user!.phone);
                return res.json({ status: current?.status || "failed", error: current?.error || "Job already finalized." });
              }
              await setCreationModelUrl(job.creation_id!, req.user!.phone, durableUrl).catch(() => {
                // creation_id may be null for arbitrary images — that's fine
              });
              // PHASE BO-0: Register as canonical asset + record persistence event
              const { registerLegacyModelAsset } = await import("./server/legacy-asset-registration");
              const { recordPersistenceEvent } = await import("./server/model-persistence-events");

              void registerLegacyModelAsset({
                ownerId: req.user!.phone,
                glbUrl: durableUrl,
                sha256: "unknown",
                sizeBytes: 0,
                sourceImageUrl: "",
                jobId,
                creationId: job.creation_id ?? undefined,
              }).then((assetUuid) => {
                if (assetUuid) {
                  getPool().query(
                    "UPDATE generation_jobs SET canonical_asset_uuid = ? WHERE id = ?",
                    [assetUuid, jobId],
                  ).catch(() => {});
                }
              });

              void recordPersistenceEvent("static_glb_stored", {
                jobId,
                detail: "Model stored and registered from /api/image-to-3d/:jobId/status",
              });
              return res.json({ status: "done", model_url: durableUrl, progress: 100 });
            }
            await failGenerationJobAndRefundOnce(getPool(), jobId, "3D provider completed without a model file.");
            return res.json({ status: "failed", error: "3D provider completed without a model file." });
          } else if (poll.done && poll.error) {
            await failGenerationJobAndRefundOnce(getPool(), jobId, poll.error || "3D provider generation failed.");
            return res.json({ status: "failed", error: poll.error });
          } else {
            return res.json({ status: "running", progress: poll.progress || 0 });
          }
        } catch (pollErr: any) {
          return res.json({ status: "running", progress: 0 });
        }
      }

      // Terminal states
      if (job.status === "done_static_fallback") {
        return res.json({ success: true, status: "done_static_fallback", model_url: (job as any).model_url || null, error: null });
      }
      res.json({ status: job.status, model_url: (job as any).model_url || null });
    } catch (err: any) {
      res.status(500).json({ success: false, error: "Failed to check job status." });
    }
  });

  app.get("/api/jobs/:id", requireAuth, async (req: AuthedRequest, res) => {

    try {
      const jobId = parseInt(req.params.id, 10);
      const job = await getJob(jobId, req.user!.phone);
      if (!job) return res.status(404).json({ success: false, error: "Job not found" });

      const animatorOperation = decodeAnimatorOperationMetadata(job.operation_name);
      if (animatorOperation) {
        const voicedResult = getOwnedVoicedResult(jobId, req.user!.phone);
        const progress = job.status === "done" || job.status === "failed" ? 100 : job.status === "running" ? 60 : 20;
        return res.json({ success: true, status: job.status, progress, video_url: voicedResult?.resultUrl || null, error: job.error || null });
      }

      // If running, poll the operation
      if (job.status === "running" || job.status === "queued") {
        // --- HeyGen talking-video branch ---
        if (job.operation_name && isHeyGenHandle(job.operation_name)) {
          if (job.creation_id === null) {
            return res.status(409).json({ success: false, status: job.status, error: "This video job has no creation target and cannot be finalized by the HTTP status route." });
          }
          try {
            const result = await pollTalkingVideo(job.operation_name);
            if (result.done) {
              if (result.videoUrl) {
                const dataUrl = await fetchMp4AsDataUrl(result.videoUrl);
                const videoUrl = await uploadBase64Image(dataUrl);
                if (!await markGenerationJobDoneOnce(getPool(), jobId)) {
                  const current = await getJob(jobId, req.user!.phone);
                  return res.json({ success: true, status: current?.status || "failed", error: current?.error || "Job already finalized." });
                }
                await setCreationVideoUrl(job.creation_id!, req.user!.phone, videoUrl);
                await sendSms(req.user!.phone, `🐾 Paws & Memories: Your talking pet video is ready! View it at ${process.env.APP_URL || "your app"}.`);
                return res.json({ success: true, status: "done", video_url: videoUrl });
              } else {
                await failGenerationJobAndRefundOnce(getPool(), jobId, result.error || "HeyGen generation failed");
                return res.json({ success: true, status: "failed", error: result.error || "HeyGen generation failed" });
              }
            } else {
              await updateJobStatus(jobId, "running");
            }
          } catch (pollErr: any) {
            console.error("HeyGen poll error:", pollErr);
            await failGenerationJobAndRefundOnce(getPool(), jobId, pollErr.message);
            return res.json({ success: true, status: "failed", error: pollErr.message });
          }
          return res.json({ success: true, status: job.status, video_url: null, error: job.error });
        }
        // --- Meshy 3D-model branch ---
        if (job.operation_name && isTripoHandle(job.operation_name)) {
          const providerGate = await claimPipelineProviderPoll(jobId);
          if (providerGate.isCreatePipeline && !providerGate.claim?.eligible) {
            const current = await getJob(jobId, req.user!.phone);
            return res.json({ success: true, status: current?.status || "failed", model_url: providerGate.claim?.context?.currentModelUrl || null, error: current?.error || null });
          }
          try {
            const result = await pollImageTo3D(job.operation_name);
            if (result.done) {
              if (result.glbUrl) {
                // Static model is ALWAYS stored first — a later rig failure can
                // never cost the user their base model (P3 §5.3).
                const modelUrl = await uploadBinaryFromUrl(result.glbUrl, "model/gltf-binary");
                if (providerGate.isCreatePipeline && providerGate.claim) {
                  await setCreationModelUrl(job.creation_id!, req.user!.phone, modelUrl);
                  const status = await finishStoredPipelineModel(jobId, providerGate.claim, modelUrl);
                  if (status === "done") {
                    await sendSms(req.user!.phone, `🐾 Paws & Memories: Your 3D pet model is ready! View it at ${process.env.APP_URL || "your app"}.`);
                    // PHASE BO-0: Register as canonical asset + record persistence event
                    const { registerLegacyModelAsset } = await import("./server/legacy-asset-registration");
                    const { recordPersistenceEvent } = await import("./server/model-persistence-events");

                    void registerLegacyModelAsset({
                      ownerId: req.user!.phone,
                      glbUrl: modelUrl,
                      sha256: "unknown",
                      sizeBytes: 0,
                      sourceImageUrl: "",
                      jobId,
                      creationId: job.creation_id ?? undefined,
                    }).then((assetUuid) => {
                      if (assetUuid) {
                        getPool().query(
                          "UPDATE generation_jobs SET canonical_asset_uuid = ? WHERE id = ?",
                          [assetUuid, jobId],
                        ).catch(() => {});
                      }
                    });

                    void recordPersistenceEvent("static_glb_stored", {
                      jobId,
                      detail: "Model stored and registered from /api/jobs/:id poll",
                    });
                  }
                  return res.json({ success: true, status, model_url: modelUrl });
                }
                if (!await markGenerationJobDoneOnce(getPool(), jobId)) {
                  const current = await getJob(jobId, req.user!.phone);
                  return res.json({ success: true, status: current?.status || "failed", error: current?.error || "Job already finalized." });
                }
                await setCreationModelUrl(job.creation_id!, req.user!.phone, modelUrl);
                await sendSms(req.user!.phone, `🐾 Paws & Memories: Your 3D pet model is ready! View it at ${process.env.APP_URL || "your app"}.`);
                return res.json({ success: true, status: "done", model_url: modelUrl });
              } else {
                if (providerGate.isCreatePipeline) {
                  await rejectPipelineRigRecovery(jobId, providerGate.claim?.context || null, result.error || "Provider returned no model", providerGate.claim?.leaseOwner);
                } else {
                  await failGenerationJobAndRefundOnce(getPool(), jobId, result.error || "Meshy generation failed");
                }
                return res.json({ success: true, status: "failed", error: result.error || "Meshy generation failed" });
              }
            } else {
              if (providerGate.isCreatePipeline && providerGate.claim?.leaseOwner) {
                await pipelineRigRecovery.releaseProviderPoll(jobId, providerGate.claim.leaseOwner, "provider_still_running");
              } else {
                await updateJobStatus(jobId, "running");
              }
            }
          } catch (pollErr: any) {
            console.error("Meshy poll error:", pollErr);
            if (providerGate.isCreatePipeline) {
              await rejectPipelineRigRecovery(jobId, providerGate.claim?.context || null, `Provider poll failed: ${pollErr.message}`, providerGate.claim?.leaseOwner);
            } else {
              await failGenerationJobAndRefundOnce(getPool(), jobId, pollErr.message);
            }
            return res.json({ success: true, status: "failed", error: pollErr.message });
          }
          return res.json({ success: true, status: job.status, model_url: null, error: job.error });
        }
        // --- Veo (Gemini) branch ---
        if (job.operation_name) {
          try {
            const op: any = await ai.operations.getVideosOperation({ operation: veoOperationHandle(job.operation_name) });
            if (op.done) {
              if (op.response?.generatedVideos?.[0]?.video) {
                const videoData: any = op.response.generatedVideos[0].video;
                let videoUrl: string;
                if (videoData.uri) {
                  const gcsRes = await fetch(videoData.uri, { headers: process.env.GEMINI_API_KEY ? { "x-goog-api-key": process.env.GEMINI_API_KEY } : undefined });
                  if (!gcsRes.ok) throw new Error(`Video download failed (${gcsRes.status})`);
                  const buf = Buffer.from(await gcsRes.arrayBuffer());
                  videoUrl = await uploadBase64Image(`data:video/mp4;base64,${buf.toString("base64")}`);
                } else if (videoData.imageBytes) {
                  videoUrl = await uploadBase64Image(`data:video/mp4;base64,${videoData.imageBytes}`);
                } else {
                  throw new Error("Veo returned no video URI or bytes");
                }
                
                // Update DB
                if (!await markGenerationJobDoneOnce(getPool(), jobId)) {
                  const current = await getJob(jobId, req.user!.phone);
                  return res.json({ success: true, status: current?.status || "failed", error: current?.error || "Job already finalized." });
                }
                await setCreationVideoUrl(job.creation_id!, req.user!.phone, videoUrl);
                
                await sendSms(req.user!.phone, `🐾 Paws & Memories: Your pet video animation is ready! View it at ${process.env.APP_URL || "your app"}.`);
                
                return res.json({ success: true, status: "done", video_url: videoUrl });
              } else {
                // Failed or empty response
                await failGenerationJobAndRefundOnce(getPool(), jobId, "No video generated");
                return res.json({ success: true, status: "failed", error: "Generation returned no video" });
              }
            } else {
              // Still running
              await updateJobStatus(jobId, "running");
            }
          } catch (pollErr: any) {
            console.error("Video poll error:", pollErr);
            await failGenerationJobAndRefundOnce(getPool(), jobId, pollErr.message);
            return res.json({ success: true, status: "failed", error: pollErr.message });
          }
        }
      }

      if (job.status === "done_static_fallback") {
        // PHASE BO-0: Record persistence event
        const { recordPersistenceEvent } = await import("./server/model-persistence-events");
        void recordPersistenceEvent("done_static_fallback", {
          jobId,
          detail: "Job completed via static fallback (rig skipped)",
        });
        return res.json({ success: true, status: "done_static_fallback", model_url: (job as any).model_url || null, error: null });
      }
      res.json({ success: true, status: job.status, video_url: null, error: job.error });
    } catch (err: any) {
      console.error("Error polling job:", err);
      res.status(500).json({ success: false, error: "Failed to poll job status." });
    }
  });

  // Restart recovery is explicit and conservative. Legacy rows without a
  // source fingerprint/recovery timestamp are finalized without touching the
  // Blender worker; only a recent, leased, current-model rig can resume.
  let pipelineRigRecoverySweepActive = false;
  async function recoverPipelineRigJobs(): Promise<void> {
    if (pipelineRigRecoverySweepActive) return;
    pipelineRigRecoverySweepActive = true;
    try {
      const jobIds = await pipelineRigRecovery.listRigRecoveryCandidates();
      for (const jobId of jobIds) {
        await runCreatePipelineRigStage(jobId);
      }
    } catch (error: any) {
      console.error("[PipelineRig recovery] sweep failed:", error?.message || error);
    } finally {
      pipelineRigRecoverySweepActive = false;
    }
  }
  void recoverPipelineRigJobs();
  setInterval(() => void recoverPipelineRigJobs(), 60 * 1000);

  let generationRefundSweepActive = false;
  async function recoverPendingGenerationRefunds(): Promise<void> {
    if (generationRefundSweepActive) return;
    generationRefundSweepActive = true;
    try {
      const result = await sweepPendingGenerationRefunds(getPool(), 25);
      if (result.failed > 0) {
        console.error(`[Generation refunds] ${result.failed}/${result.attempted} pending refunds remain retryable.`);
      }
    } catch (error: any) {
      console.error("[Generation refunds] sweep failed:", error?.message || error);
    } finally {
      generationRefundSweepActive = false;
    }
  }
  void recoverPendingGenerationRefunds();
  setInterval(() => void recoverPendingGenerationRefunds(), 60 * 1000);

  // Background poller for orphaned/running provider jobs (runs every 15s).
  // Create-pipeline model jobs must acquire a provider lease before polling.
  setInterval(async () => {
    try {
      const jobs = await getRunningJobs();
      for (const job of jobs) {
        const animatorOperation = decodeAnimatorOperationMetadata(job.operation_name);
        const videoStaleMs = Number(process.env.VIDEO_JOB_STALE_MS) || 20 * 60 * 1000;
        if (job.kind === "video" && Date.now() - new Date(job.created_at).getTime() > videoStaleMs) {
          if (animatorOperation) {
            const { claimVoiceoverFinalizer, failVoiceoverAndRefundOnce } = await import("./server/animator/voicedResults.ts");
            const leaseOwner = await claimVoiceoverFinalizer(job.id, job.user_phone);
            if (leaseOwner) await failVoiceoverAndRefundOnce(job.id, leaseOwner, "Voiceover generation timed out before a durable verified video was published.");
            continue;
          }
          await failGenerationJobAndRefundOnce(getPool(), job.id, "Video generation timed out before a durable file was returned.");
          continue;
        }
        if (!job.operation_name) continue;
        // --- HeyGen talking-video branch ---
        const heyGenOperation = animatorOperation?.providerOperationName || job.operation_name;
        if (isHeyGenHandle(heyGenOperation)) {
          if (animatorOperation) {
            const {
              claimVoiceoverFinalizer,
              releaseVoiceoverFinalizer,
              markVoiceoverDone,
              failVoiceoverAndRefundOnce,
              persistVoicedResult,
            } = await import("./server/animator/voicedResults.ts");
            const leaseOwner = await claimVoiceoverFinalizer(job.id, job.user_phone);
            if (!leaseOwner) continue;
            const cleanup: string[] = [];
            try {
              const result = await pollTalkingVideo(animatorOperation.providerOperationName);
              if (!result.done) {
                await releaseVoiceoverFinalizer(job.id, leaseOwner);
                continue;
              }
              if (!result.videoUrl) {
                await failVoiceoverAndRefundOnce(job.id, leaseOwner, result.error || "Voiceover provider returned no video");
                continue;
              }
              const { getOwnedRecording, validateRecordingUpload } = await import("./server/animator/recordings.ts");
              const { resolveWithinWorkspace, ANIMATOR_DATA_DIR } = await import("./server/animator/paths.ts");
              const { muxAudioBed } = await import("./server/animator/audioMux.ts");
              const recording = getOwnedRecording(animatorOperation.recordingId, job.user_phone);
              if (!recording) throw new Error("Owner recording is missing or inaccessible");
              const providerResponse = await fetch(result.videoUrl);
              if (!providerResponse.ok) throw new Error(`Voiceover download failed (${providerResponse.status})`);
              const declaredLength = Number(providerResponse.headers.get("content-length") || 0);
              if (declaredLength > 25 * 1024 * 1024) throw new Error("Voiceover download exceeds size limit");
              const providerBytes = Buffer.from(await providerResponse.arrayBuffer());
              if (providerBytes.length > 25 * 1024 * 1024) throw new Error("Voiceover download exceeds size limit");
              validateRecordingUpload(providerBytes, "video/mp4");
              const providerPath = resolveWithinWorkspace(`tmp/voiceover-${job.id}-${randomUUID()}.mp4`, ANIMATOR_DATA_DIR);
              const outputExtension = recording.mimeType === "video/mp4" ? "mp4" : "webm";
              const outputPath = resolveWithinWorkspace(`tmp/voiced-${job.id}-${randomUUID()}.${outputExtension}`, ANIMATOR_DATA_DIR);
              cleanup.push(providerPath, outputPath);
              await fs.promises.mkdir(path.dirname(providerPath), { recursive: true });
              await fs.promises.writeFile(providerPath, providerBytes, { flag: "wx" });
              await muxAudioBed({ workspaceRoot: ANIMATOR_DATA_DIR, videoPath: `recordings/${recording.fileName}`, audioSources: [{ path: path.relative(ANIMATOR_DATA_DIR, providerPath), gain: 1 }], outputPath: path.relative(ANIMATOR_DATA_DIR, outputPath), maxDuration: 10 });
              const voicedBytes = await fs.promises.readFile(outputPath);
              const outputMime = outputExtension === "mp4" ? "video/mp4" : "video/webm";
              const durableUrl = await uploadBase64Binary(voicedBytes.toString("base64"), outputMime, "animator-voiced-results");
              if (!durableUrl) throw new Error("Durable voiced-result publication returned no URL");
              persistVoicedResult({ jobId: job.id, ownerId: job.user_phone, recordingId: animatorOperation.recordingId, resultUrl: durableUrl, mimeType: outputMime, bytes: voicedBytes });
              if (!await markVoiceoverDone(job.id, leaseOwner)) throw new Error("Voiceover finalizer lease was lost before completion");
            } catch (err: any) {
              const reason = `Voiceover finalization failed: ${String(err?.message || err).replace(/[\r\n\t]+/g, " ").slice(0, 420)}`;
              console.error(`Background Animator voiceover error for job ${job.id}:`, err);
              await failVoiceoverAndRefundOnce(job.id, leaseOwner, reason);
            } finally {
              for (const candidate of cleanup) await fs.promises.rm(candidate, { force: true }).catch(() => undefined);
            }
            continue;
          }
          try {
            const result = await pollTalkingVideo(heyGenOperation);
            if (result.done) {
              if (result.videoUrl) {
                // Standard create-video HeyGen flow
                const dataUrl = await fetchMp4AsDataUrl(result.videoUrl);
                const videoUrl = await uploadBase64Image(dataUrl);
                if (!await markGenerationJobDoneOnce(getPool(), job.id)) continue;
                if (job.creation_id) {
                  await setCreationVideoUrl(job.creation_id, job.user_phone, videoUrl);
                }
                await sendSms(job.user_phone, `🐾 Paws & Memories: Your talking pet video is ready! View it at ${process.env.APP_URL || "your app"}.`);
              } else {
                await failGenerationJobAndRefundOnce(getPool(), job.id, result.error || "HeyGen generation failed");
              }
            }
          } catch (err: any) {
            const reason = String(err?.message || err).slice(0, 480);
            console.error(`Background HeyGen poller error for job ${job.id}:`, err);
            await failGenerationJobAndRefundOnce(getPool(), job.id, `HeyGen poll failed: ${reason}`);
          }
          continue;
        }
        // --- Meshy 3D-model branch ---
        if (isTripoHandle(job.operation_name)) {
          const providerGate = await claimPipelineProviderPoll(job.id);
          if (providerGate.isCreatePipeline && !providerGate.claim?.eligible) continue;
          try {
            const result = await pollImageTo3D(job.operation_name);
            if (result.done) {
              if (result.glbUrl) {
                // Static model is ALWAYS stored first (P3 §5.3).
                const modelUrl = await uploadBinaryFromUrl(result.glbUrl, "model/gltf-binary");
                if (providerGate.isCreatePipeline && providerGate.claim) {
                  if (job.creation_id) {
                    await setCreationModelUrl(job.creation_id, job.user_phone, modelUrl);
                  }
                  const status = await finishStoredPipelineModel(job.id, providerGate.claim, modelUrl);
                  if (status === "done") {
                    await sendSms(job.user_phone, `🐾 Paws & Memories: Your 3D pet model is ready! View it at ${process.env.APP_URL || "your app"}.`);
                    // PHASE BO-0: Register as canonical asset + record persistence event
                    const { registerLegacyModelAsset } = await import("./server/legacy-asset-registration");
                    const { recordPersistenceEvent } = await import("./server/model-persistence-events");

                    // Register as canonical asset (non-blocking, non-fatal)
                    void registerLegacyModelAsset({
                      ownerId: job.user_phone,
                      glbUrl: modelUrl,
                      sha256: "unknown",
                      sizeBytes: 0,
                      sourceImageUrl: "",
                      jobId: job.id,
                      creationId: job.creation_id ?? undefined,
                    }).then((assetUuid) => {
                      if (assetUuid) {
                        getPool().query(
                          "UPDATE generation_jobs SET canonical_asset_uuid = ? WHERE id = ?",
                          [assetUuid, job.id],
                        ).catch(() => {});
                      }
                    });

                    // Record persistence event
                    void recordPersistenceEvent("static_glb_stored", {
                      jobId: job.id,
                      detail: "Model stored and registered from background sweep",
                    });
                  }
                  continue;
                }
                if (!await markGenerationJobDoneOnce(getPool(), job.id)) continue;
                if (job.creation_id) {
                  await setCreationModelUrl(job.creation_id, job.user_phone, modelUrl);
                }
                await sendSms(job.user_phone, `🐾 Paws & Memories: Your 3D pet model is ready! View it at ${process.env.APP_URL || "your app"}.`);
              } else {
                if (providerGate.isCreatePipeline) {
                  await rejectPipelineRigRecovery(job.id, providerGate.claim?.context || null, result.error || "Provider returned no model", providerGate.claim?.leaseOwner);
                } else {
                  await failGenerationJobAndRefundOnce(getPool(), job.id, result.error || "Meshy generation failed");
                }
              }
            } else if (providerGate.isCreatePipeline && providerGate.claim?.leaseOwner) {
              await pipelineRigRecovery.releaseProviderPoll(job.id, providerGate.claim.leaseOwner, "provider_still_running");
            }
          } catch (err: any) {
            // Preserve the real cause. This previously stored the literal string
            // "Poller error", which is why jobs 21-23 are unactionable in the DB:
            // the message that would have explained them was thrown away.
            const reason = String(err?.message || err).slice(0, 480);
            console.error(`Background Tripo poller error for job ${job.id}:`, err);
            if (providerGate.isCreatePipeline) {
              await rejectPipelineRigRecovery(job.id, providerGate.claim?.context || null, `Provider poll failed: ${reason}`, providerGate.claim?.leaseOwner);
            } else {
              await failGenerationJobAndRefundOnce(getPool(), job.id, `Tripo poll failed: ${reason}`);
            }
          }
          continue;
        }
        // --- Veo (Gemini) branch ---
        try {
          const op: any = await ai.operations.getVideosOperation({ operation: veoOperationHandle(job.operation_name) });
          if (op.done) {
            if (op.response?.generatedVideos?.[0]?.video) {
              const videoData: any = op.response.generatedVideos[0].video;
              let videoUrl: string;
              if (videoData.uri) {
                const gcsRes = await fetch(videoData.uri, { headers: process.env.GEMINI_API_KEY ? { "x-goog-api-key": process.env.GEMINI_API_KEY } : undefined });
                if (!gcsRes.ok) throw new Error(`Video download failed (${gcsRes.status})`);
                const buf = Buffer.from(await gcsRes.arrayBuffer());
                videoUrl = await uploadBase64Image(`data:video/mp4;base64,${buf.toString("base64")}`);
              } else if (videoData.imageBytes) {
                videoUrl = await uploadBase64Image(`data:video/mp4;base64,${videoData.imageBytes}`);
              } else {
                throw new Error("Veo returned no video URI or bytes");
              }
              
              if (!await markGenerationJobDoneOnce(getPool(), job.id)) continue;
              if (job.creation_id) {
                await setCreationVideoUrl(job.creation_id, job.user_phone, videoUrl);
              }
              
              await sendSms(job.user_phone, `🐾 Paws & Memories: Your pet video animation is ready! View it at ${process.env.APP_URL || "your app"}.`);
            } else {
              await failGenerationJobAndRefundOnce(getPool(), job.id, "No video generated");
            }
          }
        } catch (err) {
          console.error(`Background poller error for job ${job.id}:`, err);
          await failGenerationJobAndRefundOnce(getPool(), job.id, "Poller error");
        }
      }
    } catch (e) {
      // Silent fail for background poller to avoid crashing the server
    }
  }, 15000);

  // Randy AI pet guide live chat route
  app.post("/api/randy-chat", requireAuth, randyChatLimiter, async (req, res) => {
    try {
      const request = RandyChatRequestSchema.safeParse(req.body);
      if (!request.success) return res.status(400).json({ success: false, error: "Message or chat history is invalid." });
      const { message, history } = request.data;

      const userPhone = (req as AuthedRequest).user!.phone;
      const liveContext = {
        credits: await getCreditBalance(userPhone),
        isAdmin: await isUserAdmin(userPhone),
      };

      // Map communication messages cleanly to the @google/genai format
      const contentParts: any[] = [];
      if (history.length) {
        history.forEach((item) => {
          contentParts.push({
            role: item.role === "user" ? "user" : "model",
            parts: [{ text: item.text }]
          });
        });
      }

      contentParts.push({
        role: "user",
        parts: [{ text: message }]
      });

      const response = await ai.models.generateContent({
        model: process.env.GEMINI_TEXT_MODEL || "gemini-3.1-flash-lite",
        contents: contentParts,
        config: {
          systemInstruction: buildRandySystemInstruction(liveContext),
          temperature: 0.4,
          responseMimeType: "application/json",
        }
      });

      const rawText = response.text || "";

      const { text, action } = parseRandyModelResponse(
        rawText,
        "I was chasing a squirrel and forgot what I was saying! *tilts head* Can you run that by me one more time, friend?",
      );

      const actorHash = createHash("sha256").update(userPhone).digest("hex").slice(0, 12);
      console.info("[Randy] action proposal", { actorHash, registryVersion: RANDY_REGISTRY_VERSION, action });

      res.json({ success: true, text, action, knowledgeVersion: RANDY_REGISTRY_VERSION });
    } catch (err: any) {
      console.error("Error in Randy chat query:", err);
      res.json({
        success: true,
        text: "My furry ears drooped a bit because my signal got tangled in the leash *whines softly*. Could you try asking me again, friend? (And make sure your Gemini API key is configured correctly in Settings > Secrets!)",
        action: { type: "none" }
      });
    }
  });

  // Legal pages — served server-side as standalone HTML so they always load
  // for users and for SMS/10DLC compliance reviewers, independent of the SPA.
  // Registered BEFORE static/SPA catch-all so /legal/* is not swallowed by index.html.
  const legalHeaders = (res: any) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
  };
  app.get("/legal/privacy", (_req, res) => { legalHeaders(res); res.send(privacyHtml()); });
  app.get("/legal/terms", (_req, res) => { legalHeaders(res); res.send(termsHtml()); });
  app.get("/legal/sms", (_req, res) => { legalHeaders(res); res.send(smsTermsHtml()); });

  // Every real /api route is registered above this line. Anything still
  // unmatched under /api is a genuine 404, and it must be answered as JSON:
  // falling through to the SPA catch-all below returned "200 OK" with an HTML
  // document, so a fetch() for a mistyped or retired endpoint looked like a
  // success and then threw inside .json(). Registered before the static/SPA
  // handlers so it applies to the vite dev middleware and production alike.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Serve static assets or mount Vite middleware
  // Auto-detect production: if dist/index.html exists we're running from a build
  const distPath = path.join(process.cwd(), 'dist');
  const isProduction = process.env.NODE_ENV === "production" || fs.existsSync(path.join(distPath, 'index.html'));

  if (!isProduction) {
    // Dynamic import so vite is never loaded in production bundles
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log(`[Production] Serving static files from ${distPath}`);
    app.use(express.static(distPath, {
      // index:false is load-bearing. express.static's `index` option defaults to
      // "index.html", so a request for "/" is answered from disk here and never
      // reaches the SPA catch-all below — which meant the homepage alone was
      // served the raw template, skipping injectMeta() and keeping the generic
      // title/description. Every other route was fine because no file matches
      // them. Turning the directory index off lets "/" fall through.
      index: false,
      setHeaders(res, filePath) {
        // Vite fingerprints asset filenames, so hashed assets are safe to cache
        // forever. index.html must stay uncached so new deploys are picked up.
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else if (/\.(js|css|woff2?|png|jpe?g|webp|avif|glb|gltf|svg)$/i.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }));
    // Static-asset requests (models, images, media, data files) that reached here
    // did NOT match a real file — return a clean 404 instead of index.html. Otherwise
    // a missing asset like /objects/bed.glb returns HTML, and loaders (GLTFLoader,
    // fetch(...).json()) choke on "<!doctype ...". SPA routes (no file extension)
    // still fall through to index.html.
    const ASSET_EXT = /\.(glb|gltf|bin|hdr|exr|ktx2|basis|png|jpe?g|webp|avif|gif|svg|mp4|webm|mp3|wav|ogg|json|wasm|woff2?|ttf|otf)$/i;

    // Read the SPA shell once — it only changes on deploy. Every route used to
    // get this file verbatim, which meant every page declared the homepage as
    // its canonical and self-excluded itself from the index. injectMeta()
    // rewrites the canonical, og:url, title and description per route before
    // sending, so crawlers and social scrapers (which never run JS) see the
    // right tags in the initial HTML. See server/seoMeta.ts.
    const indexHtmlPath = path.join(distPath, 'index.html');

    // NODE_ENV=production can be set on a host where `npm run build` has not
    // run yet, in which case this file does not exist. Fail with a sentence
    // that names the cause instead of an ENOENT stack trace at boot — a
    // half-built deploy is the single most common deployment failure here
    // (DEPLOYMENT_NOTES.md §1).
    if (!fs.existsSync(indexHtmlPath)) {
      throw new Error(
        `[Production] ${indexHtmlPath} is missing. The deploy did not run "npm run build". ` +
        `Run the build before "npm start" — serving the repo-root index.html will not work, ` +
        `it references /src/main.tsx which only exists under the Vite dev server.`
      );
    }

    // Read once — this file only changes on deploy.
    const INDEX_HTML = fs.readFileSync(indexHtmlPath, 'utf8');

    const serveSpaShell = (req: express.Request, res: express.Response) => {
      if (ASSET_EXT.test(req.path)) {
        return res.status(404).type("txt").send("Not found");
      }
      res.setHeader("Cache-Control", "no-cache");
      return res.type("html").send(injectMeta(INDEX_HTML, req.path));
    };
    // Hostinger's Express router does not include "/" in the "*" match used
    // below, even though deeper SPA routes are matched. Keep the homepage
    // explicit so a successful deployment cannot return "Cannot GET /".
    app.get("/", serveSpaShell);
    app.get("*", serveSpaShell);
  }

  let shuttingDown = false;
  async function shutdown(reason: string, exitCode: number) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] ${reason}`);
    try {
      await Promise.race([
        Promise.all([
          new Promise<void>((resolve, reject) => {
            httpServer.close((error) => error ? reject(error) : resolve());
          }),
          closePool(),
        ]),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Graceful shutdown timed out.")), 10_000).unref();
        }),
      ]);
    } catch (error) {
      console.error("[Shutdown] Server did not close cleanly:", error);
      exitCode = 1;
    }
    process.exit(exitCode);
  }

  process.once("SIGTERM", () => { void shutdown("SIGTERM", 0); });
  process.once("SIGINT", () => { void shutdown("SIGINT", 0); });
  process.once("unhandledRejection", (reason) => {
    console.error("[FATAL] Unhandled rejection:", reason);
    void shutdown("unhandledRejection", 1);
  });
  process.once("uncaughtException", (error) => {
    console.error("[FATAL] Uncaught exception:", error);
    void shutdown("uncaughtException", 1);
  });
}

const isEntryPoint = Boolean(
  process.argv[1] &&
  (process.argv[1].endsWith("server.ts") ||
   process.argv[1].endsWith("server.cjs") ||
   process.argv[1].endsWith("server.js"))
);
const hasHostingerBootstrap = Boolean(
  (globalThis as typeof globalThis & { __PAWSOME_HOSTINGER_BOOTSTRAP__?: unknown })
    .__PAWSOME_HOSTINGER_BOOTSTRAP__
);

if (isEntryPoint || hasHostingerBootstrap) {
  startServer().catch(async (error) => {
    console.error("[FATAL] Server startup failed:", error);
    await closePool().catch((closeError) => {
      console.error("[FATAL] Database pool cleanup failed:", closeError);
    });
    process.exitCode = 1;
  });
}
