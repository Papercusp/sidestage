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

/*
 * One resolver behind BOTH read hooks. Which hook carries a given name is a
 * property of the sync contract, not of this panel: `event.runOfShow` and
 * `event.auction.active` are UNSYNCED (D-025) and so arrive via
 * `useRestSyncQuery`, while `event.actions.items` is a registry leaf and
 * arrives via `useSyncQuery`. Serving both from one name-keyed resolver keeps
 * the fixture about the DATA, so a name changing rungs cannot silently drop a
 * surface back to its loading branch here.
 */
vi.mock('@papercusp/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/sync')>()),
  useSyncPrincipal: () => 'demo-runner',
  useRestSyncQuery: ({ queryName }: { queryName: string }) => resolveQuery(queryName),
  useSyncQuery: ({ queryName }: { queryName: string }) => resolveQuery(queryName),
  useSyncMutate: (_name: string, fallback: (input: unknown) => Promise<unknown>) => fallback,
}));

function resolveQuery(queryName: string) {
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
          title: 'Aurora Cup', currentPriceCents: 4_200, currentQuantity: 3, listedQuantity: 3, attributes: {},
        },
        {
          eventId: 'demo-room', eventItemId: 'demo-room:planned-b', productId: 'planned-b',
          title: 'Beacon Mug', currentPriceCents: 2_400, currentQuantity: 6, listedQuantity: 6, attributes: {},
        },
      ],
    };
  }
  if (queryName === 'event.auction.active') {
    return { ...state, data: [], invalidate: mocks.auctionInvalidate };
  }
  return { ...state, data: [] };
}

/*
 * Only the two TRANSPORT functions are stubbed. `describeSellerActionFailure`
 * and `EventApiError` are the real ones on purpose: the failure copy the seller
 * reads is decided by that classifier, so a stub of it would test the stub.
 */
vi.mock('../events/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../events/api')>()),
  startSellerAuction: mocks.startSellerAuction,
  executeSellerAction: mocks.executeSellerAction,
}));

import { EventApiError } from '../events/api';
import { RunOfShowPanel } from './RunOfShowPanel';
/*
 * The panel reads the ONE shared clock (D-003) rather than taking a log as a
 * prop, so these renders supply a real provider. `stagedProductId` is the
 * server-authoritative staged flag the provider tracks (D-005) — the same input
 * production passes it — so the clock these tests exercise is the production
 * one, not a hand-built log the panel would no longer accept.
 */
import { StageClockProvider } from './stage-clock';

/**
 * The actorId (2nd arg) of the Nth `executeSellerAction` call.
 *
 * `vi.fn(async () => ({ ok: true }))` infers its parameter list from that
 * zero-arg factory, so `mock.calls` is typed `[][]` and any index access is
 * TS2493 — a build-only failure, since vitest never typechecks. Centralised
 * here so the identity-switch assertions read as intent rather than as casts.
 */
const actorIdOfCall = (index: number): string | undefined =>
  (mocks.executeSellerAction.mock.calls[index] as unknown as [string, string, unknown] | undefined)?.[1];

describe('RunOfShowPanel integration', () => {
  beforeEach(() => {
    mocks.auctionInvalidate.mockClear();
    mocks.startSellerAuction.mockClear();
    mocks.itemsInvalidate.mockClear();
    mocks.executeSellerAction.mockClear();
    mocks.executeSellerAction.mockImplementation(async () => ({ ok: true }));
  });

  /** Mount the panel and hand back the "Take live" button (P-010). */
  async function mountAndFindTakeLive(
    onActiveProductChange: (id: string | null) => void,
    actorId = 'seller-1',
  ) {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StageClockProvider stagedProductId="planned-a">
          <RunOfShowPanel
            eventId="demo-room"
            actorId={actorId}
            activeProduct={null}
            onActiveProductChange={onActiveProductChange}
          />
        </StageClockProvider>,
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

  it('pushes as the CURRENTLY selected seller after an identity switch, never the previous one', async () => {
    /*
     * P-008 clause 4 (two-seller event-manager regression), plan Decision D-011.
     *
     * The READ side of this surface is already two-seller proven server-side:
     * `GET/PUT /events/:eventId/run-of-show` and `event.runOfShow` are
     * seller-owned cells in event-access.cross-seller.test.ts and die under the
     * M1 ownership mutation. What had NO guard is the WRITE seam here — the
     * actor this panel executes AS.
     *
     * The exposure if it regressed: the dock is remounted per demo user by
     * P-007's `key={userId}`, so a captured actor is invisible in normal use.
     * Strip or bypass that key and a panel that captured `actorId` once keeps
     * pushing as the PREVIOUS seller — seller B's "Take live" executes on the
     * server as seller A. That is a cross-identity WRITE, the same exposure
     * class as a cross-identity read, so it belongs to this plan's invariant.
     *
     * Asserted by re-rendering the SAME instance with a new actor rather than
     * remounting: a remount would pass even against a captured actor, since
     * each mount captures its own correct one. Deterministic, no race.
     */
    const onActiveProductChange = vi.fn();
    const { container, root, button } = await mountAndFindTakeLive(onActiveProductChange, 'seller-mira');
    try {
      expect(button).toBeDefined();
      await act(async () => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(mocks.executeSellerAction).toHaveBeenCalledOnce();
      // `vi.fn(async () => …)` infers a zero-arg tuple for `mock.calls`, so index
      // access is a compile error (TS2493) even though the call really carries
      // three args. Same cast idiom as the first cell in this file.
      expect(actorIdOfCall(0)).toBe('seller-mira');

      // The demo user switches. Same component instance, new actor prop.
      await act(async () => {
        root.render(
          <StageClockProvider stagedProductId="planned-a">
            <RunOfShowPanel
              eventId="demo-room"
              actorId="seller-avi"
              activeProduct={null}
              onActiveProductChange={onActiveProductChange}
            />
          </StageClockProvider>,
        );
      });
      const afterSwitch = [...container.querySelectorAll('button')]
        .find((candidate) => candidate.textContent === 'Take live');
      expect(afterSwitch).toBeDefined();
      await act(async () => {
        afterSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(mocks.executeSellerAction).toHaveBeenCalledTimes(2);
      expect(actorIdOfCall(1)).toBe('seller-avi');
      // The decisive assertion: the second push must NOT carry the first seller.
      expect(actorIdOfCall(1)).not.toBe('seller-mira');
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it('does NOT advance local selection when the server refuses the push', async () => {
    // The regression this pins: advancing selection on a refused push puts the
    // dock and the D-005 server-truth clock into disagreement — the seller sees
    // a card that is not on stage and a clock that never starts.
    // A REFUSAL is a 4xx: the server judged this command and said why.
    mocks.executeSellerAction.mockImplementation(async () => {
      throw new EventApiError('The event policy does not allow push actions.', 409);
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
      // Nothing to retry: the server will refuse the identical command again.
      expect([...container.querySelectorAll('button')].map((node) => node.textContent))
        .not.toContain('Try again');
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it('never puts a 5xx body on screen — a server FAULT gets our copy and a retry (WI-39837)', async () => {
    /*
     * The bug this pins, verbatim from prod: the push hit a 23505 on
     * `event_lineup_item_one_on_stage`, Nest answered with its generic
     * "Internal server error", and the panel printed that string into the Next
     * card as body text. A 500 is not a sentence written for a seller — it says
     * nothing about what happened and nothing about what to do.
     */
    mocks.executeSellerAction.mockImplementation(async () => {
      throw new EventApiError('Internal server error', 500);
    });
    const onActiveProductChange = vi.fn();
    const { container, root, button } = await mountAndFindTakeLive(onActiveProductChange);
    try {
      await act(async () => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.textContent).not.toContain('Internal server error');
      expect(container.textContent).toContain('This item could not be taken live.');
      // A fault says what did NOT happen, so the seller knows the stage is intact.
      expect(container.textContent).toContain('Nothing changed on stage.');
      // The command was well formed, so re-sending it is a sensible offer.
      const retry = [...container.querySelectorAll('button')]
        .find((candidate) => candidate.textContent === 'Try again');
      expect(retry).toBeDefined();
      await act(async () => {
        retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(mocks.executeSellerAction).toHaveBeenCalledTimes(2);
      // Local selection still never advances on a failed push (D-005).
      expect(onActiveProductChange).not.toHaveBeenCalled();
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
        root.render(
          <StageClockProvider stagedProductId="planned-a">
            <RunOfShowPanel
              eventId="demo-room"
              actorId="seller-1"
              activeProduct={null}
              onActiveProductChange={() => undefined}
            />
          </StageClockProvider>,
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
        root.render(
          <StageClockProvider stagedProductId="planned-a">
            <RunOfShowPanel
              eventId="demo-room"
              actorId="seller-1"
              activeProduct={null}
              catalogProducts={[{
                id: 'planned-b', name: 'Beacon Mug', imageUrl: '/beacon.jpg', price: '$24.00',
                description: 'Hand-thrown stoneware.', stockLabel: '6 available', tone: 'cyan', glyph: '◒',
              }]}
              onActiveProductChange={onActiveProductChange}
            />
          </StageClockProvider>,
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
