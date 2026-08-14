/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  shouldUseMobileStudio,
  STUDIO_VIEW_TABS,
  studioBoardConfig,
  useTranscriptMomentRecorder,
} from './SellerTab';
import {
  isMobileStudioViewport,
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
      { id: 'chat', label: 'Chat' },
      { id: 'copilot', label: 'Copilot' },
    ]);
    expect(isMobileStudioViewport((query) => ({
      matches: query === STUDIO_MOBILE_MEDIA_QUERY,
    }))).toBe(true);
    expect(isMobileStudioViewport(() => ({ matches: false }))).toBe(false);
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
      'event-chat',
      'run-of-show',
    ]);
  });

  it('maps Event Manager to its own persisted preparation board', () => {
    const active = studioBoardConfig('active-event');
    const manager = studioBoardConfig('event-manager');
    expect(manager.layoutName).toBe('seller-event-manager');
    expect(manager.resetEventName).toContain('event-manager');
    expect(panelIds(manager.layoutSeed)).toEqual([
      'event-manager',
      'event-settings',
      'run-of-show-planner',
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
});
