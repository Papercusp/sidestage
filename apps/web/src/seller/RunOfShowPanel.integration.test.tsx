/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auctionInvalidate: vi.fn(),
  itemsInvalidate: vi.fn(),
  executeSellerAction: vi.fn(async () => ({ ok: true })),
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
        invalidate: mocks.itemsInvalidate,
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
  executeSellerAction: mocks.executeSellerAction,
}));

import { RunOfShowPanel } from './RunOfShowPanel';
import { emptyStageLog, stageLogOnProductChange } from '../run-of-show';

describe('RunOfShowPanel integration', () => {
  beforeEach(() => {
    mocks.auctionInvalidate.mockClear();
    mocks.startSellerAuction.mockClear();
    mocks.itemsInvalidate.mockClear();
    mocks.executeSellerAction.mockClear();
    mocks.executeSellerAction.mockImplementation(async () => ({ ok: true }));
  });

  /** Mount the panel and hand back the "Take live" button (P-010). */
  async function mountAndFindTakeLive(onActiveProductChange: (id: string | null) => void) {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      const stageLog = stageLogOnProductChange(emptyStageLog(), 'planned-a', Date.now());
      root.render(
        <RunOfShowPanel
          eventId="demo-room"
          actorId="seller-1"
          stageLog={stageLog}
          activeProduct={null}
          onActiveProductChange={onActiveProductChange}
        />,
      );
    });
    const button = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === 'Take live');
    return { container, root, button };
  }

  it('"Take live" performs the GUARDED SERVER PUSH, not just a local selection change', async () => {
    const onActiveProductChange = vi.fn();
    const { container, root, button } = await mountAndFindTakeLive(onActiveProductChange);
    try {
      expect(button).toBeDefined();

      await act(async () => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // The push must reach the server, and must be a WELL-FORMED push: the
      // guard rejects a push carrying a quantity, a price, or a swap target
      // (guardrail.ts:101-118), and rejects any action with no reason (:70).
      expect(mocks.executeSellerAction).toHaveBeenCalledOnce();
      const [pushedEventId, pushedActorId, action] = mocks.executeSellerAction.mock.calls[0] as unknown as [
        string, string, Record<string, unknown>,
      ];
      expect(pushedEventId).toBe('demo-room');
      expect(pushedActorId).toBe('seller-1');
      expect(action.kind).toBe('push');
      expect(action.productId).toBe('planned-b');
      expect(String(action.reason)).not.toHaveLength(0);
      expect(action).not.toHaveProperty('quantity');
      expect(action).not.toHaveProperty('priceCents');
      expect(action).not.toHaveProperty('swapToProductId');

      // Server truth is re-read, and only THEN does local selection follow.
      expect(mocks.itemsInvalidate).toHaveBeenCalled();
      expect(onActiveProductChange).toHaveBeenCalledWith('planned-b');
      expect(container.textContent).not.toContain('could not be taken live');
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it('does NOT advance local selection when the server refuses the push', async () => {
    // The regression this pins: advancing selection on a refused push puts the
    // dock and the D-005 server-truth clock into disagreement — the seller sees
    // a card that is not on stage and a clock that never starts.
    mocks.executeSellerAction.mockImplementation(async () => {
      throw new Error('The event policy does not allow push actions.');
    });
    const onActiveProductChange = vi.fn();
    const { container, root, button } = await mountAndFindTakeLive(onActiveProductChange);
    try {
      await act(async () => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(mocks.executeSellerAction).toHaveBeenCalledOnce();
      expect(onActiveProductChange).not.toHaveBeenCalled();
      expect(mocks.itemsInvalidate).not.toHaveBeenCalled();
      // The server's own refusal is surfaced verbatim rather than restated.
      expect(container.textContent).toContain('The event policy does not allow push actions.');
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
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
            actorId="seller-1"
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
            actorId="seller-1"
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
