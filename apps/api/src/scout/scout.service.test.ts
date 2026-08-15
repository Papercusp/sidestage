import { describe, expect, it } from 'vitest';
import { CartService, InMemoryCartStore } from '../cart/cart.service';
import type { CatalogVariant } from '../catalog/catalog.types';
import { DeterministicScoutReplyModel, ScoutService } from './scout.service';
import { FixtureCatalogSource } from '../catalog/catalog.sources';
import { scoutCatalogFrom } from './scout-catalog.adapter';
import { InMemoryScoutMemoryStore } from './scout-memory';

describe('ScoutService', () => {
  it('returns verified catalog cards and a stable cart id', async () => {
    const service = new ScoutService(scoutCatalogFrom(new FixtureCatalogSource()), new DeterministicScoutReplyModel(), new CartService(new InMemoryCartStore()), new InMemoryScoutMemoryStore());
    const response = await service.chat({ message: 'wireless headphones', maxProducts: 3 });
    expect(response.products[0].title).toContain('Headphones');
    expect(response.cartId).toBe(response.cart.id);
    expect(response.reply).toContain('verified');
  });

  it('fails clearly for an empty chat message', async () => {
    const service = new ScoutService(scoutCatalogFrom(new FixtureCatalogSource()), new DeterministicScoutReplyModel(), new CartService(new InMemoryCartStore()), new InMemoryScoutMemoryStore());
    await expect(service.chat({ message: '  ' })).rejects.toThrow('message is required');
  });

  it('returns actual computers, not matching accessories, and drops unrelated kettle memory', async () => {
    const base: Omit<CatalogVariant, 'id' | 'title' | 'productType'> = {
      groupId: null,
      brand: 'Restart',
      sku: 'SKU',
      condition: 'NEW',
      handlingDays: 1,
      priceCents: 100_00,
      qty: 2,
      reservedQty: 0,
      availableQty: 2,
    };
    const memory = new InMemoryScoutMemoryStore();
    await memory.remember('user:buyer-1', 'find me kettles', 'turn');
    const service = new ScoutService(
      scoutCatalogFrom(new FixtureCatalogSource([
        { ...base, id: 'laptop', title: 'Latitude laptop', productType: 'NOTEBOOK_COMPUTER' },
        { ...base, id: 'desktop', title: 'OptiPlex desktop', productType: 'PERSONAL_COMPUTER' },
        { ...base, id: 'bag', title: 'Computer carrying bag', productType: 'CARRYING_CASE_OR_BAG' },
      ])),
      new DeterministicScoutReplyModel(),
      new CartService(new InMemoryCartStore()),
      memory,
    );

    const response = await service.chat(
      { message: 'find me computers', maxProducts: 10 },
      { buyerId: 'buyer-1' },
    );

    expect(response.products.map((product) => product.productId)).toEqual(['laptop', 'desktop']);
    expect(response.reply.toLowerCase()).not.toContain('kettle');
  });
});
