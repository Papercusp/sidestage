import { BadRequestException, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/database.module';
import { EventConfigService, policyFromConfig } from '../config/event-config.service';
import { buildPreflightReport, probeDurability, type PreflightReport } from './preflight';
import { RehearsalService } from './rehearsal.service';
import { REHEARSAL_KINDS, type DressRehearsalVerdict, type RehearsalKind, type RehearsalReport } from './rehearsal.types';

function readKind(value: string): RehearsalKind {
  if ((REHEARSAL_KINDS as readonly string[]).includes(value)) return value as RehearsalKind;
  throw new BadRequestException(`Unknown rehearsal "${value}". Expected one of: ${REHEARSAL_KINDS.join(', ')}.`);
}

@Controller('rehearsals')
export class RehearsalController {
  constructor(
    @Inject(RehearsalService) private readonly rehearsals: RehearsalService,
    @Inject(EventConfigService) private readonly configs: EventConfigService,
    @Inject(PG_POOL) private readonly pool: Pool | null,
  ) {}

  /** The server-side half of preflight: what the browser cannot honestly measure. */
  @Get('preflight/:eventId')
  async preflight(@Param('eventId') eventId: string): Promise<PreflightReport> {
    const config = await this.configs.get(eventId);
    // Probe on every request. `this.pool !== null` would only tell us Postgres
    // was up when the API booted, which may have been hours before the host
    // opened this screen.
    const durability = await probeDurability(this.pool);
    return buildPreflightReport({
      eventId: config.eventId,
      config,
      policy: policyFromConfig(config),
      durability,
    });
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
