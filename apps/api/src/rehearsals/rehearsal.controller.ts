import { BadRequestException, Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/database.module';
import { GuardedActionService } from '../actions/action.service';
import { EventConfigService } from '../config/event-config.service';
import { EVENT_POLICY_RESOLVER, type EventPolicyResolver } from '../config/event-policy-resolver';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import {
  buildPreflightReport,
  CLIENT_REALTIME_PROBE_EVENT,
  createClientRealtimeProbeReceipt,
  probeDurability,
  type ClientClockReceipt,
  type ClientRealtimeProbeReceipt,
  type PreflightReport,
} from './preflight';
import { RehearsalService } from './rehearsal.service';
import { REHEARSAL_KINDS, type DressRehearsalVerdict, type RehearsalKind, type RehearsalReport } from './rehearsal.types';

function readKind(value: string): RehearsalKind {
  if ((REHEARSAL_KINDS as readonly string[]).includes(value)) return value as RehearsalKind;
  throw new BadRequestException(`Unknown rehearsal "${value}". Expected one of: ${REHEARSAL_KINDS.join(', ')}.`);
}

function readProbeNonce(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(value)) {
    throw new BadRequestException('Realtime probe nonce must be 8–128 URL-safe characters.');
  }
  return value;
}

@Controller('rehearsals')
export class RehearsalController {
  constructor(
    @Inject(RehearsalService) private readonly rehearsals: RehearsalService,
    @Inject(EventConfigService) private readonly configs: EventConfigService,
    @Inject(GuardedActionService) private readonly actions: GuardedActionService,
    @Inject(EVENT_POLICY_RESOLVER) private readonly policyResolver: EventPolicyResolver,
    @Inject(PG_POOL) private readonly pool: Pool | null,
    @Inject(SyncInvalidationService) private readonly invalidations: SyncInvalidationService,
  ) {}

  /** The server-side half of preflight: what the browser cannot honestly measure. */
  @Get('preflight/:eventId')
  async preflight(@Param('eventId') eventId: string): Promise<PreflightReport> {
    const config = await this.configs.get(eventId);
    // Probe on every request. `this.pool !== null` would only tell us Postgres
    // was up when the API booted, which may have been hours before the host
    // opened this screen.
    const durability = await probeDurability(this.pool);
    // Lint the policy the guard will actually enforce (WI-38673): the same
    // resolver GuardedActionService uses, fed the event's registered items so
    // derived floors read as ready instead of a stale "no floor" blocker.
    const items = this.actions.listItems(eventId)
      .map((item) => ({ productId: item.productId, priceCents: item.priceCents }));
    return buildPreflightReport({
      eventId: config.eventId,
      config,
      policy: await this.policyResolver.resolve(eventId, items),
      durability,
    });
  }

  /** Timestamped independently so a browser can estimate its clock offset. */
  @Get('client-clock')
  clientClock(): ClientClockReceipt {
    return { serverTimeMs: Date.now() };
  }

  /**
   * Echo a correlation nonce through the production invalidation/SSE path.
   * The HTTP response alone is not a pass; the browser waits for this exact
   * nonce to return on `/sync/sse` and times that full round trip.
   */
  @Post('client-realtime/:eventId')
  clientRealtime(
    @Param('eventId') eventId: string,
    @Body() body: { nonce?: unknown },
  ): ClientRealtimeProbeReceipt {
    const receipt = createClientRealtimeProbeReceipt(eventId, readProbeNonce(body?.nonce));
    this.invalidations.invalidate(CLIENT_REALTIME_PROBE_EVENT, { ...receipt });
    return receipt;
  }

  /** Everything at once, folded into a single go / no-go verdict. */
  @Post('all')
  runAll(): Promise<DressRehearsalVerdict> {
    return this.rehearsals.runAll();
  }

  @Post(':kind')
  run(@Param('kind') kind: string): Promise<RehearsalReport> {
    return this.rehearsals.run(readKind(kind));
  }
}
