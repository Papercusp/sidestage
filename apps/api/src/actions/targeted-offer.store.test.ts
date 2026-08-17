import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  InMemoryTargetedOfferStore,
  sortOffersNewestFirst,
  toDomainOffer,
  type StoredTargetedOffer,
  type TargetedOfferDraft,
} from './targeted-offer.store';

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

describe('InMemoryTargetedOfferStore parity adapter', () => {
  it('creates at version 1 and returns detached snapshots', async () => {
    const store = new InMemoryTargetedOfferStore();
    const created = await store.create(draft());

    expect(created).toMatchObject({
      id: 'offer-1',
      status: 'pending',
      version: 1,
      createdAt: '2026-08-17T10:00:00.000Z',
      updatedAt: '2026-08-17T10:00:00.000Z',
    });

    // The store hands out copies: mutating a read must not corrupt the row.
    created.priceCents = 999;
    created.status = 'cancelled';
    await expect(store.get('offer-1')).resolves.toMatchObject({
      priceCents: 1_500,
      status: 'pending',
    });
  });

  it('resolves an unknown offer as undefined rather than throwing', async () => {
    const store = new InMemoryTargetedOfferStore();
    await expect(store.get('nope')).resolves.toBeUndefined();
  });

  it('rejects a second offer reusing an existing id', async () => {
    const store = new InMemoryTargetedOfferStore();
    await store.create(draft());
    await expect(store.create(draft({ buyerId: 'buyer-2' }))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  describe('create idempotency on the originating command', () => {
    it('returns the first offer when the same command is retried', async () => {
      const store = new InMemoryTargetedOfferStore();
      const first = await store.create(draft({ clientRequestId: 'cmd-1' }));
      // A retry mints a fresh offer id, so convergence cannot rely on the id.
      const retry = await store.create(
        draft({ id: 'offer-2', clientRequestId: 'cmd-1', priceCents: 1_200 }),
      );

      expect(retry).toMatchObject({ id: first.id, priceCents: 1_500, version: 1 });
      await expect(store.get('offer-2')).resolves.toBeUndefined();
      await expect(store.listForBuyer('buyer-1')).resolves.toHaveLength(1);
    });

    it('scopes the command key per event, so one id under two events stays distinct', async () => {
      const store = new InMemoryTargetedOfferStore();
      await store.create(draft({ clientRequestId: 'cmd-1' }));
      const other = await store.create(
        draft({ id: 'offer-2', eventId: 'event-2', clientRequestId: 'cmd-1' }),
      );

      expect(other.id).toBe('offer-2');
      await expect(store.listForEventProduct('event-2', 'mug')).resolves.toHaveLength(1);
    });

    it('keeps the composite key unambiguous when ids contain the separator', async () => {
      // requestKey joins eventId + clientRequestId. A naive ':' join would make
      // ('a:b', 'c') and ('a', 'b:c') collide and wrongly dedupe two distinct
      // commands into one offer; the NUL separator is what prevents that.
      const store = new InMemoryTargetedOfferStore();
      const left = await store.create(
        draft({ id: 'offer-left', eventId: 'a:b', clientRequestId: 'c' }),
      );
      const right = await store.create(
        draft({ id: 'offer-right', eventId: 'a', clientRequestId: 'b:c' }),
      );

      expect([left.id, right.id]).toEqual(['offer-left', 'offer-right']);
    });

    it('does not dedupe offers minted without a command key', async () => {
      const store = new InMemoryTargetedOfferStore();
      await store.create(draft());
      await store.create(draft({ id: 'offer-2' }));

      await expect(store.listForBuyer('buyer-1')).resolves.toHaveLength(2);
    });
  });

  describe('reads', () => {
    it('returns one buyer newest-first, breaking ties on id', async () => {
      const store = new InMemoryTargetedOfferStore();
      await store.create(draft({ id: 'older', createdAt: '2026-08-17T09:00:00.000Z' }));
      await store.create(draft({ id: 'newest', createdAt: '2026-08-17T11:00:00.000Z' }));
      await store.create(draft({ id: 'a-tie', createdAt: '2026-08-17T11:00:00.000Z' }));
      await store.create(draft({ id: 'other-buyer', buyerId: 'buyer-2' }));

      await expect(store.listForBuyer('buyer-1')).resolves.toMatchObject([
        { id: 'a-tie' },
        { id: 'newest' },
        { id: 'older' },
      ]);
    });

    it('filters an event-item read on both the event and the product', async () => {
      const store = new InMemoryTargetedOfferStore();
      await store.create(draft());
      await store.create(draft({ id: 'other-product', productId: 'cup' }));
      await store.create(draft({ id: 'other-event', eventId: 'event-2' }));

      await expect(store.listForEventProduct('event-1', 'mug')).resolves.toMatchObject([
        { id: 'offer-1' },
      ]);
    });
  });

  describe('setStatus compare-and-set', () => {
    it('bumps the version and stamps the lifecycle time', async () => {
      const store = new InMemoryTargetedOfferStore();
      const created = await store.create(draft());
      const accepted = await store.setStatus(
        created.id,
        created.version,
        'accepted',
        '2026-08-17T12:00:00.000Z',
      );

      expect(accepted).toMatchObject({
        status: 'accepted',
        version: 2,
        acceptedAt: '2026-08-17T12:00:00.000Z',
        updatedAt: '2026-08-17T12:00:00.000Z',
      });
      expect(accepted.cancelledAt).toBeUndefined();
    });

    it('preserves the original acceptance time when a later status lands', async () => {
      // An offer may be cancelled after it was accepted; the accepted stamp is
      // evidence of what happened and must not be rewritten.
      const store = new InMemoryTargetedOfferStore();
      const created = await store.create(draft());
      const accepted = await store.setStatus(created.id, 1, 'accepted', '2026-08-17T12:00:00.000Z');
      const cancelled = await store.setStatus(
        created.id,
        accepted.version,
        'cancelled',
        '2026-08-17T13:00:00.000Z',
      );

      expect(cancelled).toMatchObject({
        status: 'cancelled',
        version: 3,
        acceptedAt: '2026-08-17T12:00:00.000Z',
        cancelledAt: '2026-08-17T13:00:00.000Z',
      });
    });

    it('rejects a write against a version another writer already moved', async () => {
      const store = new InMemoryTargetedOfferStore();
      const created = await store.create(draft());
      await store.setStatus(created.id, created.version, 'accepted', '2026-08-17T12:00:00.000Z');

      await expect(
        store.setStatus(created.id, created.version, 'cancelled', '2026-08-17T12:30:00.000Z'),
      ).rejects.toBeInstanceOf(ConflictException);
      // The losing write left no trace.
      await expect(store.get(created.id)).resolves.toMatchObject({
        status: 'accepted',
        version: 2,
      });
    });

    it('distinguishes a missing offer from a stale one', async () => {
      const store = new InMemoryTargetedOfferStore();
      await expect(store.setStatus('ghost', 1, 'accepted', '2026-08-17T12:00:00.000Z'))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('attachAudit provenance backfill', () => {
    it('records the audit id without bumping the version', async () => {
      const store = new InMemoryTargetedOfferStore();
      const created = await store.create(draft());
      await store.attachAudit(created.id, 'audit-1');

      await expect(store.get(created.id)).resolves.toMatchObject({
        auditId: 'audit-1',
        version: created.version,
        updatedAt: created.updatedAt,
      });
    });

    it('never overwrites an audit id already recorded', async () => {
      const store = new InMemoryTargetedOfferStore();
      await store.create(draft({ auditId: 'audit-first' }));
      await store.attachAudit('offer-1', 'audit-second');

      await expect(store.get('offer-1')).resolves.toMatchObject({ auditId: 'audit-first' });
    });

    it('ignores an unknown offer instead of throwing', async () => {
      const store = new InMemoryTargetedOfferStore();
      await expect(store.attachAudit('ghost', 'audit-1')).resolves.toBeUndefined();
    });
  });

  describe('remove during rollback', () => {
    it('deletes the named offers and ignores ids it does not hold', async () => {
      const store = new InMemoryTargetedOfferStore();
      await store.create(draft());
      await store.create(draft({ id: 'offer-2' }));

      await store.remove(['offer-1', 'ghost']);

      await expect(store.get('offer-1')).resolves.toBeUndefined();
      await expect(store.get('offer-2')).resolves.toBeDefined();
    });

    it('frees the command key so the rolled-back command can run again', async () => {
      // Rollback un-does the action, so a re-run is a NEW offer rather than the
      // removed one resurfacing through create idempotency.
      const store = new InMemoryTargetedOfferStore();
      const first = await store.create(draft({ clientRequestId: 'cmd-1' }));
      await store.remove([first.id]);

      const reissued = await store.create(draft({ id: 'offer-2', clientRequestId: 'cmd-1' }));

      expect(reissued.id).toBe('offer-2');
      await expect(store.get(first.id)).resolves.toBeUndefined();
    });

    it('accepts an empty removal', async () => {
      const store = new InMemoryTargetedOfferStore();
      await store.create(draft());
      await store.remove([]);

      await expect(store.listForBuyer('buyer-1')).resolves.toHaveLength(1);
    });
  });
});

describe('targeted-offer projections', () => {
  it('strips storage-only fields from the domain contract', () => {
    const stored: StoredTargetedOffer = {
      ...draft({ clientRequestId: 'cmd-1', auditId: 'audit-1' }),
      version: 3,
      updatedAt: '2026-08-17T12:00:00.000Z',
      acceptedAt: '2026-08-17T12:00:00.000Z',
    };

    expect(toDomainOffer(stored)).toEqual({
      id: 'offer-1',
      eventId: 'event-1',
      eventItemId: 'event-1:mug',
      productId: 'mug',
      buyerId: 'buyer-1',
      priceCents: 1_500,
      quantity: 2,
      status: 'pending',
      createdAt: '2026-08-17T10:00:00.000Z',
    });
  });

  it('sorts newest-first and detaches every row it returns', () => {
    const rows: StoredTargetedOffer[] = [
      { ...draft({ id: 'older', createdAt: '2026-08-17T09:00:00.000Z' }), version: 1, updatedAt: '2026-08-17T09:00:00.000Z' },
      { ...draft({ id: 'newer', createdAt: '2026-08-17T11:00:00.000Z' }), version: 1, updatedAt: '2026-08-17T11:00:00.000Z' },
    ];

    const sorted = sortOffersNewestFirst(rows);

    expect(sorted.map((offer) => offer.id)).toEqual(['newer', 'older']);
    sorted[0]!.priceCents = 1;
    expect(rows.find((offer) => offer.id === 'newer')!.priceCents).toBe(1_500);
  });
});
