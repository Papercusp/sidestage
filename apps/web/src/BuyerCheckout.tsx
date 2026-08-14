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
  confirmBuyerSquarePayment,
  createBuyerCheckoutSession,
  fetchBuyerShippingRates,
  persistBuyerCartId,
  readBuyerCartId,
  removeBuyerCartItem,
  setBuyerCartQuantity,
  type BuyerCart,
  type BuyerCheckoutOrder,
  type BuyerCheckoutSessionResponse,
  type BuyerPaymentSession,
  type BuyerShippingAddress,
  type BuyerShippingRate,
} from './buyer-checkout-api';
import { useBuyerIdentity } from './buyer-identity';
import './buyer-checkout.css';

export type BuyerCheckoutStep = 'cart' | 'address' | 'shipping' | 'payment' | 'success';

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

export function holdRemainingMs(expiresAt: string | undefined, nowMs: number): number | null {
  if (!expiresAt) return null;
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return 0;
  return Math.max(0, deadline - nowMs);
}

export function formatHoldCountdown(remainingMs: number | null): string {
  if (remainingMs === null) return 'Reserved';
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

interface SquareTokenResult {
  status: 'OK' | string;
  token?: string;
  errors?: Array<{ message?: string }>;
}

interface SquareCardHandle {
  attach(selector: string): Promise<void>;
  tokenize(): Promise<SquareTokenResult>;
  destroy?(): Promise<void>;
}

interface SquarePaymentsHandle {
  card(): Promise<SquareCardHandle>;
}

interface SquareBrowserSdk {
  payments(appId: string, locationId: string): Promise<SquarePaymentsHandle>;
}

declare global {
  interface Window {
    Square?: SquareBrowserSdk;
  }
}

let squareSdkPromise: Promise<SquareBrowserSdk> | undefined;

function loadSquareSandboxSdk(): Promise<SquareBrowserSdk> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Square requires a browser'));
  if (window.Square) return Promise.resolve(window.Square);
  if (squareSdkPromise) return squareSdkPromise;

  squareSdkPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-sidestage-square]');
    const script = existing ?? document.createElement('script');
    const finish = () => window.Square
      ? resolve(window.Square)
      : reject(new Error('Square sandbox did not initialize'));
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => reject(new Error('Square sandbox could not be loaded')), { once: true });
    if (!existing) {
      script.src = 'https://sandbox.web.squarecdn.com/v1/square.js';
      script.async = true;
      script.dataset.sidestageSquare = 'true';
      document.head.append(script);
    }
  });
  return squareSdkPromise;
}

function SquareSandboxCard({
  session,
  busy,
  onConfirm,
  onError,
}: {
  session: BuyerPaymentSession;
  busy: boolean;
  onConfirm: (sourceId: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const cardRef = useRef<SquareCardHandle | undefined>(undefined);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (session.status !== 'ready' || !session.appId || !session.locationId) return;
    let cancelled = false;
    let mountedCard: SquareCardHandle | undefined;
    void loadSquareSandboxSdk()
      .then((sdk) => sdk.payments(session.appId!, session.locationId!))
      .then((payments) => payments.card())
      .then(async (card) => {
        mountedCard = card;
        await card.attach('#sidestage-square-card');
        if (cancelled) {
          await card.destroy?.();
          return;
        }
        cardRef.current = card;
        setReady(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error instanceof Error ? error.message : 'Square sandbox could not be loaded');
      });
    return () => {
      cancelled = true;
      cardRef.current = undefined;
      void mountedCard?.destroy?.();
    };
  }, [onError, session.appId, session.locationId, session.status]);

  const pay = async () => {
    const result = await cardRef.current?.tokenize();
    if (!result || result.status !== 'OK' || !result.token) {
      onError(result?.errors?.[0]?.message ?? 'Square could not tokenize this card');
      return;
    }
    await onConfirm(result.token);
  };

  return (
    <div className="buyer-checkout-payment">
      <div id="sidestage-square-card" className="buyer-square-card" aria-label="Square sandbox card entry" />
      <button className="button primary" type="button" disabled={!ready || busy} onClick={() => void pay()}>
        {busy ? 'Processing…' : `Pay ${formatBuyerPrice(session.amountCents)} with Square`}
      </button>
      <p>Sandbox payment · card details are tokenized by Square and never reach SideStage.</p>
    </div>
  );
}

export interface BuyerCheckoutDrawerProps {
  open: boolean;
  step: BuyerCheckoutStep;
  cart: BuyerCart | null;
  draft: CheckoutDraft;
  rates: readonly BuyerShippingRate[];
  selectedRateId: string;
  checkout: BuyerCheckoutSessionResponse | null;
  completedOrder: BuyerCheckoutOrder | null;
  busy: boolean;
  nowMs: number;
  error?: string;
  onClose: () => void;
  onStep: (step: BuyerCheckoutStep) => void;
  onDraft: (draft: CheckoutDraft) => void;
  onLoadRates: () => Promise<void>;
  onSelectRate: (id: string) => void;
  onStartCheckout: () => Promise<void>;
  onConfirm: (sourceId: string) => Promise<void>;
  onQuantity: (productId: string, quantity: number) => Promise<void>;
  onRemove: (productId: string) => Promise<void>;
  onError: (message: string) => void;
}

function stepTitle(step: BuyerCheckoutStep): string {
  if (step === 'address') return 'Where should it go?';
  if (step === 'shipping') return 'Choose shipping';
  if (step === 'payment') return 'Square sandbox';
  if (step === 'success') return 'Order confirmed';
  return 'Held items';
}

export function BuyerCheckoutDrawer(props: BuyerCheckoutDrawerProps) {
  const {
    open, step, cart, draft, rates, selectedRateId, checkout, completedOrder, busy, nowMs, error,
    onClose, onStep, onDraft, onLoadRates, onSelectRate, onStartCheckout, onConfirm,
    onQuantity, onRemove, onError,
  } = props;
  if (!open) return null;

  const selectedRate = rates.find((rate) => rate.id === selectedRateId);
  const totalCents = (cart?.subtotalCents ?? 0) + (selectedRate?.totalCents ?? 0);
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
            <p className="eyebrow">{step === 'cart' ? 'Reserved for 2 minutes' : 'Buyer checkout'}</p>
            <h2 id="buyer-checkout-title">{stepTitle(step)}</h2>
          </div>
          <button className="button secondary" type="button" onClick={onClose}>Close</button>
        </header>

        <ol className="buyer-checkout-progress" aria-label="Checkout progress">
          {['cart', 'address', 'shipping', 'payment'].map((name, index) => (
            <li className={step === name ? 'active' : undefined} key={name}>{index + 1}<span>{name}</span></li>
          ))}
        </ol>

        {error ? <div className="buyer-checkout-error" role="alert">{error}</div> : null}

        {step === 'cart' ? (
          <div className="buyer-checkout-body">
            {!cart?.items.length ? <p>No held items yet. Hold an item from the live rail to reserve it for two minutes.</p> : (
              <ul className="buyer-checkout-cart" aria-label="Held items">
                {cart.items.map((item) => {
                  const remaining = holdRemainingMs(item.expiresAt, nowMs);
                  return (
                  <li key={item.productId}>
                    <span className="buyer-held-item-image" aria-hidden="true">
                      {item.imageUrl ? <img src={item.imageUrl} alt="" width="56" height="56" /> : item.title.slice(0, 1)}
                    </span>
                    <div>
                      <strong>{item.title}</strong>
                      <span>{formatBuyerPrice(item.priceCents)} each</span>
                      <span className="buyer-hold-countdown" role="timer" aria-label={`${item.title} hold time remaining`}>
                        <strong>{formatHoldCountdown(remaining)}</strong> remaining
                      </span>
                    </div>
                    <label>
                      <span>Quantity</span>
                      <input
                        type="number"
                        min="1"
                        max="99"
                        value={item.quantity}
                        disabled={busy}
                        onChange={(event) => void onQuantity(item.productId, Number(event.currentTarget.value))}
                      />
                    </label>
                    <button type="button" onClick={() => void onRemove(item.productId)} disabled={busy}>Remove</button>
                  </li>
                  );
                })}
              </ul>
            )}
            <div className="buyer-checkout-total"><span>Subtotal</span><strong>{formatBuyerPrice(cart?.subtotalCents ?? 0)}</strong></div>
            <button className="button primary" type="button" disabled={!cart?.items.length || busy} onClick={() => onStep('address')}>
              Checkout
            </button>
          </div>
        ) : null}

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
              <button className="button secondary" type="button" onClick={() => onStep('cart')}>Back</button>
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
              <span>Cart <strong>{formatBuyerPrice(cart?.subtotalCents ?? 0)}</strong></span>
              <span>Shipping <strong>{formatBuyerPrice(selectedRate?.totalCents ?? 0)}</strong></span>
              <span>Total <strong>{formatBuyerPrice(totalCents)}</strong></span>
            </div>
            <div className="buyer-checkout-actions">
              <button className="button secondary" type="button" onClick={() => onStep('address')}>Edit address</button>
              <button className="button primary" type="button" disabled={!selectedRate || busy} onClick={() => void onStartCheckout()}>
                {busy ? 'Starting checkout…' : 'Continue to Square'}
              </button>
            </div>
          </div>
        ) : null}

        {step === 'payment' && checkout ? (
          <div className="buyer-checkout-body">
            <div className="buyer-checkout-total"><span>Order total</span><strong>{formatBuyerPrice(checkout.order.totalCents)}</strong></div>
            {checkout.session.status === 'needs-configuration' ? (
              <div className="buyer-checkout-config" role="status">
                <strong>Square sandbox needs configuration.</strong>
                <p>Set the server-side Square sandbox credentials to enable tokenized card checkout.</p>
              </div>
            ) : (
              <SquareSandboxCard session={checkout.session} busy={busy} onConfirm={onConfirm} onError={onError} />
            )}
            <button className="button secondary" type="button" onClick={() => onStep('shipping')} disabled={busy}>Back to shipping</button>
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

export function BuyerCheckoutProvider({
  eventId,
  apiBaseUrl,
  children,
}: PropsWithChildren<{ eventId: string; apiBaseUrl?: string }>) {
  const { buyerId } = useBuyerIdentity();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<BuyerCheckoutStep>('cart');
  const [cartId, setCartId] = useState(() => readBuyerCartId(buyerId));
  const [draft, setDraft] = useState<CheckoutDraft>(EMPTY_DRAFT);
  const [rates, setRates] = useState<BuyerShippingRate[]>([]);
  const [selectedRateId, setSelectedRateId] = useState('');
  const [checkout, setCheckout] = useState<BuyerCheckoutSessionResponse | null>(null);
  const [completedOrder, setCompletedOrder] = useState<BuyerCheckoutOrder | null>(null);
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
  const cart = cartQuery.data?.[0] ?? null;

  useEffect(() => {
    setCartId(readBuyerCartId(buyerId));
    setRates([]);
    setSelectedRateId('');
    setCheckout(null);
    setCompletedOrder(null);
  }, [buyerId]);

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
      fetchBuyerShippingRates(nextCartId, nextAddress, apiBaseUrl)
    ),
    [apiBaseUrl],
  );
  const mutateShippingRates = useSyncMutate<
    { cartId: string; address: BuyerShippingAddress },
    BuyerShippingRate[]
  >('shipping.rates', ratesFallback);
  const checkoutFallback = useCallback(
    (input: Parameters<typeof createBuyerCheckoutSession>[0]) => createBuyerCheckoutSession(input, apiBaseUrl),
    [apiBaseUrl],
  );
  const mutateCheckout = useSyncMutate<
    Parameters<typeof createBuyerCheckoutSession>[0],
    BuyerCheckoutSessionResponse
  >('checkout.createSession', checkoutFallback);
  const confirmFallback = useCallback(
    ({ orderId, sourceId }: { orderId: string; sourceId: string }) => (
      confirmBuyerSquarePayment(orderId, sourceId, apiBaseUrl)
    ),
    [apiBaseUrl],
  );
  const mutateConfirmPayment = useSyncMutate<
    { orderId: string; sourceId: string },
    Awaited<ReturnType<typeof confirmBuyerSquarePayment>>
  >('checkout.confirmPayment', confirmFallback);
  const quantityFallback = useCallback(
    ({ cartId: nextCartId, productId, quantity }: { cartId: string; productId: string; quantity: number }) => (
      setBuyerCartQuantity(nextCartId, productId, quantity, apiBaseUrl)
    ),
    [apiBaseUrl],
  );
  const mutateQuantity = useSyncMutate<
    { cartId: string; productId: string; quantity: number },
    BuyerCart
  >('cart.setQuantity', quantityFallback);
  const removeFallback = useCallback(
    ({ cartId: nextCartId, productId }: { cartId: string; productId: string }) => (
      removeBuyerCartItem(nextCartId, productId, apiBaseUrl)
    ),
    [apiBaseUrl],
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

  const addHeldProduct = useCallback(async (product: BuyerProduct): Promise<BuyerCart> => {
    setOpen(true);
    setStep('cart');
    setBusy(true);
    setError(undefined);
    try {
      const heldCart = await mutateHoldProduct({ product });
      adoptCartId(heldCart.id);
      setNowMs(Date.now());
      return heldCart;
    } catch (caught) {
      fail(caught);
      throw caught;
    } finally {
      setBusy(false);
    }
  }, [adoptCartId, fail, mutateHoldProduct]);

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
    expiryRefreshInFlight.current = cart.updatedAt;
    cartQuery.invalidate();
    setRates([]);
    setSelectedRateId('');
    setCheckout(null);
    setStep('cart');
    setError('A two-minute hold expired. The item is available to other buyers again.');
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
    if (!cart || !draft.email.trim() || !address.name.trim() || !address.line1.trim()
      || !address.city.trim() || !address.state.trim() || !address.postalCode.trim()) {
      setError('Email, name, and a complete shipping address are required.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await mutateShippingRates({ cartId: cart.id, address });
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
    if (!cart || !selectedRateId) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await mutateCheckout({
        cartId: cart.id,
        buyerId,
        eventId,
        email: draft.email.trim(),
        shippingAddress: address,
        shippingRateId: selectedRateId,
      });
      setCheckout(result);
      setStep('payment');
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (sourceId: string) => {
    if (!checkout) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await mutateConfirmPayment({ orderId: checkout.order.id, sourceId });
      if (result.payment.status !== 'paid' || result.order.status !== 'paid') {
        throw new Error(result.payment.errorMessage ?? 'Square did not complete the payment');
      }
      setCompletedOrder(result.order);
      setStep('success');
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const changeQuantity = async (productId: string, quantity: number) => {
    if (!cart || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) return;
    setBusy(true);
    try {
      await mutateQuantity({ cartId: cart.id, productId, quantity });
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (productId: string) => {
    if (!cart) return;
    setBusy(true);
    try {
      await mutateRemove({ cartId: cart.id, productId });
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const contextValue = useMemo<BuyerCheckoutActions>(() => ({
    holdProduct: addHeldProduct,
    openHeldItems: () => { setStep('cart'); setOpen(true); setError(undefined); },
    adoptCartId,
    cartId,
    heldItemCount: cart?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0,
    heldProductIds: cart?.items.map((item) => item.productId) ?? [],
  }), [addHeldProduct, adoptCartId, cart, cartId]);

  return (
    <BuyerCheckoutContext.Provider value={contextValue}>
      {children}
      <BuyerCheckoutDrawer
        open={open}
        step={step}
        cart={cart}
        draft={draft}
        rates={rates}
        selectedRateId={selectedRateId}
        checkout={checkout}
        completedOrder={completedOrder}
        busy={busy}
        nowMs={nowMs}
        error={error}
        onClose={() => setOpen(false)}
        onStep={setStep}
        onDraft={setDraft}
        onLoadRates={loadRates}
        onSelectRate={setSelectedRateId}
        onStartCheckout={startCheckout}
        onConfirm={confirm}
        onQuantity={changeQuantity}
        onRemove={remove}
        onError={setError}
      />
    </BuyerCheckoutContext.Provider>
  );
}
