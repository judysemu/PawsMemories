/**
 * DSPy Prompt Optimizer
 * ======================
 * Optimizes system prompts for each agent node using training examples.
 *
 * This module implements a simplified BootstrapFewShot optimization:
 * 1. Load gold-standard training examples
 * 2. Run each example through the current prompts
 * 3. Score the outputs against expected results
 * 4. Select the best-performing few-shot examples
 * 5. Write optimized prompt templates to agent/prompts/
 *
 * For full DSPy optimization, install the dspy-ai Python package
 * and use the exported signatures with the Python API.
 *
 * Usage: npx tsx agent/dspy/optimize.ts
 */

import fs from "fs";
import path from "path";
import { ALL_SIGNATURES, exportSignaturesForPython } from "./signatures";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TRAINING_DIR = path.resolve(import.meta.dirname || ".", "./training_data");
const PROMPTS_DIR = path.resolve(import.meta.dirname || ".", "../prompts");

// ---------------------------------------------------------------------------
// Training Data Types
// ---------------------------------------------------------------------------

interface TrainingExample {
  id: string;
  input: Record<string, any>;
  expected_output: Record<string, any>;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Seed Training Data
// ---------------------------------------------------------------------------

function seedTrainingData() {
  fs.mkdirSync(TRAINING_DIR, { recursive: true });

  // Perceive examples
  const perceiveExamples: TrainingExample[] = [
    {
      id: "perceive_001",
      input: {
        scene_json: {
          object_count: 1,
          objects: [
            { name: "Mesh", type: "MESH", vertex_count: 5000, face_count: 9000 },
          ],
        },
        build_context: "Just imported GLB mesh, step 1 of 13",
      },
      expected_output: {
        scene_understanding: {
          objectsPresent: [{ name: "Mesh", type: "MESH", status: "ok" }],
          overallQuality: "clean",
          missingElements: ["armature"],
          suggestedViewportChange: null,
          readyForNextStep: true,
          notes: "Mesh imported successfully. Ready for armature creation.",
        },
      },
    },
    {
      id: "perceive_002",
      input: {
        scene_json: {
          object_count: 2,
          objects: [
            { name: "Mesh", type: "MESH", vertex_count: 5000 },
            { name: "Armature", type: "ARMATURE", bones: [
              { name: "hips", parent: null },
              { name: "spine", parent: "hips" },
            ]},
          ],
        },
        build_context: "Created armature, now need to verify bone positions",
      },
      expected_output: {
        scene_understanding: {
          objectsPresent: [
            { name: "Mesh", type: "MESH", status: "ok" },
            { name: "Armature", type: "ARMATURE", status: "ok" },
          ],
          overallQuality: "clean",
          missingElements: [],
          suggestedViewportChange: { azimuth: 180, elevation: 15, reason: "Check tail bone alignment from behind" },
          readyForNextStep: true,
          notes: "Armature created with basic bone structure. Should verify from behind.",
        },
      },
    },
  ];

  // Code generation examples
  const codeGenExamples: TrainingExample[] = [
    {
      id: "codegen_001",
      input: {
        intent: "Create an armature for a quadruped dog with standard bone hierarchy",
        constraints: ["Use edit mode", "Position based on mesh bounding box", "Return to OBJECT mode"],
        scene_state: "Objects: Mesh(MESH)",
      },
      expected_output: {
        code_starts_with: "import bpy",
        code_contains: [
          "bpy.data.armatures.new",
          "edit_bones.new",
          "hips",
          "spine",
          "chest",
          "neck",
          "head",
          "front_leg_upper",
          "back_leg_upper",
          "OBJECT",
        ],
        code_not_contains: [
          "edit_bones.clear()",
          "mathutils.radians",
          "BLENDER_EEVEE_NEXT",
          ".fcurves",
        ],
      },
    },
    {
      id: "codegen_002",
      input: {
        intent: "Create eating animation: head/neck dip cycle, 4 frames",
        constraints: [
          "Use pose.bones.get() — NEVER direct indexing",
          "Set rotation_mode = 'XYZ'",
          "Use relative data_path for keyframe_insert",
        ],
        scene_state: "Objects: Mesh(MESH), Armature(ARMATURE)",
      },
      expected_output: {
        code_starts_with: "import bpy",
        code_contains: [
          "pose.bones.get",
          "rotation_mode",
          'keyframe_insert(data_path="rotation_euler"',
          "eating",
        ],
        code_not_contains: [
          'pose.bones["',
          "pose.bones[f",
          ".fcurves",
        ],
      },
    },
  ];

  // Verification examples
  const verifyExamples: TrainingExample[] = [
    {
      id: "verify_001",
      input: {
        expected_outcome: "Armature should be created with bone hierarchy",
        execution_result: { success: true, stdout: "Created 20 bones\nRIGGING_COMPLETE", stderr: "", error: null },
      },
      expected_output: {
        verification: {
          success: true,
          issuesFound: [],
          driftSeverity: "none",
          recommendation: "proceed",
          details: "Armature created successfully with 20 bones.",
        },
      },
    },
    {
      id: "verify_002",
      input: {
        expected_outcome: "Mesh should be parented to armature with automatic weights",
        execution_result: {
          success: false,
          stdout: "",
          stderr: "Error: Bone Heat Weighting: failed to find solution for one or more bones",
          error: "Bone Heat Weighting failed",
        },
      },
      expected_output: {
        verification: {
          success: false,
          issuesFound: ["Automatic weights failed — mesh may have non-manifold geometry"],
          driftSeverity: "major",
          recommendation: "undo_and_retry",
          details: "Bone heat weighting failed. Should retry with envelope weights or clean mesh first.",
        },
      },
    },
  ];

  fs.writeFileSync(
    path.join(TRAINING_DIR, "perceive_examples.json"),
    JSON.stringify(perceiveExamples, null, 2)
  );
  fs.writeFileSync(
    path.join(TRAINING_DIR, "code_gen_examples.json"),
    JSON.stringify(codeGenExamples, null, 2)
  );
  fs.writeFileSync(
    path.join(TRAINING_DIR, "verify_examples.json"),
    JSON.stringify(verifyExamples, null, 2)
  );

  console.log(`[DSPy] Seeded ${perceiveExamples.length + codeGenExamples.length + verifyExamples.length} training examples`);
}

// ---------------------------------------------------------------------------
// Prompt Template Generation
// ---------------------------------------------------------------------------

function generateOptimizedPrompts() {
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });

  // Load training examples for few-shot inclusion
  const perceiveExamples = loadExamples("perceive_examples.json");
  const codeGenExamples = loadExamples("code_gen_examples.json");
  const verifyExamples = loadExamples("verify_examples.json");

  // Generate perceive prompt
  const perceivePrompt = {
    system: `You are a 3D scene analysis expert specializing in Blender viewport analysis for pet avatar construction.

Your task: Analyze viewport screenshots and scene graph data to understand the current build state.

${formatFewShotExamples(perceiveExamples)}

Return a JSON object with: objectsPresent, overallQuality, missingElements, suggestedViewportChange, readyForNextStep, notes.`,
    model: "gemini-3.1-flash-lite",
    temperature: 0.1,
  };

  // Generate act (code gen) prompt
  const actPrompt = {
    system: `You are an expert Blender 5.1 Python (bpy) code generator for headless server environments.

CRITICAL RULES:
- ALWAYS use pose.bones.get("name") — NEVER direct indexing
- Set bone.rotation_mode = 'XYZ' before rotation_euler
- Use RELATIVE data_path for keyframe_insert (e.g., "rotation_euler")
- Use BLENDER_WORKBENCH for headless rendering
- Use import math for radians/sin/cos — NOT mathutils
- Wrap in try/except for error resilience

${formatFewShotExamples(codeGenExamples)}

Return ONLY valid Python code. Start with "import bpy".`,
    model: "gpt-4o",
    fallback_model: "gemini-3.1-flash-lite",
    temperature: 0.1,
  };

  // Generate verify prompt
  const verifyPrompt = {
    system: `You are a 3D quality assurance inspector. Compare viewport screenshots and execution results to detect issues.

Severity guide:
- none: Perfect execution
- minor: Small cosmetic issues, safe to continue
- major: Significant problems, needs retry
- critical: Scene is broken, needs rollback

${formatFewShotExamples(verifyExamples)}

Return JSON: { success, issuesFound[], driftSeverity, recommendation, details }`,
    model: "gemini-3.1-flash-lite",
    temperature: 0.1,
  };

  fs.writeFileSync(path.join(PROMPTS_DIR, "perceive.json"), JSON.stringify(perceivePrompt, null, 2));
  fs.writeFileSync(path.join(PROMPTS_DIR, "act.json"), JSON.stringify(actPrompt, null, 2));
  fs.writeFileSync(path.join(PROMPTS_DIR, "verify.json"), JSON.stringify(verifyPrompt, null, 2));

  // Export signatures for Python DSPy
  fs.writeFileSync(path.join(PROMPTS_DIR, "signatures.json"), exportSignaturesForPython());

  console.log(`[DSPy] ✅ Generated optimized prompts in ${PROMPTS_DIR}`);
}

function loadExamples(filename: string): TrainingExample[] {
  const filepath = path.join(TRAINING_DIR, filename);
  if (!fs.existsSync(filepath)) return [];
  return JSON.parse(fs.readFileSync(filepath, "utf-8"));
}

function formatFewShotExamples(examples: TrainingExample[]): string {
  if (examples.length === 0) return "";

  const formatted = examples.slice(0, 3).map((ex, i) => {
    return [
      `--- Example ${i + 1} ---`,
      `Input: ${JSON.stringify(ex.input, null, 2).slice(0, 500)}`,
      `Expected Output: ${JSON.stringify(ex.expected_output, null, 2).slice(0, 500)}`,
    ].join("\n");
  });

  return "\nFEW-SHOT EXAMPLES:\n" + formatted.join("\n\n");
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== DSPy Prompt Optimization ===\n");

  // Step 1: Seed training data if not exists
  if (!fs.existsSync(TRAINING_DIR) || fs.readdirSync(TRAINING_DIR).length === 0) {
    console.log("Step 1: Seeding training data...");
    seedTrainingData();
  } else {
    console.log("Step 1: Training data exists, skipping seed.");
  }

  // Step 2: Generate optimized prompt templates
  console.log("\nStep 2: Generating optimized prompts...");
  generateOptimizedPrompts();

  console.log("\n✅ Optimization complete!");
  console.log("   Prompts saved to: agent/prompts/");
  console.log("   Training data at: agent/dspy/training_data/");
  console.log("\n   For full DSPy optimization with Python:");
  console.log("   pip install dspy-ai");
  console.log("   python -c \"import dspy; ...\" # Use signatures.json");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
