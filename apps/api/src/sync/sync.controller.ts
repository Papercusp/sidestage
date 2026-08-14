import {
  Body,
  Controller,
  Headers,
  Inject,
  Post,
  Query,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import {
  DEMO_PRINCIPAL_HEADER,
  DEMO_PRINCIPAL_QUERY_PARAM,
  normalizeDemoPrincipal,
} from '@papercusp/sync/principal';
import { filter, interval, map, merge, of, type Observable } from 'rxjs';
import {
  SyncInvalidationService,
  type SyncInvalidation,
} from './sync-invalidation.service';
import {
  SyncQueryRegistry,
  type SyncQueryArgs,
  type SyncRequestContext,
} from './sync-query.registry';

interface SyncQuery {
  name?: unknown;
  args?: unknown;
}

export interface SyncBatchBody {
  queries?: unknown;
}

export interface SyncResult {
  rows: unknown[];
  version: string;
  error?: string;
}

@Controller('sync')
export class SyncController {
  constructor(
    @Inject(SyncQueryRegistry)
    private readonly queries: SyncQueryRegistry,
    @Inject(SyncInvalidationService)
    private readonly invalidations: SyncInvalidationService,
  ) {}

  /** Results remain index-aligned with the incoming query list. */
  @Post('rest-query-batch')
  async restQueryBatch(
    @Body() body: SyncBatchBody,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ): Promise<{ results: SyncResult[] }> {
    const queries = Array.isArray(body?.queries) ? body.queries : [];
    const context = this.requestContext(principalHeader);
    const results = await Promise.all(
      queries.map((query) => this.runQuery(query as SyncQuery, context)),
    );
    return { results };
  }

  @Sse('sse')
  syncEvents(
    @Query('eventId') eventId?: string,
    @Query(DEMO_PRINCIPAL_QUERY_PARAM) principalQuery?: string,
  ): Observable<MessageEvent> {
    const context = this.requestContext(principalQuery);
    const heartbeat = interval(15_000).pipe(map(() => this.heartbeat()));
    const updates = this.invalidations.events().pipe(
      filter((event) => this.matchesEvent(event, eventId, context)),
      map((event): MessageEvent => ({
        id: `invalidate-${event.tsMs}`,
        type: 'invalidate',
        data: JSON.stringify(event),
      })),
    );
    return merge(of(this.heartbeat()), heartbeat, updates);
  }

  private async runQuery(query: SyncQuery, context: SyncRequestContext): Promise<SyncResult> {
    const name = typeof query.name === 'string' ? query.name : '';
    const args = this.readArgs(query.args);
    try {
      return {
        rows: await this.queries.resolve(name, args, context),
        version: String(Date.now()),
      };
    } catch (error) {
      return {
        rows: [],
        version: String(Date.now()),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private readArgs(value: unknown): SyncQueryArgs {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as SyncQueryArgs
      : {};
  }

  private matchesEvent(
    event: SyncInvalidation,
    eventId: string | undefined,
    context: SyncRequestContext,
  ): boolean {
    if (event.principal && event.principal !== context.principal) return false;
    if (!eventId || !event.args) return true;
    const invalidatedEventId = event.args.eventId;
    return typeof invalidatedEventId !== 'string' || invalidatedEventId === eventId;
  }

  private requestContext(value: unknown): SyncRequestContext {
    return { principal: normalizeDemoPrincipal(value) };
  }

  private heartbeat(): MessageEvent {
    const now = Date.now();
    return {
      id: `heartbeat-${now}`,
      type: 'heartbeat',
      data: JSON.stringify({ tsMs: now }),
    };
  }
}
