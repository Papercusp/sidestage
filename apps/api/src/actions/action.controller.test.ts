import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ChatService } from '../chat/chat.service';
import type { CopilotPolicy } from '../copilot/copilot.types';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { EventService, InMemoryEventStore } from '../events/event.service';
import { ActionController } from './action.controller';
import { GuardedActionService } from './action.service';
import type { ActionEventItem } from './action.types';

const EVENT_ID = 'alpha-event';

const policy: CopilotPolicy = {
  automationLevel: 'auto',
  allowAutoActions: true,
  priceFloorCentsByProduct: { mug: 1_000 },
  maxMarkdownPercent: 20,
  blockedActionKinds: [],
  tone: 'warm',
};

const item: ActionEventItem = {
  eventId: EVENT_ID,
  eventItemId: `${EVENT_ID}:mug`,
  productId: 'mug',
  title: 'Blue mug',
  priceCents: 1_500,
  availableQty: 5,
  quantity: 5,
  attributes: { color: 'blue' },
};

function runtime() {
  const actions = new GuardedActionService();
  const ownership = new EventOwnershipGuard(new EventService(
    new InMemoryEventStore([{
      eventId: EVENT_ID,
      title: 'Alpha event',
      sellerId: 'seller-alpha',
      sellerName: 'Alpha',
      status: 'live',
      startsAt: null,
      endedAt: null,
    }]),
    new ChatService(),
  ));
  return { actions, controller: new ActionController(actions, ownership) };
}

async function notFoundResponse(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    expect.unreachable('expected the owner check to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(NotFoundException);
    return (error as NotFoundException).getResponse();
  }
}

describe('ActionController event ownership', () => {
  it('rejects every event-id route before a foreign seller can read or mutate it', async () => {
    const { controller } = runtime();

    const foreignCalls = [
      () => controller.register(EVENT_ID, { policy, items: [item] }, 'seller-beta'),
      () => controller.items(EVENT_ID, 'seller-beta'),
      () => controller.audit(EVENT_ID, 'seller-beta'),
      () => controller.execute(EVENT_ID, {
        actorId: 'seller-forged',
        action: {
          kind: 'markdown',
          productId: 'mug',
          priceCents: 1_200,
          reason: 'Foreign markdown',
        },
      }, 'seller-beta'),
    ];

    for (const call of foreignCalls) {
      await expect(call()).rejects.toThrow('Event not found for this seller.');
    }
  });

  it('collapses a foreign audit id and an absent audit id without applying rollback', async () => {
    const { actions, controller } = runtime();
    await controller.register(EVENT_ID, { policy, items: [item] }, 'seller-alpha');
    const executed = await controller.execute(EVENT_ID, {
      actorId: 'seller-forged',
      action: {
        kind: 'markdown',
        productId: 'mug',
        priceCents: 1_200,
        reason: 'Owner markdown',
      },
    }, 'seller-alpha');

    const foreign = await notFoundResponse(() => controller.rollback(
      executed.auditId,
      { actorId: 'seller-forged', reason: 'Foreign rollback' },
      'seller-beta',
    ));
    const absent = await notFoundResponse(() => controller.rollback(
      'missing-audit',
      { actorId: 'seller-forged', reason: 'Missing rollback' },
      'seller-beta',
    ));

    expect(absent).toEqual(foreign);
    const audit = actions.getAudit(executed.auditId);
    expect(audit).toMatchObject({ actorId: 'seller-alpha' });
    expect(audit).not.toHaveProperty('rolledBackAt');
    expect(await actions.listItems(EVENT_ID)).toEqual([
      expect.objectContaining({ productId: 'mug', priceCents: 1_200 }),
    ]);
  });
});
