import { describe, expect, it, vi } from 'vitest';
import {
  buildSideStageScoutBody,
  createSideStageScoutTransport,
  ensureScoutBuyerCookie,
  scoutProductToBuyerProduct,
  type ScoutCookieDocument,
} from './scout-transport';

describe('SideStage Scout transport', () => {
  it('promotes only cart/event context into the first turn and preserves reconnect cursors', () => {
    const turn = {
      message: 'show my held items',
      sessionId: 'session-1',
      pageContext: { cartId: 'cart-7', eventId: 'event-9', buyerId: 'forged' },
    };
    expect(buildSideStageScoutBody(turn, null)).toEqual({
      message: 'show my held items',
      sessionId: 'session-1',
      pageContext: turn.pageContext,
      cartId: 'cart-7',
      eventId: 'event-9',
    });
    expect(buildSideStageScoutBody(turn, { turnId: 'turn-2', lastEventId: 5 }))
      .toEqual({ turnId: 'turn-2', lastEventId: 5 });
  });

  it('uses the same-origin stream endpoint and the shared body adapter', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('id: 1\ndata: {"type":"done"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream', 'X-Scout-Turn-Id': 'turn-1' },
      });
    };
    const cookieDocument: ScoutCookieDocument = { cookie: '' };
    const transport = createSideStageScoutTransport({
      fetchImpl,
      cookieDocument,
      randomId: () => 'scout-browser-1',
    });

    for await (const _event of transport.streamTurn({
      message: 'find headphones',
      sessionId: null,
      pageContext: { cartId: 'cart-1', eventId: 'event-1' },
    })) {
      // drain
    }

    expect(requests).toEqual([{
      url: '/api/scout/chat/stream',
      body: {
        message: 'find headphones',
        pageContext: { cartId: 'cart-1', eventId: 'event-1' },
        cartId: 'cart-1',
        eventId: 'event-1',
      },
    }]);
    expect(cookieDocument.cookie).toContain('ss_buyer_id=scout-browser-1');
  });

  it('keeps an existing valid continuity cookie and rejects malformed product cards', () => {
    const cookieDocument = { cookie: 'other=x; ss_buyer_id=scout-existing' };
    const randomId = vi.fn(() => 'scout-new');
    expect(ensureScoutBuyerCookie(cookieDocument, randomId)).toBe('scout-existing');
    expect(randomId).not.toHaveBeenCalled();
    expect(scoutProductToBuyerProduct({ nope: true })).toBeNull();
  });

  it('maps the server ProductCard onto the existing buyer rail shape', () => {
    expect(scoutProductToBuyerProduct({
      productId: 'p-1',
      title: 'Aurora headphones',
      description: 'Wireless over-ear headphones',
      priceCents: 12999,
      availableQty: 4,
      imageUrl: 'https://example.test/p-1.jpg',
      attributes: { brand: 'Aurora' },
    })).toEqual({
      id: 'p-1',
      title: 'Aurora headphones',
      subtitle: 'Wireless over-ear headphones',
      priceCents: 12999,
      availableQty: 4,
      imageUrl: 'https://example.test/p-1.jpg',
    });
  });
});
