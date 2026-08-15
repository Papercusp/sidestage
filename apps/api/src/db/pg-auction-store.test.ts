import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Auction, AuctionBid } from '../auction/auction.service';
import { DEFAULT_DATABASE_URL } from './database.module';
import { PgAuctionStore } from './pg-auction-store';

type QueryResult = { rows: unknown[] };
type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>;

function activeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    id: 'auction-1',
    eventId: 'event-1',
    eventItemId: 'item-1',
    productId: 'product-1',
    quantity: 2,
    startingPriceCents: 1_000,
    currentPriceCents: 1_000,
    status: 'active',
    startedAt: '2026-08-14T18:00:00.000Z',
    endsAt: '2099-08-14T18:01:00.000Z',
    bids: [],
    ...overrides,
  };
}

function transactionalPool(handler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params));
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as never, connect, query, release };
}

describe('PgAuctionStore transactional aggregate authority', () => {
  it('reserves inventory and inserts the aggregate in one transaction', async () => {
    const harness = transactionalPool((sql) => {
      if (sql.includes('SELECT id FROM storefront_product')) return { rows: [{ id: 'product-1' }] };
      return { rows: [] };
    });
    const store = new PgAuctionStore(harness.pool);
    const auction = activeAuction();

    await expect(store.start(auction)).resolves.toEqual(auction);

    const statements = harness.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    expect(statements).toEqual([
      'BEGIN',
      'SELECT expire_inventory_reservations()',
      'SELECT id FROM storefront_product WHERE id = $1 FOR UPDATE',
      'SELECT reserve_inventory($1, $2, $3, $4, $5)',
      expect.stringContaining('INSERT INTO auction_state'),
      'COMMIT',
    ]);
    expect(harness.query.mock.calls[3]?.[1]).toEqual(['product-1', 'auction', 'auction-1', 2, null]);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('recovers the current aggregate from Postgres after a service restart', async () => {
    const recovered = activeAuction({ currentPriceCents: 1_400 });
    const query = vi.fn().mockResolvedValue({ rows: [{ payload: recovered }] });
    const store = new PgAuctionStore({ query } as never);

    await expect(store.getCurrentByEvent('event-1')).resolves.toEqual(recovered);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM auction_state'), ['event-1']);
  });

  it('validates a bid against the aggregate selected FOR UPDATE, not stale process state', async () => {
    const authoritative = activeAuction({ currentPriceCents: 1_500 });
    const harness = transactionalPool((sql) => {
      if (sql.includes('FROM auction_state') && sql.includes('FOR UPDATE')) {
        return { rows: [{ payload: authoritative }] };
      }
      return { rows: [] };
    });
    const store = new PgAuctionStore(harness.pool);
    const staleBid: AuctionBid = {
      id: 'bid-stale',
      bidderId: 'buyer-a',
      amountCents: 1_400,
      createdAt: '2026-08-14T18:00:30.000Z',
    };

    await expect(store.placeBid('auction-1', staleBid)).rejects.toThrow(
      'Bid must be greater than the current price of 1500 cents',
    );
    expect(harness.query.mock.calls.map(([sql]) => sql.trim())).toContain('ROLLBACK');
    expect(harness.query.mock.calls.some(([sql]) => sql.includes('UPDATE auction_state'))).toBe(false);
  });

  it('replays a persisted guest idempotency key under the aggregate row lock without another write', async () => {
    const existingBid: AuctionBid = {
      id: 'bid-original',
      bidderId: 'guest_verified',
      displayName: 'Ava',
      amountCents: 1_400,
      idempotencyKey: 'bid:req-1234',
      createdAt: '2026-08-14T18:00:30.000Z',
    };
    const harness = transactionalPool((sql) => {
      if (sql.includes('FROM auction_state') && sql.includes('FOR UPDATE')) {
        return { rows: [{ payload: activeAuction({ currentPriceCents: 1_400, bids: [existingBid] }) }] };
      }
      return { rows: [] };
    });
    const store = new PgAuctionStore(harness.pool);

    await expect(store.placeBid('auction-1', { ...existingBid, id: 'bid-retry' })).resolves.toMatchObject({
      accepted: true,
      changed: false,
      auction: { bids: [{ id: 'bid-original', idempotencyKey: 'bid:req-1234' }] },
    });
    expect(harness.query.mock.calls.some(([sql]) => sql.includes('UPDATE auction_state'))).toBe(false);
    expect(harness.query.mock.calls.map(([sql]) => sql.trim()).at(-1)).toBe('COMMIT');
  });

  it('settles an expired auction transactionally before refusing a late bid', async () => {
    const expired = activeAuction({ endsAt: '2020-08-14T18:01:00.000Z' });
    const harness = transactionalPool((sql) => {
      if (sql.includes('FROM auction_state') && sql.includes('FOR UPDATE')) {
        return { rows: [{ payload: expired }] };
      }
      if (sql.includes('release_inventory')) return { rows: [{ released: true }] };
      return { rows: [] };
    });
    const store = new PgAuctionStore(harness.pool);

    await expect(store.placeBid('auction-1', {
      id: 'bid-too-late',
      bidderId: 'buyer-a',
      amountCents: 2_000,
      createdAt: '2026-08-14T18:02:00.000Z',
    })).resolves.toMatchObject({
      accepted: false,
      changed: true,
      inventoryChanged: true,
      auction: { status: 'closed', winnerOrder: undefined },
    });
    const statements = harness.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    expect(statements.findIndex((sql) => sql.includes('release_inventory'))).toBeLessThan(
      statements.findIndex((sql) => sql.startsWith('UPDATE auction_state')),
    );
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('closes to a persisted winner order while retaining the winning inventory hold', async () => {
    const auction = activeAuction({
      currentPriceCents: 1_600,
      bids: [{
        id: 'bid-1',
        bidderId: 'buyer-a',
        displayName: 'A',
        amountCents: 1_600,
        createdAt: '2026-08-14T18:00:30.000Z',
      }],
    });
    let persisted: unknown[] | undefined;
    const harness = transactionalPool((sql, params) => {
      if (sql.includes('FROM auction_state') && sql.includes('FOR UPDATE')) {
        return { rows: [{ payload: auction }] };
      }
      if (sql.includes('FROM inventory_reservation')) return { rows: [{ id: '11' }] };
      if (sql.includes('UPDATE auction_state')) persisted = params;
      return { rows: [] };
    });
    const store = new PgAuctionStore(harness.pool);

    const result = await store.close('auction-1');

    expect(result).toMatchObject({ changed: true, inventoryChanged: false });
    expect(result.auction).toMatchObject({
      status: 'closed',
      winnerOrder: {
        auctionId: 'auction-1',
        bidderId: 'buyer-a',
        quantity: 2,
        unitPriceCents: 1_600,
        totalCents: 3_200,
        status: 'pending',
      },
    });
    expect(persisted?.[3]).toBe('buyer-a');
    expect(JSON.parse(String(persisted?.[5]))).toMatchObject({
      status: 'closed',
      winnerOrder: { bidderId: 'buyer-a' },
    });
    expect(harness.query.mock.calls.some(([sql]) => sql.includes('release_inventory'))).toBe(false);
  });

  it('releases the inventory hold in the same transaction when there is no winner', async () => {
    const harness = transactionalPool((sql) => {
      if (sql.includes('FROM auction_state') && sql.includes('FOR UPDATE')) {
        return { rows: [{ payload: activeAuction() }] };
      }
      if (sql.includes('release_inventory')) return { rows: [{ released: true }] };
      return { rows: [] };
    });
    const store = new PgAuctionStore(harness.pool);

    await expect(store.close('auction-1')).resolves.toMatchObject({
      changed: true,
      inventoryChanged: true,
      auction: { status: 'closed', winnerOrder: undefined },
    });
    const statements = harness.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    expect(statements.findIndex((sql) => sql.includes('release_inventory'))).toBeLessThan(
      statements.findIndex((sql) => sql.startsWith('UPDATE auction_state')),
    );
    expect(statements.at(-1)).toBe('COMMIT');
  });
});

describe.runIf(process.env.SIDESTAGE_PG_INTEGRATION === '1')('PgAuctionStore against Postgres', () => {
  it('serializes concurrent bids and recovers the winner through a fresh store instance', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max: 4 });
    const suffix = randomUUID();
    const productId = `auction-test-product-${suffix}`;
    const auction = activeAuction({
      id: `auction-test-${suffix}`,
      eventId: `auction-test-event-${suffix}`,
      eventItemId: `auction-test-item-${suffix}`,
      productId,
      endsAt: '2099-08-14T18:01:00.000Z',
    });

    try {
      await pool.query(
        `INSERT INTO event (event_id, title, seller_id, seller_name, status)
         VALUES ($1, 'Auction test event', 'demo-seller', 'Demo Seller', 'live')`,
        [auction.eventId],
      );
      await pool.query(
        `INSERT INTO storefront_product (id, slug, region, sku, price_cents, active, qty, reserved_qty)
         VALUES ($1, $1, 'US', $2, 1000, true, 3, 0)`,
        [productId, `AUCTION-TEST-${suffix}`],
      );
      const firstProcess = new PgAuctionStore(pool);
      await firstProcess.start(auction);

      const bids = await Promise.allSettled([
        firstProcess.placeBid(auction.id, {
          id: `bid-low-${suffix}`,
          bidderId: 'buyer-low',
          amountCents: 1_200,
          createdAt: '2026-08-14T18:00:20.000Z',
        }),
        firstProcess.placeBid(auction.id, {
          id: `bid-high-${suffix}`,
          bidderId: 'buyer-high',
          amountCents: 1_300,
          createdAt: '2026-08-14T18:00:21.000Z',
        }),
      ]);
      expect(bids.some(({ status }) => status === 'fulfilled')).toBe(true);

      const restartedProcess = new PgAuctionStore(pool);
      const recovered = await restartedProcess.getCurrentByEvent(auction.eventId);
      expect(recovered).toMatchObject({
        id: auction.id,
        status: 'active',
        currentPriceCents: 1_300,
      });
      expect(recovered?.bids[0]).toMatchObject({ bidderId: 'buyer-high', amountCents: 1_300 });

      const closed = await restartedProcess.close(auction.id);
      expect(closed.auction).toMatchObject({
        status: 'closed',
        winnerOrder: {
          bidderId: 'buyer-high',
          unitPriceCents: 1_300,
          totalCents: 2_600,
        },
      });
      await expect(restartedProcess.listWinnerOrdersForBuyer('buyer-high')).resolves.toEqual([
        expect.objectContaining({ auctionId: auction.id, bidderId: 'buyer-high' }),
      ]);
    } finally {
      await pool.query('DELETE FROM auction_state WHERE id = $1', [auction.id]);
      await pool.query("DELETE FROM inventory_reservation WHERE source_kind = 'auction' AND source_id = $1", [auction.id]);
      await pool.query('DELETE FROM storefront_product WHERE id = $1', [productId]);
      await pool.query('DELETE FROM event WHERE event_id = $1', [auction.eventId]);
      await pool.end();
    }
  });
});
