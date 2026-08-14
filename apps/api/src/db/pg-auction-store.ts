import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  Auction,
  AuctionBid,
  AuctionBidResult,
  AuctionCloseResult,
  AuctionStore,
  AuctionWinnerOrder,
} from '../auction/auction.service';

interface AuctionPayloadRow {
  payload: Auction | string;
}

interface AuctionIdRow {
  id: string;
}

interface BooleanRow {
  released: boolean;
}

function cloneAuction(auction: Auction): Auction {
  return {
    ...auction,
    bids: auction.bids.map((bid) => ({ ...bid })),
    winnerOrder: auction.winnerOrder ? { ...auction.winnerOrder } : undefined,
  };
}

function payload(row: AuctionPayloadRow | undefined): Auction | null {
  if (!row) return null;
  const value = typeof row.payload === 'string' ? JSON.parse(row.payload) as Auction : row.payload;
  return cloneAuction(value);
}

function postgresCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Postgres authority for the complete auction aggregate. Every mutation locks
 * the aggregate row, and start/close mutate the source-tracked inventory hold
 * in that SAME transaction, so no process crash can leave half an auction.
 */
export class PgAuctionStore implements AuctionStore {
  constructor(private readonly pool: Pool) {}

  async start(auction: Auction, availableQty?: number): Promise<Auction> {
    try {
      return await this.transaction(async (client) => {
        await client.query('SELECT expire_inventory_reservations()');
        const existing = await client.query<AuctionIdRow>(
          'SELECT id FROM storefront_product WHERE id = $1 FOR UPDATE',
          [auction.productId],
        );
        if (existing.rows.length === 0) {
          if (availableQty === undefined) throw new NotFoundException(`Inventory item ${auction.productId} was not found`);
          await client.query(
            `INSERT INTO storefront_product (id, slug, region, sku, price_cents, active, qty, reserved_qty)
             VALUES ($1, $1, 'US', upper(regexp_replace($1, '[^A-Za-z0-9]+', '-', 'g')), 0, true, $2, 0)`,
            [auction.productId, availableQty],
          );
        }

        try {
          await client.query(
            'SELECT reserve_inventory($1, $2, $3, $4, $5)',
            [auction.productId, 'auction', auction.id, auction.quantity, null],
          );
        } catch (error) {
          if (error instanceof Error && /insufficient inventory/i.test(error.message)) {
            throw new ConflictException(`Insufficient available quantity for ${auction.productId}`);
          }
          if (error instanceof Error && /was not found/i.test(error.message)) {
            throw new NotFoundException(`Inventory item ${auction.productId} was not found`);
          }
          throw error;
        }

        await client.query(
          `INSERT INTO auction_state
             (id, event_id, event_item_id, product_id, status, quantity,
              current_price_cents, winner_bidder_id, started_at, ends_at,
              closed_at, payload, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, NULL, $10::jsonb, now())`,
          [
            auction.id,
            auction.eventId,
            auction.eventItemId,
            auction.productId,
            auction.status,
            auction.quantity,
            auction.currentPriceCents,
            auction.startedAt,
            auction.endsAt,
            JSON.stringify(auction),
          ],
        );
        return cloneAuction(auction);
      });
    } catch (error) {
      if (postgresCode(error) === '23505') {
        throw new ConflictException(`Event ${auction.eventId} already has an active auction`);
      }
      throw error;
    }
  }

  async getCurrentByEvent(eventId: string): Promise<Auction | null> {
    const result = await this.pool.query<AuctionPayloadRow>(
      `SELECT payload
         FROM auction_state
        WHERE event_id = $1
        ORDER BY (status = 'active') DESC, started_at DESC
        LIMIT 1`,
      [eventId],
    );
    return payload(result.rows[0]);
  }

  async get(id: string): Promise<Auction | null> {
    const result = await this.pool.query<AuctionPayloadRow>(
      'SELECT payload FROM auction_state WHERE id = $1',
      [id],
    );
    return payload(result.rows[0]);
  }

  async listByProduct(productId: string): Promise<Auction[]> {
    const result = await this.pool.query<AuctionPayloadRow>(
      'SELECT payload FROM auction_state WHERE product_id = $1 ORDER BY started_at DESC',
      [productId],
    );
    return result.rows.flatMap((row) => payload(row) ?? []);
  }

  async listWinnerOrdersForBuyer(bidderId: string): Promise<AuctionWinnerOrder[]> {
    const result = await this.pool.query<AuctionPayloadRow>(
      `SELECT payload
         FROM auction_state
        WHERE winner_bidder_id = $1
        ORDER BY closed_at DESC`,
      [bidderId],
    );
    return result.rows.flatMap((row) => {
      const auction = payload(row);
      return auction?.winnerOrder ? [{ ...auction.winnerOrder }] : [];
    });
  }

  async placeBid(id: string, bid: AuctionBid): Promise<AuctionBidResult> {
    return this.transaction(async (client) => {
      const auction = await this.lockAuction(client, id);
      if (auction.status !== 'active') {
        return { auction, accepted: false, changed: false, inventoryChanged: false };
      }
      if (Date.now() >= Date.parse(auction.endsAt)) {
        const closed = await this.closeLocked(client, auction);
        return { ...closed, accepted: false };
      }
      if (bid.amountCents <= auction.currentPriceCents) {
        throw new ConflictException(`Bid must be greater than the current price of ${auction.currentPriceCents} cents`);
      }

      auction.bids.push({ ...bid });
      auction.bids.sort((left, right) => right.amountCents - left.amountCents || left.createdAt.localeCompare(right.createdAt));
      auction.currentPriceCents = bid.amountCents;
      await this.persist(client, auction);
      return { auction: cloneAuction(auction), accepted: true, changed: true, inventoryChanged: false };
    });
  }

  async close(id: string): Promise<AuctionCloseResult> {
    return this.transaction(async (client) => {
      const auction = await this.lockAuction(client, id);
      return auction.status === 'active'
        ? this.closeLocked(client, auction)
        : { auction, changed: false, inventoryChanged: false };
    });
  }

  async closeExpired(): Promise<AuctionCloseResult[]> {
    const result = await this.pool.query<AuctionIdRow>(
      "SELECT id FROM auction_state WHERE status = 'active' AND ends_at <= now() ORDER BY ends_at",
    );
    const closed: AuctionCloseResult[] = [];
    for (const row of result.rows) {
      const outcome = await this.close(row.id);
      if (outcome.changed) closed.push(outcome);
    }
    return closed;
  }

  private async lockAuction(client: PoolClient, id: string): Promise<Auction> {
    const result = await client.query<AuctionPayloadRow>(
      'SELECT payload FROM auction_state WHERE id = $1 FOR UPDATE',
      [id],
    );
    const auction = payload(result.rows[0]);
    if (!auction) throw new NotFoundException('Auction was not found');
    return auction;
  }

  private async closeLocked(client: PoolClient, auction: Auction): Promise<AuctionCloseResult> {
    auction.status = 'closed';
    auction.closedAt = new Date().toISOString();
    const winner = auction.bids[0];
    let inventoryChanged = false;

    if (!winner) {
      const result = await client.query<BooleanRow>(
        'SELECT release_inventory($1, $2, $3) AS released',
        ['auction', auction.id, auction.productId],
      );
      if (!result.rows[0]?.released) {
        throw new Error(`Active auction ${auction.id} has no releasable inventory reservation`);
      }
      inventoryChanged = true;
    } else {
      const reservation = await client.query<AuctionIdRow>(
        `SELECT id::text AS id
           FROM inventory_reservation
          WHERE source_kind = 'auction'
            AND source_id = $1
            AND variant_id = $2
            AND state IN ('held', 'committed')
          FOR UPDATE`,
        [auction.id, auction.productId],
      );
      if (reservation.rows.length === 0) {
        throw new Error(`Active auction ${auction.id} has no inventory reservation for its winner`);
      }
      auction.winnerOrder = {
        id: `order_${randomUUID()}`,
        auctionId: auction.id,
        eventId: auction.eventId,
        eventItemId: auction.eventItemId,
        productId: auction.productId,
        bidderId: winner.bidderId,
        quantity: auction.quantity,
        unitPriceCents: winner.amountCents,
        totalCents: winner.amountCents * auction.quantity,
        status: 'pending',
        createdAt: auction.closedAt,
      };
    }

    await this.persist(client, auction);
    return { auction: cloneAuction(auction), changed: true, inventoryChanged };
  }

  private async persist(client: PoolClient, auction: Auction): Promise<void> {
    await client.query(
      `UPDATE auction_state
          SET status = $2,
              current_price_cents = $3,
              winner_bidder_id = $4,
              closed_at = $5,
              payload = $6::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [
        auction.id,
        auction.status,
        auction.currentPriceCents,
        auction.winnerOrder?.bidderId ?? null,
        auction.closedAt ?? null,
        JSON.stringify(auction),
      ],
    );
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
