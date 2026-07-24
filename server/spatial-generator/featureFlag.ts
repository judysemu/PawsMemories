export function isInhouseSpatialGeneratorEnabled(): boolean {
  const envVal = process.env.INHOUSE_SPATIAL_GENERATOR_ENABLED;
  if (!envVal) return false;
  return envVal.trim().toLowerCase() === "true" || envVal.trim() === "1";
}

export class SpatialGeneratorFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpatialGeneratorFeatureError";
  }
}

export function assertInhouseSpatialGeneratorEnabled(): void {
  if (!isInhouseSpatialGeneratorEnabled()) {
    throw new SpatialGeneratorFeatureError(
      "INHOUSE_SPATIAL_GENERATOR_ENABLED is not set to true. The in-house spatial generator is disabled.",
    );
  }
}