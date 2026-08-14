import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import {
  DockWorkspace,
  type DockLayoutStore,
  type PanelComponent,
  type PanelRegistry,
} from '@papercusp/dock-workbench';
import './seller-dock.css';
import {
  SELLER_DOCK_LAYOUT_NAME,
  type SellerPanelId,
} from './seller-dock-layout';
import { SELLER_DOCK_RESET_EVENT, createSellerDockStore } from './seller-dock-store';
import { SellerDockBoard } from './SellerDockBoard';
import { SellerDockToolbar } from './SellerDockToolbar';
import type { SellerDockPanelContextValue } from './seller-dock-panel-props';

/**
 * Seller dock host (P-007).
 *
 * D-007: this ADAPTS `@papercusp/dock-workbench` — it does not hand-roll
 * DockviewReact hosting, panel registry, or layout persistence. What lives here
 * is only the SideStage-specific part: the seller layout seed, the token-themed
 * chrome, and the context seam that feeds panels their props.
 *
 * Lane boundaries:
 *   P-007 (this file) — the host, the default layout, the chrome, the seam.
 *   P-009            — registers a component for each SellerPanelId.
 *   P-010            — persistence hardening + the reset control. The store now
 *                      lives in `./seller-dock-store` (it self-heals an
 *                      unreadable saved layout instead of letting the dock fail
 *                      to load) and the control in `./SellerDockToolbar`, which
 *                      reaches the dock through `resetEventName` below.
 */

/**
 * Props for the seller panels, supplied through context.
 *
 * D-006 is the reason this context exists at all: panel props MUST NOT travel
 * as dockview panel `params`. dockview serializes `params` into the layout JSON
 * that P-010 persists, and this bundle holds refs (`videoRef`), callbacks and
 * live MediaStream objects — none of which survive JSON. Routing them through
 * `params` would either corrupt the persisted layout or force P-010 to strip
 * them back out on every save.
 *
 * P-009 replaced the original open `[key: string]: unknown` bag with a concrete
 * per-panel shape. That shape lives in `./seller-dock-panel-props` rather than
 * here, which preserves the property the open bag was protecting: adding a
 * panel does not change the dock host. Widening it in place would have made
 * this host import all six panel components' types, so every new panel would
 * edit the host — exactly what the open bag existed to avoid.
 */
export type { SellerDockPanelContextValue };

const SellerDockContext = createContext<SellerDockPanelContextValue | null>(null);

/**
 * Read the seller panel props from inside a docked panel.
 *
 * Throws rather than returning null: a panel rendered outside the provider is a
 * wiring bug that would otherwise surface as a scatter of undefined props deep
 * in a child component, far from the cause.
 */
export function useSellerDockPanels(): SellerDockPanelContextValue {
  const value = useContext(SellerDockContext);
  if (!value) {
    throw new Error('useSellerDockPanels must be used within <SellerDock>');
  }
  return value;
}

/**
 * Panel types that may be registered after first paint.
 *
 * Module scope, not an inline arrow: `DockWorkspace` documents that this must be
 * referentially stable or its dead-layout guard re-runs on every commit.
 *
 * Every seller panel is registered synchronously by P-009, so nothing is
 * genuinely deferred — returning false keeps the guard at its STRICTEST, which
 * is the safe direction. If a seller panel ever loads lazily, add it here or the
 * guard may discard a perfectly good saved layout while that load is in flight.
 */
const isDeferredPanelType = (_type: string): boolean => false;

/**
 * The class applied to the dockview root (P-011).
 *
 * BOTH halves are load-bearing, and the first one is easy to lose:
 *
 *   `dockview-theme-light` — dockview defines its ~110 `--dv-*` variables
 *     INSIDE its theme classes, not on :root. `DockWorkspace` renders
 *     `className ?? 'dockview-theme-dark'`, so a consumer that passes a
 *     className REPLACES the base theme rather than adding to it. SideStage is
 *     the first consumer to pass one, and it silently did exactly that: 29 of
 *     the 47 `--dv-*` variables dockview's generic rules consume resolved to
 *     nothing — including `--dv-sash-color` (the resize handles), the tab-strip
 *     height, tab font-size, radii and every transition. Naming the light theme
 *     (SideStage is a light, cream-ground app — `--bg: #FFF8EF`) supplies sane
 *     structural defaults for all but 6 of them; the colour layer below then
 *     re-points everything visible at SideStage tokens.
 *
 *   `seller-dock-theme` — that token layer, in ./seller-dock.css. It must come
 *     AFTER the base theme: both are single-class selectors, so equal
 *     specificity makes source order the tiebreak, and seller-dock.css is
 *     imported after dock-workbench (which imports dockview.css).
 *
 * Exported so the chrome guard test can assert the pairing directly, rather
 * than the test restating a literal that could drift from this one.
 */
export const SELLER_DOCK_CLASS_NAME = 'dockview-theme-light seller-dock-theme';

export interface SellerDockProps {
  /** Panel props bundle, supplied to panels via context (never via params). */
  panels: SellerDockPanelContextValue;
  /** Panel registry. Defaults to P-009's registry with all six seller panels. */
  registry?: PanelRegistry;
  /** Layout store. Defaults to localStorage seeded with the default layout. */
  store?: DockLayoutStore;
  /**
   * Rendered when a persisted layout names a panel this build cannot render.
   *
   * Typed as the workbench's own `PanelComponent` rather than restating the
   * prop shape: `DockWorkspace` passes every panel the full `PanelComponentProps`
   * (which carries `params` and `api` alongside `panelId`/`panelType`), so a
   * narrower local restatement is not assignable to the prop it feeds.
   */
  missingComponent?: PanelComponent;
  children?: ReactNode;
}

export function SellerDock({ panels, registry, store, missingComponent }: SellerDockProps) {
  // A fresh store per mount would re-seed and drop the user's saved layout, so
  // it is memoised for the life of the component.
  const layoutStore = useMemo(() => store ?? createSellerDockStore(), [store]);
  const shellRef = useRef<HTMLDivElement>(null);

  return (
    <SellerDockContext.Provider value={panels}>
      <div ref={shellRef} className="seller-dock-shell">
        <SellerDockToolbar fullscreenTargetRef={shellRef} />
        {/*
          P-015 wraps the host in a resize frame. It is a WRAPPER, not a
          replacement: .seller-dock-host keeps the geometry P-007/P-011 gave it
          (the height clamp, the border, the overflow), and the frame only
          overrides those dimensions once the user has actually dragged. The
          same reasoning as P-010's toolbar — a later lane adds a layer around
          this block rather than editing decisions that belong to an earlier one.
        */}
        <SellerDockBoard><div className="seller-dock-host">
          {/*
            `registry` and `missingComponent` are supplied by the caller rather
            than defaulted here. Defaulting them would mean importing
            ./seller-dock-panels, which imports this module for the context hook —
            a cycle — and would re-couple the host to the panel inventory that the
            props-module split above deliberately decoupled it from.
          */}
          <DockWorkspace
            layoutName={SELLER_DOCK_LAYOUT_NAME}
            store={layoutStore}
            registry={registry}
            className={SELLER_DOCK_CLASS_NAME}
            resetEventName={SELLER_DOCK_RESET_EVENT}
            isDeferredPanelType={isDeferredPanelType}
            missingComponent={missingComponent}
          />
        </div></SellerDockBoard>
      </div>
    </SellerDockContext.Provider>
  );
}

export type { SellerPanelId };
