import { Body, Controller, Get, Headers, Inject, Param, Put } from '@nestjs/common';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { DEMO_PRINCIPAL_HEADER } from '../sync/sync-request-context';
import { RunOfShowService, type RunOfShowPlan } from './run-of-show.service';

/**
 * The seller's run of show for one event: planned product order, per-product
 * time budgets, and talking-point notes.
 *
 * Read/write is seller-tooling only in the same sense as event config — the
 * plan is advisory (D-001) and never feeds the action guard, so there is no
 * policy projection here: what the seller saved is exactly what comes back.
 */
@Controller('events')
export class RunOfShowController {
  constructor(
    @Inject(RunOfShowService) private readonly runOfShow: RunOfShowService,
    @Inject(SyncInvalidationService) private readonly invalidations: SyncInvalidationService,
    @Inject(EventOwnershipGuard) private readonly ownership: EventOwnershipGuard,
  ) {}

  @Get(':eventId/run-of-show')
  async get(
    @Param('eventId') eventId: string,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ): Promise<RunOfShowPlan> {
    await this.ownership.requireOwned(eventId, principalHeader);
    return this.runOfShow.get(eventId);
  }

  @Put(':eventId/run-of-show')
  async put(
    @Param('eventId') eventId: string,
    @Body() body: { entries?: unknown },
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ): Promise<RunOfShowPlan> {
    await this.ownership.requireOwned(eventId, principalHeader);
    const plan = await this.runOfShow.save(eventId, body ?? {});
    this.invalidations.invalidate('event.runOfShow', { eventId: plan.eventId });
    return plan;
  }
}
