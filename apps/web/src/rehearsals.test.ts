import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildClientPreflightReport,
  buildReadinessReport,
  historyDelta,
  probeClockSkew,
  probeMediaLoopback,
  probeRealtimeRoundTrip,
  readHistory,
  readinessReportFilename,
  recordHistory,
  runDressRehearsal,
  runRehearsal,
  type ClientPreflightReport,
  type DressRehearsalVerdict,
  type OpenRealtimeProbeSource,
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

describe('measured browser preflight', () => {
  it('requires the correlated nonce to return through the real SSE invalidation path', async () => {
    let callbacks: Parameters<OpenRealtimeProbeSource>[0] | undefined;
    const close = vi.fn();
    const openSource: OpenRealtimeProbeSource = (next) => {
      callbacks = next;
      queueMicrotask(next.onOpen);
      return { close };
    };
    let clock = 100;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const nonce = (JSON.parse(String(init?.body)) as { nonce: string }).nonce;
      queueMicrotask(() => {
        clock = 137;
        callbacks?.onInvalidate(JSON.stringify({
          name: 'rehearsal.client-round-trip',
          args: { nonce, serverTimeMs: 120 },
        }));
      });
      return { ok: true, status: 200, json: async () => ({ nonce }) } as Response;
    });

    await expect(probeRealtimeRoundTrip('event/a', {
      apiBaseUrl: 'http://api.test/',
      principal: 'demo-rehearsal',
      fetchImpl: fetchImpl as typeof fetch,
      now: () => clock,
      nonce: () => 'probe-nonce-123',
      openSource,
      timeoutMs: 50,
    })).resolves.toEqual({ kind: 'measured', latencyMs: 37, serverTimeMs: 120 });

    expect(callbacks?.url).toBe('http://api.test/sync/sse?eventId=event%2Fa');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://api.test/rehearsals/client-realtime/event%2Fa');
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('x-demo-principal')).toBe('demo-rehearsal');
    expect(close).toHaveBeenCalledOnce();
  });

  it('distinguishes an emitted probe with no return from one that never opened', async () => {
    const opensButNeverReturns: OpenRealtimeProbeSource = (callbacks) => {
      queueMicrotask(callbacks.onOpen);
      return { close: vi.fn() };
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const nonce = (JSON.parse(String(init?.body)) as { nonce: string }).nonce;
      return { ok: true, status: 200, json: async () => ({ nonce }) } as Response;
    });
    const failed = await probeRealtimeRoundTrip('event-1', {
      fetchImpl: fetchImpl as typeof fetch,
      nonce: () => 'probe-nonce-123',
      openSource: opensButNeverReturns,
      timeoutMs: 5,
    });
    expect(failed).toEqual({ kind: 'failed', message: 'No round trip within 5ms after the probe was emitted.' });

    const notAttempted = await probeRealtimeRoundTrip('event-1', {
      openSource: () => ({ close: vi.fn() }),
      timeoutMs: 5,
    });
    expect(notAttempted).toEqual({
      kind: 'not-attempted',
      message: 'Not attempted: the realtime stream did not open within 5ms.',
    });
  });

  it('opens camera and microphone, measures bytes from both, and always releases their tracks', async () => {
    const video = {
      kind: 'video', label: 'Studio cam', readyState: 'live',
      getSettings: () => ({ width: 1920, height: 1080 }), stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const audio = {
      kind: 'audio', label: 'Desk mic', readyState: 'live',
      getSettings: () => ({ sampleRate: 48_000 }), stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const stream = {
      getVideoTracks: () => [video],
      getAudioTracks: () => [audio],
      getTracks: () => [video, audio],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    const captureTrackBytes = vi.fn(async (track: MediaStreamTrack) => track.kind === 'video' ? 4_096 : 2_048);

    await expect(probeMediaLoopback({ mediaDevices: { getUserMedia }, captureTrackBytes }))
      .resolves.toEqual({
        kind: 'measured',
        videoBytes: 4_096,
        audioBytes: 2_048,
        videoLabel: 'Studio cam',
        audioLabel: 'Desk mic',
        width: 1920,
        height: 1080,
        sampleRate: 48_000,
      });
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: true });
    expect(captureTrackBytes).toHaveBeenCalledTimes(2);
    expect(video.stop).toHaveBeenCalledOnce();
    expect(audio.stop).toHaveBeenCalledOnce();
  });

  it('does not turn missing media instrumentation or zero captured bytes into a green check', async () => {
    await expect(probeMediaLoopback({ mediaDevices: null })).resolves.toMatchObject({ kind: 'unavailable' });

    const video = { kind: 'video', label: '', readyState: 'live', getSettings: () => ({}), stop: vi.fn() } as unknown as MediaStreamTrack;
    const audio = { kind: 'audio', label: '', readyState: 'live', getSettings: () => ({}), stop: vi.fn() } as unknown as MediaStreamTrack;
    const stream = {
      getVideoTracks: () => [video], getAudioTracks: () => [audio], getTracks: () => [video, audio],
    } as unknown as MediaStream;
    await expect(probeMediaLoopback({
      mediaDevices: { getUserMedia: async () => stream },
      captureTrackBytes: async (track) => track.kind === 'video' ? 100 : 0,
    })).resolves.toMatchObject({ kind: 'failed', message: expect.stringContaining('microphone produced no') });
    expect(video.stop).toHaveBeenCalledOnce();
    expect(audio.stop).toHaveBeenCalledOnce();
  });

  it('measures clock skew at the HTTP midpoint and carries the uncertainty window', async () => {
    const ticks = [1_000, 1_040];
    const measured = await probeClockSkew({
      apiBaseUrl: 'http://api.test',
      now: () => ticks.shift() ?? 1_040,
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ serverTimeMs: 1_025 }) } as Response)) as typeof fetch,
    });
    expect(measured).toEqual({ kind: 'measured', skewMs: 5, roundTripMs: 40, uncertaintyMs: 20 });
  });

  it('builds readiness from observations and keeps unknowns from rendering ready', () => {
    const ready = buildClientPreflightReport({
      realtime: { kind: 'measured', latencyMs: 25, serverTimeMs: 1_000 },
      media: { kind: 'measured', videoBytes: 10, audioBytes: 8, videoLabel: 'cam', audioLabel: 'mic' },
      clock: { kind: 'measured', skewMs: 5, roundTripMs: 20, uncertaintyMs: 10 },
      now: () => 1,
    });
    expect(ready.ready).toBe(true);
    expect(ready.checks.every((check) => check.observed.length > 0 && check.expectation.length > 0)).toBe(true);

    const unknown = buildClientPreflightReport({
      realtime: { kind: 'not-attempted', message: 'Not attempted' },
      media: { kind: 'unavailable', message: 'Unavailable' },
      clock: { kind: 'unknown', message: 'Unknown' },
    });
    expect(unknown).toMatchObject({ ready: false, blockers: 0, unknowns: 3 });
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

  const clientPreflight = (ready: boolean): ClientPreflightReport => ({
    ranAt: '2026-08-13T20:02:00.000Z',
    ready,
    blockers: ready ? 0 : 1,
    warnings: 0,
    unknowns: 0,
    checks: [],
  });

  it('is ready only when server, browser, and rehearsal measurements all ran and passed', () => {
    const now = () => Date.parse('2026-08-13T21:00:00.000Z');
    expect(buildReadinessReport({ eventId: EVENT, preflight: preflight(true), clientPreflight: clientPreflight(true), verdict: verdict(true), now }).ready).toBe(true);
    expect(buildReadinessReport({ eventId: EVENT, preflight: preflight(false), clientPreflight: clientPreflight(true), verdict: verdict(true), now }).ready).toBe(false);
    expect(buildReadinessReport({ eventId: EVENT, preflight: preflight(true), clientPreflight: clientPreflight(false), verdict: verdict(true), now }).ready).toBe(false);
    expect(buildReadinessReport({ eventId: EVENT, preflight: preflight(true), clientPreflight: clientPreflight(true), verdict: verdict(false), now }).ready).toBe(false);
  });

  it('treats any measurement group that never ran as not-ready, not as a pass', () => {
    const now = () => Date.parse('2026-08-13T21:00:00.000Z');
    expect(buildReadinessReport({ eventId: EVENT, preflight: preflight(true), clientPreflight: clientPreflight(true), verdict: null, now }).ready).toBe(false);
    expect(buildReadinessReport({ eventId: EVENT, preflight: preflight(true), clientPreflight: null, verdict: verdict(true), now }).ready).toBe(false);
    expect(buildReadinessReport({ eventId: EVENT, preflight: null, clientPreflight: clientPreflight(true), verdict: verdict(true), now }).ready).toBe(false);
  });

  it('carries both halves through verbatim and stamps the generation time', () => {
    const file = buildReadinessReport({
      eventId: EVENT,
      preflight: preflight(true),
      clientPreflight: clientPreflight(true),
      verdict: verdict(true),
      now: () => Date.parse('2026-08-13T21:30:45.500Z'),
    });
    expect(file.generatedAt).toBe('2026-08-13T21:30:45.500Z');
    expect(file.eventId).toBe(EVENT);
    expect(file.preflight?.ranAt).toBe('2026-08-13T20:00:00.000Z');
    expect(file.clientPreflight?.ranAt).toBe('2026-08-13T20:02:00.000Z');
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

});
