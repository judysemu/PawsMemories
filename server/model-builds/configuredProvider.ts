import {
  TripoModelBuildAdapter,
  type ModelBuildProvider,
  type ModelBuildProviderInput,
  type ModelBuildProviderResult,
  type ModelBuildPollResult,
  type ModelBuildReferenceViewKind,
} from "./provider";

/**
 * The one provider the model generator builds against.
 *
 * This was previously resolved at runtime from PAWS_3D_PROVIDER through a
 * factory map, which existed to let TRELLIS be selected instead. TRELLIS was
 * removed on 2026-08-20 and the map has had a single entry since, so the
 * indirection only created ways to be misconfigured: an unset or mistyped
 * variable could reach a lookup miss deep inside a paid flow rather than
 * failing at boot, and the same variable had to agree with the SKU registry
 * and the capability contract independently.
 *
 * Binding the id here removes that class of failure entirely. Adding a second
 * provider later means reintroducing selection deliberately, with the registry
 * and capabilities updated in the same change.
 */
export const PAWS_3D_PROVIDER_ID = "tripo" as const;

export type Paws3dProviderId = typeof PAWS_3D_PROVIDER_ID;

/**
 * Defers Tripo credential validation until the enabled pipeline performs an
 * operation. Importing the server with MODEL_BUILD_V3_ENABLED=false therefore
 * remains safe even when the documented connection values are blank.
 */
export class LazyConfiguredModelBuildProvider implements ModelBuildProvider {
  private resolvedProvider: ModelBuildProvider | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly createProvider: () => ModelBuildProvider = () => new TripoModelBuildAdapter(),
  ) {}

  get providerId(): string {
    return PAWS_3D_PROVIDER_ID;
  }

  get modelId(): string {
    return this.env.TRIPO_MODEL_VERSION || "default";
  }

  get requiredReferenceViewKinds(): readonly ModelBuildReferenceViewKind[] {
    return ["front", "left", "right", "rear"] as const;
  }

  async preflightForCharge(): Promise<void> {
    await this.resolve().preflightForCharge?.();
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
    if (!this.resolvedProvider) this.resolvedProvider = this.createProvider();
    return this.resolvedProvider;
  }
}

export function createLazyConfiguredModelBuildProvider(
  env: NodeJS.ProcessEnv = process.env,
  createProvider?: () => ModelBuildProvider,
): ModelBuildProvider {
  return new LazyConfiguredModelBuildProvider(env, createProvider);
}
