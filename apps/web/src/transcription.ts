import { DEMO_PRINCIPAL_HEADER } from '@papercusp/sync';

/**
 * Provider-neutral live transcription for the seller stage.
 *
 * A short-lived Deepgram token keeps the permanent API key on the server. If
 * no token is configured, the browser Web Speech API is used as a local demo
 * fallback. Both providers emit the same interim/final segment contract so a
 * transcript controller does not need to know which transport is active.
 */

export type TranscriptionProvider = 'deepgram' | 'web-speech';
export type TranscriptionState = 'idle' | 'connecting' | 'listening' | 'stopped' | 'error';

export interface TranscriptSegment {
  id: string;
  text: string;
  isFinal: boolean;
  provider: TranscriptionProvider;
  receivedAt: number;
  startMs?: number;
  endMs?: number;
}

export interface TranscriptionError {
  message: string;
  cause?: unknown;
}

export type SegmentListener = (segment: TranscriptSegment) => void;
export type StateListener = (state: TranscriptionState) => void;
export type ErrorListener = (error: TranscriptionError) => void;

export interface TranscriptionSession {
  readonly provider: TranscriptionProvider;
  readonly state: TranscriptionState;
  start(): Promise<void>;
  stop(): Promise<void>;
  onSegment(listener: SegmentListener): () => void;
  onState(listener: StateListener): () => void;
  onError(listener: ErrorListener): () => void;
}

export type DeepgramTokenProvider = () => Promise<string | null>;

export interface WebSocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string, protocols?: string | string[]) => WebSocketLike;

export interface MediaRecorderLike {
  ondataavailable: ((event: { data: Blob; }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  start(timesliceMs?: number): void;
  stop(): void;
}

export type MediaRecorderFactory = (stream: MediaStream) => MediaRecorderLike;

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

export interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
}

export type SpeechRecognitionFactory = () => SpeechRecognitionLike;

export interface TranscriptionOptions {
  /** The publisher's stream; required for Deepgram MediaRecorder capture. */
  mediaStream?: MediaStream;
  /** Short-lived token only. Never pass a permanent Deepgram API key here. */
  deepgramToken?: string;
  deepgramTokenProvider?: DeepgramTokenProvider;
  /** Fall back only when the token provider explicitly reports Deepgram unconfigured. */
  fallbackToWebSpeech?: boolean;
  deepgramUrl?: string;
  model?: string;
  language?: string;
  webSocketFactory?: WebSocketFactory;
  mediaRecorderFactory?: MediaRecorderFactory;
  speechRecognitionFactory?: SpeechRecognitionFactory;
  /**
   * Override the browser recording-capability probe (`MediaRecorder.isTypeSupported`).
   * Tests inject it to simulate a browser; production leaves it undefined.
   */
  isTypeSupported?: (type: string) => boolean;
}

export const DEFAULT_DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';
export const DEFAULT_DEEPGRAM_MODEL = 'nova-3';
export const DEFAULT_TRANSCRIPTION_LANGUAGE = 'en-US';
const OPEN_SOCKET = 1;

export const PUBLISHER_STREAM_REQUIRED_MESSAGE = 'Deepgram transcription requires the publisher media stream.';

/**
 * The recoverable message an ENDED publisher stream must produce (WI-39726).
 *
 * Chrome answers `.start()` on a stream with no live audio track with
 * "Failed to execute 'start' on 'MediaRecorder': There was an error starting
 * the MediaRecorder." — a raw platform string that tells a seller nothing and
 * reads as a Studio crash. Transcription is restartable from here: going live
 * again publishes a fresh stream, so this states the recovery.
 */
export const PUBLISHER_STREAM_ENDED_MESSAGE =
  'The microphone for this event is no longer live, so captions could not start. Start the event again to resume transcription.';

/**
 * Whether a stream can still feed the audio recorder.
 *
 * A publisher teardown calls `track.stop()` on the tracks but leaves the
 * MediaStream OBJECT intact, so holding a non-null stream proves nothing about
 * whether it can be recorded — only track `readyState` does.
 */
export function hasLiveAudioTrack(stream: MediaStream): boolean {
  const tracks = typeof stream.getAudioTracks === 'function'
    ? stream.getAudioTracks()
    : stream.getTracks?.().filter((track) => track.kind === 'audio') ?? [];
  return tracks.some((track) => track.readyState === 'live');
}

function browserWebSocketFactory(url: string, protocols?: string | string[]): WebSocketLike {
  if (typeof WebSocket === 'undefined') throw new Error('WebSocket is unavailable in this browser.');
  return new WebSocket(url, protocols) as unknown as WebSocketLike;
}

/**
 * Containers Deepgram's live endpoint decodes from a MediaRecorder stream, best first.
 *
 * `buildDeepgramUrl` sets NO `encoding`/`container` parameter, so Deepgram SNIFFS the container
 * — which only works for the ones it actually understands. Every entry here is Opus in a
 * container Deepgram documents support for.
 *
 * ⚠ `audio/mp4` — what Safari/iOS produce, and the ONLY thing they produce — is DELIBERATELY
 * ABSENT. Safari's MediaRecorder emits fragmented MP4/AAC, and nobody has yet measured whether
 * Deepgram's live endpoint decodes that from a chunked socket. Adding it unverified would trade
 * a LOUD failure for a SILENT one (a socket that opens and returns no transcripts) — which is
 * the exact symptom WI-39774 exists to remove. Until someone measures it against a real grant
 * token, a browser that can only record MP4 is routed to Web Speech instead (see
 * ConfiguredProviderSession.start) rather than sent to Deepgram to fail quietly.
 */
export const DEEPGRAM_RECORDER_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
] as const;

/** What a browser with no Deepgram-compatible container must say instead of a raw platform string. */
export const DEEPGRAM_UNSUPPORTED_BROWSER_MESSAGE =
  'This browser cannot record audio in a format Deepgram accepts. Use Chrome, Edge or Firefox for Deepgram captions.';

/**
 * The first Deepgram-compatible mimeType this browser can actually record, or `null` if none.
 *
 * Before WI-39774 the recorder was constructed with a HARDCODED `audio/webm;codecs=opus`, so on
 * any browser without WebM (Safari, every iOS browser) `new MediaRecorder(...)` threw
 * NotSupportedError the instant the Deepgram socket opened — no captions, and a raw platform
 * string as the only explanation.
 *
 * A browser with no `isTypeSupported` to ask keeps the previous behaviour (the preferred type)
 * rather than being refused: the probe is there to catch a browser that says NO, never to reject
 * one that cannot answer.
 */
export function pickDeepgramRecorderMimeType(
  isTypeSupported?: (type: string) => boolean,
): string | null {
  const supports = isTypeSupported
    ?? (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
      ? (type: string) => MediaRecorder.isTypeSupported(type)
      : null);
  if (!supports) return DEEPGRAM_RECORDER_MIME_TYPES[0];
  return DEEPGRAM_RECORDER_MIME_TYPES.find((type) => supports(type)) ?? null;
}

/**
 * The stream the Deepgram recorder actually consumes: the audio tracks only.
 *
 * The publisher hands its full A/V localStream to transcription, and Chromium
 * refuses an audio-only mimeType over a stream that carries a video track —
 * `recorder.start()` throws the raw "Failed to execute 'start' on
 * 'MediaRecorder'" platform string (WI-39774: the prod captions death on every
 * Chromium browser). Recording from a rebuilt audio-only stream keeps the
 * mimeType and the tracks consistent. Rebuilding only REFERENCES the tracks:
 * the publisher's stream is untouched, and the recorder still stops yielding
 * data when the publisher stops those same tracks.
 *
 * A stream with no video tracks is returned as-is, and an environment without
 * a `MediaStream` constructor keeps the original stream rather than gaining a
 * new failure mode here.
 */
export function deepgramRecorderInputStream(stream: MediaStream): MediaStream {
  const videoTracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
  if (videoTracks.length === 0) return stream;
  if (typeof MediaStream === 'undefined' || typeof stream.getAudioTracks !== 'function') return stream;
  return new MediaStream(stream.getAudioTracks());
}

function browserMediaRecorderFactory(stream: MediaStream): MediaRecorderLike {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is unavailable in this browser.');
  const mimeType = pickDeepgramRecorderMimeType();
  if (!mimeType) throw new Error(DEEPGRAM_UNSUPPORTED_BROWSER_MESSAGE);
  return new MediaRecorder(deepgramRecorderInputStream(stream), { mimeType }) as unknown as MediaRecorderLike;
}

/**
 * Translate a recorder start failure into something the Studio can act on.
 *
 * Chrome reports an unrecordable stream as "Failed to execute 'start' on
 * 'MediaRecorder': There was an error starting the MediaRecorder." — true of a
 * dead stream, an unsupported mimeType and a seized device alike. When the
 * tracks are provably gone we can name the cause and the recovery; otherwise
 * the platform text is preserved as the cause rather than guessed at.
 */
function recorderStartError(error: unknown, stream: MediaStream): Error {
  if (!hasLiveAudioTrack(stream)) {
    const ended = new Error(PUBLISHER_STREAM_ENDED_MESSAGE);
    if (error !== undefined) (ended as Error & { cause?: unknown }).cause = error;
    return ended;
  }
  return error instanceof Error ? error : new Error(String(error));
}

function browserSpeechRecognitionFactory(): SpeechRecognitionLike {
  const browser = globalThis as typeof globalThis & {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  if (!Constructor) throw new Error('Web Speech recognition is unavailable in this browser.');
  return new Constructor();
}

abstract class BaseSession implements TranscriptionSession {
  abstract readonly provider: TranscriptionProvider;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  protected currentState: TranscriptionState = 'idle';
  private readonly segmentListeners = new Set<SegmentListener>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private sequence = 0;

  get state(): TranscriptionState {
    return this.currentState;
  }

  onSegment(listener: SegmentListener): () => void {
    this.segmentListeners.add(listener);
    return () => this.segmentListeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  protected setState(state: TranscriptionState): void {
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }

  protected emitError(error: unknown): void {
    const normalized: TranscriptionError = {
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    };
    this.setState('error');
    for (const listener of this.errorListeners) listener(normalized);
  }

  protected emitSegment(segment: Omit<TranscriptSegment, 'id' | 'provider' | 'receivedAt'>): void {
    const next: TranscriptSegment = {
      ...segment,
      id: `${this.provider}-${++this.sequence}`,
      provider: this.provider,
      receivedAt: Date.now(),
    };
    if (!next.text.trim()) return;
    for (const listener of this.segmentListeners) listener(next);
  }
}

interface DeepgramMessage {
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}

export function buildDeepgramUrl(options: Pick<TranscriptionOptions, 'deepgramUrl' | 'model' | 'language'>): string {
  const url = new URL(options.deepgramUrl ?? DEFAULT_DEEPGRAM_URL);
  url.searchParams.set('model', options.model ?? DEFAULT_DEEPGRAM_MODEL);
  url.searchParams.set('language', options.language ?? DEFAULT_TRANSCRIPTION_LANGUAGE);
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('punctuate', 'true');
  return url.toString();
}

const DEFAULT_API_ORIGIN = 'http://localhost:3110';

interface DeepgramTokenGrant {
  accessToken?: unknown;
  expiresIn?: unknown;
  code?: unknown;
  message?: unknown;
}

export interface DeepgramTokenRequestOptions {
  /** Canonical demo principal used by the SideStage seller boundary. */
  principal?: string;
  fetchImpl?: typeof fetch;
}

/** Fetch one 30-second JWT at connection start; never persist or cache it. */
export async function requestDeepgramToken(
  apiBaseUrl?: string,
  options: DeepgramTokenRequestOptions = {},
): Promise<string | null> {
  const apiOrigin = (apiBaseUrl || DEFAULT_API_ORIGIN).replace(/\/+$/, '');
  const principal = options.principal?.trim();
  const response = await (options.fetchImpl ?? globalThis.fetch)(`${apiOrigin}/transcription/deepgram-token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      ...(principal ? { [DEMO_PRINCIPAL_HEADER]: principal } : {}),
    },
  });
  let body: DeepgramTokenGrant = {};
  try {
    body = await response.json() as DeepgramTokenGrant;
  } catch {
    // The bounded status error below is safer than reflecting an arbitrary body.
  }
  if (response.status === 503 && body.code === 'deepgram_not_configured') return null;
  if (!response.ok) {
    throw new Error(typeof body.message === 'string'
      ? body.message
      : `Deepgram token request failed (${response.status}).`);
  }
  const token = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
  if (!token) throw new Error('Deepgram token response was invalid.');
  return token;
}

class DeepgramSession extends BaseSession {
  readonly provider = 'deepgram' as const;
  private socket: WebSocketLike | null = null;
  private recorder: MediaRecorderLike | null = null;
  private stopping = false;
  /**
   * Bumped by every start and every stop so an in-flight attempt can tell it
   * has been superseded. `start` awaits a token grant and then a socket open;
   * without this, a stop landing inside either gap still ran to completion —
   * attaching a recorder and reporting `listening` for an event the seller had
   * already ended, and leaking the capture that fed it (WI-39726).
   */
  private generation = 0;

  constructor(private readonly options: TranscriptionOptions) {
    super();
  }

  private superseded(generation: number): boolean {
    return this.stopping || generation !== this.generation;
  }

  /**
   * Refuse a start the same way a failed one reports: listeners see the reason
   * and the state turns `error`, so a caller that only subscribes still learns
   * why captions stopped instead of watching a silent `idle`.
   */
  private refuseStart(message: string): never {
    const error = new Error(message);
    this.emitError(error);
    throw error;
  }

  async start(): Promise<void> {
    if (this.currentState === 'listening' || this.currentState === 'connecting') return;
    const stream = this.options.mediaStream;
    if (!stream) this.refuseStart(PUBLISHER_STREAM_REQUIRED_MESSAGE);
    /*
     * Liveness is re-checked HERE, not trusted from construction (WI-39726).
     *
     * Switching events tears down the previous room's publisher, which stops
     * the tracks but keeps the same MediaStream object, so a session built for
     * the old event still holds a non-null — and unrecordable — stream. Failing
     * before the token spend keeps a dead stream from reaching MediaRecorder,
     * where Chrome answers with a raw platform string instead of anything a
     * seller can act on.
     */
    if (!hasLiveAudioTrack(stream)) this.refuseStart(PUBLISHER_STREAM_ENDED_MESSAGE);
    const generation = ++this.generation;
    this.stopping = false;
    this.setState('connecting');
    try {
      const token = (this.options.deepgramToken ?? await this.options.deepgramTokenProvider?.())?.trim();
      if (this.superseded(generation)) return;
      if (!token) throw new Error('A short-lived Deepgram token is required.');
      const factory = this.options.webSocketFactory ?? browserWebSocketFactory;
      const recorderFactory = this.options.mediaRecorderFactory ?? browserMediaRecorderFactory;
      const socket = factory(buildDeepgramUrl(this.options), ['bearer', token]);
      if (this.superseded(generation)) {
        try { socket.close(1000, 'transcription superseded'); } catch { /* already closing */ }
        return;
      }
      this.socket = socket;
      const opened = new Promise<void>((resolve, reject) => {
        socket.onopen = () => {
          if (this.superseded(generation)) {
            try { socket.close(1000, 'transcription superseded'); } catch { /* already closing */ }
            resolve();
            return;
          }
          let recorder: MediaRecorderLike;
          try {
            // The stream can end between the guard above and the socket open —
            // the whole window this bug lives in — so it is re-checked once more
            // against the recorder that is about to consume it.
            if (!hasLiveAudioTrack(stream)) throw new Error(PUBLISHER_STREAM_ENDED_MESSAGE);
            recorder = recorderFactory(stream);
            recorder.ondataavailable = (event) => {
              if (event.data.size > 0 && socket.readyState === OPEN_SOCKET) socket.send(event.data);
            };
            recorder.onerror = (event) => this.emitError(event);
            recorder.start(250);
          } catch (error) {
            reject(recorderStartError(error, stream));
            return;
          }
          this.recorder = recorder;
          this.setState('listening');
          resolve();
        };
        socket.onmessage = (event) => this.handleMessage(event.data);
        socket.onerror = (event) => this.emitError(event);
        socket.onclose = (event) => {
          if (!this.stopping && this.currentState !== 'error') {
            this.emitError(new Error(event.reason || `Deepgram connection closed (${event.code ?? 'unknown'}).`));
          }
        };
      });
      await opened;
    } catch (error) {
      this.cleanup();
      this.emitError(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Supersede an in-flight start even from idle/stopped: the attempt that is
    // mid-await has not reached `listening` yet, so the state guard below would
    // otherwise let it finish and re-open capture after the seller stopped.
    this.generation += 1;
    this.stopping = true;
    if (this.currentState === 'stopped' || this.currentState === 'idle') return;
    this.cleanup();
    this.setState('stopped');
  }

  private handleMessage(data: unknown): void {
    try {
      if (typeof data !== 'string') return;
      const message = JSON.parse(data) as DeepgramMessage;
      const transcript = message.channel?.alternatives?.[0]?.transcript?.trim();
      if (!transcript) return;
      const startMs = typeof message.start === 'number' ? Math.round(message.start * 1_000) : undefined;
      const endMs = startMs !== undefined && typeof message.duration === 'number'
        ? startMs + Math.round(message.duration * 1_000)
        : undefined;
      this.emitSegment({ text: transcript, isFinal: Boolean(message.is_final || message.speech_final), startMs, endMs });
    } catch (error) {
      this.emitError(error);
    }
  }

  private cleanup(): void {
    // Our own close must not re-enter `onclose` as a connection error. Without
    // this, tearing down after a failed start reported "seller stopped
    // transcription" as an error the seller never caused, ahead of the real one.
    this.stopping = true;
    try { this.recorder?.stop(); } catch { /* recorder may already be stopped */ }
    this.recorder = null;
    this.socket?.close(1000, 'seller stopped transcription');
    this.socket = null;
  }
}

class WebSpeechSession extends BaseSession {
  readonly provider = 'web-speech' as const;
  private recognition: SpeechRecognitionLike | null = null;
  private stopping = false;

  constructor(private readonly options: TranscriptionOptions) {
    super();
  }

  async start(): Promise<void> {
    if (this.currentState === 'listening') return;
    this.stopping = false;
    this.setState('connecting');
    try {
      const recognition = (this.options.speechRecognitionFactory ?? browserSpeechRecognitionFactory)();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = this.options.language ?? DEFAULT_TRANSCRIPTION_LANGUAGE;
      recognition.onresult = (event) => {
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript?.trim();
          if (transcript) this.emitSegment({ text: transcript, isFinal: Boolean(result?.isFinal) });
        }
      };
      recognition.onerror = (event) => this.emitError(new Error(`Web Speech error: ${event.error ?? 'unknown'}`));
      recognition.onend = () => {
        if (!this.stopping && this.currentState === 'listening') {
          try { recognition.start(); } catch (error) { this.emitError(error); }
        }
      };
      this.recognition = recognition;
      recognition.start();
      this.setState('listening');
    } catch (error) {
      this.emitError(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.currentState === 'stopped' || this.currentState === 'idle') return;
    this.stopping = true;
    try { this.recognition?.stop(); } catch { /* recognition may already be stopped */ }
    this.recognition?.abort?.();
    this.recognition = null;
    this.setState('stopped');
  }
}

/**
 * Resolves the server capability before selecting a transport. Only a null
 * token (the API's explicit not-configured signal) permits Web Speech; rejected
 * grants and network failures stay visible as Deepgram errors.
 */
class ConfiguredProviderSession extends BaseSession {
  private active: TranscriptionSession | null = null;
  private removeListeners: Array<() => void> = [];

  constructor(private readonly options: TranscriptionOptions) {
    super();
  }

  get provider(): TranscriptionProvider {
    return this.active?.provider ?? 'deepgram';
  }

  async start(): Promise<void> {
    if (this.currentState === 'listening' || this.currentState === 'connecting') return;
    this.setState('connecting');
    try {
      const token = (this.options.deepgramToken ?? await this.options.deepgramTokenProvider?.())?.trim() || null;
      /*
       * A token is necessary but NOT sufficient (WI-39774). Deepgram capture runs through
       * MediaRecorder, and a browser that cannot record any container Deepgram decodes (Safari,
       * every iOS browser) would take the Deepgram path and die at recorder construction — with
       * captions configured to fall back, and a Web Speech engine sitting right there unused.
       *
       * This is a CAPABILITY check, not error-swallowing: it is decided before the token is
       * spent, from the browser's own answer, with no network involved. Grant failures and
       * network errors still surface as Deepgram errors exactly as before — see this class's
       * header. An injected mediaRecorderFactory owns its own format choice, so it is trusted.
       */
      const canRecordForDeepgram = this.options.mediaRecorderFactory !== undefined
        || pickDeepgramRecorderMimeType(this.options.isTypeSupported) !== null;
      const next = token && canRecordForDeepgram
        ? new DeepgramSession({ ...this.options, deepgramToken: token, deepgramTokenProvider: undefined })
        : new WebSpeechSession(this.options);
      this.active = next;
      this.removeListeners = [
        next.onSegment((segment) => this.emitSegment({
          text: segment.text,
          isFinal: segment.isFinal,
          startMs: segment.startMs,
          endMs: segment.endMs,
        })),
        next.onState((state) => this.setState(state)),
        next.onError((error) => this.emitError(error.cause ?? new Error(error.message))),
      ];
      await next.start();
    } catch (error) {
      this.cleanupListeners();
      this.active = null;
      this.emitError(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const active = this.active;
    this.active = null;
    if (active) await active.stop();
    this.cleanupListeners();
    this.setState('stopped');
  }

  private cleanupListeners(): void {
    for (const remove of this.removeListeners) remove();
    this.removeListeners = [];
  }
}

export function createTranscriptionSession(options: TranscriptionOptions = {}): TranscriptionSession {
  if (options.deepgramTokenProvider && options.fallbackToWebSpeech) {
    return new ConfiguredProviderSession(options);
  }
  if (options.deepgramToken || options.deepgramTokenProvider) return new DeepgramSession(options);
  return new WebSpeechSession(options);
}
