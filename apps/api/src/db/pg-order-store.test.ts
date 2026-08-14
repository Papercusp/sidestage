import { describe, expect, it, vi } from 'vitest';
import { PgOrderStore } from './pg-order-store';

describe('PgOrderStore buyer reads', () => {
  it('scopes pending idempotency to both cart and buyer', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ payload: { id: 'order-1' } }] }) };
    const store = new PgOrderStore(pool as never);

    await expect(store.findPendingByCart('cart-1', 'buyer-1')).resolves.toEqual({ id: 'order-1' });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("payload->>'buyerId' = $2"),
      ['cart-1', 'buyer-1'],
    );
  });

  it('returns the bounded buyer order history from JSON payload identity', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ payload: { id: 'new' } }, { payload: { id: 'old' } }] }),
    };
    const store = new PgOrderStore(pool as never);

    await expect(store.listByBuyer('buyer-1')).resolves.toEqual([{ id: 'new' }, { id: 'old' }]);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/payload->>'buyerId'.*ORDER BY updated_at DESC LIMIT 200/),
      ['buyer-1'],
    );
  });
});
