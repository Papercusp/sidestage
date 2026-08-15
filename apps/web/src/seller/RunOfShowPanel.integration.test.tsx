/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auctionInvalidate: vi.fn(),
  startSellerAuction: vi.fn(async () => ({
    id: 'auction-1',
    eventId: 'demo-room',
    eventItemId: 'demo-room:planned-b',
    productId: 'planned-b',
    quantity: 1,
    startingPriceCents: 2_400,
    currentPriceCents: 2_400,
    status: 'active' as const,
    startedAt: '2026-08-15T00:00:00.000Z',
    endsAt: '2026-08-15T00:01:30.000Z',
  })),
}));

vi.mock('@papercusp/sync', () => ({
  useSyncPrincipal: () => 'demo-runner',
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    const state = { loading: false, error: null, invalidate: vi.fn() };
    if (queryName === 'event.runOfShow') {
      return {
        ...state,
        data: [{
          eventId: 'demo-room',
          entries: [
            { productId: 'planned-a', plannedDurationSec: 300, notes: 'Lead with the glaze.' },
            { productId: 'planned-b', plannedDurationSec: 120, notes: '' },
          ],
        }],
      };
    }
    if (queryName === 'event.actions.items') {
      return {
        ...state,
        data: [
          {
            eventId: 'demo-room', eventItemId: 'demo-room:planned-a', productId: 'planned-a',
            title: 'Aurora Cup', priceCents: 4_200, availableQty: 3, quantity: 3, attributes: {},
          },
          {
            eventId: 'demo-room', eventItemId: 'demo-room:planned-b', productId: 'planned-b',
            title: 'Beacon Mug', priceCents: 2_400, availableQty: 6, quantity: 6, attributes: {},
          },
        ],
      };
    }
    if (queryName === 'event.auction.active') {
      return { ...state, data: [], invalidate: mocks.auctionInvalidate };
    }
    return { ...state, data: [] };
  },
  useSyncMutate: (_name: string, fallback: (input: unknown) => Promise<unknown>) => fallback,
}));

vi.mock('../events/api', () => ({
  startSellerAuction: mocks.startSellerAuction,
}));

import { RunOfShowPanel } from './RunOfShowPanel';
import { emptyStageLog, stageLogOnProductChange } from '../run-of-show';

describe('RunOfShowPanel integration', () => {
  beforeEach(() => {
    mocks.auctionInvalidate.mockClear();
    mocks.startSellerAuction.mockClear();
  });

  it('stages a planned id even when its commerce detail is outside the catalog window', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      await act(async () => {
        const stageLog = stageLogOnProductChange(emptyStageLog(), 'planned-a', Date.now());
        root.render(
          <RunOfShowPanel
            eventId="demo-room"
            stageLog={stageLog}
            activeProduct={null}
            onActiveProductChange={() => undefined}
          />,
        );
      });

      expect(container.textContent).toContain('Now');
      expect(container.textContent).toContain('Aurora Cup');
      expect(container.textContent).toContain('Lead with the glaze.');
      expect(container.textContent).toContain('Beacon Mug');
      expect(container.textContent).toContain('Start auction');
      expect(container.textContent).toContain('6 available');
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it('starts the next planned product auction without taking it live', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    const onActiveProductChange = vi.fn();

    try {
      await act(async () => {
        const stageLog = stageLogOnProductChange(emptyStageLog(), 'planned-a', Date.now());
        root.render(
          <RunOfShowPanel
            eventId="demo-room"
            stageLog={stageLog}
            activeProduct={null}
            catalogProducts={[{
              id: 'planned-b', name: 'Beacon Mug', imageUrl: '/beacon.jpg', price: '$24.00',
              description: 'Hand-thrown stoneware.', stockLabel: '6 available', tone: 'cyan', glyph: '◒',
            }]}
            onActiveProductChange={onActiveProductChange}
          />,
        );
      });

      const startButton = [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Start auction');
      expect(startButton).toBeDefined();

      await act(async () => {
        startButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(mocks.startSellerAuction).toHaveBeenCalledWith(
        'demo-room',
        expect.objectContaining({ eventItemId: 'demo-room:planned-b', productId: 'planned-b' }),
        1,
        2_400,
        undefined,
        'demo-runner',
        90,
      );
      expect(mocks.auctionInvalidate).toHaveBeenCalledOnce();
      expect(onActiveProductChange).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Beacon Mug auction started for 90 seconds.');
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});
