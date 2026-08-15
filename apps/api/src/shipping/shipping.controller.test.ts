import { describe, expect, it, vi } from 'vitest';
import { ShippingController } from './shipping.controller';
import type { ShippingService } from './shipping.service';

const INPUT = {
  cartId: 'cart-avi',
  address: {
    line1: '99 Main St',
    city: 'New York',
    state: 'NY',
    postalCode: '10001',
  },
};

describe('ShippingController buyer principal boundary', () => {
  it('requires a selected buyer before invoking the shipping service', () => {
    const shipping = { getRatesForBuyer: vi.fn() } as unknown as ShippingService;
    const controller = new ShippingController(shipping);

    expect(() => controller.getRates(INPUT, undefined)).toThrow('Buyer principal is required');
    expect(shipping.getRatesForBuyer).not.toHaveBeenCalled();
  });

  it('passes only the canonical buyer principal to the owned rate path', async () => {
    const shipping = { getRatesForBuyer: vi.fn().mockResolvedValue([]) } as unknown as ShippingService;
    const controller = new ShippingController(shipping);

    await expect(controller.getRates(INPUT, 'seller-demo-avi')).resolves.toEqual([]);
    expect(shipping.getRatesForBuyer).toHaveBeenCalledWith(INPUT, 'buyer-demo-avi');
  });

  it('applies the same principal boundary to the shipping meter', async () => {
    const shipping = { getMeterForBuyer: vi.fn().mockResolvedValue({}) } as unknown as ShippingService;
    const controller = new ShippingController(shipping);

    expect(() => controller.getMeter({ cartId: 'cart-avi' }, undefined)).toThrow('Buyer principal is required');
    await expect(controller.getMeter({ cartId: 'cart-avi' }, 'demo-avi')).resolves.toEqual({});
    expect(shipping.getMeterForBuyer).toHaveBeenCalledWith({ cartId: 'cart-avi' }, 'buyer-demo-avi');
  });
});
