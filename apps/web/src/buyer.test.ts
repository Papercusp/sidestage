import { describe, expect, it } from 'vitest';

import {
  availableBuyerProducts,
  buildBuyerShareUrl,
  DEMO_BUYER_PRODUCTS,
  formatBuyerPrice,
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
    expect(availableBuyerProducts(DEMO_BUYER_PRODUCTS).map((product) => product.id)).toEqual([
      'linen-hoodie-blue-m',
      'stoneware-mug-matte-12oz',
    ]);
  });
});
