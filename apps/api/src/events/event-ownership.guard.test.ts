import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ChatService } from '../chat/chat.service';
import { EventOwnershipGuard } from './event-ownership.guard';
import { EventService, InMemoryEventStore } from './event.service';

function guard(): EventOwnershipGuard {
  return new EventOwnershipGuard(new EventService(
    new InMemoryEventStore([{
      eventId: 'alpha-event',
      title: 'Alpha event',
      sellerId: 'seller-alpha',
      sellerName: 'Alpha',
      status: 'scheduled',
      startsAt: null,
      endedAt: null,
    }]),
    new ChatService(),
  ));
}

describe('EventOwnershipGuard', () => {
  it('derives the seller role from the canonical demo principal', async () => {
    await expect(guard().requireOwned('alpha-event', 'buyer-alpha')).resolves.toMatchObject({
      sellerId: 'seller-alpha',
      event: { eventId: 'alpha-event' },
    });
  });

  it('rejects a missing principal before reading private data', async () => {
    await expect(guard().requireOwned('alpha-event', undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('collapses foreign, absent, and missing secondary event ids', async () => {
    const ownership = guard();
    const capture = async (eventId: unknown): Promise<unknown> => {
      try {
        await ownership.requireOwnedForSeller(eventId, 'seller-other');
        expect.unreachable('expected owner check to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundException);
        return (error as NotFoundException).getResponse();
      }
    };

    const foreign = await capture('alpha-event');
    expect(await capture('missing-event')).toEqual(foreign);
    expect(await capture(undefined)).toEqual(foreign);
  });
});
