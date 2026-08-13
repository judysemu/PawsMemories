export interface FulfillmentReadinessInput {
  stripeConfigured: boolean;
  slantConfigured: boolean;
  shopifyConfigured: boolean;
  pawprintProductCount: number;
  storageConfigured: boolean;
  workerConfigured: boolean;
}

export function buildFulfillmentReadiness(input: FulfillmentReadinessInput) {
  return {
    modelPrinting: {
      provider: "slant3d" as const,
      available: Boolean(
        input.slantConfigured && input.stripeConfigured
        && input.storageConfigured && input.workerConfigured,
      ),
    },
    pawprintPrinting: {
      provider: "shopify" as const,
      available: Boolean(
        input.shopifyConfigured && input.storageConfigured && input.pawprintProductCount > 0,
      ),
      productCount: Math.max(0, Math.floor(input.pawprintProductCount)),
    },
  };
}
