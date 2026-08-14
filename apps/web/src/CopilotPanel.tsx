import { type FormEvent, useCallback, useState } from 'react';
import { useSyncMutate } from '@papercusp/sync';
import type { BuyerProduct } from './buyer';
import { useBuyerCheckout } from './BuyerCheckout';
import { browserEventId } from './event-identity';
import { resolveApiOrigin, useEventChatSender, type EventChatMessageInput } from './EventChat';

interface ProductCard {
  productId: string;
  title: string;
  description: string;
  priceCents: number;
  availableQty: number;
  imageUrl?: string;
  attributes: Record<string, string | number | boolean>;
}

interface ScoutResponse {
  reply: string;
  products: ProductCard[];
  cartId: string;
  latencyMs: number;
}

export interface CopilotPanelProps {
  apiBaseUrl?: string;
  eventId?: string;
}

export type CopilotReplyReviewStatus = 'idle' | 'pending' | 'approved' | 'skipped';

export const PRODUCT_RESEARCH_LATENCY_BUDGET_MS = 2_000;

export function ProductResearchLatency({ latencyMs }: { latencyMs: number | null }) {
  if (latencyMs === null) return null;
  const withinBudget = latencyMs < PRODUCT_RESEARCH_LATENCY_BUDGET_MS;
  return (
    <p className="copilot-latency" role="status" aria-live="polite">
      <span>Product research</span>
      <strong className={withinBudget ? 'status-success' : 'status-warning'}>
        {latencyMs}ms · {withinBudget ? 'within' : 'over'} the sub-2s budget
      </strong>
    </p>
  );
}

/** Build the shared EventChat mutation input used by an approved copilot reply. */
export function sellerReplyInput(text: string): EventChatMessageInput {
  return {
    userId: 'seller-copilot-review',
    displayName: 'Host',
    role: 'seller',
    text: text.trim(),
  };
}

export function copilotProductToBuyerProduct(product: ProductCard): BuyerProduct {
  return {
    id: product.productId,
    title: product.title,
    subtitle: product.description,
    priceCents: product.priceCents,
    availableQty: product.availableQty,
    imageUrl: product.imageUrl,
  };
}

export interface CopilotReplyReviewProps {
  draft: string;
  editing: boolean;
  status: Exclude<CopilotReplyReviewStatus, 'idle'>;
  busy?: boolean;
  onDraftChange: (draft: string) => void;
  onEdit: () => void;
  onApprove: () => void;
  onSkip: () => void;
}

/** Seller review card shared by the generated, edited, sent, and skipped states. */
export function CopilotReplyReview({
  draft,
  editing,
  status,
  busy = false,
  onDraftChange,
  onEdit,
  onApprove,
  onSkip,
}: CopilotReplyReviewProps) {
  const pending = status === 'pending';
  return (
    <article className={`copilot-review-card copilot-review-${status}`} aria-label="Copilot reply review" data-copilot-reply-review="true">
      <div className="copilot-review-heading">
        <div>
          <p className="panel-kicker">Suggested seller reply</p>
          <strong>{pending ? 'Review before it reaches the room' : status === 'approved' ? 'Reply sent to the room' : 'Reply skipped'}</strong>
        </div>
        <span className="copilot-review-status">{status}</span>
      </div>
      {editing && pending ? (
        <label className="copilot-reply-editor">
          <span>Edit reply</span>
          <textarea aria-label="Seller reply draft" value={draft} onChange={(event) => onDraftChange(event.target.value)} />
        </label>
      ) : <p className="copilot-review-copy">{draft}</p>}
      {pending ? (
        <div className="copilot-review-actions" aria-label="Copilot reply actions">
          <button className="button primary" type="button" disabled={busy || !draft.trim()} onClick={onApprove}>Approve</button>
          <button className="button secondary" type="button" disabled={busy} onClick={onEdit}>{editing ? 'Editing' : 'Edit'}</button>
          <button className="button tertiary" type="button" disabled={busy} onClick={onSkip}>Skip</button>
        </div>
      ) : (
        <p className="copilot-review-result" role="status">
          {status === 'approved' ? 'Approved reply posted as the seller in live event chat.' : 'Suggestion dismissed without sending a message.'}
        </p>
      )}
    </article>
  );
}

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

/**
 * Small browser adapter for the P-004 contracts. The live-selling tabs can
 * compose this panel without owning cart state or payment-provider details.
 */
export function CopilotPanel({ apiBaseUrl, eventId = browserEventId() }: CopilotPanelProps) {
  const apiOrigin = resolveApiOrigin(apiBaseUrl);
  const buyerCheckout = useBuyerCheckout();
  const sendChatMessage = useEventChatSender({ eventId, apiBaseUrl });
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState('Ask about a product in the verified catalog.');
  const [replyDraft, setReplyDraft] = useState('');
  const [replyReviewStatus, setReplyReviewStatus] = useState<CopilotReplyReviewStatus>('idle');
  const [editingReply, setEditingReply] = useState(false);
  const [products, setProducts] = useState<ProductCard[]>([]);
  const [researchLatencyMs, setResearchLatencyMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const scoutFallback = useCallback(async (input: { message: string; cartId?: string; eventId: string }) => {
    const path = '/scout/chat';
    const init: RequestInit = { method: 'POST', body: JSON.stringify(input) };
    const response = await fetch(`${apiOrigin}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
    const payload = await response.json() as ScoutResponse & { message?: string };
    if (!response.ok) throw new Error(payload.message ?? `Request failed (${response.status})`);
    return payload;
  }, [apiOrigin]);
  const requestScout = useSyncMutate<
    { message: string; cartId?: string; eventId: string },
    ScoutResponse
  >('scout.chat', scoutFallback);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await requestScout({ message, cartId: buyerCheckout?.cartId, eventId });
      buyerCheckout?.adoptCartId(result.cartId);
      setProducts(result.products);
      setReply(result.reply);
      setReplyDraft(result.reply);
      setResearchLatencyMs(result.latencyMs);
      setReplyReviewStatus('pending');
      setEditingReply(false);
      setMessage('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to reach the copilot');
    } finally {
      setBusy(false);
    }
  }

  async function approveReply() {
    if (!replyDraft.trim() || busy || replyReviewStatus !== 'pending') return;
    setBusy(true);
    setError(undefined);
    try {
      await sendChatMessage(sellerReplyInput(replyDraft));
      setReplyReviewStatus('approved');
      setEditingReply(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to send the approved seller reply');
    } finally {
      setBusy(false);
    }
  }

  async function addToCart(product: ProductCard) {
    setBusy(true);
    setError(undefined);
    try {
      if (!buyerCheckout) throw new Error('Buyer checkout is unavailable');
      await buyerCheckout.holdProduct(copilotProductToBuyerProduct(product));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to update cart');
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
      {replyReviewStatus === 'idle' ? <p className="copilot-reply" role="status">{reply}</p> : (
        <CopilotReplyReview
          draft={replyDraft}
          editing={editingReply}
          status={replyReviewStatus}
          busy={busy}
          onDraftChange={setReplyDraft}
          onEdit={() => setEditingReply(true)}
          onApprove={() => void approveReply()}
          onSkip={() => {
            setReplyReviewStatus('skipped');
            setEditingReply(false);
          }}
        />
      )}
      <form className="copilot-form" onSubmit={ask}>
        <label htmlFor="copilot-message">Ask about the catalog</label>
        <div className="copilot-input-row">
          <input id="copilot-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Try “wireless headphones”" />
          <button className="button primary" type="submit" disabled={busy || !message.trim()}>{busy ? 'Working…' : 'Ask'}</button>
        </div>
      </form>
      <ProductResearchLatency latencyMs={researchLatencyMs} />
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
      {buyerCheckout?.heldItemCount ? (
        <div className="copilot-cart">
          <span>Held cart · {buyerCheckout.heldItemCount} item(s)</span>
          <button className="button secondary" type="button" onClick={buyerCheckout.openHeldItems} disabled={busy}>Open checkout</button>
        </div>
      ) : null}
    </section>
  );
}
