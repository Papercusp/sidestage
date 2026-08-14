import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import {
  EventStatsService,
  PricingHistoryService,
  StatsController,
  StatsSyncQueries,
} from './stats.module';

describe('StatsController pricing history', () => {
  it('registers event stats with the shared sync query registry', async () => {
    const stats = { read: vi.fn().mockResolvedValue({ eventId: 'event-1', viewers: 3, itemsSold: 2, totalRaisedCents: 4200 }) };
    const pricingHistory = {
      read: vi.fn().mockResolvedValue({ productId: 'mug', prices: [], offers: [], auctions: [] }),
    };
    const queries = new SyncQueryRegistry();
    const moduleRef = await Test.createTestingModule({
      providers: [
        StatsSyncQueries,
        { provide: EventStatsService, useValue: stats },
        { provide: PricingHistoryService, useValue: pricingHistory },
        { provide: SyncQueryRegistry, useValue: queries },
      ],
    }).compile();
    moduleRef.get(StatsSyncQueries).onModuleInit();

    await expect(queries.resolve('event.stats', { eventId: 'event-1' })).resolves.toEqual([
      { eventId: 'event-1', viewers: 3, itemsSold: 2, totalRaisedCents: 4200 },
    ]);
    expect(stats.read).toHaveBeenCalledWith('event-1');
    await expect(queries.resolve('event.pricingHistory', { eventId: 'event-1', productId: 'mug' })).resolves.toEqual([
      { productId: 'mug', prices: [], offers: [], auctions: [] },
    ]);
    expect(pricingHistory.read).toHaveBeenCalledWith('event-1', 'mug');
    await moduleRef.close();
  });

  it('combines settled checkout, targeted-offer, and auction outcomes for one product', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ price_cents: '2400', sold_qty: '5', rejected_qty: '2' }],
      }),
    };
    const actions = {
      listAudit: vi.fn().mockReturnValue([
        {
          after: {
            offers: [
              { id: 'offer-1', productId: 'mug', buyerId: 'buyer-a', priceCents: 2200, quantity: 2, status: 'accepted' },
              { id: 'offer-2', productId: 'mug', buyerId: 'buyer-b', priceCents: 2100, quantity: 1, status: 'cancelled' },
            ],
          },
        },
      ]),
    };
    const auctions = {
      listByProduct: vi.fn().mockResolvedValue([
        { id: 'auction-1', status: 'closed', currentPriceCents: 2600, quantity: 3, winnerOrder: { bidderId: 'buyer-c' }, closedAt: '2026-08-14T01:00:00Z' },
        { id: 'auction-2', status: 'closed', currentPriceCents: 1800, quantity: 1 },
      ]),
    };
    const pricingHistory = new PricingHistoryService(
      pool as never,
      actions as never,
      auctions as never,
    );
    const controller = new StatsController({ read: vi.fn() } as never, pricingHistory);

    const history = await controller.pricingHistory('event-1', 'mug');

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("status IN ('paid', 'failed')"), ['mug']);
    expect(actions.listAudit).toHaveBeenCalledWith('event-1');
    expect(history.prices).toEqual([{ priceCents: 2400, soldQty: 5, rejectedQty: 2 }]);
    expect(history.offers.map(({ buyerId, outcome }) => ({ buyerId, outcome }))).toEqual([
      { buyerId: 'buyer-b', outcome: 'rejected' },
      { buyerId: 'buyer-a', outcome: 'accepted' },
    ]);
    expect(history.auctions).toEqual([
      expect.objectContaining({ id: 'auction-1', outcome: 'sold', bidderId: 'buyer-c' }),
      expect.objectContaining({ id: 'auction-2', outcome: 'no-sale' }),
    ]);
  });

  describe('event stats are isolated per event', () => {
    // Paid orders belonging to two different events, plus a third event with none.
    const PAID_ORDERS = [
      { eventId: 'event-a', items: 2, totalCents: 4200 },
      { eventId: 'event-a', items: 1, totalCents: 800 },
      { eventId: 'event-b', items: 5, totalCents: 9900 },
    ];

    /**
     * Stands in for Postgres. Deliberately honours the eventId predicate ONLY when
     * the query actually carries it AND binds the parameter — otherwise it returns
     * the GLOBAL sum, exactly as the unfixed query did. That is what makes these
     * assertions falsifiable: drop the predicate from stats.module.ts and the
     * isolation cases below fail instead of silently passing against a mock that
     * was filtering on the test's behalf.
     */
    const fakePool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const scoped = sql.includes("payload->>'eventId' = $1") && typeof params?.[0] === 'string';
        const rows = scoped ? PAID_ORDERS.filter((o) => o.eventId === params?.[0]) : PAID_ORDERS;
        return {
          rows: [{
            items: String(rows.reduce((n, o) => n + o.items, 0)),
            raised: String(rows.reduce((n, o) => n + o.totalCents, 0)),
          }],
        };
      }),
    };

    const chat = { getStats: () => ({ activeUsers: 0 }) };
    const service = () => new EventStatsService(chat as never, fakePool as never);

    it('reports only the requested event totals, not the platform-wide sum', async () => {
      // Global totals across both events would be 8 items / 14900 cents.
      await expect(service().read('event-a')).resolves.toMatchObject({
        eventId: 'event-a', itemsSold: 3, totalRaisedCents: 5000,
      });
      await expect(service().read('event-b')).resolves.toMatchObject({
        eventId: 'event-b', itemsSold: 5, totalRaisedCents: 9900,
      });
    });

    it('reports zero for an event with no paid orders rather than the global total', async () => {
      // The regression this guards: an unscoped aggregate reported 8/14900 here.
      await expect(service().read('event-with-no-orders')).resolves.toMatchObject({
        itemsSold: 0, totalRaisedCents: 0,
      });
    });

    it('binds the eventId as a parameter instead of interpolating it', async () => {
      fakePool.query.mockClear();
      await service().read("event-'; DROP TABLE checkout_order; --");
      const [sql, params] = fakePool.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("payload->>'eventId' = $1");
      expect(params).toEqual(["event-'; DROP TABLE checkout_order; --"]);
      expect(sql).not.toContain('DROP TABLE');
    });

    it('CONTROL: the fake pool really does return the platform-wide sum when unscoped', async () => {
      // Falsifiability proof for the three cases above. They only mean something if
      // this fake discriminates — a mock that filtered unconditionally would let them
      // pass even against the unfixed query. Here we call it the way the OLD code did
      // (no predicate, no bound params) and assert it yields the global total, which
      // is precisely what would break the isolation expectations.
      const unscoped = await fakePool.query("... FROM checkout_order WHERE status = 'paid'");
      expect(unscoped.rows[0]).toEqual({ items: '8', raised: '14900' });
    });

    it('fails closed on a blank eventId instead of returning the global total', async () => {
      // StatsSyncQueries coerces a missing/non-string eventId arg to ''. That must
      // read as zero, never as every seller's revenue.
      await expect(service().read('')).resolves.toMatchObject({
        itemsSold: 0, totalRaisedCents: 0,
      });
    });
  });

  it('returns honest empty settled history when Postgres is unavailable', async () => {
    const pricingHistory = new PricingHistoryService(
      null,
      { listAudit: () => [] } as never,
      { listByProduct: async () => [] } as never,
    );
    const controller = new StatsController({ read: vi.fn() } as never, pricingHistory);
    await expect(controller.pricingHistory('event-1', 'mug')).resolves.toEqual({
      productId: 'mug', prices: [], offers: [], auctions: [],
    });
  });
});
