import '@papercusp/cart-drawer/styles.css';
import { useCallback } from 'react';
import {
  CartChip,
  CartDrawerBody,
  CartDrawerFooter,
  CartDrawerHeader,
  CartDrawerShell,
  CartDrawerSurface,
  CartEmptyState,
  CartErrorNotice,
  CartLineCard,
  CartLineList,
  CartSubtotalPanel,
  useDraftQuantities,
  useLineAlerts,
} from '@papercusp/cart-drawer';
import { formatBuyerPrice } from './buyer';
import type { BuyerCart, BuyerShippingMeter } from './buyer-checkout-api';
import {
  formatHoldCountdown,
  holdRemainingMs,
  planHoldWrite,
  toCartData,
  type BuyerCartAdapter,
} from './buyer-cart-adapter';
import './buyer-cart-drawer.css';

/**
 * SideStage's held-items cart, built on the shared `@papercusp/cart-drawer`.
 *
 * The library owns the presentation — drawer chrome (`@papercusp/drawer-stack`
 * registration + a non-modal Vaul pane), header/body/footer, the line card with
 * its committable quantity stepper, subtotal panel, empty/error states — and
 * this file stays SideStage's adapter surface: the holds/expiry writes (through
 * `BuyerCartAdapter`), the per-hold countdown rendered into the line card's
 * slot, and SideStage's copy.
 *
 * Split in two on purpose. `BuyerCartPanel` is the whole drawer CONTENT and
 * renders under `renderToStaticMarkup`, so the shipped held-items acceptance
 * criteria stay unit-assertable; `BuyerCartDrawer` adds the Vaul/portal shell
 * around it, which by design only mounts in a browser.
 */

export interface BuyerCartPanelProps {
  /** The server's cart. Null before a first hold — renders the empty state. */
  cart: BuyerCart | null;
  /** Clock the per-line countdowns render against; the provider ticks it. */
  nowMs: number;
  /** A cart write is in flight — disables the line controls. */
  busy?: boolean;
  /** Drawer-level failure (a failed hold, an expired hold). */
  error?: string;
  shippingMeter?: BuyerShippingMeter | null;
  shippingMeterLoading?: boolean;
  /** The holds/expiry seam; every write in this panel goes through it. */
  adapter: BuyerCartAdapter;
  /** Hand off to the existing BuyerCheckout flow. */
  onCheckout: () => void;
  onClose: () => void;
}

export function BuyerCartPanel({
  cart,
  nowMs,
  busy = false,
  error,
  shippingMeter,
  shippingMeterLoading = false,
  adapter,
  onCheckout,
  onClose,
}: BuyerCartPanelProps) {
  const { drafts, setDraft, commit } = useDraftQuantities();
  const { alerts, setAlert } = useLineAlerts();

  // Every write funnels through here so a server rejection (409 "Insufficient
  // available quantity…") lands as THAT line's alert rather than a drawer-wide
  // error — the buyer needs to know which hold could not move.
  const write = useCallback(async (productId: string, next: number) => {
    const plan = planHoldWrite(next);
    if (plan.kind === 'reject') {
      setAlert(productId, plan.reason);
      return;
    }
    try {
      if (plan.kind === 'release') await adapter.remove(productId);
      else await adapter.setQuantity(productId, plan.quantity);
    } catch (caught) {
      setAlert(productId, caught instanceof Error ? caught.message : 'That hold could not be updated.');
    }
  }, [adapter, setAlert]);

  const commitDraft = useCallback((productId: string) => {
    // null = no draft, or one that did not parse — the input reverts to the
    // server quantity on its own once the draft is cleared.
    const parsed = commit(productId);
    if (parsed === null) return;
    void write(productId, parsed);
  }, [commit, write]);

  const lines = toCartData(cart)?.items ?? [];
  const heldUnits = lines.reduce((total, line) => total + line.quantity, 0);
  // `CartLine` is the library's structural shape and carries no expiry — holds
  // are a SideStage concern, so the deadline is looked up beside the mapped
  // line rather than smuggled through the shared type.
  const expiryByProductId = new Map((cart?.items ?? []).map((item) => [item.productId, item.expiresAt]));
  // The server authors the subtotal (CartService.summarize); re-deriving it in
  // the client would introduce a second, silently-disagreeing authority.
  const subtotalCents = cart?.subtotalCents ?? 0;

  return (
    <CartDrawerSurface>
      <CartDrawerHeader
        kicker="Reserved for 2 minutes"
        title="Held items"
        description="Every hold releases on its own when the countdown reaches zero."
        chips={lines.length ? <CartChip tone="accent">{heldUnits} held</CartChip> : null}
        onClose={onClose}
        closeLabel="Close held items"
      />

      <CartDrawerBody>
        {error ? <CartErrorNotice message={error} retryLabel="Refresh" onRetry={() => adapter.refresh()} /> : null}

        {lines.length === 0 ? (
          <CartEmptyState
            title="No held items yet"
            body="Hold an item from the live rail to reserve it for two minutes."
          />
        ) : (
          <CartLineList>
            {lines.map((line) => {
              const { title } = line.product;
              return (
                <CartLineCard
                  key={line.id}
                  item={line}
                  busy={busy}
                  imageSrc={line.product.imageUrl}
                  imageAlt=""
                  imageFallback={<span aria-hidden="true">{title.slice(0, 1)}</span>}
                  formatPrice={formatBuyerPrice}
                  unitPriceSuffix=" each"
                  lineTotalLabel="Line total"
                  qtyLabel="Quantity"
                  draftValue={drafts[line.id]}
                  onDraftChange={(raw) => setDraft(line.id, raw)}
                  onCommitDraft={() => commitDraft(line.id)}
                  onIncrement={() => void write(line.id, line.quantity + 1)}
                  onDecrement={() => void write(line.id, line.quantity - 1)}
                  onRemove={() => void write(line.id, 0)}
                  labels={{
                    increase: `Increase ${title} quantity`,
                    decrease: `Decrease ${title} quantity`,
                    quantity: `${title} quantity`,
                    remove: `Release the hold on ${title}`,
                  }}
                  alert={alerts[line.id] ?? null}
                >
                  <p
                    className="buyer-hold-countdown"
                    role="timer"
                    aria-label={`${title} hold time remaining`}
                  >
                    <strong>{formatHoldCountdown(holdRemainingMs(expiryByProductId.get(line.id), nowMs))}</strong> remaining
                  </p>
                </CartLineCard>
              );
            })}
          </CartLineList>
        )}

        {lines.length > 0 ? (
          <section className="buyer-shipping-meter" aria-label="Combined shipping meter">
            <div className="buyer-shipping-meter-heading">
              <div>
                <p className="eyebrow">Combined shipping</p>
                <h3>{shippingMeterLoading && !shippingMeter ? 'Packing your items…' : `${shippingMeter?.parcelCount ?? '—'} ${shippingMeter?.parcelCount === 1 ? 'box' : 'boxes'}`}</h3>
              </div>
              {shippingMeter ? <strong>{shippingMeter.fillPercent}% full</strong> : null}
            </div>
            {shippingMeter ? (
              <div className="buyer-shipping-parcels" aria-label={`${shippingMeter.parcelCount} packed ${shippingMeter.parcelCount === 1 ? 'box' : 'boxes'}`}>
                {shippingMeter.parcels.map((parcel, index) => (
                  <div className="buyer-shipping-parcel" key={`${parcel.boxName ?? 'custom'}-${index}`}>
                    <span><strong>{parcel.boxName ?? 'Custom box'}</strong><small>{parcel.fillPercent}% filled</small></span>
                    <span className="buyer-shipping-fill" aria-hidden="true"><span style={{ width: `${parcel.fillPercent}%` }} /></span>
                  </div>
                ))}
              </div>
            ) : null}
            {shippingMeter?.suggestion?.status === 'price-confirmed' && shippingMeter.suggestion.shippingStays ? (
              <p className="buyer-shipping-suggestion is-confirmed">
                Add one more {shippingMeter.suggestion.title} — shipping stays {formatBuyerPrice(shippingMeter.suggestion.shippingStays.totalCents)} with {shippingMeter.suggestion.shippingStays.carrier} {shippingMeter.suggestion.shippingStays.service}.
              </p>
            ) : shippingMeter?.suggestion ? (
              <p className="buyer-shipping-suggestion">
                One more {shippingMeter.suggestion.title} still fits this packing plan. Enter an address at checkout to verify shipping.
              </p>
            ) : shippingMeter ? (
              <p className="buyer-shipping-suggestion">Another item may require a new box.</p>
            ) : null}
          </section>
        ) : null}
      </CartDrawerBody>

      <CartDrawerFooter>
        <CartSubtotalPanel
          label="Subtotal"
          sublabel={`${lines.length} held ${lines.length === 1 ? 'line' : 'lines'}`}
          amount={formatBuyerPrice(subtotalCents)}
          note="Shipping and tax are quoted at checkout."
        />
        <button
          className="button primary buyer-cart-checkout"
          type="button"
          disabled={lines.length === 0 || busy}
          onClick={onCheckout}
        >
          Checkout
        </button>
      </CartDrawerFooter>
    </CartDrawerSurface>
  );
}

export interface BuyerCartDrawerProps extends BuyerCartPanelProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Units on hold — the rail badge, and why the rail appears at all. */
  heldItemCount: number;
}

export function BuyerCartDrawer({ open, onOpenChange, heldItemCount, ...panel }: BuyerCartDrawerProps) {
  return (
    <CartDrawerShell
      id="sidestage-held-items"
      priority={20}
      width="var(--cd-drawer-width)"
      open={open}
      onOpenChange={onOpenChange}
      contentId="sidestage-held-items-drawer"
      ariaLabel="Held items"
      a11yDescription="Items you have reserved. Each hold lasts two minutes — adjust quantities, release a hold, or continue to checkout."
      renderTrigger={({ open: isOpen }) => (
        // The buyer tab's own "Held items" button is the primary entry point;
        // this rail pill is the always-reachable one from any tab, and only
        // materializes once there is something held (or the drawer is open).
        heldItemCount > 0 || isOpen ? (
          <button
            type="button"
            className="buyer-cart-rail"
            data-open={isOpen || undefined}
            aria-expanded={isOpen}
            aria-controls="sidestage-held-items-drawer"
            onClick={() => onOpenChange(!isOpen)}
          >
            <span aria-hidden="true">🛒</span>
            <span className="buyer-cart-rail-count" aria-hidden="true">{heldItemCount}</span>
            <span className="cd-sr-only">{`Held items (${heldItemCount})`}</span>
          </button>
        ) : null
      )}
    >
      <BuyerCartPanel {...panel} />
    </CartDrawerShell>
  );
}
