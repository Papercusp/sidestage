import { BadRequestException, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/database.module';
import { EventConfigService, policyFromConfig } from '../config/event-config.service';
import { buildPreflightReport, type PreflightReport } from './preflight';
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
    return buildPreflightReport({
      eventId: config.eventId,
      config,
      policy: policyFromConfig(config),
      hasDatabase: this.pool !== null,
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
