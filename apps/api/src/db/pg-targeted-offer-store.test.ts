import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { TargetedOfferDraft } from '../actions/targeted-offer.store';
import { DEFAULT_DATABASE_URL } from './database.module';
import { PgTargetedOfferStore } from './pg-targeted-offer-store';

type QueryResult = { rows: unknown[] };
type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>;

function draft(overrides: Partial<TargetedOfferDraft> = {}): TargetedOfferDraft {
  return {
    id: 'offer-1',
    eventId: 'event-1',
    eventItemId: 'event-1:mug',
    productId: 'mug',
    buyerId: 'buyer-1',
    priceCents: 1_500,
    quantity: 2,
    status: 'pending',
    createdAt: '2026-08-17T10:00:00.000Z',
    ...overrides,
  };
}

/** A row exactly as node-pg hands it back: bigint as text, timestamps as Date. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    offer_id: 'offer-1',
    event_id: 'event-1',
    event_item_id: 'event-1:mug',
    product_id: 'mug',
    buyer_id: 'buyer-1',
    price_cents: 1_500,
    quantity: 2,
    status: 'pending',
    audit_id: null,
    client_request_id: null,
    version: '1',
    created_at: new Date('2026-08-17T10:00:00.000Z'),
    updated_at: new Date('2026-08-17T10:00:00.000Z'),
    accepted_at: null,
    cancelled_at: null,
    ...overrides,
  };
}

/** The store reads through pool.query and writes CAS through pool.connect. */
function mockPool(handler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params));
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { query, connect } as never, query, connect, release };
}

function statements(query: ReturnType<typeof vi.fn>): string[] {
  return query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());
}

describe('PgTargetedOfferStore row mapping', () => {
  it('normalizes a bigint version and timestamptz columns the driver did not parse', async () => {
    // version is bigint, which node-pg returns as a STRING; a caller comparing
    // it to a number would silently never match, so the cast is load-bearing.
    const harness = mockPool(() => ({
      rows: [row({
        version: '7',
        audit_id: 'audit-1',
        client_request_id: 'cmd-1',
        status: 'accepted',
        accepted_at: new Date('2026-08-17T12:00:00.000Z'),
        updated_at: '2026-08-17T12:00:00.000Z',
      })],
    }));

    await expect(new PgTargetedOfferStore(harness.pool).get('offer-1')).resolves.toEqual({
      id: 'offer-1',
      eventId: 'event-1',
      eventItemId: 'event-1:mug',
      productId: 'mug',
      buyerId: 'buyer-1',
      priceCents: 1_500,
      quantity: 2,
      status: 'accepted',
      auditId: 'audit-1',
      clientRequestId: 'cmd-1',
      version: 7,
      createdAt: '2026-08-17T10:00:00.000Z',
      updatedAt: '2026-08-17T12:00:00.000Z',
      acceptedAt: '2026-08-17T12:00:00.000Z',
    });
  });

  it('omits absent provenance and lifecycle stamps instead of carrying nulls', async () => {
    const harness = mockPool(() => ({ rows: [row()] }));
    const offer = await new PgTargetedOfferStore(harness.pool).get('offer-1');

    expect(offer).not.toHaveProperty('auditId');
    expect(offer).not.toHaveProperty('clientRequestId');
    expect(offer).not.toHaveProperty('acceptedAt');
    expect(offer).not.toHaveProperty('cancelledAt');
  });

  it('resolves a missing offer as undefined', async () => {
    const harness = mockPool(() => ({ rows: [] }));
    await expect(new PgTargetedOfferStore(harness.pool).get('ghost')).resolves.toBeUndefined();
  });
});

describe('PgTargetedOfferStore create convergence', () => {
  it('lets the database dedupe a retried command via the partial unique index', async () => {
    const harness = mockPool(() => ({ rows: [row({ client_request_id: 'cmd-1' })] }));

    await new PgTargetedOfferStore(harness.pool).create(draft({ clientRequestId: 'cmd-1' }));

    expect(statements(harness.query)[0]).toContain(
      'ON CONFLICT (event_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING',
    );
  });

  it('reads back the winning offer when DO NOTHING suppressed the insert', async () => {
    const harness = mockPool((sql) =>
      sql.includes('INSERT INTO targeted_offer')
        ? { rows: [] }
        : { rows: [row({ offer_id: 'offer-first', client_request_id: 'cmd-1' })] });

    const converged = await new PgTargetedOfferStore(harness.pool)
      .create(draft({ id: 'offer-retry', clientRequestId: 'cmd-1' }));

    expect(converged).toMatchObject({ id: 'offer-first', clientRequestId: 'cmd-1' });
    expect(statements(harness.query)[1]).toContain('WHERE event_id = $1 AND client_request_id = $2');
  });

  it('does not offer a conflict target for an offer minted without a command key', async () => {
    // Without a command key there is nothing to converge on, so a duplicate id
    // must surface as a collision rather than be quietly swallowed.
    const harness = mockPool(() => ({ rows: [row()] }));

    await new PgTargetedOfferStore(harness.pool).create(draft());

    expect(statements(harness.query)[0]).not.toContain('ON CONFLICT');
  });

  it('translates a duplicate primary key into a conflict', async () => {
    const harness = mockPool(() => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      });
    });

    await expect(new PgTargetedOfferStore(harness.pool).create(draft()))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('propagates a non-collision database failure unchanged', async () => {
    const harness = mockPool(() => {
      throw Object.assign(new Error('insert or update violates foreign key constraint'), {
        code: '23503',
      });
    });

    await expect(new PgTargetedOfferStore(harness.pool).create(draft()))
      .rejects.toThrow('foreign key');
  });

  it('reports a conflict when the suppressed insert has no readable winner', async () => {
    const harness = mockPool(() => ({ rows: [] }));

    await expect(
      new PgTargetedOfferStore(harness.pool).create(draft({ clientRequestId: 'cmd-1' })),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('PgTargetedOfferStore transaction boundary', () => {
  it('carries the expected version in the UPDATE and commits once', async () => {
    const harness = mockPool((sql) =>
      sql.includes('UPDATE targeted_offer') ? { rows: [row({ version: '2' })] } : { rows: [] });

    const updated = await new PgTargetedOfferStore(harness.pool)
      .setStatus('offer-1', 1, 'accepted', '2026-08-17T12:00:00.000Z');

    expect(updated.version).toBe(2);
    expect(statements(harness.query)).toEqual([
      'BEGIN',
      expect.stringMatching(/UPDATE targeted_offer .* WHERE offer_id = \$1 AND version = \$2/),
      'COMMIT',
    ]);
    // The invariant travels in the WHERE clause, not in a prior read.
    expect(harness.query.mock.calls[1]![1]).toEqual([
      'offer-1',
      1,
      'accepted',
      '2026-08-17T12:00:00.000Z',
    ]);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('stamps the lifecycle time only for the status that earns it', async () => {
    const harness = mockPool((sql) =>
      sql.includes('UPDATE targeted_offer') ? { rows: [row({ version: '2' })] } : { rows: [] });

    await new PgTargetedOfferStore(harness.pool)
      .setStatus('offer-1', 1, 'accepted', '2026-08-17T12:00:00.000Z');

    const update = statements(harness.query)[1]!;
    // COALESCE is what preserves an earlier acceptance across a later change.
    expect(update).toContain("accepted_at = CASE WHEN $3 = 'accepted' THEN COALESCE(accepted_at, $4::timestamptz)");
    expect(update).toContain("cancelled_at = CASE WHEN $3 = 'cancelled' THEN COALESCE(cancelled_at, $4::timestamptz)");
  });

  it('rolls back and reports a conflict when another writer moved the version', async () => {
    const harness = mockPool((sql) => {
      if (sql.includes('UPDATE targeted_offer')) return { rows: [] };
      if (sql.includes('SELECT offer_id')) return { rows: [{ offer_id: 'offer-1' }] };
      return { rows: [] };
    });

    await expect(
      new PgTargetedOfferStore(harness.pool).setStatus('offer-1', 1, 'accepted', '2026-08-17T12:00:00.000Z'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(statements(harness.query)).toEqual([
      'BEGIN',
      expect.stringContaining('UPDATE targeted_offer'),
      expect.stringContaining('SELECT offer_id FROM targeted_offer'),
      'ROLLBACK',
    ]);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('reports a missing offer rather than a conflict when the row is gone', async () => {
    const harness = mockPool(() => ({ rows: [] }));

    await expect(
      new PgTargetedOfferStore(harness.pool).setStatus('ghost', 1, 'accepted', '2026-08-17T12:00:00.000Z'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(statements(harness.query).at(-1)).toBe('ROLLBACK');
    expect(harness.release).toHaveBeenCalledOnce();
  });
});

describe('PgTargetedOfferStore provenance and rollback', () => {
  it('guards the audit backfill so it never overwrites a recorded id', async () => {
    const harness = mockPool(() => ({ rows: [] }));

    await new PgTargetedOfferStore(harness.pool).attachAudit('offer-1', 'audit-1');

    expect(statements(harness.query)).toEqual([
      'UPDATE targeted_offer SET audit_id = $2 WHERE offer_id = $1 AND audit_id IS NULL',
    ]);
  });

  it('removes a batch in one statement', async () => {
    const harness = mockPool(() => ({ rows: [] }));

    await new PgTargetedOfferStore(harness.pool).remove(['offer-1', 'offer-2']);

    expect(statements(harness.query)).toEqual([
      'DELETE FROM targeted_offer WHERE offer_id = ANY($1::text[])',
    ]);
    expect(harness.query.mock.calls[0]![1]).toEqual([['offer-1', 'offer-2']]);
  });

  it('skips the round trip entirely when there is nothing to remove', async () => {
    const harness = mockPool(() => ({ rows: [] }));

    await new PgTargetedOfferStore(harness.pool).remove([]);

    expect(harness.query).not.toHaveBeenCalled();
  });
});

describe.runIf(process.env.SIDESTAGE_PG_INTEGRATION === '1')('PgTargetedOfferStore against Postgres', () => {
  it('survives a store restart, converges a retried command, and rejects a stale write', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max: 3 });
    const suffix = randomUUID();
    const eventId = `offer-test-event-${suffix}`;
    const productId = `offer-test-product-${suffix}`;
    const eventItemId = `${eventId}:${productId}`;

    try {
      await pool.query(
        `INSERT INTO storefront_product
           (id, slug, sku, price_cents, qty, reserved_qty, seller_id)
         VALUES ($1, $1, $1, 1500, 5, 0, 'seller-demo')`,
        [productId],
      );
      await pool.query(
        `INSERT INTO event (event_id, title, seller_id, seller_name, status)
         VALUES ($1, 'Offer test event', 'seller-demo', 'Demo Seller', 'live')`,
        [eventId],
      );
      await pool.query(
        `INSERT INTO event_lineup_item
           (event_item_id, event_id, product_id, position, reference_price_cents,
            current_price_cents, listed_quantity, current_quantity, title)
         VALUES ($1, $2, $3, 0, 1500, 1500, 5, 5, 'Blue mug')`,
        [eventItemId, eventId, productId],
      );

      const firstProcess = new PgTargetedOfferStore(pool);
      const created = await firstProcess.create({
        id: `offer-${suffix}`,
        eventId,
        eventItemId,
        productId,
        buyerId: `buyer-${suffix}`,
        priceCents: 1_500,
        quantity: 2,
        status: 'pending',
        createdAt: new Date().toISOString(),
        clientRequestId: `cmd-${suffix}`,
      });
      expect(created).toMatchObject({ status: 'pending', version: 1 });

      // The retry carries a fresh offer id: convergence must come from the
      // partial unique index on (event_id, client_request_id), not the id.
      const retried = await firstProcess.create({
        id: `offer-retry-${suffix}`,
        eventId,
        eventItemId,
        productId,
        buyerId: `buyer-${suffix}`,
        priceCents: 9_999,
        quantity: 7,
        status: 'pending',
        createdAt: new Date().toISOString(),
        clientRequestId: `cmd-${suffix}`,
      });
      expect(retried).toMatchObject({ id: created.id, priceCents: 1_500, version: 1 });

      const restartedProcess = new PgTargetedOfferStore(pool);
      await expect(restartedProcess.listForBuyer(`buyer-${suffix}`)).resolves.toMatchObject([
        { id: created.id, status: 'pending', version: 1 },
      ]);
      await expect(restartedProcess.listForEventProduct(eventId, productId))
        .resolves.toHaveLength(1);

      // Acceptance must land with its stamp: targeted_offer_accepted_stamped
      // rejects an accepted row whose accepted_at is null.
      const accepted = await restartedProcess.setStatus(
        created.id,
        created.version,
        'accepted',
        new Date().toISOString(),
      );
      expect(accepted).toMatchObject({ status: 'accepted', version: 2 });
      expect(accepted.acceptedAt).toBeTruthy();

      await expect(
        firstProcess.setStatus(created.id, created.version, 'cancelled', new Date().toISOString()),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(firstProcess.get(created.id)).resolves.toMatchObject({
        status: 'accepted',
        version: 2,
      });

      // Cancelling after acceptance keeps the acceptance stamp as evidence.
      const cancelled = await restartedProcess.setStatus(
        created.id,
        accepted.version,
        'cancelled',
        new Date().toISOString(),
      );
      expect(cancelled).toMatchObject({ status: 'cancelled', version: 3 });
      expect(cancelled.acceptedAt).toBe(accepted.acceptedAt);

      await expect(
        restartedProcess.setStatus(created.id, 99, 'expired', new Date().toISOString()),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        restartedProcess.setStatus(`ghost-${suffix}`, 1, 'expired', new Date().toISOString()),
      ).rejects.toBeInstanceOf(NotFoundException);

      await restartedProcess.remove([created.id, `never-existed-${suffix}`]);
      await expect(restartedProcess.get(created.id)).resolves.toBeUndefined();
    } finally {
      await pool.query('DELETE FROM event WHERE event_id = $1', [eventId]);
      await pool.query('DELETE FROM storefront_product WHERE id = $1', [productId]);
      await pool.end();
    }
  });
});
