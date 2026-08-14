import { describe, expect, it } from 'vitest';
import {
  formatHoldCountdown,
  holdRemainingMs,
  planHoldWrite,
  toCartData,
  MAX_HELD_QUANTITY,
} from './buyer-cart-adapter';
import type { BuyerCart } from './buyer-checkout-api';

/**
 * The hold rules the shared cart drawer is driven by. They live here — pure,
 * outside the component — precisely so they can be asserted without a DOM: the
 * drawer only dispatches on `planHoldWrite`, and the countdown it renders is
 * `formatHoldCountdown(holdRemainingMs(...))`.
 */

const cart: BuyerCart = {
  id: 'cart-1',
  currency: 'USD',
  subtotalCents: 5000,
  updatedAt: '2026-08-14T06:00:00Z',
  items: [
    { productId: 'mug', title: 'Aurora mug', priceCents: 2500, quantity: 2, expiresAt: '2026-08-14T06:02:00Z' },
    { productId: 'lamp', title: 'Dune lamp', priceCents: 4000, quantity: 1, imageUrl: 'https://cdn.test/lamp.png' },
  ],
};

describe('planHoldWrite', () => {
  it('treats stepping a line below one as releasing the hold, not holding zero', () => {
    // The shared stepper is a generic 0..n control; the server rejects 0, and a
    // buyer who steps to nothing means "give it up", so this must not become a
    // set-to-zero request that fails.
    expect(planHoldWrite(0)).toEqual({ kind: 'release' });
    expect(planHoldWrite(-3)).toEqual({ kind: 'release' });
  });

  it('rejects above the server ceiling locally instead of spending a failing request', () => {
    const plan = planHoldWrite(MAX_HELD_QUANTITY + 1);
    expect(plan.kind).toBe('reject');
    expect(plan).toMatchObject({ reason: expect.stringContaining(String(MAX_HELD_QUANTITY)) });
  });

  it('rejects a non-integer draft rather than sending one the server will refuse', () => {
    expect(planHoldWrite(2.5).kind).toBe('reject');
    expect(planHoldWrite(Number.NaN).kind).toBe('reject');
  });

  it('passes an in-range quantity through unchanged', () => {
    expect(planHoldWrite(1)).toEqual({ kind: 'set', quantity: 1 });
    expect(planHoldWrite(MAX_HELD_QUANTITY)).toEqual({ kind: 'set', quantity: MAX_HELD_QUANTITY });
  });
});

describe('holdRemainingMs', () => {
  const now = Date.parse('2026-08-14T06:00:30Z');

  it('counts down to the server-authored deadline', () => {
    expect(holdRemainingMs('2026-08-14T06:02:00Z', now)).toBe(90_000);
  });

  it('floors at zero once the deadline has passed instead of going negative', () => {
    expect(holdRemainingMs('2026-08-14T06:00:00Z', now)).toBe(0);
  });

  it('reads a line with no expiry as un-held rather than as expired', () => {
    expect(holdRemainingMs(undefined, now)).toBeNull();
  });

  it('reads an unparseable expiry as ALREADY EXPIRED, never as indefinite', () => {
    // The safe failure is releasing a hold the buyer no longer has; rendering an
    // endless hold off a malformed timestamp would misreport reserved stock.
    expect(holdRemainingMs('not-a-date', now)).toBe(0);
  });
});

describe('formatHoldCountdown', () => {
  it('renders m:ss with a zero-padded seconds field', () => {
    expect(formatHoldCountdown(90_000)).toBe('1:30');
    expect(formatHoldCountdown(9_000)).toBe('0:09');
    expect(formatHoldCountdown(0)).toBe('0:00');
  });

  it('rounds UP so a hold never reads 0:00 while it is still live', () => {
    expect(formatHoldCountdown(1)).toBe('0:01');
  });

  it('labels a line with no expiry rather than printing a fake clock', () => {
    expect(formatHoldCountdown(null)).toBe('Reserved');
  });
});

describe('toCartData', () => {
  it('keys each library line by product id, which is the server line key', () => {
    const mapped = toCartData(cart);
    expect(mapped?.items.map((item) => item.id)).toEqual(['mug', 'lamp']);
    expect(mapped?.items[0]).toMatchObject({
      productId: 'mug',
      quantity: 2,
      product: { id: 'mug', title: 'Aurora mug', priceCents: 2500 },
    });
  });

  it('leaves availableQty unset so the library never clamps against unknown stock', () => {
    // The cart payload carries no stock figure. A clamp against `undefined`
    // would be a client-side guess disagreeing with the server that owns
    // inventory; unset means "unknown, do not clamp".
    expect(toCartData(cart)?.items.every((item) => item.availableQty === undefined)).toBe(true);
  });

  it('normalizes a missing image to null so the card renders its fallback', () => {
    const mapped = toCartData(cart);
    expect(mapped?.items[0].product.imageUrl).toBeNull();
    expect(mapped?.items[1].product.imageUrl).toBe('https://cdn.test/lamp.png');
  });

  it('maps no cart to no cart', () => {
    expect(toCartData(null)).toBeNull();
    expect(toCartData(undefined)).toBeNull();
  });
});
