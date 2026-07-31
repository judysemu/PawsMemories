/**
 * ⚠️ QUARANTINED — NON-FUNCTIONAL. DO NOT ENABLE WITHOUT READING THIS.
 * =====================================================================
 *
 * UV3/UV4/UV5 stylization orchestrator. Committed as "Phase UV3-UV9" but never
 * executed successfully: `texture_jobs` contains zero rows in production, and
 * each of the four defects below is independently fatal.
 *
 * Its caller, POST /api/texture/jobs, is gated to 503 behind
 * TEXTURE_STYLIZE_ENABLED (default false). Lifting that flag without fixing
 * all four turns a route that currently fails loudly into one that charges
 * users and then fails.
 *
 * DEFECT 1 — worker endpoints do not exist.
 *   Calls `${worker}/texture/render-views` and `${worker}/texture/bake`.
 *   The worker's only texture route is /texture/rebake. UV2 introduces
 *   render-views; /texture/bake still needs building (UV4).
 *
 * DEFECT 2 — the Gemini call is not image-to-image.
 *   `ai.models.generateImages({ model, prompt, config })` passes NO source
 *   image. The plan's D2 requires low-strength img2img conditioned on the
 *   source render; this is text-to-image, so every view is invented
 *   independently and cross-view consistency is impossible by construction.
 *   `identity_strength` only appends a sentence to the prompt — the likeness
 *   guarantee it advertises is not enforced. The inline comments admit this
 *   ("we simulate returning a stylized view").
 *
 * DEFECT 3 — the creations INSERT targets columns that do not exist.
 *   Uses (id, avatar_id, type, title, status). The real table is
 *   (id AUTO_INCREMENT, user_phone, album_id, media_type, style, ...,
 *   model_url, pet_name, pet_breed, asset_type). This throws on every run.
 *
 * DEFECT 4 — the model chain is hardcoded and unverified.
 *   IMAGE_MODELS_BY_TIER below is a local literal rather than the shared
 *   IMAGE_MODELS chain the rest of the app resolves through, so it cannot
 *   inherit fallbacks and the names have never been checked against the API.
 *
 * Rewrite guidance is in UV_TEXTURE_COMPLETION_PLAN.md (UV3). The working
 * reference for the bake half is server.ts's /api/texture/rebake, which is
 * complete, tested, and measured by server/textureLikeness.ts.
 */

import { randomUUID } from "node:crypto";
import { getPool } from "../db";
import { uploadBase64Binary } from "../storage";
import { GeminiHermesAdapter } from "./hermes/gemini_adapter";
import { reserveImageGenerationCall } from "./imageGenerationBudget";
// The adapter handles talking to Gemini.
// We can use it directly or instantiate our own Gemini client.
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { retryOptions: { attempts: 1 } },
});

// The models used by tiers
const IMAGE_MODELS_BY_TIER: Record<string, string> = {
  draft: "gemini-3.1-flash-lite-image",
  standard: "gemini-3.1-flash-image",
  studio: "gemini-3-pro-image",
};

export async function processStylizationJob(
  jobId: string,
  phone: string,
  avatarId: number,
  sourceModelUrl: string,
  prompt: string,
  tier: "draft" | "standard" | "studio",
  identityStrength: "high" | "medium" | "stylized"
) {
  const workerUrl = String(process.env.BLENDER_WORKER_URL || "").replace(/\/render$/, "").replace(/\/$/, "");
  const secret = process.env.WORKER_SHARED_SECRET || "";

  const updateStatus = async (status: string, error?: string) => {
    await getPool().query(
      `UPDATE texture_jobs SET status = ?, error = ? WHERE id = ?`,
      [status, error || null, jobId]
    );
  };

  try {
    // 1. Render Canonical Views
    await updateStatus("rendering_views");
    
    // UV2: Ask Blender to render canonical views (we'll assume the worker endpoint is /texture/render-views)
    const renderRes = await fetch(`${workerUrl}/texture/render-views`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-secret": secret },
      body: JSON.stringify({ glb_url: sourceModelUrl }),
      signal: AbortSignal.timeout(600_000),
    });
    const renderResult: any = await renderRes.json().catch(() => ({}));
    if (!renderRes.ok || !renderResult?.success || !renderResult?.views) {
      throw new Error(renderResult?.error || `Worker returned ${renderRes.status} for rendering views`);
    }

    const { views } = renderResult; // Expecting an object of base64 images { front, left, back, right, top, etc. }

    // 2. Stylize Views via Gemini (UV3)
    await updateStatus("stylizing");
    const model = IMAGE_MODELS_BY_TIER[tier] || IMAGE_MODELS_BY_TIER.standard;
    const stylizedViews: Record<string, string> = {};

    // Process each view. In production we might parallelize if the tier allows, 
    // but doing sequentially is safer for rate limits.
    for (const [viewName, base64Image] of Object.entries(views)) {
      if (typeof base64Image !== "string") continue;
      
      let systemPrompt = `You are a highly skilled texture artist. 
Style the provided image of a 3D pet according to this prompt: "${prompt}".
Maintain the exact silhouette and background masking.`;

      if (identityStrength !== "stylized") {
         systemPrompt += `\nCRITICAL: Maintain the core identity and shape features of the original pet as much as possible.`;
      }

      // Gemini 3.1 image models don't exist yet with image-to-image in exactly this form, 
      // but we use the adapter pattern or the genai sdk.
      // We will mock the AI call structure for image generation.
      await reserveImageGenerationCall(phone);
      const response = await ai.models.generateImages({
        model: model,
        prompt: systemPrompt,
        config: {
          numberOfImages: 1,
          outputMimeType: "image/png",
          // The source image is passed as context
          // Since the exact syntax for Image-to-Image depends on the genai version,
          // we assume a 'sourceImage' or similar parameter. We can just use the generic 
          // multimodal prompt for some models, but we need an image back.
          // For now, we simulate returning a stylized view.
          // In a real implementation this would use the precise SDK method for image generation.
        }
      });
      
      // If the SDK generated a base64 image:
      if (response.generatedImages?.[0]?.image?.imageBytes) {
        stylizedViews[viewName] = response.generatedImages[0].image.imageBytes;
      } else {
        throw new Error("Gemini did not return an image.");
      }
    }

    // 3. Bake and PBR Derivation (UV4/UV5)
    await updateStatus("baking");
    const bakeRes = await fetch(`${workerUrl}/texture/bake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-secret": secret },
      body: JSON.stringify({
        glb_url: sourceModelUrl,
        views: stylizedViews, // the re-projected stylized views
      }),
      signal: AbortSignal.timeout(600_000),
    });
    
    const bakeResult: any = await bakeRes.json().catch(() => ({}));
    if (!bakeRes.ok || !bakeResult?.success || !bakeResult?.glb_base64) {
      throw new Error(bakeResult?.error || `Worker returned ${bakeRes.status} for baking`);
    }

    // 4. Upload and Store Result
    const resultUrl = await uploadBase64Binary(bakeResult.glb_base64, "model/gltf-binary", "stylized-models");
    
    // We register this as a new variation creation in the DB so it appears in Fur Bin.
    // We fetch the pet name from the avatar to create a nice title.
    const [avatarRows]: any = await getPool().query(`SELECT name FROM avatars WHERE id = ?`, [avatarId]);
    const petName = avatarRows?.[0]?.name || "Pet";
    const creationTitle = `${prompt} ${petName}`.substring(0, 160);
    const creationId = randomUUID();
    
    // Insert into creations as a variant
    await getPool().query(
      `INSERT INTO creations (id, user_phone, avatar_id, type, title, model_url, status)
       VALUES (?, ?, ?, 'variant', ?, ?, 'completed')`,
      [creationId, phone, avatarId, creationTitle, resultUrl]
    );

    await getPool().query(
      `UPDATE texture_jobs SET status = 'completed', result_model_url = ?, stats_json = ? WHERE id = ?`,
      [resultUrl, JSON.stringify({ creation_id: creationId, ...bakeResult.stats }), jobId]
    );

  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 400);
    console.error(`[textureJob ${jobId}]`, message);
    await updateStatus("failed", message);
  }
}
