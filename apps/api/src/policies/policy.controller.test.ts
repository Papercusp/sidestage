import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ChatService } from '../chat/chat.service';
import { EventService, InMemoryEventStore, type EventRecord } from '../events/event.service';
import { baselinePolicyBody } from './policy-rules';
import { PolicyController } from './policy.controller';
import {
  InMemoryPolicyStore,
  PolicyError,
  PolicyService,
  type RequestContext,
} from './policy.service';
import type { ProviderCapabilities } from './policy.types';

const EVENTS: EventRecord[] = [
  {
    eventId: 'alpha-event',
    title: 'Alpha event',
    sellerId: 'seller-alpha',
    sellerName: 'Alpha',
    status: 'scheduled',
    startsAt: null,
    endedAt: null,
  },
  {
    eventId: 'beta-event',
    title: 'Beta event',
    sellerId: 'seller-beta',
    sellerName: 'Beta',
    status: 'scheduled',
    startsAt: null,
    endedAt: null,
  },
];

const CAPS: ProviderCapabilities = {
  configuredPaymentMethods: ['card', 'wallet'],
  extendedWarrantyMonths: 12,
};

function build() {
  const policies = new PolicyService(new InMemoryPolicyStore(), CAPS);
  const events = new EventService(new InMemoryEventStore(EVENTS.map((event) => ({ ...event }))), new ChatService());
  return { controller: new PolicyController(policies, events), policies };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    expect.unreachable('expected request to be rejected');
  } catch (error) {
    return error;
  }
}

describe('PolicyController seller ownership boundary (P-003)', () => {
  it('derives authority only from x-demo-principal and ignores a forged x-seller-id', async () => {
    const { controller } = build();
    const headers = {
      'x-demo-principal': 'seller-alpha',
      'x-seller-id': 'seller-beta',
      'x-request-id': 'req-forged-seller',
    };

    const foreign = await rejected(controller.effective('beta-event', headers));
    const absent = await rejected(controller.effective('missing-event', headers));

    expect(foreign).toBeInstanceOf(NotFoundException);
    expect(absent).toBeInstanceOf(NotFoundException);
    expect((foreign as NotFoundException).getResponse()).toEqual(
      (absent as NotFoundException).getResponse(),
    );
  });

  it('returns the same not-found contract for foreign and absent policy revision ids', async () => {
    const { controller, policies } = build();
    const seedContext: RequestContext = {
      requestId: 'req-seed',
      correlationId: 'req-seed',
      actorType: 'seller',
      actorId: 'seller-beta',
    };
    const betaRevision = await policies.createDraft(
      'seller-beta',
      { eventId: 'beta-event', body: baselinePolicyBody() },
      seedContext,
      'seed-beta-revision',
    );
    const headers = {
      'x-demo-principal': 'seller-alpha',
      'x-request-id': 'req-revision-probe',
    };

    const foreign = await rejected(controller.get(betaRevision.id, headers));
    const absent = await rejected(controller.get('missing-revision', headers));

    expect(foreign).toBeInstanceOf(PolicyError);
    expect(absent).toBeInstanceOf(PolicyError);
    expect((foreign as PolicyError).getStatus()).toBe(404);
    expect((absent as PolicyError).getStatus()).toBe(404);
    expect((foreign as PolicyError).getResponse()).toEqual(
      (absent as PolicyError).getResponse(),
    );
  });
});
