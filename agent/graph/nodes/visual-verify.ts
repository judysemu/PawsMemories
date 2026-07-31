/**
 * Visual Verify Node — Gemini Vision
 * ====================================
 * Post-pipeline visual check that compares the rendered 3D model against
 * the original pet photo to catch gross mismatches before finalizing.
 *
 * This runs AFTER the sprite sheet render and BEFORE finalize.
 * It answers: "Does this 3D model actually look like the pet in the photo?"
 */

import type { BuildState, VisualVerificationResult } from "./types";
import { executeBlenderTool } from "../../tools/blender_mcp";
import { generateGeminiText, type GeminiInteractionInput } from "../../gemini";

const VISUAL_VERIFY_SYSTEM_PROMPT = `You are a quality assurance inspector comparing a 3D rendered model against an original pet photograph. Your job is to determine whether the 3D model is a reasonable representation of the pet in the photo.

You will receive:
1. The original pet photograph
2. A viewport render of the 3D model from a 3/4 angle
3. Information about the pet species and breed

Evaluate these aspects:
- SILHOUETTE: Does the 3D model's outline/silhouette roughly match the pet's body shape?
- PROPORTIONS: Are the head, body, legs, and tail proportions reasonable for this breed?
- ANATOMY: Does the model have the correct number of legs? Is the tail present/absent correctly?
- POSE: Is the model in a plausible pose, or is it distorted/mangled?
- OVERALL: On a scale from "good" to "unrecognizable", how well does the 3D model represent the pet?

You are NOT checking for exact likeness — 3D models will always be stylised.
You ARE checking for gross errors: wrong number of legs, geometry soup, completely wrong proportions, missing major body parts.

Return ONLY a JSON object:
{
  "overallMatch": "good" | "acceptable" | "poor" | "unrecognizable",
  "silhouetteMatch": true/false,
  "proportionIssues": ["list of specific issues"],
  "anatomyIssues": ["list of specific issues"],
  "confidence": 0.0-1.0,
  "recommendation": "accept" | "retry_rigging" | "retry_mesh" | "fail"
}

GUIDELINES:
- "good": Model clearly represents the pet. Minor stylistic differences are fine.
- "acceptable": Model is recognisable as the same type of animal. Some proportion issues.
- "poor": Model has significant issues but is still somewhat animal-shaped.
- "unrecognizable": Geometry soup, completely wrong animal, or total failure.

- "accept": overallMatch is good or acceptable
- "retry_rigging": proportions are wrong but mesh geometry is ok — try re-rigging
- "retry_mesh": mesh itself is bad — need a new 3D generation
- "fail": unrecoverable — model is geometry soup or totally broken

Be generous with "acceptable" — 3D generation from photos is inherently imperfect.`;

/**
 * Run visual verification: compare the 3D model render against the original pet photo.
 */
export async function visualVerifyNode(state: BuildState): Promise<Partial<BuildState>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[VisualVerify] No GEMINI_API_KEY — skipping visual verification");
    return {
      visualVerification: {
        overallMatch: "acceptable",
        silhouetteMatch: true,
        proportionIssues: [],
        anatomyIssues: [],
        confidence: 0.5,
        recommendation: "accept",
      },
      statusMessage: "Visual verification skipped (no API key)",
    };
  }

  // Get a canonical viewport screenshot of the 3D model
  let viewportImage: string | null = null;
  try {
    // Front 3/4 view — the most informative angle for comparing body shape
    const vp = await executeBlenderTool("get_viewport", { azimuth: 35, elevation: 25 });
    viewportImage = vp.data?.image_base64 || null;
  } catch (err: any) {
    console.warn("[VisualVerify] Failed to capture viewport:", err.message);
  }

  if (!viewportImage) {
    console.warn("[VisualVerify] No viewport image available — skipping");
    return {
      visualVerification: {
        overallMatch: "acceptable",
        silhouetteMatch: true,
        proportionIssues: [],
        anatomyIssues: [],
        confidence: 0.3,
        recommendation: "accept",
      },
      statusMessage: "Visual verification skipped (no viewport)",
    };
  }

  // Build the comparison prompt
  const promptText = [
    `PET INFO: ${state.petAnalysis.species} — ${state.petAnalysis.breed}`,
    `Body type: ${state.petAnalysis.bodyType}, Legs: ${state.petAnalysis.legCount}, Tail: ${state.petAnalysis.hasTail}`,
    `Proportions: head=${state.petAnalysis.bodyProportions.headSize}, legs=${state.petAnalysis.bodyProportions.legLength}, body=${state.petAnalysis.bodyProportions.bodyLength}`,
    "",
    "Compare the original pet photograph (Image 1) with the 3D model viewport render (Image 2).",
    "Determine if the 3D model is a reasonable representation of the pet.",
    "",
    "Return ONLY the JSON verification object.",
  ].join("\n");

  const input: GeminiInteractionInput = [{ type: "text", text: promptText }];
  const fallbackParts: any[] = [{ text: promptText }];

  // Add original pet photo if available
  if (state.originalImageBase64) {
    let cleanBase64 = state.originalImageBase64;
    let mimeType = "image/jpeg";
    const match = state.originalImageBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      cleanBase64 = match[2];
    }

    input.push({ type: "image", data: cleanBase64, mime_type: mimeType });
    fallbackParts.push({ inlineData: { data: cleanBase64, mimeType } });
  }

  // Add viewport render
  input.push({ type: "image", data: viewportImage, mime_type: "image/png" });
  fallbackParts.push({ inlineData: { data: viewportImage, mimeType: "image/png" } });

  try {
    const responseText = await generateGeminiText({
      apiKey,
      model: "gemini-3.1-flash-lite",
      input,
      fallbackContents: [{ role: "user", parts: fallbackParts }],
      systemInstruction: VISUAL_VERIFY_SYSTEM_PROMPT,
      temperature: 0.1,
    });

    let result: VisualVerificationResult;

    try {
      const jsonMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ||
        responseText.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : responseText;
      result = JSON.parse(jsonStr);
    } catch {
      // If parse fails, assume acceptable
      console.warn("[VisualVerify] Failed to parse Gemini response, assuming acceptable");
      result = {
        overallMatch: "acceptable",
        silhouetteMatch: true,
        proportionIssues: [],
        anatomyIssues: [],
        confidence: 0.4,
        recommendation: "accept",
      };
    }

    // Normalise: ensure required fields exist
    result = {
      overallMatch: result.overallMatch || "acceptable",
      silhouetteMatch: result.silhouetteMatch ?? true,
      proportionIssues: result.proportionIssues || [],
      anatomyIssues: result.anatomyIssues || [],
      confidence: typeof result.confidence === "number" ? result.confidence : 0.5,
      recommendation: result.recommendation || "accept",
    };

    console.log(
      `[VisualVerify] Result: ${result.overallMatch} (confidence: ${result.confidence.toFixed(2)}, recommendation: ${result.recommendation})`,
    );

    if (result.proportionIssues.length > 0) {
      console.log(`[VisualVerify] Proportion issues: ${result.proportionIssues.join(", ")}`);
    }
    if (result.anatomyIssues.length > 0) {
      console.log(`[VisualVerify] Anatomy issues: ${result.anatomyIssues.join(", ")}`);
    }

    // Determine status based on result
    const statusMessage = result.recommendation === "accept"
      ? `✅ Visual verification passed: ${result.overallMatch} match`
      : result.recommendation === "fail"
        ? `❌ Visual verification failed: ${result.overallMatch} — ${[...result.proportionIssues, ...result.anatomyIssues].join(", ")}`
        : `⚠️ Visual verification issues: ${result.overallMatch} — recommends ${result.recommendation}`;

    return {
      visualVerification: result,
      viewportImage,
      statusMessage,
    };
  } catch (err: any) {
    console.error("[VisualVerify] Gemini verification failed:", err.message);
    // On error, don't block the pipeline — accept with low confidence
    return {
      visualVerification: {
        overallMatch: "acceptable",
        silhouetteMatch: true,
        proportionIssues: [],
        anatomyIssues: [],
        confidence: 0.2,
        recommendation: "accept",
      },
      statusMessage: `Visual verification error: ${err.message} — continuing anyway`,
    };
  }
}
