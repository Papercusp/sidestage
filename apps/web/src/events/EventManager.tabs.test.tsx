/** @vitest-environment jsdom */

/**
 * Keyboard access to the Event Manager tablists (WI-39290).
 *
 * Both navs here have carried `role="tablist"`/`role="tab"` for a while, but
 * they were plain links underneath: every tab sat in the ordinary Tab sequence
 * and the arrow keys did nothing. That combination is worse than no ARIA at
 * all — a screen-reader user is TOLD this is a tablist, then the interaction
 * the role promises is missing, and the tab stops multiply instead of
 * collapsing to one. The pattern the rest of the app already implements
 * (`SellerMobileStudio`, `BuyerRoomContext`) is the bar being asserted here.
 *
 * These are real DOM renders driven by real key events, because every property
 * under test — which element holds focus, which tab is selected after a key,
 * what the URL became — is a consequence of state changing between renders.
 *
 * The nav is also a ROUTE here, not local state: unlike the mobile Studio
 * tablist, an arrow key has to move the URL as well as focus, so the tests
 * assert the query string alongside `aria-selected`.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SellerEventItem } from './api';
import type { SellerOwnedEvent } from './EventManager';

const mocks = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('@papercusp/sync', () => ({
  useSyncPrincipal: () => 'demo-seller',
  useSyncQuery: () => ({ data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() }),
  // The catalog reads under this tree name UNSYNCED queries and so call
  // useRestSyncQuery (WI-39772). This factory does not spread the real module,
  // so an omitted export is `undefined` at the call site, not a fallback.
  useRestSyncQuery: () => ({ data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() }),
  useSyncMutate: (_name: string, fallback: (input: unknown) => Promise<unknown>) => fallback,
  SyncContext: { Provider: ({ children }: { children: unknown }) => children },
}));

import { EventManager, nextTabId } from './EventManager';

const ITEMS: SellerEventItem[] = [{
  eventId: 'sunday-drop',
  eventItemId: 'sunday-drop:espresso',
  productId: 'espresso',
  title: 'Barista Pro Espresso',
  priceCents: 4_000,
  availableQty: 9,
  quantity: 4,
  attributes: {},
}];

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

function tablist(container: HTMLElement, className: string): HTMLElement {
  const nav = container.querySelector<HTMLElement>(`.${className}`);
  if (!nav) throw new Error(`no .${className} rendered`);
  if (nav.getAttribute('role') !== 'tablist') throw new Error(`.${className} is not a tablist`);
  return nav;
}

function tabs(nav: HTMLElement): HTMLAnchorElement[] {
  return [...nav.querySelectorAll<HTMLAnchorElement>('[role="tab"]')];
}

function selectedTab(nav: HTMLElement): HTMLAnchorElement {
  const found = tabs(nav).find((tab) => tab.getAttribute('aria-selected') === 'true');
  if (!found) throw new Error('no tab is selected');
  return found;
}

/** label -> tabIndex, so the whole tab-stop shape is one assertion. */
function tabStops(nav: HTMLElement): Record<string, number> {
  return Object.fromEntries(tabs(nav).map((tab) => [tab.textContent?.trim() ?? '', tab.tabIndex]));
}

async function press(target: HTMLElement, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('nextTabId — the roving-focus key rule', () => {
  const ids = ['lineup', 'settings', 'rehearse'] as const;

  it('moves right and left, wrapping at both ends', () => {
    expect(nextTabId(ids, 'lineup', 'ArrowRight')).toBe('settings');
    expect(nextTabId(ids, 'rehearse', 'ArrowRight')).toBe('lineup');
    expect(nextTabId(ids, 'settings', 'ArrowLeft')).toBe('lineup');
    expect(nextTabId(ids, 'lineup', 'ArrowLeft')).toBe('rehearse');
  });

  it('jumps to the ends on Home and End', () => {
    expect(nextTabId(ids, 'settings', 'Home')).toBe('lineup');
    expect(nextTabId(ids, 'settings', 'End')).toBe('rehearse');
  });

  it('returns null for a key the tablist does not own, so the event is left alone', () => {
    // Returning a tab for ArrowDown/Tab/Enter is how a tablist starts
    // swallowing keys that belong to the page or the link itself.
    for (const key of ['ArrowDown', 'ArrowUp', 'Tab', 'Enter', ' ', 'a']) {
      expect(nextTabId(ids, 'lineup', key)).toBeNull();
    }
  });

  it('returns null when the current id is not in the list', () => {
    expect(nextTabId(ids, 'nowhere' as (typeof ids)[number], 'ArrowRight')).toBeNull();
  });
});

describe('EventManager tablists — roving tabindex and arrow keys', () => {
  let container: HTMLElement;
  let unmount: () => Promise<void>;

  async function mount(search: string) {
    mocks.fetchMock.mockReset();
    vi.stubGlobal('fetch', mocks.fetchMock);
    window.history.replaceState({}, '', search);
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
  }

  beforeEach(async () => {
    await mount('/?tab=seller&studio=event-manager&manager=events');
  });

  afterEach(async () => {
    await unmount();
    container.remove();
    delete (globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT;
    vi.unstubAllGlobals();
  });

  it('gives the view tablist exactly one tab stop', () => {
    expect(tabStops(tablist(container, 'event-manager-switch'))).toEqual({
      'My events 1': 0,
      'Create event': -1,
    });
  });

  it('gives the event detail tablist exactly one tab stop', () => {
    expect(tabStops(tablist(container, 'event-detail-tabs'))).toEqual({
      Lineup: 0,
      Settings: -1,
    });
  });

  it('moves selection, focus, and the URL when ArrowRight is pressed on a detail tab', async () => {
    const nav = tablist(container, 'event-detail-tabs');
    const lineup = selectedTab(nav);
    lineup.focus();

    await press(lineup, 'ArrowRight');

    const settings = selectedTab(nav);
    expect(settings.textContent?.trim()).toBe('Settings');
    // Focus has to FOLLOW selection — moving one without the other strands the
    // keyboard user on a tab that is no longer the selected one.
    expect(document.activeElement).toBe(settings);
    expect(tabStops(nav)).toEqual({ Lineup: -1, Settings: 0 });
    expect(new URL(window.location.href).searchParams.get('section')).toBe('settings');
  });

  it('wraps a detail tab back to the first section with ArrowRight at the end', async () => {
    await unmount();
    container.remove();
    await mount('/?tab=seller&studio=event-manager&manager=events&section=settings');

    const nav = tablist(container, 'event-detail-tabs');
    const settings = selectedTab(nav);
    expect(settings.textContent?.trim()).toBe('Settings');

    await press(settings, 'ArrowRight');

    expect(selectedTab(nav).textContent?.trim()).toBe('Lineup');
    expect(new URL(window.location.href).searchParams.get('section')).toBe('lineup');
  });

  it('moves the view tablist between My events and Create event with the arrow keys', async () => {
    const nav = tablist(container, 'event-manager-switch');
    const myEvents = selectedTab(nav);
    myEvents.focus();

    await press(myEvents, 'ArrowRight');

    const create = selectedTab(container.querySelector<HTMLElement>('.event-manager-switch')!);
    expect(create.textContent?.trim()).toBe('Create event');
    expect(document.activeElement).toBe(create);
    expect(new URL(window.location.href).searchParams.get('manager')).toBe('create');
  });

  it('leaves a key the tablist does not own to the page', async () => {
    const nav = tablist(container, 'event-detail-tabs');
    const lineup = selectedTab(nav);
    const before = window.location.href;

    await press(lineup, 'ArrowDown');

    expect(selectedTab(nav).textContent?.trim()).toBe('Lineup');
    // Untouched, not merely equivalent: an unhandled key must not push a route
    // at all, so this compares the whole href rather than the section param
    // (which the default route resolves without ever writing to the URL).
    expect(window.location.href).toBe(before);
  });

  it('labels every tabpanel with the tab that controls it', () => {
    const panels = [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    expect(panels.length).toBeGreaterThan(0);

    for (const panel of panels) {
      const labelledBy = panel.getAttribute('aria-labelledby');
      expect(labelledBy, `${panel.className} has no aria-labelledby`).toBeTruthy();

      // The label must resolve to a real tab, not just be present: a dangling
      // aria-labelledby reads as an unnamed panel, which is the defect the
      // P-008 corroboration on WI-39290 reported.
      const label = document.getElementById(labelledBy!);
      expect(label, `aria-labelledby="${labelledBy}" resolves to nothing`).not.toBeNull();
      expect(label!.getAttribute('role')).toBe('tab');
    }
  });

  it('points every tab at a panel that exists', () => {
    const all = [
      ...tabs(tablist(container, 'event-manager-switch')),
      ...tabs(tablist(container, 'event-detail-tabs')),
    ];

    for (const tab of all) {
      const controls = tab.getAttribute('aria-controls');
      expect(controls, `${tab.textContent} has no aria-controls`).toBeTruthy();
    }

    // Only the SELECTED tab's panel is rendered — the others are routed away,
    // so this asserts the live pair rather than every id in the markup.
    for (const nav of ['event-manager-switch', 'event-detail-tabs']) {
      const tab = selectedTab(tablist(container, nav));
      const panel = document.getElementById(tab.getAttribute('aria-controls')!);
      expect(panel, `${tab.textContent} controls a panel that is not rendered`).not.toBeNull();
      expect(panel!.getAttribute('role')).toBe('tabpanel');
    }
  });
});
