import { describe, expect, it } from 'vitest';
import { GuardedActionService } from './action.service';
import type { ActionEventItem } from './action.types';
import type { CopilotPolicy } from '../copilot/copilot.types';
import { withDerivedPriceFloors } from '../config/event-config.service';
import { SyncInvalidationService, type SyncInvalidation } from '../sync/sync-invalidation.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { ActionSyncQueries } from './action.module';

const policy: CopilotPolicy = {
  automationLevel: 'auto',
  allowAutoActions: true,
  priceFloorCentsByProduct: { mug: 1_000 },
  maxMarkdownPercent: 20,
  blockedActionKinds: [],
  tone: 'warm',
};

const item: ActionEventItem = {
  eventId: 'event-1',
  eventItemId: 'event-1:mug',
  productId: 'mug',
  title: 'Blue mug',
  priceCents: 1_500,
  availableQty: 5,
  quantity: 5,
  attributes: { color: 'blue' },
};

function service(): GuardedActionService {
  const actions = new GuardedActionService();
  actions.registerEvent('event-1', { policy, items: [item] });
  return actions;
}

describe('GuardedActionService', () => {
  it('registers the seller lineup as the event.actions.items named query', async () => {
    const actions = service();
    const queries = new SyncQueryRegistry();
    new ActionSyncQueries(actions, queries).onModuleInit();

    await expect(queries.resolve('event.actions.items', { eventId: 'event-1' })).resolves.toEqual([
      expect.objectContaining({ eventId: 'event-1', productId: 'mug' }),
    ]);
  });

  it('invalidates the event-scoped lineup after registration, action, and rollback writes', async () => {
    const invalidations = new SyncInvalidationService();
    const published: SyncInvalidation[] = [];
    const subscription = invalidations.events().subscribe((event) => published.push(event));
    const actions = new GuardedActionService(null, invalidations);
    actions.registerEvent('event-1', { policy, items: [item] });
    const applied = await actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'markdown', productId: 'mug', priceCents: 1_200, reason: 'Live markdown' },
    });
    await actions.rollback(applied.auditId, 'seller-1');
    subscription.unsubscribe();

    expect(published.filter(({ name }) => name === 'event.actions.items').map(({ args }) => args)).toEqual([
      { eventId: 'event-1' },
      { eventId: 'event-1' },
      { eventId: 'event-1' },
    ]);
    expect(published.filter(({ name }) => name === 'event.pricingHistory').map(({ args }) => args)).toEqual([
      { eventId: 'event-1', productId: 'mug' },
      { eventId: 'event-1', productId: 'mug' },
    ]);
  });

  it('applies a markdown, records before/after state, and rolls it back', async () => {
    const actions = service();
    const applied = await actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'markdown', productId: 'mug', priceCents: 1_200, reason: 'Live viewer asked for a small discount' },
    });

    expect(applied.state.priceCents).toBe(1_200);
    const audit = actions.getAudit(applied.auditId);
    expect(audit.kind).toBe('markdown');
    expect(audit.before.item.priceCents).toBe(1_500);
    expect(audit.after.item.priceCents).toBe(1_200);

    const rollback = await actions.rollback(applied.auditId, 'seller-1', 'Undo test markdown');
    expect(rollback.state.priceCents).toBe(1_500);
    expect(actions.listAudit('event-1')).toHaveLength(2);
    expect(actions.getAudit(applied.auditId).rolledBackAt).toBeDefined();
    expect(actions.getAudit(rollback.auditId).kind).toBe('rollback');
  });

  it('adjusts price and quantity in one audited write while respecting availability', async () => {
    const actions = service();
    const result = await actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'price-adjust', productId: 'mug', priceCents: 1_400, quantity: 3, reason: 'Limit the live drop quantity' },
    });

    expect(result.state).toMatchObject({ priceCents: 1_400, quantity: 3, availableQty: 5 });
    expect(actions.getAudit(result.auditId).kind).toBe('price-adjust');
    await expect(actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'price-adjust', productId: 'mug', priceCents: 1_300, quantity: 6, reason: 'Too many units' },
    })).rejects.toThrow('available');
  });

  it('creates a targeted offer, reserves its quantity, and restores it on rollback', async () => {
    const actions = service();
    const result = await actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'targeted-offer', productId: 'mug', buyerId: 'buyer-9', quantity: 2, priceCents: 1_200, reason: 'Reward a returning buyer' },
    });

    expect(result.offer).toMatchObject({ buyerId: 'buyer-9', quantity: 2, priceCents: 1_200, status: 'pending' });
    expect(result.offer?.createdAt).toBeDefined();
    expect(actions.listOffersForBuyer('buyer-9')).toEqual([
      expect.objectContaining({ id: result.offer?.id, buyerId: 'buyer-9', createdAt: expect.any(String) }),
    ]);
    expect(actions.listOffersForBuyer('buyer-other')).toEqual([]);
    expect(result.state.availableQty).toBe(3);
    const rollback = await actions.rollback(result.auditId, 'seller-1');
    expect(rollback.state.availableQty).toBe(5);
    expect(actions.getAudit(result.auditId).after.offers).toHaveLength(1);
    expect(actions.getAudit(rollback.auditId).after.offers).toHaveLength(0);
  });

  it('invalidates only the targeted buyer when an offer is created or rolled back', async () => {
    const invalidations = new SyncInvalidationService();
    const published: SyncInvalidation[] = [];
    const subscription = invalidations.events().subscribe((event) => published.push(event));
    const actions = new GuardedActionService(null, invalidations);
    actions.registerEvent('event-1', { policy, items: [item] });

    const result = await actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'targeted-offer', productId: 'mug', buyerId: 'buyer-9', quantity: 1, priceCents: 1_200, reason: 'Reward a returning buyer' },
    });
    await actions.rollback(result.auditId, 'seller-1');
    subscription.unsubscribe();

    expect(published.filter(({ name }) => name === 'orders.byBuyer').map(({ args }) => args)).toEqual([
      { buyerId: 'buyer-9' },
      { buyerId: 'buyer-9' },
    ]);
  });

  it('blocks below-floor writes before mutating state or creating an audit', async () => {
    const actions = service();
    await expect(actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'markdown', productId: 'mug', priceCents: 900, reason: 'Unsafe discount' },
    })).rejects.toThrow('floor');
    expect(actions.listItems('event-1')[0].priceCents).toBe(1_500);
    expect(actions.listAudit('event-1')).toEqual([]);
  });

  it('rejects rollback after a newer write changes the same item', async () => {
    const actions = service();
    const first = await actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'markdown', productId: 'mug', priceCents: 1_300, reason: 'First offer' },
    });
    await actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'price-adjust', productId: 'mug', priceCents: 1_400, reason: 'Second offer' },
    });
    await expect(actions.rollback(first.auditId, 'seller-1')).rejects.toThrow('stale');
  });

  it('pushes an item on stage and swap moves the stage to another verified item', async () => {
    const actions = new GuardedActionService();
    actions.registerEvent('event-1', {
      policy,
      items: [item, { ...item, eventItemId: 'event-1:cup', productId: 'cup', title: 'Aurora cup' }],
    });

    const pushed = await actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'push', productId: 'mug', reason: 'Mug takes the stage' },
    });
    expect(pushed.state.onStage).toBe(true);

    const swapped = await actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'swap', productId: 'mug', swapToProductId: 'cup', reason: 'Cup up next' },
    });
    expect(swapped.state.onStage).toBe(false);
    const items = actions.listItems('event-1');
    expect(items.find((entry) => entry.productId === 'cup')?.onStage).toBe(true);
    expect(items.find((entry) => entry.productId === 'mug')?.onStage).toBe(false);

    await expect(actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'swap', productId: 'cup', swapToProductId: 'ghost', reason: 'Bad target' },
    })).rejects.toThrow('not a verified event item');
  });

  it('stock-adjust sets the listed quantity within verified availability and price stays untouched', async () => {
    const actions = service();
    const adjusted = await actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'stock-adjust', productId: 'mug', quantity: 2, reason: 'Held two back for the auction' },
    });
    expect(adjusted.state.quantity).toBe(2);
    expect(adjusted.state.priceCents).toBe(1_500);

    await expect(actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'stock-adjust', productId: 'mug', quantity: 9, reason: 'Too many' },
    })).rejects.toThrow();

    await expect(actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'push', productId: 'mug', priceCents: 1_000, reason: 'Push cannot change price' },
    })).rejects.toThrow();
  });
});

describe('config-authoritative policy resolution (WI-38673)', () => {
  const configPolicy: CopilotPolicy = {
    automationLevel: 'confirm',
    allowAutoActions: false,
    priceFloorCentsByProduct: { mug: 1_050 },
    maxMarkdownPercent: 30,
    blockedActionKinds: [],
    tone: 'warm',
  };

  it('enforces the resolver policy over the caller-registered policy', async () => {
    const seen: { eventId?: string; items?: readonly { productId: string; priceCents: number }[] } = {};
    const actions = new GuardedActionService({
      resolve: async (eventId, items) => {
        seen.eventId = eventId;
        seen.items = items;
        return configPolicy;
      },
    });
    // The register caller brings a permissive policy: 1-cent floor, no cap.
    // Before WI-38673 this policy governed — an HTTP caller could bring its own.
    actions.registerEvent('event-1', {
      policy: { ...policy, priceFloorCentsByProduct: { mug: 1 }, maxMarkdownPercent: 100 },
      items: [item],
    });

    await expect(actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'markdown', productId: 'mug', priceCents: 900, reason: 'Below the config floor' },
    })).rejects.toThrow('floor');

    // The resolver saw the registered items, so floors derive from verified prices.
    expect(seen.eventId).toBe('event-1');
    expect(seen.items).toEqual([{ productId: 'mug', priceCents: 1_500 }]);

    // A markdown the config policy allows still goes through.
    const applied = await actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'markdown', productId: 'mug', priceCents: 1_100, reason: 'Inside the config floor' },
    });
    expect(applied.state.priceCents).toBe(1_100);
  });

  it('anchors derived floors to the registration price across successive markdowns', async () => {
    const derivedPolicy: CopilotPolicy = {
      ...policy,
      priceFloorCentsByProduct: {},
      maxMarkdownPercent: 30,
    };
    const resolvedPrices: number[] = [];
    const actions = new GuardedActionService({
      resolve: async (_eventId, items) => {
        resolvedPrices.push(items[0]?.priceCents ?? -1);
        return withDerivedPriceFloors(derivedPolicy, items);
      },
    });
    actions.registerEvent('event-1', {
      policy: derivedPolicy,
      items: [{ ...item, priceCents: 10_000 }],
    });

    await actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'markdown', productId: 'mug', priceCents: 7_500, reason: 'First 25% markdown' },
    });
    await expect(actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'markdown', productId: 'mug', priceCents: 5_625, reason: 'Second 25% markdown' },
    })).rejects.toThrow('floor');

    expect(actions.listItems('event-1')[0]).toMatchObject({
      referencePriceCents: 10_000,
      priceCents: 7_500,
    });
    expect(resolvedPrices).toEqual([10_000, 10_000]);
  });

  it('falls back to the registered policy when no resolver is wired (rehearsal path)', async () => {
    const actions = new GuardedActionService();
    actions.registerEvent('event-1', { policy, items: [item] });
    const applied = await actions.apply({
      eventId: 'event-1',
      actorId: 'seller-1',
      action: { kind: 'markdown', productId: 'mug', priceCents: 1_250, reason: 'Registered policy governs' },
    });
    expect(applied.state.priceCents).toBe(1_250);
  });
});
