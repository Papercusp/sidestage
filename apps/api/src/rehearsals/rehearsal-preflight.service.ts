import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { GuardedActionService } from '../actions/action.service';
import { EventConfigService } from '../config/event-config.service';
import { EVENT_POLICY_RESOLVER, type EventPolicyResolver } from '../config/event-policy-resolver';
import { PG_POOL } from '../db/database.module';
import { buildPreflightReport, probeDurability, type PreflightReport } from './preflight';

/** Shared server-side preflight used by both REST and the named sync query. */
@Injectable()
export class RehearsalPreflightService {
  constructor(
    @Inject(EventConfigService) private readonly configs: EventConfigService,
    @Inject(GuardedActionService) private readonly actions: GuardedActionService,
    @Inject(EVENT_POLICY_RESOLVER) private readonly policyResolver: EventPolicyResolver,
    @Inject(PG_POOL) private readonly pool: Pool | null,
  ) {}

  async read(eventId: string): Promise<PreflightReport> {
    const config = await this.configs.get(eventId);
    // Probe on every read. A non-null pool only proves Postgres answered when
    // the API booted, which may have been hours before this preflight.
    const durability = await probeDurability(this.pool);
    const items = (await this.actions.listItems(eventId))
      .map((item) => ({
        productId: item.productId,
        priceCents: item.referencePriceCents ?? item.priceCents,
      }));
    return buildPreflightReport({
      eventId: config.eventId,
      config,
      policy: await this.policyResolver.resolve(eventId, items),
      durability,
    });
  }
}
