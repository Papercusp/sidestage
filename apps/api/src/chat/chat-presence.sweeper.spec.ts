import { describe, expect, it, vi } from 'vitest';

import {
  ChatPresenceSweeper,
  DEFAULT_PRESENCE_SWEEP_INTERVAL_MS,
  presenceSweepIntervalMs,
} from './chat-presence.sweeper';
import { ChatService } from './chat.service';
import { InMemoryChatStore } from './chat.store';

const TTL_MS = 35_000;

function serviceWithStore(): { service: ChatService; store: InMemoryChatStore } {
  const store = new InMemoryChatStore();
  return { service: new ChatService(undefined, store), store };
}

describe('presenceSweepIntervalMs', () => {
  it('falls back to the default for missing, unparseable, or dangerously small values', () => {
    expect(presenceSweepIntervalMs(undefined)).toBe(DEFAULT_PRESENCE_SWEEP_INTERVAL_MS);
    expect(presenceSweepIntervalMs('not-a-number')).toBe(DEFAULT_PRESENCE_SWEEP_INTERVAL_MS);
    expect(presenceSweepIntervalMs('0')).toBe(DEFAULT_PRESENCE_SWEEP_INTERVAL_MS);
    expect(presenceSweepIntervalMs('-5000')).toBe(DEFAULT_PRESENCE_SWEEP_INTERVAL_MS);
  });

  it('accepts an explicit override at or above one second', () => {
    expect(presenceSweepIntervalMs('1000')).toBe(1_000);
    expect(presenceSweepIntervalMs('2500.7')).toBe(2_500);
  });

  it('sweeps well inside the presence TTL so a replicated reader never shows a long-lived ghost', () => {
    expect(DEFAULT_PRESENCE_SWEEP_INTERVAL_MS).toBeLessThan(TTL_MS / 2);
  });
});

describe('ChatPresenceSweeper', () => {
  it('expires presence rows nobody read, which is the Zero/WebSocket case', async () => {
    const { service, store } = serviceWithStore();
    await service.touchPresence('demo-event', { userId: 'buyer-1', displayName: 'Maya', role: 'buyer' });

    // No REST presence read happens here on purpose: a client synced over Zero
    // reads the replicated table directly and never calls listPresence.
    vi.setSystemTime(new Date(Date.now() + TTL_MS + 1_000));
    const swept = await new ChatPresenceSweeper(service).sweep();

    expect(swept).toEqual(['demo-event']);
    expect(await store.listPresence('demo-event', new Date(0).toISOString())).toEqual([]);
    vi.useRealTimers();
  });

  it('leaves a live participant alone', async () => {
    const { service } = serviceWithStore();
    await service.touchPresence('demo-event', { userId: 'buyer-1', displayName: 'Maya', role: 'buyer' });

    expect(await new ChatPresenceSweeper(service).sweep()).toEqual([]);
    expect(await service.getPresence('demo-event')).toHaveLength(1);
  });

  it('invalidates the presence and stats surfaces for each swept event', async () => {
    const invalidated: string[] = [];
    const store = new InMemoryChatStore();
    const service = new ChatService(
      { invalidate: (name: string) => { invalidated.push(name); } } as never,
      store,
    );
    await service.touchPresence('demo-event', { userId: 'buyer-1', displayName: 'Maya', role: 'buyer' });
    invalidated.length = 0;

    vi.setSystemTime(new Date(Date.now() + TTL_MS + 1_000));
    await new ChatPresenceSweeper(service).sweep();

    expect(invalidated).toContain('event.chat.presence');
    expect(invalidated).toContain('event.chat.stats');
    vi.useRealTimers();
  });

  it('swallows a store failure so one bad tick cannot take the process down', async () => {
    const failing = {
      expireStalePresence: () => Promise.reject(new Error('connection terminated')),
    } as never;
    const service = new ChatService(undefined, failing);

    await expect(new ChatPresenceSweeper(service).sweep()).resolves.toEqual([]);
  });

  it('starts an unref\'d interval on init and clears it on destroy', () => {
    const { service } = serviceWithStore();
    const sweeper = new ChatPresenceSweeper(service, 1_000);
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    sweeper.onModuleInit();
    expect(setSpy).toHaveBeenCalledTimes(1);
    // A second init must not leak a second timer.
    sweeper.onModuleInit();
    expect(setSpy).toHaveBeenCalledTimes(1);

    sweeper.onModuleDestroy();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    // Destroy is idempotent.
    sweeper.onModuleDestroy();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('counts sweeps and expired events in the operational metrics', async () => {
    const { service } = serviceWithStore();
    await service.touchPresence('demo-event', { userId: 'buyer-1', displayName: 'Maya', role: 'buyer' });
    const sweeper = new ChatPresenceSweeper(service);

    await sweeper.sweep();
    expect(service.getOperationalMetrics()).toMatchObject({ presenceExpirySweeps: 1, presenceRowsExpired: 0 });

    vi.setSystemTime(new Date(Date.now() + TTL_MS + 1_000));
    await sweeper.sweep();
    expect(service.getOperationalMetrics()).toMatchObject({ presenceExpirySweeps: 2, presenceRowsExpired: 1 });
    vi.useRealTimers();
  });
});
