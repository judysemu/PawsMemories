export interface ShopifyStoreVariant {
  id: string;
  title: string;
  price: string;
  availableForSale: boolean;
  sellableOnlineQuantity: number;
}

export interface ShopifyStoreProduct {
  id: string;
  handle: string;
  title: string;
  description: string;
  featuredImageUrl: string | null;
  featuredImageAlt: string | null;
  minPrice: string;
  maxPrice: string;
  currencyCode: string;
  availableForSale: boolean;
  published: boolean;
  productUrl: string;
  pawprintPersonalizable: boolean;
  variants: ShopifyStoreVariant[];
  shopifyUpdatedAt: string;
  lastSyncedAt?: string;
}

export interface ShopifyCatalogSyncResult {
  runId: number;
  productCount: number;
  durationMs: number;
  completedAt: string;
}

export interface ShopifyCatalogSyncStatus {
  id: number;
  status: "running" | "succeeded" | "failed";
  productCount: number;
  durationMs: number | null;
  errorSummary: string | null;
  startedAt: string;
  completedAt: string | null;
}
