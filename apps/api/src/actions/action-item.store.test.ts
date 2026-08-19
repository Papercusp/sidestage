import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { InMemoryActionItemStore, type ActionItemDraft } from './action-item.store';

function draft(overrides: Partial<ActionItemDraft> = {}): ActionItemDraft {
  return {
    eventId: 'event-1',
    eventItemId: 'event-1:mug',
    productId: 'mug',
    position: 0,
    referencePriceCents: 1_500,
    priceCents: 1_500,
    quantity: 5,
    availableQty: 5,
    stageState: 'queued',
    onStage: false,
    title: 'Blue mug',
    attributes: { color: 'blue' },
    ...overrides,
  };
}

describe('InMemoryActionItemStore parity adapter', () => {
  it('orders rows and returns detached snapshots with durable metadata', async () => {
    const store = new InMemoryActionItemStore();
    const rows = await store.register('event-1', [
      draft({ eventItemId: 'event-1:cup', productId: 'cup', position: 1, title: 'Cup' }),
      draft(),
    ]);

    expect(rows.map((row) => row.productId)).toEqual(['mug', 'cup']);
    expect(rows[0]).toMatchObject({
      eventItemId: 'event-1:mug',
      referencePriceCents: 1_500,
      version: 1,
      // D-026: epoch millis, not an ISO string.
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    rows[0]!.attributes.color = 'mutated outside the store';
    await expect(store.list('event-1')).resolves.toMatchObject([
      { attributes: { color: 'blue' } },
      { productId: 'cup' },
    ]);
  });

  it('preserves stable identity, reference price, and creation time on registration refresh', async () => {
    const store = new InMemoryActionItemStore();
    const [first] = await store.register('event-1', [draft()]);
    const [refreshed] = await store.register('event-1', [draft({
      eventItemId: 'caller-tried-to-replace-it',
      referencePriceCents: 999,
      priceCents: 1_250,
      availableQty: 4,
      title: 'Updated title',
    })]);

    expect(refreshed).toMatchObject({
      eventItemId: first!.eventItemId,
      referencePriceCents: first!.referencePriceCents,
      createdAt: first!.createdAt,
      priceCents: 1_250,
      availableQty: 4,
      title: 'Updated title',
      version: 2,
    });
  });

  it('rejects stale optimistic writes without partially mutating the lineup', async () => {
    const store = new InMemoryActionItemStore();
    const [registered] = await store.register('event-1', [draft()]);
    await store.write('event-1', [{
      expectedVersion: registered!.version,
      item: { ...registered!, priceCents: 1_400 },
    }]);

    await expect(store.write('event-1', [{
      expectedVersion: registered!.version,
      item: { ...registered!, priceCents: 1_200 },
    }])).rejects.toBeInstanceOf(ConflictException);
    await expect(store.list('event-1')).resolves.toMatchObject([
      { priceCents: 1_400, version: 2 },
    ]);
  });

  it('enforces one on-stage row per event across registration and writes', async () => {
    const store = new InMemoryActionItemStore();
    await expect(store.register('event-1', [
      draft({ stageState: 'on-stage', onStage: true }),
      draft({ eventItemId: 'event-1:cup', productId: 'cup', stageState: 'on-stage', onStage: true }),
    ])).rejects.toBeInstanceOf(ConflictException);

    const rows = await store.register('event-1', [
      draft({ stageState: 'on-stage', onStage: true }),
      draft({ eventItemId: 'event-1:cup', productId: 'cup', position: 1 }),
    ]);
    await expect(store.write('event-1', [{
      expectedVersion: rows[1]!.version,
      item: { ...rows[1]!, stageState: 'on-stage', onStage: true },
    }])).rejects.toBeInstanceOf(ConflictException);
  });
});
