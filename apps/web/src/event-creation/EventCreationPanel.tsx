import { useMemo, useState } from 'react';
import { useCatalog, variantToCatalogRow } from '../catalog';
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
import './event-creation.css';

export interface EventCreationPanelProps {
  catalog?: readonly CatalogRow[];
  onCreateEvent?: (payload: EventCreationPayload) => void;
}

const ALL_PRODUCT_TYPES = 'all';

export function EventCreationPanel({ catalog: catalogProp, onCreateEvent }: EventCreationPanelProps) {
  const [eventName, setEventName] = useState('');
  const [query, setQuery] = useState('');
  const [productType, setProductType] = useState(ALL_PRODUCT_TYPES);
  const [availability, setAvailability] = useState<CatalogAvailabilityFilter>('all');
  const [selectedRowIds, setSelectedRowIds] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, EventItemDraft>>({});
  const [error, setError] = useState<string | null>(null);

  // No catalog prop → the ONE product source (P-102): server-side search over
  // the real catalog. A supplied prop (tests, embedding) keeps the local path.
  const remote = useCatalog(
    {
      q: query,
      productType: productType === ALL_PRODUCT_TYPES ? undefined : productType,
      availability,
      pageSize: 50,
    },
    undefined,
    catalogProp ? Number.MAX_SAFE_INTEGER : 250,
  );
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
  const rowsById = useMemo(() => new Map(catalog.map((row) => [row.id, row])), [catalog]);
  const selectedRows = useMemo(
    () => catalog.filter((row) => selectedRowIds.has(row.id)),
    [catalog, selectedRowIds],
  );
  const selectedDrafts = useMemo(
    () => selectedRows.map((row) => drafts[row.id] ?? draftFromCatalog(row)),
    [drafts, selectedRows],
  );

  const selectRows = (next: ReadonlySet<string>) => {
    const valid = new Set([...next].filter((id) => (rowsById.get(id)?.availableQty ?? 0) > 0));
    setSelectedRowIds(valid);
    setDrafts((current) => {
      const updated = { ...current };
      for (const id of valid) {
        const row = rowsById.get(id);
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

  const handleCreate = () => {
    const payload = createEventPayload(eventName, selectedDrafts);
    if (!payload) {
      setError(selectedDrafts.length === 0 ? 'Select at least one in-stock item.' : 'Add an event name to continue.');
      return;
    }
    setError(null);
    onCreateEvent?.(payload);
  };

  return (
    <section className="event-creation" aria-labelledby="event-creation-title">
      <div className="event-creation-heading">
        <div>
          <p className="eyebrow">Seller workspace · event setup</p>
          <h2 id="event-creation-title">Choose what goes on stage</h2>
          <p className="event-creation-copy">Search the full catalog, select multiple items, then set the live offer and quantity for each one.</p>
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
          />
        </label>
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

      <InventoryPickerGrid
        rows={filteredRows}
        selectedRowIds={selectedRowIds}
        drafts={drafts}
        onSelectedRowIdsChange={selectRows}
        onDraftChange={updateDraft}
      />

      <div className="event-creation-footer">
        <div>
          <strong>{selectedRows.length ? `${selectedRows.length} items ready for your event` : 'Select items to build your event'}</strong>
          <span>Items remain unreserved until a buyer checks out.</span>
        </div>
        <button className="button primary" type="button" disabled={!selectedRows.length} onClick={handleCreate}>
          Create event <span aria-hidden="true">→</span>
        </button>
      </div>
      {error ? <p className="event-form-error" role="alert">{error}</p> : null}
    </section>
  );
}

export default EventCreationPanel;
