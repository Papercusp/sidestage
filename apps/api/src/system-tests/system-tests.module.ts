import { Module } from '@nestjs/common';
import type { Pool } from 'pg';

import { PostgresSystemTestRunStore } from '@papercusp/system-test-runner';
import { AuctionModule } from '../auction/auction.module';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { SystemTestsController } from './system-tests.controller';
import { SYSTEM_TEST_RUN_STORE, SystemTestsService } from './system-tests.service';

@Module({
  imports: [DatabaseModule, AuctionModule],
  controllers: [SystemTestsController],
  providers: [
    {
      provide: SYSTEM_TEST_RUN_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PostgresSystemTestRunStore(pool) : null),
    },
    {
      provide: SystemTestsService,
      inject: [SYSTEM_TEST_RUN_STORE],
      useFactory: (store: PostgresSystemTestRunStore | null) => new SystemTestsService(store),
    },
  ],
})
export class SystemTestsModule {}
