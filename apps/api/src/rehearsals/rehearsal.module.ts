import { Module } from '@nestjs/common';
import { EventConfigModule } from '../config/event-config.module';
import { DatabaseModule } from '../db/database.module';
import { RehearsalController } from './rehearsal.controller';
import { RehearsalService } from './rehearsal.service';

/**
 * The rehearsals deliberately construct their own service instances rather than
 * injecting the live singletons, so a run cannot touch a real event. This
 * module therefore imports only what the PREFLIGHT needs: the saved event
 * config, and the database handle it reports the durability of.
 */
@Module({
  imports: [DatabaseModule, EventConfigModule],
  controllers: [RehearsalController],
  providers: [RehearsalService],
  exports: [RehearsalService],
})
export class RehearsalModule {}
