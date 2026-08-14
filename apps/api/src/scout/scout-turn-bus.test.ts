import { afterEach, describe, expect, it } from 'vitest';
import { _resetChannelsForTest } from '@papercusp/sse';
import { ScoutTurnBusService } from './scout-turn-bus.service';
import type { ScoutStreamEvent } from './scout.types';

/**
 * The reconnect-safe property, tested at the seam that owns it.
 *
 * What makes a dropped connection recoverable is that the TURN does not live on
 * the connection: it runs detached into a ring-buffer channel, and a resuming
 * client replays from `recentSince(lastEventId)`. These tests exercise exactly
 * that — a turn is consumed, "the connection drops", and a second reader
 * recovers the missed events without the turn being restarted.
 */

afterEach(() => {
  _resetChannelsForTest();
});

async function drain(bus: ScoutTurnBusService, turnId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const off = bus.channel(turnId).onDone(() => {
      off();
      resolve();
    });
  });
}

function turnOf(events: ScoutStreamEvent[]): AsyncGenerator<ScoutStreamEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

const TURN: ScoutStreamEvent[] = [
  { type: 'session', sessionId: 's1' },
  { type: 'tool_start', tool: 'search_catalog' },
  { type: 'products', products: [] },
  { type: 'token', content: 'hello ' },
  { type: 'token', content: 'world' },
  { type: 'done' },
];

describe('ScoutTurnBusService', () => {
  it('publishes every event of a detached turn, with monotonic ids', async () => {
    const bus = new ScoutTurnBusService();
    bus.run('turn-1', turnOf(TURN));
    await drain(bus, 'turn-1');

    const buffered = bus.channel('turn-1').recentSince(0);
    expect(buffered.map((i) => i.event.type)).toEqual([
      'session',
      'tool_start',
      'products',
      'token',
      'token',
      'done',
    ]);
    const ids = buffered.map((i) => i.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('replays ONLY what a resuming client missed, from its Last-Event-ID', async () => {
    const bus = new ScoutTurnBusService();
    bus.run('turn-2', turnOf(TURN));
    await drain(bus, 'turn-2');

    const all = bus.channel('turn-2').recentSince(0);
    // The client "saw" through the products event, then dropped.
    const lastSeen = all[2].id;

    const replayed = bus.channel('turn-2').recentSince(lastSeen);
    expect(replayed.map((i) => i.event.type)).toEqual(['token', 'token', 'done']);
    expect(replayed.every((i) => i.id > lastSeen)).toBe(true);
  });

  it('does not restart the turn on resume — the generator runs exactly once', async () => {
    const bus = new ScoutTurnBusService();
    let starts = 0;
    const gen = (async function* () {
      starts += 1;
      yield { type: 'done' } as ScoutStreamEvent;
    })();

    bus.run('turn-3', gen);
    await drain(bus, 'turn-3');
    // A resume only reads the existing channel (as the controller does).
    bus.channel('turn-3').recentSince(0);
    bus.channel('turn-3').recentSince(0);

    expect(starts).toBe(1);
  });

  it('surfaces a terminal error event when the turn throws — never a silent hang', async () => {
    const bus = new ScoutTurnBusService();
    const failing = (async function* (): AsyncGenerator<ScoutStreamEvent> {
      yield { type: 'session', sessionId: 's1' };
      throw new Error('model exploded');
    })();

    bus.run('turn-4', failing);
    await drain(bus, 'turn-4');

    const events = bus.channel('turn-4').recentSince(0).map((i) => i.event);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    // The internal failure text is not leaked to the customer.
    expect((events.at(-1) as { message: string }).message).not.toContain('model exploded');
  });

  it('gives each turn its own channel — concurrent turns cannot bleed into each other', async () => {
    const bus = new ScoutTurnBusService();
    bus.run('turn-a', turnOf([{ type: 'token', content: 'A' }, { type: 'done' }]));
    bus.run('turn-b', turnOf([{ type: 'token', content: 'B' }, { type: 'done' }]));
    await Promise.all([drain(bus, 'turn-a'), drain(bus, 'turn-b')]);

    const textOf = (turnId: string) =>
      bus
        .channel(turnId)
        .recentSince(0)
        .map((i) => i.event)
        .filter((e): e is Extract<ScoutStreamEvent, { type: 'token' }> => e.type === 'token')
        .map((e) => e.content)
        .join('');

    expect(textOf('turn-a')).toBe('A');
    expect(textOf('turn-b')).toBe('B');
  });
});
