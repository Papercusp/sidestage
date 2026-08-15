import { describe, expect, it } from 'vitest';
import {
  InMemoryScoutSessionStore,
  ifNoneMatchMatches,
  transcriptEtag,
  transcriptVersion,
  visibleTranscript,
} from './scout-session.store';
import type { ScoutMessage } from './scout.types';

const msg = (role: 'user' | 'assistant', content: string): ScoutMessage => ({
  role,
  content,
  ts: '2026-08-14T00:00:00.000Z',
});

describe('transcriptVersion', () => {
  it('changes when a message is appended', () => {
    const at = '2026-08-14T00:00:00.000Z';
    const before = transcriptVersion({ messages: [msg('user', 'hi')], lastActiveAt: at });
    const after = transcriptVersion({
      messages: [msg('user', 'hi'), msg('assistant', 'hello')],
      lastActiveAt: at,
    });
    expect(after).not.toBe(before);
  });

  it('changes when the last message is edited in place — the count alone would not', () => {
    const messages = [msg('user', 'hi')];
    const before = transcriptVersion({ messages, lastActiveAt: '2026-08-14T00:00:00.000Z' });
    const after = transcriptVersion({ messages, lastActiveAt: '2026-08-14T00:00:05.000Z' });
    expect(after).not.toBe(before);
  });
});

describe('ifNoneMatchMatches', () => {
  const etag = transcriptEtag('s1', '2-2026-08-14T00:00:00.000Z');

  it('matches the single validator it issued', () => {
    expect(ifNoneMatchMatches(etag, etag)).toBe(true);
  });

  it('matches inside a COMMA-SEPARATED list — the RFC shape a naive equality test misses', () => {
    expect(ifNoneMatchMatches(`W/"other", ${etag}, W/"third"`, etag)).toBe(true);
  });

  it('does not match a different or absent validator', () => {
    expect(ifNoneMatchMatches('W/"other"', etag)).toBe(false);
    expect(ifNoneMatchMatches(undefined, etag)).toBe(false);
  });

  it('does not match on a mere substring — a prefix of the etag is a DIFFERENT version', () => {
    const older = transcriptEtag('s1', '1-2026-08-14T00:00:00.000Z');
    expect(ifNoneMatchMatches(older, etag)).toBe(false);
    // A truncated validator must not satisfy the full one.
    expect(ifNoneMatchMatches(etag.slice(0, etag.length - 2), etag)).toBe(false);
  });
});

describe('visibleTranscript', () => {
  it('keeps user + assistant turns in order', () => {
    expect(visibleTranscript([msg('user', 'hi'), msg('assistant', 'hello')])).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('drops blank turns so the restored drawer has no empty bubbles', () => {
    expect(visibleTranscript([msg('assistant', '   '), msg('user', 'hi')])).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });
});

describe('InMemoryScoutSessionStore', () => {
  it('creates on first append and accumulates across turns', async () => {
    const store = new InMemoryScoutSessionStore();
    expect(await store.get('buyer-a', 's1')).toBeNull();

    await store.append('buyer-a', 's1', [msg('user', 'hi')]);
    const after = await store.append('buyer-a', 's1', [msg('assistant', 'hello')]);

    expect(after.messages.map((m) => m.content)).toEqual(['hi', 'hello']);
    expect((await store.get('buyer-a', 's1'))?.messages).toHaveLength(2);
  });

  it('returns a copy — a caller mutating the result cannot corrupt the store', async () => {
    const store = new InMemoryScoutSessionStore();
    const session = await store.append('buyer-a', 's1', [msg('user', 'hi')]);
    session.messages.push(msg('assistant', 'injected'));
    expect((await store.get('buyer-a', 's1'))?.messages).toHaveLength(1);
  });

  it('makes a foreign session indistinguishable from a missing one and preserves its owner', async () => {
    const store = new InMemoryScoutSessionStore();
    await store.append('buyer-a', 's1', [msg('user', 'secret')]);

    expect(await store.get('buyer-b', 's1')).toBeNull();
    expect(await store.get('buyer-b', 'missing')).toBeNull();
    await expect(store.append('buyer-b', 's1', [msg('user', 'takeover')]))
      .rejects.toThrow('Scout session not found');
    expect((await store.get('buyer-a', 's1'))?.messages.map((message) => message.content))
      .toEqual(['secret']);
  });
});
