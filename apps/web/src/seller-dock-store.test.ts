import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CURRENT_LAYOUT_SCHEMA_VERSION, type LayoutDoc } from '@papercusp/dock-workbench';

import {
  SELLER_DOCK_LAYOUT_NAME,
  SELLER_MANAGER_DOCK_LAYOUT_NAME,
  sellerDockDefaultLayout,
  sellerEventManagerDockDefaultLayout,
} from './seller-dock-layout';
import {
  SELLER_DOCK_RESET_EVENT,
  SELLER_MANAGER_DOCK_RESET_EVENT,
  SELLER_DOCK_STORAGE_PREFIX,
  createSellerDockStore,
  requestSellerDockLayoutReset,
  sellerDockStorageKey,
} from './seller-dock-store';

/**
 * P-010 — layout persistence.
 *
 * These tests exist because the failures they cover are SILENT in every other
 * check: a corrupt localStorage row typechecks fine, renders fine in a fresh
 * browser profile, and only bricks the tab for the one user who has the bad row.
 * The suite therefore drives the real workbench store against a real (in-memory)
 * Storage rather than mocking the store out — a mock would assert my assumptions
 * about the store's behaviour instead of the behaviour.
 */

/** Minimal in-memory Storage. The workbench store reads the GLOBAL, so we install it there. */
function installFakeLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  const fake: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (k: string) => (backing.has(k) ? (backing.get(k) as string) : null),
    key: (i: number) => [...backing.keys()][i] ?? null,
    removeItem: (k: string) => void backing.delete(k),
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  return backing;
}

const KEY = sellerDockStorageKey();

let store: Map<string, string>;

beforeEach(() => {
  store = installFakeLocalStorage();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, 'localStorage');
  vi.restoreAllMocks();
});

describe('sellerDockStorageKey', () => {
  it('is scoped per tab by layout name, so two docks cannot share a row', () => {
    expect(KEY).toBe(`${SELLER_DOCK_STORAGE_PREFIX}:${SELLER_DOCK_LAYOUT_NAME}`);
    expect(sellerDockStorageKey('buyer')).toBe(`${SELLER_DOCK_STORAGE_PREFIX}:buyer`);
    expect(sellerDockStorageKey()).not.toBe(sellerDockStorageKey('buyer'));
  });
});

describe('createSellerDockStore — round trip', () => {
  it('seeds the default seller layout on first load and persists it under the per-tab key', async () => {
    const row = await createSellerDockStore().load(SELLER_DOCK_LAYOUT_NAME);

    expect(row.layoutJson).toEqual(sellerDockDefaultLayout());
    expect(store.has(KEY)).toBe(true);
  });

  it('seeds a second board under its own layout name and default geometry', async () => {
    const manager = createSellerDockStore({ seed: sellerEventManagerDockDefaultLayout });
    const row = await manager.load(SELLER_MANAGER_DOCK_LAYOUT_NAME);

    expect(row.layoutJson).toEqual(sellerEventManagerDockDefaultLayout());
    expect(store.has(sellerDockStorageKey(SELLER_MANAGER_DOCK_LAYOUT_NAME))).toBe(true);
    expect(sellerDockStorageKey(SELLER_MANAGER_DOCK_LAYOUT_NAME)).not.toBe(KEY);
  });

  it('restores a saved layout instead of reseeding — the whole point of persistence', async () => {
    const s = createSellerDockStore();
    const moved = sellerDockDefaultLayout();
    // A geometry change of exactly the kind dragging a sash produces.
    (moved.root as { children: Array<{ size?: number }> }).children[0].size = 750;

    await s.save(SELLER_DOCK_LAYOUT_NAME, moved);
    const reloaded = await createSellerDockStore().load(SELLER_DOCK_LAYOUT_NAME);

    expect((reloaded.layoutJson as LayoutDoc).root).toEqual(moved.root);
    expect(reloaded.layoutJson).not.toEqual(sellerDockDefaultLayout());
  });

  it('reset() drops the saved layout and returns the default', async () => {
    const s = createSellerDockStore();
    const moved = sellerDockDefaultLayout();
    (moved.root as { children: Array<{ size?: number }> }).children[0].size = 750;
    await s.save(SELLER_DOCK_LAYOUT_NAME, moved);

    const afterReset = await s.reset(SELLER_DOCK_LAYOUT_NAME);

    expect(afterReset.layoutJson).toEqual(sellerDockDefaultLayout());
    // And it STAYS reset across a remount, rather than resurrecting the old row.
    const reloaded = await createSellerDockStore().load(SELLER_DOCK_LAYOUT_NAME);
    expect(reloaded.layoutJson).toEqual(sellerDockDefaultLayout());
  });
});

describe('createSellerDockStore — self-healing', () => {
  it('recovers from a row that is not valid JSON rather than failing the load', async () => {
    store.set(KEY, '{"layoutJson": {"schemaVersion": 1, "root"');
    const onRecover = vi.fn();

    const row = await createSellerDockStore({ onRecover }).load(SELLER_DOCK_LAYOUT_NAME);

    expect(row.layoutJson).toEqual(sellerDockDefaultLayout());
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(onRecover.mock.calls[0][0]).toMatchObject({ layoutName: SELLER_DOCK_LAYOUT_NAME, key: KEY });
  });

  it('recovers from a well-formed row whose layout is structurally invalid', async () => {
    // Parses cleanly; fails validation (a tabs node with no panels array).
    store.set(
      KEY,
      JSON.stringify({
        layoutName: SELLER_DOCK_LAYOUT_NAME,
        schemaVersion: CURRENT_LAYOUT_SCHEMA_VERSION,
        layoutJson: { schemaVersion: CURRENT_LAYOUT_SCHEMA_VERSION, root: { kind: 'tabs', id: 'x', activePanelId: 'a' } },
        updatedTs: 1,
        createdTs: 1,
      }),
    );

    const row = await createSellerDockStore({ onRecover: () => {} }).load(SELLER_DOCK_LAYOUT_NAME);

    expect(row.layoutJson).toEqual(sellerDockDefaultLayout());
  });

  it('treats an unknown schemaVersion as a discard-and-reseed migration', async () => {
    store.set(
      KEY,
      JSON.stringify({
        layoutName: SELLER_DOCK_LAYOUT_NAME,
        schemaVersion: 99,
        layoutJson: { schemaVersion: 99, root: { kind: 'group', id: 'r', children: [] } },
        updatedTs: 1,
        createdTs: 1,
      }),
    );

    const row = await createSellerDockStore({ onRecover: () => {} }).load(SELLER_DOCK_LAYOUT_NAME);

    expect(row.layoutJson).toEqual(sellerDockDefaultLayout());
    expect(row.schemaVersion).toBe(CURRENT_LAYOUT_SCHEMA_VERSION);
  });

  it('HEALS storage, so the next load is clean and does not recover twice', async () => {
    store.set(KEY, 'not json at all');
    const onRecover = vi.fn();
    const s = createSellerDockStore({ onRecover });

    await s.load(SELLER_DOCK_LAYOUT_NAME);
    await s.load(SELLER_DOCK_LAYOUT_NAME);

    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('recovers on the SAVE path too — a row corrupted after mount must not block writes', async () => {
    const s = createSellerDockStore({ onRecover: () => {} });
    await s.load(SELLER_DOCK_LAYOUT_NAME);
    // Something else corrupts the row between mount and the debounced save.
    store.set(KEY, '}{');

    const saved = await s.save(SELLER_DOCK_LAYOUT_NAME, sellerDockDefaultLayout());

    expect(saved.layoutJson).toEqual(sellerDockDefaultLayout());
  });

  it('does NOT wipe stored state when the caller passes an invalid layout', async () => {
    const s = createSellerDockStore({ onRecover: () => {} });
    const good = sellerDockDefaultLayout();
    (good.root as { children: Array<{ size?: number }> }).children[0].size = 750;
    await s.save(SELLER_DOCK_LAYOUT_NAME, good);
    const before = store.get(KEY);

    await expect(
      s.save(SELLER_DOCK_LAYOUT_NAME, { schemaVersion: 1, root: null } as unknown as LayoutDoc),
    ).rejects.toThrow();

    // The user's good layout survives someone else's bad write.
    expect(store.get(KEY)).toBe(before);
  });

  it('propagates rather than spinning when the reseeded row also fails', async () => {
    store.set(KEY, 'garbage');
    // Storage that accepts the discard but never actually forgets the bad row.
    const stubborn = { removeItem: () => {} };

    await expect(
      createSellerDockStore({ storage: stubborn, onRecover: () => {} }).load(SELLER_DOCK_LAYOUT_NAME),
    ).rejects.toThrow();
  });
});

describe('requestSellerDockLayoutReset', () => {
  it('dispatches the reset event the dock listens for', () => {
    const target = new EventTarget();
    const heard = vi.fn();
    target.addEventListener(SELLER_DOCK_RESET_EVENT, heard);

    expect(requestSellerDockLayoutReset(target)).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('can target one Studio board without resetting its sibling', () => {
    const target = new EventTarget();
    const active = vi.fn();
    const manager = vi.fn();
    target.addEventListener(SELLER_DOCK_RESET_EVENT, active);
    target.addEventListener(SELLER_MANAGER_DOCK_RESET_EVENT, manager);

    expect(requestSellerDockLayoutReset(target, SELLER_MANAGER_DOCK_RESET_EVENT)).toBe(true);
    expect(manager).toHaveBeenCalledOnce();
    expect(active).not.toHaveBeenCalled();
  });

  it('reports false instead of throwing when there is no window to dispatch on', () => {
    expect(requestSellerDockLayoutReset(undefined)).toBe(false);
  });
});
