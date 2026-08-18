/**
 * Phase 2 of the Zero/REST parity harness: PER-QUERY DIFFERENTIAL comparison —
 * WI-39867, gating plan Decision D-023 (sidestage-websocket-sync-cutover-2026-08-17)
 * on the WS rung's return.
 *
 * ## The gap this closes, stated precisely
 *
 * Every guard that existed before this file compares NAME SETS.
 * `zero-contract.parity.test.ts` proves each `SyncQueryRegistry` registration is
 * either a Zero leaf or carries an `UNSYNCED_QUERY_REASONS` entry, and it walks
 * `apps/web` so a call site cannot name a query with no leaf (WI-39763).
 * `surfaces.ts` cross-checks the contract's principal against the census's
 * audience tags. None of that can see the failure that actually reached users:
 * **a name present on BOTH transports whose ROWS DISAGREE.**
 *
 * It shipped twice, and neither instance was visible to a name-set check:
 *
 *   1. `catalog.page` — one name, two contracts (`{q,productType,availability,
 *      page,pageSize}` -> a `CatalogPage` ENVELOPE, versus `{region,limit}` ->
 *      bare `storefrontProduct` rows). Blank buyer runway on prod (WI-39855).
 *   2. `events.guide` / `events.mine` — SERVER-COMPUTED fields the Zero schema
 *      has no column for and ZQL cannot derive: `viewers` (live chat presence),
 *      `playbackUrl` (composed from runtime config), `withheldFromGuide` (a
 *      policy verdict). The WS rung served rows with `viewers` UNDEFINED, which
 *      `formatViewers` rendered as a confident "0 watching" beside a correct
 *      "2 watching" from `event.stats` — WI-39839 symptom 3.
 *
 * Generalized (fact `sidestage-synced-queries-lie-about-server-computed-fields`):
 * a server-computed field is underivable in ZQL, so any query returning one can
 * never be a faithful Zero leaf — and **a key present on the REST row and absent
 * on the Zero row is the exact signature of the whole class.**
 * `keysMissingOnZero` below is therefore the finding this file exists to produce.
 *
 * ## Why the fixtures live in THIS module and not in the integration test
 *
 * The comparison itself needs a seeded database, so it can only run under
 * `SIDESTAGE_PG_INTEGRATION=1`. But the most likely future regression is not a
 * subtle row mismatch — it is somebody adding a synced query and never giving it
 * a fixture, so the differential silently never covers it. That failure must be
 * caught by the DEFAULT suite, which has no database.
 *
 * Splitting the fixture TABLE (pure data) from the fixture RUN (needs Postgres)
 * is what makes that possible: `missingFixtures()` is a total function over the
 * contract and is asserted by `differential.test.ts`, which runs on every
 * `npm test`. A new synced query with a REST registration and no fixture fails
 * the ordinary suite immediately, rather than being quietly skipped by an
 * opt-in run nobody armed.
 */
import { SYNCED_QUERY_PRINCIPAL_SCOPE, type SyncedQueryName } from '@papercusp/sidestage-zero';

/**
 * Identifiers the integration seed creates. Fixtures are FUNCTIONS of these
 * rather than literals so the seed can use per-run unique ids — two concurrent
 * runs (or a re-run after a failed cleanup) must never collide on a shared
 * `event-live`-style constant, and a fixture pinned to whatever rows happen to
 * be in the developer's database is not a measurement.
 */
export type ParitySeedRefs = {
  eventId: string;
  eventItemId: string;
  productId: string;
  sellerId: string;
  cartId: string;
};

export type ParityFixture = {
  /**
   * The args handed to BOTH rungs. Identical by construction — a differential
   * that let the two sides take different args would be measuring the fixture,
   * not the transports.
   */
  args: (refs: ParitySeedRefs) => Record<string, unknown>;
  /**
   * The principal the REST rung resolves as, and the `userID` the Zero rung
   * builds its query context with. `null` is a real value (public queries).
   */
  principal: (refs: ParitySeedRefs) => string | null;
  /**
   * Rows the seed GUARANTEES this query returns. Load-bearing: a key-set
   * comparison over two empty result sets is vacuous — it "passes" while
   * proving nothing, which is precisely how a silently-broken query would slip
   * through a harness built to catch it. `minRows: 1` or more makes
   * non-emptiness an assertion rather than an assumption.
   */
  minRows: number;
  /**
   * Set when the Zero leaf ends in `.one()`. Zero then resolves to a single
   * row (or `undefined`), while the REST rung is contractually an array —
   * `SyncQueryRegistry.resolve` throws otherwise. That asymmetry is expected
   * and is normalized before comparison; what is NOT expected is a `.one()`
   * leaf standing in for a REST result that legitimately has several rows,
   * which is WI-39855 leg c and is reported as a cardinality finding.
   */
  zeroReturnsOne?: boolean;
};

/**
 * Args + principal for every synced query that ALSO has a REST registration.
 *
 * Deliberately hand-authored: the two rungs' arg shapes are exactly what drifted
 * in WI-39855, so deriving args from one side would let that side define
 * correctness and hide the drift this harness exists to find. Each entry is the
 * args a real client sends.
 */
export const PARITY_FIXTURES: Readonly<Record<string, ParityFixture>> = {
  'event.config': {
    args: (r) => ({ eventId: r.eventId }),
    principal: (r) => r.sellerId,
    minRows: 1,
    zeroReturnsOne: true,
  },
  'event.runOfShow': {
    args: (r) => ({ eventId: r.eventId }),
    principal: (r) => r.sellerId,
    minRows: 1,
    zeroReturnsOne: true,
  },
  'event.lineup.items': {
    args: (r) => ({ eventId: r.eventId }),
    principal: () => null,
    minRows: 2,
  },
  'event.actions.items': {
    args: (r) => ({ eventId: r.eventId }),
    principal: (r) => r.sellerId,
    minRows: 2,
  },
  'event.auction.active': {
    args: (r) => ({ eventId: r.eventId }),
    principal: () => null,
    minRows: 1,
    zeroReturnsOne: true,
  },
  'event.chat.messages': {
    args: (r) => ({ eventId: r.eventId }),
    principal: () => null,
    minRows: 2,
  },
  'event.chat.presence': {
    args: (r) => ({ eventId: r.eventId }),
    principal: () => null,
    minRows: 2,
  },
  'event.chat.transcript': {
    args: (r) => ({ eventId: r.eventId }),
    principal: () => null,
    minRows: 2,
  },
  'event.replay.chapters': {
    // minRows 1, not 2: the REST rung DERIVES chapters from transcript moments
    // and may merge several into one, so its row count is deliberately not 1:1
    // with the seeded moments. The Zero leaf reads the moment rows straight, so
    // the resulting count difference is a genuine cardinality finding — this
    // floor only stops the seed's own expectation from being reported as drift.
    args: (r) => ({ eventId: r.eventId }),
    principal: () => null,
    minRows: 1,
  },
  'event.copilot.proposals': {
    args: (r) => ({ eventId: r.eventId }),
    principal: (r) => r.sellerId,
    minRows: 1,
  },
  'cart.byId': {
    args: (r) => ({ cartId: r.cartId }),
    principal: (r) => `buyer-${r.cartId}`,
    minRows: 1,
    zeroReturnsOne: true,
  },
};

/**
 * The set this harness can actually diff: a synced query with a live REST
 * registration to diff it AGAINST.
 *
 * `registeredNames` must come from a bootstrapped `SyncQueryRegistry`, never a
 * hand-kept list — the point is that a query appearing on both transports is
 * discovered, not remembered. Synced names with no REST registration (the
 * `CONTRACT_AHEAD_OF_REGISTRY` forward scope) are correctly excluded: there is
 * no second implementation to disagree with.
 */
export function comparableQueryNames(registeredNames: Iterable<string>): SyncedQueryName[] {
  const registered = new Set(registeredNames);
  return (Object.keys(SYNCED_QUERY_PRINCIPAL_SCOPE) as SyncedQueryName[]).filter((name) =>
    registered.has(name),
  );
}

/**
 * Comparable queries with no fixture — i.e. the ones this harness would
 * silently not cover. Asserted EMPTY by the always-on unit suite, so adding a
 * synced query without a fixture fails immediately instead of quietly shrinking
 * the differential's coverage.
 */
export function missingFixtures(registeredNames: Iterable<string>): string[] {
  return comparableQueryNames(registeredNames).filter((name) => !(name in PARITY_FIXTURES));
}

/**
 * Fixtures naming a query that is no longer both synced and registered — dead
 * entries that would otherwise sit here looking like coverage. Also asserted
 * empty, so a query leaving the contract cleans up after itself.
 */
export function staleFixtures(registeredNames: Iterable<string>): string[] {
  const comparable = new Set<string>(comparableQueryNames(registeredNames));
  return Object.keys(PARITY_FIXTURES).filter((name) => !comparable.has(name));
}

export type ShapeDiff = {
  queryName: string;
  restRowCount: number;
  zeroRowCount: number;
  /** Zero returned a bare row rather than an array — a `.one()` leaf. */
  zeroWasSingular: boolean;
  /** Rows actually compared field-by-field. */
  comparedRows: number;
  /**
   * TRUE when neither rung returned anything. The comparison is then
   * information-free and must NOT be reported as parity — see `minRows`.
   */
  vacuous: boolean;
  /** Keys on REST rows that never appear on a Zero row — THE class signature. */
  keysMissingOnZero: string[];
  /** Keys on Zero rows that never appear on a REST row. */
  keysMissingOnRest: string[];
  /** Human-readable findings; EMPTY means the two rungs agree. */
  findings: string[];
};

/** Deep-canonicalize (recursively sort keys) so key ORDER never counts as drift. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

function isRow(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Union of own enumerable keys across every row-shaped entry. */
function keyUnion(rows: readonly unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (isRow(row)) for (const key of Object.keys(row)) keys.add(key);
  }
  return keys;
}

/**
 * Normalize a Zero result to an array. `.one()` yields a bare row or
 * `undefined`; `undefined` is ZERO rows, not one undefined row — collapsing
 * that distinction would let a missing row read as a present-but-empty one.
 */
function normalizeZeroRows(zeroResult: unknown): { rows: unknown[]; singular: boolean } {
  if (Array.isArray(zeroResult)) return { rows: zeroResult, singular: false };
  if (zeroResult === undefined || zeroResult === null) return { rows: [], singular: true };
  return { rows: [zeroResult], singular: true };
}

/**
 * Candidate row-identity keys, most specific first. `eventId` is deliberately
 * ABSENT: it is the FILTER every one of these queries is scoped by, so it holds
 * the same value on every row. Treating it as an identity silently collapses a
 * whole result set onto one key — measured on `event.chat.presence`, where both
 * rungs returned 2 rows and the pairing compared 0 of them while reporting no
 * mismatch. A key that identifies nothing is worse than no key, because the
 * resulting "no findings" reads as parity.
 */
const IDENTITY_KEYS = ['id', 'eventItemId', 'userId', 'productId'] as const;

/**
 * Pair rows across the two rungs. The rungs order independently, so positional
 * pairing would manufacture value mismatches out of a mere ordering difference —
 * but an identity key is only usable if it actually identifies. A key qualifies
 * only when it is present on EVERY row of BOTH sides and its values are UNIQUE
 * within each side; otherwise we fall back to positional pairing, which is the
 * honest answer for rows with no identity.
 */
function pairRows(
  restRows: readonly unknown[],
  zeroRows: readonly unknown[],
): { rest: unknown; zero: unknown; label: string }[] {
  const usableIdentity = (key: string): boolean => {
    const values = (rows: readonly unknown[]) =>
      rows.map((row) => (isRow(row) ? row[key] : undefined));
    for (const side of [restRows, zeroRows]) {
      const side_values = values(side);
      const scalar = side_values.filter((v) => typeof v === 'string' || typeof v === 'number');
      if (scalar.length !== side.length) return false;
      if (new Set(scalar.map(String)).size !== side.length) return false;
    }
    return true;
  };

  const key = IDENTITY_KEYS.find((candidate) => usableIdentity(candidate));

  if (key) {
    const zeroByKey = new Map(
      zeroRows.map((row) => [String((row as Record<string, unknown>)[key]), row]),
    );
    return restRows.flatMap((rest) => {
      const id = String((rest as Record<string, unknown>)[key]);
      return zeroByKey.has(id) ? [{ rest, zero: zeroByKey.get(id), label: `${key}=${id}` }] : [];
    });
  }

  const shared = Math.min(restRows.length, zeroRows.length);
  return Array.from({ length: shared }, (_, i) => ({
    rest: restRows[i],
    zero: zeroRows[i],
    label: `row[${i}]`,
  }));
}

/**
 * Compare one query's two answers on the three axes WI-39867 names:
 * (a) row KEY SETS, (b) cardinality, (c) value equality on the shared keys.
 *
 * Values are compared only on keys BOTH sides carry; a key one side is missing
 * entirely is a key-set finding, and reporting it a second time as a value
 * mismatch would bury the real signal under noise.
 */
export function diffQueryShape(input: {
  queryName: string;
  restRows: readonly unknown[];
  zeroResult: unknown;
  minRows: number;
  zeroReturnsOne?: boolean;
}): ShapeDiff {
  const { queryName, restRows, minRows } = input;
  const { rows: zeroRows, singular } = normalizeZeroRows(input.zeroResult);
  const findings: string[] = [];

  // (0) Non-vacuity. A harness that reports parity from two empty result sets
  // is worse than no harness: it produces a green verdict from no evidence.
  const vacuous = restRows.length === 0 && zeroRows.length === 0;
  if (vacuous) {
    findings.push(
      `VACUOUS: both rungs returned 0 rows, so nothing was actually compared. ` +
        `The seed guarantees at least ${minRows} row(s) — either the seed did not land or both rungs are broken.`,
    );
  }
  if (restRows.length < minRows) {
    findings.push(
      `REST returned ${restRows.length} row(s), fewer than the ${minRows} the seed guarantees — ` +
        `the REST rung lost seeded data (or the seed is wrong; check the seed before blaming the rung).`,
    );
  }
  if (zeroRows.length < minRows) {
    findings.push(
      `Zero returned ${zeroRows.length} row(s), fewer than the ${minRows} the seed guarantees — ` +
        `the Zero rung lost seeded data.`,
    );
  }

  // (b) Cardinality. A `.one()` leaf standing in for a multi-row REST result
  // silently shows the client ONE of several rows (WI-39855 leg c).
  if (singular && restRows.length > 1) {
    findings.push(
      `cardinality: the Zero leaf is singular (.one()) but REST returned ${restRows.length} rows — ` +
        `the WS rung would serve only one of them.`,
    );
  }
  if (!singular && input.zeroReturnsOne) {
    findings.push(
      `cardinality: fixture declares zeroReturnsOne but the Zero leaf returned an array — the fixture is stale.`,
    );
  }
  if (restRows.length !== zeroRows.length) {
    findings.push(`row count: REST=${restRows.length} Zero=${zeroRows.length}`);
  }

  // (a) Key sets. `keysMissingOnZero` is the WI-39839 / WI-39855 signature.
  const restKeys = keyUnion(restRows);
  const zeroKeys = keyUnion(zeroRows);
  const keysMissingOnZero = [...restKeys].filter((k) => !zeroKeys.has(k)).sort();
  const keysMissingOnRest = [...zeroKeys].filter((k) => !restKeys.has(k)).sort();

  if (keysMissingOnZero.length > 0) {
    findings.push(
      `SERVER-COMPUTED FIELD DROPPED — keys present on REST rows and absent from Zero rows: ` +
        `${keysMissingOnZero.join(', ')}. This is the exact signature of WI-39839/WI-39855: a field ZQL ` +
        `cannot derive, served as undefined by the WS rung. Either the field is derivable and the leaf ` +
        `must select it, or the query is not Zero-able and belongs in UNSYNCED_QUERY_REASONS.`,
    );
  }
  if (keysMissingOnRest.length > 0) {
    findings.push(
      `keys present on Zero rows and absent from REST rows: ${keysMissingOnRest.join(', ')} — ` +
        `the WS rung would serve fields the REST rung never does.`,
    );
  }

  // (c) Value equality, on the keys both sides actually carry.
  const sharedKeys = [...restKeys].filter((k) => zeroKeys.has(k)).sort();
  const pairs = pairRows(restRows, zeroRows);

  // Structural guard on the comparison itself. Both rungs returning rows while
  // NOTHING got paired means the values were never compared — and with no
  // finding to show for it that reads as parity. This is not hypothetical: an
  // earlier revision keyed on `eventId` (constant across a result set) and
  // compared 0 of `event.chat.presence`'s 2+2 rows in exactly this silence.
  if (restRows.length > 0 && zeroRows.length > 0 && pairs.length === 0) {
    findings.push(
      `NOTHING COMPARED: REST returned ${restRows.length} row(s) and Zero ${zeroRows.length}, but no row ` +
        `could be paired — the two rungs share no usable identity key, so value equality was never checked. ` +
        `Treat this as unverified, never as parity.`,
    );
  }
  for (const { rest, zero, label } of pairs) {
    if (!isRow(rest) || !isRow(zero)) {
      const a = JSON.stringify(canonicalize(rest));
      const b = JSON.stringify(canonicalize(zero));
      if (a !== b) findings.push(`${label}: non-row values differ REST=${a} Zero=${b}`);
      continue;
    }
    for (const key of sharedKeys) {
      if (!(key in rest) || !(key in zero)) continue;
      const a = JSON.stringify(canonicalize(rest[key]));
      const b = JSON.stringify(canonicalize(zero[key]));
      if (a !== b) findings.push(`${label}.${key}: REST=${a} Zero=${b}`);
    }
  }

  return {
    queryName,
    restRowCount: restRows.length,
    zeroRowCount: zeroRows.length,
    zeroWasSingular: singular,
    comparedRows: pairs.length,
    vacuous,
    keysMissingOnZero,
    keysMissingOnRest,
    findings,
  };
}

/** One-line report for a diff, for test output that names the query. */
export function formatShapeDiff(diff: ShapeDiff): string {
  const head = `${diff.queryName} (REST=${diff.restRowCount} Zero=${diff.zeroRowCount}, compared ${diff.comparedRows})`;
  return diff.findings.length === 0
    ? `${head}: parity`
    : `${head}:\n${diff.findings.map((f) => `    - ${f}`).join('\n')}`;
}
