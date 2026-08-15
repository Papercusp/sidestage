import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveInventory } from './inventory-api';

describe('saveInventory', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('puts authoritative quantity and price to the shared inventory route', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ saved: true, quantity: 3, priceCents: 1_500, snapshot: { productId: 'mug', qty: 3, reservedQty: 1, availableQty: 2, priceCents: 1_500 } }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await saveInventory({ productId: 'mug/blue', quantity: 3, priceCents: 1_500 }, 'https://api.example/');

    expect(fetchMock).toHaveBeenCalledWith('https://api.example/inventory/mug%2Fblue', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 3, priceCents: 1_500 }),
    });
  });
});
