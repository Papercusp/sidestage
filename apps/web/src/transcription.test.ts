import { describe, expect, it, vi } from 'vitest';
import { buildDeepgramUrl, createTranscriptionSession, requestDeepgramToken, type MediaRecorderLike, type SpeechRecognitionLike, type WebSocketLike } from './transcription';

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

class FakeRecorder implements MediaRecorderLike {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  started = false;
  stopped = false;
  start() { this.started = true; }
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
      mediaStream: {} as MediaStream,
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
      mediaStream: {} as MediaStream,
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
      sellerAccessToken: 'seller-session-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }))
      .resolves.toBe('temporary-jwt');
    expect(fetchImpl).toHaveBeenCalledWith('https://api.sidestage.test/transcription/deepgram-token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        authorization: 'Bearer seller-session-token',
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
      sellerAccessToken: 'seller-session-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toBeNull();
  });

  it('keeps seller authorization failures visible instead of treating them as a fallback signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ message: 'A valid seller credential is required.' }),
    } as unknown as Response);

    await expect(requestDeepgramToken(undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow('A valid seller credential is required.');
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
