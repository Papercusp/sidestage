import { afterEach, describe, expect, it, vi } from 'vitest';
import { adjustSellerEventStock, executeSellerAction, fetchEventThumbnailUrl, setupSellerEvent, startSellerAuction, type SellerEventItem } from './api';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('seller event API orchestration', () => {
  it('creates config, reserves inventory, and registers guarded items with verified floors', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/events/sunday-drop/config') && init?.method === 'PUT') return json({ ok: true });
      if (url.endsWith('/events/sunday-drop/config')) {
        return json({
          eventId: 'sunday-drop',
          name: 'Sunday drop',
          policy: {
            automationLevel: 'confirm',
            allowAutoActions: false,
            priceFloorCentsByProduct: {},
            maxMarkdownPercent: 20,
            blockedActionKinds: [],
            tone: 'warm',
          },
        });
      }
      if (url.endsWith('/catalog/variants/mug')) {
        return json({
          id: 'mug', groupId: 'mugs', title: 'Aurora mug', brand: 'Northstar',
          productType: 'HOME', sku: 'MUG-1', condition: 'NEW', handlingDays: 2,
          priceCents: 2_000, availableQty: 5,
        });
      }
      if (url.endsWith('/inventory/mug/hold')) return json({ held: true });
      if (url.endsWith('/actions/events/sunday-drop/register')) {
        const body = JSON.parse(String(init?.body)) as { policy: { priceFloorCentsByProduct: Record<string, number> }; items: SellerEventItem[] };
        expect(body.policy.priceFloorCentsByProduct.mug).toBe(1_200);
        return json({ items: body.items });
      }
      throw new Error(`Unexpected URL ${url}`);
    }));

    const result = await setupSellerEvent({
      name: 'Sunday drop',
      items: [{ catalogId: 'mug', groupId: 'mugs', eventPriceCents: 1_500, quantityLimit: 3 }],
    });

    expect(result.items[0]).toMatchObject({ productId: 'mug', priceCents: 1_500, quantity: 3 });
    expect(calls.some((call) => call.url.endsWith('/inventory/mug/hold'))).toBe(true);
  });

  it('sends the thumbnail on the config PUT, and omits the key when there is none', async () => {
    const configBodies: string[] = [];
    const stub = () => vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/events/sunday-drop/config') && init?.method === 'PUT') {
        configBodies.push(String(init.body));
        return json({ ok: true });
      }
      if (url.endsWith('/events/sunday-drop/config')) {
        return json({
          eventId: 'sunday-drop',
          name: 'Sunday drop',
          policy: {
            automationLevel: 'confirm',
            allowAutoActions: false,
            priceFloorCentsByProduct: {},
            maxMarkdownPercent: 20,
            blockedActionKinds: [],
            tone: 'warm',
          },
        });
      }
      if (url.endsWith('/catalog/variants/mug')) {
        return json({
          id: 'mug', groupId: 'mugs', title: 'Aurora mug', brand: 'Northstar',
          productType: 'HOME', sku: 'MUG-1', condition: 'NEW', handlingDays: 2,
          priceCents: 2_000, availableQty: 5,
        });
      }
      if (url.endsWith('/inventory/mug/hold')) return json({ held: true });
      if (url.endsWith('/actions/events/sunday-drop/register')) {
        const body = JSON.parse(String(init?.body)) as { items: SellerEventItem[] };
        return json({ items: body.items });
      }
      throw new Error(`Unexpected URL ${url}`);
    }));

    const items = [{ catalogId: 'mug', groupId: 'mugs', eventPriceCents: 1_500, quantityLimit: 3 }];
    const thumbnailUrl = 'data:image/png;base64,iVBORw0KGgo=';

    stub();
    await setupSellerEvent({ name: 'Sunday drop', thumbnailUrl, items });
    expect(JSON.parse(configBodies[0])).toEqual({ name: 'Sunday drop', thumbnailUrl });

    vi.unstubAllGlobals();
    stub();
    await setupSellerEvent({ name: 'Sunday drop', items });
    // The KEY must be absent, not null: the API reads absent as "keep" and null
    // as "clear", so a null here would wipe a thumbnail on any later re-setup.
    const withoutThumbnail = JSON.parse(configBodies[1]) as Record<string, unknown>;
    expect(withoutThumbnail).toEqual({ name: 'Sunday drop' });
    expect('thumbnailUrl' in withoutThumbnail).toBe(false);
  });

  it('updates the durable event reservation before the guarded stock action', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/inventory/mug/hold')) return json({ held: true });
      if (url.endsWith('/actions/events/drop/execute')) {
        const body = JSON.parse(String(init?.body)) as { action: { quantity: number } };
        expect(body.action.quantity).toBe(2);
        return json({ auditId: 'audit-1', status: 'executed', state: { ...ITEM, quantity: 2 } });
      }
      throw new Error(`Unexpected URL ${url}`);
    }));

    const result = await adjustSellerEventStock('drop', ITEM, 2);
    expect(result.state.quantity).toBe(2);
    expect(urls).toEqual([
      'http://localhost:3100/inventory/mug/hold',
      'http://localhost:3100/actions/events/drop/execute',
    ]);
  });

  it('keeps seller-entered quantity in auction and targeted-offer requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith('/auctions/start')) {
        expect(body).toMatchObject({
          eventId: 'drop', eventItemId: 'drop:mug', productId: 'mug',
          quantity: 3, startingPriceCents: 1_100, availableQty: 5,
        });
        return json({ id: 'auction-1', ...body, currentPriceCents: 1_100, status: 'active', startedAt: 'now', endsAt: 'later' });
      }
      if (url.endsWith('/actions/events/drop/execute')) {
        expect(body).toMatchObject({
          actorId: 'seller-demo',
          action: { kind: 'targeted-offer', productId: 'mug', buyerId: 'buyer-7', quantity: 2, priceCents: 1_200 },
        });
        return json({
          auditId: 'audit-offer', status: 'executed', state: ITEM,
          offer: { id: 'offer-1', eventId: 'drop', eventItemId: 'drop:mug', productId: 'mug', buyerId: 'buyer-7', quantity: 2, priceCents: 1_200, status: 'pending' },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }));

    const auction = await startSellerAuction('drop', ITEM, 3, 1_100);
    const offer = await executeSellerAction('drop', {
      kind: 'targeted-offer', productId: 'mug', buyerId: 'buyer-7', quantity: 2,
      priceCents: 1_200, reason: 'Quantity-aware offer',
    });

    expect(auction.quantity).toBe(3);
    expect(offer.offer?.quantity).toBe(2);
  });
});

const ITEM: SellerEventItem = {
  eventId: 'drop',
  eventItemId: 'drop:mug',
  productId: 'mug',
  title: 'Aurora mug',
  priceCents: 1_500,
  availableQty: 5,
  quantity: 3,
  attributes: {},
};

/**
 * The thumbnail fetch must never reject — a picture is decoration. But it must
 * also never make an OUTAGE look like decoration, which is what it used to do:
 * /events/:id/config 500'd for every event on the site and each one rendered the
 * placeholder, indistinguishable from an event that simply has no image.
 */
describe('fetchEventThumbnailUrl error discrimination', () => {
  it('returns the thumbnail on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ eventId: 'e', thumbnailUrl: 'data:image/png;base64,AAA' })));
    await expect(fetchEventThumbnailUrl('e')).resolves.toBe('data:image/png;base64,AAA');
  });

  it('stays SILENT on a 404 — that event just has no config', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'not found' }, 404)));

    await expect(fetchEventThumbnailUrl('missing')).resolves.toBeUndefined();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('REPORTS a 500 while still resolving undefined, so the outage is visible but the UI survives', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'Internal server error' }, 500)));

    // Still degrades gracefully — the caller renders its placeholder.
    await expect(fetchEventThumbnailUrl('sunday-drop')).resolves.toBeUndefined();
    // ...but no longer silently.
    expect(error).toHaveBeenCalledTimes(1);
    const logged = String(error.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain('sunday-drop');
    expect(logged).toContain('500');
    expect(logged).toContain('not a missing image');
    error.mockRestore();
  });

  it('REPORTS a transport failure, which carries no status at all', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    await expect(fetchEventThumbnailUrl('sunday-drop')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('treats every 5xx as reportable, not just 500', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'bad gateway' }, 502)));

    await expect(fetchEventThumbnailUrl('e')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('treats a 400 as silent, pinning the boundary at exactly 500', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'bad request' }, 400)));

    await expect(fetchEventThumbnailUrl('e')).resolves.toBeUndefined();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
