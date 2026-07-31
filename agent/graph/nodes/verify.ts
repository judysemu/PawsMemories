/**
 * Verify Node — Gemini Vision
 * ============================
 * Compares viewport before/after code execution to detect drift.
 * This is THE critical piece — without verification, errors compound
 * and you get geometry soup after a few steps.
 */

import type { BuildState, VerificationResult } from "./types";
import { executeBlenderTool } from "../../tools/blender_mcp";
import { generateGeminiText, type GeminiInteractionInput } from "../../gemini";

const VERIFY_SYSTEM_PROMPT = `You are a 3D quality assurance inspector for Blender scenes. Your job is to compare viewport screenshots before and after a code execution step to detect problems.

You will receive:
1. What the step was supposed to do (the intent)
2. Whether the code executed successfully (stdout/stderr)
3. A viewport screenshot of the current state
4. Optionally, a previous viewport screenshot for comparison

Evaluate:
- Did the step accomplish its intent?
- Are there visible geometry issues (clipping, inverted normals, missing parts)?
- For rigging: are bones positioned correctly relative to the mesh?
- For animation: do the poses look anatomically correct?
- Is there any "drift" — unintended changes to the scene?

Return ONLY a JSON object:
{
  "success": true/false,
  "issuesFound": ["list of specific issues"],
  "driftSeverity": "none" | "minor" | "major" | "critical",
  "recommendation": "proceed" | "undo_and_retry" | "undo_and_replan" | "abort",
  "details": "brief explanation"
}

SEVERITY GUIDE:
- none: Step executed perfectly, no issues
- minor: Small cosmetic issues that won't affect the final result (e.g., slightly off bone position)
- major: Significant problems that need fixing but aren't catastrophic (e.g., wrong bone hierarchy)
- critical: Scene is broken, needs immediate rollback (e.g., geometry soup, crash artifacts)

Be conservative — it's better to catch a false positive than let drift compound.`;

export async function verifyNode(state: BuildState): Promise<Partial<BuildState>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Without vision, assume success if code execution succeeded
    return handleNoVision(state);
  }

  // Get the latest execution result
  const lastResult = state.executionHistory[state.executionHistory.length - 1];
  if (!lastResult) {
    return { statusMessage: "No execution result to verify" };
  }

  // If code execution itself failed, no need for vision check
  if (!lastResult.executeResult.success) {
    const verification: VerificationResult = {
      success: false,
      issuesFound: [`Code execution error: ${lastResult.executeResult.error?.slice(0, 300)}`],
      driftSeverity: "major",
      recommendation: "undo_and_retry",
      details: "Code execution failed. Will retry with adapted approach.",
    };

    return applyVerification(state, verification);
  }

  // Auto-pass steps that use deterministic, pre-tested code templates.
  // These steps run hardcoded Python from act.ts's deterministicCodeForAction()
  // — vision verification adds no value and frequently produces false-positive
  // "critical drift" reports (e.g., adding an armature changes the visual
  // appearance dramatically, but that's the intended effect, not drift).
  if (isDeterministicStep(lastResult.description)) {
    const verification: VerificationResult = {
      success: true,
      issuesFound: [],
      driftSeverity: "none",
      recommendation: "proceed",
      details: `Deterministic step passed (code execution succeeded): ${lastResult.description}`,
    };
    return applyVerification(state, verification);
  }

  // Take a viewport screenshot for verification
  let viewportImage: string | null = null;
  try {
    const vp = await executeBlenderTool("get_viewport", { azimuth: 45, elevation: 30 });
    viewportImage = vp.data?.image_base64 || null;
  } catch {
    // Continue without viewport
  }

  // Build verification prompt
  const stepDescription = lastResult.description;
  const stdout = lastResult.executeResult.stdout.slice(-500);
  const stderr = lastResult.executeResult.stderr.slice(-300);

  const promptText = [
    `STEP INTENT: ${stepDescription}`,
    "",
    `CODE EXECUTION RESULT:`,
    `- Success: ${lastResult.executeResult.success}`,
    stdout ? `- Stdout (last 500 chars): ${stdout}` : "",
    stderr ? `- Stderr (last 300 chars): ${stderr}` : "",
    "",
    "Analyze the viewport screenshot and determine if this step succeeded correctly.",
    "",
    "Return ONLY the JSON verification object.",
  ].filter(Boolean).join("\n");

  const input: GeminiInteractionInput = [{ type: "text", text: promptText }];
  const fallbackParts: any[] = [{ text: promptText }];

  // Add current viewport
  if (viewportImage) {
    input.push({
      type: "image",
      data: viewportImage,
      mime_type: "image/png",
    });
    fallbackParts.push({
      inlineData: {
        data: viewportImage,
        mimeType: "image/png",
      },
    });
  }

  try {
    const responseText = await generateGeminiText({
      apiKey,
      model: "gemini-3.1-flash-lite",
      input,
      fallbackContents: [{ role: "user", parts: fallbackParts }],
      systemInstruction: VERIFY_SYSTEM_PROMPT,
      temperature: 0.1,
    });

    let verification: VerificationResult;

    try {
      const jsonMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ||
        responseText.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : responseText;
      verification = JSON.parse(jsonStr);
    } catch {
      // If we can't parse the response, assume success if code executed ok
      verification = {
        success: lastResult.executeResult.success,
        issuesFound: [],
        driftSeverity: "none",
        recommendation: "proceed",
        details: "Verification parse failed, assuming success based on execution result.",
      };
    }

    return applyVerification(state, normalizeVerification(state, verification), viewportImage);
  } catch (err: any) {
    console.warn("[Verify] Gemini verification failed:", err.message);
    return handleNoVision(state);
  }
}

/**
 * Check if a step description matches one of the deterministic code templates
 * in act.ts's deterministicCodeForAction(). These steps use hardcoded, pre-tested
 * Python scripts and should not be sent to Gemini Vision for verification.
 */
function isDeterministicStep(description: string): boolean {
  const desc = description.toLowerCase();

  // "Verify mesh import and inspect geometry"
  if (desc.includes("verify") && desc.includes("mesh") && desc.includes("import")) return true;

  // "Create dog armature with proper bone hierarchy"
  if (desc.includes("create") && desc.includes("armature")) return true;

  // "Parent mesh to armature with automatic weights"
  if (desc.includes("parent mesh") || desc.includes("automatic weights")) return true;

  // "Create eating/drinking/running/playing/sleeping/photo animation"
  if (/create\s+(eating|drinking|running|playing|sleeping|photo)\s+animation/i.test(description)) return true;

  // "Setup orthographic camera and 3-point lighting"
  if (desc.includes("camera") && desc.includes("lighting")) return true;

  // "Render sprite sheet (6 animations × max frames)"
  if (desc.includes("render sprite sheet")) return true;

  // "Save checkpoint" — handled directly by act.ts, but guard anyway
  if (desc.includes("checkpoint")) return true;

  return false;
}

function handleNoVision(state: BuildState): Partial<BuildState> {
  const lastResult = state.executionHistory[state.executionHistory.length - 1];
  const success = lastResult?.executeResult.success ?? false;

  const verification: VerificationResult = {
    success,
    issuesFound: success ? [] : [lastResult?.executeResult.error || "Unknown error"],
    driftSeverity: success ? "none" : "major",
    recommendation: success ? "proceed" : "undo_and_retry",
    details: "No vision verification available. Decision based on execution result only.",
  };

  return applyVerification(state, normalizeVerification(state, verification));
}

function normalizeVerification(state: BuildState, verification: VerificationResult): VerificationResult {
  // Rule 0: driftSeverity "none" or "minor" MUST map to "proceed".
  // Gemini sometimes returns contradictory responses like
  // {driftSeverity: "none", recommendation: "undo_and_replan"} which causes
  // infinite loops. If the model says drift is none/minor, trust that assessment
  // and force the recommendation to match.
  if (
    verification.driftSeverity === "none" ||
    verification.driftSeverity === "minor"
  ) {
    return {
      ...verification,
      success: true,
      recommendation: "proceed",
    };
  }

  const lastResult = state.executionHistory[state.executionHistory.length - 1];
  const description = lastResult?.description.toLowerCase() || "";
  const stdout = lastResult?.executeResult.stdout || "";

  if (!lastResult?.executeResult.success) return verification;

  const warningOnly =
    /bone heat weighting|bone .* not found|no animatable bones/i.test(stdout) &&
    !/traceback|runtimeerror|exception/i.test(stdout);

  const coreStep =
    (description.includes("create") && description.includes("animation")) ||
    (description.includes("create") && description.includes("armature")) ||
    description.includes("parent mesh");

  if (warningOnly && coreStep) {
    return {
      success: true,
      issuesFound: verification.issuesFound.filter((issue) => !/bone heat|not found/i.test(issue)),
      driftSeverity: "minor",
      recommendation: "proceed",
      details: `Proceeding with usable ${lastResult.description}; Blender emitted non-fatal warnings.`,
    };
  }

  return verification;
}

function applyVerification(
  state: BuildState,
  verification: VerificationResult,
  viewportImage?: string | null
): Partial<BuildState> {
  // Update the last execution history entry with the verification
  const updatedHistory = [...state.executionHistory];
  if (updatedHistory.length > 0) {
    updatedHistory[updatedHistory.length - 1] = {
      ...updatedHistory[updatedHistory.length - 1],
      verification,
    };
  }

  // If verified successful, mark the step as completed
  const updatedPlan = [...state.buildPlan];
  if (verification.recommendation === "proceed" && state.currentStep < updatedPlan.length) {
    updatedPlan[state.currentStep] = {
      ...updatedPlan[state.currentStep],
      completed: true,
    };
  }

  // If we need to retry, increment the retry count
  if (
    verification.recommendation === "undo_and_retry" ||
    verification.recommendation === "undo_and_replan"
  ) {
    if (state.currentStep < updatedPlan.length) {
      updatedPlan[state.currentStep] = {
        ...updatedPlan[state.currentStep],
        retryCount: updatedPlan[state.currentStep].retryCount + 1,
      };
    }
  }

  return {
    executionHistory: updatedHistory,
    buildPlan: updatedPlan,
    viewportImage: viewportImage || state.viewportImage,
    statusMessage: verification.success
      ? `✅ Verified: ${verification.details}`
      : `⚠️ Issues: ${verification.issuesFound.join(", ")}`,
  };
}
