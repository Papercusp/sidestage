import { afterEach, describe, expect, it, vi } from 'vitest';
import { adjustSellerEventStock, setupSellerEvent, type SellerEventItem } from './api';

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
