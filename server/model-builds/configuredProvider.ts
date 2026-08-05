import {
  ModelBuildProviderError,
  TripoModelBuildAdapter,
  type ModelBuildProvider,
} from "./provider";
import { TrellisModelBuildAdapter } from "./trellisProvider";

export type ModelBuildProviderFactory = () => ModelBuildProvider;

export function selectedPaws3dProvider(env: NodeJS.ProcessEnv = process.env): string {
  const selected = String(env.PAWS_3D_PROVIDER || "tripo").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(selected)) {
    throw new ModelBuildProviderError("Configured 3D provider id is invalid", "PROVIDER_CONFIG_INVALID", false);
  }
  const externalProviders = new Set(
    String(env.PAWS_3D_EXTERNAL_PROVIDER_IDS || "tripo")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (env.PAWS_3D_INHOUSE_ONLY === "true" && externalProviders.has(selected)) {
    throw new ModelBuildProviderError(
      "In-house-only mode rejects the selected external provider",
      "INHOUSE_PROVIDER_REQUIRED",
      false,
    );
  }
  return selected;
}

export function createConfiguredModelBuildProvider(
  env: NodeJS.ProcessEnv = process.env,
  factories: ReadonlyMap<string, ModelBuildProviderFactory> = new Map([
    ["tripo", () => new TripoModelBuildAdapter()],
    ["trellis2", () => new TrellisModelBuildAdapter()],
  ]),
): ModelBuildProvider {
  const selected = selectedPaws3dProvider(env);
  const factory = factories.get(selected);
  if (!factory) {
    throw new ModelBuildProviderError("Configured 3D provider is unavailable", "PROVIDER_CONFIG_UNAVAILABLE", false);
  }
  return factory();
}
