import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BuyerCartPanel, type BuyerCartPanelProps } from './BuyerCartDrawer';
import type { BuyerCartAdapter } from './buyer-cart-adapter';
import type { BuyerCart } from './buyer-checkout-api';

/**
 * The held-items acceptance criteria shipped with the hand-rolled cart step in
 * BuyerCheckout; P-006 moved that surface onto the shared @papercusp/cart-drawer
 * and the criteria moved with it — the copy, the price, the live per-hold
 * countdown, and the checkout handoff are asserted here now.
 *
 * These render the PANEL rather than BuyerCartDrawer: the drawer adds the Vaul
 * portal shell, which by design mounts only in a browser. The shell's own
 * behavior (dialog role, stack placement) belongs to the library.
 */

const cart: BuyerCart = {
  id: 'cart-1',
  currency: 'USD',
  subtotalCents: 2500,
  updatedAt: '2026-08-14T06:00:00Z',
  items: [{
    productId: 'mug', title: 'Aurora mug', priceCents: 2500, quantity: 1,
    expiresAt: '2026-08-14T06:02:00Z',
  }],
};

function adapter(overrides: Partial<BuyerCartAdapter> = {}): BuyerCartAdapter {
  return {
    hold: vi.fn(async () => cart),
    setQuantity: vi.fn(async () => cart),
    remove: vi.fn(async () => cart),
    refresh: vi.fn(),
    ...overrides,
  };
}

function props(overrides: Partial<BuyerCartPanelProps> = {}): BuyerCartPanelProps {
  return {
    cart,
    // 30s into the two-minute hold.
    nowMs: Date.parse('2026-08-14T06:00:30Z'),
    busy: false,
    adapter: adapter(),
    onCheckout: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('BuyerCartPanel', () => {
  it('reviews held items with the live per-hold countdown in the item slot', () => {
    const html = renderToStaticMarkup(<BuyerCartPanel {...props()} />);
    expect(html).toContain('Reserved for 2 minutes');
    expect(html).toContain('Held items');
    expect(html).toContain('Aurora mug');
    expect(html).toContain('$25.00');
    expect(html).toContain('1:30');
    expect(html).toContain('remaining');
    expect(html).toContain('Checkout');
    // The countdown is a timer inside the shared line card, not a sibling of it.
    expect(html).toMatch(/class="cd-line-card"[\s\S]*role="timer"/);
    expect(html).toContain('aria-label="Aurora mug hold time remaining"');
  });

  it('renders the server subtotal rather than re-deriving one', () => {
    // A cart whose subtotal disagrees with quantity × price: the server is the
    // authority (it prices holds), so its number must be the one shown.
    const html = renderToStaticMarkup(<BuyerCartPanel {...props({
      cart: { ...cart, subtotalCents: 9900 },
    })} />);
    expect(html).toContain('$99.00');
  });

  it('shows an expired hold as released rather than as time remaining', () => {
    const html = renderToStaticMarkup(<BuyerCartPanel {...props({
      nowMs: Date.parse('2026-08-14T06:05:00Z'),
    })} />);
    expect(html).toContain('0:00');
  });

  it('offers the hold-something-first empty state and no checkout', () => {
    const html = renderToStaticMarkup(<BuyerCartPanel {...props({ cart: null })} />);
    expect(html).toContain('No held items yet');
    expect(html).toContain('Hold an item from the live rail to reserve it for two minutes.');
    expect(html).toContain('disabled');
  });

  it('surfaces a drawer-level failure with a refresh that re-reads the pruned cart', () => {
    const html = renderToStaticMarkup(<BuyerCartPanel {...props({
      error: 'A two-minute hold expired. The item is available to other buyers again.',
    })} />);
    expect(html).toContain('A two-minute hold expired.');
    expect(html).toContain('Refresh');
  });

  it('disables the line controls while a cart write is in flight', () => {
    const html = renderToStaticMarkup(<BuyerCartPanel {...props({ busy: true })} />);
    for (const control of [
      'Increase Aurora mug quantity',
      'Decrease Aurora mug quantity',
      'Aurora mug quantity',
      'Release the hold on Aurora mug',
    ]) {
      expect(html, `${control} must be disabled mid-write`)
        .toMatch(new RegExp(`disabled=""[^>]*aria-label="${control}"`));
    }
  });

  it('renders server-authored box fill and packing-only guidance without inventing a price', () => {
    const html = renderToStaticMarkup(<BuyerCartPanel {...props({
      shippingMeter: {
        cartId: cart.id,
        revision: cart.updatedAt,
        totalUnits: 1,
        parcelCount: 1,
        fillPercent: 45,
        parcels: [{ boxName: '8x6x4', length: 8, width: 6, height: 4, weightOz: 10, usedVolumeIn3: 86.4, capacityVolumeIn3: 192, fillPercent: 45 }],
        suggestion: { status: 'packing-only', productId: 'mug', title: 'Aurora mug', nextQuantity: 2, hypotheticalParcelCount: 1 },
      },
    })} />);
    expect(html).toContain('Combined shipping');
    expect(html).toContain('1 box');
    expect(html).toContain('45% full');
    expect(html).toContain('45% filled');
    expect(html).toContain('Enter an address at checkout to verify shipping.');
    expect(html).not.toContain('shipping stays');
  });

  it('shows shipping-stays copy only for a server-confirmed equal hypothetical quote', () => {
    const html = renderToStaticMarkup(<BuyerCartPanel {...props({
      shippingMeter: {
        cartId: cart.id,
        revision: cart.updatedAt,
        totalUnits: 1,
        parcelCount: 1,
        fillPercent: 45,
        parcels: [{ boxName: '8x6x4', length: 8, width: 6, height: 4, weightOz: 10, usedVolumeIn3: 86.4, capacityVolumeIn3: 192, fillPercent: 45 }],
        suggestion: {
          status: 'price-confirmed', productId: 'mug', title: 'Aurora mug', nextQuantity: 2, hypotheticalParcelCount: 1,
          shippingStays: { rateId: 'UPS:Ground', carrier: 'UPS', service: 'Ground', totalCents: 1_099 },
        },
      },
    })} />);
    expect(html).toContain('Add one more Aurora mug');
    expect(html).toContain('shipping stays $10.99 with UPS Ground');
  });
});
