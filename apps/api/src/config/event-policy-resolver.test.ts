import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ActionModule } from '../actions/action.module';
import { ChatService } from '../chat/chat.service';
import type { CopilotPolicy } from '../copilot/copilot.types';
import { EventService, InMemoryEventStore } from '../events/event.service';
import type { PolicyService } from '../policies/policy.service';
import { EventConfigModule } from './event-config.module';
import { EventConfigService, InMemoryEventConfigStore, withDerivedPriceFloors } from './event-config.service';
import { ConfigEventPolicyResolver, EVENT_POLICY_RESOLVER } from './event-policy-resolver';

const ITEMS = [
  { productId: 'mug', priceCents: 1_500 },
  { productId: 'poster', priceCents: 900 },
];

const BASE: CopilotPolicy = {
  automationLevel: 'confirm',
  allowAutoActions: false,
  priceFloorCentsByProduct: {},
  maxMarkdownPercent: 30,
  blockedActionKinds: [],
  tone: 'warm',
};

function policyStub(result: { policy: CopilotPolicy } | null): PolicyService {
  return { effectiveCopilotPolicy: async () => result } as unknown as PolicyService;
}

function eventService(): EventService {
  return new EventService(new InMemoryEventStore([{
    eventId: 'event-1',
    title: 'Event 1',
    sellerId: 'seller-alice',
    sellerName: 'Alice',
    status: 'scheduled',
    startsAt: null,
    endedAt: null,
  }]), new ChatService());
}

describe('withDerivedPriceFloors', () => {
  it('derives a floor from the verified price and the markdown cap', () => {
    const floors = withDerivedPriceFloors(BASE, ITEMS).priceFloorCentsByProduct;
    expect(floors.mug).toBe(1_050); // ceil(1500 × 0.7)
    expect(floors.poster).toBe(630); // ceil(900 × 0.7)
  });

  it('keeps an explicit floor over the derived one', () => {
    const policy = { ...BASE, priceFloorCentsByProduct: { mug: 1_200 } };
    expect(withDerivedPriceFloors(policy, ITEMS).priceFloorCentsByProduct.mug).toBe(1_200);
  });

  it('never derives below one cent, even with no cap', () => {
    const policy = { ...BASE, maxMarkdownPercent: 100 };
    expect(withDerivedPriceFloors(policy, ITEMS).priceFloorCentsByProduct.mug).toBe(1);
  });

  it('skips items with no valid verified price', () => {
    const floors = withDerivedPriceFloors(BASE, [{ productId: 'ghost', priceCents: 0 }]).priceFloorCentsByProduct;
    expect(floors.ghost).toBeUndefined();
  });
});

describe('ConfigEventPolicyResolver', () => {
  it('falls back to the guardrail-toggle policy and fills derived floors', async () => {
    const resolver = new ConfigEventPolicyResolver(
      new EventConfigService(new InMemoryEventConfigStore()),
      policyStub(null),
      eventService(),
    );
    const policy = await resolver.resolve('event-1', ITEMS);
    // The default config keeps priceChanges guarded → confirm level, 30% cap.
    expect(policy.automationLevel).toBe('confirm');
    expect(policy.maxMarkdownPercent).toBe(30);
    expect(policy.priceFloorCentsByProduct.mug).toBe(1_050);
    expect(policy.priceFloorCentsByProduct.poster).toBe(630);
  });

  it('preserves the event-default playful tone when no published policy overrides it', async () => {
    const configs = new EventConfigService(new InMemoryEventConfigStore());
    const prepared = await configs.prepare('event-1', { replyTone: 'playful' }, 'seller-alice');
    await configs.persistOwned(prepared, 'seller-alice');
    const resolver = new ConfigEventPolicyResolver(configs, policyStub(null), eventService());

    await expect(resolver.resolve('event-1', ITEMS)).resolves.toMatchObject({ tone: 'playful' });
  });

  it('prefers a published seller policy, with derivation filling unnamed products', async () => {
    const published: CopilotPolicy = {
      automationLevel: 'auto',
      allowAutoActions: true,
      priceFloorCentsByProduct: { mug: 1_400 },
      maxMarkdownPercent: 50,
      blockedActionKinds: [],
      tone: 'concise',
    };
    const resolver = new ConfigEventPolicyResolver(
      new EventConfigService(new InMemoryEventConfigStore()),
      policyStub({ policy: published }),
      eventService(),
    );
    const policy = await resolver.resolve('event-1', ITEMS);
    expect(policy.priceFloorCentsByProduct.mug).toBe(1_400); // explicit floor wins
    expect(policy.priceFloorCentsByProduct.poster).toBe(450); // ceil(900 × 0.5)
    expect(policy.maxMarkdownPercent).toBe(50);
  });
});

/**
 * The registration seam, guarded against dying silently under mocks: assert
 * the real module metadata wires the resolver into the action module's graph
 * (WI-38673). Nest module metadata keys are its stable public decorator keys.
 */
describe('WI-38673 wiring seam', () => {
  it('EventConfigModule provides + exports the resolver token and ActionModule imports the module', () => {
    const providers: unknown[] = Reflect.getMetadata('providers', EventConfigModule) ?? [];
    expect(providers.some((p) => (p as { provide?: unknown })?.provide === EVENT_POLICY_RESOLVER)).toBe(true);
    const exported: unknown[] = Reflect.getMetadata('exports', EventConfigModule) ?? [];
    expect(exported).toContain(EVENT_POLICY_RESOLVER);
    const imports: unknown[] = Reflect.getMetadata('imports', ActionModule) ?? [];
    expect(imports).toContain(EventConfigModule);
  });
});
