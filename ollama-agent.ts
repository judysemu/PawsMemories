/**
 * AI Agent for pet image analysis and Blender script generation.
 * (Note: Originally designed for Ollama, but switched to Google Gemini 1.5
 * to avoid 401 Unauthorized errors on public endpoints, since Gemini is 
 * already configured and authenticated in this project.)
 * 
 * Uses Gemini Pro/Flash vision model to:
 *   1. Analyze pet photos — identify species, breed, pose, anatomy
 *   2. Generate Blender Python rigging scripts — armature with proper bone structure
 *   3. Generate Blender Python animation scripts — 6 action animations baked to sprite sheet
 */

import { GoogleGenAI } from "@google/genai";
import { SKELETON_CONTRACTS } from "./skeletonContract";

// =============================================================================
// Types
// =============================================================================

export interface PetAnalysis {
  species: string;        // "dog", "cat", "bird", "rabbit", etc.
  breed: string;          // "Golden Retriever", "Persian Cat", etc.
  bodyType: string;       // "quadruped", "biped", "winged"
  estimatedPose: string;  // "standing", "sitting", "lying_down"
  legCount: number;       // 4 for most pets
  hasTail: boolean;
  hasWings: boolean;
  bodyProportions: {
    headSize: string;     // "small", "medium", "large"
    legLength: string;    // "short", "medium", "long"
    bodyLength: string;   // "compact", "medium", "elongated"
    neckLength: string;   // "short", "medium", "long"
  };
  coatColors: string[];
  coatPattern: string;
}

// =============================================================================
// Helpers
// =============================================================================

function getAiClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set. Cannot use AI agent.");
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

/**
 * Extract JSON from a potentially mixed text + JSON response.
 */
function extractJson<T>(text: string): T {
  // Try to find JSON block in markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    return JSON.parse(fenceMatch[1].trim());
  }

  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }

  throw new Error(`Could not extract JSON from AI response: ${text.slice(0, 200)}`);
}

/**
 * Wraps Gemini API calls with exponential backoff to handle 503 "High Demand" errors.
 * Strategy: retry up to 8 times on the primary model (gemini-3.1-flash-lite) with exponential
 * backoff capped at 30s (~2 min total window). If all retries fail, falls back to
 * a current lightweight model for one final attempt to avoid total pipeline failure.
 * (retired Gemini 2.x models are not used; override via env.)
 */
const FALLBACK_MODEL = process.env.GEMINI_TEXT_FALLBACK_MODEL || 'gemini-3.1-flash-lite';

async function generateContentWithRetry(ai: any, request: any, maxRetries = 8) {
  let lastError: any;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await ai.models.generateContent(request);
    } catch (err: any) {
      lastError = err;
      const isRetryable = err.status === 503 || err.status === 429 || (err.message && (err.message.includes("503") || err.message.includes("429") || err.message.includes("UNAVAILABLE") || err.message.includes("high demand")));

      if (isRetryable && i < maxRetries - 1) {
        const waitTime = Math.min(Math.pow(2, i) * 2000, 30000);
        console.warn(`[AI Agent] Gemini High Demand Error (Attempt ${i + 1}/${maxRetries}). Retrying in ${waitTime / 1000}s...`);
        await new Promise(r => setTimeout(r, waitTime));
      } else if (!isRetryable) {
        // Non-retryable error (auth, bad request, etc.) — fail immediately
        throw err;
      }
      // If retryable and last attempt, fall through to fallback below
    }
  }

  // All retries exhausted on primary model — try fallback
  const primaryModel = request.model || 'unknown';
  if (primaryModel !== FALLBACK_MODEL) {
    console.warn(`[AI Agent] ⚠️ All ${maxRetries} retries on ${primaryModel} exhausted. Falling back to ${FALLBACK_MODEL}...`);
    try {
      const result = await ai.models.generateContent({ ...request, model: FALLBACK_MODEL });
      console.warn(`[AI Agent] ✅ Fallback to ${FALLBACK_MODEL} succeeded (quality may differ from ${primaryModel}).`);
      return result;
    } catch (fallbackErr: any) {
      console.error(`[AI Agent] ❌ Fallback model ${FALLBACK_MODEL} also failed:`, fallbackErr.message || fallbackErr);
      throw fallbackErr;
    }
  }

  throw lastError;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Analyze a pet photo using Gemini vision model.
 * Returns structured data about the animal's species, breed, anatomy, and pose.
 */
export async function analyzePetImage(imageBase64: string): Promise<PetAnalysis> {
  console.log("[AI Agent] Analyzing pet image with Gemini...");

  const prompt = `You are an expert animal anatomist and 3D modeler. Analyze this pet photo and return a JSON object with the following structure. Be precise about the animal's anatomy as this will be used for 3D rigging.

Return ONLY a valid JSON object with this exact structure (no other text):
{
  "species": "dog",
  "breed": "Golden Retriever",
  "bodyType": "quadruped",
  "estimatedPose": "standing",
  "legCount": 4,
  "hasTail": true,
  "hasWings": false,
  "bodyProportions": {
    "headSize": "medium",
    "legLength": "medium",
    "bodyLength": "medium",
    "neckLength": "medium"
  },
  "coatColors": ["#C0A080", "#FFFFFF"],
  "coatPattern": "solid"
}

Rules:
- species: the animal type (dog, cat, bird, rabbit, hamster, etc.)
- breed: best guess at the breed, or "Mixed" if unclear
- bodyType: "quadruped" for 4-legged, "biped" for 2-legged, "winged" for birds
- estimatedPose: "standing", "sitting", "lying_down", or "other"
- legCount: number of legs (4 for dogs/cats, 2 for birds)
- bodyProportions values: "small", "medium", or "large" / "short", "medium", "long" / "compact", "medium", "elongated"
- coatColors: Array of 1-3 primary colors found on the pet, formatted as hex codes (e.g., ["#000000", "#FFFFFF"])
- coatPattern: The pattern of the coat (e.g., "solid", "spotted", "striped", "bicolor", "tricolor")

Return ONLY the JSON object.`;

  try {
    const ai = getAiClient();
    
    // Process base64
    let cleanBase64 = imageBase64;
    let mimeType = "image/jpeg";
    const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      cleanBase64 = match[2];
    }

    const response = await generateContentWithRetry(ai, {
      model: process.env.GEMINI_TEXT_MODEL || 'gemini-3.1-flash-lite',
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            {
              inlineData: {
                data: cleanBase64,
                mimeType,
              }
            }
          ]
        }
      ],
      config: {
        temperature: 0.1,
      }
    });

    const responseText = response.text || "";
    const analysis = extractJson<PetAnalysis>(responseText);
    console.log(`[AI Agent] ✅ Detected: ${analysis.species} (${analysis.breed}), ${analysis.bodyType}, pose: ${analysis.estimatedPose}`);
    return analysis;
  } catch (err) {
    console.warn("[AI Agent] Failed to parse analysis, using fallback:", err);
    // Fallback to a safe default (dog)
    return {
      species: "dog",
      breed: "Mixed Breed",
      bodyType: "quadruped",
      estimatedPose: "standing",
      legCount: 4,
      hasTail: true,
      hasWings: false,
      bodyProportions: {
        headSize: "medium",
        legLength: "medium",
        bodyLength: "medium",
        neckLength: "medium",
      },
      coatColors: ["#C0A080"],
      coatPattern: "solid"
    };
  }
}

/**
 * Generate a Blender Python script for rigging a 3D mesh based on pet analysis.
 */
export async function generateRiggingScript(analysis: PetAnalysis): Promise<string> {
  console.log(`[AI Agent] Generating rigging script for ${analysis.species} (${analysis.breed}) using Gemini...`);

  const bodyType = (analysis.bodyType === 'biped' || analysis.bodyType === 'winged' || analysis.bodyType === 'quadruped')
    ? analysis.bodyType
    : 'quadruped';
  const contract = SKELETON_CONTRACTS[bodyType];

  let exactBonesBlock = `- ROOT bone at the center of mass\n`;
  exactBonesBlock += `- Spine chain: ${contract.chains.spine.map(b => `"${b}"`).join(" → ")}\n`;
  exactBonesBlock += `- Neck: ${contract.chains.neckHead.map(b => `"${b}"`).join(" → ")}\n`;
  for (const limb of contract.chains.limbs) {
    exactBonesBlock += `- ${limb.name}: ${limb.bones.map(b => `"${b}"`).join(" → ")}\n`;
  }
  if (analysis.hasTail && contract.chains.tail) {
    exactBonesBlock += `- Tail chain: ${contract.chains.tail.map(b => `"${b}"`).join(" → ")}`;
  } else {
    // strip trailing newline if no tail
    exactBonesBlock = exactBonesBlock.trimEnd();
  }

  const prompt = `You are an expert Blender 5.1 Python (bpy) scripter specializing in 3D character rigging.

Generate a complete Blender Python script that:
1. Assumes a GLB mesh is already imported and is the active object
2. Creates a new armature with bones appropriate for a ${analysis.species} (${analysis.breed})
3. The animal is a ${analysis.bodyType} with ${analysis.legCount} legs
4. Body proportions: head=${analysis.bodyProportions.headSize}, legs=${analysis.bodyProportions.legLength}, body=${analysis.bodyProportions.bodyLength}, neck=${analysis.bodyProportions.neckLength}
5. Has tail: ${analysis.hasTail}

The armature MUST include these bone chains (using these EXACT bone names):
${exactBonesBlock}

The script must:
- Create the armature in edit mode
- Position bones approximately based on the mesh bounding box
- If calculating world bounding box corners, MUST use: "from mathutils import Vector; world_bbox_corners = [mesh_obj.matrix_world @ Vector(v) for v in mesh_obj.bound_box]"
- To parent with automatic weights, you MUST use exactly this code:
  bpy.context.view_layer.objects.active = armature_obj
  mesh_obj.select_set(True)
  armature_obj.select_set(True)
  bpy.ops.object.parent_set(type='ARMATURE_AUTO')
- ALWAYS switch back to OBJECT mode before finishing (e.g., bpy.ops.object.mode_set(mode='OBJECT'))
- Set the armature as the active object when done
- If using show_in_front, apply it to the armature object (e.g., armature_obj.show_in_front = True), NEVER to the armature data.
- If you need to calculate radians, use the standard Python "math" module (e.g., import math; math.radians(90)), NOT mathutils.radians().
- DO NOT use "return" outside of a function (use sys.exit(1) if you need to abort early).
- DO NOT use "edit_bones.clear()". To remove bones, use a loop: "for b in list(armature.edit_bones): armature.edit_bones.remove(b)"
- NOT render anything
- NOT save the file
- Print "RIGGING_COMPLETE" when done

IMPORTANT: Return ONLY the Python code, no markdown fences, no explanations. Start with "import bpy".`;

  const ai = getAiClient();
  const response = await generateContentWithRetry(ai, {
    model: process.env.GEMINI_TEXT_MODEL || 'gemini-3.1-flash-lite',
    contents: prompt,
    config: { temperature: 0.1 }
  });

  // Extract just the Python code
  let script = response.text || "";

  // Remove markdown fences if present
  const fenceMatch = script.match(/```(?:python)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    script = fenceMatch[1];
  }

  // Ensure script starts with import
  if (!script.trim().startsWith("import")) {
    const importIdx = script.indexOf("import bpy");
    if (importIdx >= 0) {
      script = script.slice(importIdx);
    }
  }

  // Ensure the completion marker is present
  if (!script.includes("RIGGING_COMPLETE")) {
    script += '\nprint("RIGGING_COMPLETE")\n';
  }

  console.log(`[AI Agent] Sanitizing generated rigging script...`);
  script = sanitizeBlenderScript(script);

  console.log(`[AI Agent] ✅ Rigging script generated and sanitized (${script.length} chars)`);
  return script;
}

/**
 * Post-process AI-generated Blender scripts to fix known hallucination patterns.
 * This is a code-level safety net that catches bad patterns AFTER generation.
 */
function sanitizeBlenderScript(script: string): string {
  let s = script;

  // Fix 1: strip.is_active → strip.mute (is_active doesn't exist on NlaStrip)
  s = s.replace(/\.is_active\s*=\s*False/g, '.mute = True');
  s = s.replace(/\.is_active\s*=\s*True/g, '.mute = False');

  // Fix 2: BLENDER_EEVEE_NEXT → BLENDER_EEVEE (3.4 compat)
  s = s.replace(/BLENDER_EEVEE_NEXT/g, 'BLENDER_EEVEE');

  // Fix 3: Fix full-path keyframe_insert on pose bones
  // e.g. bone.keyframe_insert(data_path=f'pose.bones["{bone.name}"].rotation_euler'...)
  // → bone.keyframe_insert(data_path="rotation_euler"...)
  s = s.replace(
    /keyframe_insert\s*\(\s*data_path\s*=\s*f?['"]\s*pose\.bones\[.*?\]\.(rotation_euler|location|scale|rotation_quaternion)['"]/g,
    (match, prop) => `keyframe_insert(data_path="${prop}"`
  );

  // Fix 4: mathutils.radians → math.radians
  s = s.replace(/mathutils\.radians\s*\(/g, 'math.radians(');

  // Fix 5: Remove bare 'return' outside functions (causes SyntaxError)
  // Only remove top-level returns, not returns inside def blocks
  s = s.replace(/^return\b.*$/gm, '# return removed (top-level)');

  // Fix 6: bpy.ops.object.select_all() → safe loop
  s = s.replace(
    /bpy\.ops\.object\.select_all\s*\(\s*action\s*=\s*['"](?:SELECT|DESELECT)['"]\s*\)/g,
    'for _o in list(bpy.context.selected_objects): _o.select_set(False)'
  );

  // Fix 7: edit_bones.clear() → safe loop
  s = s.replace(
    /(\w+)\.edit_bones\.clear\(\)/g,
    'for _b in list($1.edit_bones): $1.edit_bones.remove(_b)'
  );

  // Fix 8: Ensure math import exists if math.radians is used
  if (s.includes('math.radians') && !s.includes('import math')) {
    s = 'import math\n' + s;
  }

  // Fix 9: Remove obsolete .distance on lights (Blender 2.7 legacy API)
  s = s.replace(/(\w+)\.distance\s*=\s*([^#\n]+)/g, '# legacy light distance removed');

  // Fix 10: Remove obsolete contact shadows (Removed in EEVEE-Next / Blender 4.2+)
  s = s.replace(/(\w+)\.use_contact_shadows?\s*=\s*(True|False)/g, '# contact shadows removed in EEVEE-Next');

  // Fix 11: Remove direct .fcurves access which was removed in Blender 4.3 (Animation 2.0)
  // Instead of risking a crash, we comment out the whole line and rely on animation_data_clear() or safe methods
  s = s.replace(/^.*\.fcurves.*$/gm, '# fcurves access removed in Blender 5 Animation 2.0');

  // Fix 12: Neutralize bpy.data.lights.remove() calls — these crash with StructRNA ReferenceError
  // when the light object has already been deleted. Orphan data blocks are harmless in headless scripts.
  s = s.replace(/bpy\.data\.lights\.remove\s*\([^)]*\)/g, 'pass  # light data removal skipped (StructRNA safety)');

  // Fix 13: Neutralize bpy.data.cameras.remove() for the same StructRNA reason
  s = s.replace(/bpy\.data\.cameras\.remove\s*\([^)]*\)/g, 'pass  # camera data removal skipped (StructRNA safety)');

  // Fix 9: Ensure the script has a top-level try/except to never crash silently
  if (!s.includes('except Exception') && !s.includes('except:')) {
    // Wrap the main execution in try/except for better error reporting
    const lines = s.split('\n');
    const importLines: string[] = [];
    const bodyLines: string[] = [];
    let pastImports = false;

    for (const line of lines) {
      if (!pastImports && (line.startsWith('import ') || line.startsWith('from ') || line.trim() === '')) {
        importLines.push(line);
      } else {
        pastImports = true;
        bodyLines.push(line);
      }
    }

    s = importLines.join('\n') + '\nimport traceback\n\ntry:\n' +
      bodyLines.map(l => '    ' + l).join('\n') +
      '\nexcept Exception as _e:\n    traceback.print_exc()\n    print(f"SCRIPT_ERROR: {_e}")\n    import sys; sys.exit(1)\n';
  }

  return s;
}

/**
 * Generate a Blender Python script that creates 6 action animations
 * and bakes them into a sprite sheet PNG.
 */
export async function generateSpriteAnimationScript(analysis: PetAnalysis): Promise<string> {
  console.log(`[AI Agent] Generating sprite animation script for ${analysis.species} using Gemini...`);

  const bodyType = (analysis.bodyType === 'biped' || analysis.bodyType === 'winged' || analysis.bodyType === 'quadruped')
    ? analysis.bodyType
    : 'quadruped';
  const contract = SKELETON_CONTRACTS[bodyType];

  let boneNamesList = "hips, spine, chest, neck, head";
  if (bodyType === 'quadruped') {
    boneNamesList += ", front_leg_upper.L/R, front_leg_lower.L/R, front_paw.L/R, back_leg_upper.L/R, back_leg_lower.L/R, back_paw.L/R";
    if (analysis.hasTail) {
      boneNamesList += ", tail_01, tail_02, tail_03";
    }
  } else if (bodyType === 'biped') {
    boneNamesList += ", shoulder.L/R, upperarm.L/R, forearm.L/R, hand.L/R, thigh.L/R, shin.L/R, foot.L/R";
  } else {
    boneNamesList += ", " + contract.allBones.filter(b => !["hips", "spine", "chest", "neck", "head"].includes(b)).join(", ");
  }

  const prompt = `You are an expert Blender 5.1 Python (bpy) scripter specializing in character animation and sprite sheet rendering for a headless server environment.

TARGET: Blender 5.1.2 running headless (blender --background). No GPU, no UI context. All APIs must be compatible with Blender 5.1.x.

Generate a complete Blender Python script. The script will be injected into a wrapper that has already imported the rigged model, set the armature as active, and entered Pose Mode.

═══════════════════════════════════════════════════════════
SECTION 1: INPUT ASSUMPTIONS
═══════════════════════════════════════════════════════════

- The active object is an ARMATURE (the rigged ${analysis.species}).
- The mesh is the armature's child.
- Bone names: ${boneNamesList}
- An "output_path" variable is already defined and points to the PNG output location.

═══════════════════════════════════════════════════════════
SECTION 2: GEOMETRY & MESH CONSTRAINTS
═══════════════════════════════════════════════════════════

- Origin point: assume paws rest at approximately Y=0 (ground plane).
- When calculating bounding box, use: from mathutils import Vector; corners = [obj.matrix_world @ Vector(v) for v in obj.bound_box]
- Do NOT modify the mesh geometry, only animate via pose bones.

═══════════════════════════════════════════════════════════
SECTION 3: RIGGING & POSE CONSTRAINTS
═══════════════════════════════════════════════════════════

BONE ACCESS — MANDATORY PATTERN:
  bone = armature_obj.pose.bones.get("bone_name")
  if bone is None:
      print(f"WARNING: bone 'bone_name' not found, skipping")
  else:
      bone.rotation_euler = (x, y, z)
  NEVER use armature_obj.pose.bones["name"] (crashes if missing). ALWAYS use .get() with None check.

At script start, print available bones:
  print(f"Available bones: {[b.name for b in armature_obj.pose.bones]}")

ROTATION MODE: Before setting rotation_euler, ensure: bone.rotation_mode = 'XYZ'

KEYFRAME_INSERT — MANDATORY PATTERN:
  bone.keyframe_insert(data_path="rotation_euler", index=0, frame=1)
  bone.keyframe_insert(data_path="location", index=1, frame=5)
  The data_path is RELATIVE to the bone. Do NOT use the full armature path.
  WRONG: bone.keyframe_insert(data_path=f'pose.bones["{bone.name}"].rotation_euler', ...)
  This WRONG pattern causes: TypeError: property "pose.bones[...].rotation_euler" not found

IK/FK LIMITS: Keep rotation values within anatomically plausible ranges:
  - Leg joints: max ±45° per axis
  - Spine/neck: max ±30° per axis
  - Head: max ±40° per axis
${analysis.hasTail ? "  - Tail: max ±25° per segment\n" : ""}
═══════════════════════════════════════════════════════════
SECTION 4: ANIMATION REQUIREMENTS
═══════════════════════════════════════════════════════════

Create 6 separate bpy.data.actions:

ACTION 1 - "eating" (4 frames, 8fps):
  Head/neck dip down, jaw-like bobbing on head bone, body mostly still with slight forward lean.

ACTION 2 - "drinking" (4 frames, 8fps):
  Head stays at consistent low level, rhythmic head bobbing (lapping), neck extends down.

ACTION 3 - "running" (6 frames, 12fps):
  Full gallop/trot cycle, front and back legs alternate in pairs, body bobs slightly.
  ${analysis.hasTail ? "Tail follows body motion with slight delay." : ""}

ACTION 4 - "playing" (4 frames, 10fps):
  Playful bounce/jump, front paws lift, then spring up. Energetic, joyful.
  ${analysis.hasTail ? "Tail wags rapidly." : ""}

ACTION 5 - "sleeping" (3 frames, 4fps):
  Body lowered (legs tucked), slow breathing (chest/spine gentle rise/fall), head resting near front paws.

ACTION 6 - "photo" (3 frames, 6fps):
  Alert sitting/standing, head tilts slightly to one side, ears perk up (head bone rotation). Hold pose.

ANIMATION_DATA: Before assigning an action, ALWAYS check:
  if not armature_obj.animation_data:
      armature_obj.animation_data_create()
  armature_obj.animation_data.action = action

NLA STRIPS: If pushing actions to NLA tracks:
  - Use strip.mute = True to deactivate. Do NOT use strip.is_active (it does not exist).
  - Use nla_tracks.new() and track.strips.new(name, start_frame, action)

═══════════════════════════════════════════════════════════
SECTION 5: CAMERA & COMPOSITION
═══════════════════════════════════════════════════════════

- Camera type: ORTHOGRAPHIC (cam_data.type = 'ORTHO')
- Position camera to the side of the model, facing it
- Set ortho_scale to fit the model with ~15% margin so ears/tail aren't clipped
- Use Damped Track or manual rotation to point at model center
- Frame the model consistently regardless of breed size

═══════════════════════════════════════════════════════════
SECTION 6: LIGHTING & ENVIRONMENT
═══════════════════════════════════════════════════════════

- Add a simple 3-point lighting rig (key, fill, rim) using bpy.data.lights
- Key light: SUN type, energy ~2.0, positioned above-front
- Fill light: POINT or AREA, energy ~0.5, opposite side
- Rim light: SPOT or SUN, energy ~1.0, behind model
- World background: keep transparent (scene.render.film_transparent = True)

═══════════════════════════════════════════════════════════
SECTION 7: RENDER & OUTPUT
═══════════════════════════════════════════════════════════

RENDER ENGINE — MANDATORY:
  scene.render.engine = 'BLENDER_WORKBENCH'
  scene.render.resolution_x = 128
  scene.render.resolution_y = 128
  DO NOT use Cycles. DO NOT use BLENDER_EEVEE or BLENDER_EEVEE_NEXT.
  Workbench is the fastest engine for headless CPU rendering (no ray computation).
  For Workbench lighting, use: scene.display.shading.light = 'STUDIO'
  and scene.display.shading.studio_light = 'Default' (or any .exr studio light name).

TRANSPARENCY:
  scene.render.film_transparent = True
  scene.render.image_settings.file_format = 'PNG'
  scene.render.image_settings.color_mode = 'RGBA'

SPRITE SHEET ASSEMBLY — MANDATORY APPROACH:
  a) Render each frame to a temp file: scene.render.filepath = f"/tmp/frame_{i}.png"; bpy.ops.render.render(write_still=True)
  b) Load it: img = bpy.data.images.load(filepath)
  c) Create sheet image: sheet = bpy.data.images.new("Sheet", width, height, alpha=True)
  d) Use numpy for compositing:
     import numpy as np
     sheet_arr = np.zeros((sheet_h, sheet_w, 4), dtype=np.float32)
     # For each frame:
     src = np.empty((128, 128, 4), dtype=np.float32)
     img.pixels.foreach_get(src.ravel())
     src = np.flipud(src)  # Blender stores pixels bottom-up
     sheet_arr[row_y:row_y+128, col_x:col_x+128] = src
     # Final:
     sheet_arr = np.flipud(sheet_arr)
     sheet.pixels.foreach_set(sheet_arr.ravel())
     sheet.filepath_raw = output_path
     sheet.save()
  Do NOT read from 'Render Result' — it crashes with IndexError.

SPRITE SHEET LAYOUT:
  6 columns wide × 6 rows tall (128×128 per cell)
  Each row = one animation action. Columns = frames.
  Total image: 768 × 768 pixels.

METADATA JSON:
  Save alongside the sprite sheet (output_path with .json extension).
  Format: { "frameWidth": 128, "frameHeight": 128, "animations": { "eating": { "row": 0, "frames": 8, "fps": 12 }, ... } }

═══════════════════════════════════════════════════════════
SECTION 8: FORBIDDEN PATTERNS (WILL CRASH)
═══════════════════════════════════════════════════════════

- ❌ bpy.ops.object.select_all() → use: for o in list(bpy.context.selected_objects): o.select_set(False)
- ❌ edit_bones.clear() → use: for b in list(arm.edit_bones): arm.edit_bones.remove(b)
- ❌ strip.is_active → use: strip.mute = True/False
- ❌ mathutils.radians() → use: import math; math.radians()
- ❌ "return" outside a function → use: sys.exit(1) if needed
- ❌ Full-path keyframe_insert data_path → use relative path only
- ❌ Reading pixels from 'Render Result' image → render to disk first
- ❌ bpy.ops.pose.select_all() without ensuring POSE mode and active armature first
- ❌ light_data.distance = X → Use .energy instead (distance is a legacy 2.7 API and will crash)
- ❌ use_contact_shadow(s) = True → Do NOT use contact shadows, EEVEE-Next uses raytracing implicitly
- ❌ action.fcurves → DO NOT access fcurves directly (Blender 5 removed action.fcurves in Animation 2.0). To clear animation, use obj.animation_data_clear() or create a new action.
- ❌ scene.render.engine = 'BLENDER_EEVEE' → Use 'BLENDER_WORKBENCH' (EEVEE is 10× slower headless on CPU)
- ❌ scene.eevee.taa_render_samples → Workbench does not use this setting
- ❌ bpy.data.lights.remove() / bpy.data.cameras.remove() → Do NOT manually remove light or camera data blocks. Deleting the object first invalidates the .data reference, causing StructRNA ReferenceError. Orphan data blocks are harmless in headless scripts.

═══════════════════════════════════════════════════════════
SECTION 9: CODE STYLE
═══════════════════════════════════════════════════════════

- Maximum 400 lines. Use loops, helper functions, and math for keyframes.
- DO NOT hardcode every single frame manually — the script will be truncated.
- Wrap the main logic in a function (e.g., def main():) and call it at the bottom.
- Print "SPRITE_BAKE_COMPLETE" as the very last line when done.
- Use import math for radians/sin/cos. Do NOT use mathutils for math functions.
- Use print() liberally for progress logging.

IMPORTANT: Return ONLY the Python code. Start with "import bpy". No markdown fences, no explanations.`;

  const ai = getAiClient();
  const response = await generateContentWithRetry(ai, {
    model: process.env.GEMINI_TEXT_MODEL || 'gemini-3.1-flash-lite',
    contents: prompt,
    config: { temperature: 0.1 }
  });

  // Extract the Python code
  let script = response.text || "";
  const fenceMatch = script.match(/```(?:python)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    script = fenceMatch[1];
  }

  if (!script.trim().startsWith("import")) {
    const importIdx = script.indexOf("import bpy");
    if (importIdx >= 0) {
      script = script.slice(importIdx);
    }
  }

  // Apply post-generation sanitization to catch any remaining hallucinations
  console.log(`[AI Agent] Sanitizing generated script...`);
  script = sanitizeBlenderScript(script);

  if (!script.includes("SPRITE_BAKE_COMPLETE")) {
    script += '\nprint("SPRITE_BAKE_COMPLETE")\n';
  }

  console.log(`[AI Agent] ✅ Animation/sprite script generated and sanitized (${script.length} chars)`);
  return script;
}

/**
 * Convenience: run the full analysis + script generation pipeline.
 * Returns both scripts ready for the Blender worker.
 */
export async function generateAvatarScripts(imageBase64: string): Promise<{
  analysis: PetAnalysis;
  riggingScript: string;
  spriteScript: string;
}> {
  const analysis = await analyzePetImage(imageBase64);
  const riggingScript = await generateRiggingScript(analysis);
  const spriteScript = await generateSpriteAnimationScript(analysis);
  return { analysis, riggingScript, spriteScript };
}
