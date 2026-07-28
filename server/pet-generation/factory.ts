import { TripoModelBuildAdapter } from "../model-builds/provider";
import { assertPetGlbEnabled } from "./featureFlag";
import { skuRegistry, registerDefaultSkus, type SkuRegistry } from "./skuRegistry";
import { TripoPetGenerationAdapter } from "./tripoAdapter";
import { StubPetGenerationProvider } from "./stubProvider";
import {
  type PetModelGenerationProvider,
  type ProviderJobStore,
  InMemoryJobStore,
  PetGenerationError,
} from "./provider";

let defaultsRegistered = false;

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
  assertPetGlbEnabled();

  const registry = options.registry ?? skuRegistry;
  if (registry === skuRegistry && !defaultsRegistered) {
    registerDefaultSkus(registry);
    defaultsRegistered = true;
  }

  // Fail closed BEFORE any override is considered.
  const binding = registry.resolve(sku);

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
      // Run the animated pipeline (base → rig → idle/walk → merge) so the
      // delivered GLB carries real idle+walk clips. Opt out with
      // PET_GLB_ANIMATE=0 for a bare single-shot model.
      { animate: process.env.PET_GLB_ANIMATE !== "0" },
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
