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
}

export function SellerDockToolbar({ onResetLayout }: SellerDockToolbarProps = {}) {
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

  return (
    <div className="seller-dock-toolbar">
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
