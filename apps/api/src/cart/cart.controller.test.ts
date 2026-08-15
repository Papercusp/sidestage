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
