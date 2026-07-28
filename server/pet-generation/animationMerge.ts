import { NodeIO, type Document, type Animation } from "@gltf-transform/core";
import { PetGenerationError } from "./provider";

/**
 * Tripo's `animate_retarget` returns ONE preset animation per call, so `idle`
 * and `walk` arrive as two separate GLBs of the SAME rigged model. `validatePetGlb`
 * requires BOTH clips present in ONE delivered GLB, so we merge them.
 *
 * Strategy: take the idle GLB as the base (mesh + skin + idle clip) and rebuild
 * the walk clip natively inside it, re-pointing each channel at the base model's
 * OWN nodes (matched by name — both GLBs share the identical rig). This avoids
 * the skeleton/mesh duplication that a whole-document merge would cause.
 *
 * The two clips are force-named `idle` and `walk` so the validator's
 * name-substring gates (`idle_clip_exists`, `walk_clip_exists`) pass
 * deterministically regardless of what Tripo labelled them.
 */
export async function mergeIdleWalk(idleGlb: Buffer, walkGlb: Buffer): Promise<Buffer> {
  const io = new NodeIO();
  const base = await io.readBinary(new Uint8Array(idleGlb));
  const src = await io.readBinary(new Uint8Array(walkGlb));

  const idleAnim = firstAnimation(base, "idle");
  idleAnim.setName("idle");

  const walkSrc = firstAnimation(src, "walk");
  copyAnimationByNodeName(base, walkSrc, "walk");

  const out = await io.writeBinary(base);
  return Buffer.from(out);
}

function firstAnimation(doc: Document, which: string): Animation {
  const anims = doc.getRoot().listAnimations();
  if (!anims.length) {
    throw new PetGenerationError(
      "ANIM_SOURCE_EMPTY",
      `${which} GLB carries no animation to merge`,
    );
  }
  return anims[0];
}

/**
 * Rebuilds `srcAnim` inside `target` as a new animation named `newName`,
 * pointing every channel at the target node with the same name. Sampler input
 * (keyframe times) and output (values) accessors are cloned into the target's
 * first buffer. Channels whose target node has no name-match in the target are
 * skipped rather than guessed — a missing bone must never be silently mistargeted.
 */
function copyAnimationByNodeName(target: Document, srcAnim: Animation, newName: string): void {
  const nodesByName = new Map(
    target.getRoot().listNodes().map((n) => [n.getName(), n]),
  );
  const buffer = target.getRoot().listBuffers()[0] ?? target.createBuffer();
  const anim = target.createAnimation(newName);

  for (const ch of srcAnim.listChannels()) {
    const srcNode = ch.getTargetNode();
    const path = ch.getTargetPath();
    if (!srcNode || !path) continue;
    const tgtNode = nodesByName.get(srcNode.getName());
    if (!tgtNode) continue; // no name-match — skip, never mistarget a bone

    const srcSampler = ch.getSampler();
    if (!srcSampler) continue;
    const srcInput = srcSampler.getInput();
    const srcOutput = srcSampler.getOutput();
    if (!srcInput || !srcOutput) continue;

    const input = target
      .createAccessor()
      .setType(srcInput.getType())
      .setArray(new Float32Array(srcInput.getArray() as ArrayLike<number>))
      .setBuffer(buffer);
    const output = target
      .createAccessor()
      .setType(srcOutput.getType())
      .setArray(new Float32Array(srcOutput.getArray() as ArrayLike<number>))
      .setBuffer(buffer);

    const sampler = target
      .createAnimationSampler()
      .setInput(input)
      .setOutput(output)
      .setInterpolation(srcSampler.getInterpolation());
    const channel = target
      .createAnimationChannel()
      .setTargetNode(tgtNode)
      .setTargetPath(path)
      .setSampler(sampler);

    anim.addSampler(sampler).addChannel(channel);
  }

  if (!anim.listChannels().length) {
    throw new PetGenerationError(
      "ANIM_MERGE_NO_MATCH",
      `No ${newName} channels matched the base rig by node name`,
    );
  }
}
