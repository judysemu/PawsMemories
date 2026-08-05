import { TripoModelBuildAdapter } from "../model-builds/provider";
import { TrellisModelBuildAdapter } from "../model-builds/trellisProvider";
import { skuRegistry, registerDefaultSkus, type SkuRegistry } from "./skuRegistry";
import { InHousePetGenerationAdapter } from "./inHouseAdapter";
import { TripoPetGenerationAdapter } from "./tripoAdapter";
import { StubPetGenerationProvider } from "./stubProvider";
import {
  type PetModelGenerationProvider,
  type ProviderJobStore,
  InMemoryJobStore,
  PetGenerationError,
} from "./provider";

let defaultsRegistered = false;

export class PetGlbFeatureError extends Error {
  constructor() {
    super("CUSTOM_RIGGED_PET_GLB_V1 is disabled until PET_GLB_ENABLED=true");
    this.name = "PetGlbFeatureError";
  }
}

/**
 * Resolve a provider for a SKU.
 *
 * Order matters: the SKU is resolved FIRST, so an unregistered SKU fails
 * closed even when the stub override is active. Checking the stub flag first
 * would let unknown SKUs silently succeed in CI — the opposite of the
 * fail-closed requirement.
 *
 * Nothing DB-touching is constructed at module import time.
 */
export function createProviderForSku(
  sku: string,
  options: { store?: ProviderJobStore; registry?: SkuRegistry } = {},
): PetModelGenerationProvider {
  if (process.env.PET_GLB_ENABLED !== "true") throw new PetGlbFeatureError();
  const registry = options.registry ?? skuRegistry;
  if (registry === skuRegistry && !defaultsRegistered) {
    registerDefaultSkus(registry);
    defaultsRegistered = true;
  }

  // Fail closed BEFORE any override is considered.
  const binding = registry.resolve(sku);
  const externalProviders = new Set(
    String(process.env.PAWS_3D_EXTERNAL_PROVIDER_IDS || "tripo")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (process.env.PAWS_3D_INHOUSE_ONLY === "true" && externalProviders.has(binding.providerId.toLowerCase())) {
    throw new PetGenerationError(
      "INHOUSE_PROVIDER_REQUIRED",
      `In-house-only mode rejects providerId '${binding.providerId}' for SKU ${sku}`,
    );
  }

  if (process.env.PET_GLB_USE_STUB === "true") {
    console.log(
      `[ProviderFactory] stub override active sku=${sku} (binding was providerId=${binding.providerId})`,
    );
    return new StubPetGenerationProvider();
  }

  console.log(
    `[ProviderFactory] sku=${sku} providerId=${binding.providerId} providerVersion=${binding.providerVersion}`,
  );

  if (binding.providerId === "tripo") {
    return new TripoPetGenerationAdapter(
      new TripoModelBuildAdapter(),
      options.store ?? new InMemoryJobStore(),
      binding.providerVersion,
      // Reference approval starts the paid build. Base and texture remain
      // explicit stages; the purchased body-rig stage internally completes
      // Tripo's idle/walk presets without another customer gate.
      { animate: false },
    );
  }

  if (binding.providerId === "trellis2") {
    return new InHousePetGenerationAdapter(
      new TrellisModelBuildAdapter(),
      options.store ?? new InMemoryJobStore(),
      binding.providerVersion,
    );
  }

  throw new PetGenerationError(
    "UNSUPPORTED_PROVIDER",
    `Unsupported providerId '${binding.providerId}' for SKU ${sku}`,
  );
}

/** Test seam: reset memoised default registration. */
export function resetProviderFactoryForTests(): void {
  defaultsRegistered = false;
}
