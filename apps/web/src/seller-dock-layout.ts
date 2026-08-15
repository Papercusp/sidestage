import type { LayoutDoc, PanelInstance, TabStrip } from '@papercusp/dock-workbench';

/**
 * Default dock layout for the Seller tab (P-007).
 *
 * The Live console owns camera, audience chat, captions, and transcript history
 * as one persistent surface. The rail therefore contains only run-of-show;
 * neither chat nor transcription is an independently dockable default panel.
 * Sizes are nominal ratios consumed by dock-workbench serialization.
 */

/** Stable panel ids. P-009 registers a component against each of these. */
export type SellerPanelId =
  | 'stage-status'
  | 'on-deck'
  | 'copilot'
  | 'event-chat'
  | 'event-manager'
  | 'inventory'
  | 'run-of-show';

/** The complete seller panel inventory (D-004). */
export const SELLER_PANEL_IDS: readonly SellerPanelId[] = [
  'stage-status',
  'on-deck',
  'copilot',
  'event-chat',
  'event-manager',
  'inventory',
  'run-of-show',
];

/** Tab-strip labels, keyed by panel id. */
export const SELLER_PANEL_TITLES: Readonly<Record<SellerPanelId, string>> = {
  'stage-status': 'Live console',
  'on-deck': 'On deck',
  copilot: 'Copilot',
  'event-chat': 'Event chat',
  'event-manager': 'Event manager',
  inventory: 'Inventory',
  'run-of-show': 'Run of show',
};

/** Panels on the default Active Event board. Chat and transcript are embedded in Live console. */
export const SELLER_ACTIVE_PANEL_IDS = [
  'stage-status',
  'copilot',
  'run-of-show',
  'inventory',
] as const satisfies readonly SellerPanelId[];

/** Panels on the independently persisted Event Manager board. */
export const SELLER_MANAGER_PANEL_IDS = [
  'event-manager',
] as const satisfies readonly SellerPanelId[];

/** Stable names are also the localStorage identity for each Studio board. */
export const SELLER_ACTIVE_DOCK_LAYOUT_NAME = 'seller-active-event';
export const SELLER_MANAGER_DOCK_LAYOUT_NAME = 'seller-event-manager';

/** Compatibility alias for helpers/tests that operate on the default board. */
export const SELLER_DOCK_LAYOUT_NAME = SELLER_ACTIVE_DOCK_LAYOUT_NAME;

/**
 * A single-panel tab strip.
 *
 * D-006: `params` carries the panel id and NOTHING else. Props reach panels via
 * React context, never through dockview params — params are serialized into the
 * persisted layout, and refs/functions/live objects are not serializable.
 */
function strip(ids: readonly SellerPanelId[], size: number, activePanelId = ids[0]!): TabStrip {
  const panels: PanelInstance[] = ids.map((id) => ({
    id,
    type: id,
    title: SELLER_PANEL_TITLES[id],
  }));
  return { kind: 'tabs', id: `${activePanelId}-group`, activePanelId, panels, size };
}

function solo(id: SellerPanelId, size: number): TabStrip {
  return strip([id], size, id);
}

/**
 * The default seller layout. A fresh function per call: `LayoutDoc` is handed to
 * a store that may mutate/serialize it, so callers must never share one object.
 */
export function sellerActiveEventDockDefaultLayout(): LayoutDoc {
  return {
    schemaVersion: 1,
    root: {
      kind: 'group',
      id: 'seller-active-root',
      direction: 'row',
      children: [
        {
          kind: 'group',
          id: 'seller-active-primary',
          direction: 'col',
          size: 620,
          children: [
            solo('stage-status', 650),
            solo('copilot', 350),
          ],
        },
        {
          kind: 'group',
          id: 'seller-active-rail',
          direction: 'col',
          size: 380,
          children: [strip(['run-of-show', 'inventory'], 1000, 'run-of-show')],
        },
      ],
    },
  };
}

export function sellerEventManagerDockDefaultLayout(): LayoutDoc {
  return {
    schemaVersion: 1,
    root: solo('event-manager', 1000),
  };
}

/** Default remains Active Event for callers that do not select a Studio view. */
export function sellerDockDefaultLayout(): LayoutDoc {
  return sellerActiveEventDockDefaultLayout();
}

/** Which column a panel occupies in the default layout. */
export function defaultColumnForPanel(id: SellerPanelId): 'primary' | 'rail' {
  return id === 'stage-status' || id === 'copilot' || id === 'event-manager'
    ? 'primary'
    : 'rail';
}
