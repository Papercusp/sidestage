import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CartService, emptyCart, InMemoryCartStore } from '../cart/cart.service';
import type { CatalogSource, CatalogVariant } from '../catalog/catalog.types';
import { EasyPostClient, type EasyPostRate, type EasyPostShipment } from './easypost.client';
import { ShippingService, type ShippingRateInput } from './shipping.service';

const ADDRESS: ShippingRateInput['address'] = {
  name: '  Buyer  ',
  line1: '  99 Main St ',
  city: 'New York',
  state: 'ny',
  postalCode: '10001',
  country: 'us',
};

function variant(id: string, overrides: Partial<CatalogVariant> = {}): CatalogVariant {
  return {
    id,
    groupId: `group-${id}`,
    title: id,
    brand: 'SideStage',
    productType: 'TEST',
    sku: id,
    condition: 'NEW',
    handlingDays: 1,
    priceCents: 1_000,
    qty: 10,
    reservedQty: 0,
    availableQty: 10,
    ...overrides,
  };
}

function catalog(variants: CatalogVariant[]): CatalogSource {
  const byId = new Map(variants.map((entry) => [entry.id, entry]));
  return {
    search: vi.fn(),
    productTypes: vi.fn(),
    variant: vi.fn(async (id: string) => byId.get(id)),
  } as unknown as CatalogSource;
}

function rate(id: string, carrier: string, service: string, dollars: string, days: number | null): EasyPostRate {
  return { id, carrier, service, rate: dollars, delivery_days: days };
}

function shipment(id: string, rates: EasyPostRate[]): EasyPostShipment {
  return { id, rates };
}

function carrier(createShipment: EasyPostClient['createShipment'], configured = true): EasyPostClient {
  return {
    isConfigured: vi.fn(() => configured),
    createShipment,
  } as unknown as EasyPostClient;
}

async function cartWith(productId: string, quantity = 1): Promise<{ carts: CartService; cartId: string }> {
  const carts = new CartService(new InMemoryCartStore());
  const cart = await carts.addItem({ productId, title: productId, priceCents: 1_000, quantity });
  return { carts, cartId: cart.id };
}

describe('ShippingService', () => {
  it('authorizes buyer-owned rate lookups before expired-cart cleanup or carrier access', async () => {
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
    const createShipment = vi.fn();
    const service = new ShippingService(
      new CartService(store, inventory as never),
      catalog([variant('mug')]),
      carrier(createShipment),
    );

    await expect(service.getRatesForBuyer({ cartId: stored.id, address: ADDRESS }, 'buyer-demo-other'))
      .rejects.toThrow('Cart was not found for this buyer');
    expect(inventory.release).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    expect(createShipment).not.toHaveBeenCalled();
  });

  it('quotes a cart for its server-bound buyer owner', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({
      cartId: 'cart-avi',
      buyerId: 'buyer-demo-avi',
      productId: 'mug',
      title: 'Harbor Kettle',
      priceCents: 7_600,
    });
    const createShipment = vi.fn().mockResolvedValue(shipment('shipment-1', [
      rate('rate-1', 'USPS', 'Priority', '12.50', 3),
    ]));
    const service = new ShippingService(carts, catalog([variant('mug')]), carrier(createShipment));

    await expect(service.getRatesForBuyer({ cartId: cart.id, address: ADDRESS }, 'buyer-demo-avi'))
      .resolves.toMatchObject([{ id: 'USPS:Priority', totalCents: 1_250 }]);
  });

  it('authors box fill on the server and confirms unchanged shipping only from equal quotes', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({
      cartId: 'cart-meter',
      buyerId: 'buyer-demo-avi',
      productId: 'mug',
      title: 'Harbor Kettle',
      priceCents: 7_600,
    });
    const createShipment = vi.fn().mockResolvedValue(shipment('shipment-1', [
      rate('rate-1', 'USPS', 'Priority', '5.00', 3),
    ]));
    const service = new ShippingService(carts, catalog([variant('mug', {
      weight: { value: 8, unit: 'ounces' },
      dimensions: { length: 2, width: 2, height: 2, unit: 'inches' },
    })]), carrier(createShipment));

    await expect(service.getMeterForBuyer({ cartId: cart.id }, 'buyer-demo-avi')).resolves.toMatchObject({
      cartId: 'cart-meter',
      totalUnits: 1,
      parcelCount: 1,
      fillPercent: 5,
      parcels: [{ boxName: '8x6x4', fillPercent: 5 }],
      suggestion: {
        status: 'packing-only',
        productId: 'mug',
        title: 'Harbor Kettle',
        nextQuantity: 2,
        hypotheticalParcelCount: 1,
      },
    });
    expect(createShipment).not.toHaveBeenCalled();

    await expect(service.getMeterForBuyer({
      cartId: cart.id,
      address: ADDRESS,
      rateId: 'USPS:Priority',
    }, 'buyer-demo-avi')).resolves.toMatchObject({
      suggestion: {
        status: 'price-confirmed',
        shippingStays: {
          rateId: 'USPS:Priority',
          carrier: 'USPS',
          service: 'Priority',
          totalCents: 500,
        },
      },
    });
    expect(createShipment).toHaveBeenCalledTimes(2);
  });

  it('degrades to empty rates without EasyPost configuration', async () => {
    const easyPost = carrier(vi.fn(), false);
    const source = catalog([]);
    const service = new ShippingService(new CartService(new InMemoryCartStore()), source, easyPost);

    await expect(service.getRates({ cartId: 'missing', address: ADDRESS })).resolves.toEqual([]);
    expect(source.variant).not.toHaveBeenCalled();
    expect(easyPost.createShipment).not.toHaveBeenCalled();
  });

  it('rejects missing address fields and empty carts before requesting a quote', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const empty = await carts.getCart();
    const easyPost = carrier(vi.fn());
    const service = new ShippingService(carts, catalog([]), easyPost);

    await expect(service.getRates({ cartId: empty.id, address: { ...ADDRESS, line1: ' ' } }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getRates({ cartId: empty.id, address: ADDRESS }))
      .rejects.toThrow('Cart is empty or not found');
    expect(easyPost.createShipment).not.toHaveBeenCalled();
  });

  it('converts catalog units and sends normalized addresses to EasyPost', async () => {
    const { carts, cartId } = await cartWith('oversized');
    const source = catalog([variant('oversized', {
      weight: { value: 1, unit: 'kg' },
      dimensions: {
        length: { value: 1_000, unit: 'mm' },
        width: { value: 25.4, unit: 'cm' },
        height: { value: 0.1, unit: 'm' },
      },
    })]);
    const createShipment = vi.fn().mockResolvedValue(shipment('shipment-1', [
      rate('rate-1', 'USPS', 'Priority', '12.50', 3),
    ]));
    const service = new ShippingService(carts, source, carrier(createShipment));

    await expect(service.getRates({ cartId, address: ADDRESS })).resolves.toMatchObject([
      { id: 'USPS:Priority', totalCents: 1_250, deliveryDays: 3, parcelCount: 1 },
    ]);
    expect(createShipment).toHaveBeenCalledTimes(1);
    expect(createShipment).toHaveBeenCalledWith(
      {
        name: 'Buyer',
        street1: '99 Main St',
        street2: undefined,
        city: 'New York',
        state: 'NY',
        zip: '10001',
        country: 'US',
        phone: undefined,
      },
      expect.objectContaining({
        length: expect.closeTo(39.3701, 3),
        width: expect.closeTo(10, 3),
        height: expect.closeTo(3.93701, 3),
        weight: 35,
      }),
      `cart-${cartId}-parcel-0`,
    );
  });

  it('deduplicates each parcel, intersects services, sums totals, and invalidates cache on cart or address changes', async () => {
    const { carts, cartId } = await cartWith('heavy', 2);
    const source = catalog([variant('heavy', {
      weight: { value: 40, unit: 'pounds' },
      dimensions: { length: 10, width: 8, height: 4, unit: 'inches' },
    })]);
    const parcelOne = shipment('shipment-1', [
      rate('usps-expensive', 'USPS', 'Priority', '5.00', 3),
      rate('usps-cheapest', 'USPS', 'Priority', '4.00', 4),
      rate('ups-only-here', 'UPS', 'Ground', '10.00', 5),
      rate('fedex-1', 'FedEx', 'Home', '8.00', 2),
    ]);
    const parcelTwo = shipment('shipment-2', [
      rate('usps-2', 'USPS', 'Priority', '6.00', 2),
      rate('fedex-2', 'FedEx', 'Home', '7.00', 3),
    ]);
    const createShipment = vi.fn(async (_address, _parcel, reference?: string) => (
      reference?.endsWith('parcel-0') ? parcelOne : parcelTwo
    ));
    const service = new ShippingService(carts, source, carrier(createShipment));
    const input = { cartId, address: ADDRESS };

    const first = await service.getRates(input);
    expect(first).toMatchObject([
      { id: 'USPS:Priority', totalCents: 1_000, deliveryDays: 4, parcelCount: 2 },
      { id: 'FedEx:Home', totalCents: 1_500, deliveryDays: 3, parcelCount: 2 },
    ]);
    expect(first.some((entry) => entry.id === 'UPS:Ground')).toBe(false);
    expect(first.every((entry) => !Number.isNaN(Date.parse(entry.quotedAt)))).toBe(true);
    expect(createShipment).toHaveBeenCalledTimes(2);

    await expect(service.getRates(input)).resolves.toEqual(first);
    expect(createShipment).toHaveBeenCalledTimes(2);
    await expect(service.resolveRate(input, 'USPS:Priority')).resolves.toMatchObject({ totalCents: 1_000 });
    await expect(service.resolveRate(input, 'UPS:Ground')).rejects.toThrow('unavailable or expired');

    await service.getRates({ ...input, address: { ...ADDRESS, postalCode: '10002' } });
    expect(createShipment).toHaveBeenCalledTimes(4);

    await carts.setQuantity(cartId, 'heavy', 1);
    await service.getRates(input);
    expect(createShipment).toHaveBeenCalledTimes(5);
    await expect(service.resolveRate(input, 'USPS:Priority')).resolves.toMatchObject({ totalCents: 400 });
    await expect(service.resolveRate(input, 'UPS:Ground')).resolves.toMatchObject({ totalCents: 1_000, parcelCount: 1 });
  });

  it('returns a useful four-rate slate containing both the cheapest and fastest services', async () => {
    const { carts, cartId } = await cartWith('small');
    const createShipment = vi.fn().mockResolvedValue(shipment('shipment-1', [
      rate('a', 'A', 'Service', '5.00', 5),
      rate('b', 'B', 'Service', '6.00', 4),
      rate('c', 'C', 'Service', '7.00', 3),
      rate('d', 'D', 'Service', '8.00', 2),
      rate('e', 'E', 'Service', '20.00', 1),
    ]));
    const service = new ShippingService(carts, catalog([variant('small')]), carrier(createShipment));

    const rates = await service.getRates({ cartId, address: ADDRESS });
    expect(rates.map((entry) => entry.id)).toEqual(['A:Service', 'B:Service', 'C:Service', 'E:Service']);
  });
});
