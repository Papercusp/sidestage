import { useMemo, useState } from 'react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { formatPrice } from '../event-creation/catalog';
import type { SellerEventItem } from './api';

export interface EventLineupGridProps {
  items: readonly SellerEventItem[];
  busyProductId?: string | null;
  onPush: (item: SellerEventItem) => void;
  onSwap: (current: SellerEventItem, target: SellerEventItem) => void;
  onMarkdown: (item: SellerEventItem, percent: number) => void;
  onStockAdjust: (item: SellerEventItem, quantity: number) => void;
  onStartAuction: (item: SellerEventItem, quantity: number, startingPriceCents: number) => void;
  onSendOffer: (item: SellerEventItem, buyerId: string, quantity: number, priceCents: number) => void;
}

interface CommerceDraft {
  auctionPrice: string;
  auctionQuantity: string;
  offerBuyer: string;
  offerPrice: string;
  offerQuantity: string;
}

function defaultCommerceDraft(item: SellerEventItem): CommerceDraft {
  const price = (item.priceCents / 100).toFixed(2);
  return {
    auctionPrice: price,
    auctionQuantity: '1',
    offerBuyer: '',
    offerPrice: price,
    offerQuantity: '1',
  };
}

function positiveWholeNumber(value: string, maximum: number): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
}

function priceInCents(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const cents = Math.round(parsed * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function initials(value: string): string {
  return value.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

export function EventLineupGrid({
  items,
  busyProductId,
  onPush,
  onSwap,
  onMarkdown,
  onStockAdjust,
  onStartAuction,
  onSendOffer,
}: EventLineupGridProps) {
  const [markdowns, setMarkdowns] = useState<Record<string, string>>({});
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [commerceDrafts, setCommerceDrafts] = useState<Record<string, CommerceDraft>>({});
  const onStage = items.find((item) => item.onStage);

  const updateCommerceDraft = (item: SellerEventItem, patch: Partial<CommerceDraft>) => {
    setCommerceDrafts((current) => ({
      ...current,
      [item.productId]: { ...(current[item.productId] ?? defaultCommerceDraft(item)), ...patch },
    }));
  };

  const columns = useMemo<ColumnDef<SellerEventItem>[]>(() => [
    {
      key: 'product',
      header: 'Product',
      headerText: 'Product',
      width: 2.2,
      toCopyText: (item) => item.title,
      render: ({ row }) => (
        <div className="event-item-product">
          <span className="event-item-mark" aria-hidden="true">{initials(row.title)}</span>
          <span>
            <strong>{row.title}</strong>
            <small>{String(row.attributes.brand ?? '')} · {String(row.attributes.sku ?? row.productId)}</small>
          </span>
        </div>
      ),
    },
    {
      key: 'stage',
      header: 'Stage',
      headerText: 'Stage',
      width: 'minmax(150px, .9fr)',
      toCopyText: (item) => item.onStage ? 'On stage' : 'Queued',
      render: ({ row }) => (
        <div className="event-row-actions">
          <span className={`event-stage-badge${row.onStage ? ' is-live' : ''}`}>
            {row.onStage ? 'On stage' : 'Queued'}
          </span>
          <button
            className="button tertiary"
            type="button"
            disabled={row.onStage || busyProductId === row.productId}
            onClick={() => onPush(row)}
          >
            Push
          </button>
          <button
            className="button tertiary"
            type="button"
            disabled={!onStage || row.onStage || busyProductId === row.productId}
            onClick={() => onStage && onSwap(onStage, row)}
          >
            Swap
          </button>
        </div>
      ),
    },
    {
      key: 'price',
      header: 'Live price',
      headerText: 'Live price',
      width: 'minmax(180px, 1fr)',
      align: 'right',
      toCopyText: (item) => formatPrice(item.priceCents),
      render: ({ row }) => (
        <div className="event-inline-action">
          <strong>{formatPrice(row.priceCents)}</strong>
          <label>
            <span className="sr-only">Markdown percent for {row.title}</span>
            <input
              aria-label={`Markdown percent for ${row.title}`}
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={markdowns[row.productId] ?? ''}
              placeholder="%"
              onChange={(event) => setMarkdowns((current) => ({ ...current, [row.productId]: event.target.value }))}
            />
          </label>
          <button
            className="button tertiary"
            type="button"
            disabled={busyProductId === row.productId || !markdowns[row.productId]}
            onClick={() => onMarkdown(row, Number(markdowns[row.productId]))}
          >
            Markdown
          </button>
        </div>
      ),
    },
    {
      key: 'stock',
      header: 'Event stock',
      headerText: 'Event stock',
      width: 'minmax(190px, 1fr)',
      align: 'right',
      toCopyText: (item) => `${item.quantity} of ${item.availableQty}`,
      render: ({ row }) => (
        <div className="event-inline-action">
          <span>{row.quantity}/{row.availableQty}</span>
          <label>
            <span className="sr-only">Event stock for {row.title}</span>
            <input
              aria-label={`Event stock for ${row.title}`}
              type="number"
              min={0}
              max={row.availableQty}
              step={1}
              value={quantities[row.productId] ?? String(row.quantity)}
              onChange={(event) => setQuantities((current) => ({ ...current, [row.productId]: event.target.value }))}
            />
          </label>
          <button
            className="button tertiary"
            type="button"
            disabled={busyProductId === row.productId}
            onClick={() => onStockAdjust(row, Number(quantities[row.productId] ?? row.quantity))}
          >
            Stock
          </button>
        </div>
      ),
    },
    {
      key: 'commerce',
      header: 'Auction / offer',
      headerText: 'Auction and targeted offer creation',
      width: 'minmax(360px, 1.8fr)',
      toCopyText: (item) => `Auction or offer ${item.quantity} reserved units`,
      render: ({ row }) => {
        const draft = commerceDrafts[row.productId] ?? defaultCommerceDraft(row);
        const maximum = Math.max(1, row.quantity);
        const auctionQuantity = positiveWholeNumber(draft.auctionQuantity, maximum);
        const auctionPriceCents = priceInCents(draft.auctionPrice);
        const offerQuantity = positiveWholeNumber(draft.offerQuantity, maximum);
        const offerPriceCents = priceInCents(draft.offerPrice);
        const disabled = busyProductId === row.productId;
        return (
          <div className="event-commerce-actions">
            <div className="event-commerce-row">
              <span className="event-commerce-kind">Auction</span>
              <label className="event-commerce-price">
                <span aria-hidden="true">$</span>
                <span className="sr-only">Auction starting price for {row.title}</span>
                <input
                  aria-label={`Auction starting price for ${row.title}`}
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={draft.auctionPrice}
                  onChange={(event) => updateCommerceDraft(row, { auctionPrice: event.target.value })}
                />
              </label>
              <label className="event-commerce-quantity">
                <span aria-hidden="true">×</span>
                <span className="sr-only">Auction quantity for {row.title}</span>
                <input
                  aria-label={`Auction quantity for ${row.title}`}
                  type="number"
                  min={1}
                  max={maximum}
                  step={1}
                  value={draft.auctionQuantity}
                  onChange={(event) => updateCommerceDraft(row, { auctionQuantity: event.target.value })}
                />
              </label>
              <button
                className="button tertiary"
                type="button"
                disabled={disabled || auctionQuantity === null || auctionPriceCents === null}
                onClick={() => auctionQuantity !== null && auctionPriceCents !== null
                  && onStartAuction(row, auctionQuantity, auctionPriceCents)}
              >
                Start auction
              </button>
            </div>
            <div className="event-commerce-row">
              <label className="event-commerce-buyer">
                <span className="sr-only">Offer buyer ID for {row.title}</span>
                <input
                  aria-label={`Offer buyer ID for ${row.title}`}
                  value={draft.offerBuyer}
                  placeholder="Buyer ID"
                  onChange={(event) => updateCommerceDraft(row, { offerBuyer: event.target.value })}
                />
              </label>
              <label className="event-commerce-price">
                <span aria-hidden="true">$</span>
                <span className="sr-only">Offer price for {row.title}</span>
                <input
                  aria-label={`Offer price for ${row.title}`}
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={draft.offerPrice}
                  onChange={(event) => updateCommerceDraft(row, { offerPrice: event.target.value })}
                />
              </label>
              <label className="event-commerce-quantity">
                <span aria-hidden="true">×</span>
                <span className="sr-only">Offer quantity for {row.title}</span>
                <input
                  aria-label={`Offer quantity for ${row.title}`}
                  type="number"
                  min={1}
                  max={maximum}
                  step={1}
                  value={draft.offerQuantity}
                  onChange={(event) => updateCommerceDraft(row, { offerQuantity: event.target.value })}
                />
              </label>
              <button
                className="button tertiary"
                type="button"
                disabled={disabled || !draft.offerBuyer.trim() || offerQuantity === null || offerPriceCents === null}
                onClick={() => offerQuantity !== null && offerPriceCents !== null
                  && onSendOffer(row, draft.offerBuyer.trim(), offerQuantity, offerPriceCents)}
              >
                Send
              </button>
            </div>
          </div>
        );
      },
    },
  ], [busyProductId, commerceDrafts, markdowns, onMarkdown, onPush, onSendOffer, onStage, onStartAuction, onStockAdjust, onSwap, quantities]);

  return (
    <RichGrid
      className="event-lineup-grid"
      columns={columns}
      rows={[...items]}
      getRowId={(item) => item.productId}
      rowProps={({ row }) => ({
        'data-testid': `event-item-${row.productId}`,
        'aria-label': `${row.title}, ${row.availableQty} available${row.onStage ? ', on stage' : ''}`,
      })}
      topSlot={(
        <div className="event-grid-note">
          <span><strong>Live lineup</strong> · every mutation is guarded and audited</span>
          <span>{onStage ? `${onStage.title} is on stage` : 'Push the first item when ready'}</span>
        </div>
      )}
      empty={<div className="event-grid-empty">No event items yet.</div>}
      rowMinHeight={64}
      headerHeight={42}
    />
  );
}

export default EventLineupGrid;
