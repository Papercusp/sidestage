import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_EVENT_LOW_STOCK_THRESHOLD,
  ActiveEventInventoryPanel,
  activeEventLowStockCount,
  clampActiveEventQuantity,
} from './ActiveEventInventoryPanel';
import type { SellerEventItem } from './events/api';

const ITEMS: SellerEventItem[] = [
  {
    eventId: 'event-1', eventItemId: 'event-1:mug', productId: 'mug', title: 'Cobalt mug',
    currentPriceCents: 4_800, currentQuantity: 12, listedQuantity: 3, attributes: { sku: 'MUG-COBALT' },
  },
  {
    eventId: 'event-1', eventItemId: 'event-1:tray', productId: 'tray', title: 'Terrazzo tray',
    currentPriceCents: 3_600, currentQuantity: 20, listedQuantity: 8, attributes: { sku: 'TRAY-01' },
  },
];

describe('ActiveEventInventoryPanel', () => {
  it('renders event-scoped stock controls, an add affordance, and a low-stock summary', () => {
    const markup = renderToStaticMarkup(
      <ActiveEventInventoryPanel
        eventId="event-1"
        actorId="seller-1"
        eventName="Friday studio drop"
        initialItems={ITEMS}
      />,
    );

    expect(markup).toContain('Inventory without leaving the show');
    expect(markup).toContain('2 items · 11 reserved units');
    expect(markup).toContain('1 low-stock item needs attention');
    expect(markup).toContain('+ Add item');
    expect(markup).toContain('Decrease event stock for Cobalt mug');
    expect(markup).toContain('Increase event stock for Terrazzo tray');
    expect(markup).toContain('All changes saved');
  });

  it('uses the documented three-unit low-stock threshold', () => {
    expect(ACTIVE_EVENT_LOW_STOCK_THRESHOLD).toBe(3);
    expect(activeEventLowStockCount(ITEMS)).toBe(1);
    expect(activeEventLowStockCount([{ listedQuantity: 4 }, { listedQuantity: 5 }])).toBe(0);
  });

  it('clamps draft quantities to verified event bounds', () => {
    expect(clampActiveEventQuantity({ currentQuantity: 7 }, -1)).toBe(0);
    expect(clampActiveEventQuantity({ currentQuantity: 7 }, 4.9)).toBe(4);
    expect(clampActiveEventQuantity({ currentQuantity: 7 }, 20)).toBe(7);
  });
});
