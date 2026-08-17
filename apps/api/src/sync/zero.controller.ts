/**
 * P-011 (serving lane): the `/zero/query` + `/zero/mutate` handlers zero-cache
 * calls — plan sidestage-websocket-sync-cutover-2026-08-17, WI-39663.
 *
 * These are the two endpoints `libs/zero/src/index.ts` names in its header and
 * that `apps/api/src/sync/parity/harness.ts` was written against. Until this
 * file existed there were NO zero routes at all, so a browser running
 * `syncType="WEBSOCKETS"` had nothing to talk to and stepped down the fallback
 * ladder to SSE (plan D-006).
 *
 * ## The two endpoints are NOT symmetric — this is the thing to understand
 *
 * `/zero/query` is a *transform* endpoint. zero-cache sends a named query plus
 * its args; we resolve that name against the shared `queries` registry and hand
 * back the resulting ZQL AST. zero-cache executes it against its own replica.
 * So this route touches NO database and is correct even when Postgres is
 * unreachable — which is why it does not take the pool.
 *
 * `/zero/mutate` genuinely writes, so it does need a database. It runs the
 * shared `createMutators()` through Zero's `PushProcessor`.
 *
 * ## Why `zeroNodePg` and not the `zeroPostgresJS` pinned in harness.ts
 *
 * harness.ts:130 pins `zeroPostgresJS(schema, pg)`, which needs a *postgres.js*
 * client. This app's DI already provides a live, probed, schema-guarded
 * node-postgres `Pool` (`PG_POOL`, db/database.module.ts). Zero 1.8 ships
 * `zeroNodePg(schema, pg: Pool | string)` from
 * `@rocicorp/zero/server/adapters/pg`, which accepts exactly that Pool — so we
 * reuse the one pool the app already owns instead of opening a second,
 * unsupervised connection pool against the same database with its own limits.
 * Recorded as a plan Decision; harness.ts's comment is corrected to match.
 *
 * ## PG_POOL is nullable and that is load-bearing
 *
 * `createPoolOrNull()` returns null when Postgres is unreachable or
 * DATA_BACKEND=memory. A mutate request in that state must FAIL LOUDLY rather
 * than report a success it never performed — a silently-swallowed write is the
 * exact class of bug the transport-fallback fix (deliverable d) was about.
 */
import {
  Body,
  Controller,
  Headers,
  Inject,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { zeroNodePg } from '@rocicorp/zero/server/adapters/pg';
import {
  PushProcessor,
  handleQueryRequest,
  type QueryRequestHandler,
} from '@rocicorp/zero/server';
import type { MutateResponse, QueryResponse } from '@rocicorp/zero/server';
import { createMutators, queries, schema } from '@papercusp/sidestage-zero';

import { PG_POOL } from '../db/database.module';
import {
  DEMO_PRINCIPAL_HEADER,
  DEMO_PRINCIPAL_QUERY_PARAM,
  normalizeDemoPrincipal,
} from './sync-request-context';

/** A registry leaf: a callable query builder, possibly carrying Zero's derived wire name. */
type QueryLeaf = ((...args: never[]) => unknown) & { queryName?: string };

/**
 * Resolve a dot-path (`'events.mine'`) against the shared query registry.
 *
 * Deliberately the same traversal as `parity/harness.ts:resolveQueryLeaf` —
 * the harness exists to prove this endpoint and the contract agree, so the
 * lookup it verifies has to be the lookup that actually serves.
 */
export function resolveQueryLeaf(path: string): QueryLeaf | undefined {
  let node: unknown = queries;
  for (const key of path.split('.')) {
    if (node === null || (typeof node !== 'object' && typeof node !== 'function')) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'function' ? (node as QueryLeaf) : undefined;
}

@Controller('zero')
export class ZeroController {
  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool | null,
  ) {}

  /**
   * zero-cache resolves named queries here. Pure transformation: no database
   * access, so this answers correctly even with Postgres down.
   */
  @Post('query')
  async query(
    @Body() body: unknown,
    @Query() searchParams: Record<string, string>,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ): Promise<QueryResponse> {
    const principal = normalizeDemoPrincipal(
      principalHeader ?? searchParams?.[DEMO_PRINCIPAL_QUERY_PARAM],
    );
    return handleQueryRequest({
      handler: this.transformQuery,
      schema,
      query: searchParams ?? {},
      body: (body ?? {}) as never,
      userID: principal,
    });
  }

  /** zero-cache pushes mutations here. This one really writes, so it needs the pool. */
  @Post('mutate')
  async mutate(
    @Body() body: unknown,
    @Query() searchParams: Record<string, string>,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ): Promise<MutateResponse> {
    const pool = this.pool;
    if (!pool) {
      // Truthful refusal. Reporting success here would durably lose a write.
      throw new ServiceUnavailableException(
        'Zero mutations require Postgres, but no connection pool is available ' +
          '(DATA_BACKEND=memory, or the database was unreachable at boot). ' +
          'Run: docker compose up -d',
      );
    }
    const principal = normalizeDemoPrincipal(
      principalHeader ?? searchParams?.[DEMO_PRINCIPAL_QUERY_PARAM],
    );
    const processor = new PushProcessor(zeroNodePg(schema, pool), { principal });
    return processor.process(
      createMutators() as never,
      searchParams ?? {},
      (body ?? {}) as never,
    );
  }

  /**
   * Bound method: `handleQueryRequest` invokes this per query in the request.
   * An unknown name throws rather than returning an empty result — a query the
   * contract does not define is a drift bug, and answering it with zero rows
   * would hide that behind a plausible-looking empty list.
   */
  private readonly transformQuery: QueryRequestHandler = (name, args) => {
    const leaf = resolveQueryLeaf(name);
    if (!leaf) {
      throw new Error(
        `Unknown Zero query '${name}' — not defined in @papercusp/sidestage-zero's queries registry.`,
      );
    }
    const build = leaf as (...callArgs: unknown[]) => unknown;
    return (args === undefined ? build() : build(args)) as never;
  };
}
