import React, { useEffect, useRef, useState } from "react";
import {
  Archive,
  Box,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  ExternalLink,
  FolderPlus,
  History,
  Heart,
  ImageOff,
  Library,
  Loader2,
  PackageOpen,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { createHttpFurBinV5Api } from "./client";
import type {
  FurBinCollection,
  FurBinItem,
  FurBinShowcase,
  FurBinV5Api,
  LibraryFilters,
  PublishShowcaseInput,
} from "./types";
import {
  archivePrivateItem,
  clampLibraryPage,
  createLatestLibraryRequestGate,
  formatBytes,
  formatDimensions,
  libraryPageCount,
  loadLatestLibraryPage,
  mergeItem,
  normalizeLibraryFilters,
  publishPublicDerivative,
  refreshSignedView,
  rollbackToVersion,
} from "./workflows";
import "./furBinV5.css";

interface FurBinV5ExperienceProps {
  api?: FurBinV5Api;
}

type View = "library" | "showcase";

const defaultApi = createHttpFurBinV5Api();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function Badge({ badge }: { badge: FurBinItem["badges"][number] }) {
  const verified = badge.state === "verified";
  return (
    <span
      className={`furbin-v5-badge ${verified ? "is-verified" : badge.state === "failed" ? "is-failed" : ""}`}
      title={badge.evidenceLabel}
    >
      {verified ? <CheckCircle2 aria-hidden="true" size={13} /> : <Clock3 aria-hidden="true" size={13} />}
      {badge.label}: {verified ? "verified" : badge.state === "failed" ? "failed" : "not verified"}
    </span>
  );
}

function Preview({ item, className = "" }: { item: FurBinItem; className?: string }) {
  if (item.coverUrl) {
    return <img className={`furbin-v5-preview ${className}`} src={item.coverUrl} alt={`Preview of ${item.title}`} />;
  }
  return (
    <div className={`furbin-v5-preview furbin-v5-preview-fallback ${className}`} role="img" aria-label={`${item.title}, preview unavailable`}>
      <Box aria-hidden="true" size={38} />
      <span>3D asset</span>
    </div>
  );
}

function ItemCard({
  item,
  onOpen,
  onKeep,
  onToss,
}: {
  item: FurBinItem;
  onOpen: (item: FurBinItem) => void;
  onKeep: (item: FurBinItem) => void;
  onToss: (item: FurBinItem) => void;
}) {
  return (
    <article className="furbin-v5-card">
      <button type="button" className="furbin-v5-card-open" onClick={() => onOpen(item)} aria-label={`Open ${item.title}`}>
        <Preview item={item} />
        <span className="furbin-v5-scope"><ShieldCheck aria-hidden="true" size={12} /> Private source</span>
        <span className="furbin-v5-card-copy">
          <span className="furbin-v5-card-title">{item.title}</span>
          <span className="furbin-v5-card-meta">{formatDimensions(item)}</span>
          <span className="furbin-v5-badge-row">
            {item.badges.filter((badge) => badge.state === "verified").slice(0, 2).map((badge) => <Badge key={badge.id} badge={badge} />)}
            {!item.badges.some((badge) => badge.state === "verified") && <span className="furbin-v5-muted">Measurements pending</span>}
          </span>
          <span className="furbin-v5-card-action">View details <ChevronRight aria-hidden="true" size={16} /></span>
        </span>
      </button>
      <div className="furbin-v5-feedback-callout">
        <strong>How is it?</strong>
        <div>
          <button type="button" className={item.feedbackDecision === "keep" ? "is-selected" : ""} onClick={() => onKeep(item)}><Heart aria-hidden="true" size={14} /> Keep it</button>
          <button type="button" className={item.feedbackDecision === "toss" ? "is-selected is-toss" : ""} onClick={() => onToss(item)}><Trash2 aria-hidden="true" size={14} /> Toss it</button>
        </div>
      </div>
    </article>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="furbin-v5-empty">
      <PackageOpen aria-hidden="true" size={42} />
      <h2>{filtered ? "No models match those filters" : "Your private library is ready"}</h2>
      <p>{filtered ? "Clear a filter or try a broader search." : "Accepted model versions will appear here without exposing their storage location."}</p>
    </div>
  );
}

function PublicShowcaseCard({ showcase }: { showcase: FurBinShowcase }) {
  return (
    <article className="furbin-v5-public-card">
      <div className="furbin-v5-public-art">
        {showcase.coverUrl
          ? <img src={showcase.coverUrl} alt={`Public preview of ${showcase.title}`} />
          : <div className="furbin-v5-public-fallback"><ImageOff aria-hidden="true" size={34} /><span>Static preview unavailable</span></div>}
        <span className="furbin-v5-public-label"><Sparkles aria-hidden="true" size={13} /> Public derivative</span>
      </div>
      <div className="furbin-v5-public-copy">
        <p className="furbin-v5-eyebrow">{showcase.category} · {showcase.viewCount.toLocaleString()} views</p>
        <h2>{showcase.title}</h2>
        {showcase.description && <p>{showcase.description}</p>}
        <div className="furbin-v5-tags">{showcase.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
        <dl className="furbin-v5-facts">
          <div><dt>Rights</dt><dd>{showcase.rightsDeclaration.replaceAll("_", " ")}</dd></div>
          <div><dt>Commercial use</dt><dd>{showcase.commercialEligible ? "Eligible" : "Not declared"}</dd></div>
          {showcase.attribution && <div><dt>Attribution</dt><dd>{showcase.attribution}</dd></div>}
        </dl>
        {showcase.publicViewUrl && (
          <a className="furbin-v5-primary" href={showcase.publicViewUrl} target="_blank" rel="noopener noreferrer">
            <Download aria-hidden="true" size={16} /> Open public model file
          </a>
        )}
        <p className="furbin-v5-fallback-note">Static, non-WebGL details remain available on every device.</p>
      </div>
    </article>
  );
}

function ItemDetail({
  api,
  initialItem,
  collections,
  onClose,
  onChanged,
}: {
  api: FurBinV5Api;
  initialItem: FurBinItem;
  collections: FurBinCollection[];
  onClose: () => void;
  onChanged: (item: FurBinItem) => void;
}) {
  const [item, setItem] = useState(initialItem);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [collectionUuid, setCollectionUuid] = useState("");
  const [publishForm, setPublishForm] = useState<PublishShowcaseInput>({
    itemUuid: initialItem.itemUuid,
    publicDerivativeUuid: "",
    publicDerivativeVersionNumber: 0,
    title: initialItem.title,
    description: initialItem.description || undefined,
    tags: initialItem.tags,
    category: "pets",
    rightsDeclaration: "all_rights_reserved",
    commercialEligible: false,
  });
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const commitItem = (updated: FurBinItem) => {
    setItem(updated);
    onChanged(updated);
  };

  const run = async (name: string, action: () => Promise<void>) => {
    setBusyAction(name);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const refresh = () => run("refresh", async () => {
    const updated = await refreshSignedView(api, item.itemUuid);
    commitItem({ ...item, ...updated, versions: updated.versions.length ? updated.versions : item.versions, derivatives: updated.derivatives.length ? updated.derivatives : item.derivatives });
    setNotice("A fresh short-lived viewing link is ready.");
  });

  const publicDerivatives = item.derivatives.filter((derivative) => derivative.scope === "public" && derivative.purpose === "showcase");

  return (
    <div className="furbin-v5-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="furbin-v5-modal" role="dialog" aria-modal="true" aria-labelledby="furbin-v5-detail-title">
        <header className="furbin-v5-modal-header">
          <div>
            <p className="furbin-v5-eyebrow">Private source · {formatBytes(item.storageBytes)}</p>
            <h2 id="furbin-v5-detail-title">{item.title}</h2>
          </div>
          <button ref={closeButtonRef} type="button" className="furbin-v5-icon-button" onClick={onClose} aria-label="Close item details"><X aria-hidden="true" /></button>
        </header>

        <div className="furbin-v5-detail-layout">
          <div className="furbin-v5-detail-preview">
            <Preview item={item} />
            <p><ShieldCheck aria-hidden="true" size={14} /> This canonical source stays private. Public sharing uses a separate derivative.</p>
            <div className="furbin-v5-view-actions">
              {item.signedViewUrl
                ? <a className="furbin-v5-primary" href={item.signedViewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" size={16} /> Open model file</a>
                : <span className="furbin-v5-muted">No viewing link is currently available.</span>}
              <button type="button" className="furbin-v5-secondary" onClick={refresh} disabled={busyAction !== null}>
                <RefreshCw aria-hidden="true" size={15} className={busyAction === "refresh" ? "furbin-v5-spin" : ""} /> Refresh link
              </button>
            </div>
            <p className="furbin-v5-fallback-note">The viewer opens the signed file directly. This screen does not require WebGL.</p>
          </div>

          <div className="furbin-v5-detail-copy">
            {item.description && <p>{item.description}</p>}
            <div className="furbin-v5-tags">{item.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
            <dl className="furbin-v5-facts">
              <div><dt>Measured size</dt><dd>{formatDimensions(item)}</dd></div>
              <div><dt>Accessories</dt><dd>{item.accessoryCount}</dd></div>
              <div><dt>Derivatives</dt><dd>{item.derivativeCount}</dd></div>
              <div><dt>Updated</dt><dd>{new Date(item.updatedAt).toLocaleDateString()}</dd></div>
            </dl>
            <h3>Measured capabilities</h3>
            <div className="furbin-v5-badge-stack">{item.badges.map((badge) => <Badge key={badge.id} badge={badge} />)}</div>
          </div>
        </div>

        <div className="furbin-v5-detail-sections">
          <section className="furbin-v5-detail-section" aria-labelledby="furbin-v5-versions">
            <div className="furbin-v5-section-title"><History aria-hidden="true" size={18} /><h3 id="furbin-v5-versions">Version history</h3></div>
            {item.versions.length ? (
              <ol className="furbin-v5-version-list">
                {item.versions.map((version) => (
                  <li key={version.versionNumber}>
                    <span><strong>Version {version.versionNumber}</strong><small>{formatBytes(version.sizeBytes)} · {new Date(version.createdAt).toLocaleDateString()}</small></span>
                    {version.isCurrent
                      ? <span className="furbin-v5-current">Current</span>
                      : <button type="button" className="furbin-v5-text-button" disabled={!api.capabilities.rollbackByVersionNumber || busyAction !== null} onClick={() => run(`rollback-${version.versionNumber}`, async () => {
                        const updated = await rollbackToVersion(api, item.itemUuid, version.versionNumber);
                        commitItem(updated);
                        setNotice(`Version ${version.versionNumber} is now current.`);
                      })}><RotateCcw aria-hidden="true" size={14} /> Make current</button>}
                  </li>
                ))}
              </ol>
            ) : <p className="furbin-v5-capability-note">Version history is waiting for a public version-number endpoint. Internal database IDs are never shown or submitted.</p>}
          </section>

          <section className="furbin-v5-detail-section" aria-labelledby="furbin-v5-derivatives">
            <div className="furbin-v5-section-title"><UploadCloud aria-hidden="true" size={18} /><h3 id="furbin-v5-derivatives">Derivatives</h3></div>
            {item.derivatives.length ? <ul className="furbin-v5-derivative-list">{item.derivatives.map((derivative) => (
              <li key={`${derivative.derivativeUuid}-${derivative.versionNumber}`}>
                <span><strong>{derivative.label}</strong><small>Version {derivative.versionNumber} · {derivative.purpose}</small></span>
                <span className={`furbin-v5-scope-pill ${derivative.scope === "public" ? "is-public" : ""}`}>{derivative.scope}</span>
              </li>
            ))}</ul> : <p className="furbin-v5-capability-note">No derivative lineage was returned by the server.</p>}
          </section>

          <section className="furbin-v5-detail-section" aria-labelledby="furbin-v5-collections">
            <div className="furbin-v5-section-title"><FolderPlus aria-hidden="true" size={18} /><h3 id="furbin-v5-collections">Add to collection</h3></div>
            {collections.length ? <div className="furbin-v5-inline-form">
              <select aria-label="Collection" value={collectionUuid} onChange={(event) => setCollectionUuid(event.target.value)}>
                <option value="">Choose a collection</option>
                {collections.map((collection) => <option key={collection.collectionUuid} value={collection.collectionUuid}>{collection.name}</option>)}
              </select>
              <button type="button" className="furbin-v5-secondary" disabled={!collectionUuid || busyAction !== null} onClick={() => run("collection", async () => {
                await api.addItemToCollection(collectionUuid, item.itemUuid);
                setNotice("Added to the collection.");
              })}>Add</button>
            </div> : <p className="furbin-v5-capability-note">Create a collection from the library toolbar, then add this model.</p>}
          </section>

          <section className="furbin-v5-detail-section" aria-labelledby="furbin-v5-publish">
            <div className="furbin-v5-section-title"><Sparkles aria-hidden="true" size={18} /><h3 id="furbin-v5-publish">Public showcase</h3></div>
            {item.showcase ? (
              <div className="furbin-v5-showcase-status">
                <span>Moderation: <strong>{item.showcase.moderationState}</strong></span>
                <button type="button" className="furbin-v5-danger" disabled={busyAction !== null} onClick={() => run("unpublish", async () => {
                  await api.unpublishShowcase(item.showcase!.showcaseUuid);
                  commitItem({ ...item, showcase: undefined });
                  setNotice("Public derivative unpublished. Private source preserved.");
                })}>Unpublish</button>
              </div>
            ) : (
              <form className="furbin-v5-publish-form" onSubmit={(event) => {
                event.preventDefault();
                void run("publish", async () => {
                  const showcase = await publishPublicDerivative(api, publishForm);
                  commitItem({ ...item, showcase });
                  setNotice("Public derivative submitted for moderation.");
                });
              }}>
                <label>Public derivative
                  <select value={`${publishForm.publicDerivativeUuid}:${publishForm.publicDerivativeVersionNumber}`} disabled={!api.capabilities.separatePublicDerivative} onChange={(event) => {
                    const derivative = publicDerivatives.find((candidate) => `${candidate.derivativeUuid}:${candidate.versionNumber}` === event.target.value);
                    setPublishForm((current) => ({ ...current, publicDerivativeUuid: derivative?.derivativeUuid || "", publicDerivativeVersionNumber: derivative?.versionNumber || 0 }));
                  }}>
                    <option value=":0">Choose a validated public derivative</option>
                    {publicDerivatives.map((derivative) => <option key={`${derivative.derivativeUuid}-${derivative.versionNumber}`} value={`${derivative.derivativeUuid}:${derivative.versionNumber}`}>{derivative.label} · v{derivative.versionNumber}</option>)}
                  </select>
                </label>
                <label>Showcase title<input required maxLength={300} value={publishForm.title} onChange={(event) => setPublishForm((current) => ({ ...current, title: event.target.value }))} /></label>
                <label>Category<input required maxLength={100} value={publishForm.category} onChange={(event) => setPublishForm((current) => ({ ...current, category: event.target.value }))} /></label>
                <label>Rights
                  <select value={publishForm.rightsDeclaration} onChange={(event) => setPublishForm((current) => ({ ...current, rightsDeclaration: event.target.value }))}>
                    <option value="all_rights_reserved">All rights reserved</option>
                    <option value="cc_by_4_0">CC BY 4.0</option>
                    <option value="cc_by_nc_4_0">CC BY-NC 4.0</option>
                  </select>
                </label>
                <label className="furbin-v5-check"><input type="checkbox" checked={publishForm.commercialEligible} onChange={(event) => setPublishForm((current) => ({ ...current, commercialEligible: event.target.checked }))} /> Declare commercial eligibility</label>
                {!api.capabilities.separatePublicDerivative && <p className="furbin-v5-capability-note">Publishing is locked until the server accepts a separate public derivative. Your private source will not be repurposed.</p>}
                <button type="submit" className="furbin-v5-primary" disabled={!api.capabilities.separatePublicDerivative || !publishForm.publicDerivativeUuid || busyAction !== null}><UploadCloud aria-hidden="true" size={16} /> Submit for moderation</button>
              </form>
            )}
          </section>
        </div>

        {(error || notice) && <p className={error ? "furbin-v5-message is-error" : "furbin-v5-message"} role="status">{error || notice}</p>}
        <footer className="furbin-v5-modal-footer">
          <button type="button" className="furbin-v5-danger" disabled={!api.capabilities.archive || busyAction !== null} onClick={() => run("archive", async () => {
            const updated = await archivePrivateItem(api, item.itemUuid);
            commitItem(updated);
            setNotice("Item archived. Canonical files were not deleted.");
          })}><Archive aria-hidden="true" size={16} /> Archive item</button>
          {!api.capabilities.archive && <span className="furbin-v5-muted">Archive endpoint pending</span>}
        </footer>
      </section>
    </div>
  );
}

export function FurBinV5Experience({ api = defaultApi }: FurBinV5ExperienceProps) {
  const [view, setView] = useState<View>("library");
  const [items, setItems] = useState<FurBinItem[]>([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<LibraryFilters>({ page: 1, limit: 40 });
  const [draftQuery, setDraftQuery] = useState("");
  const [collections, setCollections] = useState<FurBinCollection[]>([]);
  const [selected, setSelected] = useState<FurBinItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [collectionName, setCollectionName] = useState("");
  const [publicUuid, setPublicUuid] = useState("");
  const [publicShowcase, setPublicShowcase] = useState<FurBinShowcase | null>(null);
  const [publicLoading, setPublicLoading] = useState(false);
  const [feedbackItem, setFeedbackItem] = useState<FurBinItem | null>(null);
  const [feedbackSubject, setFeedbackSubject] = useState("");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackError, setFeedbackError] = useState("");
  const libraryRequestGateRef = useRef(createLatestLibraryRequestGate());

  const load = async (nextFilters = filters) => {
    const normalized = normalizeLibraryFilters(nextFilters);
    await loadLatestLibraryPage(api, normalized, libraryRequestGateRef.current, {
      start: () => {
        setLoading(true);
        setError("");
      },
      success: (result) => {
        const clampedPage = clampLibraryPage(result.total, result.page, result.limit);
        if (clampedPage !== result.page) {
          const clampedFilters = { ...normalized, page: clampedPage, limit: result.limit };
          setFilters(clampedFilters);
          void load(clampedFilters);
          return;
        }
        setItems(result.items);
        setTotal(result.total);
        setFilters({ ...normalized, page: result.page, limit: result.limit });
      },
      failure: (cause) => setError(errorMessage(cause)),
      finish: () => setLoading(false),
    });
  };

  useEffect(() => {
    let active = true;
    void load(filters);
    if (api.capabilities.listCollections) {
      api.listCollections()
        .then((next) => { if (active) setCollections(next); })
        .catch(() => { if (active) setCollections([]); });
    }
    return () => {
      active = false;
      libraryRequestGateRef.current.invalidate();
    };
    // The API instance is deliberately injectable in tests/stories.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const openItem = async (item: FurBinItem) => {
    setSelected(item);
    try {
      const detail = await api.getItem(item.itemUuid);
      const merged = {
        ...item,
        ...detail,
        versions: detail.versions.length ? detail.versions : item.versions,
        derivatives: detail.derivatives.length ? detail.derivatives : item.derivatives,
      };
      setSelected(merged);
      setItems((current) => mergeItem(current, merged));
    } catch {
      // Search DTO remains usable if a detail refresh expires or is temporarily unavailable.
    }
  };

  const updateFilter = (next: LibraryFilters) => {
    const normalized = normalizeLibraryFilters(next);
    setFilters(normalized);
    void load(normalized);
  };

  const markFeedback = (itemUuid: string, decision: "keep" | "toss") => {
    setItems((current) => current.map((item) => item.itemUuid === itemUuid ? { ...item, feedbackDecision: decision } : item));
    setSelected((current) => current?.itemUuid === itemUuid ? { ...current, feedbackDecision: decision } : current);
  };

  const keepItem = async (item: FurBinItem) => {
    setFeedbackError("");
    try {
      await api.submitFeedback(item.itemUuid, { decision: "keep" });
      markFeedback(item.itemUuid, "keep");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const openTossForm = (item: FurBinItem) => {
    setFeedbackItem(item);
    setFeedbackSubject(`Please review ${item.title}`);
    setFeedbackMessage("");
    setFeedbackError("");
  };

  const submitTossFeedback = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!feedbackItem) return;
    setFeedbackBusy(true);
    setFeedbackError("");
    try {
      const result = await api.submitFeedback(feedbackItem.itemUuid, {
        decision: "toss",
        subject: feedbackSubject.trim(),
        message: feedbackMessage.trim(),
      });
      markFeedback(feedbackItem.itemUuid, "toss");
      setFeedbackItem(null);
      setError(result.emailSent ? "" : "Your feedback was saved for the admin, but email delivery is waiting for mail configuration.");
    } catch (cause) {
      setFeedbackError(errorMessage(cause));
    } finally {
      setFeedbackBusy(false);
    }
  };

  const hasFilters = Boolean(filters.query || filters.tag || filters.collectionUuid || filters.hasRig || filters.hasFacial || filters.hasAnimations);
  const availableTags = [...new Set(items.flatMap((item) => item.tags))].sort().slice(0, 10);
  const currentPage = clampLibraryPage(total, filters.page || 1, filters.limit || 40);
  const totalPages = libraryPageCount(total, filters.limit || 40);

  return (
    <main className="furbin-v5-shell">
      <div className="furbin-v5-orb furbin-v5-orb-one" aria-hidden="true" />
      <div className="furbin-v5-orb furbin-v5-orb-two" aria-hidden="true" />
      <header className="furbin-v5-hero">
        <div>
          <p className="furbin-v5-kicker">Canonical model library</p>
          <h1>Fur Bin</h1>
          <p>Your private model vault, measured versions, and approved public derivatives in one place.</p>
        </div>
        <div className="furbin-v5-total" aria-label={`${total} private models`}><strong>{total}</strong><span>private models</span></div>
      </header>

      <nav className="furbin-v5-tabs" aria-label="Fur Bin views">
        <button type="button" aria-current={view === "library" ? "page" : undefined} onClick={() => { setError(""); setView("library"); }}><Library aria-hidden="true" size={17} /> Private library</button>
        <button type="button" aria-current={view === "showcase" ? "page" : undefined} onClick={() => { setError(""); setView("showcase"); }}><Sparkles aria-hidden="true" size={17} /> Public showcase</button>
      </nav>

      {view === "library" ? (
        <>
          <section className="furbin-v5-toolbar" aria-label="Library search and filters">
            <form className="furbin-v5-search" role="search" onSubmit={(event) => {
              event.preventDefault();
              updateFilter({ ...filters, query: draftQuery, page: 1 });
            }}>
              <Search aria-hidden="true" size={18} />
              <label className="sr-only" htmlFor="furbin-v5-search">Search your private models</label>
              <input id="furbin-v5-search" type="search" value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} placeholder="Search names and descriptions" />
              <button type="submit">Search</button>
            </form>
            <div className="furbin-v5-filter-row" aria-label="Capability filters">
              {([[
                "hasRig", "Rig listed",
              ], ["hasFacial", "Face listed"], ["hasAnimations", "Animation listed"]] as const).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={filters[key] === true} onClick={() => updateFilter({ ...filters, [key]: filters[key] ? undefined : true, page: 1 })}>{label}</button>
              ))}
              <button type="button" onClick={() => setCollectionOpen((current) => !current)}><FolderPlus aria-hidden="true" size={15} /> New collection</button>
              {hasFilters && <button type="button" onClick={() => { setDraftQuery(""); updateFilter({ page: 1, limit: 40 }); }}>Clear filters</button>}
            </div>
            {collectionOpen && (
              <form className="furbin-v5-collection-form" onSubmit={(event) => {
                event.preventDefault();
                const name = collectionName.trim();
                if (!name) return;
                api.createCollection({ name }).then((collection) => {
                  setCollections((current) => [...current, collection]);
                  setCollectionName("");
                  setCollectionOpen(false);
                }).catch((cause) => setError(errorMessage(cause)));
              }}>
                <label htmlFor="furbin-v5-collection-name">Collection name</label>
                <input id="furbin-v5-collection-name" required maxLength={200} value={collectionName} onChange={(event) => setCollectionName(event.target.value)} />
                <button className="furbin-v5-primary" type="submit">Create</button>
              </form>
            )}
            {collections.length > 0 && (
              <div className="furbin-v5-collection-chips" aria-label="Filter by collection">
                {collections.map((collection) => <button type="button" key={collection.collectionUuid} aria-pressed={filters.collectionUuid === collection.collectionUuid} onClick={() => updateFilter({ ...filters, collectionUuid: filters.collectionUuid === collection.collectionUuid ? undefined : collection.collectionUuid, page: 1 })}>{collection.name}</button>)}
              </div>
            )}
            {availableTags.length > 0 && (
              <div className="furbin-v5-tag-chips" aria-label="Filter by tag">
                <Tag aria-hidden="true" size={15} />
                {availableTags.map((tag) => <button type="button" key={tag} aria-pressed={filters.tag === tag} onClick={() => updateFilter({ ...filters, tag: filters.tag === tag ? undefined : tag, page: 1 })}>#{tag}</button>)}
              </div>
            )}
          </section>

          {error && <div className="furbin-v5-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>Try again</button></div>}
          {loading ? (
            <div className="furbin-v5-loading" role="status"><Loader2 aria-hidden="true" className="furbin-v5-spin" /><span>Opening your private library…</span></div>
          ) : items.length ? (
            <section className="furbin-v5-grid" aria-label="Private model library">
              {items.map((item) => <ItemCard key={item.itemUuid} item={item} onOpen={openItem} onKeep={(target) => void keepItem(target)} onToss={openTossForm} />)}
            </section>
          ) : <EmptyState filtered={hasFilters} />}
          {totalPages > 1 && (
            <nav className="furbin-v5-pagination" aria-label="Private library pages">
              <button
                type="button"
                aria-label="Previous library page"
                disabled={loading || currentPage <= 1}
                onClick={() => updateFilter({ ...filters, page: currentPage - 1 })}
              >
                Previous
              </button>
              <span>Page {currentPage} of {totalPages}</span>
              <button
                type="button"
                aria-label="Next library page"
                disabled={loading || currentPage >= totalPages}
                onClick={() => updateFilter({ ...filters, page: currentPage + 1 })}
              >
                Next
              </button>
            </nav>
          )}
        </>
      ) : (
        <section className="furbin-v5-showcase-search">
          <div className="furbin-v5-showcase-intro">
            <p className="furbin-v5-eyebrow">Approved records only</p>
            <h2>Open a public showcase</h2>
            <p>Public records point to immutable derivatives. They never reveal the owner’s private source or storage key.</p>
          </div>
          <form onSubmit={(event) => {
            event.preventDefault();
            const uuid = publicUuid.trim();
            if (!uuid) return;
            setPublicLoading(true);
            setError("");
            setPublicShowcase(null);
            api.getPublicShowcase(uuid).then(setPublicShowcase).catch((cause) => setError(errorMessage(cause))).finally(() => setPublicLoading(false));
          }}>
            <label htmlFor="furbin-v5-public-uuid">Showcase link ID</label>
            <div><input id="furbin-v5-public-uuid" required value={publicUuid} onChange={(event) => setPublicUuid(event.target.value)} placeholder="Paste the public showcase UUID" /><button type="submit" className="furbin-v5-primary" disabled={publicLoading}>{publicLoading ? <Loader2 aria-hidden="true" className="furbin-v5-spin" /> : <Search aria-hidden="true" />} Find showcase</button></div>
          </form>
          {error && <div className="furbin-v5-error" role="alert">{error}</div>}
          {publicShowcase && <PublicShowcaseCard showcase={publicShowcase} />}
        </section>
      )}

      {selected && <ItemDetail api={api} initialItem={selected} collections={collections} onClose={() => setSelected(null)} onChanged={(updated) => {
        setSelected(updated);
        setItems((current) => mergeItem(current, updated));
      }} />}
      {feedbackItem && (
        <div className="furbin-v5-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !feedbackBusy && setFeedbackItem(null)}>
          <form className="furbin-v5-feedback-form" role="dialog" aria-modal="true" aria-labelledby="furbin-feedback-title" onSubmit={submitTossFeedback}>
            <button type="button" className="furbin-v5-icon-button furbin-v5-feedback-close" onClick={() => setFeedbackItem(null)} disabled={feedbackBusy} aria-label="Close feedback form"><X aria-hidden="true" /></button>
            <p className="furbin-v5-eyebrow">Toss it · feedback to Pawsome3D</p>
            <h2 id="furbin-feedback-title">What should we improve?</h2>
            <p>Your account, order, asset ID, model version, provider job, and file hash are attached automatically. Do not paste private account details.</p>
            <label>Subject<input required minLength={3} maxLength={200} value={feedbackSubject} onChange={(event) => setFeedbackSubject(event.target.value)} /></label>
            <label>Details<textarea required minLength={10} maxLength={4000} rows={7} value={feedbackMessage} onChange={(event) => setFeedbackMessage(event.target.value)} placeholder="Tell us what looks wrong and what you expected." /></label>
            {feedbackError && <p className="furbin-v5-message is-error" role="alert">{feedbackError}</p>}
            <div className="furbin-v5-feedback-actions">
              <button type="button" className="furbin-v5-secondary" onClick={() => setFeedbackItem(null)} disabled={feedbackBusy}>Cancel</button>
              <button type="submit" className="furbin-v5-danger" disabled={feedbackBusy || feedbackSubject.trim().length < 3 || feedbackMessage.trim().length < 10}>{feedbackBusy ? "Sending…" : "Send to admin"}</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
