import { FormEvent, useState } from 'react';
import { useBuyerIdentity } from './buyer-identity';
import { browserEventId } from './event-identity';

interface ProductCard {
  productId: string;
  title: string;
  description: string;
  priceCents: number;
  availableQty: number;
  imageUrl?: string;
  attributes: Record<string, string | number | boolean>;
}

interface Cart {
  id: string;
  items: Array<{ productId: string; title: string; priceCents: number; quantity: number; imageUrl?: string }>;
  subtotalCents: number;
}

interface ScoutResponse {
  reply: string;
  products: ProductCard[];
  cart: Cart;
  cartId: string;
}

interface CheckoutResponse {
  order: { id: string; totalCents: number; status: string };
  session: { status: string; mode: string; appId: string | null; locationId: string | null };
}

export interface CopilotPanelProps {
  apiBaseUrl?: string;
  eventId?: string;
}

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

/**
 * Small browser adapter for the P-004 contracts. The live-selling tabs can
 * compose this panel without owning cart state or payment-provider details.
 */
export function CopilotPanel({ apiBaseUrl = '', eventId = browserEventId() }: CopilotPanelProps) {
  const { buyerId } = useBuyerIdentity();
  const [message, setMessage] = useState('');
  const [cartId, setCartId] = useState<string>();
  const [reply, setReply] = useState('Ask about a product in the verified catalog.');
  const [products, setProducts] = useState<ProductCard[]>([]);
  const [cart, setCart] = useState<Cart>();
  const [checkout, setCheckout] = useState<CheckoutResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
    const payload = await response.json() as T & { message?: string };
    if (!response.ok) throw new Error(payload.message ?? `Request failed (${response.status})`);
    return payload;
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await request<ScoutResponse>('/scout/chat', {
        method: 'POST',
        body: JSON.stringify({ message, cartId }),
      });
      setCartId(result.cartId);
      setCart(result.cart);
      setProducts(result.products);
      setReply(result.reply);
      setMessage('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to reach the copilot');
    } finally {
      setBusy(false);
    }
  }

  async function addToCart(product: ProductCard) {
    setBusy(true);
    setError(undefined);
    try {
      const result = await request<Cart>('/cart/items', {
        method: 'POST',
        body: JSON.stringify({ cartId, productId: product.productId, title: product.title, priceCents: product.priceCents, imageUrl: product.imageUrl }),
      });
      setCartId(result.id);
      setCart(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to update cart');
    } finally {
      setBusy(false);
    }
  }

  async function startCheckout() {
    if (!cartId || !cart?.items.length || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setCheckout(await request<CheckoutResponse>('/checkout/sessions', {
        method: 'POST',
        body: JSON.stringify({ cartId, buyerId, eventId }),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to start checkout');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="copilot-panel" aria-label="Seller copilot">
      <div className="copilot-panel-heading">
        <div>
          <p className="eyebrow">Verified catalog copilot</p>
          <h2>Find it, pin it, sell it.</h2>
        </div>
        <span className="live-badge">SQUARE SANDBOX</span>
      </div>
      <p className="copilot-reply" role="status">{reply}</p>
      <form className="copilot-form" onSubmit={ask}>
        <label htmlFor="copilot-message">Ask about the catalog</label>
        <div className="copilot-input-row">
          <input id="copilot-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Try “wireless headphones”" />
          <button className="button primary" type="submit" disabled={busy || !message.trim()}>{busy ? 'Working…' : 'Ask'}</button>
        </div>
      </form>
      {error ? <p className="copilot-error" role="alert">{error}</p> : null}
      {products.length > 0 ? (
        <div className="copilot-products" aria-label="Verified products">
          {products.map((product) => (
            <article className="copilot-product" key={product.productId}>
              {product.imageUrl ? <img src={product.imageUrl} alt="" /> : <div className="copilot-product-placeholder" aria-hidden="true" />}
              <div className="copilot-product-copy"><h3>{product.title}</h3><p>{product.description}</p><strong>{money(product.priceCents)}</strong><small>{product.availableQty} available</small></div>
              <button className="button secondary" type="button" onClick={() => void addToCart(product)} disabled={busy}>Add</button>
            </article>
          ))}
        </div>
      ) : null}
      {cart ? <div className="copilot-cart"><span>Cart · {cart.items.reduce((sum, item) => sum + item.quantity, 0)} item(s)</span><strong>{money(cart.subtotalCents)}</strong><button className="button secondary" type="button" onClick={() => void startCheckout()} disabled={busy || !cart.items.length}>Checkout</button></div> : null}
      {checkout ? <p className="copilot-checkout" role="status">Order {checkout.order.id} is {checkout.order.status}. Square {checkout.session.status} in {checkout.session.mode} mode.</p> : null}
    </section>
  );
}
