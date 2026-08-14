import { createResilientEventSource } from '@papercusp/sse';
import { resolveApiBaseUrl } from './catalog';

/**
 * Browser contract for the launch-readiness rehearsals.
 *
 * These types mirror `apps/api/src/rehearsals/rehearsal.types.ts`. The two
 * workspaces do not share a package, so the mirror is checked by a test that
 * runs a real report through this module's own type guard rather than by
 * hoping the two files stay in step.
 */

export const REHEARSAL_KINDS = ['actions', 'auction', 'checkout', 'injection'] as const;
export type RehearsalKind = (typeof REHEARSAL_KINDS)[number];

export type RehearsalEvidence = Record<string, string | number | boolean>;

export interface RehearsalCaseResult {
  caseId: string;
  title: string;
  expectation: string;
  passed: boolean;
  observed: string;
  evidence?: RehearsalEvidence;
}

export interface RehearsalReport {
  runId: string;
  kind: RehearsalKind;
  title: string;
  summary: string;
  totalCases: number;
  passedCases: number;
  passed: boolean;
  latencyMs: number;
  ranAt: string;
  cases: RehearsalCaseResult[];
  caveats?: string[];
}

export interface DressRehearsalBlocker {
  kind: RehearsalKind;
  caseId: string;
  title: string;
  observed: string;
}

export interface DressRehearsalVerdict {
  ranAt: string;
  ready: boolean;
  totalCases: number;
  passedCases: number;
  blockers: DressRehearsalBlocker[];
  caveats: string[];
  reports: RehearsalReport[];
}

export type PreflightStatus = 'ready' | 'warning' | 'blocker' | 'unknown';

export interface PreflightCheck {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
  remedy?: string;
}

export interface PreflightReport {
  eventId: string;
  ranAt: string;
  /** False when anything blocks OR anything could not be measured. */
  ready: boolean;
  blockers: number;
  warnings: number;
  /** Checks that could not be established either way — these hold back `ready`. */
  unknowns: number;
  checks: PreflightCheck[];
}

export interface ClientPreflightCheck {
  id: 'realtime-round-trip' | 'media-loopback' | 'clock-skew';
  label: string;
  status: PreflightStatus;
  /** The condition this probe set out to establish. */
  expectation: string;
  /** What this run actually measured — never a capability assertion. */
  observed: string;
  evidence?: RehearsalEvidence;
  remedy?: string;
}

export interface ClientPreflightReport {
  ranAt: string;
  ready: boolean;
  blockers: number;
  warnings: number;
  unknowns: number;
  checks: ClientPreflightCheck[];
}

export const REHEARSAL_LABELS: Record<RehearsalKind, string> = {
  actions: 'Guarded actions',
  auction: 'Live auction',
  checkout: 'Checkout and shipping',
  injection: 'Hostile input',
};

async function postJson<T>(path: string, apiBaseUrl?: string): Promise<T> {
  const response = await fetch(`${resolveApiBaseUrl(apiBaseUrl)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `Request failed (${response.status})`);
  return payload;
}

export function runRehearsal(kind: RehearsalKind, apiBaseUrl?: string): Promise<RehearsalReport> {
  return postJson<RehearsalReport>(`/rehearsals/${kind}`, apiBaseUrl);
}

export function runDressRehearsal(apiBaseUrl?: string): Promise<DressRehearsalVerdict> {
  return postJson<DressRehearsalVerdict>('/rehearsals/all', apiBaseUrl);
}

// ---- Measured browser preflight ---------------------------------------------

export const REALTIME_PROBE_TIMEOUT_MS = 3_000;
export const MEDIA_SAMPLE_WINDOW_MS = 350;
export const MEDIA_PROBE_TIMEOUT_MS = 3_000;
export const REALTIME_WARNING_MS = 1_000;
export const CLOCK_SKEW_WARNING_MS = 1_000;
export const CLOCK_SKEW_BLOCKER_MS = 5_000;

export type RealtimeProbeOutcome =
  | { kind: 'measured'; latencyMs: number; serverTimeMs: number }
  | { kind: 'failed'; message: string }
  | { kind: 'not-attempted'; message: string };

export type MediaLoopbackOutcome =
  | {
    kind: 'measured';
    videoBytes: number;
    audioBytes: number;
    videoLabel: string;
    audioLabel: string;
    width?: number;
    height?: number;
    sampleRate?: number;
  }
  | { kind: 'failed'; message: string }
  | { kind: 'unavailable'; message: string };

export type ClockSkewOutcome =
  | { kind: 'measured'; skewMs: number; roundTripMs: number; uncertaintyMs: number }
  | { kind: 'unknown'; message: string };

interface RealtimeSourceCallbacks {
  url: string;
  onOpen(): void;
  onInvalidate(data: string): void;
  onError(error: Error): void;
}

export interface RealtimeProbeSource {
  close(): void;
}

export type OpenRealtimeProbeSource = (callbacks: RealtimeSourceCallbacks) => RealtimeProbeSource;

export interface RealtimeProbeOptions {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  timeoutMs?: number;
  openSource?: OpenRealtimeProbeSource;
}

function openRealtimeProbeSource(callbacks: RealtimeSourceCallbacks): RealtimeProbeSource {
  return createResilientEventSource({
    url: callbacks.url,
    initialBackoffMs: 250,
    maxBackoffMs: 250,
    jitter: 0,
    zombieTimeoutMs: 0,
    maxConsecutiveFailures: 1,
    handlers: { invalidate: callbacks.onInvalidate },
    onOpen: callbacks.onOpen,
    onError: callbacks.onError,
  });
}

function randomProbeNonce(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Measure the same POST -> SyncInvalidationService -> SSE path the app uses to
 * refresh live panels. Opening a socket is not a pass: the matching nonce must
 * come back through the `invalidate` event before the deadline.
 */
export function probeRealtimeRoundTrip(
  eventId: string,
  options: RealtimeProbeOptions = {},
): Promise<RealtimeProbeOutcome> {
  if (!options.openSource && typeof globalThis.EventSource === 'undefined') {
    return Promise.resolve({
      kind: 'not-attempted',
      message: 'Not attempted: this browser does not provide EventSource.',
    });
  }

  const apiBaseUrl = resolveApiBaseUrl(options.apiBaseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? REALTIME_PROBE_TIMEOUT_MS;
  const nonce = (options.nonce ?? randomProbeNonce)();
  const openSource = options.openSource ?? openRealtimeProbeSource;

  return new Promise((resolve) => {
    let source: RealtimeProbeSource | undefined;
    let opened = false;
    let emitted = false;
    let settled = false;
    let startedAt = 0;

    const finish = (outcome: RealtimeProbeOutcome) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      source?.close();
      resolve(outcome);
    };

    const timeout = globalThis.setTimeout(() => {
      if (!opened) {
        finish({
          kind: 'not-attempted',
          message: `Not attempted: the realtime stream did not open within ${timeoutMs}ms.`,
        });
        return;
      }
      finish({
        kind: 'failed',
        message: emitted
          ? `No round trip within ${timeoutMs}ms after the probe was emitted.`
          : `The probe request did not complete within ${timeoutMs}ms, so no realtime round trip was measured.`,
      });
    }, timeoutMs);

    source = openSource({
      url: `${apiBaseUrl}/sync/sse?eventId=${encodeURIComponent(eventId)}`,
      onOpen() {
        if (opened || settled) return;
        opened = true;
        startedAt = now();
        void fetchImpl(`${apiBaseUrl}/rehearsals/client-realtime/${encodeURIComponent(eventId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nonce }),
        }).then(async (response) => {
          if (!response.ok) {
            finish({ kind: 'failed', message: `Realtime probe request failed (${response.status}).` });
            return;
          }
          const receipt = await response.json() as { nonce?: unknown };
          if (receipt.nonce !== nonce) {
            finish({ kind: 'failed', message: 'Realtime probe returned a different correlation nonce.' });
            return;
          }
          emitted = true;
        }).catch((error: unknown) => {
          finish({
            kind: 'failed',
            message: `Realtime probe request failed (${error instanceof Error ? error.message : String(error)}).`,
          });
        });
      },
      onInvalidate(data) {
        let event: { name?: unknown; args?: Record<string, unknown> };
        try {
          event = JSON.parse(data) as typeof event;
        } catch {
          return;
        }
        if (event.name !== 'rehearsal.client-round-trip' || event.args?.nonce !== nonce) return;
        const serverTimeMs = event.args.serverTimeMs;
        if (typeof serverTimeMs !== 'number') return;
        emitted = true;
        finish({
          kind: 'measured',
          latencyMs: Math.max(0, Math.round(now() - startedAt)),
          serverTimeMs,
        });
      },
      onError(error) {
        finish({
          kind: opened ? 'failed' : 'not-attempted',
          message: opened
            ? `The realtime stream failed during the probe (${error.message}).`
            : `Not attempted: the realtime stream could not open (${error.message}).`,
        });
      },
    });
    if (settled) source.close();
  });
}

export interface ClockSkewProbeOptions {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Estimate wall-clock skew using the midpoint of the HTTP request window. */
export async function probeClockSkew(options: ClockSkewProbeOptions = {}): Promise<ClockSkewOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const startedAt = now();
  try {
    const response = await fetchImpl(`${resolveApiBaseUrl(options.apiBaseUrl)}/rehearsals/client-clock`);
    const receivedAt = now();
    if (!response.ok) return { kind: 'unknown', message: `Clock probe failed (${response.status}).` };
    const payload = await response.json() as { serverTimeMs?: unknown };
    if (typeof payload.serverTimeMs !== 'number' || !Number.isFinite(payload.serverTimeMs)) {
      return { kind: 'unknown', message: 'Clock probe returned no usable server timestamp.' };
    }
    const roundTripMs = Math.max(0, Math.round(receivedAt - startedAt));
    const midpointMs = startedAt + ((receivedAt - startedAt) / 2);
    return {
      kind: 'measured',
      skewMs: Math.round(payload.serverTimeMs - midpointMs),
      roundTripMs,
      uncertaintyMs: Math.ceil(roundTripMs / 2),
    };
  } catch (error) {
    return {
      kind: 'unknown',
      message: `Clock probe could not be measured (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

export interface MediaDevicesProbeProvider {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export type CaptureTrackBytes = (track: MediaStreamTrack) => Promise<number>;

export interface MediaLoopbackProbeOptions {
  mediaDevices?: MediaDevicesProbeProvider | null;
  captureTrackBytes?: CaptureTrackBytes;
  timeoutMs?: number;
}

class MeasurementUnavailableError extends Error {}

async function captureTrackBytes(track: MediaStreamTrack): Promise<number> {
  if (typeof globalThis.MediaRecorder === 'undefined' || typeof globalThis.MediaStream === 'undefined') {
    throw new MeasurementUnavailableError('MediaRecorder is unavailable in this browser.');
  }
  const recorder = new MediaRecorder(new MediaStream([track]));
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(stopTimer);
      globalThis.clearTimeout(failTimer);
      if (error) reject(error);
      else resolve(bytes);
    };
    const stopTimer = globalThis.setTimeout(() => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }, MEDIA_SAMPLE_WINDOW_MS);
    const failTimer = globalThis.setTimeout(
      () => finish(new Error(`Media recorder did not finish within ${MEDIA_PROBE_TIMEOUT_MS}ms.`)),
      MEDIA_PROBE_TIMEOUT_MS,
    );
    recorder.addEventListener('dataavailable', (event: BlobEvent) => { bytes += event.data.size; });
    recorder.addEventListener('stop', () => finish(), { once: true });
    recorder.addEventListener('error', () => finish(new Error(`The ${track.kind} recorder failed.`)), { once: true });
    try {
      recorder.start();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function withProbeTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { globalThis.clearTimeout(timer); resolve(value); },
      (error) => { globalThis.clearTimeout(timer); reject(error); },
    );
  });
}

/** Open both devices and prove each produced encoded media bytes, then release them. */
export async function probeMediaLoopback(
  options: MediaLoopbackProbeOptions = {},
): Promise<MediaLoopbackOutcome> {
  const mediaDevices = options.mediaDevices === undefined
    ? globalThis.navigator?.mediaDevices
    : options.mediaDevices;
  if (!mediaDevices) {
    return { kind: 'unavailable', message: 'Camera and microphone access is unavailable in this browser.' };
  }

  let stream: MediaStream | undefined;
  try {
    stream = await mediaDevices.getUserMedia({ video: true, audio: true });
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0];
    if (!video || !audio) {
      return {
        kind: 'failed',
        message: `The device stream opened without ${!video ? 'a video track' : 'an audio track'}.`,
      };
    }
    if (video.readyState !== 'live' || audio.readyState !== 'live') {
      return { kind: 'failed', message: 'A camera or microphone track stopped before it produced media.' };
    }

    const capture = options.captureTrackBytes ?? captureTrackBytes;
    const timeoutMs = options.timeoutMs ?? MEDIA_PROBE_TIMEOUT_MS;
    const [videoBytes, audioBytes] = await withProbeTimeout(
      Promise.all([capture(video), capture(audio)]),
      timeoutMs,
      `No camera/microphone samples within ${timeoutMs}ms.`,
    );
    if (videoBytes < 1 || audioBytes < 1) {
      return {
        kind: 'failed',
        message: `Devices opened, but ${videoBytes < 1 ? 'the camera produced no encoded frame bytes' : 'the microphone produced no encoded sample bytes'}.`,
      };
    }
    const videoSettings = video.getSettings();
    const audioSettings = audio.getSettings();
    return {
      kind: 'measured',
      videoBytes,
      audioBytes,
      videoLabel: video.label || 'camera',
      audioLabel: audio.label || 'microphone',
      ...(typeof videoSettings.width === 'number' ? { width: videoSettings.width } : {}),
      ...(typeof videoSettings.height === 'number' ? { height: videoSettings.height } : {}),
      ...(typeof audioSettings.sampleRate === 'number' ? { sampleRate: audioSettings.sampleRate } : {}),
    };
  } catch (error) {
    if (error instanceof MeasurementUnavailableError) {
      return { kind: 'unavailable', message: error.message };
    }
    return {
      kind: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

export function buildClientPreflightReport(input: {
  realtime: RealtimeProbeOutcome;
  media: MediaLoopbackOutcome;
  clock: ClockSkewOutcome;
  now?: () => number;
}): ClientPreflightReport {
  const checks: ClientPreflightCheck[] = [];

  if (input.realtime.kind === 'measured') {
    checks.push({
      id: 'realtime-round-trip',
      label: 'Realtime round trip',
      status: input.realtime.latencyMs > REALTIME_WARNING_MS ? 'warning' : 'ready',
      expectation: `A correlated update returns through the live SSE path within ${REALTIME_PROBE_TIMEOUT_MS}ms.`,
      observed: `The matching update returned in ${input.realtime.latencyMs}ms.`,
      evidence: { latencyMs: input.realtime.latencyMs, serverTimeMs: input.realtime.serverTimeMs },
      ...(input.realtime.latencyMs > REALTIME_WARNING_MS
        ? { remedy: 'The path works, but it is slow. Check the API and network before opening the room.' }
        : {}),
    });
  } else {
    checks.push({
      id: 'realtime-round-trip',
      label: 'Realtime round trip',
      status: input.realtime.kind === 'failed' ? 'blocker' : 'unknown',
      expectation: `A correlated update returns through the live SSE path within ${REALTIME_PROBE_TIMEOUT_MS}ms.`,
      observed: input.realtime.message,
      remedy: input.realtime.kind === 'failed'
        ? 'Restore the realtime connection, then re-run the check before opening the room.'
        : 'Use a browser with EventSource support and re-run the check.',
    });
  }

  if (input.media.kind === 'measured') {
    const dimensions = input.media.width && input.media.height
      ? ` at ${input.media.width}×${input.media.height}`
      : '';
    checks.push({
      id: 'media-loopback',
      label: 'Camera + microphone',
      status: 'ready',
      expectation: 'The selected camera and microphone open and each produce real media bytes.',
      observed: `Camera produced ${input.media.videoBytes.toLocaleString()} encoded bytes${dimensions}; microphone produced ${input.media.audioBytes.toLocaleString()} encoded bytes.`,
      evidence: {
        videoBytes: input.media.videoBytes,
        audioBytes: input.media.audioBytes,
        videoDevice: input.media.videoLabel,
        audioDevice: input.media.audioLabel,
        ...(input.media.width ? { width: input.media.width } : {}),
        ...(input.media.height ? { height: input.media.height } : {}),
        ...(input.media.sampleRate ? { sampleRate: input.media.sampleRate } : {}),
      },
    });
  } else {
    checks.push({
      id: 'media-loopback',
      label: 'Camera + microphone',
      status: input.media.kind === 'failed' ? 'blocker' : 'unknown',
      expectation: 'The selected camera and microphone open and each produce real media bytes.',
      observed: input.media.message,
      remedy: input.media.kind === 'failed'
        ? 'Allow camera and microphone access, check the selected devices, then re-run the probe.'
        : 'Use a browser that can record local media, then re-run the probe.',
    });
  }

  if (input.clock.kind === 'measured') {
    const absoluteSkew = Math.abs(input.clock.skewMs);
    const direction = input.clock.skewMs > 0 ? 'behind' : input.clock.skewMs < 0 ? 'ahead of' : 'aligned with';
    const status: PreflightStatus = absoluteSkew > CLOCK_SKEW_BLOCKER_MS
      ? 'blocker'
      : absoluteSkew > CLOCK_SKEW_WARNING_MS ? 'warning' : 'ready';
    checks.push({
      id: 'clock-skew',
      label: 'Browser clock',
      status,
      expectation: `The browser clock is within ${CLOCK_SKEW_WARNING_MS}ms of the API clock.`,
      observed: absoluteSkew === 0
        ? `Browser and API clocks aligned within a ±${input.clock.uncertaintyMs}ms measurement window.`
        : `Browser clock is ${absoluteSkew}ms ${direction} the API (±${input.clock.uncertaintyMs}ms; HTTP round trip ${input.clock.roundTripMs}ms).`,
      evidence: {
        skewMs: input.clock.skewMs,
        roundTripMs: input.clock.roundTripMs,
        uncertaintyMs: input.clock.uncertaintyMs,
      },
      ...(status === 'ready' ? {} : {
        remedy: status === 'blocker'
          ? 'Synchronize this computer clock before running a timed auction.'
          : 'Clock drift is visible. Synchronize this computer before the event if it grows.',
      }),
    });
  } else {
    checks.push({
      id: 'clock-skew',
      label: 'Browser clock',
      status: 'unknown',
      expectation: `The browser clock is within ${CLOCK_SKEW_WARNING_MS}ms of the API clock.`,
      observed: input.clock.message,
      remedy: 'Restore API access and re-run the clock check before a timed auction.',
    });
  }

  const blockers = checks.filter((check) => check.status === 'blocker').length;
  const warnings = checks.filter((check) => check.status === 'warning').length;
  const unknowns = checks.filter((check) => check.status === 'unknown').length;
  return {
    ranAt: new Date((input.now ?? Date.now)()).toISOString(),
    ready: blockers === 0 && unknowns === 0,
    blockers,
    warnings,
    unknowns,
    checks,
  };
}

export interface ClientPreflightOptions {
  realtime?: RealtimeProbeOptions;
  media?: MediaLoopbackProbeOptions;
  clock?: ClockSkewProbeOptions;
  now?: () => number;
}

export async function runClientPreflight(
  eventId: string,
  options: ClientPreflightOptions = {},
): Promise<ClientPreflightReport> {
  const [realtime, media, clock] = await Promise.all([
    probeRealtimeRoundTrip(eventId, options.realtime),
    probeMediaLoopback(options.media),
    probeClockSkew(options.clock),
  ]);
  return buildClientPreflightReport({ realtime, media, clock, now: options.now });
}

// ---- Run history -------------------------------------------------------------

export interface RehearsalHistoryEntry {
  kind: RehearsalKind;
  ranAt: string;
  passedCases: number;
  totalCases: number;
  passed: boolean;
}

const HISTORY_KEY_PREFIX = 'sidestage:rehearsal-history:';
const HISTORY_LIMIT = 10;

function historyKey(eventId: string): string {
  return `${HISTORY_KEY_PREFIX}${eventId}`;
}

function safeStorage(): Storage | null {
  try {
    // Private-mode Safari throws on access rather than returning null, and a
    // readiness screen must not break because history is unavailable.
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readHistory(eventId: string): RehearsalHistoryEntry[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(historyKey(eventId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isHistoryEntry) : [];
  } catch {
    return [];
  }
}

function isHistoryEntry(value: unknown): value is RehearsalHistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.kind === 'string'
    && (REHEARSAL_KINDS as readonly string[]).includes(entry.kind)
    && typeof entry.ranAt === 'string'
    && typeof entry.passedCases === 'number'
    && typeof entry.totalCases === 'number'
    && typeof entry.passed === 'boolean';
}

export function recordHistory(eventId: string, report: RehearsalReport): RehearsalHistoryEntry[] {
  const storage = safeStorage();
  const entry: RehearsalHistoryEntry = {
    kind: report.kind,
    ranAt: report.ranAt,
    passedCases: report.passedCases,
    totalCases: report.totalCases,
    passed: report.passed,
  };
  const next = [entry, ...readHistory(eventId)].slice(0, HISTORY_LIMIT);
  if (storage) {
    try {
      storage.setItem(historyKey(eventId), JSON.stringify(next));
    } catch {
      // A full or blocked storage must not fail the run the host just did.
    }
  }
  return next;
}

/**
 * The change since the previous run of the SAME rehearsal.
 *
 * Returns null when there is nothing to compare against — a first run has no
 * delta, and inventing "0" would read as "nothing changed", which is a
 * different and misleading claim.
 */
export function historyDelta(history: readonly RehearsalHistoryEntry[], kind: RehearsalKind): number | null {
  const forKind = history.filter((entry) => entry.kind === kind);
  const [latest, previous] = forKind;
  if (!latest || !previous) return null;
  return latest.passedCases - previous.passedCases;
}

// ---- Report export -----------------------------------------------------------

export interface ReadinessReportFile {
  generatedAt: string;
  eventId: string;
  ready: boolean;
  preflight: PreflightReport | null;
  clientPreflight: ClientPreflightReport | null;
  verdict: DressRehearsalVerdict | null;
}

export function buildReadinessReport(input: {
  eventId: string;
  preflight: PreflightReport | null;
  clientPreflight: ClientPreflightReport | null;
  verdict: DressRehearsalVerdict | null;
  now?: () => number;
}): ReadinessReportFile {
  const now = input.now ?? Date.now;
  // Ready requires BOTH halves to have actually run and passed. A missing half
  // is not a pass — that is the whole reason this is computed here rather than
  // read off whichever report happens to be present.
  const ready = Boolean(input.preflight?.ready)
    && Boolean(input.clientPreflight?.ready)
    && Boolean(input.verdict?.ready);
  return {
    generatedAt: new Date(now()).toISOString(),
    eventId: input.eventId,
    ready,
    preflight: input.preflight,
    clientPreflight: input.clientPreflight,
    verdict: input.verdict,
  };
}

export function readinessReportFilename(eventId: string, generatedAt: string): string {
  const stamp = generatedAt.replace(/[:.]/g, '-');
  return `sidestage-readiness-${eventId}-${stamp}.json`;
}
