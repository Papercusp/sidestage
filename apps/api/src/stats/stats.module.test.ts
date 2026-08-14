import { describe, expect, it, vi } from 'vitest';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { StatsController, StatsSyncQueries } from './stats.module';

describe('StatsController pricing history', () => {
  it('registers event stats with the shared sync query registry', async () => {
    const stats = { stats: vi.fn().mockResolvedValue({ eventId: 'event-1', viewers: 3, itemsSold: 2, totalRaisedCents: 4200 }) };
    const queries = new SyncQueryRegistry();
    new StatsSyncQueries(stats as never, queries).onModuleInit();

    await expect(queries.resolve('event.stats', { eventId: 'event-1' })).resolves.toEqual([
      { eventId: 'event-1', viewers: 3, itemsSold: 2, totalRaisedCents: 4200 },
    ]);
    expect(stats.stats).toHaveBeenCalledWith('event-1');
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
    const controller = new StatsController(
      { getStats: () => ({ activeUsers: 0 }) } as never,
      pool as never,
      actions as never,
      auctions as never,
    );

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

  it('returns honest empty settled history when Postgres is unavailable', async () => {
    const controller = new StatsController(
      { getStats: () => ({ activeUsers: 0 }) } as never,
      null,
      { listAudit: () => [] } as never,
      { listByProduct: async () => [] } as never,
    );
    await expect(controller.pricingHistory('event-1', 'mug')).resolves.toEqual({
      productId: 'mug', prices: [], offers: [], auctions: [],
    });
  });
});
