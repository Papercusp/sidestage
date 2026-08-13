import { describe, expect, it } from 'vitest';
import { CartService, InMemoryCartStore } from './cart.service';

describe('CartService', () => {
  it('merges repeated products and calculates a cents subtotal', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const first = await carts.addItem({ cartId: 'cart-1', productId: 'p-1', title: 'Mug', priceCents: 1250, quantity: 2 });
    const second = await carts.addItem({ cartId: first.id, productId: 'p-1', title: 'Mug', priceCents: 1250, quantity: 1 });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].quantity).toBe(3);
    expect(second.subtotalCents).toBe(3750);
  });

  it('rejects invalid quantities instead of creating unbounded carts', async () => {
    const carts = new CartService(new InMemoryCartStore());
    await expect(carts.addItem({ productId: 'p-1', title: 'Mug', priceCents: 1250, quantity: 0 })).rejects.toThrow('Quantity');
  });
});
