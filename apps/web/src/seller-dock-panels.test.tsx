import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SELLER_PANEL_IDS, SELLER_PANEL_TITLES } from './seller-dock-layout';
import {
  SELLER_PANEL_COMPONENTS,
  SellerDockMissingPanel,
  createSellerPanelRegistry,
} from './seller-dock-panels';

/**
 * P-009 panel-registration tests.
 *
 * These assert the invariants THIS lane owns — that every panel the layout can
 * name is registered, and that panels take their props from the context seam
 * (D-006/D-009) rather than from dockview params. Full seller-tab QA, including
 * driving the real dock in the browser, is P-012.
 */

/** The props dockview hands a registered panel; our adapters ignore all of them. */
const panelProps = (panelType: string) => ({
  panelId: panelType,
  panelType,
  params: {},
  api: { setParams: () => undefined, setTitle: () => undefined, close: () => undefined },
});

describe('seller panel registry', () => {
  it('registers exactly the panel inventory the layout can name', () => {
    const registry = createSellerPanelRegistry();
    // Sorted both sides: registry.list() sorts, and equality on a set-like
    // comparison should not depend on declaration order.
    expect(registry.list()).toEqual([...SELLER_PANEL_IDS].sort());
  });

  it('registers every panel with its layout title', () => {
    const registry = createSellerPanelRegistry();
    for (const id of SELLER_PANEL_IDS) {
      expect(registry.get(id)?.meta.title).toBe(SELLER_PANEL_TITLES[id]);
    }
  });

  /**
   * Guards the remount hazard documented on the components: dockview keys a
   * panel's React tree by component identity, so an adapter rebuilt per call
   * would tear down the video preview / transcript socket / chat subscription
   * on every render. Two independent registries must hand back the SAME
   * component objects.
   */
  it('reuses one stable component identity per panel across registries', () => {
    const a = createSellerPanelRegistry();
    const b = createSellerPanelRegistry();
    for (const id of SELLER_PANEL_IDS) {
      expect(a.get(id)?.component).toBe(b.get(id)?.component);
      expect(a.get(id)?.component).toBe(SELLER_PANEL_COMPONENTS[id]);
    }
  });
});

describe('seller panels read props from context, not params', () => {
  /**
   * The load-bearing assertion for D-006/D-009.
   *
   * Every adapter resolves its props through `useSellerDockPanels()`, which
   * throws outside the provider. So rendering one with dockview's params
   * present but NO provider must still throw — if an adapter ever regressed to
   * reading `params`, it would render happily here and this test would fail.
   * That regression is otherwise invisible until a persisted layout round-trips
   * and the props come back as JSON husks.
   */
  it.each([...SELLER_PANEL_IDS])('%s throws when rendered outside the provider', (id) => {
    const Panel = SELLER_PANEL_COMPONENTS[id];
    expect(() => renderToStaticMarkup(<Panel {...panelProps(id)} />)).toThrow(
      /useSellerDockPanels must be used within <SellerDock>/,
    );
  });
});

describe('missing-panel fallback', () => {
  it('names the panel type a stale layout asked for', () => {
    const html = renderToStaticMarkup(<SellerDockMissingPanel panelType="retired-panel" />);
    expect(html).toContain('retired-panel');
    expect(html).toContain('seller-dock-missing');
  });
});
