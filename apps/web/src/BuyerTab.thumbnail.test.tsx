import { renderToStaticMarkup } from 'react-dom/server';
import { SyncContext } from '@papercusp/sync';
import { describe, expect, it, vi } from 'vitest';

import { BuyerTab, buyerProductsFromSyncRows, buyerStatsFromSyncRows } from './BuyerTab';
import type { GuideEvent } from './events/api';

/**
 * The BUYER-side cover for the event thumbnail.
 *
 * The owner's ask for this feature was specifically that an uploaded image is
 * "used as the thumbnail in the event browser" — i.e. the buyer surface is the
 * deliverable, not the seller's upload control. That control is covered by
 * EventCreationPanel.thumbnail.test.tsx and the encode/validate core by
 * thumbnail.test.ts, which left exactly this wiring — BuyerTab -> EventThumbnail
 * -> <img>/poster — asserted nowhere. This file closes that.
 *
 * Rendered with renderToStaticMarkup, matching the hive's convention (there is
 * no DOM environment and no @testing-library/react). Effects do not run under
 * static rendering, so the `thumbnailUrl` PROP is the seam under test here; the
 * fetch-from-config path it falls back to is deliberately out of scope and is
 * called out in the last test below.
 */

const STATS = { viewers: 0, itemsSold: 0, totalRaisedCents: 0 } as const;

function render(thumbnailUrl?: string): string {
  return renderToStaticMarkup(
    <BuyerTab eventId="evt-thumb" eventTitle="Vintage Camera Drop" products={[]} stats={STATS} thumbnailUrl={thumbnailUrl} />,
  );
}

/**
 * Slice out just the buyer's thumbnail box.
 *
 * Asserting over the whole page would be a false claim about a true thing: the
 * product rail renders its own <img> per row, so a page-wide "has an image"
 * or "has no image" assertion passes or fails for reasons unrelated to the
 * thumbnail. Matched on the class TOKEN rather than the full attribute value,
 * because EventThumbnail composes its own class with the one BuyerTab passes.
 */
function thumbnailBox(html: string): string {
  const open = html.search(/<div class="[^"]*\bbuyer-event-thumbnail\b/);
  expect(open).toBeGreaterThan(-1);
  const close = html.indexOf('</div>', open);
  return html.slice(open, close + '</div>'.length);
}

describe('BuyerTab event thumbnail', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';

  it('renders the stored thumbnail as the buyer-facing image', () => {
    const box = thumbnailBox(render(PNG));
    expect(box).toContain(`src="${PNG}"`);
  });

  it('names the event in the alt text instead of leaving it unlabelled', () => {
    const box = thumbnailBox(render(PNG));
    // The alt text is the only description a screen-reader user gets for the
    // event's image, so it must carry the event name, not a generic string.
    expect(box).toContain('alt="Vintage Camera Drop thumbnail"');
  });

  it('falls back to the placeholder when the event has no thumbnail', () => {
    const box = thumbnailBox(render(undefined));
    expect(box).toContain('event-thumbnail-empty');
    expect(box).not.toContain('<img');
  });

  // The security-relevant case: a stored value can predate a tightening of the
  // allow-list, or arrive from a fixture that never went through the API's
  // validation at all. The buyer render must refuse it rather than trust that
  // the write path was the only way in.
  for (const hostile of [
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:image/svg+xml;base64,PHN2Zy8+',
  ]) {
    it(`refuses to render a hostile thumbnail value (${hostile.slice(0, 24)}...)`, () => {
      const html = render(hostile);
      // It falls back...
      expect(thumbnailBox(html)).toContain('event-thumbnail-empty');
      // ...and, the claim that actually matters, the hostile string reaches NO
      // attribute anywhere on the buyer page — not the <img src>, and not the
      // <video poster>, which consumes the same value on a separate code path.
      expect(html).not.toContain(hostile);
    });
  }

  it('does not render a thumbnail image before the config fetch has resolved', () => {
    // Effects do not run under static rendering, so this is the first-paint
    // state of an event whose thumbnail is only known from the API. Asserting
    // it pins the fallback as the INITIAL state: without it, a regression that
    // renders a broken <img> until the fetch lands would go unnoticed here.
    const box = thumbnailBox(render(undefined));
    expect(box).not.toContain('<img');
  });
});

describe('BuyerTab sync read models', () => {
  it('reads the guide and active-event thumbnail through events.guide without a direct fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const guideEvent: GuideEvent = {
      eventId: 'live-room',
      title: 'Renamed live room',
      sellerId: 'seller-1',
      sellerName: 'SideStage Seller',
      status: 'live',
      startsAt: '2026-08-14T15:00:00.000Z',
      endedAt: null,
      thumbnailUrl: 'data:image/png;base64,GUIDE',
      viewers: 8,
    };
    const useDataImpl = vi.fn((options: { queryName: string }) => ({
      data: options.queryName === 'events.guide' ? [guideEvent] : [],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate: vi.fn(),
      error: null,
    }));

    const html = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <BuyerTab eventId="live-room" eventTitle="Stale title" products={[]} stats={STATS} />
      </SyncContext.Provider>,
    );

    expect(useDataImpl).toHaveBeenCalledWith({
      queryName: 'events.guide',
      args: {},
      enabled: true,
      pollIntervalMs: 15_000,
    });
    expect(html).toContain('Renamed live room');
    expect(html).toContain('src="data:image/png;base64,GUIDE"');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('maps the event stats named-query row without changing the buyer view shape', () => {
    expect(buyerStatsFromSyncRows([STATS])).toEqual(STATS);
    expect(buyerStatsFromSyncRows([])).toBeNull();
  });

  it('maps a catalog page and gates the transport-failure fixture to development', () => {
    const synced = buyerProductsFromSyncRows([{
      rows: [{
        id: 'variant-1',
        groupId: 'product-1',
        title: 'Stoneware mug',
        brand: 'Northstar',
        productType: 'HOME',
        sku: 'MUG-1',
        condition: 'NEW',
        handlingDays: 2,
        priceCents: 2_400,
        qty: 3,
        reservedQty: 0,
        availableQty: 3,
      }],
      page: 1,
      pageSize: 6,
      total: 1,
      totalIsFloor: false,
    }], false);

    expect(synced).toEqual([
      expect.objectContaining({ id: 'variant-1', title: 'Stoneware mug', priceCents: 2_400, availableQty: 3 }),
    ]);
    expect(buyerProductsFromSyncRows(undefined, false)).toEqual([]);
    expect(buyerProductsFromSyncRows(undefined, true, true).length).toBeGreaterThan(0);
    expect(buyerProductsFromSyncRows(undefined, true, false)).toEqual([]);
  });

  it('alerts production buyers instead of rendering products when the catalog source is down', () => {
    const useDataImpl = vi.fn((options: { queryName: string }) => ({
      data: [],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate: vi.fn(),
      error: options.queryName === 'catalog.page' ? new Error('catalog unavailable') : null,
    }));

    const html = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <BuyerTab eventId="live-room" stats={STATS} guideEvents={[]} allowDemoData={false} />
      </SyncContext.Provider>,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Live inventory is unavailable');
    expect(html).not.toContain('demo-espresso-matte-black');
  });
});
