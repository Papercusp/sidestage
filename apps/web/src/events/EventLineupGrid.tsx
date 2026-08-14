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
}: EventLineupGridProps) {
  const [markdowns, setMarkdowns] = useState<Record<string, string>>({});
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const onStage = items.find((item) => item.onStage);

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
  ], [busyProductId, markdowns, onMarkdown, onPush, onStage, onStockAdjust, onSwap, quantities]);

  return (
    <RichGrid
      className="event-lineup-grid"
      columns={columns}
      rows={[...items]}
      getRowId={(item) => item.productId}
      rowProps={({ row }) => ({ 'data-testid': `event-item-${row.productId}` })}
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
