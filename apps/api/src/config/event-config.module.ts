import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { EventConfigController } from './event-config.controller';
import {
  EVENT_CONFIG_STORE,
  EventConfigService,
  InMemoryEventConfigStore,
  PgEventConfigStore,
} from './event-config.service';

@Module({
  imports: [DatabaseModule],
  controllers: [EventConfigController],
  providers: [
    EventConfigService,
    {
      provide: EVENT_CONFIG_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgEventConfigStore(pool) : new InMemoryEventConfigStore()),
    },
  ],
  exports: [EventConfigService],
})
export class EventConfigModule {}
