import type { LayoutDoc, PanelInstance, TabStrip } from '@papercusp/dock-workbench';

/**
 * Default dock layout for the Seller tab (P-007).
 *
 * Expressed as a dock-workbench `LayoutDoc` (D-007: adapt the workbench, do not
 * hand-roll DockviewReact wiring). Keeping it as data is deliberate: it is the
 * `seed` handed to the layout store, P-010 diffs a restored layout against it,
 * and P-012 can assert the mapping below with no DOM.
 *
 * ── Provenance: the styles.css rules this layout reproduces ───────────────
 *   .seller-grid   { display: grid; grid-template-columns: 1.2fr .8fr; }
 *   .stage-primary { grid-row: span 2; min-height: 330px; }
 *
 * `.seller-grid` has six children, auto-placed row-major into two columns.
 * Because `.stage-primary` spans two rows, the cell map today is:
 *
 *   row 1 | stage-status (spans 1-2) | transcript    |
 *   row 2 |            ""            | on-deck       |
 *   row 3 | copilot                  | event-chat    |
 *   row 4 | event-manager            | (empty cell)  |
 *
 * So the columns are NOT interchangeable: which column a panel sits in, and its
 * order within that column, is what "mirrors the seller-grid exactly" means
 * (D-003: first paint must be identical to the grid it replaces).
 *
 * ── Sizing ───────────────────────────────────────────────────────────────
 * Sizes pass straight through `toDockviewJson` into dockview's serialized grid,
 * which rescales a branch to whatever the container actually is. Only the
 * RATIOS survive, so these are nominal units on a 1000x1000 basis rather than
 * real pixels.
 *
 * Widths come from `1.2fr .8fr` -> 600 / 400.
 *
 * Heights are expressed against the grid's four row-units so the row LINES
 * still align across the two columns — which CSS grid gives for free (rows are
 * shared between columns) and which a naive "just split the rail into thirds"
 * would quietly break:
 *
 *   primary: stage-status 2/4, copilot 1/4, event-manager 1/4
 *   rail:    transcript   1/4, on-deck  1/4, event-chat 1/4 + the empty row-4
 *            cell, which has no dock equivalent — a dock column always fills,
 *            so the trailing panel absorbs it (1/4 + 1/4 = 1/2).
 *
 * The shared boundary at the halfway mark therefore lands in the same place in
 * both columns, exactly as it does in the grid today.
 */

/** Stable panel ids. P-009 registers a component against each of these. */
export type SellerPanelId =
  | 'stage-status'
  | 'transcript'
  | 'on-deck'
  | 'copilot'
  | 'event-chat'
  | 'event-manager'
  | 'event-settings';

/** The complete seller panel inventory (D-004). */
export const SELLER_PANEL_IDS: readonly SellerPanelId[] = [
  'stage-status',
  'transcript',
  'on-deck',
  'copilot',
  'event-chat',
  'event-manager',
  'event-settings',
];

/** Tab-strip labels, keyed by panel id. */
export const SELLER_PANEL_TITLES: Readonly<Record<SellerPanelId, string>> = {
  'stage-status': 'Live console',
  transcript: 'Transcript',
  'on-deck': 'On deck',
  copilot: 'Copilot',
  'event-chat': 'Event chat',
  'event-manager': 'Event manager',
  'event-settings': 'Event settings',
};

/** The layout name this dock persists under (P-010 keys storage by it). */
export const SELLER_DOCK_LAYOUT_NAME = 'seller';

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
export function sellerDockDefaultLayout(): LayoutDoc {
  return {
    schemaVersion: 1,
    root: {
      kind: 'group',
      id: 'seller-root',
      direction: 'row',
      children: [
        {
          kind: 'group',
          id: 'seller-primary',
          direction: 'col',
          size: 600, // 1.2fr
          children: [
            strip(['stage-status', 'event-settings'], 500, 'stage-status'), // one current-event strip
            solo('copilot', 250),
            solo('event-manager', 250),
          ],
        },
        {
          kind: 'group',
          id: 'seller-rail',
          direction: 'col',
          size: 400, // .8fr
          children: [
            solo('transcript', 250),
            solo('on-deck', 250),
            solo('event-chat', 500), // absorbs the grid's empty row-4 cell
          ],
        },
      ],
    },
  };
}

/** Which column a panel occupies in the default layout. */
export function defaultColumnForPanel(id: SellerPanelId): 'primary' | 'rail' {
  return id === 'stage-status' || id === 'event-settings' || id === 'copilot' || id === 'event-manager'
    ? 'primary'
    : 'rail';
}
