import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  SELLER_DOCK_RESET_EVENT,
  readSellerDockBoardSize,
  writeSellerDockBoardSize,
  type BoardSizeOptions,
  type SellerDockBoardSize,
} from './seller-dock-store';
import { SELLER_DOCK_LAYOUT_NAME } from './seller-dock-layout';

/**
 * Whole-board resize (P-015).
 *
 * Owner: "the full width and height of the entire board should also be
 * resizeable, not just the individual components." The inner panels have been
 * resizable since P-007 — dockview's sashes do that. What was missing is the
 * OUTER frame: the board itself was a fixed `clamp(560px, 72vh, 900px)` box
 * (see .seller-dock-host in seller-dock.css) that the user could not change.
 *
 * This file is a FRAME and nothing else, per D-003: it wraps the dock host,
 * paints three drag affordances on it, and owns the resulting width/height. It
 * renders no dock, knows no panels, and imports nothing from dockview.
 *
 * WHERE THE SIZE LIVES. On the existing layout row, via P-010's store — see the
 * board-size block in ./seller-dock-store for why a sibling field on that one
 * row is both the plan's requirement (no parallel store) and the reason reset
 * works for free. The DEFAULT is the ABSENCE of that field, which is why this
 * component renders NO inline style until the user has actually resized: the
 * unsized board is exactly the stylesheet's box, not a JS restatement of it
 * that could drift from the CSS.
 */

/**
 * Floors, in CSS pixels.
 *
 * Sized so the dock stays USABLE rather than merely non-zero: below roughly
 * this, dockview's tab strip (var(--ss-control-h)) plus a panel's padding
 * leaves no content area, and the board becomes a row of tabs over a sliver.
 * A floor a user can hit and still recover from is the point — there is no
 * "unresize" button other than Reset layout.
 */
export const SELLER_DOCK_MIN_BOARD_WIDTH = 480;
export const SELLER_DOCK_MIN_BOARD_HEIGHT = 320;

/** Keyboard resize increments: a nudge, and a Shift-held coarse step. */
export const SELLER_DOCK_BOARD_KEY_STEP = 16;
export const SELLER_DOCK_BOARD_KEY_STEP_COARSE = 64;

export interface BoardSizeLimits {
  /**
   * Upper bound on width — the space actually available in the seller tab.
   *
   * There is deliberately NO height ceiling. Width is bounded because the plan
   * scopes the board to "within the seller tab", and a board wider than its
   * column would either overflow the page or force a horizontal scrollbar on
   * the whole tab. Height has no such constraint: the page scrolls vertically
   * already, so a tall board is a legitimate thing to want, and inventing a
   * ceiling for it would just be a limit the user has to fight.
   */
  maxWidth?: number;
}

/**
 * Clamp a proposed size into the permitted range.
 *
 * Pure, and exported, because this is the whole of the geometry policy and the
 * component around it cannot be exercised in this package's test environment
 * (apps/web tests render through `react-dom/server` — there is no DOM, so there
 * are no pointers to drag and no boxes to measure). Keeping the policy in a
 * pure function is what makes the rules testable at all.
 *
 * The max floor-check is not redundant: when the available width is narrower
 * than the minimum (a very small window), the MINIMUM wins. The board is
 * allowed to be wider than its column in that case, because the alternative is
 * a board too small to use, and the overflow is visible and self-explanatory.
 */
export function clampSellerDockBoardSize(
  size: SellerDockBoardSize,
  limits: BoardSizeLimits = {},
): SellerDockBoardSize {
  const maxWidth = limits.maxWidth;
  let width = Math.max(SELLER_DOCK_MIN_BOARD_WIDTH, Math.round(size.width));
  if (typeof maxWidth === 'number' && Number.isFinite(maxWidth)) {
    width = Math.min(width, Math.max(SELLER_DOCK_MIN_BOARD_WIDTH, Math.round(maxWidth)));
  }
  const height = Math.max(SELLER_DOCK_MIN_BOARD_HEIGHT, Math.round(size.height));
  return { width, height };
}

/** Which dimension(s) a handle drives. */
export type BoardResizeAxis = 'x' | 'y' | 'xy';

/**
 * The size an arrow key produces, or null when the key is not a resize key for
 * this handle.
 *
 * Split out from the component for the same reason as the clamp: it is policy,
 * and policy that only exists inside a DOM event handler is policy no test in
 * this package can reach.
 */
export function sellerDockBoardSizeFromKey(
  key: string,
  shiftKey: boolean,
  axis: BoardResizeAxis,
  from: SellerDockBoardSize,
  limits: BoardSizeLimits = {},
): SellerDockBoardSize | null {
  const step = shiftKey ? SELLER_DOCK_BOARD_KEY_STEP_COARSE : SELLER_DOCK_BOARD_KEY_STEP;
  let dw = 0;
  let dh = 0;
  if (axis !== 'y' && (key === 'ArrowRight' || key === 'ArrowLeft')) {
    dw = key === 'ArrowRight' ? step : -step;
  } else if (axis !== 'x' && (key === 'ArrowDown' || key === 'ArrowUp')) {
    dh = key === 'ArrowDown' ? step : -step;
  } else {
    return null;
  }
  return clampSellerDockBoardSize({ width: from.width + dw, height: from.height + dh }, limits);
}

/**
 * Width available to the board: the inner width of whatever contains it.
 *
 * Returns Infinity rather than 0 when nothing is measurable (detached node,
 * a zero-width parent mid-mount). Returning 0 would clamp every drag to the
 * minimum and read exactly like a broken resize.
 */
function availableWidth(frame: HTMLElement | null): number {
  const parentWidth = frame?.parentElement?.clientWidth ?? 0;
  return parentWidth > 0 ? parentWidth : Number.POSITIVE_INFINITY;
}

interface DragState {
  axis: BoardResizeAxis;
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  maxWidth: number;
}

export interface SellerDockBoardProps {
  /** The dock host. */
  children: ReactNode;
  /** Layout name the size is stored under; matches the dock's own. */
  layoutName?: string;
  /** Storage overrides, for tests. Mirrors `SellerDockStoreOptions.storage`. */
  boardSizeOptions?: BoardSizeOptions;
  /** Window event that resets the board, alongside the dock's own reset. */
  resetEventName?: string;
}

export function SellerDockBoard({
  children,
  layoutName = SELLER_DOCK_LAYOUT_NAME,
  boardSizeOptions,
  resetEventName = SELLER_DOCK_RESET_EVENT,
}: SellerDockBoardProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  // Read in the initialiser, not an effect: the board must paint at its
  // restored size on the FIRST frame. Restoring in an effect paints the default
  // and then snaps, which is indistinguishable from a bug.
  const [size, setSize] = useState<SellerDockBoardSize | null>(
    () => readSellerDockBoardSize(layoutName, boardSizeOptions) ?? null,
  );
  const [dragging, setDragging] = useState<BoardResizeAxis | null>(null);

  // The committed size, mirrored for the handlers that persist it. Reading
  // `size` from a handler's closure would persist whatever the last RENDER saw,
  // which during a fast drag is not necessarily the last size applied.
  const sizeRef = useRef<SellerDockBoardSize | null>(size);
  const applySize = useCallback((next: SellerDockBoardSize | null) => {
    sizeRef.current = next;
    setSize(next);
  }, []);

  const persist = useCallback(
    (next: SellerDockBoardSize) => {
      writeSellerDockBoardSize(next, layoutName, boardSizeOptions);
    },
    [layoutName, boardSizeOptions],
  );

  /**
   * Reset. The dock's own listener (DockWorkspace, via `resetEventName`) drops
   * the whole storage row; this drops the in-memory size so the frame returns
   * to the stylesheet's default in the same tick.
   *
   * It deliberately does NOT write anything. The row is being removed and
   * reseeded around this handler, and a write landing in that window would
   * either resurrect a size the user just reset or — worse — recreate a partial
   * row. Default geometry IS the absence of a stored size, so there is nothing
   * to persist.
   */
  useEffect(() => {
    const onReset = () => {
      sizeRef.current = null;
      setSize(null);
    };
    window.addEventListener(resetEventName, onReset);
    return () => window.removeEventListener(resetEventName, onReset);
  }, [resetEventName]);

  const onPointerDown = useCallback(
    (axis: BoardResizeAxis) => (event: React.PointerEvent<HTMLDivElement>) => {
      const frame = frameRef.current;
      if (!frame || event.button !== 0) return;
      // Stops the browser from starting a text selection / native drag, which
      // otherwise cancels the pointer capture mid-resize.
      event.preventDefault();
      const rect = frame.getBoundingClientRect();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        axis,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: rect.width,
        startHeight: rect.height,
        // Measured ONCE per drag rather than per move: the parent's width does
        // not change while the user is dragging, and re-reading clientWidth on
        // every pointermove forces a layout flush per frame.
        maxWidth: availableWidth(frame),
      };
      setDragging(axis);
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      applySize(
        clampSellerDockBoardSize(
          {
            width: drag.axis === 'y' ? drag.startWidth : drag.startWidth + (event.clientX - drag.startX),
            height: drag.axis === 'x' ? drag.startHeight : drag.startHeight + (event.clientY - drag.startY),
          },
          { maxWidth: drag.maxWidth },
        ),
      );
    },
    [applySize],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      setDragging(null);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      // Persisted at drag END, not on every move: a pointermove-rate write is a
      // JSON.stringify of the whole layout row per frame, and an interrupted
      // drag should not leave a half-dragged size on disk.
      if (sizeRef.current) persist(sizeRef.current);
    },
    [persist],
  );

  const onKeyDown = useCallback(
    (axis: BoardResizeAxis) => (event: React.KeyboardEvent<HTMLDivElement>) => {
      const frame = frameRef.current;
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      const next = sellerDockBoardSizeFromKey(
        event.key,
        event.shiftKey,
        axis,
        // Measured, not read from state: until the first resize there IS no
        // state, and the stylesheet's box is the only truth about the size the
        // user is currently looking at.
        { width: rect.width, height: rect.height },
        { maxWidth: availableWidth(frame) },
      );
      if (!next) return;
      event.preventDefault();
      applySize(next);
      // Keyboard steps are discrete and complete, so each one commits.
      persist(next);
    },
    [applySize, persist],
  );

  const handleProps = (axis: BoardResizeAxis) => ({
    onPointerDown: onPointerDown(axis),
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  });

  return (
    <div
      ref={frameRef}
      className="seller-dock-board"
      data-resizing={dragging ?? undefined}
      // No inline style until the user has resized — see the header note: the
      // default board is the stylesheet's box, not a copy of it.
      style={size ? { width: `${size.width}px`, height: `${size.height}px` } : undefined}
    >
      {children}
      {/*
        Handles are keyboard-operable `separator`s, not decoration. dockview
        ships no outer resize affordance at all, so without these the feature
        would be pointer-only — and the P-011 chrome pass established that a
        focus ring here has to be earned under a real Tab, not assumed.

        Only the EAST and SOUTH edges carry handles. The north and west edges
        are left alone on purpose: dockview uses the board's outer edges as drop
        zones when a panel is dragged, and covering all four would take that
        away. Two edges plus the corner reach every dimension the owner asked
        for while leaving half the perimeter free for panel drops.
      */}
      <div
        {...handleProps('x')}
        className="seller-dock-board-handle seller-dock-board-handle--e"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize board width"
        tabIndex={0}
        onKeyDown={onKeyDown('x')}
      />
      <div
        {...handleProps('y')}
        className="seller-dock-board-handle seller-dock-board-handle--s"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize board height"
        tabIndex={0}
        onKeyDown={onKeyDown('y')}
      />
      {/*
        The corner drives both axes at once. It is aria-hidden and not
        focusable BECAUSE it adds no reach for a keyboard user — both of its
        dimensions are already reachable from the two edge handles above, so
        exposing it would only add a third tab stop that does nothing new.
      */}
      <div
        {...handleProps('xy')}
        className="seller-dock-board-handle seller-dock-board-handle--se"
        aria-hidden="true"
      />
    </div>
  );
}
