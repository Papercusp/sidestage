import { describe, expect, it, vi } from 'vitest';
import { PgOrderStore } from './pg-order-store';

describe('PgOrderStore buyer reads', () => {
  it('loads one canonical order by source identity', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ payload: { id: 'order-1' } }] }) };
    const store = new PgOrderStore(pool as never);

    await expect(store.findBySource('cart', 'cart-1')).resolves.toEqual({ id: 'order-1' });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/source_kind = \$1 AND source_id = \$2/),
      ['cart', 'cart-1'],
    );
  });

  it('looks up webhook targets through the unique Stripe PaymentIntent column', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ payload: { id: 'order-1' } }] }) };
    const store = new PgOrderStore(pool as never);

    await expect(store.findByPaymentIntent('pi_123')).resolves.toEqual({ id: 'order-1' });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('stripe_payment_intent_id = $1'),
      ['pi_123'],
    );
  });

  it('returns the bounded buyer order history from lifted identity', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ payload: { id: 'new' } }, { payload: { id: 'old' } }] }),
    };
    const store = new PgOrderStore(pool as never);

    await expect(store.listByBuyer('buyer-1')).resolves.toEqual([{ id: 'new' }, { id: 'old' }]);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/buyer_id = \$1.*ORDER BY updated_at DESC LIMIT 200/),
      ['buyer-1'],
    );
  });

  it('writes lifted identity and payment state beside the lossless payload', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const store = new PgOrderStore(pool as never);
    const order = {
      id: 'order-1',
      buyerId: 'buyer-1',
      sourceKind: 'auction',
      sourceId: 'auction-1',
      eventId: 'event-1',
      subtotalCents: 1900,
      shippingCents: 0,
      totalCents: 1900,
      currency: 'USD',
      status: 'pending',
      paymentState: 'payment_required',
      createdAt: '2026-08-14T02:00:00.000Z',
      items: [],
    } as const;

    await store.set(order);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('(id, cart_id, buyer_id, source_kind, source_id, status, payment_state'),
      [
        'order-1', null, 'buyer-1', 'auction', 'auction-1', 'pending',
        'payment_required', null, JSON.stringify(order),
      ],
    );
  });
});
