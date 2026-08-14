import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSyncMutate, useSyncQuery } from '@papercusp/sync';
import { EventSettingsPanel, type EventConfigView } from '../ConfigTab';
import {
  eventManagerHref,
  useUrlEventManagerRoute,
  type EventManagerRoute,
  type EventManagerSection,
} from '../app-routing';
import EventCreationPanel from '../event-creation/EventCreationPanel';
import type { EventCreationPayload } from '../event-creation/catalog';
import {
  addItemsToSellerEvent,
  adjustSellerEventStock,
  executeSellerAction,
  readSellerAuctionToken,
  rememberSellerAuctionToken,
  setupSellerEvent,
  startSellerAuction,
  verifySellerAuctionAccess,
  type SellerActionResult,
  type SellerAuction,
  type SellerEventItem,
  type SellerEventSetup,
} from './api';
import EventLineupGrid from './EventLineupGrid';
import './event-manager.css';

export interface EventManagerProps {
  eventId: string;
  actorId: string;
  eventName?: string;
  apiBaseUrl?: string;
  initialItems?: readonly SellerEventItem[];
  initialEvents?: readonly SellerOwnedEvent[];
  onEventReady?: (eventId: string, eventName: string) => void;
}

export interface SellerOwnedEvent {
  eventId: string;
  title: string;
  sellerId: string;
  sellerName: string;
  status: 'draft' | 'scheduled' | 'live' | 'ended';
  startsAt: string | null;
  endedAt: string | null;
  thumbnailUrl?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The seller event request failed.';
}

type AddItemsMutation = { eventId: string; payload: EventCreationPayload };
type ExecuteActionMutation = {
  eventId: string;
  actorId: string;
  action: Parameters<typeof executeSellerAction>[2];
};
type AdjustStockMutation = {
  eventId: string;
  actorId: string;
  item: SellerEventItem;
  quantity: number;
};
type StartAuctionMutation = {
  eventId: string;
  item: SellerEventItem;
  quantity: number;
  startingPriceCents: number;
};

function eventInitials(title: string): string {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('') || 'EV';
}

function eventTiming(event: SellerOwnedEvent): string {
  const date = event.status === 'ended' ? event.endedAt : event.startsAt;
  if (!date) return event.status === 'draft' ? 'Not scheduled' : 'Schedule pending';
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return 'Schedule pending';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

function managerRoute(
  eventId: string | undefined,
  section: EventManagerSection = 'lineup',
): EventManagerRoute {
  return { view: 'events', ...(eventId ? { eventId } : {}), section };
}

export function EventManager({
  eventId,
  actorId,
  eventName = 'Seller event',
  apiBaseUrl,
  initialItems,
  initialEvents,
  onEventReady,
}: EventManagerProps) {
  const [route, navigateRoute] = useUrlEventManagerRoute();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [eventSearch, setEventSearch] = useState('');
  const [busyProductId, setBusyProductId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sellerAuctionToken, setSellerAuctionToken] = useState(() => readSellerAuctionToken() ?? '');
  const [sellerAccessDraft, setSellerAccessDraft] = useState('');
  const [sellerAccessBusy, setSellerAccessBusy] = useState(false);

  const directoryQuery = useSyncQuery<SellerOwnedEvent>({
    queryName: 'events.mine',
    args: {},
    enabled: initialEvents === undefined,
    pollIntervalMs: 15_000,
  });
  const events = initialEvents ?? directoryQuery.data ?? [];
  const filteredEvents = useMemo(() => {
    const needle = eventSearch.trim().toLowerCase();
    return needle
      ? events.filter((event) => `${event.title} ${event.status}`.toLowerCase().includes(needle))
      : [...events];
  }, [eventSearch, events]);
  const routedEvent = route.eventId
    ? events.find((event) => event.eventId === route.eventId)
    : undefined;
  const fallbackEvent = events.find((event) => event.eventId === eventId) ?? events[0];
  const selectedEvent = routedEvent ?? fallbackEvent;
  const selectedEventId = route.eventId ?? selectedEvent?.eventId ?? eventId;
  const isCreateView = route.view === 'create';

  const configQuery = useSyncQuery<EventConfigView>({
    queryName: 'event.config',
    args: { eventId: selectedEventId },
    enabled: initialItems === undefined && !isCreateView,
    pollIntervalMs: 30_000,
  });
  const itemsQuery = useSyncQuery<SellerEventItem>({
    queryName: 'event.actions.items',
    args: { eventId: selectedEventId },
    enabled: initialItems === undefined && !isCreateView,
    pollIntervalMs: 10_000,
  });
  const name = configQuery.data?.[0]?.name ?? selectedEvent?.title ?? eventName;
  const items = initialItems ?? itemsQuery.data ?? [];
  const loaded = isCreateView || initialItems !== undefined || (!configQuery.loading && !itemsQuery.loading);
  const readError = initialItems === undefined ? configQuery.error ?? itemsQuery.error : null;

  const setupFallback = useCallback(
    async (payload: EventCreationPayload) => setupSellerEvent(payload, apiBaseUrl),
    [apiBaseUrl],
  );
  const mutateSetup = useSyncMutate<EventCreationPayload, SellerEventSetup>('event.setup', setupFallback);

  const addItemsFallback = useCallback(
    async ({ eventId: resolvedEventId, payload }: AddItemsMutation) => (
      addItemsToSellerEvent(resolvedEventId, payload, apiBaseUrl)
    ),
    [apiBaseUrl],
  );
  const mutateAddItems = useSyncMutate<AddItemsMutation, SellerEventSetup>('event.addItems', addItemsFallback);

  const actionFallback = useCallback(
    async ({ eventId: resolvedEventId, actorId: resolvedActorId, action }: ExecuteActionMutation) => (
      executeSellerAction(resolvedEventId, resolvedActorId, action, apiBaseUrl)
    ),
    [apiBaseUrl],
  );
  const mutateAction = useSyncMutate<ExecuteActionMutation, SellerActionResult>('event.executeAction', actionFallback);

  const stockFallback = useCallback(
    async ({ eventId: resolvedEventId, actorId: resolvedActorId, item, quantity }: AdjustStockMutation) => (
      adjustSellerEventStock(resolvedEventId, resolvedActorId, item, quantity, apiBaseUrl)
    ),
    [apiBaseUrl],
  );
  const mutateStock = useSyncMutate<AdjustStockMutation, SellerActionResult>('event.adjustStock', stockFallback);

  const auctionFallback = useCallback(
    async ({ eventId: resolvedEventId, item, quantity, startingPriceCents }: StartAuctionMutation) => (
      startSellerAuction(resolvedEventId, item, quantity, startingPriceCents, apiBaseUrl, sellerAuctionToken || undefined)
    ),
    [apiBaseUrl, sellerAuctionToken],
  );
  const mutateStartAuction = useSyncMutate<StartAuctionMutation, SellerAuction>('auction.start', auctionFallback);

  useEffect(() => {
    setPickerOpen(false);
    setMessage(null);
  }, [selectedEventId]);

  const submitPicker = async (payload: EventCreationPayload) => {
    setMessage(null);
    const result = isCreateView
      ? await mutateSetup(payload)
      : await mutateAddItems({ eventId: selectedEventId, payload });
    setPickerOpen(false);
    setMessage(isCreateView ? 'Event created and inventory reserved.' : 'Catalog items reserved and added to the live event.');
    onEventReady?.(result.eventId, result.name);
    navigateRoute(managerRoute(result.eventId));
  };

  const runAction = async (
    productId: string,
    task: () => Promise<unknown>,
    success: string,
  ) => {
    setBusyProductId(productId);
    setMessage(null);
    try {
      await task();
      setMessage(success);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyProductId(null);
    }
  };

  const unlockAuctionWrites = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = sellerAccessDraft.trim();
    if (!token) return;
    setSellerAccessBusy(true);
    setMessage(null);
    try {
      await verifySellerAuctionAccess(token, apiBaseUrl);
      rememberSellerAuctionToken(token);
      setSellerAuctionToken(token);
      setSellerAccessDraft('');
      setMessage('Seller auction writes unlocked for this browser session.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setSellerAccessBusy(false);
    }
  };

  const openRoute = (next: EventManagerRoute) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigateRoute(next);
  };

  const selectEvent = (event: SellerOwnedEvent) => {
    onEventReady?.(event.eventId, event.title);
    navigateRoute(managerRoute(event.eventId, route.section));
  };

  const eventStatus = selectedEvent?.status ?? 'draft';

  return (
    <section className="event-manager" aria-labelledby="event-manager-title">
      <div className="event-manager-heading">
        <div>
          <p className="eyebrow">Seller workspace · event setup</p>
          <h2 id="event-manager-title">Event Manager</h2>
          <p className="event-manager-copy">
            Choose an event to manage, or create one from real catalog inventory. Guarded seller actions remain enforced server-side.
          </p>
        </div>
        <nav className="event-manager-switch" aria-label="Event Manager view" role="tablist">
          <a
            className={route.view === 'events' ? 'is-active' : undefined}
            href={eventManagerHref(managerRoute(selectedEventId), typeof window === 'undefined' ? '/' : window.location.href)}
            role="tab"
            aria-selected={route.view === 'events'}
            aria-controls="event-manager-events"
            onClick={openRoute(managerRoute(selectedEventId))}
          >
            My events <span>{events.length}</span>
          </a>
          <a
            className={route.view === 'create' ? 'is-active' : undefined}
            href={eventManagerHref({ view: 'create', section: 'lineup' }, typeof window === 'undefined' ? '/' : window.location.href)}
            role="tab"
            aria-selected={route.view === 'create'}
            aria-controls="event-manager-create"
            onClick={openRoute({ view: 'create', section: 'lineup' })}
          >
            Create event
          </a>
        </nav>
      </div>

      {route.view === 'create' ? (
        <div id="event-manager-create" role="tabpanel" className="event-manager-create-view">
          <EventCreationPanel
            title="Build the live lineup"
            copy="Name the event, reserve real catalog inventory, and set the guarded price and quantity for every item."
            submitLabel="Create event"
            onCreateEvent={submitPicker}
          />
        </div>
      ) : (
        <div id="event-manager-events" role="tabpanel" className="event-manager-layout">
          <aside className="event-list-panel" aria-label="My events">
            <div className="event-list-heading">
              <div>
                <p className="eyebrow">My events</p>
                <strong>Drafts, scheduled rooms, live shows, and replays</strong>
              </div>
              <span className="event-list-count">{events.length} total</span>
            </div>
            <label className="event-search-field event-list-search">
              <span aria-hidden="true">⌕</span>
              <span className="sr-only">Search my events</span>
              <input
                type="search"
                placeholder="Search events"
                value={eventSearch}
                onChange={(event) => setEventSearch(event.target.value)}
              />
            </label>
            {directoryQuery.loading ? <p className="event-list-state" role="status">Loading your events…</p> : null}
            {directoryQuery.error ? <p className="event-list-state" role="status">{errorMessage(directoryQuery.error)}</p> : null}
            <div className="event-list">
              {filteredEvents.map((event) => (
                <button
                  key={event.eventId}
                  type="button"
                  className={`event-list-row${event.eventId === selectedEventId ? ' is-selected' : ''}`}
                  aria-pressed={event.eventId === selectedEventId}
                  onClick={() => selectEvent(event)}
                >
                  <span className="event-list-avatar" aria-hidden="true">{eventInitials(event.title)}</span>
                  <span className="event-list-copy">
                    <strong>{event.title}</strong>
                    <small>{eventTiming(event)}</small>
                  </span>
                  <span className={`event-status event-status-${event.status}`}>{event.status}</span>
                </button>
              ))}
            </div>
            {!directoryQuery.loading && filteredEvents.length === 0 ? (
              <div className="event-list-empty">
                <p>{eventSearch ? 'No events match this search.' : 'No seller events yet.'}</p>
                {!eventSearch ? (
                  <a
                    className="button secondary"
                    href={eventManagerHref({ view: 'create', section: 'lineup' }, typeof window === 'undefined' ? '/' : window.location.href)}
                    onClick={openRoute({ view: 'create', section: 'lineup' })}
                  >
                    Create event
                  </a>
                ) : null}
              </div>
            ) : null}
          </aside>

          <section className="event-detail-panel" aria-labelledby="event-detail-title">
            <div className="event-detail-heading">
              <div>
                <span className={`event-status event-status-${eventStatus}`}>{eventStatus}</span>
                <h3 id="event-detail-title">{name}</h3>
                <p>{items.length} reserved {items.length === 1 ? 'item' : 'items'} · Event ID {selectedEventId}</p>
              </div>
              <button className="button secondary" type="button" onClick={() => setPickerOpen((open) => !open)}>
                {pickerOpen ? 'Close lineup editor' : 'Add inventory'}
              </button>
            </div>

            <nav className="event-detail-tabs" aria-label={`${name} detail`} role="tablist">
              {(['lineup', 'settings'] as const).map((section) => {
                const next = managerRoute(selectedEventId, section);
                return (
                  <a
                    key={section}
                    className={route.section === section ? 'is-active' : undefined}
                    href={eventManagerHref(next, typeof window === 'undefined' ? '/' : window.location.href)}
                    role="tab"
                    aria-selected={route.section === section}
                    onClick={openRoute(next)}
                  >
                    {section === 'lineup' ? 'Lineup' : 'Settings'}
                  </a>
                );
              })}
            </nav>

            {route.section === 'settings' ? (
              <div className="event-settings-view" role="tabpanel">
                <EventSettingsPanel eventId={selectedEventId} apiBaseUrl={apiBaseUrl} embedded />
              </div>
            ) : (
              <div className="event-lineup-view" role="tabpanel">
                {!loaded ? <p className="event-manager-message" role="status">Loading verified event state…</p> : null}
                {readError ? <p className="event-manager-message" role="status">{errorMessage(readError)}</p> : null}

                {loaded && pickerOpen ? (
                  <EventCreationPanel
                    initialEventName={name}
                    eventNameReadOnly
                    title={`Add inventory to ${name}`}
                    copy="Select more real-catalog inventory and set the event price and reserved quantity."
                    submitLabel="Reserve and add items"
                    onCreateEvent={submitPicker}
                  />
                ) : null}

                {items.length ? (
                  <>
                    <div className="event-guardrail-banner">
                      <span className="feature-icon cyan" aria-hidden="true">⌁</span>
                      <span>
                        <strong>Guarded seller actions are live</strong>
                        <small>Price floors, markdown limits, verified inventory, audit, and rollback are enforced server-side.</small>
                      </span>
                    </div>
                    <form className="event-auction-access" onSubmit={(event) => void unlockAuctionWrites(event)}>
                      <div>
                        <strong>{sellerAuctionToken ? 'Auction writes unlocked' : 'Unlock auction writes'}</strong>
                        <small>Start and close require the server-configured seller credential. It stays in this browser session only.</small>
                      </div>
                      {!sellerAuctionToken ? (
                        <div className="event-auction-access-controls">
                          <label htmlFor="seller-auction-access">Seller credential</label>
                          <input
                            id="seller-auction-access"
                            type="password"
                            autoComplete="current-password"
                            value={sellerAccessDraft}
                            onChange={(event) => setSellerAccessDraft(event.target.value)}
                          />
                          <button className="button secondary" type="submit" disabled={sellerAccessBusy || !sellerAccessDraft.trim()}>
                            {sellerAccessBusy ? 'Checking…' : 'Unlock'}
                          </button>
                        </div>
                      ) : null}
                    </form>
                    <div className="event-manager-queue-heading">
                      <div>
                        <p className="eyebrow">Event lineup</p>
                        <strong>{items.length} reserved {items.length === 1 ? 'item' : 'items'} ready for the live room</strong>
                      </div>
                    </div>
                    <EventLineupGrid
                      items={items}
                      busyProductId={busyProductId}
                      onPush={(item) => void runAction(
                        item.productId,
                        () => mutateAction({
                          eventId: selectedEventId,
                          actorId,
                          action: { kind: 'push', productId: item.productId, reason: 'Seller pushed this verified item to the live stage' },
                        }),
                        `${item.title} is now on stage.`,
                      )}
                      onSwap={(current, target) => void runAction(
                        target.productId,
                        () => mutateAction({
                          eventId: selectedEventId,
                          actorId,
                          action: {
                            kind: 'swap',
                            productId: current.productId,
                            swapToProductId: target.productId,
                            reason: 'Seller swapped the next verified item onto the live stage',
                          },
                        }),
                        `${target.title} replaced ${current.title} on stage.`,
                      )}
                      onMarkdown={(item, percent) => void runAction(
                        item.productId,
                        () => mutateAction({
                          eventId: selectedEventId,
                          actorId,
                          action: {
                            kind: 'markdown',
                            productId: item.productId,
                            priceCents: Math.max(1, Math.round(item.priceCents * (1 - percent / 100))),
                            reason: `Seller applied a ${percent}% live-event markdown`,
                          },
                        }),
                        `${item.title} markdown passed the event guardrail.`,
                      )}
                      onStockAdjust={(item, quantity) => void runAction(
                        item.productId,
                        () => mutateStock({ eventId: selectedEventId, actorId, item, quantity }),
                        `${item.title} inventory reservation is now ${quantity}.`,
                      )}
                      onStartAuction={(item, quantity, startingPriceCents) => void runAction(
                        item.productId,
                        () => mutateStartAuction({ eventId: selectedEventId, item, quantity, startingPriceCents }),
                        `${quantity} × ${item.title} auction started.`,
                      )}
                      onSendOffer={(item, buyerId, quantity, priceCents) => void runAction(
                        item.productId,
                        () => mutateAction({
                          eventId: selectedEventId,
                          actorId,
                          action: {
                            kind: 'targeted-offer',
                            productId: item.productId,
                            buyerId,
                            quantity,
                            priceCents,
                            reason: `Seller sent ${buyerId} a quantity-aware targeted offer`,
                          },
                        }),
                        `${quantity} × ${item.title} offered to ${buyerId}.`,
                      )}
                    />
                  </>
                ) : loaded && !pickerOpen ? (
                  <div className="event-detail-empty">
                    <div>
                      <strong>This event has no reserved inventory yet.</strong>
                      <p>Add verified catalog items before opening the live room.</p>
                      <button className="button primary" type="button" onClick={() => setPickerOpen(true)}>Add inventory</button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>
      )}

      {message ? <p className="event-manager-message" role="status">{message}</p> : null}
    </section>
  );
}

export default EventManager;
