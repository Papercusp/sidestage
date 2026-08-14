import { useEffect, useState } from 'react';
import EventCreationPanel from '../event-creation/EventCreationPanel';
import type { EventCreationPayload } from '../event-creation/catalog';
import {
  addItemsToSellerEvent,
  adjustSellerEventStock,
  executeSellerAction,
  fetchSellerEvent,
  setupSellerEvent,
  startSellerAuction,
  type SellerEventItem,
} from './api';
import EventLineupGrid from './EventLineupGrid';
import './event-manager.css';

export interface EventManagerProps {
  eventId: string;
  eventName?: string;
  apiBaseUrl?: string;
  initialItems?: readonly SellerEventItem[];
  onEventReady?: (eventId: string, eventName: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The seller event request failed.';
}

export function EventManager({
  eventId,
  eventName = 'Seller event',
  apiBaseUrl,
  initialItems,
  onEventReady,
}: EventManagerProps) {
  const [name, setName] = useState(eventName);
  const [items, setItems] = useState<SellerEventItem[]>(() => [...(initialItems ?? [])]);
  const [loaded, setLoaded] = useState(initialItems !== undefined);
  const [pickerOpen, setPickerOpen] = useState((initialItems?.length ?? 0) === 0);
  const [busyProductId, setBusyProductId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async (id = eventId) => {
    const setup = await fetchSellerEvent(id, apiBaseUrl);
    setName(setup.name);
    setItems(setup.items);
    setLoaded(true);
    setPickerOpen(setup.items.length === 0);
    return setup;
  };

  useEffect(() => {
    if (initialItems !== undefined) return;
    let cancelled = false;
    setLoaded(false);
    void fetchSellerEvent(eventId, apiBaseUrl)
      .then((setup) => {
        if (cancelled) return;
        setName(setup.name);
        setItems(setup.items);
        setPickerOpen(setup.items.length === 0);
        setLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setItems([]);
        setPickerOpen(true);
        setMessage(errorMessage(error));
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [apiBaseUrl, eventId, initialItems]);

  const submitPicker = async (payload: EventCreationPayload) => {
    setMessage(null);
    const result = items.length
      ? await addItemsToSellerEvent(eventId, payload, apiBaseUrl)
      : await setupSellerEvent(payload, apiBaseUrl);
    setName(result.name);
    setItems(result.items);
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
      await refresh();
      setMessage(success);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyProductId(null);
    }
  };

  return (
    <section className="event-manager" aria-labelledby="event-manager-title">
      <div className="event-manager-heading">
        <div>
          <p className="eyebrow">Seller workspace · event setup</p>
          <h2 id="event-manager-title">{items.length ? name : 'Build the live lineup.'}</h2>
          <p className="event-manager-copy">
            Search the real catalog, reserve event quantities, then run Push, Swap, Markdown, and Stock through the guarded action service.
          </p>
        </div>
      </div>

      {!loaded ? <p className="event-manager-message" role="status">Loading verified event state…</p> : null}

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
              () => executeSellerAction(eventId, {
                kind: 'push',
                productId: item.productId,
                reason: 'Seller pushed this verified item to the live stage',
              }, apiBaseUrl),
              `${item.title} is now on stage.`,
            )}
            onSwap={(current, target) => void runAction(
              target.productId,
              () => executeSellerAction(eventId, {
                kind: 'swap',
                productId: current.productId,
                swapToProductId: target.productId,
                reason: 'Seller swapped the next verified item onto the live stage',
              }, apiBaseUrl),
              `${target.title} replaced ${current.title} on stage.`,
            )}
            onMarkdown={(item, percent) => void runAction(
              item.productId,
              () => executeSellerAction(eventId, {
                kind: 'markdown',
                productId: item.productId,
                priceCents: Math.max(1, Math.round(item.priceCents * (1 - percent / 100))),
                reason: `Seller applied a ${percent}% live-event markdown`,
              }, apiBaseUrl),
              `${item.title} markdown passed the event guardrail.`,
            )}
            onStockAdjust={(item, quantity) => void runAction(
              item.productId,
              () => adjustSellerEventStock(eventId, item, quantity, apiBaseUrl),
              `${item.title} inventory reservation is now ${quantity}.`,
            )}
            onStartAuction={(item, quantity, startingPriceCents) => void runAction(
              item.productId,
              () => startSellerAuction(eventId, item, quantity, startingPriceCents, apiBaseUrl),
              `${quantity} × ${item.title} auction started.`,
            )}
            onSendOffer={(item, buyerId, quantity, priceCents) => void runAction(
              item.productId,
              () => executeSellerAction(eventId, {
                kind: 'targeted-offer',
                productId: item.productId,
                buyerId,
                quantity,
                priceCents,
                reason: `Seller sent ${buyerId} a quantity-aware targeted offer`,
              }, apiBaseUrl),
              `${quantity} × ${item.title} offered to ${buyerId}.`,
            )}
          />
        </>
      ) : null}

      {message ? <p className="event-manager-message" role="status">{message}</p> : null}
    </section>
  );
}

export default EventManager;
