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
  foregroundSellerDockPanel,
  migrateSellerActiveEventLayout,
  migrateSellerEventManagerLayout,
  requestSellerDockLayoutReset,
  sellerDockStorageKey,
  sellerDockStoragePrefix,
  readSellerDockBoardSize,
  writeSellerDockBoardSize,
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

function layoutPanelIds(layout: LayoutDoc): string[] {
  const visit = (node: LayoutDoc['root']): string[] => node.kind === 'tabs'
    ? node.panels.map((panel) => panel.id)
    : node.children.flatMap(visit);
  return [
    ...visit(layout.root),
    ...(layout.floating ?? []).flatMap((group) => group.panels.map((panel) => panel.id)),
  ];
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

/*
 * P-007 — a demo-identity change is an atomic browser boundary.
 *
 * The dock layout is the one Studio surface that deliberately OUTLIVES that
 * boundary (it is persisted so it survives reloads), which is exactly why it
 * has to carry the seller. These tests drive the real store against a real
 * in-memory Storage for the same reason the suite above does: a shared row is
 * invisible to typecheck and to any single-seller render, and only shows up as
 * one demo seller silently inheriting — and then overwriting — another's board.
 */
describe('sellerDockStoragePrefix — P-007 seller isolation', () => {
  it('gives two demo sellers separate rows for the same board', () => {
    const avi = sellerDockStorageKey(SELLER_DOCK_LAYOUT_NAME, sellerDockStoragePrefix('seller-avi'));
    const rae = sellerDockStorageKey(SELLER_DOCK_LAYOUT_NAME, sellerDockStoragePrefix('seller-rae'));

    expect(avi).toBe(`${SELLER_DOCK_STORAGE_PREFIX}:seller-avi:${SELLER_DOCK_LAYOUT_NAME}`);
    expect(avi).not.toBe(rae);
  });

  it('keeps each seller’s boards separate from each other as well', () => {
    const prefix = sellerDockStoragePrefix('seller-avi');

    expect(sellerDockStorageKey(SELLER_DOCK_LAYOUT_NAME, prefix))
      .not.toBe(sellerDockStorageKey(SELLER_MANAGER_DOCK_LAYOUT_NAME, prefix));
  });

  it('falls back to the shared prefix when no seller is named, so SSR and tests keep the pre-P-007 row', () => {
    expect(sellerDockStoragePrefix(null)).toBe(SELLER_DOCK_STORAGE_PREFIX);
    expect(sellerDockStoragePrefix(undefined)).toBe(SELLER_DOCK_STORAGE_PREFIX);
    expect(sellerDockStoragePrefix('   ')).toBe(SELLER_DOCK_STORAGE_PREFIX);
  });

  it('encodes the id so a seller containing ":" cannot collide with another seller/board pair', () => {
    // Unencoded these two would BOTH be `sidestage.dock:a:b:seller`.
    const nested = sellerDockStorageKey(SELLER_DOCK_LAYOUT_NAME, sellerDockStoragePrefix('a:b'));
    const sibling = sellerDockStorageKey(`b:${SELLER_DOCK_LAYOUT_NAME}`, sellerDockStoragePrefix('a'));

    expect(nested).not.toBe(sibling);
    expect(nested).toBe(`${SELLER_DOCK_STORAGE_PREFIX}:a%3Ab:${SELLER_DOCK_LAYOUT_NAME}`);
  });

  it('does not let one seller read or overwrite another seller’s saved layout', async () => {
    const aviStore = createSellerDockStore({ keyPrefix: sellerDockStoragePrefix('seller-avi') });
    const moved = sellerDockDefaultLayout();
    // A geometry change of exactly the kind dragging a sash produces.
    (moved.root as { children: Array<{ size?: number }> }).children[0].size = 750;
    await aviStore.save(SELLER_DOCK_LAYOUT_NAME, moved);

    const raeStore = createSellerDockStore({ keyPrefix: sellerDockStoragePrefix('seller-rae') });
    const raeRow = await raeStore.load(SELLER_DOCK_LAYOUT_NAME);

    // Rae gets the SEED, not Avi's dragged board...
    expect(raeRow.layoutJson).toEqual(sellerDockDefaultLayout());
    // ...and Rae's own load did not overwrite Avi's row.
    const aviReloaded = await createSellerDockStore({
      keyPrefix: sellerDockStoragePrefix('seller-avi'),
    }).load(SELLER_DOCK_LAYOUT_NAME);
    expect((aviReloaded.layoutJson as LayoutDoc).root).toEqual(moved.root);
  });

  it('keeps the board SIZE on the same seller-scoped row as the layout', async () => {
    // The size is a read-modify-write of the layout row, so a prefix that
    // reached the store but not the size read would make every resize a silent
    // no-op. This is the regression that split prefixes would produce.
    const keyPrefix = sellerDockStoragePrefix('seller-avi');
    await createSellerDockStore({ keyPrefix }).load(SELLER_DOCK_LAYOUT_NAME);

    expect(writeSellerDockBoardSize({ width: 1024, height: 640 }, SELLER_DOCK_LAYOUT_NAME, { keyPrefix }))
      .toBe(true);
    expect(readSellerDockBoardSize(SELLER_DOCK_LAYOUT_NAME, { keyPrefix }))
      .toEqual({ width: 1024, height: 640 });
    // The other seller has no row at all, so their board is not resized to it.
    expect(readSellerDockBoardSize(SELLER_DOCK_LAYOUT_NAME, {
      keyPrefix: sellerDockStoragePrefix('seller-rae'),
    })).toBeUndefined();
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

  it('migrates retired Transcript, Event Chat, and On Deck panes out of saved layouts', async () => {
    const legacy = sellerDockDefaultLayout();
    const root = legacy.root as Extract<LayoutDoc['root'], { kind: 'group' }>;
    const rail = root.children.find((node) => node.id === 'seller-active-rail') as Extract<LayoutDoc['root'], { kind: 'group' }>;
    const chatStrip: Extract<LayoutDoc['root'], { kind: 'tabs' }> = {
      kind: 'tabs',
      id: 'legacy-event-chat-group',
      activePanelId: 'event-chat',
      panels: [{ id: 'event-chat', type: 'event-chat', title: 'Event chat' }],
      size: 450,
    };
    rail.children.unshift(chatStrip);
    chatStrip.panels.unshift({ id: 'transcript', type: 'transcript', title: 'Transcript' });
    chatStrip.activePanelId = 'transcript';
    rail.children.splice(1, 0, {
      kind: 'tabs',
      id: 'on-deck-group',
      activePanelId: 'on-deck',
      panels: [{ id: 'on-deck', type: 'on-deck', title: 'On deck' }],
      size: 300,
    });
    legacy.floating = [{
      id: 'legacy-transcript-float',
      x: 10,
      y: 10,
      width: 420,
      height: 320,
      activePanelId: 'transcript-floating',
      panels: [
        { id: 'transcript-floating', type: 'transcript', title: 'Transcript' },
        { id: 'event-chat-floating', type: 'event-chat', title: 'Event chat' },
      ],
    }];
    root.children[0]!.size = 701;

    expect(layoutPanelIds(legacy)).toContain('on-deck');
    expect(layoutPanelIds(legacy)).toContain('transcript');
    expect(layoutPanelIds(legacy)).toContain('event-chat');
    expect(layoutPanelIds(legacy)).toContain('transcript-floating');
    await createSellerDockStore().save(SELLER_DOCK_LAYOUT_NAME, legacy);
    const migrated = await createSellerDockStore().load(SELLER_DOCK_LAYOUT_NAME);
    const migratedLayout = migrated.layoutJson as LayoutDoc;

    expect(layoutPanelIds(migratedLayout)).not.toContain('on-deck');
    expect(layoutPanelIds(migratedLayout)).not.toContain('transcript');
    expect(layoutPanelIds(migratedLayout)).not.toContain('event-chat');
    expect(layoutPanelIds(migratedLayout)).not.toContain('transcript-floating');
    expect(layoutPanelIds(migratedLayout)).not.toContain('event-chat-floating');
    expect(layoutPanelIds(migratedLayout)).toContain('run-of-show');
    expect(layoutPanelIds(migratedLayout)).toContain('inventory');
    expect((migratedLayout.root as Extract<LayoutDoc['root'], { kind: 'group' }>).children[0]?.size).toBe(701);
    expect(migratedLayout.floating).toBeUndefined();
    expect(layoutPanelIds(migrateSellerActiveEventLayout(migratedLayout))).toEqual(
      layoutPanelIds(migratedLayout),
    );
    expect(JSON.parse(store.get(KEY)!).layoutJson).toEqual(migratedLayout);
  });

  it('adds Inventory beside Run of Show in a saved pre-feature layout without losing geometry', async () => {
    const saved = sellerDockDefaultLayout();
    const root = saved.root as Extract<LayoutDoc['root'], { kind: 'group' }>;
    const rail = root.children.find((node) => node.id === 'seller-active-rail') as Extract<LayoutDoc['root'], { kind: 'group' }>;
    const utility = rail.children[0] as Extract<LayoutDoc['root'], { kind: 'tabs' }>;
    utility.panels = utility.panels.filter((panel) => panel.id !== 'inventory');
    utility.activePanelId = 'run-of-show';
    root.children[0]!.size = 713;

    await createSellerDockStore().save(SELLER_DOCK_LAYOUT_NAME, saved);
    const migrated = (await createSellerDockStore().load(SELLER_DOCK_LAYOUT_NAME)).layoutJson as LayoutDoc;
    const migratedRoot = migrated.root as Extract<LayoutDoc['root'], { kind: 'group' }>;
    const migratedRail = migratedRoot.children.find((node) => node.id === 'seller-active-rail') as Extract<LayoutDoc['root'], { kind: 'group' }>;
    const migratedUtility = migratedRail.children[0] as Extract<LayoutDoc['root'], { kind: 'tabs' }>;

    expect(migratedUtility.panels.map((panel) => panel.id)).toEqual(['run-of-show', 'inventory']);
    expect(migratedUtility.activePanelId).toBe('run-of-show');
    expect(migratedRoot.children[0]!.size).toBe(713);
    expect(migrateSellerActiveEventLayout(migrated)).toBe(migrated);
  });

  it('preserves a canonical single-pane manager layout and its saved geometry', async () => {
    const saved = sellerEventManagerDockDefaultLayout();
    const root = saved.root as { activePanelId: string; size?: number };
    root.size = 731;
    await createSellerDockStore({ seed: sellerEventManagerDockDefaultLayout }).save(
      SELLER_MANAGER_DOCK_LAYOUT_NAME,
      saved,
    );

    const row = await createSellerDockStore({
      seed: sellerEventManagerDockDefaultLayout,
      foregroundPanelId: 'event-manager',
    }).load(SELLER_MANAGER_DOCK_LAYOUT_NAME);
    const restored = row.layoutJson as LayoutDoc;

    expect((restored.root as { activePanelId: string }).activePanelId).toBe('event-manager');
    expect((restored.root as { size?: number }).size).toBe(731);
    expect((restored.root as { panels: unknown[] }).panels).toEqual(
      (saved.root as { panels: unknown[] }).panels,
    );
  });

  it('migrates screenshot-era manager layouts to one Event Manager pane', async () => {
    const legacy: LayoutDoc = {
      schemaVersion: 1,
      root: {
        kind: 'group',
        id: 'legacy-manager-root',
        direction: 'row',
        children: [
          {
            kind: 'tabs',
            id: 'event-manager-group',
            activePanelId: 'event-manager',
            panels: [{ id: 'event-manager', type: 'event-manager', title: 'Event manager' }],
            size: 500,
          },
          {
            kind: 'tabs',
            id: 'event-settings-group',
            activePanelId: 'event-settings',
            panels: [{ id: 'event-settings', type: 'event-settings', title: 'Event settings' }],
            size: 250,
          },
          {
            kind: 'tabs',
            id: 'run-of-show-planner-group',
            activePanelId: 'run-of-show-planner',
            panels: [{ id: 'run-of-show-planner', type: 'run-of-show-planner', title: 'Run of show' }],
            size: 250,
          },
        ],
      },
    };

    expect(migrateSellerEventManagerLayout(legacy)).toEqual(sellerEventManagerDockDefaultLayout());
    const canonical = sellerEventManagerDockDefaultLayout();
    expect(migrateSellerEventManagerLayout(canonical)).toBe(canonical);

    await createSellerDockStore({ seed: sellerEventManagerDockDefaultLayout }).save(
      SELLER_MANAGER_DOCK_LAYOUT_NAME,
      legacy,
    );
    const row = await createSellerDockStore({
      seed: sellerEventManagerDockDefaultLayout,
      foregroundPanelId: 'event-manager',
    }).load(SELLER_MANAGER_DOCK_LAYOUT_NAME);

    expect(row.layoutJson).toEqual(sellerEventManagerDockDefaultLayout());
    expect(JSON.parse(store.get(sellerDockStorageKey(SELLER_MANAGER_DOCK_LAYOUT_NAME))!).layoutJson)
      .toEqual(sellerEventManagerDockDefaultLayout());
  });

  it('reseeds a manager layout that no longer contains its route panel', async () => {
    const incomplete: LayoutDoc = {
      schemaVersion: 1,
      root: {
        kind: 'tabs',
        id: 'run-of-show-planner-group',
        activePanelId: 'run-of-show-planner',
        panels: [{ id: 'run-of-show-planner', type: 'run-of-show-planner', title: 'Run of show' }],
        size: 1000,
      },
    };
    await createSellerDockStore({ seed: sellerEventManagerDockDefaultLayout }).save(
      SELLER_MANAGER_DOCK_LAYOUT_NAME,
      incomplete,
    );

    const row = await createSellerDockStore({
      seed: sellerEventManagerDockDefaultLayout,
      foregroundPanelId: 'event-manager',
    }).load(SELLER_MANAGER_DOCK_LAYOUT_NAME);

    expect(row.layoutJson).toEqual(sellerEventManagerDockDefaultLayout());
    expect(JSON.parse(store.get(sellerDockStorageKey(SELLER_MANAGER_DOCK_LAYOUT_NAME))!).layoutJson)
      .toEqual(sellerEventManagerDockDefaultLayout());
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

describe('foregroundSellerDockPanel', () => {
  it('returns null rather than mutating a layout that does not contain the panel', () => {
    const layout = sellerDockDefaultLayout();
    const before = JSON.stringify(layout);

    expect(foregroundSellerDockPanel(layout, 'not-installed')).toBeNull();
    expect(JSON.stringify(layout)).toBe(before);
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
