import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSyncMutate, useSyncPrincipal, useSyncQuery } from '@papercusp/sync';
import EventCreationPanel from './event-creation/EventCreationPanel';
import type { EventCreationPayload } from './event-creation/catalog';
import {
  addItemsToSellerEvent,
  adjustSellerEventStock,
  type SellerActionResult,
  type SellerEventItem,
  type SellerEventSetup,
} from './events/api';
import './active-event-inventory.css';

export const ACTIVE_EVENT_LOW_STOCK_THRESHOLD = 3;

export function activeEventLowStockCount(
  items: readonly Pick<SellerEventItem, 'listedQuantity'>[],
  threshold = ACTIVE_EVENT_LOW_STOCK_THRESHOLD,
): number {
  return items.filter((item) => item.listedQuantity <= threshold).length;
}

export function clampActiveEventQuantity(
  item: Pick<SellerEventItem, 'currentQuantity'>,
  quantity: number,
): number {
  const maximum = Math.max(0, Math.floor(item.currentQuantity));
  const next = Number.isFinite(quantity) ? Math.floor(quantity) : 0;
  return Math.min(maximum, Math.max(0, next));
}

type AdjustStockMutation = {
  eventId: string;
  actorId: string;
  item: SellerEventItem;
  quantity: number;
};

type AddItemsMutation = {
  eventId: string;
  payload: EventCreationPayload;
};

export interface ActiveEventInventoryPanelProps {
  eventId: string;
  actorId: string;
  eventName?: string;
  apiBaseUrl?: string;
  initialItems?: readonly SellerEventItem[];
  onLowStockCountChange?: (count: number) => void;
}

function formatPrice(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function productInitials(title: string): string {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'IT';
}

export function ActiveEventInventoryPanel({
  eventId,
  actorId,
  eventName = 'Seller event',
  apiBaseUrl,
  initialItems,
  onLowStockCountChange,
}: ActiveEventInventoryPanelProps) {
  const principal = useSyncPrincipal() ?? actorId;
  const itemsQuery = useSyncQuery<SellerEventItem>({
    queryName: 'event.actions.items',
    args: { eventId },
    enabled: initialItems === undefined,
    pollIntervalMs: 10_000,
  });
  const items = useMemo(
    () => initialItems ?? itemsQuery.data ?? [],
    [initialItems, itemsQuery.data],
  );
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const lowStockCount = activeEventLowStockCount(items);
  const totalUnits = items.reduce((sum, item) => sum + item.listedQuantity, 0);
  const dirtyItems = items.filter((item) => (
    (drafts[item.productId] ?? item.listedQuantity) !== item.listedQuantity
  ));

  useEffect(() => {
    onLowStockCountChange?.(lowStockCount);
  }, [lowStockCount, onLowStockCountChange]);

  useEffect(() => {
    const currentIds = new Set(items.map((item) => item.productId));
    setDrafts((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([productId]) => currentIds.has(productId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [items]);

  const stockFallback = useCallback(
    ({ eventId: resolvedEventId, actorId: resolvedActorId, item, quantity }: AdjustStockMutation) => (
      adjustSellerEventStock(resolvedEventId, resolvedActorId, item, quantity, apiBaseUrl, principal)
    ),
    [apiBaseUrl, principal],
  );
  const mutateStock = useSyncMutate<AdjustStockMutation, SellerActionResult>(
    'event.adjustStock',
    stockFallback,
  );

  const addItemsFallback = useCallback(
    ({ eventId: resolvedEventId, payload }: AddItemsMutation) => (
      addItemsToSellerEvent(resolvedEventId, payload, apiBaseUrl, principal)
    ),
    [apiBaseUrl, principal],
  );
  const mutateAddItems = useSyncMutate<AddItemsMutation, SellerEventSetup>(
    'event.addItems',
    addItemsFallback,
  );

  const adjustDraft = (item: SellerEventItem, delta: number) => {
    setMessage(null);
    setDrafts((current) => ({
      ...current,
      [item.productId]: clampActiveEventQuantity(
        item,
        (current[item.productId] ?? item.listedQuantity) + delta,
      ),
    }));
  };

  const saveChanges = async () => {
    if (!dirtyItems.length || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await Promise.all(dirtyItems.map((item) => mutateStock({
        eventId,
        actorId,
        item,
        quantity: drafts[item.productId] ?? item.listedQuantity,
      })));
      setDrafts({});
      itemsQuery.invalidate();
      setMessage({
        tone: 'success',
        text: `Saved ${dirtyItems.length} inventory ${dirtyItems.length === 1 ? 'change' : 'changes'}.`,
      });
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Inventory changes could not be saved.',
      });
    } finally {
      setSaving(false);
    }
  };

  const addItems = async (payload: EventCreationPayload) => {
    setMessage(null);
    await mutateAddItems({ eventId, payload });
    setPickerOpen(false);
    itemsQuery.invalidate();
    setMessage({
      tone: 'success',
      text: `Added ${payload.items.length} ${payload.items.length === 1 ? 'item' : 'items'} to ${eventName}.`,
    });
  };

  return (
    <section className="active-event-inventory" aria-labelledby="active-event-inventory-title">
      <header className="active-event-inventory-header">
        <div>
          <p className="panel-kicker">Event inventory</p>
          <h3 id="active-event-inventory-title">Inventory without leaving the show</h3>
          <p>{items.length} {items.length === 1 ? 'item' : 'items'} · {totalUnits} reserved {totalUnits === 1 ? 'unit' : 'units'}</p>
        </div>
        <div className="active-event-inventory-actions">
          <button
            className="button secondary"
            type="button"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            {pickerOpen ? 'Close picker' : '+ Add item'}
          </button>
          <button
            className="button primary"
            type="button"
            disabled={!dirtyItems.length || saving}
            onClick={() => void saveChanges()}
          >
            {saving ? 'Saving…' : `Save${dirtyItems.length ? ` (${dirtyItems.length})` : ''}`}
          </button>
        </div>
      </header>

      {lowStockCount ? (
        <p className="active-event-inventory-low-stock" role="status">
          {lowStockCount} low-stock {lowStockCount === 1 ? 'item needs' : 'items need'} attention
        </p>
      ) : null}

      {message ? (
        <p className={`active-event-inventory-message is-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      ) : null}

      {pickerOpen ? (
        <div className="active-event-inventory-picker">
          <EventCreationPanel
            initialEventName={eventName}
            eventNameReadOnly
            title={`Add inventory to ${eventName}`}
            copy="Choose real catalog items and reserve the quantity this live event can sell."
            submitLabel="Reserve and add items"
            onCreateEvent={addItems}
          />
        </div>
      ) : null}

      {itemsQuery.error && initialItems === undefined ? (
        <p className="active-event-inventory-message is-error" role="alert">
          Event inventory could not be loaded.
        </p>
      ) : itemsQuery.loading && initialItems === undefined ? (
        <p className="active-event-inventory-empty" role="status">Loading event inventory…</p>
      ) : items.length === 0 ? (
        <div className="active-event-inventory-empty">
          <strong>No event inventory yet</strong>
          <p>Add a catalog item to reserve it for this live room.</p>
        </div>
      ) : (
        <ul className="active-event-inventory-list">
          {items.map((item) => {
            const quantity = drafts[item.productId] ?? item.listedQuantity;
            const dirty = quantity !== item.listedQuantity;
            return (
              <li key={item.productId} className={dirty ? 'is-dirty' : undefined}>
                <span className="active-event-inventory-mark" aria-hidden="true">{productInitials(item.title)}</span>
                <span className="active-event-inventory-product">
                  <strong>{item.title}</strong>
                  <small>{formatPrice(item.currentPriceCents)} · {item.currentQuantity} verified available</small>
                </span>
                <span className="active-event-inventory-stepper">
                  <button
                    type="button"
                    aria-label={`Decrease event stock for ${item.title}`}
                    disabled={saving || quantity <= 0}
                    onClick={() => adjustDraft(item, -1)}
                  >−</button>
                  <output aria-label={`Event stock for ${item.title}`}>{quantity}</output>
                  <button
                    type="button"
                    aria-label={`Increase event stock for ${item.title}`}
                    disabled={saving || quantity >= item.currentQuantity}
                    onClick={() => adjustDraft(item, 1)}
                  >+</button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="active-event-inventory-footer" aria-live="polite">
        {dirtyItems.length
          ? `${dirtyItems.length} unsaved ${dirtyItems.length === 1 ? 'change' : 'changes'}`
          : 'All changes saved'}
      </footer>
    </section>
  );
}

export default ActiveEventInventoryPanel;
