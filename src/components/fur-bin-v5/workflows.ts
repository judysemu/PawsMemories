import type {
  FurBinItem,
  FurBinShowcase,
  FurBinV5Api,
  LibraryFilters,
  LibraryPage,
  PublishShowcaseInput,
} from "./types";

export function normalizeLibraryFilters(filters: LibraryFilters): LibraryFilters {
  return {
    query: filters.query?.trim() || undefined,
    tag: filters.tag?.trim().toLowerCase() || undefined,
    collectionUuid: filters.collectionUuid || undefined,
    hasRig: filters.hasRig,
    hasFacial: filters.hasFacial,
    hasAnimations: filters.hasAnimations,
    page: Math.max(1, filters.page || 1),
    limit: Math.min(100, Math.max(1, filters.limit || 40)),
  };
}

export async function loadPrivateLibrary(
  api: Pick<FurBinV5Api, "searchItems">,
  filters: LibraryFilters,
): Promise<LibraryPage> {
  const normalized = normalizeLibraryFilters(filters);
  const result = await api.searchItems(normalized);
  return {
    ...result,
    page: Number.isSafeInteger(result.page) && result.page > 0 ? result.page : normalized.page!,
    limit: Number.isSafeInteger(result.limit) && result.limit > 0 ? result.limit : normalized.limit!,
  };
}

export interface LatestLibraryRequestGate {
  begin(): number;
  isCurrent(requestId: number): boolean;
  invalidate(): void;
}

export interface LibraryLoadSink {
  start(): void;
  success(result: LibraryPage): void;
  failure(error: Error): void;
  finish(): void;
}

export function createLatestLibraryRequestGate(): LatestLibraryRequestGate {
  let latestRequestId = 0;
  return {
    begin: () => ++latestRequestId,
    isCurrent: (requestId) => requestId === latestRequestId,
    invalidate: () => { latestRequestId += 1; },
  };
}

export async function loadLatestLibraryPage(
  api: Pick<FurBinV5Api, "searchItems">,
  filters: LibraryFilters,
  gate: LatestLibraryRequestGate,
  sink: LibraryLoadSink,
): Promise<void> {
  const requestId = gate.begin();
  sink.start();
  try {
    const result = await loadPrivateLibrary(api, filters);
    if (gate.isCurrent(requestId)) sink.success(result);
  } catch (cause) {
    if (gate.isCurrent(requestId)) {
      sink.failure(cause instanceof Error ? cause : new Error("Could not load your Fur Bin."));
    }
  } finally {
    if (gate.isCurrent(requestId)) sink.finish();
  }
}

export function libraryPageCount(total: number, limit: number): number {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;
  return Math.max(1, Math.ceil(safeTotal / safeLimit));
}

export function clampLibraryPage(total: number, page: number, limit: number): number {
  const requested = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
  return Math.min(requested, libraryPageCount(total, limit));
}

export async function refreshSignedView(api: FurBinV5Api, itemUuid: string): Promise<FurBinItem> {
  return api.getItem(itemUuid);
}

export async function rollbackToVersion(
  api: FurBinV5Api,
  itemUuid: string,
  versionNumber: number,
): Promise<FurBinItem> {
  if (!api.capabilities.rollbackByVersionNumber) {
    return api.rollbackVersion(itemUuid, versionNumber);
  }
  if (!Number.isInteger(versionNumber) || versionNumber < 1) throw new Error("Invalid version number.");
  return api.rollbackVersion(itemUuid, versionNumber);
}

export async function archivePrivateItem(api: FurBinV5Api, itemUuid: string): Promise<FurBinItem> {
  return api.archiveItem(itemUuid);
}

export async function publishPublicDerivative(
  api: FurBinV5Api,
  input: PublishShowcaseInput,
): Promise<FurBinShowcase> {
  if (!input.publicDerivativeUuid || input.publicDerivativeVersionNumber < 1) {
    throw new Error("A validated public derivative is required.");
  }
  return api.publishShowcase(input);
}

export function mergeItem(items: FurBinItem[], updated: FurBinItem): FurBinItem[] {
  return items.map((item) => item.itemUuid === updated.itemUuid ? updated : item);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatDimensions(item: FurBinItem): string {
  const value = item.dimensions;
  if (!value) return "Dimensions not measured";
  return `${value.width} × ${value.height} × ${value.depth} ${value.unit}`;
}
