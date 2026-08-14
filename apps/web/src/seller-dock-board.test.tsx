import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SELLER_DOCK_BOARD_KEY_STEP,
  SELLER_DOCK_BOARD_KEY_STEP_COARSE,
  SELLER_DOCK_MIN_BOARD_HEIGHT,
  SELLER_DOCK_MIN_BOARD_WIDTH,
  SellerDockBoard,
  clampSellerDockBoardSize,
  sellerDockBoardSizeFromKey,
} from './SellerDockBoard';
import {
  createSellerDockStore,
  readSellerDockBoardSize,
  sellerDockStorageKey,
  writeSellerDockBoardSize,
  type SellerDockLayoutRow,
} from './seller-dock-store';
import { SELLER_DOCK_LAYOUT_NAME } from './seller-dock-layout';

/**
 * P-015 whole-board-resize guards.
 *
 * WHAT THESE CAN AND CANNOT REACH. apps/web tests run with no DOM — they render
 * through `react-dom/server`. So there is no pointer to drag and no box to
 * measure, and a test that claimed to verify a drag here would be verifying a
 * simulation of one. The response is not to skip the coverage but to put the
 * policy where a test can reach it: the geometry rules are pure functions
 * (clamp + key-step) and are tested directly, the persistence is tested against
 * the real store, and the render test asserts the affordances exist and are
 * labelled. What genuinely needs a browser — that dragging the east edge widens
 * the board, that a reload restores it — is live QA, and is listed on the item.
 *
 * The load-bearing test in this file is the LAST one: board size and layout
 * share one row, so the thing that must not break is a layout save silently
 * dropping the board size (or the reverse). That is the invariant "extend the
 * store, don't add a parallel one" actually buys, so it is the one pinned
 * against the real store rather than a fake.
 */

/** Map-backed Storage stand-in — enough of the interface for both accessors. */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    get size() {
      return map.size;
    },
    raw: map,
  };
}

/** A minimal well-formed row, as the workbench store writes one. */
function seededRow(extra: Partial<SellerDockLayoutRow> = {}): string {
  return JSON.stringify({
    workspaceId: 'local',
    userId: 'local',
    layoutName: SELLER_DOCK_LAYOUT_NAME,
    schemaVersion: 1,
    layoutJson: {
      schemaVersion: 1,
      root: { kind: 'tabs', id: 'root', activePanelId: 'a', panels: [{ id: 'a', type: 'stage-status' }] },
    },
    createdTs: 1000,
    updatedTs: 2000,
    ...extra,
  });
}

describe('clampSellerDockBoardSize', () => {
  it('floors both axes at the minimum usable board', () => {
    expect(clampSellerDockBoardSize({ width: 10, height: 10 })).toEqual({
      width: SELLER_DOCK_MIN_BOARD_WIDTH,
      height: SELLER_DOCK_MIN_BOARD_HEIGHT,
    });
  });

  it('passes a size above the floor through, rounded to whole pixels', () => {
    expect(clampSellerDockBoardSize({ width: 900.4, height: 600.6 })).toEqual({ width: 900, height: 601 });
  });

  it('caps width at the available width', () => {
    expect(clampSellerDockBoardSize({ width: 5000, height: 600 }, { maxWidth: 1200 })).toEqual({
      width: 1200,
      height: 600,
    });
  });

  it('lets the MINIMUM win when the container is narrower than it', () => {
    // A board too small to use is a worse outcome than one that overflows a
    // narrow column, and the overflow is at least visible and recoverable.
    expect(clampSellerDockBoardSize({ width: 300, height: 600 }, { maxWidth: 200 }).width).toBe(
      SELLER_DOCK_MIN_BOARD_WIDTH,
    );
  });

  it('does not cap height — a tall board is legitimate', () => {
    expect(clampSellerDockBoardSize({ width: 800, height: 5000 }, { maxWidth: 1000 }).height).toBe(5000);
  });

  it('ignores a non-finite max rather than collapsing to the floor', () => {
    expect(clampSellerDockBoardSize({ width: 900, height: 600 }, { maxWidth: Number.POSITIVE_INFINITY })).toEqual({
      width: 900,
      height: 600,
    });
  });
});

describe('sellerDockBoardSizeFromKey', () => {
  const from = { width: 800, height: 600 };

  it('grows and shrinks width on the horizontal handle', () => {
    expect(sellerDockBoardSizeFromKey('ArrowRight', false, 'x', from)?.width).toBe(800 + SELLER_DOCK_BOARD_KEY_STEP);
    expect(sellerDockBoardSizeFromKey('ArrowLeft', false, 'x', from)?.width).toBe(800 - SELLER_DOCK_BOARD_KEY_STEP);
  });

  it('takes a coarse step with Shift held', () => {
    expect(sellerDockBoardSizeFromKey('ArrowRight', true, 'x', from)?.width).toBe(
      800 + SELLER_DOCK_BOARD_KEY_STEP_COARSE,
    );
  });

  it('leaves the other axis untouched', () => {
    expect(sellerDockBoardSizeFromKey('ArrowRight', false, 'x', from)?.height).toBe(600);
    expect(sellerDockBoardSizeFromKey('ArrowDown', false, 'y', from)?.width).toBe(800);
  });

  it('returns null for a key the handle does not own, so the event stays unclaimed', () => {
    // The width handle must not preventDefault an ArrowDown — that would eat a
    // keystroke the page is entitled to (scrolling, or a focus move).
    expect(sellerDockBoardSizeFromKey('ArrowDown', false, 'x', from)).toBeNull();
    expect(sellerDockBoardSizeFromKey('ArrowRight', false, 'y', from)).toBeNull();
    expect(sellerDockBoardSizeFromKey('Enter', false, 'xy', from)).toBeNull();
  });

  it('drives both axes from the corner', () => {
    expect(sellerDockBoardSizeFromKey('ArrowRight', false, 'xy', from)?.width).toBe(800 + SELLER_DOCK_BOARD_KEY_STEP);
    expect(sellerDockBoardSizeFromKey('ArrowDown', false, 'xy', from)?.height).toBe(600 + SELLER_DOCK_BOARD_KEY_STEP);
  });

  it('clamps, so held arrows cannot walk the board below the floor', () => {
    const tiny = { width: SELLER_DOCK_MIN_BOARD_WIDTH, height: SELLER_DOCK_MIN_BOARD_HEIGHT };
    expect(sellerDockBoardSizeFromKey('ArrowLeft', true, 'x', tiny)?.width).toBe(SELLER_DOCK_MIN_BOARD_WIDTH);
  });
});

describe('board size persistence', () => {
  it('round-trips through the existing layout row', () => {
    const storage = fakeStorage({ [sellerDockStorageKey()]: seededRow() });
    expect(writeSellerDockBoardSize({ width: 900, height: 640 }, SELLER_DOCK_LAYOUT_NAME, { storage })).toBe(true);
    expect(readSellerDockBoardSize(SELLER_DOCK_LAYOUT_NAME, { storage })).toEqual({ width: 900, height: 640 });
  });

  it('writes into the SAME key as the layout — there is no second row', () => {
    const storage = fakeStorage({ [sellerDockStorageKey()]: seededRow() });
    writeSellerDockBoardSize({ width: 900, height: 640 }, SELLER_DOCK_LAYOUT_NAME, { storage });
    expect(storage.size).toBe(1);
    expect([...storage.raw.keys()]).toEqual([sellerDockStorageKey()]);
  });

  it('preserves the layout and does NOT move updatedTs', () => {
    // updatedTs is the optimistic-concurrency token useDockLayout replays as
    // expectedUpdatedTs. Bumping it here would make the dock's next layout save
    // raise DockLayoutConflictError, which DockWorkspace swallows — the user
    // would resize the board and then silently lose their next panel drag.
    const storage = fakeStorage({ [sellerDockStorageKey()]: seededRow() });
    const before = JSON.parse(storage.getItem(sellerDockStorageKey())!) as SellerDockLayoutRow;
    writeSellerDockBoardSize({ width: 900, height: 640 }, SELLER_DOCK_LAYOUT_NAME, { storage });
    const after = JSON.parse(storage.getItem(sellerDockStorageKey())!) as SellerDockLayoutRow;
    expect(after.updatedTs).toBe(before.updatedTs);
    expect(after.layoutJson).toEqual(before.layoutJson);
  });

  it('refuses to CREATE a row, which would destroy the layout on next load', () => {
    // A row with no layoutJson fails validateLayoutDoc, and the self-healing
    // store answers that by DISCARDING the row. Seeding a partial row to save a
    // board width would cost the user their saved layout.
    const storage = fakeStorage();
    expect(writeSellerDockBoardSize({ width: 900, height: 640 }, SELLER_DOCK_LAYOUT_NAME, { storage })).toBe(false);
    expect(storage.size).toBe(0);
  });

  it('reads absent/corrupt/absurd stored values as "no size", never as an error', () => {
    expect(readSellerDockBoardSize(SELLER_DOCK_LAYOUT_NAME, { storage: fakeStorage() })).toBeUndefined();
    for (const bad of ['not json', seededRow({ boardSize: { width: 0, height: 5 } } as never), seededRow({ boardSize: { width: Number.NaN, height: 5 } } as never), seededRow({ boardSize: 'wide' } as never)]) {
      const storage = fakeStorage({ [sellerDockStorageKey()]: bad });
      expect(readSellerDockBoardSize(SELLER_DOCK_LAYOUT_NAME, { storage })).toBeUndefined();
    }
  });

  it('rejects a non-finite size instead of writing it', () => {
    const storage = fakeStorage({ [sellerDockStorageKey()]: seededRow() });
    expect(
      writeSellerDockBoardSize({ width: Number.POSITIVE_INFINITY, height: 600 }, SELLER_DOCK_LAYOUT_NAME, { storage }),
    ).toBe(false);
  });
});

describe('board size and layout share one row', () => {
  const realLocalStorage = Reflect.get(globalThis, 'localStorage');

  afterEach(() => {
    if (realLocalStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Reflect.set(globalThis, 'localStorage', realLocalStorage);
  });

  /**
   * The whole justification for hanging board size off the layout row rather
   * than a store of its own. Both directions are asserted because both are
   * silent when broken: a dropped board size looks like "the resize didn't
   * save", and a dropped layout looks like "the dock forgot my panels".
   */
  it('a layout save preserves the board size, and a reset clears both', async () => {
    Reflect.set(globalThis, 'localStorage', fakeStorage());
    const store = createSellerDockStore();

    // Mount-equivalent: seeds the row, which is what makes a board write legal.
    const seeded = await store.load(SELLER_DOCK_LAYOUT_NAME);
    expect(writeSellerDockBoardSize({ width: 880, height: 620 })).toBe(true);

    // A subsequent LAYOUT save must spread the board size through untouched.
    await store.save(SELLER_DOCK_LAYOUT_NAME, seeded.layoutJson);
    expect(readSellerDockBoardSize()).toEqual({ width: 880, height: 620 });

    // Reset drops the whole row, so the board returns to its default geometry
    // with no board-specific reset path to forget.
    await store.reset(SELLER_DOCK_LAYOUT_NAME);
    expect(readSellerDockBoardSize()).toBeUndefined();
  });
});

describe('<SellerDockBoard>', () => {
  it('renders no inline size until the user has resized', () => {
    // The unsized board must be the stylesheet's box, not a JS restatement of
    // it — two sources for one default is how they drift.
    const html = renderToStaticMarkup(
      <SellerDockBoard boardSizeOptions={{ storage: fakeStorage() }}>
        <div className="seller-dock-host" />
      </SellerDockBoard>,
    );
    expect(html).toContain('class="seller-dock-board"');
    expect(html).not.toContain('style=');
  });

  it('restores a persisted size on the first paint', () => {
    const storage = fakeStorage({
      [sellerDockStorageKey()]: seededRow({ boardSize: { width: 912, height: 648 } } as never),
    });
    const html = renderToStaticMarkup(
      <SellerDockBoard boardSizeOptions={{ storage }}>
        <div className="seller-dock-host" />
      </SellerDockBoard>,
    );
    expect(html).toContain('width:912px');
    expect(html).toContain('height:648px');
  });

  it('exposes both axes to the keyboard as labelled separators', () => {
    const html = renderToStaticMarkup(
      <SellerDockBoard boardSizeOptions={{ storage: fakeStorage() }}>
        <div className="seller-dock-host" />
      </SellerDockBoard>,
    );
    expect(html).toContain('aria-label="Resize board width"');
    expect(html).toContain('aria-label="Resize board height"');
    expect((html.match(/role="separator"/g) ?? []).length).toBe(2);
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(2);
    // The corner adds no keyboard reach the edges lack, so it must not add a
    // third tab stop that does nothing new.
    expect(html).toContain('seller-dock-board-handle--se');
    expect(html).toContain('aria-hidden="true"');
  });
});
