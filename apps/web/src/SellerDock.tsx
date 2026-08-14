import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  DockWorkspace,
  createLocalStorageDockLayoutStore,
  type DockLayoutStore,
  type PanelRegistry,
} from '@papercusp/dock-workbench';
import './seller-dock.css';
import {
  SELLER_DOCK_LAYOUT_NAME,
  sellerDockDefaultLayout,
  type SellerPanelId,
} from './seller-dock-layout';

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
 *   P-010            — hardens persistence (versioning, reset affordance).
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
 * The shape is intentionally open: P-009 owns the concrete per-panel props and
 * widens this as it wires each panel. Keeping it a single bundle means adding a
 * panel never changes the dock host.
 */
export interface SellerDockPanelContextValue {
  [key: string]: unknown;
}

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
 * The localStorage-backed layout store, seeded with the default seller layout.
 *
 * Exported so P-010 can wrap or replace it (and so tests can hand in their own)
 * without reaching into this component.
 */
export function createSellerDockStore(keyPrefix = 'sidestage.dock'): DockLayoutStore {
  return createLocalStorageDockLayoutStore({
    keyPrefix,
    seed: () => sellerDockDefaultLayout(),
  });
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

export interface SellerDockProps {
  /** Panel props bundle, supplied to panels via context (never via params). */
  panels: SellerDockPanelContextValue;
  /** Panel registry. P-009 populates it; defaults to the workbench's shared one. */
  registry?: PanelRegistry;
  /** Layout store. Defaults to localStorage seeded with the default layout. */
  store?: DockLayoutStore;
  children?: ReactNode;
}

export function SellerDock({ panels, registry, store }: SellerDockProps) {
  // A fresh store per mount would re-seed and drop the user's saved layout, so
  // it is memoised for the life of the component.
  const layoutStore = useMemo(() => store ?? createSellerDockStore(), [store]);

  return (
    <SellerDockContext.Provider value={panels}>
      <div className="seller-dock-host">
        <DockWorkspace
          layoutName={SELLER_DOCK_LAYOUT_NAME}
          store={layoutStore}
          registry={registry}
          className="seller-dock-theme"
          isDeferredPanelType={isDeferredPanelType}
        />
      </div>
    </SellerDockContext.Provider>
  );
}

export type { SellerPanelId };
