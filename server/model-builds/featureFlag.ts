export function isPetGlbEnabled(): boolean {
  const envVal = process.env.PET_GLB_ENABLED;
  if (!envVal) return false;
  return envVal.trim().toLowerCase() === "true" || envVal.trim() === "1";
}

export function isModelBuildV3Enabled(): boolean {
  const envVal = process.env.MODEL_BUILD_V3_ENABLED;
  if (!envVal) return false;
  return envVal.trim().toLowerCase() === "true" || envVal.trim() === "1";
}

export class ModelBuildFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelBuildFeatureError";
  }
}

export function assertModelBuildV3Enabled(): void {
  if (!isModelBuildV3Enabled()) {
    throw new ModelBuildFeatureError(
      "MODEL_BUILD_V3_ENABLED is not set to true. The durable 3D build pipeline is disabled.",
    );
  }
}
