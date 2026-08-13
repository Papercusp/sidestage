import { useMemo, useState } from 'react';
import {
  addCatalogItems,
  applyMarkdown,
  createEmptyEvent,
  DEMO_EVENTS,
  formatMarkdown,
  markdownPercent,
  updateEventItem,
  type EventStatus,
  type SellerEvent,
} from './events';
import {
  DEMO_CATALOG,
  filterCatalog,
  formatPrice,
  parsePriceCents,
  type CatalogAvailabilityFilter,
  type CatalogRow,
} from '../event-creation/catalog';
import './event-manager.css';

export interface EventManagerProps {
  catalog?: readonly CatalogRow[];
  initialEvents?: readonly SellerEvent[];
  onEventsChange?: (events: readonly SellerEvent[]) => void;
}

const EVENT_STATUSES: readonly EventStatus[] = ['draft', 'scheduled', 'live', 'ended'];

function statusLabel(status: EventStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function eventDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date to be set';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function initials(value: string): string {
  return value.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

export function EventManager({
  catalog = DEMO_CATALOG,
  initialEvents = DEMO_EVENTS,
  onEventsChange,
}: EventManagerProps) {
  const [events, setEvents] = useState<SellerEvent[]>(() => initialEvents.map((event) => ({ ...event, items: [...event.items] })));
  const [selectedEventId, setSelectedEventId] = useState(initialEvents[0]?.id ?? '');
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogAvailability, setCatalogAvailability] = useState<CatalogAvailabilityFilter>('in-stock');
  const [selectedCatalogIds, setSelectedCatalogIds] = useState<ReadonlySet<string>>(new Set());
  const [newEventName, setNewEventName] = useState('');
  const [newEventOpen, setNewEventOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? events[0] ?? null;
  const filteredCatalog = useMemo(
    () => filterCatalog(catalog, catalogQuery, 'all', catalogAvailability)
      .filter((row) => !selectedEvent?.items.some((item) => item.catalogId === row.id)),
    [catalog, catalogAvailability, catalogQuery, selectedEvent],
  );

  const commitEvents = (nextEvents: SellerEvent[], nextMessage?: string) => {
    setEvents(nextEvents);
    onEventsChange?.(nextEvents);
    setMessage(nextMessage ?? null);
  };

  const updateSelectedEvent = (nextEvent: SellerEvent, nextMessage?: string) => {
    commitEvents(events.map((event) => event.id === nextEvent.id ? nextEvent : event), nextMessage);
  };

  const handleItemUpdate = (itemId: string, patch: { priceCents?: number; quantity?: number }) => {
    if (!selectedEvent) return;
    const result = updateEventItem(selectedEvent, itemId, patch);
    if (result.error) {
      setMessage(result.error);
      return;
    }
    updateSelectedEvent(result.event, 'Event item updated.');
  };

  const handleMarkdown = (itemId: string, value: string) => {
    if (!selectedEvent) return;
    const percent = Number(value);
    const result = applyMarkdown(selectedEvent, itemId, percent);
    if (result.error) {
      setMessage(result.error);
      return;
    }
    updateSelectedEvent(result.event, `Markdown set to ${percent.toFixed(1)}%.`);
  };

  const handleAddCatalogItems = () => {
    if (!selectedEvent || selectedCatalogIds.size === 0) return;
    const nextEvent = addCatalogItems(selectedEvent, catalog, [...selectedCatalogIds]);
    updateSelectedEvent(nextEvent, `${nextEvent.items.length - selectedEvent.items.length} catalog item(s) added.`);
    setSelectedCatalogIds(new Set());
    setCatalogOpen(false);
  };

  const handleCreateEvent = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newEventName.trim();
    if (!name) {
      setMessage('Add an event name to create a draft.');
      return;
    }
    const draft = createEmptyEvent(name);
    const uniqueId = events.some((candidate) => candidate.id === draft.id)
      ? `${draft.id}-${events.length + 1}`
      : draft.id;
    const nextEvent = { ...draft, id: uniqueId };
    commitEvents([...events, nextEvent], 'Draft event created. Add catalog items when you are ready.');
    setSelectedEventId(uniqueId);
    setNewEventName('');
    setNewEventOpen(false);
  };

  const handleStatusChange = (status: EventStatus) => {
    if (!selectedEvent || selectedEvent.status === status) return;
    updateSelectedEvent({ ...selectedEvent, status }, `Event marked ${status}.`);
  };

  return (
    <section className="event-manager" aria-labelledby="event-manager-title">
      <div className="event-manager-heading">
        <div>
          <p className="eyebrow">Seller workspace · events</p>
          <h2 id="event-manager-title">Run every drop from one view.</h2>
          <p className="event-manager-copy">Pick an event, tune its live offers, and keep markdowns inside the guardrail before buyers arrive.</p>
        </div>
        <button className="button primary" type="button" onClick={() => setNewEventOpen((open) => !open)}>
          {newEventOpen ? 'Close new event' : 'New event'}
        </button>
      </div>

      {newEventOpen ? (
        <form className="event-new-form" onSubmit={handleCreateEvent} data-testid="new-event-form">
          <label className="event-new-name">
            <span>Event name</span>
            <input
              aria-label="New event name"
              className="text-input"
              placeholder="e.g. Saturday studio sale"
              value={newEventName}
              onChange={(event) => setNewEventName(event.target.value)}
            />
          </label>
          <button className="button secondary" type="submit">Create draft</button>
        </form>
      ) : null}

      <div className="event-manager-layout">
        <aside className="event-list-panel" aria-label="Events">
          <div className="event-list-heading">
            <div>
              <span className="panel-kicker">Your events</span>
              <strong>{events.length} scheduled spaces</strong>
            </div>
            <span className="event-list-count">{events.filter((event) => event.status === 'live').length} live</span>
          </div>
          <div className="event-list" role="list">
            {events.map((event) => (
              <button
                className={`event-list-row${selectedEvent?.id === event.id ? ' is-selected' : ''}`}
                type="button"
                key={event.id}
                aria-pressed={selectedEvent?.id === event.id}
                onClick={() => { setSelectedEventId(event.id); setMessage(null); }}
                data-testid={`event-list-${event.id}`}
              >
                <span className="event-list-avatar" aria-hidden="true">{initials(event.name)}</span>
                <span className="event-list-copy">
                  <strong>{event.name}</strong>
                  <small>{eventDate(event.startsAt)} · {event.items.length} item{event.items.length === 1 ? '' : 's'}</small>
                </span>
                <span className={`event-status event-status-${event.status}`}>{statusLabel(event.status)}</span>
              </button>
            ))}
          </div>
        </aside>

        {selectedEvent ? (
          <div className="event-detail-panel" data-testid="event-detail">
            <header className="event-detail-heading">
              <div>
                <span className="panel-kicker">Event detail · {eventDate(selectedEvent.startsAt)}</span>
                <h3>{selectedEvent.name}</h3>
                <p>{selectedEvent.items.length} item{selectedEvent.items.length === 1 ? '' : 's'} on the floor · {selectedEvent.viewers} active viewers</p>
              </div>
              <label className="event-status-control">
                <span>Status</span>
                <select aria-label="Event status" value={selectedEvent.status} onChange={(event) => handleStatusChange(event.target.value as EventStatus)}>
                  {EVENT_STATUSES.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
                </select>
              </label>
            </header>

            <div className="event-detail-toolbar">
              <div>
                <strong>Live offer controls</strong>
                <span>Prices and quantities apply to this event only.</span>
              </div>
              <button className="button secondary" type="button" onClick={() => setCatalogOpen((open) => !open)}>
                {catalogOpen ? 'Hide catalog' : 'Add catalog items'}
              </button>
            </div>

            {catalogOpen ? (
              <div className="event-catalog-drawer" data-testid="event-catalog-drawer">
                <div className="event-catalog-drawer-heading">
                  <div>
                    <strong>Add from verified catalog</strong>
                    <span>Only in-stock items can be placed on this event.</span>
                  </div>
                  <span>{selectedCatalogIds.size} selected</span>
                </div>
                <div className="event-catalog-filters">
                  <label className="event-search-field">
                    <span aria-hidden="true">⌕</span>
                    <span className="sr-only">Search catalog to add</span>
                    <input aria-label="Search catalog to add" placeholder="Search title, brand, SKU…" value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} />
                  </label>
                  <label className="event-filter-select">
                    <span className="sr-only">Catalog availability</span>
                    <select aria-label="Catalog availability" value={catalogAvailability} onChange={(event) => setCatalogAvailability(event.target.value as CatalogAvailabilityFilter)}>
                      <option value="in-stock">In stock only</option>
                      <option value="all">All catalog items</option>
                    </select>
                  </label>
                </div>
                <div className="event-catalog-options">
                  {filteredCatalog.length ? filteredCatalog.map((row) => (
                    <label className="event-catalog-option" key={row.id}>
                      <input
                        type="checkbox"
                        checked={selectedCatalogIds.has(row.id)}
                        onChange={() => setSelectedCatalogIds((current) => {
                          const next = new Set(current);
                          if (next.has(row.id)) next.delete(row.id);
                          else next.add(row.id);
                          return next;
                        })}
                      />
                      <span>
                        <strong>{row.title}</strong>
                        <small>{row.brand} · {row.sku} · {row.availableQty} available</small>
                      </span>
                      <em>{formatPrice(row.priceCents)}</em>
                    </label>
                  )) : <p className="event-catalog-empty">No catalog items match this event search.</p>}
                </div>
                <button className="button primary" type="button" disabled={!selectedCatalogIds.size} onClick={handleAddCatalogItems}>Add selected items</button>
              </div>
            ) : null}

            <div className="event-guardrail-banner">
              <span className="feature-icon cyan" aria-hidden="true">⌁</span>
              <span><strong>Markdown guardrail: {selectedEvent.maxMarkdownPercent}% maximum</strong><small>Every price change stays grounded in the catalog base price.</small></span>
            </div>

            <div className="event-items-table-wrap">
              <table className="event-items-table">
                <caption className="sr-only">Products in {selectedEvent.name}</caption>
                <thead>
                  <tr><th scope="col">Product</th><th scope="col">Live price</th><th scope="col">Quantity</th><th scope="col">Markdown</th></tr>
                </thead>
                <tbody>
                  {selectedEvent.items.length ? selectedEvent.items.map((item) => {
                    const markdown = markdownPercent(item.basePriceCents, item.priceCents);
                    return (
                      <tr key={item.id} data-testid={`event-item-${item.catalogId}`}>
                        <td>
                          <div className="event-item-product">
                            <span className="event-item-mark" aria-hidden="true">{initials(item.title)}</span>
                            <span><strong>{item.title}</strong><small>{item.brand} · {item.sku}</small></span>
                          </div>
                        </td>
                        <td>
                          <label className="event-number-field">
                            <span className="sr-only">Event price for {item.title}</span>
                            <span className="currency-prefix">$</span>
                            <input aria-label={`Event price for ${item.title}`} inputMode="decimal" value={(item.priceCents / 100).toFixed(2)} onChange={(event) => {
                              const cents = parsePriceCents(event.target.value);
                              if (cents !== null) handleItemUpdate(item.id, { priceCents: cents });
                            }} />
                          </label>
                          <small className="event-base-price">Base {formatPrice(item.basePriceCents)}</small>
                        </td>
                        <td>
                          <label className="event-number-field quantity-field">
                            <span className="sr-only">Event quantity for {item.title}</span>
                            <input aria-label={`Event quantity for ${item.title}`} type="number" min={1} max={item.availableQty} step={1} value={item.quantity} onChange={(event) => handleItemUpdate(item.id, { quantity: Number(event.target.value) })} />
                            <span className="quantity-stock">/{item.availableQty}</span>
                          </label>
                        </td>
                        <td>
                          <div className="event-markdown-control">
                            <label>
                              <span className="sr-only">Markdown for {item.title}</span>
                              <input aria-label={`Markdown for ${item.title}`} type="number" min={0} max={selectedEvent.maxMarkdownPercent} step={0.5} value={markdown.toFixed(1)} onChange={(event) => handleMarkdown(item.id, event.target.value)} />
                              <span>%</span>
                            </label>
                            <small>{formatMarkdown(item.basePriceCents, item.priceCents)} off base</small>
                          </div>
                        </td>
                      </tr>
                    );
                  }) : (
                    <tr><td className="event-items-empty" colSpan={4}>No items yet. Add products from the verified catalog to start this event.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {message ? <p className="event-manager-message" role="status">{message}</p> : null}
          </div>
        ) : (
          <div className="event-detail-panel event-detail-empty"><p>Create an event to start building your live floor.</p></div>
        )}
      </div>
    </section>
  );
}

export default EventManager;
