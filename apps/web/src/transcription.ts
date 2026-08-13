/**
 * Provider-neutral live transcription for the seller stage.
 *
 * A short-lived Deepgram token keeps the permanent API key on the server. If
 * no token is configured, the browser Web Speech API is used as a local demo
 * fallback. Both providers emit the same interim/final segment contract so a
 * transcript pane does not need to know which transport is active.
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

export type DeepgramTokenProvider = () => Promise<string>;

export interface WebSocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

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
  deepgramUrl?: string;
  model?: string;
  language?: string;
  webSocketFactory?: WebSocketFactory;
  mediaRecorderFactory?: MediaRecorderFactory;
  speechRecognitionFactory?: SpeechRecognitionFactory;
}

export const DEFAULT_DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';
export const DEFAULT_DEEPGRAM_MODEL = 'nova-3';
export const DEFAULT_TRANSCRIPTION_LANGUAGE = 'en-US';
const OPEN_SOCKET = 1;

function browserWebSocketFactory(url: string): WebSocketLike {
  if (typeof WebSocket === 'undefined') throw new Error('WebSocket is unavailable in this browser.');
  return new WebSocket(url) as unknown as WebSocketLike;
}

function browserMediaRecorderFactory(stream: MediaStream): MediaRecorderLike {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is unavailable in this browser.');
  return new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' }) as unknown as MediaRecorderLike;
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

export function buildDeepgramUrl(options: Pick<TranscriptionOptions, 'deepgramUrl' | 'deepgramToken' | 'model' | 'language'>): string {
  const url = new URL(options.deepgramUrl ?? DEFAULT_DEEPGRAM_URL);
  url.searchParams.set('model', options.model ?? DEFAULT_DEEPGRAM_MODEL);
  url.searchParams.set('language', options.language ?? DEFAULT_TRANSCRIPTION_LANGUAGE);
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('punctuate', 'true');
  // Deepgram ephemeral tokens are intentionally scoped to this in-memory URL.
  if (options.deepgramToken) url.searchParams.set('token', options.deepgramToken);
  return url.toString();
}

class DeepgramSession extends BaseSession {
  readonly provider = 'deepgram' as const;
  private socket: WebSocketLike | null = null;
  private recorder: MediaRecorderLike | null = null;
  private stopping = false;

  constructor(private readonly options: TranscriptionOptions) {
    super();
  }

  async start(): Promise<void> {
    if (this.currentState === 'listening' || this.currentState === 'connecting') return;
    if (!this.options.mediaStream) throw new Error('Deepgram transcription requires the publisher media stream.');
    this.stopping = false;
    this.setState('connecting');
    try {
      const token = (this.options.deepgramToken ?? await this.options.deepgramTokenProvider?.())?.trim();
      if (!token) throw new Error('A short-lived Deepgram token is required.');
      const factory = this.options.webSocketFactory ?? browserWebSocketFactory;
      const recorderFactory = this.options.mediaRecorderFactory ?? browserMediaRecorderFactory;
      const socket = factory(buildDeepgramUrl({ ...this.options, deepgramToken: token }));
      this.socket = socket;
      const opened = new Promise<void>((resolve, reject) => {
        socket.onopen = () => {
          try {
            const recorder = recorderFactory(this.options.mediaStream!);
            recorder.ondataavailable = (event) => {
              if (event.data.size > 0 && socket.readyState === OPEN_SOCKET) socket.send(event.data);
            };
            recorder.onerror = (event) => this.emitError(event);
            this.recorder = recorder;
            recorder.start(250);
            this.setState('listening');
            resolve();
          } catch (error) {
            reject(error);
          }
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
    if (this.currentState === 'stopped' || this.currentState === 'idle') return;
    this.stopping = true;
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

export function createTranscriptionSession(options: TranscriptionOptions = {}): TranscriptionSession {
  if (options.deepgramToken || options.deepgramTokenProvider) return new DeepgramSession(options);
  return new WebSpeechSession(options);
}
