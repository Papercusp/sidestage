import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import {
  cloneStoredOffer,
  type StoredTargetedOffer,
  type TargetedOfferDraft,
  type TargetedOfferStatus,
  type TargetedOfferStore,
} from '../actions/targeted-offer.store';

interface TargetedOfferRow {
  offer_id: string;
  event_id: string;
  event_item_id: string;
  product_id: string;
  buyer_id: string;
  price_cents: number;
  quantity: number;
  status: TargetedOfferStatus;
  audit_id: string | null;
  client_request_id: string | null;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  accepted_at: Date | string | null;
  cancelled_at: Date | string | null;
}

const SELECT_COLUMNS = `offer_id, event_id, event_item_id, product_id, buyer_id,
  price_cents, quantity, status, audit_id, client_request_id, version,
  created_at, updated_at, accepted_at, cancelled_at`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: TargetedOfferRow): StoredTargetedOffer {
  return {
    id: row.offer_id,
    eventId: row.event_id,
    eventItemId: row.event_item_id,
    productId: row.product_id,
    buyerId: row.buyer_id,
    priceCents: row.price_cents,
    quantity: row.quantity,
    status: row.status,
    ...(row.audit_id ? { auditId: row.audit_id } : {}),
    ...(row.client_request_id ? { clientRequestId: row.client_request_id } : {}),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.accepted_at ? { acceptedAt: iso(row.accepted_at) } : {}),
    ...(row.cancelled_at ? { cancelledAt: iso(row.cancelled_at) } : {}),
  };
}

function postgresCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/**
 * Postgres production authority for targeted offers.
 *
 * Every write is a single statement whose WHERE clause carries the invariant,
 * so two API processes racing the same offer resolve in the database rather
 * than in whichever process read last: creation converges on the originating
 * command's mutation key, and a status change only lands against the version
 * the caller actually read.
 */
export class PgTargetedOfferStore implements TargetedOfferStore {
  constructor(private readonly pool: Pool) {}

  async get(offerId: string): Promise<StoredTargetedOffer | undefined> {
    const result = await this.pool.query<TargetedOfferRow>(
      `SELECT ${SELECT_COLUMNS} FROM targeted_offer WHERE offer_id = $1`,
      [offerId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async listForBuyer(buyerId: string): Promise<StoredTargetedOffer[]> {
    const result = await this.pool.query<TargetedOfferRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM targeted_offer
        WHERE buyer_id = $1
        ORDER BY created_at DESC, offer_id`,
      [buyerId],
    );
    return result.rows.map(mapRow);
  }

  async listForEventProduct(eventId: string, productId: string): Promise<StoredTargetedOffer[]> {
    const result = await this.pool.query<TargetedOfferRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM targeted_offer
        WHERE event_id = $1 AND product_id = $2
        ORDER BY created_at DESC, offer_id`,
      [eventId, productId],
    );
    return result.rows.map(mapRow);
  }

  async create(draft: TargetedOfferDraft): Promise<StoredTargetedOffer> {
    const onConflict = draft.clientRequestId
      ? 'ON CONFLICT (event_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING'
      : '';
    try {
      const inserted = await this.pool.query<TargetedOfferRow>(
        `INSERT INTO targeted_offer
           (offer_id, event_id, event_item_id, product_id, buyer_id,
            price_cents, quantity, status, audit_id, client_request_id,
            version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $11)
         ${onConflict}
         RETURNING ${SELECT_COLUMNS}`,
        [
          draft.id,
          draft.eventId,
          draft.eventItemId,
          draft.productId,
          draft.buyerId,
          draft.priceCents,
          draft.quantity,
          draft.status,
          draft.auditId ?? null,
          draft.clientRequestId ?? null,
          draft.createdAt,
        ],
      );
      if (inserted.rows[0]) return cloneStoredOffer(mapRow(inserted.rows[0]));
    } catch (error) {
      // A duplicate offer_id is a genuine collision, not a retried command.
      if (postgresCode(error) !== '23505') throw error;
      throw new ConflictException(`Offer ${draft.id} already exists`);
    }
    // DO NOTHING fired: an earlier attempt at this same command already won.
    const existing = draft.clientRequestId
      ? await this.pool.query<TargetedOfferRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM targeted_offer
          WHERE event_id = $1 AND client_request_id = $2`,
        [draft.eventId, draft.clientRequestId],
      )
      : null;
    if (existing?.rows[0]) return cloneStoredOffer(mapRow(existing.rows[0]));
    throw new ConflictException(`Offer ${draft.id} already exists`);
  }

  async setStatus(
    offerId: string,
    expectedVersion: number,
    status: TargetedOfferStatus,
    at: string,
  ): Promise<StoredTargetedOffer> {
    return this.transaction(async (client) => {
      const updated = await client.query<TargetedOfferRow>(
        `UPDATE targeted_offer
            SET status = $3,
                version = version + 1,
                updated_at = $4,
                accepted_at = CASE WHEN $3 = 'accepted' THEN COALESCE(accepted_at, $4::timestamptz) ELSE accepted_at END,
                cancelled_at = CASE WHEN $3 = 'cancelled' THEN COALESCE(cancelled_at, $4::timestamptz) ELSE cancelled_at END
          WHERE offer_id = $1 AND version = $2
        RETURNING ${SELECT_COLUMNS}`,
        [offerId, expectedVersion, status, at],
      );
      if (updated.rows[0]) return cloneStoredOffer(mapRow(updated.rows[0]));
      // No row updated: distinguish "gone" from "someone else moved first",
      // because only the second is worth a reload-and-retry.
      const present = await client.query<{ offer_id: string }>(
        'SELECT offer_id FROM targeted_offer WHERE offer_id = $1',
        [offerId],
      );
      if (!present.rows[0]) throw new NotFoundException('Offer was not found');
      throw new ConflictException('Offer changed; reload it and retry');
    });
  }

  async attachAudit(offerId: string, auditId: string): Promise<void> {
    await this.pool.query(
      'UPDATE targeted_offer SET audit_id = $2 WHERE offer_id = $1 AND audit_id IS NULL',
      [offerId, auditId],
    );
  }

  async remove(offerIds: readonly string[]): Promise<void> {
    if (offerIds.length === 0) return;
    await this.pool.query('DELETE FROM targeted_offer WHERE offer_id = ANY($1::text[])', [
      [...offerIds],
    ]);
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
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
