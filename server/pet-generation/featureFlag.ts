/**
 * Follows the established repo pattern exactly
 * (server/model-builds/featureFlag.ts, server/spatial-generator/featureFlag.ts):
 * isXEnabled() + named Error subclass + assertXEnabled(), env-driven,
 * default OFF.
 *
 * Lives here rather than in model-builds/ so the pet-generation module owns
 * its own flag and can be rolled back independently of the durable 3D build
 * pipeline.
 */
export function isPetGlbEnabled(): boolean {
  const envVal = process.env.PET_GLB_ENABLED;
  if (!envVal) return false;
  const v = envVal.trim().toLowerCase();
  return v === "true" || v === "1";
}

export class PetGlbFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PetGlbFeatureError";
  }
}

export function assertPetGlbEnabled(): void {
  if (!isPetGlbEnabled()) {
    throw new PetGlbFeatureError(
      "PET_GLB_ENABLED is not set to true. The paid pet GLB pipeline is disabled.",
    );
  }
}
