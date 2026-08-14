import { Controller, Get, Inject } from '@nestjs/common';
import { EventService, type EventSummary } from './event.service';

export interface EventListResponse {
  events: EventSummary[];
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
  constructor(@Inject(EventService) private readonly events: EventService) {}

  @Get()
  async list(): Promise<EventListResponse> {
    return { events: await this.events.listForGuide() };
  }
}
