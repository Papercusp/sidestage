import { useEffect, useState, type RefObject } from 'react';
import { requestSellerDockLayoutReset } from './seller-dock-store';

/**
 * Seller dock toolbar (P-010) — currently just the reset-layout control.
 *
 * P-010 requires a control that returns the dock to the default seller-grid
 * arrangement. `DockWorkspace` already implements the reset itself; what was
 * missing was any way for a user to reach it, because its only affordance lives
 * on the load-error screen. This dispatches the window event the dock listens
 * for, which keeps the button decoupled from the dock instance — the toolbar
 * needs no ref, no context, and no prop drilling through SellerTab.
 *
 * Deliberately NOT behind a confirmation. The action is cheap to undo (the user
 * rearranges the panels again), the default is well-defined, and a modal in
 * front of a recovery control is exactly the wrong tradeoff when the reason a
 * user reaches for it is usually that the layout is already in a state they
 * dislike. This mirrors how editors ship "Reset Layout".
 *
 * P-011 owns the CHROME here (see seller-dock.css); this file owns the wiring.
 */

export interface SellerDockToolbarProps {
  /**
   * Override the reset action. Exists for tests and for a future host that owns
   * more than one dock; the default broadcasts to whichever seller dock is
   * mounted.
   */
  onResetLayout?: () => void;
  /** The whole shell, including this toolbar and the persisted dock board. */
  fullscreenTargetRef?: RefObject<HTMLDivElement | null>;
}

export interface SellerDockFullscreenTarget {
  requestFullscreen?: () => Promise<void>;
}

export interface SellerDockFullscreenDocument {
  fullscreenElement: SellerDockFullscreenTarget | null;
  exitFullscreen?: () => Promise<void>;
}

/**
 * Toggle the native Fullscreen API for the whole seller dock shell.
 *
 * Kept independent of React so entry, exit, and unsupported-browser behavior
 * stay testable in the package's DOM-free Vitest environment.
 */
export async function toggleSellerDockFullscreen(
  target: SellerDockFullscreenTarget | null,
  fullscreenDocument: SellerDockFullscreenDocument,
): Promise<boolean> {
  if (fullscreenDocument.fullscreenElement === target && target) {
    if (!fullscreenDocument.exitFullscreen) {
      throw new Error('Exiting fullscreen is not supported in this browser.');
    }
    await fullscreenDocument.exitFullscreen();
    return false;
  }

  if (!target?.requestFullscreen) {
    throw new Error('Fullscreen is not supported in this browser.');
  }
  await target.requestFullscreen();
  return true;
}

export function SellerDockToolbar({
  onResetLayout,
  fullscreenTargetRef,
}: SellerDockToolbarProps = {}) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);

  useEffect(() => {
    if (!fullscreenTargetRef || typeof document === 'undefined') return;
    const sync = () => {
      setIsFullscreen(document.fullscreenElement === fullscreenTargetRef.current);
    };
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [fullscreenTargetRef]);

  // Wrapped rather than passed straight to onClick: the handler receives a
  // MouseEvent, and `requestSellerDockLayoutReset` takes an optional EventTarget
  // as its first argument — so passing it directly would dispatch the reset onto
  // the click event instead of the window, silently doing nothing.
  const reset = () => {
    if (onResetLayout) {
      onResetLayout();
      return;
    }
    requestSellerDockLayoutReset();
  };

  const toggleFullscreen = async () => {
    if (!fullscreenTargetRef || typeof document === 'undefined') return;
    setFullscreenError(null);
    try {
      const next = await toggleSellerDockFullscreen(fullscreenTargetRef.current, document);
      setIsFullscreen(next);
    } catch (error) {
      setFullscreenError(
        error instanceof Error ? error.message : 'The seller board could not enter fullscreen.',
      );
    }
  };

  return (
    <div className="seller-dock-toolbar">
      {fullscreenError ? (
        <span className="seller-dock-fullscreen-error" role="alert">
          {fullscreenError}
        </span>
      ) : null}
      {fullscreenTargetRef ? (
        <button
          type="button"
          className="seller-dock-fullscreen"
          onClick={() => void toggleFullscreen()}
          aria-pressed={isFullscreen}
          title={isFullscreen ? 'Return the seller board to the page' : 'Show the entire seller board in fullscreen'}
        >
          {isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        </button>
      ) : null}
      <button
        type="button"
        className="seller-dock-reset"
        onClick={reset}
        title="Restore the default seller layout"
      >
        Reset layout
      </button>
    </div>
  );
}
