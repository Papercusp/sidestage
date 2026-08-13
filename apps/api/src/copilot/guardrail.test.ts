import { describe, expect, it } from 'vitest';

import { PolicyActionGuard, PolicyReplyGuard } from './guardrail';
import type { CopilotPolicy, GroundingContext } from './copilot.types';

const policy: CopilotPolicy = {
  automationLevel: 'confirm',
  allowAutoActions: false,
  priceFloorCentsByProduct: { 'p-1': 1_000 },
  maxMarkdownPercent: 20,
  blockedActionKinds: [],
  tone: 'warm',
};

const context: GroundingContext = {
  eventItems: [{
    eventItemId: 'ei-1',
    productId: 'p-1',
    title: 'Blue mug',
    priceCents: 1_500,
    availableQty: 2,
    attributes: {},
  }],
  catalogProducts: [],
  policy,
  sources: [],
};

const action = (overrides: Partial<Parameters<PolicyActionGuard['evaluate']>[0]> = {}) => ({
  kind: 'targeted-offer' as const,
  productId: 'p-1',
  buyerId: 'buyer-1',
  quantity: 1,
  priceCents: 1_200,
  reason: 'Approved live-event offer',
  ...overrides,
});

describe('PolicyActionGuard', () => {
  const guard = new PolicyActionGuard();

  it('allows an in-stock offer inside the floor and markdown limit', async () => {
    await expect(guard.evaluate(action(), context)).resolves.toEqual({ allowed: true });
  });

  it('blocks a price below the configured product floor with an explanation', async () => {
    await expect(guard.evaluate(action({ priceCents: 900 }), context)).resolves.toMatchObject({
      allowed: false,
      code: 'price-floor',
      explanation: expect.stringContaining('floor'),
    });
  });

  it('blocks markdowns beyond the event percentage limit', async () => {
    await expect(guard.evaluate(action({ priceCents: 1_000 }), context)).resolves.toMatchObject({
      allowed: false,
      code: 'markdown-limit',
      explanation: expect.stringContaining('exceeds'),
    });
  });

  it('blocks an offer that exceeds verified availableQty', async () => {
    await expect(guard.evaluate(action({ quantity: 3 }), context)).resolves.toMatchObject({
      allowed: false,
      code: 'availability',
      explanation: expect.stringContaining('2 units'),
    });
  });

  it('blocks policy-disabled actions and untargeted offers', async () => {
    await expect(guard.evaluate(action({ buyerId: undefined }), context)).resolves.toMatchObject({
      allowed: false,
      code: 'buyer-target',
    });
    const blockedContext = { ...context, policy: { ...policy, blockedActionKinds: ['targeted-offer'] as const } };
    await expect(guard.evaluate(action(), blockedContext)).resolves.toMatchObject({
      allowed: false,
      code: 'policy',
    });
  });
});

describe('PolicyReplyGuard', () => {
  const guard = new PolicyReplyGuard();

  it('allows a reply when its declared tone matches the event policy', async () => {
    await expect(guard.evaluate({ reply: 'That mug is ready for you.', declaredTone: 'warm' }, context))
      .resolves.toEqual({ allowed: true });
  });

  it('blocks and explains an explicit tone mismatch before send', async () => {
    await expect(guard.evaluate({ reply: 'Proceed with purchase.', declaredTone: 'professional' }, context))
      .resolves.toMatchObject({ allowed: false, code: 'tone', explanation: expect.stringContaining('warm') });
  });
});
