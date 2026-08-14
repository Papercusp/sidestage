import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSyncMutate, useSyncQuery } from '@papercusp/sync';
import { EventSettingsPanel, type EventConfigView } from '../ConfigTab';
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
  onEventReady?: (eventId: string, eventName: string) => void;
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

export function EventManager({
  eventId,
  actorId,
  eventName = 'Seller event',
  apiBaseUrl,
  initialItems,
  onEventReady,
}: EventManagerProps) {
  const [pickerOpen, setPickerOpen] = useState((initialItems?.length ?? 0) === 0);
  const [busyProductId, setBusyProductId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sellerAuctionToken, setSellerAuctionToken] = useState(() => readSellerAuctionToken() ?? '');
  const [sellerAccessDraft, setSellerAccessDraft] = useState('');
  const [sellerAccessBusy, setSellerAccessBusy] = useState(false);

  const configQuery = useSyncQuery<EventConfigView>({
    queryName: 'event.config',
    args: { eventId },
    enabled: initialItems === undefined,
    pollIntervalMs: 30_000,
  });
  const itemsQuery = useSyncQuery<SellerEventItem>({
    queryName: 'event.actions.items',
    args: { eventId },
    enabled: initialItems === undefined,
    pollIntervalMs: 10_000,
  });
  const name = configQuery.data?.[0]?.name ?? eventName;
  const items = initialItems ?? itemsQuery.data ?? [];
  const loaded = initialItems !== undefined || (!configQuery.loading && !itemsQuery.loading);
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
    if (loaded) setPickerOpen(items.length === 0);
  }, [eventId, items.length, loaded]);

  const submitPicker = async (payload: EventCreationPayload) => {
    setMessage(null);
    const result = items.length
      ? await mutateAddItems({ eventId, payload })
      : await mutateSetup(payload);
    setPickerOpen(false);
    setMessage(items.length ? 'Catalog items reserved and added to the live event.' : 'Event created and inventory reserved.');
    onEventReady?.(result.eventId, result.name);
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

  return (
    <section className="event-manager" aria-labelledby="event-manager-title">
      <div className="event-manager-heading">
        <div>
          <p className="eyebrow">Seller workspace · event setup</p>
          <h2 id="event-manager-title">{items.length ? name : 'Build the live lineup.'}</h2>
          <p className="event-manager-copy">
            Search the real catalog, reserve event quantities, then push, swap, mark down, adjust stock, start auctions, and send offers through the guarded action service.
          </p>
        </div>
      </div>

      {!loaded ? <p className="event-manager-message" role="status">Loading verified event state…</p> : null}
      {readError ? <p className="event-manager-message" role="status">{errorMessage(readError)}</p> : null}

      {loaded && pickerOpen ? (
        <EventCreationPanel
          initialEventName={items.length ? name : ''}
          eventNameReadOnly={items.length > 0}
          title={items.length ? `Add inventory to ${name}` : 'Choose what goes on stage'}
          copy={items.length
            ? 'Select more real-catalog inventory and set the event price and reserved quantity.'
            : 'Create the event from real catalog inventory with a price and reservation-backed quantity for every item.'}
          submitLabel={items.length ? 'Reserve and add items' : 'Create event'}
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
              <p className="eyebrow">Event queue</p>
              <strong>{items.length} reserved {items.length === 1 ? 'item' : 'items'} ready for the live lineup</strong>
            </div>
            <button className="button secondary" type="button" onClick={() => setPickerOpen((open) => !open)}>
              {pickerOpen ? 'Close lineup editor' : 'Manage lineup'}
            </button>
          </div>
          <EventLineupGrid
            items={items}
            busyProductId={busyProductId}
            onPush={(item) => void runAction(
              item.productId,
              () => mutateAction({
                eventId,
                actorId,
                action: {
                  kind: 'push',
                  productId: item.productId,
                  reason: 'Seller pushed this verified item to the live stage',
                },
              }),
              `${item.title} is now on stage.`,
            )}
            onSwap={(current, target) => void runAction(
              target.productId,
              () => mutateAction({
                eventId,
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
                eventId,
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
              () => mutateStock({ eventId, actorId, item, quantity }),
              `${item.title} inventory reservation is now ${quantity}.`,
            )}
            onStartAuction={(item, quantity, startingPriceCents) => void runAction(
              item.productId,
              () => mutateStartAuction({ eventId, item, quantity, startingPriceCents }),
              `${quantity} × ${item.title} auction started.`,
            )}
            onSendOffer={(item, buyerId, quantity, priceCents) => void runAction(
              item.productId,
              () => mutateAction({
                eventId,
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
          <EventSettingsPanel eventId={eventId} apiBaseUrl={apiBaseUrl} embedded />
        </>
      ) : null}

      {message ? <p className="event-manager-message" role="status">{message}</p> : null}
    </section>
  );
}

export default EventManager;
