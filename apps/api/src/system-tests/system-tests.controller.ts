import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Ip,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { SystemTestContractError, type SystemTestActor } from '@papercusp/system-test-contract';
import { SystemTestRunConflictError, SystemTestRunStoreError } from '@papercusp/system-test-runner';
import { AuctionAccessService, auctionHeader } from '../auction/auction-access.service';
import { DEMO_PRINCIPAL_HEADER } from '../sync/sync-request-context';
import { SystemTestsService } from './system-tests.service';

type HeadersMap = Record<string, string | string[] | undefined>;

function cancellationReason(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException({ code: 'SYSTEM_TEST_CANCEL_INVALID', message: 'Cancellation body must be an object.' });
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'reason')) {
    throw new BadRequestException({ code: 'SYSTEM_TEST_CANCEL_INVALID', message: 'Cancellation body contains an unknown field.' });
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 500) {
    throw new BadRequestException({ code: 'SYSTEM_TEST_CANCEL_INVALID', message: 'reason must contain 1–500 characters.' });
  }
  return input.reason;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 25;
  if (!/^\d{1,3}$/.test(value)) {
    throw new BadRequestException({ code: 'SYSTEM_TEST_LIMIT_INVALID', message: 'limit must be an integer from 1 to 100.' });
  }
  const limit = Number(value);
  if (limit < 1 || limit > 100) {
    throw new BadRequestException({ code: 'SYSTEM_TEST_LIMIT_INVALID', message: 'limit must be an integer from 1 to 100.' });
  }
  return limit;
}

@Controller('system-tests')
export class SystemTestsController {
  constructor(
    private readonly systemTests: SystemTestsService,
    private readonly access: AuctionAccessService,
  ) {}

  @Get('catalog')
  catalog(@Headers() headers: HeadersMap, @Ip() ip: string) {
    this.actor(headers, ip, 'catalog');
    return this.systemTests.catalog();
  }

  @Post('runs')
  launch(@Body() body: unknown, @Headers() headers: HeadersMap, @Ip() ip: string) {
    return this.mapErrors(() => {
      const actor = this.actor(headers, ip, 'launch');
      this.access.assertPayloadSize(body, 2_048);
      const key = this.access.requireIdempotencyKey(auctionHeader(headers, 'idempotency-key'));
      return this.systemTests.launch(body, actor, key);
    });
  }

  @Get('runs')
  list(
    @Headers() headers: HeadersMap,
    @Ip() ip: string,
    @Query('limit') limit?: string,
  ) {
    return this.mapErrors(() => this.systemTests.list(this.actor(headers, ip, 'list'), parseLimit(limit)));
  }

  @Get('runs/:runId')
  get(@Param('runId') runId: string, @Headers() headers: HeadersMap, @Ip() ip: string) {
    return this.mapErrors(() => this.systemTests.get(runId, this.actor(headers, ip, 'get')));
  }

  @Post('runs/:runId/cancel')
  cancel(
    @Param('runId') runId: string,
    @Body() body: unknown,
    @Headers() headers: HeadersMap,
    @Ip() ip: string,
  ) {
    return this.mapErrors(() => {
      const actor = this.actor(headers, ip, 'cancel');
      this.access.assertPayloadSize(body, 1_024);
      return this.systemTests.cancel(runId, actor, cancellationReason(body));
    });
  }

  @Post('runs/:runId/retry')
  retry(@Param('runId') runId: string, @Headers() headers: HeadersMap, @Ip() ip: string) {
    return this.mapErrors(() => {
      const actor = this.actor(headers, ip, 'retry');
      const key = this.access.requireIdempotencyKey(auctionHeader(headers, 'idempotency-key'));
      return this.systemTests.retry(runId, actor, key);
    });
  }

  private actor(headers: HeadersMap, ip: string, action: string): SystemTestActor {
    const seller = this.access.requireSellerPrincipal(auctionHeader(headers, DEMO_PRINCIPAL_HEADER));
    this.access.consumeRateLimit(`system-tests-${action}`, seller.sellerId || ip || 'unknown', 60, 60_000);
    return { id: seller.sellerId, role: 'operator' };
  }

  private async mapErrors<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SystemTestContractError) {
        throw new BadRequestException({ code: 'SYSTEM_TEST_REQUEST_INVALID', issues: error.issues });
      }
      if (error instanceof SystemTestRunConflictError) {
        throw new ConflictException({ code: 'SYSTEM_TEST_CONFLICT', message: error.message });
      }
      if (error instanceof SystemTestRunStoreError) {
        throw new BadRequestException({ code: 'SYSTEM_TEST_STORE_REJECTED', message: error.message });
      }
      throw error;
    }
  }
}
