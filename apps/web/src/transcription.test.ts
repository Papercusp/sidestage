import { describe, expect, it, vi } from 'vitest';
import {
  buildDeepgramUrl,
  createTranscriptionSession,
  hasLiveAudioTrack,
  PUBLISHER_STREAM_ENDED_MESSAGE,
  requestDeepgramToken,
  type MediaRecorderLike,
  type SpeechRecognitionLike,
  type WebSocketLike,
} from './transcription';

/**
 * A publisher stream that can be ended the way `connectPublisher`'s teardown
 * ends one: the tracks stop, the MediaStream object survives (WI-39726).
 */
function publisherStream() {
  const track = { kind: 'audio', readyState: 'live' as MediaStreamTrackState, stop() { track.readyState = 'ended'; } };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, endTracks: () => track.stop() };
}

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  sent: unknown[] = [];
  send(data: unknown) { this.sent.push(data); }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({ data }); }
}

/**
 * Chrome's observed contract: `.start()` against a stream with no live audio
 * track throws this exact platform string — the failure WI-39726 reported.
 */
class FakeRecorder implements MediaRecorderLike {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  started = false;
  stopped = false;
  constructor(private readonly stream?: MediaStream) {}
  start() {
    if (this.stream && !hasLiveAudioTrack(this.stream)) {
      throw new Error("Failed to execute 'start' on 'MediaRecorder': There was an error starting the MediaRecorder.");
    }
    this.started = true;
  }
  stop() { this.stopped = true; }
  data() { this.ondataavailable?.({ data: new Blob(['audio']) }); }
}

class FakeRecognition implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = '';
  onresult: SpeechRecognitionLike['onresult'] = null;
  onerror: SpeechRecognitionLike['onerror'] = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;
  start() { this.started = true; }
  stop() { this.stopped = true; }
  emit(text: string, isFinal: boolean) {
    this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal }] });
  }
}

describe('transcription transport', () => {
  it('keeps credentials out of the Deepgram URL while preserving listen settings', () => {
    const url = new URL(buildDeepgramUrl({ language: 'en-US' }));
    expect(url.protocol).toBe('wss:');
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.searchParams.get('interim_results')).toBe('true');
    expect(url.searchParams.get('model')).toBe('nova-3');
  });

  it('streams recorder chunks to Deepgram and emits final/interim segments', async () => {
    const socket = new FakeSocket();
    const recorder = new FakeRecorder();
    const session = createTranscriptionSession({
      mediaStream: publisherStream().stream,
      deepgramToken: 'ephemeral-token',
      webSocketFactory: vi.fn(() => socket),
      mediaRecorderFactory: vi.fn(() => recorder),
    });
    const segments: string[] = [];
    session.onSegment((segment) => segments.push(`${segment.isFinal ? 'final' : 'interim'}:${segment.text}`));
    const started = session.start();
    socket.open();
    await started;
    expect(session.provider).toBe('deepgram');
    recorder.data();
    socket.message(JSON.stringify({ is_final: false, channel: { alternatives: [{ transcript: 'hello' }] } }));
    socket.message(JSON.stringify({ is_final: true, start: 1.2, duration: 0.8, channel: { alternatives: [{ transcript: 'hello world' }] } }));
    expect(recorder.started).toBe(true);
    expect(socket.sent).toHaveLength(1);
    expect(segments).toEqual(['interim:hello', 'final:hello world']);
    await session.stop();
    expect(recorder.stopped).toBe(true);
    expect(session.state).toBe('stopped');
  });

  it('authenticates a temporary JWT with the browser WebSocket subprotocol', async () => {
    const socket = new FakeSocket();
    const webSocketFactory = vi.fn(() => socket);
    const session = createTranscriptionSession({
      mediaStream: publisherStream().stream,
      deepgramTokenProvider: async () => 'temporary-jwt',
      webSocketFactory,
      mediaRecorderFactory: () => new FakeRecorder(),
    });

    const started = session.start();
    await vi.waitFor(() => expect(webSocketFactory).toHaveBeenCalledOnce());
    socket.open();
    await started;

    expect(webSocketFactory).toHaveBeenCalledWith(
      expect.not.stringContaining('temporary-jwt'),
      ['bearer', 'temporary-jwt'],
    );
  });

  it('uses Web Speech only when the token API explicitly reports Deepgram unconfigured', async () => {
    const recognition = new FakeRecognition();
    const session = createTranscriptionSession({
      deepgramTokenProvider: async () => null,
      fallbackToWebSpeech: true,
      speechRecognitionFactory: () => recognition,
    });

    await session.start();

    expect(session.provider).toBe('web-speech');
    expect(recognition.started).toBe(true);
  });

  it('requests a fresh token from the SideStage API without caching it in the client', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: vi.fn().mockResolvedValue({ accessToken: 'temporary-jwt', expiresIn: 30 }),
    } as unknown as Response);

    await expect(requestDeepgramToken('https://api.sidestage.test/', {
      principal: 'demo-27',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }))
      .resolves.toBe('temporary-jwt');
    expect(fetchImpl).toHaveBeenCalledWith('https://api.sidestage.test/transcription/deepgram-token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'x-demo-principal': 'demo-27',
      },
    });
  });

  it('maps only the explicit unconfigured API response to the Web Speech fallback signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn().mockResolvedValue({ code: 'deepgram_not_configured' }),
    } as unknown as Response);

    await expect(requestDeepgramToken(undefined, {
      principal: 'seller-demo',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toBeNull();
  });

  it('keeps missing-principal failures visible instead of treating them as a fallback signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ message: 'x-demo-principal is required for seller-owned resources.' }),
    } as unknown as Response);

    await expect(requestDeepgramToken(undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow('x-demo-principal is required for seller-owned resources.');
  });

  it('uses Web Speech when no Deepgram token is configured', async () => {
    const recognition = new FakeRecognition();
    const session = createTranscriptionSession({
      language: 'en-US',
      speechRecognitionFactory: () => recognition,
    });
    const texts: string[] = [];
    session.onSegment((segment) => texts.push(segment.text));
    await session.start();
    recognition.emit('buyer asks about the mug', false);
    recognition.emit('buyer asks about the mug.', true);
    expect(session.provider).toBe('web-speech');
    expect(recognition.started).toBe(true);
    expect(recognition.continuous).toBe(true);
    expect(texts).toEqual(['buyer asks about the mug', 'buyer asks about the mug.']);
    await session.stop();
    expect(recognition.stopped).toBe(true);
  });
});

/*
 * WI-39726 — switching to an active event threw "Failed to execute 'start' on
 * 'MediaRecorder'" in the seller Studio.
 *
 * The session captures the publisher's MediaStream when it is built. Ending the
 * previous event stops that stream's TRACKS but leaves the object in place, so
 * "we still hold a stream" stayed true while "the stream can be recorded" had
 * become false — and a restart handed the dead stream straight to Chrome.
 */
describe('publisher stream liveness (WI-39726)', () => {
  it('reads track state, not stream presence, as the recordability signal', () => {
    const publisher = publisherStream();
    expect(hasLiveAudioTrack(publisher.stream)).toBe(true);
    publisher.endTracks();
    expect(hasLiveAudioTrack(publisher.stream)).toBe(false);
  });

  it('refuses to restart on the previous event\'s ended stream instead of throwing the browser error', async () => {
    const publisher = publisherStream();
    const sockets: FakeSocket[] = [];
    const recorders: FakeRecorder[] = [];
    const session = createTranscriptionSession({
      mediaStream: publisher.stream,
      deepgramToken: 'ephemeral-token',
      webSocketFactory: vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket; }),
      mediaRecorderFactory: vi.fn((stream) => { const r = new FakeRecorder(stream); recorders.push(r); return r; }),
    });
    const errors: string[] = [];
    session.onError((error) => errors.push(error.message));

    const started = session.start();
    sockets[0].open();
    await started;
    expect(session.state).toBe('listening');

    // The seller ends the event: publisher teardown stops the tracks.
    publisher.endTracks();
    await session.stop();

    // Switching to the next active event re-activates transcription.
    await expect(session.start()).rejects.toThrow(PUBLISHER_STREAM_ENDED_MESSAGE);

    // No second recorder was ever built, so Chrome's raw message cannot appear.
    expect(recorders).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    expect(errors).toEqual([PUBLISHER_STREAM_ENDED_MESSAGE]);
    expect(errors.join(' ')).not.toContain('Failed to execute');
    expect(session.state).toBe('error');
  });

  it('recovers on the next event: a fresh live stream starts cleanly', async () => {
    const ended = publisherStream();
    ended.endTracks();
    const sockets: FakeSocket[] = [];
    const deadSession = createTranscriptionSession({
      mediaStream: ended.stream,
      deepgramToken: 'ephemeral-token',
      webSocketFactory: vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket; }),
      mediaRecorderFactory: vi.fn((stream) => new FakeRecorder(stream)),
    });
    await expect(deadSession.start()).rejects.toThrow(PUBLISHER_STREAM_ENDED_MESSAGE);
    // The token is never spent and no socket is opened for a stream that cannot
    // be recorded.
    expect(sockets).toHaveLength(0);

    const fresh = publisherStream();
    const socket = new FakeSocket();
    const recorder = new FakeRecorder(fresh.stream);
    const liveSession = createTranscriptionSession({
      mediaStream: fresh.stream,
      deepgramToken: 'ephemeral-token',
      webSocketFactory: vi.fn(() => socket),
      mediaRecorderFactory: vi.fn(() => recorder),
    });
    const started = liveSession.start();
    socket.open();
    await started;
    expect(liveSession.state).toBe('listening');
    expect(recorder.started).toBe(true);
  });

  it('cancels a start that a stop superseded while the token was in flight', async () => {
    const publisher = publisherStream();
    const sockets: FakeSocket[] = [];
    const recorders: FakeRecorder[] = [];
    let grantToken: (token: string) => void = () => {};
    const session = createTranscriptionSession({
      mediaStream: publisher.stream,
      deepgramTokenProvider: () => new Promise<string>((resolve) => { grantToken = resolve; }),
      webSocketFactory: vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket; }),
      mediaRecorderFactory: vi.fn((stream) => { const r = new FakeRecorder(stream); recorders.push(r); return r; }),
    });

    const pending = session.start();
    await session.stop();      // the seller ends the event mid-grant
    grantToken('ephemeral-token');
    await pending;

    // The superseded attempt must not open capture behind the seller's back.
    expect(recorders).toHaveLength(0);
    expect(session.state).toBe('stopped');
  });
});
