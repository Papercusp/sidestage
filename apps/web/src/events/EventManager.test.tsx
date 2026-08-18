/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { SyncContext } from '@papercusp/sync';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventManager, type SellerOwnedEvent } from './EventManager';
import type { SellerEventItem } from './api';

/**
 * events.mine is REST-pinned via useRestSyncQuery since WI-39855 (no Zero
 * registry leaf — every row carries the server-computed `withheldFromGuide`
 * policy verdict), so the seller directory no longer flows through
 * SyncContext.useDataImpl. Mock that hook as its observable seam; every other
 * export (SyncContext included) stays original.
 */
const restSync = vi.hoisted(() => ({
  impl: undefined as ((opts: { queryName: string }) => Record<string, unknown>) | undefined,
}));
vi.mock('@papercusp/sync', async (importOriginal) => {
  const original = await importOriginal<typeof import('@papercusp/sync')>();
  return {
    ...original,
    useRestSyncQuery: (opts: { queryName: string }) => ({
      data: [],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate: vi.fn(),
      error: null,
      ...(restSync.impl?.(opts) ?? {}),
    }),
  };
});

const ITEMS: SellerEventItem[] = [{
  eventId: 'sunday-drop',
  eventItemId: 'sunday-drop:espresso',
  productId: 'espresso',
  title: 'Barista Pro Espresso Machine',
  priceCents: 47_500,
  availableQty: 12,
  quantity: 3,
  onStage: true,
  attributes: { brand: 'BrewHaus', sku: 'BH-ESP-200-NEW', basePriceCents: 49_999 },
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

describe('EventManager', () => {
  beforeEach(() => {
    restSync.impl = undefined;
    window.history.replaceState({}, '', '/?tab=seller&studio=event-manager&manager=events');
  });

  it('reads config and lineup through named sync queries without a component-owned fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const useDataImpl = vi.fn((options: { queryName: string }) => ({
      data: options.queryName === 'event.config'
        ? [{
            eventId: 'sunday-drop',
            name: 'Live renamed drop',
            replyTone: 'warm',
            guardrails: { priceChanges: true, inventoryClaims: true, buyerSensitive: true },
            updatedAt: '2026-08-14T15:00:00.000Z',
          }]
        : options.queryName === 'event.actions.items' ? ITEMS : [],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate: vi.fn(),
      error: null,
    }));
    // The seller directory is REST-pinned, so it arrives on its own seam.
    const restImpl = vi.fn((options: { queryName: string }) => ({
      data: options.queryName === 'events.mine' ? EVENTS : [],
    }));
    restSync.impl = restImpl;

    const markup = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <EventManager actorId="seller-27" eventId="sunday-drop" eventName="Stale title" />
      </SyncContext.Provider>,
    );

    expect(useDataImpl).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'event.config',
      args: { eventId: 'sunday-drop' },
    }));
    expect(useDataImpl).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'event.actions.items',
      args: { eventId: 'sunday-drop' },
    }));
    expect(restImpl).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'events.mine',
      args: { sellerId: 'seller-27' },
    }));
    // The pin is the point: a transport-following read would break on the
    // WEBSOCKETS rung, where events.mine has no registry leaf.
    expect(useDataImpl).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryName: 'events.mine' }),
    );
    expect(markup).toContain('Live renamed drop');
    expect(markup).toContain('My events');
    expect(markup).toContain('Barista Pro Espresso Machine');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('renders the lineup AS the run of show, seeded from the lineup when nothing was planned', () => {
    const markup = renderToStaticMarkup(
      <EventManager
        actorId="seller-27"
        eventId="sunday-drop"
        eventName="Sunday drop"
        initialItems={ITEMS}
        initialEvents={EVENTS}
      />,
    );

    expect(markup).toContain('Sunday drop');
    // Direction C (D-001): ONE ordered timeline replaces the grid + the
    // separate authoring panel that used to sit beneath it.
    expect(markup).toContain('lineup-timeline');
    expect(markup).toContain('Run of show');
    expect(markup).not.toContain('data-rg-screen-grid="true"');

    // D-010: no plan was ever saved, so the show is derived from the LINEUP —
    // the product is a real SLOT, not a tray item behind an authoring step.
    // This is what keeps an unplanned event operable.
    expect(markup).toContain('data-testid="lineup-slot-espresso"');
    expect(markup).toContain('Every product in this event is in the show.');

    // The stage action lives on the slot ROW, so pushing stays one click mid
    // show. ITEMS[0] is already on stage, so it reads as such.
    expect(markup).toContain('On stage');
    expect(markup).toContain('Controls');
    // Markdown/stock/auction/offer hang off a per-slot drawer that is CLOSED by
    // default, so they are deliberately absent here. LineupTimeline.test.tsx
    // proves them with the drawer open — that is the level they belong at.
    expect(markup).not.toContain('Start auction');
    expect(markup).not.toContain('Unlock auction writes');
    expect(markup).not.toContain('Seller credential');

    expect(markup).toContain('Barista Pro Espresso Machine');
    expect(markup).toContain('Event lineup');
    expect(markup).toContain('Add inventory');
    expect(markup).toContain('Lineup');
    expect(markup).toContain('Settings');
    expect(markup).not.toContain('Rehearse');
    expect(markup.indexOf('>Lineup</a>')).toBeLessThan(markup.indexOf('>Settings</a>'));
    expect(markup).not.toContain('Event settings &amp; readiness');

    // Fault 8: the permanent "guarded seller actions are live" banner is gone.
    // Guardrails now speak where and when they bind, not as standing furniture.
    expect(markup).not.toContain('Guarded seller actions are live');

    // The standalone planner mount is retired; authoring is the timeline now.
    expect(markup).not.toContain('Plan the show');
    expect(markup).not.toContain('Save show plan');
    expect(markup).toContain('Save run of show');
  });

  /**
   * The lifecycle controls (P-005). These assert the AFFORDANCES the seller is
   * offered per status — which is the half the server cannot defend: a control
   * the API would refuse is still a 409 the seller has to read and undo. The
   * legality table itself is proven against the real server resolver in
   * event-lifecycle.test.ts, and the wire in api.test.ts.
   */
  describe('lifecycle controls', () => {
    const renderStatus = (status: SellerOwnedEvent['status']): string => renderToStaticMarkup(
      <EventManager
        actorId="seller-27"
        eventId="sunday-drop"
        eventName="Sunday drop"
        initialItems={ITEMS}
        initialEvents={[{ ...EVENTS[0], status }]}
      />,
    );

    /**
     * The `<button …>` OPENING TAG for the control with this exact label.
     *
     * Asserting `markup.toContain('disabled')` anywhere would pass on a page
     * that disabled some OTHER button, which is the failure mode that makes a
     * disabled-state test worthless. Throwing on a missing label matters just
     * as much: a renamed control would otherwise silently satisfy every
     * `not.toContain` assertion below.
     */
    const buttonTag = (markup: string, label: string): string => {
      const labelAt = markup.indexOf(`>${label}<`);
      expect(labelAt, `no control labelled "${label}" was rendered`).toBeGreaterThan(-1);
      const tagStart = markup.lastIndexOf('<button', labelAt);
      expect(tagStart, `"${label}" is not inside a <button>`).toBeGreaterThan(-1);
      return markup.slice(tagStart, markup.indexOf('>', tagStart) + 1);
    };

    it('discriminates a disabled control from an enabled one', () => {
      // The POSITIVE CONTROL for every disabled-state assertion below. Without
      // it, an extractor that quietly returned the whole document — or always
      // returned a disabled tag — would make those assertions unfalsifiable.
      const markup = renderStatus('draft');
      expect(buttonTag(markup, 'Schedule')).toContain('disabled');
      expect(buttonTag(markup, 'Go live')).not.toContain('disabled');
      expect(buttonTag(markup, 'Unpublish')).not.toContain('disabled');
    });

    it('offers the whole lifecycle on the event header', () => {
      const markup = renderStatus('draft');
      expect(markup).toContain('Event lifecycle');
      expect(markup).toContain('Start time');
      expect(markup).toContain('datetime-local');
      expect(markup).toContain('Schedule');
      expect(markup).toContain('Go live');
      expect(markup).toContain('End event');
      expect(markup).toContain('Unpublish');
    });

    it('will not offer to end an event that has not aired, and says why', () => {
      for (const status of ['draft', 'scheduled'] as const) {
        const markup = renderStatus(status);
        expect(markup).toContain('Only a live event can be ended.');
        // The refusal is not merely explained — the control is unreachable, so
        // the explanation is never something the seller discovers by failing.
        expect(buttonTag(markup, 'End event')).toContain('disabled');
      }
    });

    it('will not offer to reschedule a room that is already on air, and says why', () => {
      const markup = renderStatus('live');
      expect(markup).toContain('End the live event before rescheduling it.');
      expect(buttonTag(markup, 'Schedule')).toContain('disabled');
      expect(markup).not.toContain('Only a live event can be ended.');
      // A live room can still be ended — that is the move the hint points at.
      expect(buttonTag(markup, 'End event')).not.toContain('disabled');
    });

    it('leaves an ended event with no standing refusal — every move is legal again', () => {
      const markup = renderStatus('ended');
      expect(markup).not.toContain('Only a live event can be ended.');
      expect(markup).not.toContain('End the live event before rescheduling it.');
      // Re-running a finished show is a real thing to want, so Go live stays.
      expect(buttonTag(markup, 'Go live')).not.toContain('disabled');
      expect(buttonTag(markup, 'End event')).not.toContain('disabled');
    });

    it('disables Schedule until a start time is entered, on every status', () => {
      // The date field starts empty, so Schedule must never be the button that
      // teaches the seller about ISO-8601 by failing.
      for (const status of ['draft', 'scheduled', 'live', 'ended'] as const) {
        expect(buttonTag(renderStatus(status), 'Schedule')).toContain('disabled');
      }
    });
  });

  it('renders an empty selected event with an inventory call to action', () => {
    const newEvent: SellerOwnedEvent = {
      ...EVENTS[0],
      eventId: 'new-event',
      title: 'New event',
      status: 'draft',
    };
    const markup = renderToStaticMarkup(
      <EventManager
        actorId="seller-27"
        eventId="new-event"
        eventName="New event"
        initialItems={[]}
        initialEvents={[newEvent]}
      />,
    );

    expect(markup).toContain('This event has no reserved inventory yet.');
    expect(markup).toContain('Add inventory');
    expect(markup).toContain('Create event');
    expect(markup).not.toContain('Event settings &amp; readiness');
  });

  it('does not query or render a phantom fallback event when the seller owns no events', () => {
    // events.mine answers [] on its REST seam (the mock's default), so every
    // event-scoped query below must be DISABLED rather than merely empty.
    const useDataImpl = vi.fn(() => ({
      data: undefined,
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate: vi.fn(),
      error: null,
    }));

    const markup = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <EventManager actorId="seller-27" eventId="sunday-drop" eventName="Sunday vintage drop" />
      </SyncContext.Provider>,
    );

    expect(useDataImpl).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'event.config',
      enabled: false,
    }));
    expect(useDataImpl).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'event.actions.items',
      enabled: false,
    }));
    expect(useDataImpl).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'event.auction.active',
      enabled: false,
    }));
    expect(markup).toContain('No seller events yet.');
    expect(markup).toContain('Create your first seller event.');
    expect(markup).not.toContain('Event ID sunday-drop');
    expect(markup).not.toContain('Event not found for this seller.');
  });

  it('does not combine a missing routed id with another owned event\'s metadata', () => {
    window.history.replaceState(
      {},
      '',
      '/?tab=seller&studio=event-manager&manager=events&event=missing-event',
    );

    const markup = renderToStaticMarkup(
      <EventManager
        actorId="seller-27"
        eventId="sunday-drop"
        eventName="Sunday drop"
        initialItems={[]}
        initialEvents={EVENTS}
      />,
    );

    expect(markup).toContain('This event is not available for this seller.');
    expect(markup).toContain('Choose another event from My events, or create a new event.');
    expect(markup).not.toContain('Event ID missing-event');
    expect(markup).not.toContain('This event has no reserved inventory yet.');
  });

  it('nests settings under the selected event instead of the manager workspace switch', () => {
    window.history.replaceState({}, '', '/?tab=seller&studio=event-manager&manager=events&event=sunday-drop&section=settings');
    const markup = renderToStaticMarkup(
      <EventManager
        actorId="seller-27"
        eventId="sunday-drop"
        eventName="Sunday drop"
        initialItems={ITEMS}
        initialEvents={EVENTS}
      />,
    );

    expect(markup).toContain('Event settings &amp; readiness');
    expect(markup).toContain('Loading event settings…');
    expect(markup).not.toContain('data-rg-screen-grid="true"');
  });

  it('resolves the retired ?section=rehearse URL to the merged Lineup tab', () => {
    window.history.replaceState({}, '', '/?tab=seller&studio=event-manager&manager=events&event=sunday-drop&section=rehearse');
    const markup = renderToStaticMarkup(
      <EventManager
        actorId="seller-27"
        eventId="sunday-drop"
        eventName="Sunday drop"
        initialItems={ITEMS}
        initialEvents={EVENTS}
      />,
    );

    // A bookmarked/shared ?section=rehearse link still lands on real content:
    // the merged Lineup tab, which under direction C IS the run of show — not a
    // dedicated Rehearse tab, and not an empty/dead route.
    expect(markup).toContain('lineup-timeline');
    expect(markup).toContain('Run of show');
    expect(markup).toContain('Save run of show');
    expect(markup).not.toContain('data-rg-screen-grid="true"');
    expect(markup).not.toContain('Plan the show');
    expect(markup).not.toContain('Save show plan');
    expect(markup).not.toContain('Rehearse');
    expect(markup).not.toContain('Event settings &amp; readiness');
  });

  it('renders the existing reservation-backed creation flow in Create event', () => {
    window.history.replaceState({}, '', '/?tab=seller&studio=event-manager&manager=create');
    const markup = renderToStaticMarkup(
      <EventManager
        actorId="seller-27"
        eventId="new-event"
        eventName="New event"
        initialItems={[]}
        initialEvents={[]}
      />,
    );

    expect(markup).toContain('Build the live lineup');
    expect(markup).toContain('reserve real catalog inventory');
    expect(markup).toContain('Create event');
  });
});
