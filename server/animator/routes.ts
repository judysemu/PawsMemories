import express from "express";
import fs from "fs";
import { importAsset } from "./assets.ts";
import { inspectAsset } from "./gltf.ts";
import { enqueue, JobSpecSchema } from "./queue.ts";
import { readManifest } from "./manifest.ts";
import { resolveWithinWorkspace } from "./paths.ts";
import { createProject, getProject, listProjects, updateProject, deleteProject } from "./projects.ts";
import { createScene, getScene } from "./scenes.ts";
import { handleLipsyncPost, handleLipsyncGet } from "./lipsync.ts";
import { createSpeechPreview, SpeechPreviewSchema } from "./speechPreview.ts";
import { loadEnvironments } from "./environments.ts";
import { loadScripts, getVoiceoverScripts, estimateSpeechSeconds } from "./scripts.ts";
import { getDirectorScripts } from "./sceneScripts.ts";
import { CC0_CLIPS } from "./clips.ts";
import { uploadBase64Binary } from "../../storage.ts";
import { getCreditBalance, reserveCredits, refundReservedCredits, createJob, isUserAdmin, getDailyVideoCount } from "../../db.ts";
import { startTalkingVideo } from "../../heygen.ts";
import { CREDIT_PRICES } from "../../src/pricing.ts";
import { saveRecording, getOwnedRecording } from "./recordings.ts";
import { encodeAnimatorOperationMetadata, decodeAnimatorOperationMetadata } from "./operationMetadata.ts";
import { getOwnedVoicedResult } from "./voicedResults.ts";

export const animatorRouter = express.Router();

/**
 * Handler for errors in read (GET) endpoints.
 * ANIMATOR_UNAVAILABLE → empty shape, 200 (never break boot; spec §1D).
 * Other errors → 500 with message.
 */
function handleReadError(res: express.Response, e: any) {
  if (e.message === "ANIMATOR_UNAVAILABLE") {
    return res.json([]);
  }
  if (e.message === "ANIMATOR_DATA_DIR_NOT_FOUND") {
    return res.json([]);
  }
  res.status(500).json({ error: e.message });
}

/**
 * Handler for errors in write/convert (POST) endpoints.
 * ANIMATOR_UNAVAILABLE → 503 (write genuinely needs toolchain; spec §1D).
 * Other errors → 500 with message.
 */
function handleError(res: express.Response, e: any) {
  if (e.message === "ANIMATOR_UNAVAILABLE") {
    res.status(503).json({ code: "ANIMATOR_UNAVAILABLE", error: "Animator dependencies missing on server" });
  } else {
    res.status(500).json({ error: e.message });
  }
}

animatorRouter.post("/animator/assets", async (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    const { base64Bytes, originalFilename } = req.body;
    if (typeof base64Bytes !== "string" || !base64Bytes || base64Bytes.length > 70_000_000) {
      return res.status(400).json({ error: "Upload an owned GLB or glTF file up to 50 MB." });
    }
    const sourceBuffer = Buffer.from(base64Bytes, "base64");

    const metadata = await importAsset({
      userPhone,
      sourceBuffer,
      originalFilename: originalFilename || "model.glb"
    });
    
    res.json(metadata);
  } catch (e: any) {
    if (e.message === "ANIMATOR_UNAVAILABLE") return handleError(res, e);
    res.status(400).json({ error: e.message });
  }
});

animatorRouter.get("/animator/assets", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    const originalsDir = resolveWithinWorkspace("originals");
    if (!fs.existsSync(originalsDir)) {
      return res.json([]);
    }
    const dirs = fs.readdirSync(originalsDir);
    const assets = [];
    for (const dir of dirs) {
      const metaPath = resolveWithinWorkspace(`originals/${dir}/metadata.json`);
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (meta.userPhone === userPhone) {
          assets.push(meta);
        }
      }
    }
    res.json(assets);
  } catch (e: any) {
    handleReadError(res, e);
  }
});

animatorRouter.get("/animator/assets/:id", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    const metaPath = resolveWithinWorkspace(`originals/${req.params.id}/metadata.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ error: "Asset not found" });
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (meta.userPhone && meta.userPhone !== userPhone) return res.status(403).json({ error: "Forbidden" });
    res.json(meta);
  } catch (e: any) {
    handleReadError(res, e);
  }
});

animatorRouter.get("/animator/assets/:id/inspect", async (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    const metaPath = resolveWithinWorkspace(`originals/${req.params.id}/metadata.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ error: "Asset not found" });
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (meta.userPhone && meta.userPhone !== userPhone) return res.status(403).json({ error: "Forbidden" });
    
    const safeOriginal = meta.originalFilename.replace(/[^a-zA-Z0-9_\-\.]/g, "");
    const absPath = resolveWithinWorkspace(`originals/${req.params.id}/${safeOriginal}`);
    
    const freshMeta = await inspectAsset(absPath, meta.originalFilename);
    freshMeta.id = req.params.id;
    freshMeta.userPhone = meta.userPhone;
    res.json(freshMeta);
  } catch (e: any) {
    handleReadError(res, e);
  }
});

animatorRouter.post("/animator/jobs", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    // optimize preset is now supported.
    
    const rawSpec = {
      ...req.body,
      id: "00000000-0000-0000-0000-000000000000",
      userPhone,
      createdAt: new Date().toISOString()
    };
    
    JobSpecSchema.parse(rawSpec);
    
    // Check if asset belongs to user
    const metaPath = resolveWithinWorkspace(`originals/${req.body.assetId}/metadata.json`);
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (meta.userPhone && meta.userPhone !== userPhone) return res.status(403).json({ error: "Forbidden" });
    }
    
    const job = enqueue({
      userPhone,
      assetId: req.body.assetId,
      type: req.body.type,
      preset: req.body.preset,
      params: req.body.params || {}
    });
    
    res.json({ jobId: job.id });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

animatorRouter.get("/animator/jobs/:id", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    const dirs = ["pending", "running", "done", "failed"];
    for (const dir of dirs) {
      try {
        const p = resolveWithinWorkspace(`jobs/${dir}/${req.params.id}.json`);
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, "utf8");
          const job = JSON.parse(content);
          if (job.userPhone && job.userPhone !== userPhone) return res.status(403).json({ error: "Forbidden" });
          return res.json(job);
        }
      } catch (err) {}
    }
    res.status(404).json({ error: "Job not found" });
  } catch (e: any) {
    handleReadError(res, e);
  }
});

animatorRouter.get("/animator/jobs", (req: any, res) => {
  res.json([]);
});

animatorRouter.get("/animator/jobs/:id/manifest", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    // verify job ownership first
    let job: any;
    const dirs = ["pending", "running", "done", "failed"];
    for (const dir of dirs) {
      try {
        const p = resolveWithinWorkspace(`jobs/${dir}/${req.params.id}.json`);
        if (fs.existsSync(p)) {
          job = JSON.parse(fs.readFileSync(p, "utf8"));
          break;
        }
      } catch (err) {}
    }
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.userPhone && job.userPhone !== userPhone) return res.status(403).json({ error: "Forbidden" });
    
    const manifest = readManifest(req.params.id);
    res.json(manifest);
  } catch (e: any) {
    res.status(404).json({ error: "Manifest not found" });
  }
});

animatorRouter.get("/animator/outputs/:assetId", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    const metaPath = resolveWithinWorkspace(`originals/${req.params.assetId}/metadata.json`);
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (meta.userPhone && meta.userPhone !== userPhone) return res.status(403).json({ error: "Forbidden" });
    }
    
    const outDir = resolveWithinWorkspace(`outputs/${req.params.assetId}`);
    if (!fs.existsSync(outDir)) return res.json([]);
    const files = fs.readdirSync(outDir);
    res.json(files.map(f => ({
      path: `outputs/${req.params.assetId}/${f}`,
      url: `/animator-files/outputs/${req.params.assetId}/${f}`
    })));
  } catch (e: any) {
    handleReadError(res, e);
  }
});

animatorRouter.post("/animator/projects", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    const project = createProject(userPhone, req.body);
    res.json(project);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

animatorRouter.get("/animator/projects", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    const projects = listProjects(userPhone);
    res.json(projects);
  } catch (e: any) {
    handleReadError(res, e);
  }
});

animatorRouter.get("/animator/projects/:id", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    const project = getProject(req.params.id);
    if (project.userPhone !== userPhone) return res.status(403).json({ error: "Forbidden" });
    res.json(project);
  } catch (e: any) {
    res.status(404).json({ error: "Project not found" });
  }
});

animatorRouter.put("/animator/projects/:id", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    const project = updateProject(req.params.id, userPhone, req.body);
    res.json(project);
  } catch (e: any) {
    if (e.message === "Forbidden") return res.status(403).json({ error: "Forbidden" });
    res.status(400).json({ error: e.message });
  }
});

animatorRouter.delete("/animator/projects/:id", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    deleteProject(req.params.id, userPhone);
    res.json({ success: true });
  } catch (e: any) {
    if (e.message === "Forbidden") return res.status(403).json({ error: "Forbidden" });
    res.status(400).json({ error: e.message });
  }
});

import multer from "multer";
import path from "path";

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit for webm
});

animatorRouter.post("/animator/recordings", upload.single("video"), async (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    if (!req.file) return res.status(400).json({ error: "No video file provided" });
    const recording = saveRecording({ ownerId: userPhone, buffer: req.file.buffer, claimedMime: req.file.mimetype });
    res.status(201).json({ recordingId: recording.recordingId, url: recording.url, mimeType: recording.mimeType });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

animatorRouter.post("/animator/screenshots", upload.single("image"), async (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    if (!req.file) return res.status(400).json({ error: "No image file provided" });
    
    const outDir = resolveWithinWorkspace("screenshots");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    
    const filename = `screenshot_${Date.now()}_${userPhone.replace(/[^a-zA-Z0-9]/g, "")}.png`;
    const absPath = path.join(outDir, filename);
    
    fs.writeFileSync(absPath, req.file.buffer);
    
    let url = `/animator-files/screenshots/${filename}`;
    try {
      const base64Str = req.file.buffer.toString("base64");
      const bucketUrl = await uploadBase64Binary(base64Str, "image/png");
      if (bucketUrl) url = bucketUrl;
    } catch (uploadErr) {
      console.warn("Storage mirror failed, falling back to local URL", uploadErr);
    }
    
    res.json({ url });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

animatorRouter.get("/scenes/environments", (req: any, res) => {
  try {
    if (!req.user || !req.user.phone) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const presets = loadEnvironments();
    res.json(presets);
  } catch (e: any) {
    handleReadError(res, e);
  }
});

animatorRouter.get("/scenes/scripts", (req: any, res) => {
  try {
    if (!req.user || !req.user.phone) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const seed = typeof req.query.seed === "string" ? req.query.seed : `${req.user.phone}:${Date.now()}`;
    const requestedLimit = Number.parseInt(String(req.query.limit || "120"), 10);
    const scripts = getVoiceoverScripts(seed, Number.isFinite(requestedLimit) ? requestedLimit : 120);
    res.json(scripts);
  } catch (e: any) {
    handleReadError(res, e);
  }
});

animatorRouter.get("/scenes/director-scripts", (req: any, res) => {
  try {
    if (!req.user || !req.user.phone) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const seed = typeof req.query.seed === "string" ? req.query.seed : `${req.user.phone}:${Date.now()}`;
    const requestedLimit = req.query.limit === undefined ? undefined : Number.parseInt(String(req.query.limit), 10);
    res.json(getDirectorScripts(seed, requestedLimit === undefined || Number.isFinite(requestedLimit) ? requestedLimit : undefined));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

animatorRouter.get("/scenes/clips", (req, res) => {
  const skeleton = req.query.skeleton as string;
  if (skeleton) {
    res.json(CC0_CLIPS.filter(c => c.skeleton === skeleton));
  } else {
    res.json(CC0_CLIPS);
  }
});

animatorRouter.post("/scenes", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    const scene = createScene(userPhone, req.body);
    res.json(scene);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

animatorRouter.get("/scenes/templates", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    if (!userPhone) return res.status(401).json({ error: "Unauthorized" });
    
    // Serve JSON templates from server/animator/templates directory if it exists
    const templatesDir = require("path").join(process.cwd(), "server", "animator", "templates");
    const fs = require("fs");
    if (!fs.existsSync(templatesDir)) {
      return res.json([]);
    }
    const files = fs.readdirSync(templatesDir).filter((f: string) => f.endsWith(".json"));
    const templates = files.map((f: string) => {
      try {
        return JSON.parse(fs.readFileSync(require("path").join(templatesDir, f), "utf8"));
      } catch {
        return null;
      }
    }).filter(Boolean);
    
    res.json(templates);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

animatorRouter.get("/scenes/:id", (req: any, res) => {
  try {
    const userPhone = req.user!.phone;
    const scene = getScene(req.params.id);
    if (scene.userPhone && scene.userPhone !== userPhone) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json(scene);
  } catch (e: any) {
    res.status(404).json({ error: "Scene not found" });
  }
});

animatorRouter.post("/scenes/voiceover", async (req: any, res) => {
  let creditReservationId: string | null = null;
  try {
    const userPhone = req.user!.phone;
    if (!userPhone) return res.status(401).json({ error: "Unauthorized" });
    
    const { recordingId, scriptId, text, voiceId } = req.body;
    if (!recordingId) return res.status(400).json({ error: "recordingId is required" });
    if (!getOwnedRecording(String(recordingId), userPhone)) return res.status(404).json({ error: "Recording not found" });
    
    let scriptText = text;
    if (scriptId) {
      const scripts = loadScripts();
      const preset = scripts.find(s => s.id === scriptId);
      if (preset) scriptText = preset.text;
    }
    if (!scriptText || !String(scriptText).trim()) {
      return res.status(400).json({ error: "Text or valid scriptId required" });
    }

    const estSeconds = estimateSpeechSeconds(scriptText);
    if (estSeconds > 30) {
      return res.status(400).json({ error: "Script exceeds 30-second cap" });
    }

    const isAdmin = await isUserAdmin(userPhone);
    const VOICEOVER_COST = CREDIT_PRICES.AI_VOICE_30_SECONDS;
    const MAX_DAILY_VIDEOS = 5; 

    if (!isAdmin) {
      const dailyCount = await getDailyVideoCount(userPhone);
      if (dailyCount >= MAX_DAILY_VIDEOS) {
        return res.status(429).json({ error: `Daily limit reached (${MAX_DAILY_VIDEOS}/day)` });
      }
      const balance = await getCreditBalance(userPhone);
      if (balance < VOICEOVER_COST) {
        return res.status(402).json({ error: `Insufficient credits. Need ${VOICEOVER_COST}` });
      }
      creditReservationId = await reserveCredits(userPhone, VOICEOVER_COST, "ai_voice_generation");
      if (!creditReservationId) {
        return res.status(402).json({ error: `Insufficient credits. Need ${VOICEOVER_COST}` });
      }
    }

    // Dummy 1x1 image for HeyGen talking photo
    const dummyImageBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    
    let handle: string;
    try {
      handle = await startTalkingVideo({
        imageBuffer: dummyImageBuffer,
        mimeType: "image/png",
        script: String(scriptText),
        voiceId: voiceId || undefined,
      });
    } catch (genErr: any) {
      if (creditReservationId) {
        await refundReservedCredits(creditReservationId);
        creditReservationId = null;
      }
      return res.status(502).json({ error: genErr.message || "Failed to start Voiceover generation" });
    }

    const operationName = encodeAnimatorOperationMetadata({ providerOperationName: handle, recordingId: String(recordingId) });

    let jobId: number;
    try {
      jobId = await createJob({
        user_phone: userPhone,
        creation_id: null,
        kind: "video",
        credits_reserved: isAdmin ? 0 : VOICEOVER_COST,
        credit_debit_correlation_id: creditReservationId,
        operation_name: operationName,
      });
      creditReservationId = null; // durable job now owns any refund decision
    } catch (jobError) {
      if (creditReservationId) {
        await refundReservedCredits(creditReservationId);
        creditReservationId = null;
      }
      throw jobError;
    }

    res.status(202).json({ success: true, jobId, status: "queued" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

animatorRouter.get("/animator/voiceover-jobs/:id", async (req: any, res) => {
  const userPhone = req.user!.phone;
  const jobId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: "Invalid job ID" });
  const { getJob } = await import("../../db.ts");
  const job = await getJob(jobId, userPhone);
  if (!job || !decodeAnimatorOperationMetadata(job.operation_name)) return res.status(404).json({ error: "Voiceover job not found" });
  const result = getOwnedVoicedResult(jobId, userPhone);
  const progress = job.status === "done" ? 100 : job.status === "failed" ? 100 : job.status === "running" ? 60 : 20;
  res.json({ jobId, status: job.status, progress, error: job.error || null, resultUrl: result?.resultUrl || null, mimeType: result?.mimeType || null });
});

// ──────────────────────────────────────────────────────────────────
// Animator Builder‑out Phase‑0 stubs (job types pending implementation)
// ──────────────────────────────────────────────────────────────────

animatorRouter.post("/rig", (req: any, res) => {
  res.status(501).json({ code: "NOT_IMPLEMENTED", service: "rig", message: "Auto‑rig service not yet available" });
});

animatorRouter.get("/rig/:id", (req: any, res) => {
  res.status(501).json({ code: "NOT_IMPLEMENTED", service: "rig", message: "Auto‑rig service not yet available" });
});

animatorRouter.post("/retarget", (req: any, res) => {
  res.status(501).json({ code: "NOT_IMPLEMENTED", service: "retarget", message: "Clip retargeting not yet available" });
});

animatorRouter.post("/repurpose", (req: any, res) => {
  res.status(501).json({ code: "NOT_IMPLEMENTED", service: "repurpose", message: "Character repurposing not yet available" });
});

animatorRouter.post("/animator/lipsync", (req: any, res) => {
  handleLipsyncPost(req, res).catch((e: any) => res.status(500).json({ error: e.message }));
});
animatorRouter.post("/lipsync", (req: any, res) => {
  handleLipsyncPost(req, res).catch((e: any) => res.status(500).json({ error: e.message }));
});

animatorRouter.get("/animator/lipsync/:id", (req: any, res) => {
  handleLipsyncGet(req, res).catch((e: any) => res.status(500).json({ error: e.message }));
});
animatorRouter.get("/lipsync/:id", (req: any, res) => {
  handleLipsyncGet(req, res).catch((e: any) => res.status(500).json({ error: e.message }));
});

animatorRouter.post("/animator/speech-preview", async (req: any, res) => {
  const parsed = SpeechPreviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid speech preview" });

  const userPhone = req.user?.phone;
  if (!userPhone) return res.status(401).json({ error: "Unauthorized" });
  const cost = CREDIT_PRICES.AI_VOICE_30_SECONDS;
  let admin = false;
  let creditReservationId: string | null = null;

  try {
    admin = await isUserAdmin(userPhone);
    if (!admin) {
      const balance = await getCreditBalance(userPhone);
      if (balance < cost) return res.status(402).json({ error: `Insufficient credits. Need ${cost}` });
      creditReservationId = await reserveCredits(userPhone, cost, "ai_voice_generation");
      if (!creditReservationId) return res.status(402).json({ error: `Insufficient credits. Need ${cost}` });
    }

    const preview = await createSpeechPreview(parsed.data);
    res.json({ ...preview, creditsCharged: admin ? 0 : cost });
  } catch (error: any) {
    if (creditReservationId) {
      await refundReservedCredits(creditReservationId);
    }
    res.status(502).json({ error: error.message || "Voice preview generation failed" });
  }
});

animatorRouter.post("/reconstruct", (req: any, res) => {
  res.status(501).json({ code: "NOT_IMPLEMENTED", service: "reconstruct", message: "Point‑cloud reconstruction not yet available" });
});

animatorRouter.get("/reconstruct/:id", (req: any, res) => {
  res.status(501).json({ code: "NOT_IMPLEMENTED", service: "reconstruct", message: "Point‑cloud reconstruction not yet available" });
});

animatorRouter.post("/bake", (req: any, res) => {
  res.status(501).json({ code: "NOT_IMPLEMENTED", service: "bake", message: "Animation bake not yet available" });
});

animatorRouter.get("/bake/:id", (req: any, res) => {
  res.status(501).json({ code: "NOT_IMPLEMENTED", service: "bake", message: "Animation bake not yet available" });
});

animatorRouter.get("/rig-profiles", (req: any, res) => {
  res.json([]); // Phase‑0 stub: no profiles yet
});
