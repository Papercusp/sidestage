import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CartController } from './cart.controller';
import { CartService, emptyCart, InMemoryCartStore } from './cart.service';

describe('CartController buyer principal boundary', () => {
  it('allows the selected buyer to read and mutate their server-bound cart', async () => {
    const controller = new CartController(new CartService(new InMemoryCartStore()));
    const held = await controller.addItem({
      cartId: 'cart-avi',
      productId: 'mug',
      title: 'Harbor Kettle',
      priceCents: 7_600,
    }, 'demo-avi');

    await expect(controller.getCart(held.id, 'demo-avi')).resolves.toMatchObject({
      id: 'cart-avi',
      buyerId: 'buyer-demo-avi',
    });
    await expect(controller.setQuantity(held.id, 'mug', { quantity: 2 }, 'demo-avi'))
      .resolves.toMatchObject({ items: [expect.objectContaining({ quantity: 2 })] });
    await expect(controller.removeItem(held.id, 'mug', 'demo-avi'))
      .resolves.toMatchObject({ items: [] });
  });

  it('treats releasing an already-gone hold as a no-op, never a 400 or 404 (EI-20587893882016538)', async () => {
    // A buyer's "release" click can race the server's own read-time expiry
    // prune (GET /cart/:id releases + drops any expired line before this
    // DELETE lands) or simply arrive twice. Either way the item is already
    // absent from the buyer's own cart -- removeItem must treat that as
    // success, not surface a 400/404 to the console for a hold the buyer no
    // longer holds.
    const controller = new CartController(new CartService(new InMemoryCartStore()));
    const held = await controller.addItem({
      cartId: 'cart-avi',
      productId: 'mug',
      title: 'Harbor Kettle',
      priceCents: 7_600,
    }, 'demo-avi');

    await expect(controller.removeItem(held.id, 'mug', 'demo-avi')).resolves.toMatchObject({ items: [] });
    // The item is already gone -- a second (or expiry-raced) release for the
    // very same product must still resolve cleanly.
    await expect(controller.removeItem(held.id, 'mug', 'demo-avi')).resolves.toMatchObject({ items: [] });
    // A product that was never held at all is the same no-op shape.
    await expect(controller.removeItem(held.id, 'never-held', 'demo-avi')).resolves.toMatchObject({ items: [] });
  });

  it('hides another buyer cart across read, create-by-id, patch, and delete routes', async () => {
    const controller = new CartController(new CartService(new InMemoryCartStore()));
    await controller.addItem({
      cartId: 'cart-avi',
      productId: 'mug',
      title: 'Harbor Kettle',
      priceCents: 7_600,
    }, 'demo-avi');

    await expect(controller.getCart('cart-avi', 'demo-other')).rejects.toThrow('Cart was not found for this buyer');
    await expect(controller.addItem({
      cartId: 'cart-avi',
      productId: 'lamp',
      title: 'Lamp',
      priceCents: 2_000,
    }, 'demo-other')).rejects.toThrow('Cart was not found for this buyer');
    await expect(controller.setQuantity('cart-avi', 'mug', { quantity: 2 }, 'demo-other'))
      .rejects.toThrow('Cart was not found for this buyer');
    await expect(controller.removeItem('cart-avi', 'mug', 'demo-other'))
      .rejects.toThrow('Cart was not found for this buyer');
  });

  it('rejects requests without a selected buyer principal before touching storage', async () => {
    const controller = new CartController(new CartService(new InMemoryCartStore()));
    expect(() => controller.getCart('cart-avi', undefined)).toThrow('Buyer principal is required');
    expect(() => controller.addItem({
      productId: 'mug',
      title: 'Harbor Kettle',
      priceCents: 7_600,
    }, undefined)).toThrow('Buyer principal is required');
  });

  it('returns a client validation error for malformed add-item bodies', () => {
    const controller = new CartController(new CartService(new InMemoryCartStore()));

    expect(() => controller.addItem({ productId: 'mug' } as never, 'demo-avi'))
      .toThrow(BadRequestException);
    expect(() => controller.addItem(undefined as never, 'demo-avi'))
      .toThrow(BadRequestException);
    expect(() => controller.addItem({ productId: 'mug', title: 'Kettle', priceCents: -1 }, 'demo-avi'))
      .toThrow('priceCents must be a non-negative integer');
  });

  it('checks ownership before an expired-cart read can release inventory or persist cleanup', async () => {
    const stored = {
      ...emptyCart('cart-avi', 'buyer-demo-avi'),
      items: [{
        productId: 'mug', title: 'Harbor Kettle', priceCents: 7_600, quantity: 1,
        expiresAt: '2000-01-01T00:00:00.000Z',
      }],
      subtotalCents: 7_600,
    };
    const store = { get: vi.fn(async () => stored), set: vi.fn() };
    const inventory = { release: vi.fn(async () => true) };
    const controller = new CartController(new CartService(store, inventory as never));

    await expect(controller.getCart('cart-avi', 'demo-other'))
      .rejects.toThrow('Cart was not found for this buyer');
    expect(inventory.release).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });
});
