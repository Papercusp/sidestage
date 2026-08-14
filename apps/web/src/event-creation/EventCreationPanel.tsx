import { useEffect, useMemo, useState } from 'react';
import { catalogDemoDataEnabled, useCatalog, variantToCatalogRow } from '../catalog';
import {
  clampQuantity,
  createEventPayload,
  draftFromCatalog,
  filterCatalog,
  parsePriceCents,
  type CatalogAvailabilityFilter,
  type CatalogRow,
  type EventCreationPayload,
  type EventItemDraft,
} from './catalog';
import { InventoryPickerGrid } from './InventoryPickerGrid';
import { EventThumbnail } from './EventThumbnail';
import { ALLOWED_THUMBNAIL_TYPES, readThumbnailFile } from './thumbnail';
import './event-creation.css';

export interface EventCreationPanelProps {
  catalog?: readonly CatalogRow[];
  initialEventName?: string;
  eventNameReadOnly?: boolean;
  title?: string;
  copy?: string;
  submitLabel?: string;
  onCreateEvent?: (payload: EventCreationPayload) => void | Promise<void>;
  /** Test/embed override; production builds default false via import.meta.env.DEV. */
  allowDemoData?: boolean;
}

const ALL_PRODUCT_TYPES = 'all';

export function EventCreationPanel({
  catalog: catalogProp,
  initialEventName = '',
  eventNameReadOnly = false,
  title = 'Choose what goes on stage',
  copy = 'Search the full catalog, select multiple items, then set the live offer and quantity for each one.',
  submitLabel = 'Create event',
  onCreateEvent,
  allowDemoData = catalogDemoDataEnabled(),
}: EventCreationPanelProps) {
  const [eventName, setEventName] = useState(initialEventName);
  const [query, setQuery] = useState('');
  const [productType, setProductType] = useState(ALL_PRODUCT_TYPES);
  const [availability, setAvailability] = useState<CatalogAvailabilityFilter>('all');
  const [page, setPage] = useState(1);
  const [selectedRowIds, setSelectedRowIds] = useState<ReadonlySet<string>>(new Set());
  const [catalogById, setCatalogById] = useState<Record<string, CatalogRow>>({});
  const [drafts, setDrafts] = useState<Record<string, EventItemDraft>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [thumbnailName, setThumbnailName] = useState<string | null>(null);
  const [thumbnailError, setThumbnailError] = useState<string | null>(null);
  const [readingThumbnail, setReadingThumbnail] = useState(false);

  // No catalog prop → the ONE product source (P-102): server-side search over
  // the real catalog. A supplied prop (tests, embedding) keeps the local path.
  const remote = useCatalog(
    {
      q: query,
      productType: productType === ALL_PRODUCT_TYPES ? undefined : productType,
      availability,
      page,
      pageSize: 50,
    },
    undefined,
    catalogProp ? Number.MAX_SAFE_INTEGER : 250,
    allowDemoData,
  );
  const catalogUnavailable = catalogProp === undefined && remote.unavailable;
  const catalog = useMemo(
    () => catalogProp ?? remote.rows.map(variantToCatalogRow),
    [catalogProp, remote.rows],
  );

  const productTypes = useMemo(
    () => (catalogProp
      ? [...new Set(catalogProp.map((row) => row.productType))].sort()
      : remote.productTypes),
    [catalogProp, remote.productTypes],
  );
  const filteredRows = useMemo(
    () => (catalogProp ? filterCatalog(catalog, query, productType, availability) : [...catalog]),
    [availability, catalog, catalogProp, productType, query],
  );
  useEffect(() => {
    setPage(1);
  }, [availability, productType, query]);
  useEffect(() => {
    if (catalogUnavailable) {
      setCatalogById({});
      setSelectedRowIds(new Set());
      setDrafts({});
      return;
    }
    setCatalogById((current) => {
      const next = { ...current };
      for (const row of catalog) next[row.id] = row;
      return next;
    });
  }, [catalog, catalogUnavailable]);
  const selectedRows = useMemo(
    () => catalogUnavailable
      ? []
      : [...selectedRowIds].map((id) => catalogById[id]).filter((row): row is CatalogRow => Boolean(row)),
    [catalogById, catalogUnavailable, selectedRowIds],
  );
  const selectedDrafts = useMemo(
    () => selectedRows.map((row) => drafts[row.id] ?? draftFromCatalog(row)),
    [drafts, selectedRows],
  );

  const selectRows = (next: ReadonlySet<string>) => {
    const valid = new Set([...next].filter((id) => (catalogById[id]?.availableQty ?? 0) > 0));
    setSelectedRowIds(valid);
    setDrafts((current) => {
      const updated = { ...current };
      for (const id of valid) {
        const row = catalogById[id];
        if (row && !updated[id]) updated[id] = draftFromCatalog(row);
      }
      return updated;
    });
  };

  const updateDraft = (row: CatalogRow, field: 'eventPriceCents' | 'quantityLimit', value: string) => {
    const current = drafts[row.id] ?? draftFromCatalog(row);
    const nextValue = field === 'eventPriceCents'
      ? parsePriceCents(value)
      : clampQuantity(Number(value), row.availableQty);
    if (nextValue === null) return;
    setDrafts((existing) => ({
      ...existing,
      [row.id]: { ...current, [field]: nextValue },
    }));
  };

  // The input is reset to '' after every pick so choosing the SAME file twice
  // (having removed it in between) still fires a change event.
  const handleThumbnailPick = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setThumbnailError(null);
    setReadingThumbnail(true);
    try {
      const read = await readThumbnailFile(file);
      if (!read.ok) {
        setThumbnailError(read.error);
        return;
      }
      setThumbnailUrl(read.dataUrl);
      setThumbnailName(file.name);
    } finally {
      setReadingThumbnail(false);
    }
  };

  const clearThumbnail = () => {
    setThumbnailUrl(null);
    setThumbnailName(null);
    setThumbnailError(null);
  };

  const handleCreate = async () => {
    const payload = createEventPayload(eventName, selectedDrafts, thumbnailUrl ?? undefined);
    if (!payload) {
      setError(selectedDrafts.length === 0 ? 'Select at least one in-stock item.' : 'Add an event name to continue.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onCreateEvent?.(payload);
      setSelectedRowIds(new Set());
      setDrafts({});
      clearThumbnail();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'The event could not be saved.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="event-creation" aria-labelledby="event-creation-title">
      <div className="event-creation-heading">
        <div>
          <p className="eyebrow">Seller workspace · event setup</p>
          <h2 id="event-creation-title">{title}</h2>
          <p className="event-creation-copy">{copy}</p>
        </div>
        <span className="event-step-indicator"><span>1</span> Catalog selection</span>
      </div>

      <div className="event-name-row">
        <label className="event-name-field">
          <span>Event name</span>
          <input
            aria-label="Event name"
            placeholder="e.g. Sunday vintage drop"
            value={eventName}
            onChange={(event) => setEventName(event.target.value)}
            readOnly={eventNameReadOnly}
          />
        </label>
        <div className="event-thumbnail-field">
          <span id="event-thumbnail-label">Event thumbnail</span>
          <div className="event-thumbnail-picker">
            <label
              className={`event-thumbnail-choose${readingThumbnail || submitting ? ' is-disabled' : ''}`}
            >
              {/* The SAME component the buyer sees, so the seller's preview is
                  the real render — including the fallback — not a lookalike. */}
              <EventThumbnail
                url={thumbnailUrl}
                eventName={eventName.trim() || 'this event'}
                className="event-thumbnail-preview"
              />
              {!thumbnailUrl ? (
                <svg
                  className="event-thumbnail-upload-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10.3" />
                  <path d="m16 19 3-3 3 3" />
                  <path d="M19 22v-6" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
                </svg>
              ) : null}
              <input
                type="file"
                aria-label={thumbnailUrl ? 'Choose a replacement event thumbnail' : 'Choose an event thumbnail'}
                aria-describedby="event-thumbnail-status"
                accept={ALLOWED_THUMBNAIL_TYPES.join(',')}
                disabled={readingThumbnail || submitting}
                onChange={(event) => void handleThumbnailPick(event.currentTarget)}
              />
            </label>
            <div className="event-thumbnail-actions">
              {thumbnailUrl ? (
                <button className="button tertiary" type="button" onClick={clearThumbnail} disabled={submitting}>
                  Remove
                </button>
              ) : null}
              <span className="event-thumbnail-status" id="event-thumbnail-status">
                {readingThumbnail
                  ? 'Reading image…'
                  : thumbnailName ?? 'JPEG, PNG, WebP, or GIF · up to 512KB'}
              </span>
            </div>
          </div>
          {thumbnailError ? <p className="event-form-error" role="alert">{thumbnailError}</p> : null}
        </div>

        <div className="event-selection-summary" aria-live="polite">
          <strong>{selectedRows.length}</strong> selected
          <span>·</span>
          <span>{filteredRows.length} of {catalog.length} catalog items</span>
        </div>
      </div>

      <div className="event-filters" role="search" aria-label="Catalog filters">
        <label className="event-search-field">
          <span aria-hidden="true">⌕</span>
          <span className="sr-only">Search catalog</span>
          <input
            aria-label="Search catalog"
            placeholder="Search title, brand, SKU…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="event-filter-select">
          <span className="sr-only">Product type</span>
          <select aria-label="Product type" value={productType} onChange={(event) => setProductType(event.target.value)}>
            <option value={ALL_PRODUCT_TYPES}>All product types</option>
            {productTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <label className="event-filter-select">
          <span className="sr-only">Availability</span>
          <select aria-label="Availability" value={availability} onChange={(event) => setAvailability(event.target.value as CatalogAvailabilityFilter)}>
            <option value="all">All availability</option>
            <option value="in-stock">In stock only</option>
          </select>
        </label>
      </div>

      {catalogUnavailable ? (
        <p className="event-form-error" role="alert">
          Catalog unavailable. No inventory is shown until durable catalog storage reconnects.
        </p>
      ) : null}

      <InventoryPickerGrid
        rows={filteredRows}
        selectedRowIds={selectedRowIds}
        drafts={drafts}
        onSelectedRowIdsChange={selectRows}
        onDraftChange={updateDraft}
      />

      {!catalogProp ? (
        <div className="event-pagination" aria-label="Catalog pagination">
          <span>
            {remote.loading ? 'Loading catalog…' : `Page ${page} · ${remote.totalIsFloor ? 'at least ' : ''}${remote.total.toLocaleString()} matches`}
            {remote.showingDemo ? ' · development demo' : remote.unavailable ? ' · catalog unavailable' : ''}
          </span>
          <div>
            <button className="button tertiary" type="button" disabled={page <= 1 || remote.loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
            <button className="button tertiary" type="button" disabled={remote.loading || page * 50 >= remote.total} onClick={() => setPage((current) => current + 1)}>Next</button>
          </div>
        </div>
      ) : null}

      <div className="event-creation-footer">
        <div>
          <strong>{selectedRows.length ? `${selectedRows.length} items ready for your event` : 'Select items to build your event'}</strong>
          <span>Submitting creates source-tracked event reservations for every selected variant.</span>
        </div>
        <button className="button primary" type="button" disabled={!selectedRows.length || submitting} onClick={() => void handleCreate()}>
          {submitting ? 'Reserving…' : submitLabel} <span aria-hidden="true">→</span>
        </button>
      </div>
      {error ? <p className="event-form-error" role="alert">{error}</p> : null}
    </section>
  );
}

export default EventCreationPanel;
