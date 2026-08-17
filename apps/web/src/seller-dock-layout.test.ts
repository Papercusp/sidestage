import { describe, expect, it } from 'vitest';

import {
  SELLER_ACTIVE_DOCK_LAYOUT_NAME,
  SELLER_ACTIVE_PANEL_IDS,
  SELLER_MANAGER_DOCK_LAYOUT_NAME,
  SELLER_MANAGER_PANEL_IDS,
  SELLER_PANEL_TITLES,
  sellerActiveEventDockDefaultLayout,
  sellerEventManagerDockDefaultLayout,
  type SellerPanelId,
} from './seller-dock-layout';

type AnyNode = {
  kind: string;
  id: string;
  size?: number;
  direction?: string;
  children?: AnyNode[];
  panels?: { id: string; type: string; title?: string }[];
  activePanelId?: string;
};

function allStrips(node: AnyNode): AnyNode[] {
  if (node.kind === 'tabs') return [node];
  return (node.children ?? []).flatMap(allStrips);
}

function panelsIn(layout: { root: unknown }): string[] {
  return allStrips(layout.root as AnyNode).flatMap((strip) => (
    strip.panels ?? []
  ).map((panel) => panel.id));
}

function child(root: AnyNode, id: string): AnyNode {
  const found = (root.children ?? []).find((node) => node.id === id);
  if (!found) throw new Error(`no child ${id}`);
  return found;
}

describe('Studio dock board seeds', () => {
  it('keeps transcript and Event Chat inside Live console instead of default dock panes', () => {
    const layout = sellerActiveEventDockDefaultLayout();
    const placed = panelsIn(layout);

    expect(placed).toEqual([
      'stage-status',
      'copilot',
      'run-of-show',
      'inventory',
    ]);
    expect(new Set(placed)).toEqual(new Set(SELLER_ACTIVE_PANEL_IDS));
    expect(placed).not.toContain('event-chat');
    expect(placed).not.toContain('event-manager');
    expect(placed).not.toContain('event-settings');
    expect(placed).not.toContain('on-deck');
    expect(placed).not.toContain('transcript');
  });

  it('seeds only Event Manager while Settings and the run-of-show planner live inside the selected event (folded into Lineup)', () => {
    const layout = sellerEventManagerDockDefaultLayout();
    const root = layout.root as AnyNode;

    expect(root.kind).toBe('tabs');
    expect(panelsIn(layout)).toEqual([...SELLER_MANAGER_PANEL_IDS]);
    expect(panelsIn(layout)).not.toContain('event-settings');
    expect(panelsIn(layout)).not.toContain('run-of-show-planner');
    expect(root.activePanelId).toBe('event-manager');
  });

  it('uses the registered title and type for every seeded panel', () => {
    for (const layout of [
      sellerActiveEventDockDefaultLayout(),
      sellerEventManagerDockDefaultLayout(),
    ]) {
      for (const strip of allStrips(layout.root as AnyNode)) {
        expect((strip.panels ?? []).map((panel) => panel.id)).toContain(strip.activePanelId);
        for (const panel of strip.panels ?? []) {
          expect(panel.type).toBe(panel.id);
          expect(panel.title).toBe(SELLER_PANEL_TITLES[panel.id as SellerPanelId]);
        }
      }
    }
  });

  it('gives the live console the larger Active Event column and panel share', () => {
    const root = sellerActiveEventDockDefaultLayout().root as AnyNode;
    const primary = child(root, 'seller-active-primary');
    const rail = child(root, 'seller-active-rail');
    const width = (primary.size ?? 0) + (rail.size ?? 0);

    expect((primary.size ?? 0) / width).toBeCloseTo(0.62, 10);
    expect((rail.size ?? 0) / width).toBeCloseTo(0.38, 10);
    expect((primary.children?.[0].size ?? 0) / 1000).toBeCloseTo(0.65, 10);
  });

  it('places Inventory beside Run of Show in one utility tab strip without changing the default live tab', () => {
    const root = sellerActiveEventDockDefaultLayout().root as AnyNode;
    const rail = child(root, 'seller-active-rail');
    const utility = rail.children?.[0];

    expect(utility?.kind).toBe('tabs');
    expect(utility?.panels?.map((panel) => panel.id)).toEqual(['run-of-show', 'inventory']);
    expect(utility?.activePanelId).toBe('run-of-show');
  });

  it('hands out fresh, JSON-safe layout documents', () => {
    for (const seed of [
      sellerActiveEventDockDefaultLayout,
      sellerEventManagerDockDefaultLayout,
    ]) {
      const first = seed();
      const second = seed();
      expect(first).not.toBe(second);
      expect(first.root).not.toBe(second.root);
      expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    }
  });

  it('pins distinct persistence names so board geometry cannot overwrite its sibling', () => {
    expect(SELLER_ACTIVE_DOCK_LAYOUT_NAME).toBe('seller-active-event');
    expect(SELLER_MANAGER_DOCK_LAYOUT_NAME).toBe('seller-event-manager');
    expect(SELLER_ACTIVE_DOCK_LAYOUT_NAME).not.toBe(SELLER_MANAGER_DOCK_LAYOUT_NAME);
  });
});
