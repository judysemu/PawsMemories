import { authedFetch } from "../../api";
import {
  FurBinClientError,
  type FurBinClientCapabilities,
  type FurBinCollection,
  type FurBinItem,
  type FurBinShowcase,
  type FurBinV5Api,
  type LibraryFilters,
  type LibraryPage,
  type MeasuredBadge,
  type PublishShowcaseInput,
} from "./types";

interface ServerItemDto {
  itemUuid: string;
  title: string;
  description: string | null;
  tags: string[];
  dimensions: { width: number; height: number; depth: number; unit: string } | null;
  hasRig: boolean;
  hasFacial: boolean;
  hasAnimations: boolean;
  accessoryCount: number;
  derivativeCount: number;
  storageBytes: number;
  status: "active" | "archived" | "deleted";
  signedViewUrl?: string;
  coverUrl?: string;
  createdAt: string;
  updatedAt: string;
  badges?: MeasuredBadge[];
  currentVersionNumber?: number;
  versions?: FurBinItem["versions"];
  derivatives?: FurBinItem["derivatives"];
  showcase?: FurBinShowcase;
}

interface ServerShowcaseDto extends Omit<FurBinShowcase, never> {}

const capabilities: FurBinClientCapabilities = {
  listCollections: true,
  versionHistory: true,
  rollbackByVersionNumber: true,
  archive: true,
  separatePublicDerivative: true,
  ownerShowcaseLookup: true,
};

function measuredBadges(item: ServerItemDto): MeasuredBadge[] {
  return [
    {
      id: "rig",
      label: "Body rig",
      state: "not_verified",
      evidenceLabel: item.hasRig ? "Rig listed; measured evidence was not returned" : "No measured rig evidence",
    },
    {
      id: "facial",
      label: "Facial rig",
      state: "not_verified",
      evidenceLabel: item.hasFacial ? "Facial rig listed; deformation evidence was not returned" : "No measured facial evidence",
    },
    {
      id: "animation",
      label: "Animation",
      state: "not_verified",
      evidenceLabel: item.hasAnimations ? "Animation listed; measured evidence was not returned" : "No measured animation evidence",
    },
  ];
}

function mapItem(item: ServerItemDto): FurBinItem {
  return {
    itemUuid: item.itemUuid,
    title: item.title,
    description: item.description,
    tags: Array.isArray(item.tags) ? item.tags : [],
    dimensions: item.dimensions,
    badges: Array.isArray(item.badges) ? item.badges : measuredBadges(item),
    accessoryCount: item.accessoryCount,
    derivativeCount: item.derivativeCount,
    storageBytes: item.storageBytes,
    status: item.status,
    signedViewUrl: item.signedViewUrl,
    coverUrl: item.coverUrl,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    currentVersionNumber: item.currentVersionNumber,
    versions: Array.isArray(item.versions) ? item.versions : [],
    derivatives: Array.isArray(item.derivatives) ? item.derivatives : [],
    showcase: item.showcase,
  };
}

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: string; code?: string } | T | null;
  if (!response.ok) {
    const error = body && typeof body === "object" ? body as { error?: string; code?: string } : null;
    throw new FurBinClientError(error?.error || fallback, error?.code || "REQUEST_FAILED", response.status);
  }
  return body as T;
}

function searchQuery(filters: LibraryFilters): string {
  const query = new URLSearchParams();
  if (filters.query?.trim()) query.set("query", filters.query.trim());
  if (filters.tag?.trim()) query.set("tag", filters.tag.trim());
  if (filters.collectionUuid) query.set("collectionUuid", filters.collectionUuid);
  if (filters.hasRig !== undefined) query.set("hasRig", String(filters.hasRig));
  if (filters.hasFacial !== undefined) query.set("hasFacial", String(filters.hasFacial));
  if (filters.hasAnimations !== undefined) query.set("hasAnimations", String(filters.hasAnimations));
  query.set("page", String(filters.page || 1));
  query.set("limit", String(filters.limit || 40));
  return query.toString();
}

export function createHttpFurBinV5Api(): FurBinV5Api {
  return {
    capabilities,

    async searchItems(filters): Promise<LibraryPage> {
      const requestedPage = Math.max(1, Math.trunc(filters.page || 1));
      const requestedLimit = Math.min(100, Math.max(1, Math.trunc(filters.limit || 40)));
      const result = await parseResponse<{ items: ServerItemDto[]; total: number; page?: number; limit?: number }>(
        await authedFetch(`/api/fur-bin/items?${searchQuery(filters)}`),
        "Could not load your Fur Bin.",
      );
      return {
        items: result.items.map(mapItem),
        total: result.total,
        page: Number.isSafeInteger(result.page) && Number(result.page) > 0 ? Number(result.page) : requestedPage,
        limit: Number.isSafeInteger(result.limit) && Number(result.limit) > 0 ? Number(result.limit) : requestedLimit,
      };
    },

    async getItem(itemUuid): Promise<FurBinItem> {
      const item = await parseResponse<ServerItemDto>(
        await authedFetch(`/api/fur-bin/items/${encodeURIComponent(itemUuid)}`),
        "Could not refresh this item.",
      );
      return mapItem(item);
    },

    async listCollections(): Promise<FurBinCollection[]> {
      return parseResponse<FurBinCollection[]>(
        await authedFetch("/api/fur-bin/collections"),
        "Could not load collections.",
      );
    },

    async createCollection(input): Promise<FurBinCollection> {
      return parseResponse<FurBinCollection>(
        await authedFetch("/api/fur-bin/collections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
        "Could not create the collection.",
      );
    },

    async addItemToCollection(collectionUuid, itemUuid): Promise<void> {
      const response = await authedFetch(`/api/fur-bin/collections/${encodeURIComponent(collectionUuid)}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemUuid }),
      });
      if (!response.ok) await parseResponse(response, "Could not add this item to the collection.");
    },

    async rollbackVersion(itemUuid, versionNumber): Promise<FurBinItem> {
      const item = await parseResponse<ServerItemDto>(
        await authedFetch(`/api/fur-bin/items/${encodeURIComponent(itemUuid)}/rollback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ versionNumber }),
        }),
        "Could not change the active version.",
      );
      return mapItem(item);
    },

    async archiveItem(itemUuid): Promise<FurBinItem> {
      const item = await parseResponse<ServerItemDto>(
        await authedFetch(`/api/fur-bin/items/${encodeURIComponent(itemUuid)}/archive`, { method: "POST" }),
        "Could not archive this item.",
      );
      return mapItem(item);
    },

    async publishShowcase(input: PublishShowcaseInput): Promise<FurBinShowcase> {
      return parseResponse<FurBinShowcase>(
        await authedFetch("/api/fur-bin/showcase", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
        "Could not submit this showcase derivative.",
      );
    },

    async unpublishShowcase(showcaseUuid): Promise<void> {
      const response = await authedFetch(`/api/fur-bin/showcase/${encodeURIComponent(showcaseUuid)}/unpublish`, {
        method: "POST",
      });
      if (!response.ok) await parseResponse(response, "Could not unpublish this showcase.");
    },

    async getPublicShowcase(showcaseUuid): Promise<FurBinShowcase> {
      return parseResponse<ServerShowcaseDto>(
        await fetch(`/api/fur-bin/showcase/${encodeURIComponent(showcaseUuid)}`),
        "That public showcase is not available.",
      );
    },
  };
}
