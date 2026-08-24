import { describe, expect, it } from 'vitest';
import { CartService, InMemoryCartStore } from '../cart/cart.service';
import type { CatalogVariant } from '../catalog/catalog.types';
import { DeterministicScoutReplyModel, ScoutService, isCartStateQuestion } from './scout.service';
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

  it('returns a broadly typed COMPUTER without admitting computer accessories', async () => {
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
    const service = new ScoutService(
      scoutCatalogFrom(new FixtureCatalogSource([
        { ...base, id: 'workstation', title: 'Modular workstation computer', productType: 'COMPUTER' },
        { ...base, id: 'bag', title: 'Computer carrying bag', productType: 'CARRYING_CASE_OR_BAG' },
      ])),
      new DeterministicScoutReplyModel(),
      new CartService(new InMemoryCartStore()),
      new InMemoryScoutMemoryStore(),
    );

    const response = await service.chat({ message: 'find me computers', maxProducts: 10 });

    expect(response.products.map((product) => product.productId)).toEqual(['workstation']);
  });

  it('answers a held-items question from the cart, not the catalog, when nothing is held', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.getCart();
    const service = new ScoutService(
      scoutCatalogFrom(new FixtureCatalogSource()),
      new DeterministicScoutReplyModel(),
      carts,
      new InMemoryScoutMemoryStore(),
    );

    const response = await service.chat({ message: 'what do I have held?', cartId: cart.id });

    // The production defect: this came back as "I found 6 verified options"
    // with unrelated products (a menu planner, wedding cake servers).
    expect(response.products).toEqual([]);
    expect(response.reply).not.toContain('verified option');
    expect(response.reply.toLowerCase()).toContain("don't have any items held");
  });

  it('lists what the buyer is actually holding', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.getCart();
    await carts.addItem({
      cartId: cart.id, productId: 'sku-1', title: 'Latitude laptop', priceCents: 100_00, quantity: 2,
    });
    const service = new ScoutService(
      scoutCatalogFrom(new FixtureCatalogSource()),
      new DeterministicScoutReplyModel(),
      carts,
      new InMemoryScoutMemoryStore(),
    );

    const response = await service.chat({ message: 'what do I have held?', cartId: cart.id });

    expect(response.products).toEqual([]);
    expect(response.reply).toContain('Latitude laptop');
    expect(response.reply).toContain('1 item held');
  });

  it('still searches the catalog for an ordinary product question', async () => {
    const service = new ScoutService(
      scoutCatalogFrom(new FixtureCatalogSource()),
      new DeterministicScoutReplyModel(),
      new CartService(new InMemoryCartStore()),
      new InMemoryScoutMemoryStore(),
    );

    const response = await service.chat({ message: 'wireless headphones', maxProducts: 3 });

    expect(response.products.length).toBeGreaterThan(0);
    expect(response.reply).toContain('verified');
  });
});

describe('isCartStateQuestion', () => {
  it('matches questions about the buyer own holds', () => {
    for (const message of [
      'what do I have held?',
      'what am I holding',
      'do I have anything held right now',
      'show my held items',
      'what is in my cart',
      'my cart',
    ]) expect(isCartStateQuestion(message), message).toBe(true);
  });

  it('does not divert ordinary product searches that merely mention a cart word', () => {
    for (const message of [
      'wireless headphones',
      'cart organizer for a workshop',
      'hold-down straps',
      'find me computers',
      '',
    ]) expect(isCartStateQuestion(message), message).toBe(false);
  });
});
