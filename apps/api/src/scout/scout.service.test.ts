import { describe, expect, it } from 'vitest';
import { CartService, InMemoryCartStore } from '../cart/cart.service';
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
});
