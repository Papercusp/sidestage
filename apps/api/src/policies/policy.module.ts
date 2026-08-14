import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { EventModule } from '../events/event.module';
import { PolicyController } from './policy.controller';
import {
  InMemoryPolicyStore,
  PgPolicyStore,
  POLICY_STORE,
  PolicyService,
  PROVIDER_CAPABILITIES,
} from './policy.service';
import type { ProviderCapabilities } from './policy.types';

/**
 * Provider capabilities are resolved server-side (never from the client). The
 * demo build configures card + wallet rails and the baseline 12-month warranty
 * capability; a real deployment would read provider state.
 */
export const DEMO_CAPABILITIES: ProviderCapabilities = {
  configuredPaymentMethods: ['card', 'wallet'],
  extendedWarrantyMonths: 12,
};

@Module({
  imports: [DatabaseModule, EventModule],
  controllers: [PolicyController],
  providers: [
    PolicyService,
    { provide: PROVIDER_CAPABILITIES, useValue: DEMO_CAPABILITIES },
    {
      provide: POLICY_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgPolicyStore(pool) : new InMemoryPolicyStore()),
    },
  ],
  exports: [PolicyService],
})
export class PolicyModule {}
