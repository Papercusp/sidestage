import { describe, expect, it, vi } from 'vitest';
import { CheckoutController } from './checkout.controller';

describe('CheckoutController', () => {
  it('returns the current buyer order aggregation', async () => {
    const buyerOrders = { listForBuyer: vi.fn().mockResolvedValue([{ id: 'order-1' }]) };
    const controller = new CheckoutController({} as never, buyerOrders as never);

    await expect(controller.orders('demo-1')).resolves.toEqual({ orders: [{ id: 'order-1' }] });
    expect(buyerOrders.listForBuyer).toHaveBeenCalledWith('buyer-demo-1');
  });

  it('passes buyer and event identity into checkout session creation', async () => {
    const checkout = { createSession: vi.fn().mockResolvedValue({ order: { id: 'order-1' } }) };
    const controller = new CheckoutController(checkout as never, {} as never);
    const body = {
      cartId: 'cart-1', buyerId: 'buyer-1', eventId: 'event-1',
      shippingAddress: { line1: '99 Main St', city: 'New York', state: 'NY', postalCode: '10001' },
      shippingRateId: 'UPS:Ground',
    };

    await expect(controller.createSession(body, 'demo-1')).resolves.toEqual({ order: { id: 'order-1' } });
    expect(checkout.createSession).toHaveBeenCalledWith({ ...body, buyerId: 'buyer-demo-1' });
  });

  it('ignores client-authored buyer identity in favor of the request principal', async () => {
    const checkout = { createSession: vi.fn().mockResolvedValue({ order: { id: 'order-1' } }) };
    const controller = new CheckoutController(checkout as never, {} as never);
    await controller.createSession({ cartId: 'cart-1', buyerId: 'buyer-forged' } as never, 'seller-avi');
    expect(checkout.createSession).toHaveBeenCalledWith(expect.objectContaining({ buyerId: 'buyer-avi' }));
  });

  it('requires a buyer principal for buyer-owned reads and writes', async () => {
    const controller = new CheckoutController({ createSession: vi.fn() } as never, { listForBuyer: vi.fn() } as never);
    await expect(controller.orders()).rejects.toThrow('Buyer principal is required');
    expect(() => controller.createSession({ cartId: 'cart-1' } as never)).toThrow('Buyer principal is required');
  });

  it('passes the untouched raw body and Stripe signature to webhook handling', async () => {
    const checkout = { handleWebhook: vi.fn().mockResolvedValue({ received: true, handled: true }) };
    const controller = new CheckoutController(checkout as never, {} as never);
    const rawBody = Buffer.from('{"id":"evt_1"}');

    await expect(controller.webhook({
      rawBody,
      headers: { 'stripe-signature': 't=1,v1=signed' },
    })).resolves.toEqual({ received: true, handled: true });
    expect(checkout.handleWebhook).toHaveBeenCalledWith(rawBody, 't=1,v1=signed');
  });

  it('refuses a webhook request when Nest did not preserve its raw body', async () => {
    const controller = new CheckoutController({ handleWebhook: vi.fn() } as never, {} as never);
    expect(() => controller.webhook({ headers: {} })).toThrow('raw request body');
  });
});
