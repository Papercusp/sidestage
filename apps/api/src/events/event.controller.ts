import { Controller, Delete, Get, Headers, Inject, NotFoundException, Param } from '@nestjs/common';
import { DEFAULT_SELLER_ID } from '../policies/policy.service';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { EventService, type EventRecord, type EventSummary } from './event.service';

export interface EventListResponse {
  events: EventSummary[];
}

export interface SellerEventListResponse {
  events: EventRecord[];
}

/**
 * The event directory read (P-118 / D-019).
 *
 * NOTE on the route prefix: two other controllers already sit on 'events' —
 * EventConfigController (:eventId/config) and StatsController (:eventId/stats).
 * They are per-event reads keyed by an id the caller already holds; this is the
 * collection read, GET /events, and the paths do not collide. Keeping the
 * prefix means a buyer client talks to one resource rather than learning a
 * second noun for the same thing.
 */
@Controller('events')
export class EventController {
  constructor(
    @Inject(EventService) private readonly events: EventService,
    @Inject(SyncInvalidationService) private readonly invalidations: SyncInvalidationService,
  ) {}

  @Get()
  async list(): Promise<EventListResponse> {
    return { events: await this.events.listForGuide() };
  }

  @Get('mine')
  async listMine(
    @Headers('x-seller-id') sellerIdHeader: string | undefined,
  ): Promise<SellerEventListResponse> {
    return { events: await this.events.listForSeller(sellerIdHeader ?? DEFAULT_SELLER_ID) };
  }

  /**
   * Seller teardown is deliberately an unpublish, not a hard delete: buyers
   * stop seeing the event immediately, while event-scoped history remains
   * available for diagnosis and a later config save can publish it again.
   */
  @Delete(':eventId')
  async unpublish(
    @Param('eventId') eventId: string,
    @Headers('x-seller-id') sellerIdHeader: string | undefined,
  ): Promise<{ eventId: string; status: 'draft' }> {
    const sellerId = sellerIdHeader?.trim() || DEFAULT_SELLER_ID;
    const unpublished = await this.events.unpublish(eventId, sellerId);
    if (!unpublished) {
      throw new NotFoundException('Event not found for this seller.');
    }
    this.invalidations.invalidate('events.guide');
    this.invalidations.invalidate('events.mine');
    return { eventId, status: 'draft' };
  }
}
