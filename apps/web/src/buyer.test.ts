import { describe, expect, it } from 'vitest';

import {
  availableBuyerProducts,
  buildBuyerShareUrl,
  formatBuyerPrice,
  type BuyerProduct,
} from './buyer';

describe('buyer surface model', () => {
  it('formats integer minor-unit prices at the UI edge', () => {
    expect(formatBuyerPrice(6800)).toBe('$68.00');
    expect(formatBuyerPrice(0)).toBe('$0.00');
  });

  it('creates a stable buyer share URL from the event room identity', () => {
    expect(buildBuyerShareUrl(' Sunday-Drop ', 'https://sidestage.example/live')).toBe(
      'https://sidestage.example/live?event=sunday-drop&view=buyer',
    );
  });

  it('does not count sold-out cards as available inventory', () => {
    const products: readonly BuyerProduct[] = [
      { id: 'in-stock-a', title: 'A', subtitle: 'a', priceCents: 100, availableQty: 4 },
      { id: 'in-stock-b', title: 'B', subtitle: 'b', priceCents: 200, availableQty: 1 },
      { id: 'sold-out', title: 'C', subtitle: 'c', priceCents: 300, availableQty: 0 },
    ];
    expect(availableBuyerProducts(products).map((product) => product.id)).toEqual([
      'in-stock-a',
      'in-stock-b',
    ]);
  });
});
