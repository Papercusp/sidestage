import {
  DockLayoutConflictError,
  createLocalStorageDockLayoutStore,
  validateLayoutDoc,
  type DockLayoutRow,
  type DockLayoutStore,
} from '@papercusp/dock-workbench';

import { SELLER_DOCK_LAYOUT_NAME, sellerDockDefaultLayout } from './seller-dock-layout';

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
export const SELLER_DOCK_RESET_EVENT = 'sidestage:seller-dock:reset-layout';

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
export function requestSellerDockLayoutReset(target: EventTarget | undefined = globalThis.window): boolean {
  if (!target) return false;
  target.dispatchEvent(new Event(SELLER_DOCK_RESET_EVENT));
  return true;
}

export interface SellerDockStoreOptions {
  /** Override the key prefix (tests, or a second dock instance). */
  keyPrefix?: string;
  /** Storage used to DROP an unreadable row. Defaults to `localStorage`. */
  storage?: LayoutStorage | null;
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
    seed: () => sellerDockDefaultLayout(),
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

  return {
    async load(name: string): Promise<DockLayoutRow> {
      try {
        return await inner.load(name);
      } catch (err) {
        discard(name, asError(err));
        // The row is gone, so this takes the store's seed path.
        return inner.load(name);
      }
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
