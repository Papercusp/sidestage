import { Module } from '@nestjs/common';
import { ActionModule } from '../actions/action.module';
import { EventConfigModule } from '../config/event-config.module';
import { DatabaseModule } from '../db/database.module';
import { RehearsalController } from './rehearsal.controller';
import { RehearsalService } from './rehearsal.service';

/**
 * The rehearsals deliberately construct their own service instances rather than
 * injecting the live singletons, so a run cannot touch a real event. This
 * module therefore imports only what the PREFLIGHT needs: the saved event
 * config, the policy resolver + the live action service it READS (registered
 * items, for the enforced-policy lint (WI-38673) — never mutated), the database
 * handle it reports the durability of, and the global sync invalidation stream
 * used by the measured client round-trip probe.
 */
@Module({
  imports: [ActionModule, DatabaseModule, EventConfigModule],
  controllers: [RehearsalController],
  providers: [RehearsalService],
  exports: [RehearsalService],
})
export class RehearsalModule {}
