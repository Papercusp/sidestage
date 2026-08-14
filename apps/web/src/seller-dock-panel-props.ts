import type { ComponentProps } from 'react';
import type { CopilotPanel } from './CopilotPanel';
import type { EventChat } from './EventChat';
import type EventManager from './events/EventManager';
import type { SellerPanelId } from './seller-dock-layout';
import type { OnDeckPanel } from './seller/OnDeckPanel';
import type { StageStatusPanel } from './seller/StageStatusPanel';
import type { TranscriptPane } from './TranscriptPane';

/**
 * The props bundle every docked seller panel reads from context (P-009).
 *
 * ── Why this type lives in its own module ─────────────────────────────────
 * `SellerDock` (P-007) declared this as an open `[key: string]: unknown` bag
 * and left widening it to P-009, on the stated ground that "adding a panel
 * never changes the dock host". Widening it *in* SellerDock.tsx would have
 * spent exactly that property — the host would then import all six panel
 * components' types, so every new panel edits the host. Keeping the concrete
 * shape in this leaf module preserves P-007's intent: the host imports one
 * type, and adding a panel touches this file and the registry, never the host.
 *
 * ── Why the props are DERIVED, not restated ───────────────────────────────
 * Each entry is `ComponentProps<typeof X>` rather than a hand-written mirror of
 * X's props. A hand-written mirror is a second source of truth that drifts
 * silently: a panel gaining a required prop would still typecheck here, and the
 * gap would surface at runtime as an undefined prop inside the panel. Deriving
 * makes that a compile error at the SellerTab call site instead — the one place
 * that actually holds the value.
 *
 * ── Why it is keyed by SellerPanelId ──────────────────────────────────────
 * The keys are the same union the layout and the registry use, so the three
 * cannot disagree about what a panel is called. `Record<SellerPanelId, ...>` in
 * the registry then forces exhaustiveness: a panel id added to the union fails
 * to compile until it has both a props entry here and a registered component.
 *
 * D-006/D-009: this bundle travels by React context, NEVER as dockview panel
 * `params`. It holds a ref (`videoRef`), callbacks, and a live `MediaStream`;
 * `params` is serialized into the persisted layout, so routing props through it
 * would corrupt P-010's restore.
 */
export type SellerDockPanelContextValue = {
  'stage-status': ComponentProps<typeof StageStatusPanel>;
  transcript: ComponentProps<typeof TranscriptPane>;
  'on-deck': ComponentProps<typeof OnDeckPanel>;
  copilot: ComponentProps<typeof CopilotPanel>;
  'event-chat': ComponentProps<typeof EventChat>;
  'event-manager': ComponentProps<typeof EventManager>;
};

/**
 * Compile-time assertion that the bundle covers the panel inventory exactly.
 *
 * Without this, a panel id added to `SellerPanelId` with no props entry here
 * would only fail at the registry — and a *stale* key left behind after a panel
 * is removed would never fail at all. This catches both directions at the
 * definition site.
 */
type _BundleCoversPanelIds = SellerPanelId extends keyof SellerDockPanelContextValue
  ? keyof SellerDockPanelContextValue extends SellerPanelId
    ? true
    : ['bundle has keys that are not panel ids', Exclude<keyof SellerDockPanelContextValue, SellerPanelId>]
  : ['panel ids missing from bundle', Exclude<SellerPanelId, keyof SellerDockPanelContextValue>];
const _bundleCoversPanelIds: _BundleCoversPanelIds = true;
void _bundleCoversPanelIds;
