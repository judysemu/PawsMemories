/**
 * GeminiHermesAdapter — replaces the Hermes/Gemma bridge for all three job types.
 *
 * When HERMES_ENABLED=false (the default), this adapter handles:
 *   - "translate"  — text translation via generateContent
 *   - "knowledge"  — RAG Q&A over provided context chunks
 *   - "looks"      — LookSpecV1 structured planning via constrained JSON output
 *
 * The adapter reuses the app's existing GEMINI_API_KEY and the same
 * generateContent pattern established at server.ts L3067 (classifyGenerate).
 *
 * Control env vars:
 *   GEMINI_API_KEY       — required (already set for image generation)
 *   GEMINI_HERMES_MODEL  — optional override, defaults to "gemini-3.1-flash-lite"
 */

import { GoogleGenAI } from "@google/genai";
import { HermesLookSpecSchema } from "./schemas";
import type { HermesJobType, HermesJsonValue } from "./schemas";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface GeminiAdapter {
  run(
    type: HermesJobType,
    payload: Record<string, HermesJsonValue>,
  ): Promise<HermesJsonValue>;
}

// ---------------------------------------------------------------------------
// LookSpecV1 response schema for Gemini constrained decoding
//
// Mirrors HermesLookSpecSchema exactly. Gemini respects this at the token
// level, so the Zod .strict() validation that follows should always pass.
// ---------------------------------------------------------------------------

const LOOK_SPEC_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    schema_version: {
      type: "STRING",
      enum: ["pawsome.look-spec.v1"],
    },
    request_summary: { type: "STRING" },
    identity_rules: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
    looks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: {
            type: "STRING",
            enum: ["look-1", "look-2", "look-3", "look-4"],
          },
          title: { type: "STRING" },
          outfit: {
            type: "OBJECT",
            properties: {
              style: { type: "STRING" },
              garments: { type: "ARRAY", items: { type: "STRING" } },
              colors: { type: "ARRAY", items: { type: "STRING" } },
              accessories: { type: "ARRAY", items: { type: "STRING" } },
            },
            required: ["style", "garments", "colors", "accessories"],
          },
          pose: {
            type: "OBJECT",
            properties: {
              stance: { type: "STRING" },
              expression: { type: "STRING" },
              gaze: { type: "STRING" },
            },
            required: ["stance", "expression", "gaze"],
          },
          environment: {
            type: "OBJECT",
            properties: {
              setting: { type: "STRING" },
              background: { type: "STRING" },
            },
            required: ["setting", "background"],
          },
          camera: {
            type: "OBJECT",
            properties: {
              shot: {
                type: "STRING",
                enum: ["close-up", "waist-up", "three-quarter", "full-body"],
              },
              angle: { type: "STRING" },
            },
            required: ["shot", "angle"],
          },
          lighting: { type: "STRING" },
          render_prompt: { type: "STRING" },
          negative_prompt: { type: "STRING" },
        },
        required: [
          "id",
          "title",
          "outfit",
          "pose",
          "environment",
          "camera",
          "lighting",
          "render_prompt",
          "negative_prompt",
        ],
      },
    },
  },
  required: ["schema_version", "request_summary", "identity_rules", "looks"],
} as const;

// ---------------------------------------------------------------------------
// System instructions
// ---------------------------------------------------------------------------

const LOOKS_SYSTEM_INSTRUCTION = `\
You are a creative director specializing in AI-generated pet portrait photography. \
Given a pet's identity summary and a style prompt, produce a structured look plan.

Rules:
- schema_version: exactly "pawsome.look-spec.v1"
- request_summary (≤500 chars): one-sentence overview of the look collection
- identity_rules (3–6 items, ≤240 chars each): visual traits that MUST appear in \
every generated image — coat colour, markings, breed features, eye colour, unique \
characteristics. These are invariants the image generator will use to keep the pet \
consistent across all looks.
- Generate exactly as many looks as requested, using IDs look-1, look-2, … in order. \
IDs must be unique.
- Each look must be visually distinct from the others.
- outfit.garments (1–8 items): specific clothing pieces sized and styled for a pet, \
not a human.
- outfit.colors (1–6 items, ≤40 chars each): colour palette for the outfit.
- outfit.accessories (0–6 items): props, jewellery, seasonal items — may be empty.
- camera.shot: one of exactly "close-up", "waist-up", "three-quarter", "full-body".
- render_prompt (250–400 words): a rich, cinematographic image-generation prompt \
combining the pet's exact appearance, outfit, pose, environment, lighting, and \
camera framing. Include the most important identity_rules verbatim so the generator \
cannot miss them.
- negative_prompt (100–200 words): what to avoid — wrong coat colour, missing \
markings, human anatomy, low-quality artefacts.`;

// ---------------------------------------------------------------------------
// GeminiHermesAdapter
// ---------------------------------------------------------------------------

// Model to use for the planning pass, keyed by quality tier.
// The planning pass is text-only; image rendering is handled separately.
const HERMES_PLAN_MODEL_BY_TIER: Record<string, string> = {
  draft:    "gemini-3.1-flash-lite",
  standard: "gemini-3.1-flash-lite",
  studio:   "gemini-3.1-flash-lite",
};

export class GeminiHermesAdapter implements GeminiAdapter {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(apiKey: string, model = "gemini-3.1-flash-lite") {
    this.ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } },
    });
    this.model = model;
  }

  async run(
    type: HermesJobType,
    payload: Record<string, HermesJsonValue>,
  ): Promise<HermesJsonValue> {
    switch (type) {
      case "looks":
        return this.planLooks(payload);
      case "translate":
        return this.translateText(payload);
      case "knowledge":
        return this.answerKnowledge(payload);
      default: {
        // Exhaustiveness guard — TypeScript will flag missing cases at compile time.
        const _exhaustive: never = type;
        throw new Error(`Unknown Hermes job type: ${String(_exhaustive)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // looks — LookSpecV1 planning
  // -------------------------------------------------------------------------

  private async planLooks(
    payload: Record<string, HermesJsonValue>,
  ): Promise<HermesJsonValue> {
    const lookCount = typeof payload.look_count === "number" ? payload.look_count : 1;
    const qualityTier = typeof payload.quality_tier === "string" ? payload.quality_tier : "standard";
    const planModel = HERMES_PLAN_MODEL_BY_TIER[qualityTier] ?? this.model;

    const promptLines: string[] = [
      `Pet identity: ${String(payload.identity_summary)}`,
      `Style prompt: ${String(payload.prompt)}`,
      `Number of looks to generate: ${lookCount}`,
      `Target aspect ratio for renders: ${String(payload.aspect_ratio)}`,
      `Quality tier: ${qualityTier}`,
    ];
    if (payload.look_pack) {
      promptLines.push(`Look pack / theme: ${String(payload.look_pack)}`);
    }

    const response = await this.ai.models.generateContent({
      model: planModel,
      contents: [{ role: "user", parts: [{ text: promptLines.join("\n") }] }],
      config: {
        systemInstruction: LOOKS_SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        // Constrain token generation to the exact LookSpecV1 shape.
        // Gemini's responseSchema provides the same guarantee that
        // Outlines + Gemma offered: invalid JSON structures are impossible
        // to emit because they are pruned from the token distribution.
        responseSchema: LOOK_SPEC_RESPONSE_SCHEMA as object,
        temperature: 0.9,
      },
    });

    const text = (response.text ?? "").trim();
    if (!text) throw new Error("Gemini returned an empty looks plan.");

    // JSON.parse is safe here: responseMimeType ensures valid JSON.
    return JSON.parse(text) as HermesJsonValue;
  }

  // -------------------------------------------------------------------------
  // translate — text translation
  // -------------------------------------------------------------------------

  private async translateText(
    payload: Record<string, HermesJsonValue>,
  ): Promise<HermesJsonValue> {
    const contextLine = payload.context
      ? `\n\nContext for the translation:\n${String(payload.context)}`
      : "";
    const prompt = [
      `Translate the following text from ${String(payload.source_language)} to ${String(payload.target_language)}.${contextLine}`,
      "",
      "Text to translate:",
      String(payload.text),
      "",
      'Return JSON with exactly these fields: {"translated_text": "...", "source_language": "...", "target_language": "..."}',
      "Do not add any extra fields.",
    ].join("\n");

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    });

    const text = (response.text ?? "").trim();
    if (!text) throw new Error("Gemini returned an empty translation.");
    return JSON.parse(text) as HermesJsonValue;
  }

  // -------------------------------------------------------------------------
  // knowledge — RAG Q&A over provided context chunks
  // -------------------------------------------------------------------------

  private async answerKnowledge(
    payload: Record<string, HermesJsonValue>,
  ): Promise<HermesJsonValue> {
    const chunks = Array.isArray(payload.context_chunks)
      ? (payload.context_chunks as string[])
          .map((chunk, i) => `[${i + 1}] ${chunk}`)
          .join("\n\n")
      : "";

    const prompt = [
      "You are a helpful assistant answering questions about pets and animal care.",
      "Use the context chunks below to answer accurately. Cite the chunks you used.",
      "",
      "Context:",
      chunks,
      "",
      `Question: ${String(payload.question)}`,
      "",
      "Return JSON with exactly these fields:",
      '{"answer": "your comprehensive answer", "citations": [{"chunk_index": 1, "text": "quoted text"}]}',
      "Do not add any extra fields.",
    ].join("\n");

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        temperature: 0.2,
      },
    });

    const text = (response.text ?? "").trim();
    if (!text) throw new Error("Gemini returned an empty knowledge answer.");
    return JSON.parse(text) as HermesJsonValue;
  }
}
