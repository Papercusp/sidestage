import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildReadinessReport,
  fetchPreflight,
  historyDelta,
  readHistory,
  readinessReportFilename,
  recordHistory,
  runDressRehearsal,
  runRehearsal,
  type DressRehearsalVerdict,
  type PreflightReport,
  type RehearsalHistoryEntry,
  type RehearsalKind,
  type RehearsalReport,
} from './rehearsals';

/**
 * These tests hold the browser half of the rehearsal contract to the promises
 * the UI makes about it: history survives a storage that refuses to cooperate,
 * a first run reports "no comparison" rather than a misleading zero, and the
 * readiness verdict is only "ready" when BOTH halves actually ran and passed.
 */

const EVENT = 'evt-rehearsal-test';

function report(overrides: Partial<RehearsalReport> = {}): RehearsalReport {
  return {
    runId: 'run-1',
    kind: 'actions',
    title: 'Guarded actions',
    summary: 'Every guard held.',
    totalCases: 4,
    passedCases: 4,
    passed: true,
    latencyMs: 12,
    ranAt: '2026-08-13T20:00:00.000Z',
    cases: [],
    ...overrides,
  };
}

function entry(kind: RehearsalKind, ranAt: string, passedCases: number): RehearsalHistoryEntry {
  return { kind, ranAt, passedCases, totalCases: 4, passed: passedCases === 4 };
}

/** A localStorage that behaves, backed by a plain Map. */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
    map,
  };
}

/**
 * Install a `localStorage` global for one test.
 *
 * `defineProperty` rather than assignment, because one of the cases below needs
 * the ACCESS itself to throw — that is what private-mode Safari does, and a
 * plain assignment cannot reproduce it.
 */
function withGlobalStorage(descriptor: PropertyDescriptor): () => void {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const previous = had ? Object.getOwnPropertyDescriptor(globalThis, 'localStorage') : undefined;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...descriptor });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  };
}

let restoreStorage: (() => void) | null = null;

afterEach(() => {
  restoreStorage?.();
  restoreStorage = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('rehearsal run history', () => {
  it('round-trips a recorded run and puts the newest first', () => {
    const storage = fakeStorage();
    restoreStorage = withGlobalStorage({ value: storage, writable: true });

    recordHistory(EVENT, report({ ranAt: '2026-08-13T20:00:00.000Z' }));
    recordHistory(EVENT, report({ ranAt: '2026-08-13T21:00:00.000Z', passedCases: 3, passed: false }));

    const history = readHistory(EVENT);
    expect(history).toHaveLength(2);
    expect(history[0]?.ranAt).toBe('2026-08-13T21:00:00.000Z');
    expect(history[0]?.passed).toBe(false);
    expect(history[1]?.passedCases).toBe(4);
  });

  it('keeps history per event, so one event cannot report another event as ready', () => {
    const storage = fakeStorage();
    restoreStorage = withGlobalStorage({ value: storage, writable: true });

    recordHistory('evt-a', report());
    expect(readHistory('evt-b')).toEqual([]);
    expect(readHistory('evt-a')).toHaveLength(1);
  });

  it('caps the stored history at ten runs', () => {
    const storage = fakeStorage();
    restoreStorage = withGlobalStorage({ value: storage, writable: true });

    for (let i = 0; i < 13; i += 1) {
      recordHistory(EVENT, report({ ranAt: `2026-08-13T20:${String(i).padStart(2, '0')}:00.000Z` }));
    }

    expect(readHistory(EVENT)).toHaveLength(10);
    expect(readHistory(EVENT)[0]?.ranAt).toBe('2026-08-13T20:12:00.000Z');
  });

  it('discards stored entries that are not history entries instead of rendering junk', () => {
    const storage = fakeStorage({
      'sidestage:rehearsal-history:evt-rehearsal-test': JSON.stringify([
        { kind: 'not-a-rehearsal', ranAt: 'x', passedCases: 1, totalCases: 1, passed: true },
        { kind: 'actions', ranAt: '2026-08-13T20:00:00.000Z', passedCases: 2, totalCases: 4, passed: false },
        'nonsense',
      ]),
    });
    restoreStorage = withGlobalStorage({ value: storage, writable: true });

    const history = readHistory(EVENT);
    expect(history).toHaveLength(1);
    expect(history[0]?.kind).toBe('actions');
  });

  it('returns an empty history rather than throwing when the stored value is not JSON', () => {
    const storage = fakeStorage({ 'sidestage:rehearsal-history:evt-rehearsal-test': '{not json' });
    restoreStorage = withGlobalStorage({ value: storage, writable: true });

    expect(readHistory(EVENT)).toEqual([]);
  });

  it('survives a localStorage whose ACCESS throws (private-mode Safari)', () => {
    restoreStorage = withGlobalStorage({
      get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    });

    expect(readHistory(EVENT)).toEqual([]);
    // The run the host just did still yields its entry, in memory.
    const next = recordHistory(EVENT, report({ passedCases: 3, passed: false }));
    expect(next).toHaveLength(1);
    expect(next[0]?.passedCases).toBe(3);
  });

  it('survives a full localStorage whose setItem throws, and still returns the run', () => {
    const storage = fakeStorage();
    const throwing = {
      ...storage,
      setItem: () => { throw new DOMException('QuotaExceededError', 'QuotaExceededError'); },
    };
    restoreStorage = withGlobalStorage({ value: throwing, writable: true });

    const next = recordHistory(EVENT, report());
    expect(next).toHaveLength(1);
    expect(next[0]?.kind).toBe('actions');
  });

  it('returns an empty history when there is no localStorage at all', () => {
    // Removed explicitly rather than assumed absent: whether the runtime
    // supplies one varies by Node version, and a test that only passes because
    // the ambient store happened to be empty is not testing this path.
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    delete (globalThis as { localStorage?: unknown }).localStorage;
    restoreStorage = () => {
      if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    };

    expect(typeof localStorage).toBe('undefined');
    expect(readHistory(EVENT)).toEqual([]);
    expect(recordHistory(EVENT, report())).toHaveLength(1);
  });
});

describe('historyDelta', () => {
  it('is null on a first run — an invented 0 would read as "nothing changed"', () => {
    expect(historyDelta([entry('actions', 'a', 4)], 'actions')).toBeNull();
    expect(historyDelta([], 'actions')).toBeNull();
  });

  it('reports the change against the previous run of the SAME rehearsal', () => {
    const history = [
      entry('actions', 'c', 4),
      entry('auction', 'b', 1),
      entry('actions', 'a', 2),
    ];
    expect(historyDelta(history, 'actions')).toBe(2);
  });

  it('reports a regression as a negative number', () => {
    expect(historyDelta([entry('checkout', 'b', 1), entry('checkout', 'a', 3)], 'checkout')).toBe(-2);
  });

  it('is null for a rehearsal that has only ever run once, even alongside others', () => {
    const history = [entry('actions', 'b', 4), entry('actions', 'a', 4), entry('injection', 'c', 2)];
    expect(historyDelta(history, 'injection')).toBeNull();
  });
});

describe('buildReadinessReport', () => {
  const preflight = (ready: boolean): PreflightReport => ({
    eventId: EVENT,
    ranAt: '2026-08-13T20:00:00.000Z',
    ready,
    blockers: ready ? 0 : 1,
    warnings: 0,
    unknowns: 0,
    checks: [],
  });

  const verdict = (ready: boolean): DressRehearsalVerdict => ({
    ranAt: '2026-08-13T20:05:00.000Z',
    ready,
    totalCases: 12,
    passedCases: ready ? 12 : 9,
    blockers: [],
    caveats: [],
    reports: [],
  });

  it('is ready only when BOTH halves ran and passed', () => {
    const now = () => Date.parse('2026-08-13T21:00:00.000Z');
    expect(buildReadinessReport({ eventId: EVENT, preflight: preflight(true), verdict: verdict(true), now }).ready).toBe(true);
    expect(buildReadinessReport({ eventId: EVENT, preflight: preflight(false), verdict: verdict(true), now }).ready).toBe(false);
    expect(buildReadinessReport({ eventId: EVENT, preflight: preflight(true), verdict: verdict(false), now }).ready).toBe(false);
  });

  it('treats a half that never ran as not-ready, not as a pass', () => {
    const now = () => Date.parse('2026-08-13T21:00:00.000Z');
    expect(buildReadinessReport({ eventId: EVENT, preflight: preflight(true), verdict: null, now }).ready).toBe(false);
    expect(buildReadinessReport({ eventId: EVENT, preflight: null, verdict: verdict(true), now }).ready).toBe(false);
    expect(buildReadinessReport({ eventId: EVENT, preflight: null, verdict: null, now }).ready).toBe(false);
  });

  it('carries both halves through verbatim and stamps the generation time', () => {
    const file = buildReadinessReport({
      eventId: EVENT,
      preflight: preflight(true),
      verdict: verdict(true),
      now: () => Date.parse('2026-08-13T21:30:45.500Z'),
    });
    expect(file.generatedAt).toBe('2026-08-13T21:30:45.500Z');
    expect(file.eventId).toBe(EVENT);
    expect(file.preflight?.ranAt).toBe('2026-08-13T20:00:00.000Z');
    expect(file.verdict?.totalCases).toBe(12);
  });
});

describe('readinessReportFilename', () => {
  it('stamps the event and a filesystem-safe timestamp', () => {
    expect(readinessReportFilename('evt-1', '2026-08-13T21:30:45.500Z'))
      .toBe('sidestage-readiness-evt-1-2026-08-13T21-30-45-500Z.json');
  });

  it('leaves no colons or dots in the timestamp, which break saves on some systems', () => {
    const name = readinessReportFilename('evt-1', '2026-08-13T21:30:45.500Z');
    const stamp = name.replace(/^sidestage-readiness-evt-1-/, '').replace(/\.json$/, '');
    expect(stamp).not.toMatch(/[:.]/);
  });
});

describe('rehearsal API client', () => {
  function stubFetch(impl: (url: string, init?: RequestInit) => Promise<unknown>) {
    const spy = vi.fn(async (url: string, init?: RequestInit) => impl(url, init));
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  function jsonResponse(body: unknown, ok = true, status = 200) {
    return Promise.resolve({ ok, status, json: async () => body });
  }

  it('POSTs to the kind-specific rehearsal route and returns the report', async () => {
    const spy = stubFetch(() => jsonResponse(report({ kind: 'auction' })));

    const result = await runRehearsal('auction', 'http://api.test');

    expect(result.kind).toBe('auction');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/rehearsals/auction');
    expect(init.method).toBe('POST');
  });

  it('strips a trailing slash from the base url instead of producing a double slash', async () => {
    const spy = stubFetch(() => jsonResponse(report()));
    await runRehearsal('actions', 'http://api.test/');
    expect(spy.mock.calls[0]?.[0]).toBe('http://api.test/rehearsals/actions');
  });

  it('surfaces the server message on a failed run rather than a bare status', async () => {
    stubFetch(() => jsonResponse({ message: 'Guard service is not configured' }, false, 503));
    await expect(runRehearsal('actions', 'http://api.test'))
      .rejects.toThrow('Guard service is not configured');
  });

  it('falls back to the status code when the server sends no message', async () => {
    stubFetch(() => jsonResponse({}, false, 500));
    await expect(runRehearsal('actions', 'http://api.test')).rejects.toThrow('Request failed (500)');
  });

  it('POSTs the dress rehearsal to the all route', async () => {
    const spy = stubFetch(() => jsonResponse({
      ranAt: 'now', ready: true, totalCases: 4, passedCases: 4, blockers: [], caveats: [], reports: [],
    }));
    const result = await runDressRehearsal('http://api.test');
    expect(result.ready).toBe(true);
    expect(spy.mock.calls[0]?.[0]).toBe('http://api.test/rehearsals/all');
  });

  it('url-encodes the event id when fetching preflight', async () => {
    const spy = stubFetch(() => jsonResponse({
      eventId: 'a/b', ranAt: 'now', ready: true, blockers: 0, warnings: 0, unknowns: 0, checks: [],
    }));
    await fetchPreflight('a/b', 'http://api.test');
    expect(spy.mock.calls[0]?.[0]).toBe('http://api.test/rehearsals/preflight/a%2Fb');
  });

  it('surfaces the server message when preflight fails', async () => {
    stubFetch(() => jsonResponse({ message: 'No such event' }, false, 404));
    await expect(fetchPreflight('missing', 'http://api.test')).rejects.toThrow('No such event');
  });
});
