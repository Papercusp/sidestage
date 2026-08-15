import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EVENT_STORE, type EventStore } from './event.service';

/**
 * Fail-closed access guard for buyer-facing event projections.
 *
 * A published event is visible in the Channel Guide and may expose public
 * room data such as stats, pricing history, and persisted transcript moments.
 * Draft, withdrawn, and unknown event ids deliberately collapse to the same
 * 404 so public projections cannot enumerate seller-private work.
 */
@Injectable()
export class EventVisibilityGuard {
  constructor(@Inject(EVENT_STORE) private readonly events: EventStore) {}

  async assertBuyerVisible(eventId: string): Promise<void> {
    const visible = await this.events.listBuyerVisible();
    if (!visible.some((record) => record.eventId === eventId)) {
      throw new NotFoundException(`Unknown event: ${eventId}`);
    }
  }
}
