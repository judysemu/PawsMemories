/**
 * Act Node — GPT Code Generation
 * ================================
 * Generates actual bpy Python code based on the intent from Claude (reason node),
 * grounded by RAG context from the Blender API docs.
 *
 * Then executes the code via the MCP tool interface and returns the result.
 */

import type { BuildState, StepResult } from "./types";
import { executeBlenderTool } from "../../tools/blender_mcp";
import { facialVisemeBpyScript, parseVisemeResult } from "./facialVisemes";
import { retrieveBlenderContext, formatContextForPrompt } from "../../knowledge/retriever";
import { generateGeminiText } from "../../gemini";
import { lookupBreedAnatomy, generateVertexGroupCode, getBoneProportions } from "../../knowledge/breed-anatomy";

// ---------------------------------------------------------------------------
// Forbidden patterns (from the existing sanitizeBlenderScript in ollama-agent.ts)
// ---------------------------------------------------------------------------

const FORBIDDEN_PATTERNS = `
FORBIDDEN PATTERNS (these WILL crash Blender 5.1):
- ❌ bpy.ops.object.select_all() → use: for o in bpy.context.scene.objects: o.select_set(False)
- ❌ bpy.context.selected_objects → unavailable in Render/worker background contexts; iterate bpy.context.scene.objects instead
- ❌ bpy.context.active_object → unavailable in some background contexts; use bpy.context.view_layer.objects.active
- ❌ bpy.ops.import_scene.gltf(...) in generated code → the pipeline imports the input GLB before code generation
- ❌ Hard-coded GLB paths such as /tmp/input.glb, /tmp/model.glb, model.glb, or Windows temp paths
- ❌ edit_bones.clear() → use: for b in list(arm.edit_bones): arm.edit_bones.remove(b)
- ❌ strip.is_active → use: strip.mute = True/False
- ❌ mathutils.radians() → use: import math; math.radians()
- ❌ "return" outside a function → use: sys.exit(1) if needed
- ❌ Full-path keyframe_insert data_path → use RELATIVE path only (e.g., "rotation_euler")
- ❌ Reading pixels from 'Render Result' image → render to disk first
- ❌ light_data.distance = X → Use .energy instead
- ❌ use_contact_shadow(s) = True → removed in EEVEE-Next
- ❌ action.fcurves → removed in Blender 5 Animation 2.0
- ❌ scene.render.engine = 'BLENDER_EEVEE' → use 'BLENDER_WORKBENCH'
- ❌ bpy.data.lights.remove() / bpy.data.cameras.remove() → causes StructRNA ReferenceError
- ❌ BLENDER_EEVEE_NEXT → use BLENDER_EEVEE if needed, but prefer BLENDER_WORKBENCH for headless

MANDATORY PATTERNS:
- ✅ Work with the existing imported mesh in bpy.context.scene.objects; Do not import GLB files from generated code
- ✅ active = bpy.context.view_layer.objects.active — use view_layer for active object access
- ✅ for obj in bpy.context.scene.objects: obj.select_set(False) — safe background deselection
- ✅ bone = armature.pose.bones.get("name") — ALWAYS use .get(), NEVER direct indexing
- ✅ bone.rotation_mode = 'XYZ' — set before using rotation_euler
- ✅ bone.keyframe_insert(data_path="rotation_euler") — RELATIVE path
- ✅ from mathutils import Vector — for bounding box calculations
- ✅ world_bbox = [obj.matrix_world @ Vector(v) for v in obj.bound_box]
- ✅ import math — for math.radians(), math.sin(), math.cos()
`;

const CODE_GEN_SYSTEM_PROMPT = `You are an expert Blender 5.1 Python (bpy) code generator.

You receive:
1. A natural language description of what the code should do (the "intent")
2. Constraints to follow
3. Relevant Blender API documentation (from RAG)
4. The current scene state

Generate ONLY valid Python code that accomplishes the intent. The code will be executed directly in Blender 5.1.2 running headless (--background).

${FORBIDDEN_PATTERNS}

CODE STYLE:
- Start with "import bpy" and any other needed imports
- Assume the pet mesh is already imported into the current scene by the pipeline
- Never load external GLB files or guess filesystem paths
- Use print() for progress logging
- Handle errors gracefully — catch exceptions where appropriate
- Keep code under 200 lines
- Use helper functions for repeated operations
- End with a print statement confirming completion

Return ONLY the Python code. No markdown fences, no explanations. Start with "import".`;

/**
 * Generate bpy code using GPT (or Gemini as fallback), grounded by RAG.
 */
async function generateCode(
  intent: string,
  constraints: string[],
  sceneContext: string,
  ragContext: string
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;

  // Build the prompt
  const userPrompt = [
    `INTENT: ${intent}`,
    "",
    `CONSTRAINTS:`,
    ...constraints.map((c) => `- ${c}`),
    "",
    `CURRENT SCENE STATE:`,
    sceneContext,
    "",
    ragContext,
    "",
    "Generate the Python code now. Return ONLY code, starting with 'import'.",
  ].join("\n");

  // Try OpenAI GPT first
  if (apiKey) {
    try {
      const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
      const endpoint = baseUrl.endsWith("/") ? `${baseUrl}chat/completions` : `${baseUrl}/chat/completions`;
      
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };

      // Add OpenRouter specific headers if configured
      if (process.env.OPENAI_HTTP_REFERER) headers["HTTP-Referer"] = process.env.OPENAI_HTTP_REFERER;
      if (process.env.OPENAI_X_TITLE) headers["X-Title"] = process.env.OPENAI_X_TITLE;

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            { role: "system", content: CODE_GEN_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 4096,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          choices: { message: { content: string } }[];
        };
        let code = data.choices[0]?.message?.content || "";
        code = cleanCodeResponse(code);
        if (code) return code;
      }
    } catch (err: any) {
      console.warn("[Act] OpenAI GPT failed, falling back to Gemini:", err.message);
    }
  }

  // Fallback: use Gemini
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error("No OPENAI_API_KEY or GEMINI_API_KEY available for code generation");

  const code = await generateGeminiText({
    apiKey: geminiKey,
    model: "gemini-3.1-flash-lite",
    input: userPrompt,
    fallbackContents: userPrompt,
    systemInstruction: CODE_GEN_SYSTEM_PROMPT,
    temperature: 0.1,
  });

  return cleanCodeResponse(code);
}

/**
 * Clean markdown fences and extract pure Python code from LLM response.
 */
function cleanCodeResponse(code: string): string {
  // Remove markdown fences
  const fenceMatch = code.match(/```(?:python)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    code = fenceMatch[1];
  }

  // Ensure starts with import
  if (!code.trim().startsWith("import")) {
    const importIdx = code.indexOf("import bpy");
    if (importIdx >= 0) {
      code = code.slice(importIdx);
    }
  }

  return code.trim();
}

/**
 * Apply post-generation sanitization (from existing ollama-agent.ts).
 */
function sanitizeCode(script: string): string {
  let s = script;

  // Fix: strip.is_active → strip.mute
  s = s.replace(/\.is_active\s*=\s*False/g, ".mute = True");
  s = s.replace(/\.is_active\s*=\s*True/g, ".mute = False");

  // Fix: BLENDER_EEVEE_NEXT → BLENDER_EEVEE
  s = s.replace(/BLENDER_EEVEE_NEXT/g, "BLENDER_EEVEE");

  // Fix: background-safe object selection/context access
  s = s.replace(/bpy\.context\.selected_objects/g, "bpy.context.scene.objects");
  s = s.replace(/bpy\.context\.active_object/g, "bpy.context.view_layer.objects.active");
  s = s.replace(
    /bpy\.ops\.object\.select_all\s*\(\s*action\s*=\s*['"](?:SELECT|DESELECT)['"]\s*\)/g,
    "for _o in bpy.context.scene.objects: _o.select_set(False)"
  );

  // Fix: generated code must operate on the already-imported scene, not random paths.
  s = s.replace(/^.*bpy\.ops\.import_scene\.gltf\s*\(.*$/gm, "# import_scene.gltf removed: pipeline already imported the GLB");

  // Fix: Full-path keyframe_insert
  s = s.replace(
    /keyframe_insert\s*\(\s*data_path\s*=\s*f?['"]\s*pose\.bones\[.*?\]\.(rotation_euler|location|scale|rotation_quaternion)['"]/g,
    (_, prop) => `keyframe_insert(data_path="${prop}"`
  );

  // Fix: mathutils.radians → math.radians
  s = s.replace(/mathutils\.radians\s*\(/g, "math.radians(");

  // Fix: Remove bare 'return' outside functions
  s = s.replace(/^return\b.*$/gm, "# return removed (top-level)");

  // Fix: edit_bones.clear() → safe loop
  s = s.replace(
    /(\w+)\.edit_bones\.clear\(\)/g,
    "for _b in list($1.edit_bones): $1.edit_bones.remove(_b)"
  );

  // Fix: Ensure math import
  if (s.includes("math.radians") && !s.includes("import math")) {
    s = "import math\n" + s;
  }

  // Fix: Remove obsolete light.distance
  s = s.replace(/(\w+)\.distance\s*=\s*([^#\n]+)/g, "# legacy light distance removed");

  // Fix: Remove obsolete contact shadows
  s = s.replace(/(\w+)\.use_contact_shadows?\s*=\s*(True|False)/g, "# contact shadows removed in EEVEE-Next");

  // Fix: Remove direct .fcurves access
  s = s.replace(/^.*\.fcurves.*$/gm, "# fcurves access removed in Blender 5 Animation 2.0");

  // Fix: Neutralize bpy.data.lights.remove()
  s = s.replace(/bpy\.data\.lights\.remove\s*\([^)]*\)/g, "pass  # light data removal skipped");

  // Fix: Neutralize bpy.data.cameras.remove()
  s = s.replace(/bpy\.data\.cameras\.remove\s*\([^)]*\)/g, "pass  # camera data removal skipped");

  return s;
}

function deterministicCodeForAction(state: BuildState): string | null {
  const action = state.currentAction;
  if (!action) return null;

  const description = action.stepDescription.toLowerCase();
  const hasTail = state.petAnalysis.hasTail ? "True" : "False";

  // Look up breed-specific anatomy for proportions and animation modifiers
  const anatomy = lookupBreedAnatomy(state.petAnalysis.species, state.petAnalysis.breed);
  const boneProps = getBoneProportions(anatomy);
  const animMods = anatomy.animationModifiers;

  if (description.includes("verify mesh import")) {
    return `import bpy
print("[Deterministic] Inspecting imported mesh")
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError("No mesh objects found after GLB import")
for obj in meshes:
    print(f"Mesh {obj.name}: {len(obj.data.vertices)} verts, {len(obj.data.polygons)} faces")
print("[Deterministic] Mesh import verified")`;
  }

  if (description.includes("create") && description.includes("armature")) {
    // Breed-specific bone proportion multipliers
    const headFwd = (boneProps.headForwardExtent * 0.18).toFixed(2);
    const neckLen = (boneProps.neckLength * 0.10).toFixed(2);
    const legFront = (boneProps.legHeightFront * 0.45).toFixed(2);
    const legRear = (boneProps.legHeightRear * 0.45).toFixed(2);
    const torsoLen = (boneProps.torsoLength * 0.45).toFixed(2);
    const tailLen = (boneProps.tailLength * 0.20).toFixed(2);
    const hipH = boneProps.hipHeight.toFixed(2);

    return `import bpy
from mathutils import Vector
print("[Deterministic] Creating breed-aware armature for ${anatomy.breed} (${anatomy.species})")
# Breed-specific proportions: head=${headFwd}, neck=${neckLen}, legs_f=${legFront}, legs_r=${legRear}, torso=${torsoLen}, tail=${tailLen}
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError("No mesh object available for armature creation")
mesh = max(meshes, key=lambda o: len(o.data.vertices))
points = [mesh.matrix_world @ Vector(corner) for corner in mesh.bound_box]
min_v = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
max_v = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
center = (min_v + max_v) * 0.5
dims = max_v - min_v
length_axis = 0 if dims.x >= dims.y else 1
forward = Vector((1, 0, 0)) if length_axis == 0 else Vector((0, 1, 0))
right = Vector((0, 1, 0)) if length_axis == 0 else Vector((1, 0, 0))
half_len = max(dims[length_axis] * 0.5, 0.2)
half_w = max((dims.y if length_axis == 0 else dims.x) * 0.5, 0.08)
low = min_v.z
# Breed-aware height proportions
mid_z = low + max(dims.z * ${hipH}, 0.12)
top_z = low + max(dims.z * 0.78, 0.2)
for obj in bpy.context.scene.objects:
    obj.select_set(False)
for obj in list(bpy.context.scene.objects):
    if obj.type == 'ARMATURE':
        bpy.data.objects.remove(obj, do_unlink=True)
arm_data = bpy.data.armatures.new("PetArmatureData")
arm_obj = bpy.data.objects.new("PetArmature", arm_data)
bpy.context.collection.objects.link(arm_obj)
bpy.context.view_layer.objects.active = arm_obj
arm_obj.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
for bone in list(arm_data.edit_bones):
    arm_data.edit_bones.remove(bone)
def add_bone(name, head, tail, parent=None):
    bone = arm_data.edit_bones.new(name)
    bone.head = head
    bone.tail = tail
    bone.parent = parent
    bone.use_connect = False
    return bone
# Breed-aware spine chain with torso length multiplier
hips_h = center - forward * (half_len * ${(0.35 * boneProps.torsoLength).toFixed(2)}); hips_h.z = mid_z
spine_t = center + forward * (half_len * 0.05); spine_t.z = mid_z + dims.z * 0.05
chest_t = center + forward * (half_len * ${(0.35 * boneProps.torsoLength).toFixed(2)}); chest_t.z = mid_z + dims.z * 0.08
neck_t = center + forward * (half_len * ${(0.48 * boneProps.neckLength).toFixed(2)}); neck_t.z = top_z
head_t = center + forward * (half_len * ${(0.68 * boneProps.headForwardExtent).toFixed(2)}); head_t.z = top_z + dims.z * 0.04
hips = add_bone("hips", hips_h, spine_t)
spine = add_bone("spine", spine_t, chest_t, hips)
chest = add_bone("chest", chest_t, neck_t, spine)
neck = add_bone("neck", neck_t, head_t, chest)
head_fwd = forward * max(half_len * ${headFwd}, 0.08)
head = add_bone("head", head_t, head_t + head_fwd, neck)
jaw = add_bone("jaw", head_t + head_fwd * 0.2, head_t + head_fwd * 0.8 - Vector((0,0,0.05)), head)
for side, sign in (("L", 1), ("R", -1)):
    add_bone(f"ear.{side}", head_t + Vector((0, sign * half_w * 0.5, dims.z * 0.05)), head_t + Vector((0, sign * half_w * 0.8, dims.z * 0.15)), head)
    add_bone(f"eye.{side}", head_t + head_fwd * 0.5 + Vector((0, sign * half_w * 0.3, dims.z * 0.05)), head_t + head_fwd * 0.55 + Vector((0, sign * half_w * 0.3, dims.z * 0.05)), head)
# Breed-aware leg proportions
front_knee_h = ${(0.22 * boneProps.legHeightFront).toFixed(3)}
rear_knee_h = ${(0.22 * boneProps.legHeightRear).toFixed(3)}
for side, sign in (("L", 1), ("R", -1)):
    x_front = center + forward * (half_len * 0.28) + right * (half_w * sign)
    x_back = center - forward * (half_len * 0.28) + right * (half_w * sign)
    # Front legs
    shoulder = Vector((x_front.x, x_front.y, mid_z))
    knee = Vector((x_front.x, x_front.y, low + dims.z * front_knee_h))
    paw = Vector((x_front.x + forward.x * half_len * 0.04, x_front.y + forward.y * half_len * 0.04, low + dims.z * 0.03))
    upper = add_bone(f"front_leg_upper.{side}", shoulder, knee, chest)
    lower = add_bone(f"front_leg_lower.{side}", knee, paw, upper)
    add_bone(f"front_paw.{side}", paw, paw + forward * max(half_len * 0.08, 0.04), lower)
    # Rear legs
    shoulder = Vector((x_back.x, x_back.y, mid_z))
    knee = Vector((x_back.x, x_back.y, low + dims.z * rear_knee_h))
    paw = Vector((x_back.x + forward.x * half_len * 0.04, x_back.y + forward.y * half_len * 0.04, low + dims.z * 0.03))
    upper = add_bone(f"back_leg_upper.{side}", shoulder, knee, hips)
    lower = add_bone(f"back_leg_lower.{side}", knee, paw, upper)
    add_bone(f"back_paw.{side}", paw, paw + forward * max(half_len * 0.08, 0.04), lower)
if ${hasTail}:
    tail_len_mult = ${boneProps.tailLength.toFixed(2)}
    t0 = hips_h - forward * max(half_len * 0.12 * tail_len_mult, 0.05); t0.z = mid_z
    b1 = add_bone("tail_01", hips_h, t0, hips)
    b2 = add_bone("tail_02", t0, t0 - forward * max(half_len * 0.15 * tail_len_mult, 0.06), b1)
    add_bone("tail_03", b2.tail, b2.tail - forward * max(half_len * 0.12 * tail_len_mult, 0.05), b2)
bpy.ops.object.mode_set(mode='OBJECT')
arm_obj.show_in_front = True
bpy.context.view_layer.objects.active = arm_obj
print(f"[Deterministic] PetArmature created for ${anatomy.breed} with {len(arm_obj.data.bones)} bones")`;
  }

  if (description.includes("parent mesh") || description.includes("automatic weights")) {
    // Generate breed-specific vertex group assignment code
    const vgCode = generateVertexGroupCode(anatomy);

    return `import bpy
from mathutils import Vector
print("[Deterministic] Binding mesh to armature with breed-aware vertex groups for ${anatomy.breed}")
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
armatures = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
if not meshes:
    raise RuntimeError("No mesh object found for binding")
if not armatures:
    raise RuntimeError("No armature object found for binding")
mesh = max(meshes, key=lambda o: len(o.data.vertices))
armature = armatures[0]
bone_names = [b.name for b in armature.data.bones]
for name in bone_names:
    if not mesh.vertex_groups.get(name):
        mesh.vertex_groups.new(name=name)
points = [mesh.matrix_world @ Vector(corner) for corner in mesh.bound_box]
min_v = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
max_v = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
span = max_v - min_v
length_axis = 0 if span.x >= span.y else 1
${vgCode}
for vg in mesh.vertex_groups:
    try:
        vg.remove([v.index for v in mesh.data.vertices])
    except Exception:
        pass
bpy.context.view_layer.objects.active = armature
for obj in bpy.context.scene.objects:
    obj.select_set(False)
mesh.select_set(True)
armature.select_set(True)
try:
    print("[Deterministic] Attempting explicit breed-aware bone weights...")
    for v in mesh.data.vertices:
        world = mesh.matrix_world @ v.co
        group_name = choose_group(world)
        if group_name not in bone_names:
            group_name = bone_names[0]
        mesh.vertex_groups[group_name].add([v.index], 1.0, 'REPLACE')
    mod = next((m for m in mesh.modifiers if m.type == 'ARMATURE'), None)
    if mod is None:
        mod = mesh.modifiers.new("PetArmature", 'ARMATURE')
    mod.object = armature
    mesh.parent = armature
    print("Binding mesh to armature with explicit vertex groups")
except Exception as e:
    print(f"[Deterministic] Explicit weights failed ({e}), falling back to auto heat-diffusion...")
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
print(f"[Deterministic] Bound {mesh.name} to {armature.name} with {len(bone_names)} breed-aware vertex groups")`;
  }

  if (description.includes("clear inherited animation") || description.includes("restore neutral pose")) {
    return `import bpy
from mathutils import Matrix
print("[Deterministic] Clearing inherited motion and restoring neutral pose")
for obj in bpy.context.scene.objects:
    if obj.animation_data:
        obj.animation_data_clear()
    if obj.type == 'ARMATURE':
        for bone in obj.pose.bones:
            bone.matrix_basis = Matrix.Identity(4)
for action in list(bpy.data.actions):
    bpy.data.actions.remove(action)
bpy.context.scene.frame_set(1)
print(f"[Deterministic] Static model ready; remaining actions={len(bpy.data.actions)}")`;
  }

  const animationMatch = description.match(/create (eating|drinking|running|playing|sleeping|photo) animation/);
  if (animationMatch) {
    const name = animationMatch[1];
    // Breed-specific animation parameters
    const legAngleMax = anatomy.sections.frontLegs.jointAngleMax;
    const tailAngle = anatomy.sections.tail?.jointAngleMax ?? 12;
    const eatingReach = animMods.eatingReach;
    const playBounce = animMods.playBounce;
    const spineFlex = animMods.spineFlexMultiplier;
    const tailWag = animMods.tailWagAmplitude;
    // Use breed gait for running
    const isWaddle = animMods.runGaitType === "waddle";
    const isHop = animMods.runGaitType === "hop";
    const frameCount = isWaddle ? 36 : (isHop ? 20 : 24);

    return `import bpy
import math
print("[Deterministic] Creating ${name} animation for ${anatomy.breed} (${anatomy.species})")
armatures = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
if not armatures:
    raise RuntimeError("No armature object found for animation")
armature = armatures[0]
bpy.context.view_layer.objects.active = armature
if not armature.animation_data:
    armature.animation_data_create()
action = bpy.data.actions.new("${name}") if "${name}" not in bpy.data.actions else bpy.data.actions["${name}"]
armature.animation_data.action = action
frames = list(range(${frameCount})) if "${name}" in ("eating", "drinking", "running", "playing", "sleeping") else list(range(12))

# Setup IK constraints for foot-locking
for leg, chain in [("front", 2), ("back", 2)]:
    for side in ("L", "R"):
        paw_name = f"{leg}_paw.{side}"
        lower_name = f"{leg}_leg_lower.{side}"
        paw_bone = armature.pose.bones.get(paw_name)
        lower_bone = armature.pose.bones.get(lower_name)
        if paw_bone and lower_bone:
            # Check if IK already exists
            ik = next((c for c in lower_bone.constraints if c.type == 'IK'), None)
            if not ik:
                ik = lower_bone.constraints.new('IK')
                ik.target = armature
                ik.subtarget = paw_name
                ik.chain_count = chain
                ik.influence = 0.5 if "${name}" in ("running", "playing") else 0.0

# Breed-specific animation parameters
leg_angle_max = ${legAngleMax}
tail_angle_max = ${tailAngle}
eating_reach = ${eatingReach}
play_bounce = ${playBounce}
spine_flex = ${spineFlex}
tail_wag = ${tailWag}

for frame in frames:
    bpy.context.scene.frame_set(frame)
    phase = (frame / max(len(frames) - 1, 1)) * math.tau
    
    # Secondary motion phase delay
    sec_phase = phase - 0.5
    
    for bone_name in ("hips", "spine", "chest", "neck", "head", "jaw", "ear.L", "ear.R", "eye.L", "eye.R", "tail_01", "tail_02", "front_leg_upper.L", "front_leg_upper.R", "back_leg_upper.L", "back_leg_upper.R", "front_paw.L", "front_paw.R", "back_paw.L", "back_paw.R"):
        bone = armature.pose.bones.get(bone_name)
        if not bone:
            continue
        bone.rotation_mode = 'XYZ'
        bone.rotation_euler = (0, 0, 0)
        
        # Base motions
        if "${name}" == "eating" and bone_name in ("neck", "head"):
            bone.rotation_euler.x = math.radians((10 + 12 * math.sin(phase)) * eating_reach)
        elif "${name}" == "eating" and bone_name == "jaw":
            bone.rotation_euler.x = math.radians(15 + 15 * math.sin(phase * 2))
        elif "${name}" == "drinking" and bone_name in ("neck", "head"):
            bone.rotation_euler.x = math.radians((18 + 5 * math.sin(phase * 2)) * eating_reach)
        elif "${name}" == "drinking" and bone_name == "jaw":
            bone.rotation_euler.x = math.radians(10 + 10 * math.sin(phase * 4))
        elif "${name}" == "running" and "leg_upper" in bone_name:
            leg_amp = min(leg_angle_max, ${isWaddle ? 14 : isHop ? 30 : 22})
            ${isWaddle
              ? 'bone.rotation_euler.x = math.radians(leg_amp * 0.6 * math.sin(phase + (math.pi if bone_name.endswith(".R") else 0)))\n            bone.rotation_euler.z = math.radians(5 * math.sin(phase))  # waddle side-to-side'
              : isHop
                ? 'bone.rotation_euler.x = math.radians(leg_amp * math.sin(phase))  # synchronous hop'
                : 'bone.rotation_euler.x = math.radians(leg_amp * math.sin(phase + (math.pi if bone_name.endswith(".R") else 0)))'}
        elif "${name}" == "running" and bone_name.endswith("paw.L") or bone_name.endswith("paw.R"):
            # Counter-rotate paws for IK target simulation
            leg_amp = min(leg_angle_max, ${isWaddle ? 14 : isHop ? 30 : 22})
            ${isHop ? 'bone.rotation_euler.x = math.radians(-leg_amp * math.sin(phase))' : 'bone.rotation_euler.x = math.radians(-leg_amp * math.sin(phase + (math.pi if bone_name.endswith(".R") else 0)))'}
        elif "${name}" == "running" and bone_name in ("spine", "chest"):
            bone.rotation_euler.x = math.radians(${(4 * spineFlex).toFixed(1)} * math.sin(phase))
        elif "${name}" == "playing" and bone_name in ("hips", "spine", "chest"):
            bone.rotation_euler.x = math.radians(${(8 * playBounce).toFixed(1)} * math.sin(phase))
        elif "${name}" == "playing" and bone_name.startswith("ear."):
            bone.rotation_euler.y = math.radians(15 * math.sin(phase * 2))
            bone.rotation_euler.z = math.radians(10 * math.sin(phase * 2))
        elif "${name}" == "sleeping" and bone_name in ("spine", "neck", "head"):
            bone.rotation_euler.z = math.radians(6)
        elif "${name}" == "sleeping" and bone_name.startswith("eye."):
            bone.rotation_euler.x = math.radians(10) # close eyes
        elif "${name}" == "photo" and bone_name == "head":
            bone.rotation_euler.z = math.radians(8 * math.sin(phase))
            
        # Secondary motion
        if "${name}" in ("running", "playing") and bone_name.startswith("ear."):
            bone.rotation_euler.x += math.radians(-10 * math.sin(sec_phase)) # ear follow-through
        elif "${name}" in ("running", "playing") and bone_name == "jaw":
            bone.rotation_euler.x += math.radians(5 + 5 * math.sin(sec_phase)) # jowl bounce
        elif "${name}" in ("eating", "photo", "sleeping") and bone_name in ("chest", "spine"):
            bone.rotation_euler.x += math.radians(1.5 * math.sin(phase * 0.5)) # subtle breathing
            
        if bone_name.startswith("tail_"):
            bone.rotation_euler.z = math.radians(${(12 * tailWag).toFixed(1)} * math.sin(phase))
            
        bone.keyframe_insert(data_path="rotation_euler", frame=frame)
bpy.context.scene.frame_start = min(frames)
bpy.context.scene.frame_end = max(frames)
print(f"[Deterministic] Animation '${name}' created for ${anatomy.breed} with {len(frames)} keyframes")`;
  }

  if (description.includes("camera") && description.includes("lighting")) {
    return `import bpy
import math
from mathutils import Vector
print("[Deterministic] Setting up orthographic camera and 3-point lighting")
for obj in list(bpy.context.scene.objects):
    if obj.type in {'CAMERA', 'LIGHT'}:
        bpy.data.objects.remove(obj, do_unlink=True)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError("No mesh found to frame camera")
mesh = max(meshes, key=lambda o: len(o.data.vertices))
points = [mesh.matrix_world @ Vector(corner) for corner in mesh.bound_box]
min_v = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
max_v = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
center = (min_v + max_v) * 0.5
dims = max_v - min_v
cam_data = bpy.data.cameras.new("RenderCamera")
cam_data.type = 'ORTHO'
cam_data.ortho_scale = max(dims.x, dims.y, dims.z) * 1.5
cam_obj = bpy.data.objects.new("RenderCamera", cam_data)
bpy.context.collection.objects.link(cam_obj)
bpy.context.scene.camera = cam_obj
cam_obj.location = center + Vector((5.0, 0, 0))
cam_obj.rotation_euler = (math.radians(90), 0, math.radians(90))
def add_light(name, ltype, energy, loc, rot=None):
    ldata = bpy.data.lights.new(name=name, type=ltype)
    ldata.energy = energy
    lobj = bpy.data.objects.new(name=name, object_data=ldata)
    bpy.context.collection.objects.link(lobj)
    lobj.location = loc
    if rot:
        lobj.rotation_euler = rot
    return lobj
add_light("KeyLight", 'SUN', 2.0, center + Vector((5, -5, 5)), (math.radians(45), 0, math.radians(45)))
add_light("FillLight", 'POINT', 0.5, center + Vector((-2, -5, 1)))
add_light("RimLight", 'SUN', 1.5, center + Vector((-5, 5, 2)), (math.radians(45), 0, math.radians(-135)))
bpy.context.scene.render.film_transparent = True
bpy.context.scene.render.engine = 'BLENDER_EEVEE'
try:
    bpy.context.scene.eevee.use_gtao = True
    bpy.context.scene.eevee.use_bloom = True
except Exception:
    pass

# Apply Deterministic Procedural Coat Material based on extracted colors and pattern
if mesh.data.materials:
    mat = mesh.data.materials[0]
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    
    # Coat colors from pet analysis
    colors = ${JSON.stringify(state.petAnalysis?.coatColors || ["#C0A080"])}
    pattern = "${state.petAnalysis?.coatPattern || "solid"}"
    
    def hex_to_rgb(hex_code):
        hex_code = hex_code.lstrip('#')
        if len(hex_code) == 3:
            hex_code = ''.join(c + c for c in hex_code)
        r = int(hex_code[0:2], 16) / 255.0
        g = int(hex_code[2:4], 16) / 255.0
        b = int(hex_code[4:6], 16) / 255.0
        # sRGB to Linear
        r = (r / 12.92) if r <= 0.04045 else ((r + 0.055) / 1.055) ** 2.4
        g = (g / 12.92) if g <= 0.04045 else ((g + 0.055) / 1.055) ** 2.4
        b = (b / 12.92) if b <= 0.04045 else ((b + 0.055) / 1.055) ** 2.4
        return (r, g, b, 1.0)
    
    if bsdf:
        # Coat Pattern & Color Ramp
        voronoi = nodes.new(type='ShaderNodeTexVoronoi')
        voronoi.inputs['Scale'].default_value = 10.0 if pattern == "spotted" else (50.0 if pattern == "striped" else 0.1)
        
        ramp = nodes.new(type='ShaderNodeValToRGB')
        # Setup colors in ramp
        for i in range(len(ramp.color_ramp.elements) - 1):
            ramp.color_ramp.elements.remove(ramp.color_ramp.elements[0])
        ramp.color_ramp.elements[0].position = 0.0
        ramp.color_ramp.elements[0].color = hex_to_rgb(colors[0])
        
        if len(colors) > 1:
            el = ramp.color_ramp.elements.new(1.0)
            el.color = hex_to_rgb(colors[1 % len(colors)])
        if len(colors) > 2:
            el = ramp.color_ramp.elements.new(0.5)
            el.color = hex_to_rgb(colors[2 % len(colors)])
            
        links.new(voronoi.outputs['Distance'], ramp.inputs['Fac'])
        
        # Don't completely override Base Color if an Image Texture exists (Tripo3D output)
        base_tex = next((n for n in nodes if n.type == 'TEX_IMAGE'), None)
        if base_tex:
            mix = nodes.new(type='ShaderNodeMixRGB')
            mix.blend_type = 'OVERLAY'
            mix.inputs[0].default_value = 0.3 # Fac
            links.new(base_tex.outputs['Color'], mix.inputs[1])
            links.new(ramp.outputs['Color'], mix.inputs[2])
            links.new(mix.outputs['Color'], bsdf.inputs['Base Color'])
        else:
            links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
        
        # Fur Bump Map
        noise = nodes.new(type='ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 150.0
        noise.inputs['Detail'].default_value = 10.0
        bump = nodes.new(type='ShaderNodeBump')
        bump.inputs['Distance'].default_value = 0.05
        bump.inputs['Strength'].default_value = 0.4
        links.new(noise.outputs['Color'], bump.inputs['Height'])
        links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
print("[Deterministic] Camera and lighting setup complete")`;
  }

  if (description.includes("render sprite sheet")) {
    return `import bpy
import os
import base64
import numpy as np
print("[Deterministic] Rendering sprite sheet")
anim_names = ["eating", "drinking", "running", "playing", "sleeping", "photo"]
anim_frames = [8, 8, 8, 8, 8, 6]
rows = 6
cols = 8
frame_size = 128
bpy.context.scene.render.resolution_x = frame_size
bpy.context.scene.render.resolution_y = frame_size
bpy.context.scene.render.image_settings.file_format = 'PNG'
bpy.context.scene.render.image_settings.color_mode = 'RGBA'

# Switch to Workbench for fast headless rendering (EEVEE materials are preserved in the .blend for GLB export)
prev_engine = bpy.context.scene.render.engine
bpy.context.scene.render.engine = 'BLENDER_WORKBENCH'
bpy.context.scene.display.shading.light = 'STUDIO'
bpy.context.scene.display.shading.color_type = 'TEXTURE'

armatures = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
armature = armatures[0] if armatures else None

temp_dir = "/tmp/sprites_render"
os.makedirs(temp_dir, exist_ok=True)

for row, anim_name in enumerate(anim_names):
    num_frames = anim_frames[row]
    # Map sprite frames onto the 24-keyframe animation range
    if armature and armature.animation_data and anim_name in bpy.data.actions:
        armature.animation_data.action = bpy.data.actions[anim_name]
    anim_action = bpy.data.actions.get(anim_name)
    anim_length = 24 if anim_name != "photo" else 12
    for frame_idx in range(num_frames):
        # Sample evenly across the full keyframe range
        mapped_frame = int(frame_idx * (anim_length - 1) / max(num_frames - 1, 1))
        bpy.context.scene.frame_set(mapped_frame)
        filepath = os.path.join(temp_dir, f"r{row}_c{frame_idx}.png")
        bpy.context.scene.render.filepath = filepath
        bpy.ops.render.render(write_still=True)

sheet_width = cols * frame_size
sheet_height = rows * frame_size
sheet_img = bpy.data.images.new("SpriteSheet", width=sheet_width, height=sheet_height, alpha=True)
sheet_pixels = np.zeros((sheet_height, sheet_width, 4), dtype=np.float32)

for row in range(rows):
    for col in range(anim_frames[row]):
        filepath = os.path.join(temp_dir, f"r{row}_c{col}.png")
        if os.path.exists(filepath):
            frame_img = bpy.data.images.load(filepath)
            if frame_img.size[0] == frame_size and frame_img.size[1] == frame_size:
                fp = np.array(frame_img.pixels[:]).reshape((frame_size, frame_size, 4))
                base_y = sheet_height - (row + 1) * frame_size
                base_x = col * frame_size
                sheet_pixels[base_y:base_y+frame_size, base_x:base_x+frame_size] = fp
            bpy.data.images.remove(frame_img)

sheet_img.pixels = sheet_pixels.flatten()
out_path = os.path.join(temp_dir, "sheet_final.png")
sheet_img.filepath_raw = out_path
sheet_img.file_format = 'PNG'
sheet_img.save()

# Restore EEVEE for the GLB export step
bpy.context.scene.render.engine = prev_engine

with open(out_path, "rb") as f:
    b64 = base64.b64encode(f.read()).decode("utf-8")
    print(f"\\nSPRITE_SHEET_BASE64:{b64}\\n")

print("[Deterministic] Sprite sheet generated and encoded")`;
  }

  return null;
}

/**
 * Act node: generate code, sanitize it, execute it, return results.
 */
export async function actNode(state: BuildState): Promise<Partial<BuildState>> {
  const action = state.currentAction;
  if (!action) {
    return { statusMessage: "No action to execute" };
  }

  // Special case: checkpoint step
  if (action.stepDescription.toLowerCase().includes("checkpoint")) {
    const checkpointName = `step_${action.stepIndex}`;
    const result = await executeBlenderTool("save_checkpoint", { name: checkpointName });
    
    const stepResult: StepResult = {
      stepIndex: action.stepIndex,
      description: action.stepDescription,
      code: `# Checkpoint: ${checkpointName}`,
      executeResult: { success: result.success, stdout: "", stderr: "", error: result.error || null },
      verification: null,
      timestamp: Date.now(),
    };

    const updatedPlan = [...state.buildPlan];
    if (updatedPlan[action.stepIndex]) {
      updatedPlan[action.stepIndex] = { ...updatedPlan[action.stepIndex], completed: true };
    }

    return {
      executionHistory: [...state.executionHistory, stepResult],
      checkpoints: [...state.checkpoints, checkpointName],
      buildPlan: updatedPlan,
      statusMessage: `Checkpoint saved: ${checkpointName}`,
    };
  }

  // Special case: export step
  if (action.type === "finalize" || action.stepDescription.toLowerCase().includes("export")) {
    // Provider-morph PASSTHROUGH (not a facial rig): existing provider shape
    // keys are retained and canonicalized before the GLB leaves Blender. The
    // measured VISEME_RESULT is captured so exported metadata reflects what
    // actually exists rather than a hardcoded contract claim.
    // P4: skipped when the facial rig was not purchased (facialVisemes=false).
    let facialPassthrough = state.facialPassthrough ?? null;
    if (state.facialVisemes !== false) {
      const visemeResult = await executeBlenderTool("execute_bpy", { code: facialVisemeBpyScript() });
      if (!visemeResult.success) console.warn("[Act] Facial morph passthrough skipped:", visemeResult.error || visemeResult.data?.error);
      facialPassthrough = parseVisemeResult(visemeResult.data?.stdout) ?? facialPassthrough;
    }
    const exportResult = await executeBlenderTool("export_glb", {});
    
    const stepResult: StepResult = {
      stepIndex: action.stepIndex,
      description: action.stepDescription,
      code: "# GLB export",
      executeResult: {
        success: exportResult.success,
        stdout: `Exported ${exportResult.data?.size_bytes || 0} bytes`,
        stderr: "",
        error: exportResult.error || null,
      },
      verification: null,
      timestamp: Date.now(),
    };

    const updatedPlan = [...state.buildPlan];
    if (updatedPlan[action.stepIndex]) {
      updatedPlan[action.stepIndex] = { ...updatedPlan[action.stepIndex], completed: true };
    }

    return {
      executionHistory: [...state.executionHistory, stepResult],
      riggedGlbBase64: exportResult.data?.glb_base64 || null,
      facialPassthrough,
      buildPlan: updatedPlan,
      statusMessage: "Exported GLB",
    };
  }

  // Normal flow: use deterministic code for core rigging/animation, then LLM + RAG for the rest.
  console.log(`[Act] Generating code for: ${action.stepDescription}`);

  let code = deterministicCodeForAction(state);
  try {
    if (!code) {
      // Get RAG context
      let ragContext = "";
      try {
        const ragResults = await retrieveBlenderContext(action.bpyIntent, 6);
        ragContext = formatContextForPrompt(ragResults);
      } catch {
        ragContext = "No RAG context available.";
      }

      // Build scene context string
      const sceneContext = state.sceneState
        ? `Objects: ${(state.sceneState.objects || []).map((o: any) => `${o.name}(${o.type})`).join(", ")}`
        : "Scene state unknown.";

      code = await generateCode(action.bpyIntent, action.constraints, sceneContext, ragContext);
    }
  } catch (err: any) {
    const stepResult: StepResult = {
      stepIndex: action.stepIndex,
      description: action.stepDescription,
      code: "",
      executeResult: { success: false, stdout: "", stderr: "", error: `Code generation failed: ${err.message}` },
      verification: null,
      timestamp: Date.now(),
    };
    return {
      executionHistory: [...state.executionHistory, stepResult],
      errorCount: state.errorCount + 1,
      consecutiveErrors: state.consecutiveErrors + 1,
      statusMessage: `Code generation failed: ${err.message}`,
    };
  }

  // Sanitize
  code = sanitizeCode(code);

  // Execute via bridge
  console.log(`[Act] Executing ${code.length} chars of bpy code...`);
  const execResult = await executeBlenderTool("execute_bpy", { code });

  const stepResult: StepResult = {
    stepIndex: action.stepIndex,
    description: action.stepDescription,
    code,
    executeResult: {
      success: execResult.success && (execResult.data?.success ?? true),
      stdout: execResult.data?.stdout || "",
      stderr: execResult.data?.stderr || "",
      error: execResult.data?.error || execResult.error || null,
    },
    verification: null,
    timestamp: Date.now(),
  };

  let extractedSpriteSheet: string | undefined;
  if (execResult.success && execResult.data?.stdout) {
    const match = execResult.data.stdout.match(/SPRITE_SHEET_BASE64:([A-Za-z0-9+/=]+)/);
    if (match && match[1]) {
      extractedSpriteSheet = match[1];
      // Remove it from stdout so we don't pollute the logs
      stepResult.executeResult.stdout = execResult.data.stdout.replace(match[0], "[SPRITE_SHEET_EXTRACTED]");
    }
  }

  const newErrorCount = stepResult.executeResult.success ? state.errorCount : state.errorCount + 1;
  const newConsecutiveErrors = stepResult.executeResult.success ? 0 : state.consecutiveErrors + 1;

  const returnState: Partial<BuildState> = {
    executionHistory: [...state.executionHistory, stepResult],
    errorCount: newErrorCount,
    consecutiveErrors: newConsecutiveErrors,
    statusMessage: stepResult.executeResult.success
      ? `Executed: ${action.stepDescription}`
      : `Execution failed: ${stepResult.executeResult.error?.slice(0, 200)}`,
  };

  if (extractedSpriteSheet) {
    returnState.spriteSheetBase64 = `data:image/png;base64,${extractedSpriteSheet}`;
  }

  return returnState;
}
