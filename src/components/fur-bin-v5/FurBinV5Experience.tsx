import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  ExternalLink,
  FolderPlus,
  History,
  Image as ImageIcon,
  Library,
  Loader2,
  PackageOpen,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Tag,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { Creation } from "../../types";
import { fetchModelLibrary, type ModelLibraryItem } from "../../api";
import PetModelViewer from "../PetModelViewer";
import { createHttpFurBinV5Api } from "./client";
import type { FurBinCollection, FurBinItem, FurBinV5Api, LibraryFilters } from "./types";
import {
  clampLibraryPage,
  createLatestLibraryRequestGate,
  formatBytes,
  formatDimensions,
  libraryPageCount,
  loadLatestLibraryPage,
  mergeItem,
  normalizeLibraryFilters,
  refreshSignedView,
  rollbackToVersion,
} from "./workflows";
import "./furBinV5.css";

interface FurBinV5ExperienceProps {
  api?: FurBinV5Api;
  creations?: Creation[];
  loadLegacyModels?: () => Promise<ModelLibraryItem[]>;
}

const defaultApi = createHttpFurBinV5Api();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function requestKey(): string {
  return crypto.randomUUID();
}

function Badge({ badge }: { badge: FurBinItem["badges"][number] }) {
  const verified = badge.state === "verified";
  return (
    <span className={`furbin-v5-badge ${verified ? "is-verified" : badge.state === "failed" ? "is-failed" : ""}`} title={badge.evidenceLabel}>
      {verified ? <CheckCircle2 aria-hidden="true" size={13} /> : <Clock3 aria-hidden="true" size={13} />}
      {badge.label}: {verified ? "verified" : badge.state === "failed" ? "failed" : "not verified"}
    </span>
  );
}

/**
 * True when the item's current version is a flat image rather than a 3D model.
 * Fur Bin holds both: generated GLBs and, since the free-first-image work, 2D
 * artwork. The asset registry was already type-agnostic, so the only thing that
 * needed to learn the difference is the renderer.
 */
export function isImageItem(item: FurBinItem): boolean {
  const current =
    item.versions.find((version) => version.isCurrent) ||
    item.versions.find((version) => version.versionNumber === item.currentVersionNumber) ||
    item.versions[0];
  return !!current?.mimeType?.startsWith("image/");
}

function Preview({ item, detail = false }: { item: FurBinItem; detail?: boolean }) {
  // A 2D asset must never reach PetModelViewer: model-viewer cannot decode a
  // PNG and renders an empty stage with no error, which reads as a broken
  // item. For images the signed URL IS the artwork, so show it directly.
  if (isImageItem(item)) {
    const src = item.signedViewUrl || item.coverUrl;
    if (src) {
      return <img className="furbin-v5-preview" src={src} alt={`Artwork: ${item.title}`} />;
    }
    return (
      <div className="furbin-v5-preview furbin-v5-preview-fallback" role="img" aria-label={`${item.title}, preview unavailable`}>
        <ImageIcon aria-hidden="true" size={38} />
        <span>Preview is still preparing</span>
      </div>
    );
  }
  if (detail && item.signedViewUrl) {
    return (
      <PetModelViewer
        src={item.signedViewUrl}
        poster={item.coverUrl}
        alt={`Front-facing 3D model of ${item.title}`}
        autoRotate={false}
        thumbnail={false}
        className="furbin-v5-preview"
      />
    );
  }
  if (item.coverUrl) {
    return <img className="furbin-v5-preview" src={item.coverUrl} alt={`Preview of ${item.title}`} />;
  }
  return (
    <div className="furbin-v5-preview furbin-v5-preview-fallback" role="img" aria-label={`${item.title}, preview unavailable`}>
      <Box aria-hidden="true" size={38} />
      <span>{item.signedViewUrl ? "Open to view in 3D" : "Preview is still preparing"}</span>
    </div>
  );
}

function ItemCard({ item, onOpen, onRetry, onDelete }: {
  item: FurBinItem;
  onOpen: (item: FurBinItem) => void;
  onRetry: (item: FurBinItem) => void;
  onDelete: (item: FurBinItem) => void;
}) {
  return (
    <article className="furbin-v5-card">
      <button type="button" className="furbin-v5-card-open" onClick={() => onOpen(item)} aria-label={`Open ${item.title}`}>
        <Preview item={item} />
        <span className="furbin-v5-scope"><ShieldCheck aria-hidden="true" size={12} /> Private</span>
        <span className="furbin-v5-card-copy">
          <span className="furbin-v5-card-title">{item.title}</span>
          <span className="furbin-v5-card-meta">{formatDimensions(item)}</span>
          <span className="furbin-v5-badge-row">
            {item.badges.filter((badge) => badge.state === "verified").slice(0, 2).map((badge) => <Badge key={badge.id} badge={badge} />)}
            {!item.badges.some((badge) => badge.state === "verified") && <span className="furbin-v5-muted">Details available inside</span>}
          </span>
          <span className="furbin-v5-card-action">View your pet <ChevronRight aria-hidden="true" size={16} /></span>
        </span>
      </button>
      <div className="furbin-v5-item-actions">
        <button type="button" onClick={() => onRetry(item)} disabled={!item.sourceOrderUuid}>
          <Undo2 aria-hidden="true" size={14} /> Retry full build{item.retryPriceCredits ? ` · ${item.retryPriceCredits} PupCoins` : ""}
        </button>
        <button type="button" className="is-danger" onClick={() => onDelete(item)}><Trash2 aria-hidden="true" size={14} /> Delete</button>
      </div>
    </article>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="furbin-v5-empty">
      <PackageOpen aria-hidden="true" size={42} />
      <h2>{filtered ? "No creations match those filters" : "Your Fur Bin is ready"}</h2>
      <p>{filtered ? "Clear a filter or try a broader search." : "Your 3D pets, photos, videos, and Pawprints will appear here automatically."}</p>
    </div>
  );
}

function LegacyModelCard({ model }: { model: ModelLibraryItem }) {
  const modelUrl = model.rigged_model_url || model.model_url || "";
  return (
    <article className="furbin-v5-card furbin-v5-legacy-card">
      <div className="furbin-v5-legacy-preview">
        <PetModelViewer
          src={modelUrl}
          poster={model.image_url || undefined}
          alt={`Front-facing 3D model of ${model.name || "your pet"}`}
          autoRotate={false}
          thumbnail={Boolean(model.image_url)}
          className="furbin-v5-preview"
        />
      </div>
      <div className="furbin-v5-card-copy">
        <strong className="furbin-v5-card-title">{model.name || "Your 3D pet"}</strong>
        <span className="furbin-v5-card-meta">{model.breed || "Saved model"} · {new Date(model.created_at).toLocaleDateString()}</span>
        <a className="furbin-v5-secondary" href={modelUrl} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" size={15} /> Open model</a>
      </div>
    </article>
  );
}

function PastCreationCard({ creation }: { creation: Creation }) {
  const url = creation.video_url || creation.image_url || creation.model_url || "";
  const isVideo = Boolean(creation.video_url);
  return (
    <article className="furbin-v5-memory-card">
      {isVideo
        ? <video src={url} controls preload="metadata" aria-label={creation.name || "Saved pet video"} />
        : <img src={url} alt={creation.name || creation.pet_name || "Saved pet creation"} loading="lazy" />}
      <div><strong>{creation.name || creation.pet_name || creation.preset_name || "Saved creation"}</strong><span>{new Date(creation.created_at).toLocaleDateString()}</span></div>
    </article>
  );
}

function ItemDetail({ api, initialItem, collections, onClose, onChanged, onRetry, onDelete }: {
  api: FurBinV5Api;
  initialItem: FurBinItem;
  collections: FurBinCollection[];
  onClose: () => void;
  onChanged: (item: FurBinItem) => void;
  onRetry: (item: FurBinItem) => void;
  onDelete: (item: FurBinItem) => void;
}) {
  const [item, setItem] = useState(initialItem);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [collectionUuid, setCollectionUuid] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const commitItem = (updated: FurBinItem) => { setItem(updated); onChanged(updated); };
  const run = async (name: string, action: () => Promise<void>) => {
    setBusyAction(name); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusyAction(null); }
  };
  const refresh = () => run("refresh", async () => {
    const updated = await refreshSignedView(api, item.itemUuid);
    commitItem({ ...item, ...updated, versions: updated.versions.length ? updated.versions : item.versions, derivatives: updated.derivatives.length ? updated.derivatives : item.derivatives });
    setNotice("The secure model viewer has been refreshed.");
  });

  return (
    <div className="furbin-v5-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="furbin-v5-modal" role="dialog" aria-modal="true" aria-labelledby="furbin-v5-detail-title">
        <header className="furbin-v5-modal-header">
          <div><p className="furbin-v5-eyebrow">Private · {formatBytes(item.storageBytes)}</p><h2 id="furbin-v5-detail-title">{item.title}</h2></div>
          <button ref={closeButtonRef} type="button" className="furbin-v5-icon-button" onClick={onClose} aria-label="Close item details"><X aria-hidden="true" /></button>
        </header>

        <div className="furbin-v5-detail-layout">
          <div className="furbin-v5-detail-preview">
            <Preview item={item} detail />
            <p><ShieldCheck aria-hidden="true" size={14} /> This pet model is private to your account and faces you when the viewer opens.</p>
            <div className="furbin-v5-view-actions">
              {item.signedViewUrl
                ? <a className="furbin-v5-primary" href={item.signedViewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" size={16} /> Open model file</a>
                : <span className="furbin-v5-muted">The secure model link is still preparing.</span>}
              <button type="button" className="furbin-v5-secondary" onClick={refresh} disabled={busyAction !== null}><RefreshCw aria-hidden="true" size={15} className={busyAction === "refresh" ? "furbin-v5-spin" : ""} /> Refresh viewer</button>
            </div>
          </div>
          <div className="furbin-v5-detail-copy">
            <p>Your model, textures, rig, and every saved version stay attached to your account.</p>
            <div className="furbin-v5-tags">{item.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
            <dl className="furbin-v5-facts">
              <div><dt>Measured size</dt><dd>{formatDimensions(item)}</dd></div>
              <div><dt>Accessories</dt><dd>{item.accessoryCount}</dd></div>
              <div><dt>Related files</dt><dd>{item.derivativeCount}</dd></div>
              <div><dt>Updated</dt><dd>{new Date(item.updatedAt).toLocaleDateString()}</dd></div>
            </dl>
            <h3>Model details</h3>
            <div className="furbin-v5-badge-stack">{item.badges.map((badge) => <Badge key={badge.id} badge={badge} />)}</div>
          </div>
        </div>

        <div className="furbin-v5-detail-sections">
          <section className="furbin-v5-detail-section" aria-labelledby="furbin-v5-versions">
            <div className="furbin-v5-section-title"><History aria-hidden="true" size={18} /><h3 id="furbin-v5-versions">Version history</h3></div>
            {item.versions.length ? <ol className="furbin-v5-version-list">{item.versions.map((version) => (
              <li key={version.versionNumber}>
                <span><strong>Version {version.versionNumber}</strong><small>{formatBytes(version.sizeBytes)} · {new Date(version.createdAt).toLocaleDateString()}</small></span>
                {version.isCurrent ? <span className="furbin-v5-current">Current</span> : <button type="button" className="furbin-v5-text-button" disabled={!api.capabilities.rollbackByVersionNumber || busyAction !== null} onClick={() => run(`rollback-${version.versionNumber}`, async () => { const updated = await rollbackToVersion(api, item.itemUuid, version.versionNumber); commitItem(updated); setNotice(`Version ${version.versionNumber} is now current.`); })}><RotateCcw aria-hidden="true" size={14} /> Make current</button>}
              </li>
            ))}</ol> : <p className="furbin-v5-capability-note">This model has one saved version.</p>}
          </section>

          <section className="furbin-v5-detail-section" aria-labelledby="furbin-v5-collections">
            <div className="furbin-v5-section-title"><FolderPlus aria-hidden="true" size={18} /><h3 id="furbin-v5-collections">Add to collection</h3></div>
            {collections.length ? <div className="furbin-v5-inline-form">
              <select aria-label="Collection" value={collectionUuid} onChange={(event) => setCollectionUuid(event.target.value)}><option value="">Choose a collection</option>{collections.map((collection) => <option key={collection.collectionUuid} value={collection.collectionUuid}>{collection.name}</option>)}</select>
              <button type="button" className="furbin-v5-secondary" disabled={!collectionUuid || busyAction !== null} onClick={() => run("collection", async () => { await api.addItemToCollection(collectionUuid, item.itemUuid); setNotice("Added to the collection."); })}>Add</button>
            </div> : <p className="furbin-v5-capability-note">Create a collection from the library toolbar, then add this model.</p>}
          </section>
        </div>

        {(error || notice) && <p className={error ? "furbin-v5-message is-error" : "furbin-v5-message"} role="status">{error || notice}</p>}
        <footer className="furbin-v5-modal-footer">
          <button type="button" className="furbin-v5-secondary" disabled={!item.sourceOrderUuid} onClick={() => onRetry(item)}><Undo2 aria-hidden="true" size={16} /> Retry full build{item.retryPriceCredits ? ` · ${item.retryPriceCredits} PupCoins` : ""}</button>
          <button type="button" className="furbin-v5-danger" onClick={() => onDelete(item)}><Trash2 aria-hidden="true" size={16} /> Delete</button>
        </footer>
      </section>
    </div>
  );
}

export function FurBinV5Experience({ api = defaultApi, creations = [], loadLegacyModels = fetchModelLibrary }: FurBinV5ExperienceProps) {
  const [items, setItems] = useState<FurBinItem[]>([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<LibraryFilters>({ page: 1, limit: 40 });
  const [draftQuery, setDraftQuery] = useState("");
  const [collections, setCollections] = useState<FurBinCollection[]>([]);
  const [selected, setSelected] = useState<FurBinItem | null>(null);
  const [legacyModels, setLegacyModels] = useState<ModelLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [collectionName, setCollectionName] = useState("");
  const [retryBusy, setRetryBusy] = useState<string | null>(null);
  const [deleteItem, setDeleteItem] = useState<FurBinItem | null>(null);
  const [deleteStep, setDeleteStep] = useState<"confirm" | "done" | "report">("confirm");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [defectSubject, setDefectSubject] = useState("");
  const [defectMessage, setDefectMessage] = useState("");
  const [defectError, setDefectError] = useState("");
  const libraryRequestGateRef = useRef(createLatestLibraryRequestGate());

  const load = async (nextFilters = filters) => {
    const normalized = normalizeLibraryFilters(nextFilters);
    await loadLatestLibraryPage(api, normalized, libraryRequestGateRef.current, {
      start: () => { setLoading(true); setError(""); },
      success: (result) => {
        const clampedPage = clampLibraryPage(result.total, result.page, result.limit);
        if (clampedPage !== result.page) { const clampedFilters = { ...normalized, page: clampedPage, limit: result.limit }; setFilters(clampedFilters); void load(clampedFilters); return; }
        setItems(result.items); setTotal(result.total); setFilters({ ...normalized, page: result.page, limit: result.limit });
      },
      failure: (cause) => setError(errorMessage(cause)),
      finish: () => setLoading(false),
    });
  };

  useEffect(() => {
    let active = true;
    void load(filters);
    loadLegacyModels().then((models) => { if (active) setLegacyModels(models); }).catch(() => { if (active) setLegacyModels([]); });
    if (api.capabilities.listCollections) api.listCollections().then((next) => { if (active) setCollections(next); }).catch(() => { if (active) setCollections([]); });
    return () => { active = false; libraryRequestGateRef.current.invalidate(); };
    // API and loader are injectable test seams.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, loadLegacyModels]);

  const openItem = async (item: FurBinItem) => {
    setSelected(item);
    try {
      const detail = await api.getItem(item.itemUuid);
      const merged = { ...item, ...detail, versions: detail.versions.length ? detail.versions : item.versions, derivatives: detail.derivatives.length ? detail.derivatives : item.derivatives };
      setSelected(merged); setItems((current) => mergeItem(current, merged));
    } catch { /* Search result remains usable while a link refreshes. */ }
  };
  const updateFilter = (next: LibraryFilters) => { const normalized = normalizeLibraryFilters(next); setFilters(normalized); void load(normalized); };
  const openDelete = (item: FurBinItem) => { setSelected(null); setDeleteItem(item); setDeleteStep("confirm"); setDefectSubject(`Problem with ${item.title}`); setDefectMessage(""); setDefectError(""); };
  const confirmDelete = async () => {
    if (!deleteItem) return;
    setDeleteBusy(true); setDefectError("");
    try {
      await api.deleteItem(deleteItem.itemUuid);
      setItems((current) => current.filter((item) => item.itemUuid !== deleteItem.itemUuid));
      setTotal((current) => Math.max(0, current - 1));
      setDeleteStep("done");
    } catch (cause) { setDefectError(errorMessage(cause)); } finally { setDeleteBusy(false); }
  };
  const submitDefect = async (event: React.FormEvent) => {
    event.preventDefault(); if (!deleteItem) return;
    setDeleteBusy(true); setDefectError("");
    try {
      const result = await api.submitDefectReport(deleteItem.itemUuid, { subject: defectSubject.trim(), message: defectMessage.trim() });
      setDeleteItem(null);
      if (!result.emailSent) setError("Your message is saved for the admin. Email delivery is waiting for the site mail connection.");
    } catch (cause) { setDefectError(errorMessage(cause)); } finally { setDeleteBusy(false); }
  };
  const retryFull = async (item: FurBinItem) => {
    if (!item.sourceOrderUuid || retryBusy) return;
    setRetryBusy(item.itemUuid); setError("");
    try {
      const result = await api.retryFullOrder(item.sourceOrderUuid, requestKey());
      window.location.assign(`/pet-glb?order=${encodeURIComponent(result.orderUuid)}`);
    } catch (cause) { setError(errorMessage(cause)); setRetryBusy(null); }
  };

  const hasFilters = Boolean(filters.query || filters.tag || filters.collectionUuid || filters.hasRig || filters.hasFacial || filters.hasAnimations);
  const availableTags = [...new Set(items.flatMap((item) => item.tags))].sort().slice(0, 10);
  const currentPage = clampLibraryPage(total, filters.page || 1, filters.limit || 40);
  const totalPages = libraryPageCount(total, filters.limit || 40);
  const currentAssetUuids = new Set(items.map((item) => item.assetUuid).filter(Boolean));
  const earlierModels = legacyModels.filter((model) => !model.canonical_asset_uuid || !currentAssetUuids.has(model.canonical_asset_uuid));
  const modelCreationIds = new Set(legacyModels.filter((model) => model.source_type === "creation").map((model) => Number(model.id)));
  const earlierCreations = useMemo(() => creations.filter((creation) => {
    if (!(creation.video_url || creation.image_url || creation.model_url)) return false;
    return creation.media_type !== "model" || !modelCreationIds.has(Number(creation.id));
  }), [creations, legacyModels]);
  const visibleTotal = total + earlierModels.length + earlierCreations.length;

  return (
    <main className="furbin-v5-shell">
      <div className="furbin-v5-orb furbin-v5-orb-one" aria-hidden="true" /><div className="furbin-v5-orb furbin-v5-orb-two" aria-hidden="true" />
      <header className="furbin-v5-hero">
        <div><h1>Fur Bin</h1><p>Your private home for every 3D pet, photo, video, and Pawprint you have made.</p></div>
        <div className="furbin-v5-total" aria-label={`${visibleTotal} saved creations`}><strong>{visibleTotal}</strong><span>saved creations</span></div>
      </header>

      <section className="furbin-v5-toolbar" aria-label="Library search and filters">
        <form className="furbin-v5-search" role="search" onSubmit={(event) => { event.preventDefault(); updateFilter({ ...filters, query: draftQuery, page: 1 }); }}>
          <Search aria-hidden="true" size={18} /><label className="sr-only" htmlFor="furbin-v5-search">Search your creations</label><input id="furbin-v5-search" type="search" value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} placeholder="Search names and descriptions" /><button type="submit">Search</button>
        </form>
        <div className="furbin-v5-filter-row" aria-label="Model filters">
          {([["hasRig", "Body rig"], ["hasFacial", "Face details"], ["hasAnimations", "Animation"]] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={filters[key] === true} onClick={() => updateFilter({ ...filters, [key]: filters[key] ? undefined : true, page: 1 })}>{label}</button>)}
          <button type="button" onClick={() => setCollectionOpen((current) => !current)}><FolderPlus aria-hidden="true" size={15} /> New collection</button>
          {hasFilters && <button type="button" onClick={() => { setDraftQuery(""); updateFilter({ page: 1, limit: 40 }); }}>Clear filters</button>}
        </div>
        {collectionOpen && <form className="furbin-v5-collection-form" onSubmit={(event) => { event.preventDefault(); const name = collectionName.trim(); if (!name) return; api.createCollection({ name }).then((collection) => { setCollections((current) => [...current, collection]); setCollectionName(""); setCollectionOpen(false); }).catch((cause) => setError(errorMessage(cause))); }}><label htmlFor="furbin-v5-collection-name">Collection name</label><input id="furbin-v5-collection-name" required maxLength={200} value={collectionName} onChange={(event) => setCollectionName(event.target.value)} /><button className="furbin-v5-primary" type="submit">Create</button></form>}
        {collections.length > 0 && <div className="furbin-v5-collection-chips" aria-label="Filter by collection">{collections.map((collection) => <button type="button" key={collection.collectionUuid} aria-pressed={filters.collectionUuid === collection.collectionUuid} onClick={() => updateFilter({ ...filters, collectionUuid: filters.collectionUuid === collection.collectionUuid ? undefined : collection.collectionUuid, page: 1 })}>{collection.name}</button>)}</div>}
        {availableTags.length > 0 && <div className="furbin-v5-tag-chips" aria-label="Filter by tag"><Tag aria-hidden="true" size={15} />{availableTags.map((tag) => <button type="button" key={tag} aria-pressed={filters.tag === tag} onClick={() => updateFilter({ ...filters, tag: filters.tag === tag ? undefined : tag, page: 1 })}>#{tag}</button>)}</div>}
      </section>

      {error && <div className="furbin-v5-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>Try again</button></div>}
      {loading ? <div className="furbin-v5-loading" role="status"><Loader2 aria-hidden="true" className="furbin-v5-spin" /><span>Opening your Fur Bin…</span></div> : items.length ? <section className="furbin-v5-grid" aria-label="Your newest 3D pets">{items.map((item) => <ItemCard key={item.itemUuid} item={item} onOpen={openItem} onRetry={(target) => void retryFull(target)} onDelete={openDelete} />)}</section> : earlierModels.length || earlierCreations.length ? null : <EmptyState filtered={hasFilters} />}
      {retryBusy && <p className="furbin-v5-message furbin-v5-centered" role="status">Starting a new full-price build with the same pet photos…</p>}
      {totalPages > 1 && <nav className="furbin-v5-pagination" aria-label="Private library pages"><button type="button" aria-label="Previous library page" disabled={loading || currentPage <= 1} onClick={() => updateFilter({ ...filters, page: currentPage - 1 })}>Previous</button><span>Page {currentPage} of {totalPages}</span><button type="button" aria-label="Next library page" disabled={loading || currentPage >= totalPages} onClick={() => updateFilter({ ...filters, page: currentPage + 1 })}>Next</button></nav>}

      {earlierModels.length > 0 && <section className="furbin-v5-history-section" aria-labelledby="furbin-older-models"><div className="furbin-v5-history-title"><Library aria-hidden="true" size={18} /><div><h2 id="furbin-older-models">Your earlier 3D pets</h2><p>Models made before the current Fur Bin are restored here.</p></div></div><div className="furbin-v5-grid">{earlierModels.map((model) => <LegacyModelCard key={`${model.source_type}-${model.id}`} model={model} />)}</div></section>}
      {earlierCreations.length > 0 && <section className="furbin-v5-history-section" aria-labelledby="furbin-older-creations"><div className="furbin-v5-history-title"><History aria-hidden="true" size={18} /><div><h2 id="furbin-older-creations">Photos, videos & Pawprints</h2><p>Your past creations remain part of your account.</p></div></div><div className="furbin-v5-memory-grid">{earlierCreations.map((creation) => <PastCreationCard key={creation.id} creation={creation} />)}</div></section>}

      {selected && <ItemDetail api={api} initialItem={selected} collections={collections} onClose={() => setSelected(null)} onRetry={(target) => void retryFull(target)} onDelete={openDelete} onChanged={(updated) => { setSelected(updated); setItems((current) => mergeItem(current, updated)); }} />}
      {deleteItem && <div className="furbin-v5-modal-backdrop" role="presentation"><section className="furbin-v5-feedback-form" role="dialog" aria-modal="true" aria-labelledby="furbin-delete-title">
        <button type="button" className="furbin-v5-icon-button furbin-v5-feedback-close" onClick={() => !deleteBusy && setDeleteItem(null)} disabled={deleteBusy} aria-label="Close"><X aria-hidden="true" /></button>
        {deleteStep === "confirm" && <><p className="furbin-v5-eyebrow">Remove from your view</p><h2 id="furbin-delete-title">Delete {deleteItem.title}?</h2><p>It will disappear from your Fur Bin. Its private asset and history remain tracked so an account or support issue can still be investigated.</p>{defectError && <p className="furbin-v5-message is-error" role="alert">{defectError}</p>}<div className="furbin-v5-feedback-actions"><button type="button" className="furbin-v5-secondary" onClick={() => setDeleteItem(null)} disabled={deleteBusy}>Cancel</button><button type="button" className="furbin-v5-danger" onClick={() => void confirmDelete()} disabled={deleteBusy}>{deleteBusy ? "Deleting…" : "Yes, delete"}</button></div></>}
        {deleteStep === "done" && <><p className="furbin-v5-eyebrow">Removed from Fur Bin</p><h2 id="furbin-delete-title">Would you like to report a defect?</h2><p>This is optional. Your account, order, asset, version, provider job, and file hash will be attached automatically.</p><div className="furbin-v5-feedback-actions"><button type="button" className="furbin-v5-secondary" onClick={() => setDeleteItem(null)}>No thanks</button><button type="button" className="furbin-v5-primary" onClick={() => setDeleteStep("report")}>Send a message</button></div></>}
        {deleteStep === "report" && <form onSubmit={submitDefect}><p className="furbin-v5-eyebrow">Private message to Pawsome3D</p><h2 id="furbin-delete-title">What went wrong?</h2><p>You do not need to add your account or order details; they are attached automatically.</p><label>Subject<input required minLength={3} maxLength={200} value={defectSubject} onChange={(event) => setDefectSubject(event.target.value)} /></label><label>Details<textarea required minLength={10} maxLength={4000} rows={7} value={defectMessage} onChange={(event) => setDefectMessage(event.target.value)} placeholder="Tell us what looked wrong and what you expected." /></label>{defectError && <p className="furbin-v5-message is-error" role="alert">{defectError}</p>}<div className="furbin-v5-feedback-actions"><button type="button" className="furbin-v5-secondary" onClick={() => setDeleteItem(null)} disabled={deleteBusy}>Cancel</button><button type="submit" className="furbin-v5-primary" disabled={deleteBusy || defectSubject.trim().length < 3 || defectMessage.trim().length < 10}>{deleteBusy ? "Sending…" : "Send to admin"}</button></div></form>}
      </section></div>}
    </main>
  );
}
