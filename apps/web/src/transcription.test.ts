import { describe, expect, it, vi } from 'vitest';
import { buildDeepgramUrl, createTranscriptionSession, type MediaRecorderLike, type SpeechRecognitionLike, type WebSocketLike } from './transcription';

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
  it('builds a Deepgram URL with an ephemeral token and interim settings', () => {
    const url = new URL(buildDeepgramUrl({ deepgramToken: 'ephemeral-token', language: 'en-US' }));
    expect(url.protocol).toBe('wss:');
    expect(url.searchParams.get('token')).toBe('ephemeral-token');
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
