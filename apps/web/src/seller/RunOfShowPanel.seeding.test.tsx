/** @vitest-environment jsdom */

/**
 * The Studio dock's D-010 seeding (plan sidestage-lineup-run-of-show-2026-08-16,
 * P-006/P-007).
 *
 * D-010's premise is that the lineup IS the run of show: an event nobody planned
 * still HAS a show, seeded from lineup order. Both surfaces must seed the same
 * way or P-006's "cannot drift" is false — the Lineup would list every reserved
 * product as a slot while this dock said "No show plan yet" about the same event.
 * `EventManager`'s side of that seeding is pinned in EventManager.test.tsx; this
 * file pins the DOCK's side, which had no test of its own.
 *
 * The discriminator is deliberately NOT emptiness. A never-saved plan and a plan
 * the seller deliberately emptied are both zero entries, and only the timestamp
 * separates them (run-of-show.ts:49-51: the server's `emptyRunOfShow()` fallback
 * stamps the epoch, every real save stamps `new Date()`). So each seeding case
 * below is paired with the case that falsifies it: an implementation that
 * branched on `entries.length === 0` alone would resurrect products the seller
 * removed on purpose, and would pass half these tests while doing it.
 *
 * These are REAL DOM renders (createRoot + act) rather than
 * `renderToStaticMarkup`, because the panel reads the shared clock through
 * `StageClockProvider`, whose log is advanced in an effect — server rendering
 * runs no effects, so a static render exercises a provider that never ticked.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOfShowPlan } from '../run-of-show';

/*
 * The lineup is fixed and the PLAN is what each test varies, so the plan rows
 * live in a hoisted holder the mock factory reads at call time. Nothing else is
 * mocked: `events/api` is imported for real (it has no import-time side effects
 * and none of its calls fire without a click), which also keeps this file honest
 * about the panel doing no transport of its own on mount.
 */
const mocks = vi.hoisted(() => ({
  planRows: [] as unknown[],
  lineup: [
    {
      eventId: 'demo-room', eventItemId: 'demo-room:aurora', productId: 'aurora',
      title: 'Aurora Cup', priceCents: 4_200, availableQty: 3, quantity: 3, attributes: {},
    },
    {
      eventId: 'demo-room', eventItemId: 'demo-room:beacon', productId: 'beacon',
      title: 'Beacon Mug', priceCents: 2_400, availableQty: 6, quantity: 6, attributes: {},
    },
    {
      eventId: 'demo-room', eventItemId: 'demo-room:cinder', productId: 'cinder',
      title: 'Cinder Bowl', priceCents: 1_800, availableQty: 2, quantity: 2, attributes: {},
    },
  ],
}));

/*
 * One resolver behind BOTH read hooks. `event.runOfShow` is UNSYNCED (D-025)
 * and so arrives via `useRestSyncQuery`, while `event.actions.items` is a
 * registry leaf and arrives via `useSyncQuery`. Keying the fixture on the NAME
 * rather than the hook is what stops a rung change from silently starving the
 * panel — an empty plan renders the seeded-from-lineup branch, which is a
 * plausible screen, so these assertions would otherwise fail obscurely.
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
  if (queryName === 'event.runOfShow') return { ...state, data: mocks.planRows };
  if (queryName === 'event.actions.items') return { ...state, data: mocks.lineup };
  return { ...state, data: [] };
}

import { RunOfShowPanel } from './RunOfShowPanel';
import { StageClockProvider } from './stage-clock';

/** The server's own never-saved stamp (run-of-show.service.ts:76). */
const EPOCH = new Date(0).toISOString();
/** Any real save (run-of-show.service.ts:105). */
const SAVED_AT = '2026-08-16T18:30:00.000Z';

function plan(overrides: Partial<RunOfShowPlan> = {}): RunOfShowPlan {
  return { eventId: 'demo-room', entries: [], updatedAt: EPOCH, ...overrides };
}

type ActEnv = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function mountDock() {
  (globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <StageClockProvider stagedProductId={null}>
        <RunOfShowPanel
          eventId="demo-room"
          actorId="seller-1"
          activeProduct={null}
          onActiveProductChange={() => undefined}
        />
      </StageClockProvider>,
    );
  });
  return { container, root };
}

/** The order the dock actually painted the slot titles in. */
function renderedOrder(container: HTMLElement): string[] {
  const text = container.textContent ?? '';
  return ['Aurora Cup', 'Beacon Mug', 'Cinder Bowl']
    .filter((title) => text.includes(title))
    .sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

describe('RunOfShowPanel D-010 seeding', () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeEach(() => {
    mocks.planRows = [];
  });

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
    delete (globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT;
  });

  async function dock() {
    const { container, root } = await mountDock();
    cleanup = async () => { await act(async () => root.unmount()); };
    return container;
  }

  it('seeds the show from LINEUP ORDER when the plan query has delivered no row', async () => {
    // The pre-first-save state, and also the pre-first-response state: the query
    // is treated as never-saved so the dock shows the lineup immediately rather
    // than flashing "No show plan yet" and correcting itself a tick later.
    const container = await dock();

    expect(renderedOrder(container)).toEqual(['Aurora Cup', 'Beacon Mug', 'Cinder Bowl']);
    expect(container.textContent).not.toContain('No show plan yet');
  });

  it("seeds from the server's OWN never-saved row, which is epoch-stamped and empty", async () => {
    // `emptyRunOfShow()` answers with a real row rather than nothing, so a dock
    // that keyed seeding off "no row at all" would pass the test above and still
    // show an empty show against every event the seller has not planned yet.
    mocks.planRows = [plan({ updatedAt: EPOCH })];
    const container = await dock();

    expect(renderedOrder(container)).toEqual(['Aurora Cup', 'Beacon Mug', 'Cinder Bowl']);
    expect(container.textContent).not.toContain('No show plan yet');
  });

  it('seeded slots carry NO time budget, because an unplanned show has none to pace against', async () => {
    // Inventing a budget here would make the pace line lie about a show nobody
    // planned. The next-up card prints the em dash the view uses for a null
    // budget (RunOfShowPanel.tsx:287).
    const container = await dock();
    const nextCard = container.querySelector('.run-of-show-next-card');

    expect(nextCard?.textContent).toContain('Aurora Cup');
    expect(nextCard?.textContent).toContain('—');
    expect(nextCard?.textContent).not.toMatch(/\d+:\d\d/);
  });

  it('renders NO slots for a plan the seller deliberately emptied', async () => {
    // THE FALSIFIER for all three tests above. Same zero entries, different
    // timestamp: this plan was saved, then emptied. Seeding it from the lineup
    // would resurrect every product the seller removed on purpose — and would
    // do so silently, because the resurrected show looks exactly like a healthy
    // seeded one.
    mocks.planRows = [plan({ updatedAt: SAVED_AT })];
    const container = await dock();

    expect(renderedOrder(container)).toEqual([]);
    expect(container.textContent).toContain('No show plan yet');
  });

  it('follows the SAVED order, not lineup order, once a plan exists', async () => {
    // The second falsifier: a dock that always seeded from the lineup would
    // render these in lineup order and drop nothing, so both assertions here
    // fail against it. Cinder is reserved in the lineup but not in the plan, so
    // it belongs to the tray on the Lineup surface — never to this dock's show.
    mocks.planRows = [plan({
      updatedAt: SAVED_AT,
      entries: [
        { productId: 'beacon', plannedDurationSec: 120, notes: 'Second, on purpose.' },
        { productId: 'aurora', plannedDurationSec: 300, notes: '' },
      ],
    })];
    const container = await dock();

    expect(renderedOrder(container)).toEqual(['Beacon Mug', 'Aurora Cup']);
    expect(container.textContent).not.toContain('Cinder Bowl');
    // The saved budget IS rendered, which is what makes the em-dash assertion
    // above evidence about seeding rather than about the dash being unreachable.
    expect(container.querySelector('.run-of-show-next-card')?.textContent).toContain('2:00');
  });
});
