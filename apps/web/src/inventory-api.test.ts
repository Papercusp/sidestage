import { afterEach, describe, expect, it, vi } from 'vitest';
import { restockInventory } from './inventory-api';

describe('restockInventory', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts a validated variant intake to the shared inventory route', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ restocked: true, quantity: 3, snapshot: { productId: 'mug', qty: 5, reservedQty: 1, availableQty: 4 } }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await restockInventory({ productId: 'mug/blue', quantity: 3, priceCents: 1_500 }, 'https://api.example/');

    expect(fetchMock).toHaveBeenCalledWith('https://api.example/inventory/mug%2Fblue/restock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 3, priceCents: 1_500 }),
    });
  });
});
