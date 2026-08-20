import {
  ModelBuildProviderError,
  TripoModelBuildAdapter,
  type ModelBuildProvider,
  type ModelBuildProviderInput,
  type ModelBuildProviderResult,
  type ModelBuildPollResult,
  type ModelBuildReferenceViewKind,
} from "./provider";

export type ModelBuildProviderFactory = () => ModelBuildProvider;

export function selectedPaws3dProvider(env: NodeJS.ProcessEnv = process.env): string {
  const selected = String(env.PAWS_3D_PROVIDER || "tripo").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(selected)) {
    throw new ModelBuildProviderError("Configured 3D provider id is invalid", "PROVIDER_CONFIG_INVALID", false);
  }
  return selected;
}

export function createConfiguredModelBuildProvider(
  env: NodeJS.ProcessEnv = process.env,
  factories: ReadonlyMap<string, ModelBuildProviderFactory> = new Map<string, ModelBuildProviderFactory>([
    ["tripo", () => new TripoModelBuildAdapter()],
  ]),
): ModelBuildProvider {
  const selected = selectedPaws3dProvider(env);
  const factory = factories.get(selected);
  if (!factory) {
    throw new ModelBuildProviderError("Configured 3D provider is unavailable", "PROVIDER_CONFIG_UNAVAILABLE", false);
  }
  return factory();
}

/**
 * Defers provider credential validation until the enabled pipeline performs an
 * operation. Importing the server with MODEL_BUILD_V3_ENABLED=false therefore
 * remains safe even when the documented connection values are blank.
 */
export class LazyConfiguredModelBuildProvider implements ModelBuildProvider {
  private resolvedProvider: ModelBuildProvider | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly factories: ReadonlyMap<string, ModelBuildProviderFactory> = new Map<string, ModelBuildProviderFactory>([
      ["tripo", () => new TripoModelBuildAdapter()],
    ]),
  ) {}

  get providerId(): string {
    return selectedPaws3dProvider(this.env);
  }

  get modelId(): string {
    if (this.providerId === "tripo") return this.env.TRIPO_MODEL_VERSION || "default";
    return this.resolve().modelId || "configured";
  }

  get requiredReferenceViewKinds(): readonly ModelBuildReferenceViewKind[] {
    if (this.providerId === "tripo") return ["front", "left", "right", "rear"] as const;
    return this.resolve().requiredReferenceViewKinds || ["front", "left", "right", "rear"] as const;
  }

  async preflightForCharge(): Promise<void> {
    const provider = this.resolve();
    await provider.preflightForCharge?.();
  }

  start(input: ModelBuildProviderInput, configHash: string): Promise<ModelBuildProviderResult> {
    return this.resolve().start(input, configHash);
  }

  poll(taskHandle: string): Promise<ModelBuildPollResult> {
    return this.resolve().poll(taskHandle);
  }

  download(glbUrl: string): Promise<Buffer> {
    return this.resolve().download(glbUrl);
  }

  private resolve(): ModelBuildProvider {
    if (!this.resolvedProvider) {
      const selected = selectedPaws3dProvider(this.env);
      const factory = this.factories.get(selected);
      if (!factory) {
        throw new ModelBuildProviderError("Configured 3D provider is unavailable", "PROVIDER_CONFIG_UNAVAILABLE", false);
      }
      this.resolvedProvider = factory();
    }
    return this.resolvedProvider;
  }
}

export function createLazyConfiguredModelBuildProvider(
  env: NodeJS.ProcessEnv = process.env,
  factories?: ReadonlyMap<string, ModelBuildProviderFactory>,
): ModelBuildProvider {
  return new LazyConfiguredModelBuildProvider(env, factories);
}
