import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { CartService, InMemoryCartStore } from '../cart/cart.service';
import { CheckoutService, SquareSandboxProvider, verifySquareWebhookSignature, type PaymentProvider } from './checkout.service';

const provider = (result: 'paid' | 'failed' = 'paid'): PaymentProvider => ({
  createSession: async (input) => ({ provider: 'square', mode: 'sandbox', status: 'ready', appId: 'app', locationId: 'loc', currency: input.currency, amountCents: input.amountCents, orderId: input.orderId }),
  confirmPayment: async () => ({ status: result, transactionId: result === 'paid' ? 'txn-1' : undefined }),
});

describe('CheckoutService', () => {
  it('creates an idempotent pending order from cart snapshots', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-1', productId: 'p-1', title: 'Mug', priceCents: 1250, quantity: 2 });
    const checkout = new CheckoutService(provider(), carts);
    const first = await checkout.createSession({ cartId: cart.id, shippingCents: 500 });
    const retry = await checkout.createSession({ cartId: cart.id, shippingCents: 500 });
    expect(first.order.totalCents).toBe(3000);
    expect(retry.order.id).toBe(first.order.id);
    expect(retry.session.orderId).toBe(first.order.id);
  });

  it('moves an order to paid only after the provider confirms it', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-2', productId: 'p-2', title: 'Headphones', priceCents: 19999 });
    const checkout = new CheckoutService(provider(), carts);
    const session = await checkout.createSession({ cartId: cart.id });
    const confirmation = await checkout.confirmPayment({ orderId: session.order.id, sourceId: 'cnon:card-nonce-ok' });
    expect(confirmation.payment.status).toBe('paid');
    expect(confirmation.order.status).toBe('paid');
  });
});

describe('SquareSandboxProvider', () => {
  it('does not call Square when credentials are absent', async () => {
    let calls = 0;
    const square = new SquareSandboxProvider({ appId: 'app', locationId: 'loc' }, async () => {
      calls += 1;
      throw new Error('should not call');
    });
    const result = await square.confirmPayment({ orderId: 'order-1', sourceId: 'source', amountCents: 100, currency: 'USD' });
    expect(result.status).toBe('needs-configuration');
    expect(calls).toBe(0);
  });

  it("verifies Square's URL-plus-body HMAC contract", () => {
    const body = '{"type":"payment.completed"}';
    const url = 'https://example.test/checkout/webhook';
    const key = 'secret';
    const signature = createHmac('sha256', key).update(url + body).digest('base64');
    expect(verifySquareWebhookSignature(body, signature, url, key)).toBe(true);
    expect(verifySquareWebhookSignature(body, signature, url + '/wrong', key)).toBe(false);
  });
});
