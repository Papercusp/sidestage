import { describe, expect, it } from 'vitest';
import { REHEARSAL_RUNNERS, RehearsalService, summarizeDressRehearsal } from './rehearsal.service';
import { InMemoryRehearsalStore } from './rehearsal.store';
import { REHEARSAL_KINDS, type RehearsalReport } from './rehearsal.types';

function report(overrides: Partial<RehearsalReport>): RehearsalReport {
  return {
    runId: 'run_1',
    kind: 'actions',
    title: 'Guarded actions',
    summary: 'ok',
    totalCases: 1,
    passedCases: 1,
    passed: true,
    latencyMs: 5,
    ranAt: new Date(0).toISOString(),
    cases: [{ caseId: 'c1', title: 'A case', expectation: 'must hold', passed: true, observed: 'held' }],
    ...overrides,
  };
}

describe('rehearsal runner registry', () => {
  it('has a runner for every declared kind — and no orphans', () => {
    // A kind added to the type without a runner would 500 at the endpoint.
    expect(Object.keys(REHEARSAL_RUNNERS).sort()).toEqual([...REHEARSAL_KINDS].sort());
  });
});

describe('summarizeDressRehearsal', () => {
  it('is ready only when every case in every report held', () => {
    const verdict = summarizeDressRehearsal([report({}), report({ kind: 'auction' })], () => 1_000);
    expect(verdict.ready).toBe(true);
    expect(verdict.totalCases).toBe(2);
    expect(verdict.passedCases).toBe(2);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.ranAt).toBe(new Date(1_000).toISOString());
  });

  it('flattens failures from every rehearsal into one traceable blocker list', () => {
    const verdict = summarizeDressRehearsal([
      report({}),
      report({
        kind: 'checkout',
        passed: false,
        passedCases: 0,
        cases: [{ caseId: 'totals-add-up', title: 'Totals', expectation: 'must add up', passed: false, observed: 'off by $1' }],
      }),
    ]);
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers).toEqual([
      { kind: 'checkout', caseId: 'totals-add-up', title: 'Totals', observed: 'off by $1' },
    ]);
    expect(verdict.passedCases).toBe(1);
    expect(verdict.totalCases).toBe(2);
  });

  it('NEVER reports an empty run as ready', () => {
    // "Nothing ran" and "everything passed" must not look the same to a host
    // deciding whether to go live.
    expect(summarizeDressRehearsal([]).ready).toBe(false);
  });

  it('de-duplicates caveats across reports', () => {
    const verdict = summarizeDressRehearsal([
      report({ caveats: ['stubbed payments'] }),
      report({ kind: 'injection', caveats: ['stubbed payments', 'guard scope only'] }),
    ]);
    expect(verdict.caveats).toEqual(['stubbed payments', 'guard scope only']);
  });
});

describe('RehearsalService', () => {
  it('runs a single named rehearsal', async () => {
    const result = await new RehearsalService(new InMemoryRehearsalStore()).run('injection');
    expect(result.kind).toBe('injection');
    expect(result.passed).toBe(true);
  });

  it('runs the whole set and returns a ready verdict on a healthy build', async () => {
    const verdict = await new RehearsalService(new InMemoryRehearsalStore()).runAll();
    expect(verdict.reports.map((entry) => entry.kind)).toEqual([...REHEARSAL_KINDS]);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.ready).toBe(true);
    expect(verdict.totalCases).toBeGreaterThan(30);
    expect(verdict.caveats.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('rehearsal run persistence', () => {
  it('persists a run so latest(kind) survives the call that produced it', async () => {
    const service = new RehearsalService(new InMemoryRehearsalStore());
    expect(await service.latest('injection')).toBeNull();

    const produced = await service.run('injection');
    expect(await service.latest('injection')).toEqual(produced);
  });

  it('keeps per-kind history, not just the folded verdict blob', async () => {
    // A dress rehearsal must leave each constituent run readable on its own —
    // a per-kind run reachable only by unpacking a verdict's jsonb defeats the
    // (kind, ran_at desc) recency index the table carries for exactly this read.
    const service = new RehearsalService(new InMemoryRehearsalStore());
    await service.runAll();

    for (const kind of REHEARSAL_KINDS) {
      expect((await service.latest(kind))?.kind).toBe(kind);
    }
    expect(await service.latestDressRehearsal()).not.toBeNull();
  }, 30_000);

  it('stores two genuine runs as two runs — a rehearsal is a measurement, not a pure function', async () => {
    // The guard on the design decision most likely to be "tidied" later: a
    // judge run hashes its request so a replay resolves to one verdict, but
    // hashing here would collapse every honest re-run onto one row and destroy
    // the history the table exists to hold.
    const store = new InMemoryRehearsalStore();
    const service = new RehearsalService(store);

    const first = await service.run('injection');
    const second = await service.run('injection');

    expect(second.runId).not.toBe(first.runId);
    expect((await service.latest('injection'))?.runId).toBe(second.runId);
  });

  it('de-duplicates only when the caller supplies an explicit retry token', async () => {
    const service = new RehearsalService(new InMemoryRehearsalStore());

    const first = await service.run('injection', { idempotencyKey: 'retry-1' });
    const replay = await service.run('injection', { idempotencyKey: 'retry-1' });

    // One request delivered twice must not mint two runs.
    expect(replay.runId).toBe(first.runId);
  });

  it('gives every row of one dress rehearsal a distinct key under a single retry token', async () => {
    // rehearsal_run.idempotency_key is UNIQUE table-wide. Spreading one token
    // across the constituent runs and the folded verdict would collide them,
    // and the store's ON CONFLICT + re-SELECT would return a row of the WRONG
    // KIND — so each row is qualified by its own scope.
    const service = new RehearsalService(new InMemoryRehearsalStore());
    await service.runAll({ idempotencyKey: 'retry-1' });

    for (const kind of REHEARSAL_KINDS) {
      expect((await service.latest(kind))?.kind).toBe(kind);
    }
  }, 30_000);

  it('stamps an actor on every run, because the column rejects a blank one', async () => {
    const service = new RehearsalService(new InMemoryRehearsalStore());
    await expect(service.run('injection', { actorId: '   ' })).resolves.toBeDefined();
  });
});
