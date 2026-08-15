import {
  createContext,
  type FormEvent,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSyncMutate, useSyncQuery } from '@papercusp/sync';
import type { BuyerProduct } from './buyer';
import { formatBuyerPrice } from './buyer';
import {
  addHeldProductToCart,
  createBuyerCheckoutSession,
  fetchBuyerOrder,
  fetchBuyerOrderShippingRates,
  fetchBuyerShippingRates,
  persistBuyerCartId,
  readBuyerCartId,
  removeBuyerCartItem,
  setBuyerCartQuantity,
  type BuyerCart,
  type BuyerCheckoutOrder,
  type BuyerCheckoutSessionResponse,
  type BuyerShippingAddress,
  type BuyerShippingRate,
} from './buyer-checkout-api';
import { useBuyerIdentity } from './buyer-identity';
import { BuyerCartDrawer } from './BuyerCartDrawer';
import { BuyerScoutDrawer } from './BuyerScoutDrawer';
import { holdRemainingMs, type BuyerCartAdapter } from './buyer-cart-adapter';
import { StripePaymentForm } from './StripePaymentForm';
import './buyer-checkout.css';

/**
 * The held-items review is no longer a step here — it is the shared cart drawer
 * (`BuyerCartDrawer`, on `@papercusp/cart-drawer`), which hands off to this flow
 * at `address`. Keeping a dead 'cart' step would leave two surfaces claiming the
 * same job.
 */
export type BuyerCheckoutStep = 'address' | 'shipping' | 'payment' | 'success';

export interface CheckoutDraft extends BuyerShippingAddress {
  email: string;
}

const EMPTY_DRAFT: CheckoutDraft = {
  email: '',
  name: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
  country: 'US',
  phone: '',
};

export interface BuyerCheckoutActions {
  holdProduct: (product: BuyerProduct) => Promise<BuyerCart>;
  openHeldItems: () => void;
  openOrder: (orderId: string) => Promise<void>;
  adoptCartId: (cartId: string) => void;
  cartId?: string;
  heldItemCount: number;
  heldProductIds: readonly string[];
}

const BuyerCheckoutContext = createContext<BuyerCheckoutActions | null>(null);

/** Optional by design: BuyerProductRail is also rendered in isolated tests and embeds. */
export function useBuyerCheckout(): BuyerCheckoutActions | null {
  return useContext(BuyerCheckoutContext);
}

export interface BuyerCheckoutDrawerProps {
  open: boolean;
  step: BuyerCheckoutStep;
  cart: BuyerCart | null;
  order: BuyerCheckoutOrder | null;
  draft: CheckoutDraft;
  rates: readonly BuyerShippingRate[];
  selectedRateId: string;
  checkout: BuyerCheckoutSessionResponse | null;
  completedOrder: BuyerCheckoutOrder | null;
  busy: boolean;
  polling: boolean;
  error?: string;
  onClose: () => void;
  onStep: (step: BuyerCheckoutStep) => void;
  onDraft: (draft: CheckoutDraft) => void;
  onLoadRates: () => Promise<void>;
  onSelectRate: (id: string) => void;
  onStartCheckout: () => Promise<void>;
  onPaymentSubmitted: () => void;
  /** Back out of the flow to the held-items drawer it was handed off from. */
  onBackToCart: () => void;
  canBackToCart: boolean;
  onError: (message: string) => void;
}

function stepTitle(step: BuyerCheckoutStep): string {
  if (step === 'shipping') return 'Choose shipping';
  if (step === 'payment') return 'Secure payment';
  if (step === 'success') return 'Order confirmed';
  return 'Where should it go?';
}

export function BuyerCheckoutDrawer(props: BuyerCheckoutDrawerProps) {
  const {
    open, step, cart, order, draft, rates, selectedRateId, checkout, completedOrder, busy, polling, error,
    onClose, onStep, onDraft, onLoadRates, onSelectRate, onStartCheckout, onPaymentSubmitted,
    onBackToCart, canBackToCart, onError,
  } = props;
  if (!open) return null;

  const selectedRate = rates.find((rate) => rate.id === selectedRateId);
  const sourceOrder = checkout?.order ?? order;
  const subtotalCents = sourceOrder?.subtotalCents ?? cart?.subtotalCents ?? 0;
  const totalCents = subtotalCents + (selectedRate?.totalCents ?? 0);
  const updateDraft = (field: keyof CheckoutDraft, value: string) => onDraft({ ...draft, [field]: value });
  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    void onLoadRates();
  };

  return (
    <div className="buyer-checkout-layer">
      <button className="buyer-checkout-scrim" type="button" aria-label="Close checkout" onClick={onClose} />
      <section className="buyer-checkout-drawer" role="dialog" aria-modal="true" aria-labelledby="buyer-checkout-title">
        <header className="buyer-checkout-header">
          <div>
            <p className="eyebrow">Buyer checkout</p>
            <h2 id="buyer-checkout-title">{stepTitle(step)}</h2>
          </div>
          <button className="button secondary" type="button" onClick={onClose}>Close</button>
        </header>

        <ol className="buyer-checkout-progress" aria-label="Checkout progress">
          {['address', 'shipping', 'payment'].map((name, index) => (
            <li className={step === name ? 'active' : undefined} key={name}>{index + 1}<span>{name}</span></li>
          ))}
        </ol>

        {error ? <div className="buyer-checkout-error" role="alert">{error}</div> : null}

        {step === 'address' ? (
          <form className="buyer-checkout-body buyer-checkout-form" onSubmit={submitAddress}>
            <label>Email<input type="email" required value={draft.email} onChange={(event) => updateDraft('email', event.currentTarget.value)} /></label>
            <label>Full name<input required value={draft.name} onChange={(event) => updateDraft('name', event.currentTarget.value)} /></label>
            <label className="wide">Address<input required value={draft.line1} onChange={(event) => updateDraft('line1', event.currentTarget.value)} /></label>
            <label className="wide">Apartment, suite, etc.<input value={draft.line2} onChange={(event) => updateDraft('line2', event.currentTarget.value)} /></label>
            <label>City<input required value={draft.city} onChange={(event) => updateDraft('city', event.currentTarget.value)} /></label>
            <label>State<input required value={draft.state} onChange={(event) => updateDraft('state', event.currentTarget.value)} /></label>
            <label>ZIP code<input required value={draft.postalCode} onChange={(event) => updateDraft('postalCode', event.currentTarget.value)} /></label>
            <label>Country<input required value={draft.country} onChange={(event) => updateDraft('country', event.currentTarget.value)} /></label>
            <div className="buyer-checkout-actions wide">
              {canBackToCart ? <button className="button secondary" type="button" onClick={onBackToCart}>Back to held items</button> : <span />}
              <button className="button primary" type="submit" disabled={busy}>{busy ? 'Finding rates…' : 'Find shipping rates'}</button>
            </div>
          </form>
        ) : null}

        {step === 'shipping' ? (
          <div className="buyer-checkout-body">
            {rates.length === 0 ? <p>No live shipping rates are available for this address.</p> : (
              <fieldset className="buyer-checkout-rates">
                <legend>Live rates</legend>
                {rates.map((rate) => (
                  <label key={rate.id}>
                    <input type="radio" name="shipping-rate" checked={selectedRateId === rate.id} onChange={() => onSelectRate(rate.id)} />
                    <span><strong>{rate.carrier} {rate.service}</strong><small>{rate.deliveryDays === null ? 'Delivery estimate unavailable' : `${rate.deliveryDays} day delivery`}</small></span>
                    <strong>{formatBuyerPrice(rate.totalCents)}</strong>
                  </label>
                ))}
              </fieldset>
            )}
            <div className="buyer-checkout-summary">
              <span>Items <strong>{formatBuyerPrice(subtotalCents)}</strong></span>
              <span>Shipping <strong>{formatBuyerPrice(selectedRate?.totalCents ?? 0)}</strong></span>
              <span>Total <strong>{formatBuyerPrice(totalCents)}</strong></span>
            </div>
            <div className="buyer-checkout-actions">
              <button className="button secondary" type="button" onClick={() => onStep('address')}>Edit address</button>
              <button className="button primary" type="button" disabled={!selectedRate || busy} onClick={() => void onStartCheckout()}>
                {busy ? 'Starting checkout…' : 'Continue to payment'}
              </button>
            </div>
          </div>
        ) : null}

        {step === 'payment' && sourceOrder ? (
          <div className="buyer-checkout-body">
            <div className="buyer-checkout-total"><span>Order total</span><strong>{formatBuyerPrice(sourceOrder.totalCents)}</strong></div>
            {sourceOrder.paymentState === 'payment_processing' || polling ? (
              <div className="buyer-checkout-state" role="status">
                <strong>Payment processing</strong>
                <p>SideStage is waiting for Stripe's verified webhook. You can safely close this drawer and return from Orders.</p>
              </div>
            ) : checkout?.session.status === 'needs-configuration' ? (
              <div className="buyer-checkout-config" role="status">
                <strong>Stripe checkout is unavailable.</strong>
                <p>Payment configuration must be completed on the server before this order can be paid.</p>
              </div>
            ) : checkout ? (
              <StripePaymentForm session={checkout.session} busy={busy} onSubmitted={onPaymentSubmitted} onError={onError} />
            ) : (
              <div className="buyer-checkout-state" role="status">
                <strong>{sourceOrder.paymentState === 'payment_failed' ? 'Payment failed' : 'Payment required'}</strong>
                <p>Return to the address step to resume this order without creating a duplicate.</p>
              </div>
            )}
            {!polling && sourceOrder.paymentState !== 'payment_processing' ? <button className="button secondary" type="button" onClick={() => onStep(checkout ? 'shipping' : 'address')} disabled={busy}>Back</button> : null}
          </div>
        ) : null}

        {step === 'success' && completedOrder ? (
          <div className="buyer-checkout-body buyer-checkout-success" role="status">
            <span aria-hidden="true">✓</span>
            <h3>Payment received</h3>
            <p>Order {completedOrder.id} is paid and ready for fulfillment.</p>
            <a className="button primary" href="/?tab=orders">View my orders</a>
          </div>
        ) : null}
      </section>
    </div>
  );
}

type BuyerCheckoutProviderProps = PropsWithChildren<{
  eventId: string;
  apiBaseUrl?: string;
  showScout: boolean;
}>;

/**
 * Checkout state is private to one selected demo buyer. Keying the stateful
 * provider by that principal makes an identity switch an atomic boundary:
 * drawers, drafts, in-flight order state, and cached cart selection are all
 * discarded before the next buyer can render.
 */
export function BuyerCheckoutProvider(props: BuyerCheckoutProviderProps) {
  const { buyerId } = useBuyerIdentity();
  return <BuyerCheckoutProviderForBuyer key={buyerId} {...props} buyerId={buyerId} />;
}

function BuyerCheckoutProviderForBuyer({
  eventId,
  apiBaseUrl,
  showScout,
  children,
  buyerId,
}: BuyerCheckoutProviderProps & { buyerId: string }) {
  const [open, setOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [cartError, setCartError] = useState<string>();
  const [step, setStep] = useState<BuyerCheckoutStep>('address');
  const [cartId, setCartId] = useState(() => readBuyerCartId(buyerId));
  const [draft, setDraft] = useState<CheckoutDraft>(EMPTY_DRAFT);
  const [rates, setRates] = useState<BuyerShippingRate[]>([]);
  const [selectedRateId, setSelectedRateId] = useState('');
  const [order, setOrder] = useState<BuyerCheckoutOrder | null>(null);
  const [checkout, setCheckout] = useState<BuyerCheckoutSessionResponse | null>(null);
  const [completedOrder, setCompletedOrder] = useState<BuyerCheckoutOrder | null>(null);
  const [polling, setPolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const expiryRefreshInFlight = useRef<string | undefined>(undefined);

  const cartQuery = useSyncQuery<BuyerCart>({
    queryName: 'cart.byId',
    args: { cartId: cartId ?? '' },
    enabled: Boolean(cartId),
    pollIntervalMs: 10_000,
    staleTime: 0,
  });
  // Some query adapters retain their last payload while `enabled` flips off.
  // A buyer with no cart id must therefore mask that payload synchronously.
  const cart = cartId ? (cartQuery.data?.[0] ?? null) : null;

  useEffect(() => {
    if (cart) setNowMs(Date.now());
  }, [cart]);

  const fail = useCallback((caught: unknown) => {
    setError(caught instanceof Error ? caught.message : 'Checkout could not continue');
  }, []);

  const holdFallback = useCallback(
    ({ product }: { product: BuyerProduct }) => addHeldProductToCart(buyerId, product, apiBaseUrl),
    [apiBaseUrl, buyerId],
  );
  const mutateHoldProduct = useSyncMutate<{ product: BuyerProduct }, BuyerCart>('cart.holdProduct', holdFallback);
  const ratesFallback = useCallback(
    ({ cartId: nextCartId, address: nextAddress }: { cartId: string; address: BuyerShippingAddress }) => (
      fetchBuyerShippingRates(nextCartId, nextAddress, buyerId, apiBaseUrl)
    ),
    [apiBaseUrl, buyerId],
  );
  const mutateShippingRates = useSyncMutate<
    { cartId: string; address: BuyerShippingAddress },
    BuyerShippingRate[]
  >('shipping.rates', ratesFallback);
  const checkoutFallback = useCallback(
    (input: Parameters<typeof createBuyerCheckoutSession>[0]) => createBuyerCheckoutSession(input, buyerId, apiBaseUrl),
    [apiBaseUrl, buyerId],
  );
  const mutateCheckout = useSyncMutate<
    Parameters<typeof createBuyerCheckoutSession>[0],
    BuyerCheckoutSessionResponse
  >('checkout.createSession', checkoutFallback);
  const quantityFallback = useCallback(
    ({ cartId: nextCartId, productId, quantity }: { cartId: string; productId: string; quantity: number }) => (
      setBuyerCartQuantity(nextCartId, productId, quantity, buyerId, apiBaseUrl)
    ),
    [apiBaseUrl, buyerId],
  );
  const mutateQuantity = useSyncMutate<
    { cartId: string; productId: string; quantity: number },
    BuyerCart
  >('cart.setQuantity', quantityFallback);
  const removeFallback = useCallback(
    ({ cartId: nextCartId, productId }: { cartId: string; productId: string }) => (
      removeBuyerCartItem(nextCartId, productId, buyerId, apiBaseUrl)
    ),
    [apiBaseUrl, buyerId],
  );
  const mutateRemove = useSyncMutate<
    { cartId: string; productId: string },
    BuyerCart
  >('cart.removeItem', removeFallback);

  const adoptCartId = useCallback((nextCartId: string) => {
    const normalized = nextCartId.trim();
    if (!normalized) return;
    persistBuyerCartId(buyerId, normalized);
    setCartId(normalized);
  }, [buyerId]);

  // A hold opens the CART drawer, not the checkout flow: the buyer has reserved
  // something, not started paying for it.
  const addHeldProduct = useCallback(async (product: BuyerProduct): Promise<BuyerCart> => {
    setCartOpen(true);
    setBusy(true);
    setCartError(undefined);
    try {
      const heldCart = await mutateHoldProduct({ product });
      adoptCartId(heldCart.id);
      setNowMs(Date.now());
      return heldCart;
    } catch (caught) {
      setCartError(caught instanceof Error ? caught.message : 'That item could not be held.');
      throw caught;
    } finally {
      setBusy(false);
    }
  }, [adoptCartId, mutateHoldProduct]);

  const activeDeadlines = useMemo(() => cart?.items
    .map((item) => item.expiresAt ? Date.parse(item.expiresAt) : Number.NaN)
    .filter(Number.isFinite) ?? [], [cart]);

  useEffect(() => {
    if (activeDeadlines.length === 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), 1_000);
    return () => window.clearTimeout(timer);
  }, [activeDeadlines, nowMs]);

  useEffect(() => {
    if (!cart || expiryRefreshInFlight.current === cart.updatedAt) return;
    const hasExpiredItem = cart.items.some((item) => holdRemainingMs(item.expiresAt, nowMs) === 0);
    if (!hasExpiredItem) return;
    // An expiry invalidates any quote derived from the cart, so the flow is
    // wound back to the held-items drawer rather than left on a stale step.
    expiryRefreshInFlight.current = cart.updatedAt;
    cartQuery.invalidate();
    setRates([]);
    setSelectedRateId('');
    setCheckout(null);
    setCompletedOrder(null);
    setStep('address');
    setOpen(false);
    setCartOpen(true);
    setCartError('A two-minute hold expired. The item is available to other buyers again.');
  }, [cart, cartQuery, nowMs]);

  const address: BuyerShippingAddress = useMemo(() => ({
    name: draft.name,
    line1: draft.line1,
    line2: draft.line2 || undefined,
    city: draft.city,
    state: draft.state,
    postalCode: draft.postalCode,
    country: draft.country || 'US',
    phone: draft.phone || undefined,
  }), [draft]);

  const loadRates = async () => {
    if ((!cart && !order) || !draft.email.trim() || !address.name.trim() || !address.line1.trim()
      || !address.city.trim() || !address.state.trim() || !address.postalCode.trim()) {
      setError('Email, name, and a complete shipping address are required.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = order
        ? await fetchBuyerOrderShippingRates(order.id, address, buyerId, apiBaseUrl)
        : await mutateShippingRates({ cartId: cart!.id, address });
      setRates(result);
      setSelectedRateId(result[0]?.id ?? '');
      setStep('shipping');
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const startCheckout = async () => {
    if ((!cart && !order) || !selectedRateId) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await mutateCheckout({
        ...(order ? { orderId: order.id } : { cartId: cart!.id, eventId }),
        email: draft.email.trim(),
        name: draft.name.trim(),
        shippingAddress: address,
        shippingRateId: selectedRateId,
      });
      setOrder(result.order);
      setCheckout(result);
      setPolling(false);
      setStep('payment');
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const openOrder = useCallback(async (orderId: string, awaitWebhook = false) => {
    setCartOpen(false);
    setOpen(true);
    setBusy(true);
    setError(undefined);
    setCheckout(null);
    setRates([]);
    setSelectedRateId('');
    try {
      const current = await fetchBuyerOrder(orderId, buyerId, apiBaseUrl);
      setOrder(current);
      if (current.shippingAddress) {
        setDraft({
          email: current.email ?? '',
          name: current.shippingAddress.name,
          line1: current.shippingAddress.line1,
          line2: current.shippingAddress.line2 ?? '',
          city: current.shippingAddress.city,
          state: current.shippingAddress.state,
          postalCode: current.shippingAddress.postalCode,
          country: current.shippingAddress.country,
          phone: current.shippingAddress.phone ?? '',
        });
      }
      if (current.paymentState === 'paid') {
        setCompletedOrder(current);
        setStep('success');
        setPolling(false);
      } else if (awaitWebhook || current.paymentState === 'payment_processing') {
        setStep('payment');
        setPolling(true);
      } else {
        setStep('address');
        setPolling(false);
        if (current.paymentState === 'payment_failed') {
          setError(current.paymentError ?? 'The previous payment attempt failed. Review the address and try again.');
        }
      }
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  }, [apiBaseUrl, buyerId, fail]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const returnOrderId = url.searchParams.get('checkout_order');
    if (!returnOrderId || url.searchParams.get('checkout_return') !== '1') return;
    void openOrder(returnOrderId, true);
    for (const key of ['checkout_order', 'checkout_return', 'payment_intent', 'payment_intent_client_secret', 'redirect_status']) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [openOrder]);

  useEffect(() => {
    const orderId = order?.id;
    if (!polling || !orderId) return;
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const current = await fetchBuyerOrder(orderId, buyerId, apiBaseUrl);
        if (cancelled) return;
        setOrder(current);
        if (current.paymentState === 'paid') {
          setCompletedOrder(current);
          setStep('success');
          setPolling(false);
          return;
        }
        if (current.paymentState === 'payment_failed' || current.paymentState === 'cancelled' || current.paymentState === 'expired') {
          setPolling(false);
          setError(current.paymentError ?? 'Payment did not complete.');
          return;
        }
        timer = window.setTimeout(() => void refresh(), 1_500);
      } catch (caught) {
        if (!cancelled) {
          setPolling(false);
          fail(caught);
        }
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [apiBaseUrl, buyerId, fail, order?.id, polling]);

  /**
   * The holds/expiry seam the shared cart drawer is driven through. Writes
   * REJECT rather than swallowing into the drawer-wide error: the drawer turns a
   * rejection into that line's own alert, which is the only place a "this
   * specific hold could not move" message means anything.
   */
  const cartAdapter = useMemo<BuyerCartAdapter>(() => ({
    hold: addHeldProduct,
    setQuantity: async (productId, quantity) => {
      if (!cart) throw new Error('There is no cart to update yet.');
      setBusy(true);
      try {
        return await mutateQuantity({ cartId: cart.id, productId, quantity });
      } finally {
        setBusy(false);
      }
    },
    remove: async (productId) => {
      if (!cart) throw new Error('There is no cart to update yet.');
      setBusy(true);
      try {
        return await mutateRemove({ cartId: cart.id, productId });
      } finally {
        setBusy(false);
      }
    },
    // GET /cart/:id prunes expired holds on read, so this is also the recovery
    // path from an expiry the client noticed first.
    refresh: () => cartQuery.invalidate(),
  }), [addHeldProduct, cart, cartQuery, mutateQuantity, mutateRemove]);

  const openHeldItems = useCallback(() => {
    setCartError(undefined);
    setCartOpen(true);
  }, []);

  // The handoff, in both directions: the cart drawer owns held items, this flow
  // owns address→payment, and exactly one of them is open at a time.
  const beginCheckout = useCallback(() => {
    setCartOpen(false);
    setOrder(null);
    setCheckout(null);
    setPolling(false);
    setStep('address');
    setError(undefined);
    setOpen(true);
  }, []);

  const backToCart = useCallback(() => {
    setOpen(false);
    openHeldItems();
  }, [openHeldItems]);

  const contextValue = useMemo<BuyerCheckoutActions>(() => ({
    holdProduct: addHeldProduct,
    openHeldItems,
    openOrder,
    adoptCartId,
    cartId,
    heldItemCount: cart?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0,
    heldProductIds: cart?.items.map((item) => item.productId) ?? [],
  }), [addHeldProduct, adoptCartId, cart, cartId, openHeldItems, openOrder]);

  return (
    <BuyerCheckoutContext.Provider value={contextValue}>
      {children}
      {showScout ? (
        <BuyerScoutDrawer
          eventId={eventId}
          cartId={cartId}
          heldProductIds={contextValue.heldProductIds}
          onHoldProduct={async (product) => {
            await addHeldProduct(product);
          }}
          onOpenHeldItems={openHeldItems}
        />
      ) : null}
      <BuyerCartDrawer
        open={cartOpen}
        onOpenChange={setCartOpen}
        heldItemCount={contextValue.heldItemCount}
        cart={cart}
        nowMs={nowMs}
        busy={busy}
        error={cartError}
        adapter={cartAdapter}
        onCheckout={beginCheckout}
        onClose={() => setCartOpen(false)}
      />
      <BuyerCheckoutDrawer
        open={open}
        step={step}
        cart={cart}
        order={order}
        draft={draft}
        rates={rates}
        selectedRateId={selectedRateId}
        checkout={checkout}
        completedOrder={completedOrder}
        busy={busy}
        polling={polling}
        error={error}
        onClose={() => setOpen(false)}
        onStep={setStep}
        onDraft={setDraft}
        onLoadRates={loadRates}
        onSelectRate={setSelectedRateId}
        onStartCheckout={startCheckout}
        onPaymentSubmitted={() => {
          setError(undefined);
          setPolling(true);
        }}
        onBackToCart={backToCart}
        canBackToCart={!order}
        onError={setError}
      />
    </BuyerCheckoutContext.Provider>
  );
}
