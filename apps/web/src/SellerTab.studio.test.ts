/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  initialPinnedSellerEvent,
  resolveSellerEventIdentity,
  shouldUseMobileStudio,
  sellerEventIdentity,
  sellerEventTitleBindings,
  STUDIO_VIEW_TABS,
  studioBoardConfig,
  useSellerDeepgramTokenProvider,
  useTranscriptMomentRecorder,
} from './SellerTab';
import type { SellerEventRecord } from './events/api';
import {
  isMobileStudioViewport,
  nextStudioMobileMode,
  STUDIO_MOBILE_MEDIA_QUERY,
  STUDIO_MOBILE_MODES,
} from './SellerMobileStudio';

function panelIds(seed: () => { root: unknown }): string[] {
  const visit = (node: unknown): string[] => {
    const current = node as {
      kind?: string;
      children?: unknown[];
      panels?: Array<{ id: string }>;
    };
    return current.kind === 'tabs'
      ? (current.panels ?? []).map((panel) => panel.id)
      : (current.children ?? []).flatMap(visit);
  };
  return visit(seed().root);
}

describe('Studio board selection', () => {
  it('switches the phone experience to one explicit live panel at a time', () => {
    expect(STUDIO_MOBILE_MODES).toEqual([
      { id: 'stage', label: 'Stage' },
      { id: 'lineup', label: 'Lineup' },
      { id: 'inventory', label: 'Inventory' },
      { id: 'copilot', label: 'Copilot' },
    ]);
    expect(isMobileStudioViewport((query) => ({
      matches: query === STUDIO_MOBILE_MEDIA_QUERY,
    }))).toBe(true);
    expect(isMobileStudioViewport(() => ({ matches: false }))).toBe(false);
  });

  it('supports automatic roving selection across the mobile Studio tablist', () => {
    expect(nextStudioMobileMode('stage', 'ArrowRight')).toBe('lineup');
    expect(nextStudioMobileMode('stage', 'ArrowLeft')).toBe('copilot');
    expect(nextStudioMobileMode('copilot', 'Home')).toBe('stage');
    expect(nextStudioMobileMode('stage', 'End')).toBe('copilot');
    expect(nextStudioMobileMode('lineup', 'ArrowRight')).toBe('inventory');
    expect(nextStudioMobileMode('lineup', 'Enter')).toBeNull();
  });

  it('keeps a selected event id and authoritative title in one identity update', () => {
    expect(sellerEventIdentity('event-42', 'Friday camera drop')).toEqual({
      eventId: 'event-42',
      eventTitle: 'Friday camera drop',
    });
  });

  it('restores the URL-selected event when the Studio host remounts', () => {
    window.history.replaceState({}, '', '/?tab=seller&studio=active-event&event=avi-real-test');

    expect(initialPinnedSellerEvent()).toEqual({
      eventId: 'avi-real-test',
      eventTitle: 'Sunday vintage drop',
    });
  });

  /**
   * WI-39718. This case used to assert the OPPOSITE — that a URL naming no
   * event still produced `sunday-drop` — because that was the shipped behavior.
   * It was also the defect: DEFAULT_EVENT_ID is a hard-coded literal, so the
   * Studio presented an event the seller may not own, may have left in draft,
   * or (in production) that has no row at all, as their Active Event.
   */
  it('reports no pinned event when the URL names none, instead of manufacturing sunday-drop', () => {
    window.history.replaceState({}, '', '/?tab=seller&studio=active-event');

    expect(initialPinnedSellerEvent()).toBeNull();
  });

  describe('resolveSellerEventIdentity', () => {
    const owned = (eventId: string, title: string): SellerEventRecord => ({
      eventId,
      title,
      sellerId: 'seller-1',
      sellerName: 'Avi',
      status: 'draft',
      startsAt: null,
      endedAt: null,
    });

    it('follows the seller directory when nothing is pinned, seeding only as a last resort', () => {
      // The server already orders this directory live-first, so its head is the
      // event the seller most likely means (compareForSeller).
      expect(resolveSellerEventIdentity(null, [owned('potato', 'Potato drop'), owned('avi-real-test', 'Avi Real Test')]))
        .toEqual({ eventId: 'potato', eventTitle: 'Potato drop' });

      // Seed survives ONLY with no directory at all — the pre-read first paint.
      expect(resolveSellerEventIdentity(null, [])).toEqual({
        eventId: 'sunday-drop',
        eventTitle: 'Sunday vintage drop',
      });
    });

    it('lets an explicit pin outrank the directory, and takes its title from the matching row', () => {
      const pinned = sellerEventIdentity('avi-real-test');
      const resolved = resolveSellerEventIdentity(pinned, [
        owned('potato', 'Potato drop'),
        owned('avi-real-test', 'Avi Real Test'),
      ]);

      // The id is the seller's choice; the TITLE is the directory's, so a pinned
      // event can no longer wear the DEFAULT_EVENT_TITLE placeholder.
      expect(resolved).toEqual({ eventId: 'avi-real-test', eventTitle: 'Avi Real Test' });
    });

    it('honours a pin the directory has never heard of, rather than silently redirecting', () => {
      // Typing an unknown room id must keep that id — the console then warns
      // about it. Quietly swapping in the directory's first row would hide the
      // very state the seller needs told about.
      //
      // The title stays the DEFAULT_EVENT_TITLE placeholder here because no
      // directory row exists to supply a real one. That is precisely why the
      // status badge, not the headline, is what says whether buyers can find
      // this room: `activeEventStatus` resolves it to `unlisted`.
      expect(resolveSellerEventIdentity(sellerEventIdentity('typo-room'), [owned('potato', 'Potato drop')]))
        .toEqual({ eventId: 'typo-room', eventTitle: 'Sunday vintage drop' });
    });
  });

  it('propagates the selected guide event title to every seller panel', () => {
    const initial = sellerEventTitleBindings(
      sellerEventIdentity('sunday-drop', 'Sunday vintage drop'),
      [{ eventId: 'sunday-drop', title: 'Sunday vintage drop' }],
    );
    const selected = sellerEventTitleBindings(
      sellerEventIdentity('avi-real-test', 'Sunday vintage drop'),
      [
        { eventId: 'sunday-drop', title: 'Sunday vintage drop' },
        { eventId: 'avi-real-test', title: 'Avi Real Test' },
      ],
    );

    expect(initial).toEqual({
      stageStatus: 'Sunday vintage drop',
      eventChat: 'Sunday vintage drop',
      eventManager: 'Sunday vintage drop',
    });
    expect(selected).toEqual({
      stageStatus: 'Avi Real Test',
      eventChat: 'Avi Real Test',
      eventManager: 'Avi Real Test',
    });
  });

  it('keeps Inventory and Event Manager selected on mobile reloads', () => {
    expect(shouldUseMobileStudio('active-event', true)).toBe(true);
    expect(shouldUseMobileStudio('event-manager', true)).toBe(false);
    expect(shouldUseMobileStudio('inventory', true)).toBe(false);
    expect(shouldUseMobileStudio('active-event', false)).toBe(false);
  });

  it('exposes the exact three peer Studio subtabs in order', () => {
    expect(STUDIO_VIEW_TABS).toEqual([
      { id: 'inventory', label: 'Inventory' },
      { id: 'event-manager', label: 'Event Manager' },
      { id: 'active-event', label: 'Active Event' },
    ]);
  });

  it('maps the default view to the independently persisted live-operation board', () => {
    const config = studioBoardConfig('active-event');
    expect(config.layoutName).toBe('seller-active-event');
    expect(config.resetEventName).toContain('active-event');
    expect(panelIds(config.layoutSeed)).toEqual([
      'stage-status',
      'copilot',
      'run-of-show',
      'inventory',
    ]);
  });

  it('maps Event Manager to its own persisted preparation board', () => {
    const active = studioBoardConfig('active-event');
    const manager = studioBoardConfig('event-manager');
    expect(manager.layoutName).toBe('seller-event-manager');
    expect(manager.resetEventName).toContain('event-manager');
    expect(panelIds(manager.layoutSeed)).toEqual([
      'event-manager',
    ]);
    expect(manager.layoutName).not.toBe(active.layoutName);
    expect(manager.resetEventName).not.toBe(active.resetEventName);
  });

  it('preserves transcript ingestion through the named mutation REST fallback', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'transcript-1' }),
      text: async () => '',
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    let record: ReturnType<typeof useTranscriptMomentRecorder> | null = null;

    function Harness() {
      record = useTranscriptMomentRecorder({
        eventId: 'configured-event',
        roomEventId: 'live/event',
        selectedProductId: 'mug',
        transcriptProducts: [{ id: 'mug', label: 'Stoneware mug' }],
        apiBaseUrl: 'https://sidestage.example/',
      });
      return null;
    }

    try {
      await act(async () => root.render(createElement(Harness)));
      await act(async () => {
        await record?.({ text: 'Here is the mug', startMs: 2_000, endMs: 3_500 });
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://sidestage.example/chat/events/live%2Fevent/transcript',
      );
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        text: 'Here is the mug',
        startMs: 2_000,
        endMs: 3_500,
        productId: 'mug',
        productTitle: 'Stoneware mug',
      });
      await act(async () => root.unmount());
    } finally {
      vi.unstubAllGlobals();
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it('keeps the Deepgram token provider stable across ordinary Studio rerenders', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const providers: Array<() => Promise<string | null>> = [];
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    function Harness({ apiBaseUrl }: { apiBaseUrl?: string }) {
      providers.push(useSellerDeepgramTokenProvider(apiBaseUrl));
      return null;
    }

    try {
      await act(async () => root.render(createElement(Harness, { apiBaseUrl: 'https://api.example' })));
      const initial = providers.at(-1);
      await act(async () => root.render(createElement(Harness, { apiBaseUrl: 'https://api.example' })));
      expect(providers.at(-1)).toBe(initial);

      await act(async () => root.render(createElement(Harness, { apiBaseUrl: 'https://other.example' })));
      expect(providers.at(-1)).not.toBe(initial);
      await act(async () => root.unmount());
    } finally {
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});
