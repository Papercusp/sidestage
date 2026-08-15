/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuideEvent } from './api';
import { ChannelGuide } from './ChannelGuide';

const START = new Date('2026-08-14T12:00:00.000Z');
const EVENT: GuideEvent = {
  eventId: 'seller-scheduled-drop',
  title: 'Scheduled seller drop',
  sellerId: 'seller-studio-27',
  sellerName: 'Studio 27',
  status: 'scheduled',
  startsAt: '2026-08-14T12:00:05.000Z',
  endedAt: null,
  viewers: 0,
};

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  container.remove();
  vi.useRealTimers();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ChannelGuide scheduled-event clock', () => {
  it('ticks once per second and reaches Starting now at the scheduled instant', async () => {
    await act(async () => {
      root?.render(
        <ChannelGuide
          events={[EVENT]}
          currentEventId=""
          onSelect={() => undefined}
        />,
      );
    });
    expect(container.textContent).toContain('Starts in 5s');

    await act(async () => vi.advanceTimersByTime(1_000));
    expect(container.textContent).toContain('Starts in 4s');

    await act(async () => vi.advanceTimersByTime(4_000));
    expect(container.textContent).toContain('Starting now');
  });

  it('uses one interval for the whole guide and clears it on unmount', async () => {
    await act(async () => {
      root?.render(
        <ChannelGuide
          events={[EVENT, { ...EVENT, eventId: 'second-drop' }]}
          currentEventId=""
          onSelect={() => undefined}
        />,
      );
    });
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });
});
