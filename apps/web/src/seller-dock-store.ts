import {
  DockLayoutConflictError,
  createLocalStorageDockLayoutStore,
  validateLayoutDoc,
  type DockLayoutRow,
  type DockLayoutStore,
  type GroupNode,
  type LayoutDoc,
  type TabStrip,
} from '@papercusp/dock-workbench';

import {
  SELLER_ACTIVE_DOCK_LAYOUT_NAME,
  SELLER_DOCK_LAYOUT_NAME,
  sellerActiveEventDockDefaultLayout,
  sellerDockDefaultLayout,
} from './seller-dock-layout';

/**
 * Seller dock layout persistence (P-010).
 *
 * D-007: this ADAPTS the workbench's `createLocalStorageDockLayoutStore` rather
 * than reimplementing storage. Serialization and restore-on-mount already work
 * through it (and through `useDockLayout`); what this module adds is the two
 * things the raw store does not do:
 *
 *   1. SELF-HEALING. The raw store `JSON.parse`s the stored row and then
 *      `validateLayoutDoc`s it, and lets both failures escape `load()`. That
 *      rejection reaches `useDockLayout`, which classifies it as non-transient
 *      (correctly — it is not a network blip) and puts the dock into its error
 *      state. The practical effect is that ONE bad localStorage entry replaces
 *      the entire seller tab with an error panel, on every load, until the user
 *      discovers the reset button behind it. A layout is a convenience, not
 *      user data: the right response to an unreadable one is to drop it and
 *      seed a fresh default, not to withhold the tab.
 *
 *      This is also the schema-migration path. `validateLayoutDoc` throws on any
 *      `schemaVersion` it does not recognise, so when the workbench bumps its
 *      version, every previously-stored seller layout starts failing exactly
 *      like a corrupt one — and gets discarded and reseeded, which is the
 *      correct migration for geometry. No per-version migration code is needed
 *      or wanted here.
 *
 *   2. A NAMED RESET EVENT. `DockWorkspace` listens for a reset on a window
 *      event whose name the host supplies; without one, its `reset()` is only
 *      reachable from the error screen. `SELLER_DOCK_RESET_EVENT` plus
 *      `requestSellerDockLayoutReset()` are the two halves of that seam.
 *
 * D-006 constrains what may be stored: panel IDs and geometry ONLY. Nothing in
 * this file writes panel props into the layout, and nothing reads props back out
 * of it — props reach panels through React context (see `SellerDock`).
 */

/** localStorage key prefix. The full key is `${prefix}:${layoutName}`. */
export const SELLER_DOCK_STORAGE_PREFIX = 'sidestage.dock';

/**
 * The localStorage key a given layout persists under.
 *
 * The layout NAME is what makes the key per-tab: the seller tab stores under
 * `sidestage.dock:seller`, so a future dock on another tab gets its own row and
 * neither can overwrite the other. Exported so tests and the reset path can name
 * the exact key rather than reconstructing this format by hand.
 */
export function sellerDockStorageKey(
  layoutName: string = SELLER_DOCK_LAYOUT_NAME,
  prefix: string = SELLER_DOCK_STORAGE_PREFIX,
): string {
  return `${prefix}:${layoutName}`;
}

/**
 * Window event that asks the mounted seller dock to restore its default layout.
 *
 * Namespaced because it is dispatched on `window`, which is shared with every
 * other listener in the app.
 */
export const SELLER_ACTIVE_DOCK_RESET_EVENT = 'sidestage:seller-dock:active-event:reset-layout';
export const SELLER_MANAGER_DOCK_RESET_EVENT = 'sidestage:seller-dock:event-manager:reset-layout';
export const SELLER_DOCK_RESET_EVENT = SELLER_ACTIVE_DOCK_RESET_EVENT;

/** The subset of `Storage` this module needs; keeps tests from faking all of it. */
export type LayoutStorage = Pick<Storage, 'removeItem'>;

/**
 * Ask the mounted seller dock to reset its layout.
 *
 * Returns false when there is no window to dispatch on (SSR, unit tests) so a
 * caller can tell "no dock listening" from "reset requested". Uses `Event`
 * rather than `CustomEvent`: no detail is needed, and `Event` is available in
 * every runtime this code has to build under.
 */
export function requestSellerDockLayoutReset(
  target: EventTarget | undefined = globalThis.window,
  eventName: string = SELLER_DOCK_RESET_EVENT,
): boolean {
  if (!target) return false;
  target.dispatchEvent(new Event(eventName));
  return true;
}

export interface SellerDockStoreOptions {
  /** Override the key prefix (tests, or a second dock instance). */
  keyPrefix?: string;
  /** Storage used to DROP an unreadable row. Defaults to `localStorage`. */
  storage?: LayoutStorage | null;
  /** Seed for this named Studio board. Defaults to the Active Event board. */
  seed?: () => LayoutDoc;
  /**
   * Panel the addressed board must reveal when it is entered.
   *
   * Persisted geometry still wins; only the containing tab strip's active
   * panel is changed. If the saved layout no longer contains this essential
   * panel, the row is reseeded so the route cannot hydrate into a board that
   * has lost its own destination.
   */
  foregroundPanelId?: string;
  /**
   * Called when an unreadable row was discarded and the default reseeded.
   *
   * Defaults to a `console.warn`. This is deliberately a notification and not a
   * hook that can veto the recovery: a layout that cannot be read cannot be
   * honoured, so there is no decision left for a caller to make.
   */
  onRecover?: (info: { layoutName: string; key: string; error: Error }) => void;
}

function defaultOnRecover({ key, error }: { key: string; error: Error }): void {
  console.warn(
    `[SellerDock] discarded unreadable saved layout at "${key}" and restored the default — ${error.message}`,
  );
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function withoutPanel(node: GroupNode | TabStrip, panelId: string): GroupNode | TabStrip | null {
  if (node.kind === 'tabs') {
    const panels = node.panels.filter((panel) => panel.id !== panelId && panel.type !== panelId);
    if (panels.length === 0) return null;
    return {
      ...node,
      panels,
      activePanelId: panels.some((panel) => panel.id === node.activePanelId)
        ? node.activePanelId
        : panels[0]!.id,
    };
  }

  const children = node.children
    .map((child) => withoutPanel(child, panelId))
    .filter((child): child is GroupNode | TabStrip => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return { ...children[0], size: node.size ?? children[0].size };
  return { ...node, children };
}

function containsPanel(node: GroupNode | TabStrip, panelId: string): boolean {
  if (node.kind === 'tabs') {
    return node.panels.some((panel) => panel.id === panelId || panel.type === panelId);
  }
  return node.children.some((child) => containsPanel(child, panelId));
}

/**
 * Option 3 replaces the standalone On Deck pane with the unified Run of Show.
 * Remove that retired pane from saved Active Event layouts without discarding
 * the seller's remaining dock geometry. If they had closed Run of Show, reseed
 * instead: the route may not restore without its one live-lineup surface.
 */
export function migrateSellerActiveEventLayout(layout: LayoutDoc): LayoutDoc {
  const floatingHasOnDeck = layout.floating?.some((group) => (
    group.panels.some((panel) => panel.id === 'on-deck' || panel.type === 'on-deck')
  )) ?? false;
  const dockedHasOnDeck = containsPanel(layout.root, 'on-deck');
  if (!dockedHasOnDeck && !floatingHasOnDeck) return layout;
  if (!containsPanel(layout.root, 'run-of-show') && !(layout.floating?.some((group) => (
    group.panels.some((panel) => panel.id === 'run-of-show' || panel.type === 'run-of-show')
  )) ?? false)) {
    return sellerActiveEventDockDefaultLayout();
  }

  const root = withoutPanel(layout.root, 'on-deck');
  if (!root) return sellerActiveEventDockDefaultLayout();
  const floating = layout.floating
    ?.map((group) => {
      const panels = group.panels.filter((panel) => panel.id !== 'on-deck' && panel.type !== 'on-deck');
      if (panels.length === 0) return null;
      return {
        ...group,
        panels,
        activePanelId: panels.some((panel) => panel.id === group.activePanelId)
          ? group.activePanelId
          : panels[0]!.id,
      };
    })
    .filter((group): group is NonNullable<typeof group> => group !== null);

  return {
    ...layout,
    root,
    floating: floating && floating.length > 0 ? floating : undefined,
  };
}

/**
 * Return a copy of `layout` with `panelId` selected in its containing strip.
 * `null` means the panel was removed from the saved layout.
 *
 * Layout documents are deliberately JSON-only (D-006), so the JSON clone is
 * the narrowest safe way to preserve every piece of user geometry without
 * mutating the row returned by the underlying store.
 */
export function foregroundSellerDockPanel(layout: LayoutDoc, panelId: string): LayoutDoc | null {
  const next = JSON.parse(JSON.stringify(layout)) as LayoutDoc;

  const visit = (node: LayoutDoc['root']): boolean => {
    if (node.kind === 'tabs') {
      if (!node.panels.some((panel) => panel.id === panelId)) return false;
      node.activePanelId = panelId;
      return true;
    }
    return node.children.some(visit);
  };

  if (visit(next.root)) return next;
  const floating = next.floating?.find((group) => (
    group.panels.some((panel) => panel.id === panelId)
  ));
  if (!floating) return null;
  floating.activePanelId = panelId;
  return next;
}

/**
 * The seller dock's layout store: the workbench's localStorage store, seeded
 * with the default seller layout, wrapped so an unreadable row self-heals.
 *
 * Recovery is attempted at most ONCE per call. If the reseeded row also fails,
 * the error propagates and the dock shows its error screen — which is the right
 * outcome, because at that point the failure is in the seed or in storage
 * itself, and silently retrying would spin.
 */
export function createSellerDockStore(opts: SellerDockStoreOptions = {}): DockLayoutStore {
  const keyPrefix = opts.keyPrefix ?? SELLER_DOCK_STORAGE_PREFIX;
  const inner = createLocalStorageDockLayoutStore({
    keyPrefix,
    seed: opts.seed ?? sellerDockDefaultLayout,
  });
  const onRecover = opts.onRecover ?? defaultOnRecover;

  const resolveStorage = (): LayoutStorage | null => {
    if (opts.storage !== undefined) return opts.storage;
    return typeof localStorage !== 'undefined' ? localStorage : null;
  };

  /** Drop the unreadable row so the next read falls through to the seed. */
  const discard = (layoutName: string, error: Error): void => {
    const key = sellerDockStorageKey(layoutName, keyPrefix);
    resolveStorage()?.removeItem(key);
    onRecover({ layoutName, key, error });
  };

  const foreground = async (name: string, row: DockLayoutRow): Promise<DockLayoutRow> => {
    if (!opts.foregroundPanelId || row.schemaVersion !== 1) return row;
    const layout = foregroundSellerDockPanel(row.layoutJson as LayoutDoc, opts.foregroundPanelId);
    if (layout) return { ...row, layoutJson: layout };

    // A board route whose destination panel was closed is not recoverable by
    // merely changing activePanelId. Reuse the store's existing reset/seed path
    // so there is still one authoritative default layout.
    const seeded = await inner.reset(name);
    if (seeded.schemaVersion !== 1) return seeded;
    const repaired = foregroundSellerDockPanel(seeded.layoutJson as LayoutDoc, opts.foregroundPanelId);
    return repaired ? { ...seeded, layoutJson: repaired } : seeded;
  };

  const migrate = async (name: string, row: DockLayoutRow): Promise<DockLayoutRow> => {
    if (name !== SELLER_ACTIVE_DOCK_LAYOUT_NAME || row.schemaVersion !== 1) return row;
    const current = row.layoutJson as LayoutDoc;
    const migrated = migrateSellerActiveEventLayout(current);
    if (migrated === current) return row;
    return inner.save(name, migrated, { expectedUpdatedTs: row.updatedTs });
  };

  return {
    async load(name: string): Promise<DockLayoutRow> {
      let row: DockLayoutRow;
      try {
        row = await inner.load(name);
      } catch (err) {
        discard(name, asError(err));
        // The row is gone, so this takes the store's seed path.
        row = await inner.load(name);
      }
      return foreground(name, await migrate(name, row));
    },

    async save(name, layout, saveOpts): Promise<DockLayoutRow> {
      try {
        return await inner.save(name, layout, saveOpts);
      } catch (err) {
        // A conflict is a real, meaningful answer — another writer won the race.
        // Discarding their layout to force ours through would be data loss.
        if (err instanceof DockLayoutConflictError) throw err;
        // The store validates the INCOMING layout before it reads the stored
        // one, so an invalid argument surfaces here too. Wiping saved state
        // because the caller passed a bad document would be a non-sequitur —
        // re-raise the ORIGINAL failure and leave storage alone.
        try {
          validateLayoutDoc(layout);
        } catch {
          throw err;
        }
        // Past that, the failure came from the STORED row (the store re-reads it
        // for its conflict check), which is the self-healing case.
        discard(name, asError(err));
        return inner.save(name, layout, saveOpts);
      }
    },

    async reset(name: string): Promise<DockLayoutRow> {
      return inner.reset(name);
    },
  };
}

/* -------------------------------------------------------------------------- *
 * Board dimensions (P-015)
 * -------------------------------------------------------------------------- */

/**
 * The overall size of the dock BOARD — the outer frame around the dockview
 * host — in CSS pixels. Distinct from the inner panel geometry, which dockview
 * owns and which travels inside `layoutJson`.
 *
 * P-015 requires this to persist "alongside the existing layout persistence",
 * and the plan text is explicit that a PARALLEL store is not acceptable. So it
 * hangs off the SAME localStorage row, under the SAME key
 * (`sidestage.dock:seller`), as a sibling of `layoutJson`.
 *
 * That placement is not merely tidy — it is what the workbench store already
 * supports, and it buys three properties for free:
 *
 *   1. IT SURVIVES EVERY LAYOUT SAVE. `createLocalStorageDockLayoutStore.save`
 *      builds the next row as `{ ...existing, schemaVersion, layoutJson,
 *      updatedTs }` from a FRESH read of storage. Unknown sibling fields are
 *      spread through untouched, so a board size written here is not clobbered
 *      by the next panel drag, and `load` hands the whole parsed row back
 *      (`validateLayoutDoc` inspects `layoutJson` ONLY, never the row).
 *
 *   2. RESET IS ALREADY CORRECT. `reset` removes the entire key, so the board
 *      size disappears with the layout and the next load reseeds neither — the
 *      default geometry is the ABSENCE of this field. A second store would have
 *      needed its own reset path, which is exactly the half-implemented reset
 *      P-015 calls out as the easy thing to miss.
 *
 *   3. IT CANNOT DESYNC. One key, one row, one lifetime: there is no state in
 *      which a user's saved layout and their saved board size disagree about
 *      whether they exist.
 */
export interface SellerDockBoardSize {
  width: number;
  height: number;
}

/** The persisted row, including P-015's sibling field. */
export type SellerDockLayoutRow = DockLayoutRow & { boardSize?: SellerDockBoardSize };

/** The storage surface the board-size accessors need. */
export type BoardSizeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface BoardSizeOptions {
  /** Override the key prefix (tests, or a second dock instance). */
  keyPrefix?: string;
  /** Storage to read/write. Defaults to `localStorage`; `null` disables. */
  storage?: BoardSizeStorage | null;
}

function resolveBoardStorage(opts: BoardSizeOptions): BoardSizeStorage | null {
  if (opts.storage !== undefined) return opts.storage;
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/**
 * A stored value is only honoured if it is two finite, positive numbers.
 *
 * Anything else is treated as absent rather than as an error: a board size is a
 * convenience, and the same reasoning that makes an unreadable LAYOUT
 * self-heal into the default applies here — falling back to the default
 * geometry is always a usable outcome, so there is nothing to report and
 * nothing for a caller to decide.
 */
export function isSellerDockBoardSize(value: unknown): value is SellerDockBoardSize {
  if (!value || typeof value !== 'object') return false;
  const { width, height } = value as Partial<SellerDockBoardSize>;
  return (
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  );
}

/**
 * The persisted board size, or `undefined` when none is stored.
 *
 * Synchronous by design: it is read in a `useState` initialiser so the board
 * paints at its restored size on the FIRST frame. An async read would paint the
 * default first and then snap, which reads as a layout bug.
 */
export function readSellerDockBoardSize(
  layoutName: string = SELLER_DOCK_LAYOUT_NAME,
  opts: BoardSizeOptions = {},
): SellerDockBoardSize | undefined {
  const storage = resolveBoardStorage(opts);
  if (!storage) return undefined;
  const raw = storage.getItem(sellerDockStorageKey(layoutName, opts.keyPrefix));
  if (!raw) return undefined;
  try {
    const row = JSON.parse(raw) as SellerDockLayoutRow;
    if (!isSellerDockBoardSize(row?.boardSize)) return undefined;
    return { width: row.boardSize.width, height: row.boardSize.height };
  } catch {
    return undefined;
  }
}

/**
 * Persist the board size onto the existing layout row.
 *
 * Returns false when nothing was written. Two deliberate refusals:
 *
 *   NO ROW YET / UNREADABLE ROW. This never CREATES the row. A row whose
 *   `layoutJson` is missing fails `validateLayoutDoc` on the next load, and the
 *   self-healing wrapper above responds to that by DISCARDING the row — so
 *   seeding a partial row here would destroy the user's saved layout the next
 *   time they opened the tab, to save a board width. In practice the refusal is
 *   unreachable: `DockWorkspace` calls `store.load` on mount, which seeds the
 *   row before the board is on screen to be dragged. It is a guard, not a path.
 *
 *   NO STORAGE. SSR and unit tests, where there is nothing to write to.
 *
 * `updatedTs` is deliberately NOT bumped. It is the optimistic-concurrency
 * token `useDockLayout` replays as `expectedUpdatedTs` on its next save; moving
 * it would make the dock's very next layout save raise
 * `DockLayoutConflictError`, which `save` above re-raises as a genuine
 * conflict — and `DockWorkspace.persist` swallows conflicts silently. The user
 * would resize the board and then lose their next panel drag, with nothing in
 * the console. A board resize is not a competing writer of the layout, so it
 * must not present as one.
 *
 * The read-modify-write is synchronous end to end, which is what makes it safe
 * to interleave with the layout store: `localStorage` and the workbench store's
 * own save are both synchronous, so no layout write can land between this
 * `getItem` and its `setItem`.
 */
export function writeSellerDockBoardSize(
  size: SellerDockBoardSize,
  layoutName: string = SELLER_DOCK_LAYOUT_NAME,
  opts: BoardSizeOptions = {},
): boolean {
  if (!isSellerDockBoardSize(size)) return false;
  const storage = resolveBoardStorage(opts);
  if (!storage) return false;
  const key = sellerDockStorageKey(layoutName, opts.keyPrefix);
  const raw = storage.getItem(key);
  if (!raw) return false;
  let row: SellerDockLayoutRow;
  try {
    row = JSON.parse(raw) as SellerDockLayoutRow;
  } catch {
    return false;
  }
  if (!row || typeof row !== 'object' || row.layoutJson == null) return false;
  row.boardSize = { width: size.width, height: size.height };
  storage.setItem(key, JSON.stringify(row));
  return true;
}
