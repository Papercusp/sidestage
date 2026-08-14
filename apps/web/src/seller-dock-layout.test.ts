import { describe, expect, it } from 'vitest';

import {
  SELLER_DOCK_LAYOUT_NAME,
  SELLER_PANEL_IDS,
  SELLER_PANEL_TITLES,
  defaultColumnForPanel,
  sellerDockDefaultLayout,
  type SellerPanelId,
} from './seller-dock-layout';

/**
 * The seed's contract is D-003: first paint must be identical to the
 * `.seller-grid` it replaces. So these assert the GEOMETRY and the INVENTORY —
 * the things that make the dock look like the grid — rather than re-stating the
 * constants, which would only prove the file was copied correctly.
 */

/** Structural view of a LayoutDoc node; the workbench types are nominal to it. */
type AnyNode = {
  kind: string;
  id: string;
  size?: number;
  direction?: string;
  children?: AnyNode[];
  panels?: { id: string; type: string; title?: string }[];
  activePanelId?: string;
};

function root(): AnyNode {
  return sellerDockDefaultLayout().root as unknown as AnyNode;
}

function columnById(id: string): AnyNode {
  const found = (root().children ?? []).find((c) => c.id === id);
  if (!found) throw new Error(`no column ${id} in the default layout`);
  return found;
}

/** Panel ids in the order they are stacked down a column. */
function panelOrder(column: AnyNode): string[] {
  return (column.children ?? []).flatMap((strip) => (strip.panels ?? []).map((p) => p.id));
}

function stripsOf(column: AnyNode): AnyNode[] {
  return column.children ?? [];
}

function allStrips(): AnyNode[] {
  return [...stripsOf(columnById('seller-primary')), ...stripsOf(columnById('seller-rail'))];
}

describe('seller dock default layout — inventory', () => {
  it('places every seller panel exactly once', () => {
    const placed = allStrips().flatMap((s) => (s.panels ?? []).map((p) => p.id));

    // A panel missing here is a whole section that silently vanishes from the
    // Seller tab on first paint; a duplicate is a dockview id collision.
    expect([...placed].sort()).toEqual([...SELLER_PANEL_IDS].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('gives every panel the registered title and makes it its strip’s active tab', () => {
    for (const strip of allStrips()) {
      const panels = strip.panels ?? [];
      expect(panels).toHaveLength(1);
      const panel = panels[0];
      expect(panel.title).toBe(SELLER_PANEL_TITLES[panel.id as SellerPanelId]);
      // A solo strip whose activePanelId does not name its only panel renders blank.
      expect(strip.activePanelId).toBe(panel.id);
      expect(panel.type).toBe(panel.id);
    }
  });
});

describe('seller dock default layout — grid fidelity', () => {
  it('reproduces the seller-grid cell map, column by column and in order', () => {
    // Columns are NOT interchangeable: this order IS "mirrors the grid exactly".
    expect(panelOrder(columnById('seller-primary'))).toEqual([
      'stage-status',
      'copilot',
      'event-manager',
    ]);
    expect(panelOrder(columnById('seller-rail'))).toEqual([
      'transcript',
      'on-deck',
      'event-chat',
    ]);
  });

  it('keeps defaultColumnForPanel in agreement with the layout it describes', () => {
    // Two sources of truth for the same fact — P-009/P-010 read the helper, the
    // dock reads the doc. Nothing else forces them to stay in step.
    const primary = new Set(panelOrder(columnById('seller-primary')));
    for (const id of SELLER_PANEL_IDS) {
      expect(defaultColumnForPanel(id)).toBe(primary.has(id) ? 'primary' : 'rail');
    }
  });

  it('splits width on the grid’s 1.2fr / .8fr ratio', () => {
    const primary = columnById('seller-primary').size ?? 0;
    const rail = columnById('seller-rail').size ?? 0;
    expect(primary / (primary + rail)).toBeCloseTo(1.2 / 2, 10);
    expect(rail / (primary + rail)).toBeCloseTo(0.8 / 2, 10);
  });

  it('keeps the shared row line aligned across both columns', () => {
    const primary = stripsOf(columnById('seller-primary'));
    const rail = stripsOf(columnById('seller-rail'));
    const sum = (nodes: AnyNode[]) => nodes.reduce((t, n) => t + (n.size ?? 0), 0);

    // CSS grid shares row lines between columns for free. A dock does not — and
    // the naive "just split the rail into thirds" breaks exactly this, which is
    // invisible in the constants and obvious on screen.
    expect(sum(primary)).toBe(sum(rail));

    // stage-status spans grid rows 1-2, so the boundary beneath it must land at
    // the same offset as the boundary beneath transcript + on-deck.
    const stageStatus = primary[0].size ?? 0;
    expect(stageStatus).toBe((rail[0].size ?? 0) + (rail[1].size ?? 0));
    expect(stageStatus / sum(primary)).toBeCloseTo(0.5, 10);
  });
});

describe('seller dock default layout — persistence safety', () => {
  it('survives a JSON round trip unchanged', () => {
    // The seed is serialized into persisted layout state (D-006). A ref, a
    // function, or a live object smuggled into a panel would be silently
    // dropped here and only surface as a broken restore.
    const layout = sellerDockDefaultLayout();
    expect(JSON.parse(JSON.stringify(layout))).toEqual(layout);
  });

  it('hands out a fresh document per call', () => {
    const first = sellerDockDefaultLayout();
    const second = sellerDockDefaultLayout();
    expect(first).not.toBe(second);
    expect(first.root).not.toBe(second.root);

    // The store mutates what it is seeded with; a shared object would leak one
    // session's dragged layout into the next "reset to default".
    (first.root as unknown as AnyNode).children![0].size = 1;
    expect((second.root as unknown as AnyNode).children![0].size).not.toBe(1);
    expect(sellerDockDefaultLayout()).toEqual(second);
  });

  it('pins the storage key P-010 persists under', () => {
    // Renaming this orphans every already-persisted seller layout.
    expect(SELLER_DOCK_LAYOUT_NAME).toBe('seller');
  });
});
