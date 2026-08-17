import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_PRINCIPAL_HEADER } from '@papercusp/sync';
import {
  adjustSellerEventStock,
  closeSellerAuction,
  executeSellerAction,
  fetchSellerEvent,
  saveRunOfShowPlan,
  setupSellerEvent,
  startSellerAuction,
  transitionSellerEvent,
  unpublishSellerEvent,
  EventApiError,
  type SellerEventItem,
} from './api';

const SELLER = { sellerId: 'seller-27', sellerName: 'Studio 27', principal: 'demo-27' };

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
    }, SELLER);

    expect(result.items[0]).toMatchObject({ productId: 'mug', priceCents: 1_500, quantity: 3 });
    expect(calls.some((call) => call.url.endsWith('/inventory/mug/hold'))).toBe(true);
    const configPut = calls.find((call) => call.url.endsWith('/events/sunday-drop/config') && call.init?.method === 'PUT');
    const configGet = calls.find((call) => call.url.endsWith('/events/sunday-drop/config') && !call.init?.method);
    const register = calls.find((call) => call.url.endsWith('/actions/events/sunday-drop/register'));
    expect(new Headers(configPut?.init?.headers).get(DEMO_PRINCIPAL_HEADER)).toBe('demo-27');
    expect(new Headers(configGet?.init?.headers).get(DEMO_PRINCIPAL_HEADER)).toBe('demo-27');
    expect(new Headers(register?.init?.headers).get(DEMO_PRINCIPAL_HEADER)).toBe('demo-27');
    expect(new Headers(configPut?.init?.headers).get('x-seller-id')).toBeNull();
    expect(new Headers(configPut?.init?.headers).get('x-seller-name')).toBe('Studio 27');
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
    await setupSellerEvent({ name: 'Sunday drop', thumbnailUrl, items }, SELLER);
    expect(JSON.parse(configBodies[0])).toEqual({ name: 'Sunday drop', thumbnailUrl });

    vi.unstubAllGlobals();
    stub();
    await setupSellerEvent({ name: 'Sunday drop', items }, SELLER);
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
        const body = JSON.parse(String(init?.body)) as {
          actorId: string;
          action: { quantity: number };
        };
        expect(body.actorId).toBe('seller-stock-27');
        expect(body.action.quantity).toBe(2);
        return json({ auditId: 'audit-1', status: 'executed', state: { ...ITEM, quantity: 2 } });
      }
      throw new Error(`Unexpected URL ${url}`);
    }));

    const result = await adjustSellerEventStock('drop', 'seller-stock-27', ITEM, 2, undefined, 'demo-27');
    expect(result.state.quantity).toBe(2);
    expect(urls).toEqual([
      'http://localhost:3100/inventory/mug/hold',
      'http://localhost:3100/actions/events/drop/execute',
    ]);
    const executeCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('/actions/events/drop/execute'));
    expect(new Headers(executeCall?.[1]?.headers).get(DEMO_PRINCIPAL_HEADER)).toBe('demo-27');
  });

  it('keeps seller-entered quantity and duration in auction and targeted-offer requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith('/auctions/start')) {
        expect(body).toMatchObject({
          eventId: 'drop', eventItemId: 'drop:mug', productId: 'mug',
          quantity: 3, startingPriceCents: 1_100, durationSec: 90, availableQty: 5,
        });
        return json({ id: 'auction-1', ...body, currentPriceCents: 1_100, status: 'active', startedAt: 'now', endsAt: 'later' });
      }
      if (url.endsWith('/actions/events/drop/execute')) {
        expect(body).toMatchObject({
          actorId: 'seller-offer-27',
          action: { kind: 'targeted-offer', productId: 'mug', buyerId: 'buyer-7', quantity: 2, priceCents: 1_200 },
        });
        return json({
          auditId: 'audit-offer', status: 'executed', state: ITEM,
          offer: { id: 'offer-1', eventId: 'drop', eventItemId: 'drop:mug', productId: 'mug', buyerId: 'buyer-7', quantity: 2, priceCents: 1_200, status: 'pending' },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }));

    const auction = await startSellerAuction('drop', ITEM, 3, 1_100, undefined, 'demo-27', 90);
    const offer = await executeSellerAction('drop', 'seller-offer-27', {
      kind: 'targeted-offer', productId: 'mug', buyerId: 'buyer-7', quantity: 2,
      priceCents: 1_200, reason: 'Quantity-aware offer',
    });

    expect(auction.quantity).toBe(3);
    expect(offer.offer?.quantity).toBe(2);
  });

  it('authorizes seller start and close with the selected demo principal and no bearer credential', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/auctions/start')) {
        return json({
          id: 'auction-secure', eventId: 'drop', eventItemId: ITEM.eventItemId,
          productId: ITEM.productId, quantity: 1, startingPriceCents: 1_100,
          currentPriceCents: 1_100, status: 'active', startedAt: 'now', endsAt: 'later',
        });
      }
      if (url.endsWith('/auctions/auction-secure/close')) {
        return json({
          id: 'auction-secure', eventId: 'drop', eventItemId: ITEM.eventItemId,
          productId: ITEM.productId, quantity: 1, startingPriceCents: 1_100,
          currentPriceCents: 1_100, status: 'closed', startedAt: 'now', endsAt: 'later',
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }));

    await startSellerAuction('drop', ITEM, 1, 1_100, undefined, 'demo-27');
    await closeSellerAuction('auction-secure', undefined, 'demo-27');

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get(DEMO_PRINCIPAL_HEADER)).toBe('demo-27');
      expect(new Headers(call.init?.headers).has('authorization')).toBe(false);
    }
    expect(calls[1]).toMatchObject({
      url: 'http://localhost:3100/auctions/auction-secure/close',
      init: { method: 'POST' },
    });
  });

  it('attaches the canonical principal to seller reads and run-of-show saves', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/events/drop/config')) {
        return json({
          eventId: 'drop',
          name: 'Drop',
          policy: {
            automationLevel: 'confirm', allowAutoActions: false,
            priceFloorCentsByProduct: {}, maxMarkdownPercent: 20,
            blockedActionKinds: [], tone: 'warm',
          },
        });
      }
      if (url.endsWith('/actions/events/drop/items')) return json({ items: [ITEM] });
      if (url.endsWith('/events/drop/run-of-show')) return json({ eventId: 'drop', entries: [] });
      throw new Error(`Unexpected URL ${url}`);
    }));

    await fetchSellerEvent('drop', undefined, 'demo-27');
    await saveRunOfShowPlan('drop', [], undefined, 'demo-27');

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get(DEMO_PRINCIPAL_HEADER)).toBe('demo-27');
    }
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
 * The lifecycle transport (plan sidestage-event-lifecycle-and-home-default,
 * P-005). The UI's legality mirror is covered differentially in
 * event-lifecycle.test.ts; what is asserted HERE is the wire itself — verb,
 * path, owner header and body — because those are what a refactor silently
 * gets wrong while every rendering test still passes.
 */
const EVENT_ROW = {
  eventId: 'sunday-drop',
  title: 'Sunday drop',
  sellerId: 'seller-27',
  sellerName: 'Studio 27',
  status: 'scheduled' as const,
  startsAt: '2026-08-17T15:00:00.000Z',
  endedAt: null,
};

describe('event lifecycle transport', () => {
  it('PATCHes the one lifecycle endpoint with the action and the owner header', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return json({ event: EVENT_ROW });
    }));

    const event = await transitionSellerEvent(
      'sunday-drop',
      'schedule',
      { startsAt: '2026-08-17T15:00:00.000Z' },
      undefined,
      'demo-27',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/events/sunday-drop/lifecycle');
    expect(calls[0].init?.method).toBe('PATCH');
    expect((calls[0].init?.headers as Record<string, string>)[DEMO_PRINCIPAL_HEADER]).toBe('demo-27');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      action: 'schedule',
      startsAt: '2026-08-17T15:00:00.000Z',
    });
    // The endpoint answers `{ event }`; callers get the row, not the envelope.
    expect(event).toEqual(EVENT_ROW);
  });

  it('omits startsAt for the actions that do not carry one', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ event: { ...EVENT_ROW, status: 'live' } });
    }));

    await transitionSellerEvent('sunday-drop', 'go-live');
    await transitionSellerEvent('sunday-drop', 'end');

    // A `startsAt: undefined` would drop out of JSON anyway, but an empty
    // string would NOT — and the server refuses one, so it must never be sent.
    expect(bodies).toEqual([{ action: 'go-live' }, { action: 'end' }]);
  });

  it('surfaces a refused transition as the server\'s own reason, with its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(
      { message: 'End the live event before rescheduling it.' },
      409,
    )));

    // This is the message the seller reads when a control they could still
    // reach turns out to be illegal — it must be the server's, not a generic
    // "request failed" the client invented.
    await expect(transitionSellerEvent('sunday-drop', 'schedule', { startsAt: '2026-08-17T15:00:00.000Z' }))
      .rejects.toMatchObject({
        message: 'End the live event before rescheduling it.',
        status: 409,
      });
    await expect(transitionSellerEvent('sunday-drop', 'schedule', { startsAt: '2026-08-17T15:00:00.000Z' }))
      .rejects.toBeInstanceOf(EventApiError);
  });

  it('unpublishes through DELETE on the event resource', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return json({ eventId: 'sunday-drop', status: 'draft' });
    }));

    const result = await unpublishSellerEvent('sunday-drop', undefined, 'demo-27');

    expect(calls[0].url).toContain('/events/sunday-drop');
    expect(calls[0].url).not.toContain('/lifecycle');
    expect(calls[0].init?.method).toBe('DELETE');
    expect((calls[0].init?.headers as Record<string, string>)[DEMO_PRINCIPAL_HEADER]).toBe('demo-27');
    expect(result).toEqual({ eventId: 'sunday-drop', status: 'draft' });
  });

  it('percent-encodes an event id rather than splicing it into the path', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return json({ event: EVENT_ROW });
    }));

    await transitionSellerEvent('sunday drop/2026', 'go-live');

    expect(calls[0]).toContain('/events/sunday%20drop%2F2026/lifecycle');
  });
});
