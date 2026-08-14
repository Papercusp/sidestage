import type { ReactNode } from 'react';
import {
  createPanelRegistry,
  type PanelComponent,
  type PanelRegistry,
} from '@papercusp/dock-workbench';
import { CopilotPanel } from './CopilotPanel';
import { EventChat } from './EventChat';
import EventManager from './events/EventManager';
import { SELLER_PANEL_IDS, SELLER_PANEL_TITLES, type SellerPanelId } from './seller-dock-layout';
import { useSellerDockPanels } from './SellerDock';
import { OnDeckPanel } from './seller/OnDeckPanel';
import { RunOfShowPanel } from './seller/RunOfShowPanel';
import { StageStatusPanel } from './seller/StageStatusPanel';

/**
 * Seller panel registration (P-009).
 *
 * This is the ONLY new seam between the dock and the seller components. Each
 * entry below is an adapter: it reads the props bundle from context (D-006/
 * D-009) and spreads it into the existing component, which stays untouched
 * (D-003 — components mount unchanged inside the panels).
 *
 * Lane boundaries:
 *   P-007 — the host, the default layout, the chrome, the context seam.
 *   P-009 (this file) — a component per SellerPanelId, and the registry.
 *   P-010 — persistence hardening.
 */

/**
 * Panel body wrapper.
 *
 * `.seller-dock-panel` is P-007's chrome class (height:100%, overflow:auto,
 * padding matching `.stage-panel`). It exists in seller-dock.css but had no
 * consumer until now — it is the seam P-007 left for this lane, so the panels
 * pick up the grid's padding rhythm without any component changing.
 *
 * The wrapper also owns the SCROLL boundary. Dockview gives a panel a fixed
 * box; without `overflow:auto` here, a tall panel (for example event chat)
 * would overflow its group rather than scroll inside it.
 */
function PanelBody({ children }: { children: ReactNode }) {
  return <div className="seller-dock-panel">{children}</div>;
}

/*
 * One adapter per panel.
 *
 * These are module-scope function declarations, NOT inline arrows built during
 * render. Dockview keys a panel's React tree by its component identity, so a
 * component recreated each render remounts the panel on every parent render —
 * which for these panels means tearing down the video preview or chat
 * subscription. Module scope makes the identity permanent.
 */

const StageStatusDockPanel: PanelComponent = function StageStatusDockPanel() {
  const panels = useSellerDockPanels();
  return (
    <PanelBody>
      <StageStatusPanel {...panels['stage-status']} />
    </PanelBody>
  );
};

const OnDeckDockPanel: PanelComponent = function OnDeckDockPanel() {
  const panels = useSellerDockPanels();
  return (
    <PanelBody>
      <OnDeckPanel {...panels['on-deck']} />
    </PanelBody>
  );
};

const CopilotDockPanel: PanelComponent = function CopilotDockPanel() {
  const panels = useSellerDockPanels();
  return (
    <PanelBody>
      <CopilotPanel {...panels.copilot} />
    </PanelBody>
  );
};

const EventChatDockPanel: PanelComponent = function EventChatDockPanel() {
  const panels = useSellerDockPanels();
  return (
    <PanelBody>
      <EventChat {...panels['event-chat']} />
    </PanelBody>
  );
};

const EventManagerDockPanel: PanelComponent = function EventManagerDockPanel() {
  const panels = useSellerDockPanels();
  return (
    <PanelBody>
      <EventManager {...panels['event-manager']} />
    </PanelBody>
  );
};

const RunOfShowDockPanel: PanelComponent = function RunOfShowDockPanel() {
  const panels = useSellerDockPanels();
  return (
    <PanelBody>
      <RunOfShowPanel {...panels['run-of-show']} />
    </PanelBody>
  );
};

/**
 * Every panel id mapped to its component.
 *
 * `Record<SellerPanelId, ...>` is doing real work: it makes the mapping
 * EXHAUSTIVE. A panel id added to the union fails to compile here until it has
 * a component, so a layout can never name a panel this build forgot to
 * register — which would otherwise only surface at runtime as the missing-panel
 * fallback, in a dock the user has already customised.
 */
export const SELLER_PANEL_COMPONENTS: Record<SellerPanelId, PanelComponent> = {
  'stage-status': StageStatusDockPanel,
  'on-deck': OnDeckDockPanel,
  copilot: CopilotDockPanel,
  'event-chat': EventChatDockPanel,
  'event-manager': EventManagerDockPanel,
  'run-of-show': RunOfShowDockPanel,
};

/**
 * Shown when a persisted layout names a panel this build cannot render.
 *
 * Reachable in normal use: a saved layout outlives the code that wrote it, so a
 * renamed or removed panel id arrives here after an upgrade. Rendering a quiet
 * placeholder keeps the rest of the user's layout intact; the alternative
 * (throwing) would take down the whole dock over one stale panel.
 */
export function SellerDockMissingPanel({ panelType }: { panelType: string }) {
  return (
    <div className="seller-dock-missing">
      This panel (<code>{panelType}</code>) is not available in this version.
    </div>
  );
}

/**
 * Build a registry with every seller panel registered.
 *
 * A factory rather than a bare module-scope singleton so tests can build an
 * isolated registry; `sellerPanelRegistry` below is the shared instance the app
 * actually uses.
 */
export function createSellerPanelRegistry(): PanelRegistry {
  const registry = createPanelRegistry();
  for (const id of SELLER_PANEL_IDS) {
    registry.register(id, SELLER_PANEL_COMPONENTS[id], { title: SELLER_PANEL_TITLES[id] });
  }
  return registry;
}

/**
 * The app's seller panel registry.
 *
 * Module scope is deliberate. `DockWorkspace` re-runs its dead-layout guard
 * when the registry identity changes, so a registry rebuilt per render would
 * re-validate the layout on every commit. The adapters hold no per-instance
 * state — every panel reads context — so one shared instance is correct.
 */
export const sellerPanelRegistry = createSellerPanelRegistry();
