/** @vitest-environment jsdom */

/**
 * Editing the show ON the Lineup surface (plan
 * sidestage-lineup-run-of-show-2026-08-16, P-004/P-005, tested under P-007).
 *
 * LineupTimeline.test.tsx proves the MARKUP of the timeline against a static
 * render; the state those controls drive lives one level up, in `EventManager`
 * (`reorderShow` / `moveSlot` / `removeFromShow` / `addToShow` / the single
 * `openSlotProductId`). Neither P-004 nor P-005 claimed a test at that level, so
 * the reorder and drawer BEHAVIOUR — as opposed to the handler wiring — had no
 * coverage at all: a view that called `onMove` correctly and a container that
 * reordered wrongly would have passed everything.
 *
 * These are real DOM renders (createRoot + act) driven by real events, because
 * every property below is a consequence of state changing between renders, which
 * `renderToStaticMarkup` cannot produce.
 *
 * The case that matters most here is the FIRST structural edit against an
 * UNPLANNED event: under D-010 the show is derived from lineup order until
 * something is saved, so the first reorder has to materialise that derived order
 * into state before mutating it. Getting that wrong does not throw — it silently
 * edits an empty array, and the seller's drag appears to do nothing.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SellerEventItem } from './api';
import type { SellerOwnedEvent } from './EventManager';

const mocks = vi.hoisted(() => ({ fetchMock: vi.fn() }));

/*
 * Sync is mocked rather than provided so this file exercises the container's
 * OWN state transitions with no transport at all — and `fetch` is stubbed and
 * asserted, so an edit that quietly reached for the network would fail here
 * rather than pass with a mocked-away side effect.
 */
vi.mock('@papercusp/sync', () => ({
  useSyncPrincipal: () => 'demo-seller',
  useSyncQuery: () => ({ data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() }),
  useSyncMutate: (_name: string, fallback: (input: unknown) => Promise<unknown>) => fallback,
  SyncContext: { Provider: ({ children }: { children: unknown }) => children },
}));

import { EventManager } from './EventManager';

function item(productId: string, title: string, overrides: Partial<SellerEventItem> = {}): SellerEventItem {
  return {
    eventId: 'sunday-drop',
    eventItemId: `sunday-drop:${productId}`,
    productId,
    title,
    priceCents: 4_000,
    availableQty: 9,
    quantity: 4,
    attributes: {},
    ...overrides,
  };
}

const ITEMS: SellerEventItem[] = [
  item('espresso', 'Barista Pro Espresso'),
  item('grinder', 'Burr Grinder'),
  item('kettle', 'Gooseneck Kettle'),
];

const EVENTS: SellerOwnedEvent[] = [{
  eventId: 'sunday-drop',
  title: 'Sunday drop',
  sellerId: 'demo-seller',
  sellerName: 'SideStage Seller',
  status: 'live',
  startsAt: '2026-08-14T15:00:00.000Z',
  endedAt: null,
}];

type ActEnv = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

/** The show order the seller is actually looking at, top to bottom. */
function showOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid^="lineup-slot-"]')]
    .map((slot) => slot.getAttribute('data-testid')?.replace('lineup-slot-', '') ?? '');
}

function slotRow(container: HTMLElement, productId: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-testid="lineup-slot-${productId}"]`);
  if (!row) throw new Error(`no slot rendered for ${productId}`);
  return row;
}

/** The one button in `scope` whose label is exactly `label`. */
function button(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`no "${label}" button in ${scope.className || 'container'}`);
  return found;
}

describe('EventManager — editing the show on the Lineup surface', () => {
  let container: HTMLElement;
  let unmount: () => Promise<void>;

  beforeEach(async () => {
    mocks.fetchMock.mockReset();
    vi.stubGlobal('fetch', mocks.fetchMock);
    window.history.replaceState({}, '', '/?tab=seller&studio=event-manager&manager=events');
    (globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT = true;

    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <EventManager
          actorId="seller-27"
          eventId="sunday-drop"
          eventName="Sunday drop"
          initialItems={ITEMS}
          initialEvents={EVENTS}
        />,
      );
    });
    unmount = async () => { await act(async () => root.unmount()); };
  });

  afterEach(async () => {
    await unmount();
    container.remove();
    delete (globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT;
    vi.unstubAllGlobals();
  });

  async function press(target: Element, key: string) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  }

  async function click(target: Element) {
    await act(async () => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('starts from lineup order, because nothing has been planned (D-010)', () => {
    // The premise every test below edits FROM. If this drifts, the reorder
    // assertions stop meaning what they say.
    expect(showOrder(container)).toEqual(['espresso', 'grinder', 'kettle']);
  });

  it('reorders an UNPLANNED show from the keyboard, materialising the derived order', async () => {
    // Arrow keys, not drag: the handle is a real button so the reorder is
    // reachable without a pointer. This is also the first structural edit
    // against a plan that was never saved — the derived order has to become
    // editable state on the way through, or this drag edits nothing.
    const handle = slotRow(container, 'espresso').querySelector('.lineup-slot-handle');
    expect(handle).not.toBeNull();

    await press(handle!, 'ArrowDown');
    expect(showOrder(container)).toEqual(['grinder', 'espresso', 'kettle']);

    // Moves compose: the same slot keeps moving rather than snapping back to the
    // derived order on every render.
    await press(slotRow(container, 'espresso').querySelector('.lineup-slot-handle')!, 'ArrowDown');
    expect(showOrder(container)).toEqual(['grinder', 'kettle', 'espresso']);

    // And the positions the seller reads follow the new order, rather than
    // staying attached to the products they were first painted on.
    expect(slotRow(container, 'grinder').querySelector('.lineup-slot-position')?.textContent).toBe('1');
    expect(slotRow(container, 'espresso').querySelector('.lineup-slot-position')?.textContent).toBe('3');
  });

  it('refuses to move a slot off either end instead of wrapping or dropping it', async () => {
    // The bounds guard, from both directions. A splice with an out-of-range
    // index does not throw — it silently appends or truncates — so "nothing
    // happened" is the assertion that proves the guard is there at all.
    //
    // Its positive control is the test above: an unchanged order would ALSO be
    // what a dead event path produced, and that test fails if the keypress
    // never reaches React. Reading this one alone would not tell them apart.
    await press(slotRow(container, 'espresso').querySelector('.lineup-slot-handle')!, 'ArrowUp');
    expect(showOrder(container)).toEqual(['espresso', 'grinder', 'kettle']);

    await press(slotRow(container, 'kettle').querySelector('.lineup-slot-handle')!, 'ArrowDown');
    expect(showOrder(container)).toEqual(['espresso', 'grinder', 'kettle']);
  });

  it('ignores keys that are not a move, so the handle stays focusable text', async () => {
    // Falsifies the two tests above: a handler that reordered on ANY keypress
    // would satisfy them both and would also scramble the show on Tab.
    await press(slotRow(container, 'espresso').querySelector('.lineup-slot-handle')!, 'Enter');
    await press(slotRow(container, 'espresso').querySelector('.lineup-slot-handle')!, 'a');
    expect(showOrder(container)).toEqual(['espresso', 'grinder', 'kettle']);
  });

  it('mounts a slot drawer on demand and unmounts it again', async () => {
    // The drawer holds the markdown/stock/auction/offer controls, so leaving
    // every row's copy mounted-but-hidden is the documented perf anti-pattern.
    // Mounting is therefore a state transition worth pinning, not just markup.
    expect(container.querySelector('#lineup-drawer-espresso')).toBeNull();

    const controls = button(slotRow(container, 'espresso'), 'Controls');
    expect(controls.getAttribute('aria-expanded')).toBe('false');

    await click(controls);
    expect(container.querySelector('#lineup-drawer-espresso')).not.toBeNull();
    expect(container.textContent).toContain('Start auction');
    expect(button(slotRow(container, 'espresso'), 'Hide controls').getAttribute('aria-expanded')).toBe('true');

    await click(button(slotRow(container, 'espresso'), 'Hide controls'));
    expect(container.querySelector('#lineup-drawer-espresso')).toBeNull();
    expect(container.textContent).not.toContain('Start auction');
  });

  it('keeps exactly ONE drawer open, so two rows cannot claim the stage controls at once', async () => {
    await click(button(slotRow(container, 'espresso'), 'Controls'));
    await click(button(slotRow(container, 'grinder'), 'Controls'));

    expect(container.querySelector('#lineup-drawer-grinder')).not.toBeNull();
    expect(container.querySelector('#lineup-drawer-espresso')).toBeNull();
    expect(container.querySelectorAll('[id^="lineup-drawer-"]')).toHaveLength(1);
  });

  it('returns a removed product to the tray and takes it back at the END of the show', async () => {
    // Removing from the SHOW never removes it from the lineup — it is reserved
    // inventory either way, one click from coming back. Re-adding appends
    // rather than restoring the old position, because the seller who re-adds
    // mid-show is queueing it next, not undoing an edit.
    await click(button(slotRow(container, 'grinder'), 'Remove'));
    expect(showOrder(container)).toEqual(['espresso', 'kettle']);

    const tray = container.querySelector<HTMLElement>('.lineup-timeline-tray');
    expect(tray?.textContent).toContain('Burr Grinder');

    await click(button(tray!, 'Add to show'));
    expect(showOrder(container)).toEqual(['espresso', 'kettle', 'grinder']);
  });

  it('closes the drawer of a product it removes from the show', async () => {
    // Otherwise the single open-drawer id points at a slot that no longer
    // renders, and the seller is left with commerce controls for a product that
    // is not in the show — or, worse, they reappear when it is added back.
    await click(button(slotRow(container, 'grinder'), 'Controls'));
    expect(container.querySelector('#lineup-drawer-grinder')).not.toBeNull();

    await click(button(slotRow(container, 'grinder'), 'Remove'));
    expect(container.querySelectorAll('[id^="lineup-drawer-"]')).toHaveLength(0);

    await click(button(container.querySelector<HTMLElement>('.lineup-timeline-tray')!, 'Add to show'));
    expect(container.querySelector('#lineup-drawer-grinder')).toBeNull();
  });

  it('does none of this over the network — every edit above is local until Save', async () => {
    // The whole document is saved by one explicit PUT (`onSave`), so a reorder
    // or a removal firing transport would be both a surprise write and a
    // half-saved show.
    await press(slotRow(container, 'espresso').querySelector('.lineup-slot-handle')!, 'ArrowDown');
    await click(button(slotRow(container, 'kettle'), 'Remove'));
    await click(button(slotRow(container, 'espresso'), 'Controls'));

    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });
});
