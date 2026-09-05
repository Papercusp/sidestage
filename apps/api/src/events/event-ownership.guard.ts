import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DEMO_PRINCIPAL_HEADER,
  rolePrincipal,
} from '../sync/sync-request-context';
import { EventService, type EventRecord } from './event.service';

export interface OwnedEventContext {
  sellerId: string;
  event: EventRecord;
}

/**
 * One authorization seam for every seller-private, event-anchored surface.
 *
 * The event directory is the ownership oracle. Missing and foreign event ids
 * intentionally produce the same response so secondary resources cannot be
 * used to enumerate another seller's events.
 */
@Injectable()
export class EventOwnershipGuard {
  constructor(@Inject(EventService) private readonly events: EventService) {}

  sellerId(principal: unknown): string {
    const sellerId = rolePrincipal(principal, 'seller');
    if (!sellerId) {
      throw new UnauthorizedException(
        `${DEMO_PRINCIPAL_HEADER} is required for seller-owned resources.`,
      );
    }
    return sellerId;
  }

  async requireOwned(
    eventId: unknown,
    principal: unknown,
  ): Promise<OwnedEventContext> {
    return this.requireOwnedForSeller(eventId, this.sellerId(principal));
  }

  async requireOwnedForSeller(
    eventId: unknown,
    sellerIdInput: unknown,
  ): Promise<OwnedEventContext> {
    const eventIdValue = typeof eventId === 'string' ? eventId.trim() : '';
    const sellerId = typeof sellerIdInput === 'string' ? sellerIdInput.trim() : '';
    // MUTATION M10 (temporary): seller dropped from the ownership lookup
    const event = eventIdValue && sellerId
      ? await this.events.findById(eventIdValue)
      : undefined;
    if (!event) this.notFound();
    return { sellerId, event };
  }

  notFound(): never {
    throw new NotFoundException('Event not found for this seller.');
  }
}
