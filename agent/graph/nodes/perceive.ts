/**
 * Perceive Node — Gemini Vision
 * ==============================
 * Reads the viewport screenshot + scene graph and produces a structured
 * understanding of the current scene state. Can request viewport rotation
 * if it can't see enough of the model.
 */

import type { BuildState, SceneUnderstanding } from "./types";
import { executeBlenderTool } from "../../tools/blender_mcp";
import { generateGeminiText, type GeminiInteractionInput } from "../../gemini";

const PERCEIVE_SYSTEM_PROMPT = `You are a 3D scene analysis expert. You are examining a Blender viewport screenshot and scene graph data.

Your job is to produce a structured analysis of what you see:
1. What objects are present and their approximate state
2. Whether the geometry looks clean or has issues (inverted normals, clipping, holes)
3. Whether the rigging/bones look correct (if an armature is present)
4. Whether you can see everything you need to, or if a viewport rotation is needed
5. What elements are missing compared to the build plan

Be precise and concise. Focus on actionable observations that will help the planning agent decide what to do next.

IMPORTANT: If key parts of the model are hidden behind other geometry (e.g., the tail is behind the body, or you can't see the underside), suggest a specific viewport angle to inspect that area.`;

export async function perceiveNode(state: BuildState): Promise<Partial<BuildState>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY required for perceive node");

  // Get current viewport and scene state
  let viewportResult = state.viewportImage;
  if (!viewportResult) {
    const vp = await executeBlenderTool("get_viewport", { azimuth: 45, elevation: 30 });
    viewportResult = vp.data?.image_base64 || "";
  }

  let sceneState = state.sceneState;
  if (!sceneState) {
    const scene = await executeBlenderTool("read_scene", {});
    sceneState = scene.data;
  }

  // Build the analysis prompt
  const sceneDescription = sceneState
    ? `Scene contains ${sceneState.object_count} objects:\n` +
      (sceneState.objects || []).map((o: any) =>
        `- ${o.name} (${o.type})${o.vertex_count ? ` [${o.vertex_count} verts]` : ""}${
          o.bones ? ` [${o.bones.length} bones]` : ""
        }`
      ).join("\n")
    : "No scene data available.";

  const currentStepInfo = state.buildPlan && state.currentStep !== undefined
    ? `\nCurrent build step: ${state.currentStep + 1}/${state.buildPlan.length} — "${state.buildPlan[state.currentStep]?.description || "unknown"}"`
    : "";

  const promptText = `Analyze this Blender scene.\n\n${sceneDescription}${currentStepInfo}\n\nReturn a JSON object with this structure:\n{\n  "objectsPresent": [{"name": "...", "type": "...", "status": "ok|issues", "issues": "..."}],\n  "overallQuality": "clean|minor_issues|major_issues|geometry_soup",\n  "missingElements": ["..."],\n  "suggestedViewportChange": {"azimuth": 180, "elevation": 10, "reason": "need to inspect tail"} or null,\n  "readyForNextStep": true/false,\n  "notes": "..."\n}\n\nReturn ONLY the JSON.`;

  const input: GeminiInteractionInput = [{ type: "text", text: promptText }];
  const fallbackParts: any[] = [{ text: promptText }];

  // Add viewport image if available
  if (viewportResult) {
    input.push({
      type: "image",
      data: viewportResult,
      mime_type: "image/png",
    });
    fallbackParts.push({
      inlineData: {
        data: viewportResult,
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
      systemInstruction: PERCEIVE_SYSTEM_PROMPT,
      temperature: 0.1,
    });
    let understanding: SceneUnderstanding;

    try {
      // Extract JSON from response
      const jsonMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ||
        responseText.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : responseText;
      understanding = JSON.parse(jsonStr);
    } catch {
      understanding = {
        objectsPresent: [],
        overallQuality: "minor_issues",
        missingElements: [],
        suggestedViewportChange: null,
        readyForNextStep: true,
        notes: responseText.slice(0, 500),
      };
    }

    // If a viewport change is suggested, execute it and take a new screenshot
    if (understanding.suggestedViewportChange) {
      const { azimuth, elevation } = understanding.suggestedViewportChange;
      await executeBlenderTool("rotate_viewport", { azimuth, elevation });
      const newVp = await executeBlenderTool("get_viewport", { azimuth, elevation });
      viewportResult = newVp.data?.image_base64 || viewportResult;
    }

    return {
      sceneUnderstanding: understanding,
      viewportImage: viewportResult,
      sceneState,
    };
  } catch (err: any) {
    console.error("[Perceive] Gemini analysis failed:", err.message);
    return {
      sceneUnderstanding: {
        objectsPresent: [],
        overallQuality: "minor_issues",
        missingElements: [],
        suggestedViewportChange: null,
        readyForNextStep: true,
        notes: `Perception failed: ${err.message}`,
      },
      viewportImage: viewportResult,
      sceneState,
    };
  }
}
