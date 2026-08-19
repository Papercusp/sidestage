/**
 * THE per-query differential parity run (WI-39867) — plan Decision D-023 gates
 * the WS rung's return on this passing.
 *
 * For every query that exists on BOTH transports, it resolves the SAME args
 * through BOTH rungs against SEEDED data and compares the answers on the three
 * axes name-set parity is structurally blind to: row key sets, cardinality, and
 * value equality on the shared keys.
 *
 * ## Why it seeds instead of reading whatever is in the database
 *
 * Two reasons, and the second is the important one:
 *
 *   1. Determinism — the developer's database is shared, mutated by other
 *      agents, and has no guaranteed contents.
 *   2. NON-VACUITY. A key-set comparison over two EMPTY result sets passes while
 *      proving nothing. On the box this was written on, `auction_state` had 0
 *      active rows and `chat_presence` had 0 rows — so a harness reading ambient
 *      data would have reported "parity" for `event.auction.active` and
 *      `event.chat.presence` on the strength of `0 === 0`. That is a green
 *      verdict built from no evidence, i.e. exactly the failure this harness
 *      exists to prevent, reproduced inside the harness itself. Seeding makes
 *      every query's row count an ASSERTION (`minRows`) rather than a hope.
 *
 * Every seeded id carries a per-run suffix, so concurrent runs cannot collide
 * and a previous failed run's residue cannot be mistaken for this run's data.
 *
 * ## Gating
 *
 * `SIDESTAGE_PG_INTEGRATION=1`, this repo's existing opt-in for real-Postgres
 * coverage (see `pg-cart-store.test.ts`, and the `DATA_BACKEND: 'memory'`
 * comment in vitest.config.mts explaining why the default suite must stay
 * hermetic). Run it with:
 *
 *   SIDESTAGE_PG_INTEGRATION=1 npm run test:file -- \
 *     apps/api/src/sync/parity/differential.integration.test.ts
 *
 * The COVERAGE guard — "every comparable query has a fixture" — deliberately
 * does NOT live here. It is in `differential.test.ts` and runs on every
 * `npm test`, because a fixture gap must not depend on somebody arming this.
 */
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module';
import { DEFAULT_DATABASE_URL } from '../../db/database.module';
import { SyncQueryRegistry } from '../sync-query.registry';
import { createSseQueryRunner, createZeroQueryRunner } from './harness';
import {
  PARITY_FIXTURES,
  comparableQueryNames,
  diffQueryShape,
  formatShapeDiff,
  type ParitySeedRefs,
  type ShapeDiff,
} from './differential';

const ARMED = process.env.SIDESTAGE_PG_INTEGRATION === '1';

const suffix = randomUUID().slice(0, 8);
const refs: ParitySeedRefs = {
  eventId: `parity-event-${suffix}`,
  eventItemId: `parity-item-${suffix}`,
  productId: `parity-product-${suffix}`,
  // Must NOT match MINTED_DEMO_PERSONA (/^demo-[a-z0-9]{8}$/) — that pattern is
  // rewritten to the legacy shared demo seller by `rolePrincipal`, which would
  // silently point the seller-scoped queries at somebody else's events.
  sellerId: `seller-parity${suffix}`,
  cartId: `parity-cart-${suffix}`,
};

/**
 * Rows this run creates, newest-first so cleanup deletes children before
 * parents. Seeded through raw SQL rather than the services on purpose: the REST
 * services are one of the two subjects under comparison, so seeding through them
 * would let a bug in that rung define what "correct data" is.
 */
async function seed(pool: Pool): Promise<void> {
  const now = new Date();
  const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

  // `status: 'live'` is load-bearing: `assertBuyerVisible` (event.lineup.items,
  // event.chat.transcript) resolves through `listBuyerVisible()`, which excludes
  // drafts — a draft event would make those two queries 404 rather than diff.
  await pool.query(
    `insert into event (event_id, title, seller_id, seller_name, status, starts_at)
     values ($1, $2, $3, $4, 'live', $5)`,
    [refs.eventId, 'Parity harness event', refs.sellerId, 'Parity Seller', iso(-3_600_000)],
  );

  // `event_config.payload` holds the WHOLE `EventConfig` document, not a
  // fragment — `EventConfigService.get` returns the parsed column as-is, so a
  // partial payload makes the REST rung throw on a missing branch rather than
  // produce a comparable row. Mirrors `defaultEventConfig()`.
  await pool.query(`insert into event_config (event_id, payload) values ($1, $2)`, [
    refs.eventId,
    JSON.stringify({
      eventId: refs.eventId,
      name: 'Parity harness config',
      replyTone: 'warm',
      guardrails: { priceChanges: true, inventoryClaims: true, buyerSensitive: true },
      updatedAt: iso(0),
    }),
  ]);

  await pool.query(`insert into event_run_of_show (event_id, payload) values ($1, $2)`, [
    refs.eventId,
    JSON.stringify({ plannedOrder: [refs.eventItemId, `${refs.eventItemId}-b`] }),
  ]);

  await pool.query(
    `insert into product_catalog (group_id, region, product_type, title, description, brand)
     values ($1, 'US', 'mug', $2, 'Parity harness catalog row', 'ParityBrand')`,
    [`${refs.productId}-group`, 'Parity mug'],
  );

  for (const [index, id] of [refs.productId, `${refs.productId}-b`].entries()) {
    await pool.query(
      // `option_signature` must differ per row: the two products deliberately
      // share a seller and a catalog group (so the lineup's `product -> catalog`
      // relation has something to join to), and
      // `storefront_product_seller_group_signature_unique` covers exactly that
      // triple.
      `insert into storefront_product
         (id, slug, region, price_cents, sku, seller_id, group_id, option_signature, qty)
       values ($1, $2, 'US', $3, $4, $5, $6, $7, 10)`,
      [
        id,
        `${id}-slug`,
        1_500 + index * 100,
        `${id}-sku`,
        refs.sellerId,
        `${refs.productId}-group`,
        `parity-${index}`,
      ],
    );
  }

  // Two lineup rows, so a `.one()`-vs-array cardinality drift on the lineup
  // queries is detectable at all — one row would hide it.
  for (const [index, itemId] of [refs.eventItemId, `${refs.eventItemId}-b`].entries()) {
    await pool.query(
      `insert into event_lineup_item
         (event_item_id, event_id, product_id, position, reference_price_cents,
          current_price_cents, listed_quantity, current_quantity, stage_state, title, description)
       values ($1, $2, $3, $4, $5, $6, 5, 5, 'queued', $7, 'Parity harness lineup row')`,
      [
        itemId,
        refs.eventId,
        index === 0 ? refs.productId : `${refs.productId}-b`,
        index,
        2_000,
        1_500 + index * 100,
        `Parity item ${index}`,
      ],
    );
  }

  await pool.query(
    `insert into auction_state
       (id, event_id, event_item_id, product_id, status, quantity, current_price_cents,
        started_at, ends_at, payload, seller_id)
     values ($1, $2, $3, $4, 'active', 1, 1500, $5, $6, $7, $8)`,
    [
      `parity-auction-${suffix}`,
      refs.eventId,
      refs.eventItemId,
      refs.productId,
      iso(-60_000),
      iso(600_000),
      // Same document-store shape as event_config: `PgAuctionStore` returns
      // `row.payload` AS the `Auction`, so the payload must be a complete
      // Auction (an absent `bids` array is what made the REST rung throw
      // "Cannot read properties of undefined (reading 'map')").
      JSON.stringify({
        id: `parity-auction-${suffix}`,
        eventId: refs.eventId,
        eventItemId: refs.eventItemId,
        productId: refs.productId,
        quantity: 1,
        startingPriceCents: 1_500,
        currentPriceCents: 1_500,
        status: 'active',
        allocationState: 'held',
        startedAt: iso(-60_000),
        endsAt: iso(600_000),
        bids: [],
      }),
      refs.sellerId,
    ],
  );

  for (const index of [0, 1]) {
    await pool.query(
      `insert into chat_message (id, event_id, user_id, display_name, role, text, created_at)
       values ($1, $2, $3, $4, 'buyer', $5, $6)`,
      [
        `parity-msg-${suffix}-${index}`,
        refs.eventId,
        `buyer-${refs.cartId}`,
        'Parity Buyer',
        `Parity message ${index}`,
        iso(index * 1_000),
      ],
    );

    await pool.query(
      `insert into chat_presence (event_id, user_id, display_name, role, last_seen_at)
       values ($1, $2, $3, 'buyer', $4)`,
      [refs.eventId, `buyer-presence-${suffix}-${index}`, `Parity Watcher ${index}`, iso(index * 1_000)],
    );

    await pool.query(
      `insert into chat_transcript_moment (id, event_id, text, start_ms, end_ms, product_id, product_title)
       values ($1, $2, $3, $4, $5, $6, 'Parity mug')`,
      [
        `parity-moment-${suffix}-${index}`,
        refs.eventId,
        `Parity transcript moment ${index}`,
        index * 10_000,
        index * 10_000 + 5_000,
        refs.productId,
      ],
    );
  }

  await pool.query(
    `insert into copilot_proposal (id, event_id, source_message_id, status, revision, payload)
     values ($1, $2, $3, 'pending', 1, $4)`,
    [
      `parity-proposal-${suffix}`,
      refs.eventId,
      `parity-msg-${suffix}-0`,
      JSON.stringify({ reply: 'Parity harness proposal', grounding: 'grounded', citations: [] }),
    ],
  );

  // `buyerId` must equal what `rolePrincipal(principal, 'buyer')` yields for the
  // fixture's principal, or `assertCartOwner` 404s and the diff measures the
  // guard instead of the transports.
  await pool.query(`insert into cart (id, payload) values ($1, $2)`, [
    refs.cartId,
    JSON.stringify({
      id: refs.cartId,
      buyerId: `buyer-${refs.cartId}`,
      currency: 'USD',
      items: [],
      subtotalCents: 0,
      updatedAt: iso(0),
      revision: 1,
    }),
  ]);
}

async function cleanup(pool: Pool): Promise<void> {
  const statements: [string, unknown[]][] = [
    ['delete from copilot_proposal where event_id = $1', [refs.eventId]],
    ['delete from chat_transcript_moment where event_id = $1', [refs.eventId]],
    ['delete from chat_presence where event_id = $1', [refs.eventId]],
    ['delete from chat_message where event_id = $1', [refs.eventId]],
    ['delete from auction_state where event_id = $1', [refs.eventId]],
    ['delete from event_lineup_item where event_id = $1', [refs.eventId]],
    ['delete from event_run_of_show where event_id = $1', [refs.eventId]],
    ['delete from event_config where event_id = $1', [refs.eventId]],
    ['delete from cart where id = $1', [refs.cartId]],
    ['delete from storefront_product where group_id = $1', [`${refs.productId}-group`]],
    ['delete from product_catalog where group_id = $1', [`${refs.productId}-group`]],
    ['delete from event where event_id = $1', [refs.eventId]],
  ];
  for (const [sql, params] of statements) {
    // Best-effort: one failed delete must not strand the remaining eleven.
    await pool.query(sql, params).catch(() => undefined);
  }
}

describe.runIf(ARMED)('per-query differential Zero/REST parity', () => {
  let pool: Pool;
  let close: (() => Promise<void>) | undefined;
  const diffs = new Map<string, ShapeDiff>();
  const failures = new Map<string, string>();
  let comparable: string[] = [];

  beforeAll(async () => {
    // The vitest project pins DATA_BACKEND=memory to keep the default suite
    // hermetic. This suite is the deliberate exception, so it must opt back in
    // BEFORE AppModule is compiled — createPoolOrNull() reads it at bootstrap.
    process.env.DATA_BACKEND = 'pg';

    pool = new Pool({
      connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
      // Small on purpose. max_connections here is 100 and is a SHARED, box-wide
      // budget; a leaked dev server exhausting it has already locked every agent
      // out of Postgres once (EI-20739798038041966).
      max: 4,
    });

    await seed(pool);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = await moduleRef.init();
    close = async () => {
      await app.close();
    };

    const registry = moduleRef.get(SyncQueryRegistry);
    const runSse = createSseQueryRunner(registry);
    const runZero = createZeroQueryRunner(pool);

    comparable = comparableQueryNames(
      Object.keys(PARITY_FIXTURES).filter((name) => registry.has(name)),
    );

    for (const name of comparable) {
      const fixture = PARITY_FIXTURES[name];
      const args = fixture.args(refs);
      const principal = fixture.principal(refs);
      try {
        // Sequential, not Promise.all: the pool is capped at 4 and a parallel
        // fan-out over 11 queries would queue anyway while making a connection
        // failure look like a query failure.
        const restRows = await runSse(name, args, principal);
        const zeroResult = await runZero(name, args, principal);
        diffs.set(
          name,
          diffQueryShape({
            queryName: name,
            restRows,
            zeroResult,
            minRows: fixture.minRows,
            zeroReturnsOne: fixture.zeroReturnsOne,
          }),
        );
      } catch (error) {
        // A rung that THREW is a parity failure too, and the message is the
        // finding — swallowing it would turn a broken query into a silent skip.
        failures.set(name, error instanceof Error ? error.message : String(error));
      }
    }
  }, 120_000);

  afterAll(async () => {
    await close?.().catch(() => undefined);
    if (pool) {
      await cleanup(pool);
      await pool.end().catch(() => undefined);
    }
  });

  it('actually ran the differential over the comparable queries', () => {
    // Guards the guard: if the fixture/registry intersection came back empty,
    // every per-query assertion below would vacuously pass.
    //
    // The floor was 8 before D-025 demoted six queries to UNSYNCED_QUERY_REASONS
    // (five payload-jsonb document stores plus the event.replay.chapters derived
    // view), which took the comparable set from 11 to 5 by design. This number
    // therefore tracks the CONTRACT and must be re-derived whenever the synced
    // set changes deliberately — a floor left above the real count is a red that
    // says nothing, which is how a vacuity guard stops being read at all.
    // Current comparable set: event.lineup.items, event.actions.items,
    // event.chat.messages, event.chat.presence, event.chat.transcript.
    expect(comparable.length).toBeGreaterThanOrEqual(5);
    expect(diffs.size + failures.size).toBe(comparable.length);
  });

  it('no rung threw while answering a query the other rung answers', () => {
    expect(Object.fromEntries(failures)).toEqual({});
  });

  it('every comparison had real rows to compare — no vacuous passes', () => {
    const vacuous = [...diffs.values()].filter((d) => d.vacuous).map((d) => d.queryName);
    expect(vacuous).toEqual([]);
  });

  it('NO synced query drops a server-computed field on the Zero rung', () => {
    // The class signature (WI-39839 symptom 3, WI-39855). This is the assertion
    // D-023 gates the WS rung on: a key the REST row carries and the Zero row
    // does not is a field ZQL cannot derive, and the WS rung would serve it
    // undefined — rendering, in the shipped instance, a confident "0 watching".
    const dropped = [...diffs.values()]
      .filter((d) => d.keysMissingOnZero.length > 0)
      .map((d) => `${d.queryName}: ${d.keysMissingOnZero.join(', ')}`);
    expect(dropped).toEqual([]);
  });

  it('the two rungs agree row-for-row on every comparable query', () => {
    const report = [...diffs.values()]
      .filter((d) => d.findings.length > 0)
      .map((d) => formatShapeDiff(d))
      .join('\n');
    expect(report, `\n${report}\n`).toBe('');
  });
});

describe.runIf(!ARMED)('per-query differential Zero/REST parity (not armed)', () => {
  it('is skipped without SIDESTAGE_PG_INTEGRATION=1', () => {
    // A visible marker, so a suite run cannot be mistaken for parity having been
    // verified. The coverage guard in differential.test.ts still runs.
    expect(ARMED).toBe(false);
  });
});
