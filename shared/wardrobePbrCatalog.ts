/**
 * Curated, deterministic PBR material briefs for the authored wardrobe.
 *
 * These are asset-authoring inputs, not customer prompts. Keeping them in a
 * closed catalog prevents arbitrary paid fal.ai calls and gives every output
 * a reproducible seed and a truthful fallback while generated maps are absent.
 */
export interface WardrobePbrProfile {
  id: string;
  label: string;
  prompt: string;
  seed: number;
  fallback: {
    roughness: number;
    metalness: number;
    normalScale: number;
  };
}

export const WARDROBE_PBR_MAP_KINDS = ["basecolor", "normal", "roughness", "metalness"] as const;
export type WardrobePbrMapKind = typeof WARDROBE_PBR_MAP_KINDS[number];

const profile = (
  id: string,
  label: string,
  prompt: string,
  seed: number,
  roughness: number,
  metalness: number,
  normalScale: number,
): WardrobePbrProfile => ({
  id,
  label,
  prompt,
  seed,
  fallback: { roughness, metalness, normalScale },
});

export const WARDROBE_PBR_PROFILES: readonly WardrobePbrProfile[] = [
  profile(
    "scarlet-leather",
    "Scarlet leather",
    "seamless scarlet vegetable-tanned leather, fine natural grain, subtle hand-tooled edge wear, clean premium pet collar material, no buckles, no logos, no text",
    1729, 0.62, 0.03, 0.65,
  ),
  profile(
    "forest-leather",
    "Forest leather",
    "seamless deep forest green vegetable-tanned leather, refined natural grain, soft waxed finish, durable premium pet collar material, no buckles, no logos, no text",
    1733, 0.64, 0.03, 0.62,
  ),
  profile(
    "navy-textile",
    "Navy textile",
    "seamless rich navy blue woven cotton textile, fine diagonal twill, soft matte fibers, premium bandana and vest fabric, no pattern, no seams, no logos, no text",
    1741, 0.88, 0.0, 0.48,
  ),
  profile(
    "ranger-canvas",
    "Ranger canvas",
    "seamless rugged olive and umber waxed canvas, fine dense weave, gently weathered adventure gear material, restrained variation, no hardware, no logos, no text",
    1747, 0.78, 0.01, 0.58,
  ),
  profile(
    "royal-velvet",
    "Royal velvet",
    "seamless deep royal violet velvet, short plush nap, elegant soft directional sheen, luxurious costume fabric, clean surface, no embroidery, no logos, no text",
    1753, 0.84, 0.0, 0.38,
  ),
  profile(
    "bright-felt",
    "Bright felt",
    "seamless cheerful rose and meadow wool felt, dense fine fibers, soft handcrafted party accessory material, even color field, no decorations, no logos, no text",
    1759, 0.92, 0.0, 0.42,
  ),
  profile(
    "burnished-gold",
    "Burnished gold",
    "seamless warm burnished gold metal, restrained micro-scratches, polished raised areas and softly aged recesses, premium costume jewelry finish, no symbols, no logos, no text",
    1777, 0.3, 0.9, 0.34,
  ),
  profile(
    "antique-silver",
    "Antique silver",
    "seamless antique silver metal, delicate brushed grain, softly darkened recesses, polished highlights, premium costume crown finish, no symbols, no logos, no text",
    1783, 0.34, 0.92, 0.32,
  ),
  profile(
    "copper-leather",
    "Copper leather",
    "seamless warm copper-brown leather, fine pebble grain, subtle waxed highlights, elegant bow tie and autumn accessory material, no stitching, no logos, no text",
    1787, 0.6, 0.04, 0.6,
  ),
  profile(
    "rose-leather",
    "Rose leather",
    "seamless muted rose pink premium leather, delicate natural grain, soft satin wax finish, refined pet collar material, no flowers, no buckles, no logos, no text",
    1789, 0.63, 0.03, 0.58,
  ),
  profile(
    "midnight-leather",
    "Midnight leather",
    "seamless midnight blue-black premium leather, fine natural grain, subtle cool sheen, elegant formal pet collar material, no buckles, no stars, no logos, no text",
    1801, 0.58, 0.05, 0.56,
  ),
  profile(
    "optical-enamel",
    "Optical enamel",
    "seamless smooth charcoal and amber optical enamel, lightly polished hard coating, extremely subtle micro-surface, premium eyewear finish, no lenses, no logos, no text",
    1811, 0.26, 0.38, 0.18,
  ),
  profile(
    "seasonal-cloth",
    "Seasonal cloth",
    "seamless warm sunset and spring woven cloth, fine balanced weave, soft premium apparel fibers, clean tasteful color variation, no printed pattern, no logos, no text",
    1823, 0.86, 0.0, 0.46,
  ),
  profile(
    "frosted-cloth",
    "Frosted cloth",
    "seamless pale frost blue woven cloak fabric, fine soft fibers, subtle silvery cool highlights, premium winter costume textile, no snowflakes, no logos, no text",
    1831, 0.82, 0.0, 0.44,
  ),
  profile(
    "ember-cloth",
    "Ember cloth",
    "seamless deep ember red woven cloak fabric, fine durable fibers, restrained warm tonal variation, premium costume textile, no flames, no logos, no text",
    1847, 0.84, 0.0, 0.48,
  ),
] as const;

const BY_ID = new Map(WARDROBE_PBR_PROFILES.map((entry) => [entry.id, entry]));

export const FULL_WARDROBE_MATERIAL_IDS = new Set(BY_ID.keys());

export function getWardrobePbrProfile(id: string): WardrobePbrProfile | undefined {
  return BY_ID.get(id);
}

/**
 * fal.ai is deliberately limited to accessory materials. The pet/avatar GLB
 * already asks its 3D provider for PBR output; a second retexture pass is not
 * allowed until it proves armature, skin weights, morph targets, animation
 * clips, UVs, and identity all survive byte-level/semantic validation.
 */
export const FAL_PBR_USE_POLICY = Object.freeze({
  accessoryMaterials: true,
  riggedAvatarRetexture: false,
  animatorPreviewDependency: false,
});
