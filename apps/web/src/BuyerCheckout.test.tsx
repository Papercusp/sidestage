import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  BuyerCheckoutDrawer,
  type BuyerCheckoutDrawerProps,
  type CheckoutDraft,
} from './BuyerCheckout';
import type {
  BuyerCart,
  BuyerCheckoutOrder,
  BuyerCheckoutSessionResponse,
  BuyerShippingRate,
} from './buyer-checkout-api';

const draft: CheckoutDraft = {
  email: 'buyer@example.test',
  name: 'Avi Buyer',
  line1: '99 Main St',
  line2: '',
  city: 'New York',
  state: 'NY',
  postalCode: '10001',
  country: 'US',
  phone: '',
};

const cart: BuyerCart = {
  id: 'cart-1',
  currency: 'USD',
  subtotalCents: 2500,
  updatedAt: '2026-08-14T06:00:00Z',
  items: [{ productId: 'mug', title: 'Aurora mug', priceCents: 2500, quantity: 1 }],
};

const rate: BuyerShippingRate = {
  id: 'UPS:Ground',
  carrier: 'UPS',
  service: 'Ground',
  totalCents: 1099,
  deliveryDays: 4,
  parcelCount: 1,
  quotedAt: '2026-08-14T06:00:00Z',
};

const order: BuyerCheckoutOrder = {
  id: 'order-1',
  cartId: cart.id,
  buyerId: 'buyer-1',
  eventId: 'event-1',
  email: draft.email,
  subtotalCents: 2500,
  shippingCents: 1099,
  totalCents: 3599,
  currency: 'USD',
  status: 'pending',
  createdAt: '2026-08-14T06:00:00Z',
  items: cart.items,
  shippingAddress: draft,
  shippingRate: rate,
  paymentSession: {
    provider: 'square', mode: 'sandbox', status: 'needs-configuration',
    appId: null, locationId: null, orderId: 'order-1', amountCents: 3599, currency: 'USD',
  },
};

const checkout: BuyerCheckoutSessionResponse = { order, session: order.paymentSession };
const asyncNoop = async () => undefined;

function props(overrides: Partial<BuyerCheckoutDrawerProps> = {}): BuyerCheckoutDrawerProps {
  return {
    open: true,
    step: 'cart',
    cart,
    draft,
    rates: [rate],
    selectedRateId: rate.id,
    checkout,
    completedOrder: null,
    busy: false,
    onClose: vi.fn(),
    onStep: vi.fn(),
    onDraft: vi.fn(),
    onLoadRates: asyncNoop,
    onSelectRate: vi.fn(),
    onStartCheckout: asyncNoop,
    onConfirm: asyncNoop,
    onQuantity: asyncNoop,
    onRemove: asyncNoop,
    onError: vi.fn(),
    ...overrides,
  };
}

describe('BuyerCheckoutDrawer', () => {
  it('renders cart review inside an accessible buyer-owned drawer', () => {
    const html = renderToStaticMarkup(<BuyerCheckoutDrawer {...props()} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Buyer checkout');
    expect(html).toContain('Aurora mug');
    expect(html).toContain('$25.00');
    expect(html).toContain('Continue to address');
  });

  it('renders live carrier selection and server-derived order total', () => {
    const html = renderToStaticMarkup(<BuyerCheckoutDrawer {...props({ step: 'shipping' })} />);
    expect(html).toContain('Live rates');
    expect(html).toContain('UPS Ground');
    expect(html).toContain('4 day delivery');
    expect(html).toContain('$10.99');
    expect(html).toContain('$35.99');
    expect(html).toContain('Continue to Square');
  });

  it('explains the server-only configuration boundary instead of exposing credentials', () => {
    const html = renderToStaticMarkup(<BuyerCheckoutDrawer {...props({ step: 'payment' })} />);
    expect(html).toContain('Square sandbox needs configuration.');
    expect(html).toContain('server-side Square sandbox credentials');
    expect(html).not.toContain('SQUARE_ACCESS_TOKEN');
  });

  it('links a paid buyer directly to the shared Orders surface', () => {
    const paid = { ...order, status: 'paid' as const };
    const html = renderToStaticMarkup(<BuyerCheckoutDrawer {...props({ step: 'success', completedOrder: paid })} />);
    expect(html).toContain('Payment received');
    expect(html).toContain('Order order-1 is paid');
    expect(html).toContain('href="/?tab=orders"');
  });
});
