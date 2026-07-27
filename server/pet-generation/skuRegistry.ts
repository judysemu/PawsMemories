import { PetGenerationError } from "./provider";

export interface SkuProviderBinding {
  providerId: string;
  providerVersion: string;
}

/**
 * SKU -> provider binding. Resolution is explicit, logged, versioned, and
 * FAILS CLOSED: an unregistered SKU throws rather than falling back to a
 * default provider.
 *
 * No module-level registration side effect — call registerDefaultSkus()
 * explicitly. Import-time mutation makes resolution order-dependent and is
 * the same class of problem that previously crashed server boot under
 * DB_DISABLED=1 (spatial-generator storage.ts / routes.ts eager singletons).
 */
export class SkuRegistry {
  private bindings = new Map<string, SkuProviderBinding>();

  register(sku: string, binding: SkuProviderBinding): void {
    this.bindings.set(sku, binding);
    console.log(
      `[SkuRegistry] registered sku=${sku} providerId=${binding.providerId} providerVersion=${binding.providerVersion}`,
    );
  }

  resolve(sku: string): SkuProviderBinding {
    const binding = this.bindings.get(sku);
    if (!binding) {
      // Fail closed. No default.
      throw new PetGenerationError(
        "SKU_NOT_REGISTERED",
        `SKU '${sku}' is not registered; refusing to select a default provider`,
      );
    }
    console.log(
      `[SkuRegistry] resolved sku=${sku} providerId=${binding.providerId} providerVersion=${binding.providerVersion}`,
    );
    return { ...binding };
  }

  has(sku: string): boolean {
    return this.bindings.has(sku);
  }

  clear(): void {
    this.bindings.clear();
  }
}

export const skuRegistry = new SkuRegistry();

/** Gate A / Path 1: the first paid SKU resolves to the approved Tripo adapter. */
export const CUSTOM_RIGGED_PET_GLB_V1 = "CUSTOM_RIGGED_PET_GLB_V1";

export function registerDefaultSkus(registry: SkuRegistry = skuRegistry): void {
  registry.register(CUSTOM_RIGGED_PET_GLB_V1, {
    providerId: "tripo",
    providerVersion: process.env.TRIPO_MODEL_VERSION || "default",
  });
}
