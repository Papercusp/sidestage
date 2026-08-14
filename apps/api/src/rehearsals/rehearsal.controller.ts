import { BadRequestException, Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import {
  CLIENT_REALTIME_PROBE_EVENT,
  createClientRealtimeProbeReceipt,
  type ClientClockReceipt,
  type ClientRealtimeProbeReceipt,
  type PreflightReport,
} from './preflight';
import { RehearsalPreflightService } from './rehearsal-preflight.service';
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
    @Inject(RehearsalPreflightService) private readonly preflights: RehearsalPreflightService,
    @Inject(SyncInvalidationService) private readonly invalidations: SyncInvalidationService,
  ) {}

  /** The server-side half of preflight: what the browser cannot honestly measure. */
  @Get('preflight/:eventId')
  preflight(@Param('eventId') eventId: string): Promise<PreflightReport> {
    return this.preflights.read(eventId);
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
