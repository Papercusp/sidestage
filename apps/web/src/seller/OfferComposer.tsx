/**
 * The one targeted-offer composer (plan sidestage-lineup-run-of-show-2026-08-16,
 * D-007 / P-006).
 *
 * WHY THIS IS ONE COMPONENT AND NOT AN IDIOM EACH SURFACE REPEATS: an offer is
 * composed of four values the server independently refuses — a buyer it has
 * actually seen, a quantity within reserved inventory, a price at or above the
 * event floor, and an action kind the policy permits. A surface that assembles
 * those controls itself inevitably guards SOME of them, and the ones it forgets
 * become a Send button that is enabled for an offer the server rejects. That is
 * not hypothetical: the Lineup timeline's inline copy checked only that a buyer
 * was chosen and the price parsed, so it offered to send below-floor offers that
 * the grid it replaced had correctly blocked. Both surfaces now compose through
 * `evaluateOffer` here — the same guard, reached one way.
 *
 * The guard MIRRORS the server; it never replaces it. `evaluateOffer` exists so
 * the button stops exactly where the server stops, and the server remains the
 * authority that actually refuses.
 */
import { evaluateOffer, type BuyerCandidate } from './offer-guard';
import type { MarkdownPolicyView } from './markdown-guard';
import { BuyerPicker } from './BuyerPicker';

export interface OfferDraft {
  buyerId: string;
  quantity: string;
  /** Price as typed, in DOLLARS — the composer converts to cents once, here. */
  price: string;
}

export interface OfferComposerProps {
  productId: string;
  title: string;
  /** The verified event price the floor is computed from, in integer cents. */
  currentPriceCents: number;
  availableQty: number;
  policy?: MarkdownPolicyView | null;
  blockedActionKinds?: readonly string[] | null;
  candidates: readonly BuyerCandidate[];
  buyersLoading?: boolean;
  draft: OfferDraft;
  onDraftChange: (patch: Partial<OfferDraft>) => void;
  /** Receives the CHOSEN buyer, so the caller can name them in the action reason. */
  onSend: (buyer: BuyerCandidate, quantity: number, priceCents: number) => void;
  disabled?: boolean;
  /** Layout hook, so the dock and the timeline drawer can sit differently. */
  className?: string;
}

/** Dollars as typed → integer cents, or null when it is not a sendable number. */
function priceToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

function positiveInt(raw: string, fallback: number): number {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function emptyOfferDraft(): OfferDraft {
  return { buyerId: '', quantity: '1', price: '' };
}

export function OfferComposer({
  productId,
  title,
  currentPriceCents,
  availableQty,
  policy,
  blockedActionKinds,
  candidates,
  buyersLoading = false,
  draft,
  onDraftChange,
  onSend,
  disabled = false,
  className = 'offer-composer',
}: OfferComposerProps) {
  const priceCents = priceToCents(draft.price);
  /*
   * The server bounds an offer by `availableQty`, not by the reserved
   * `quantity`, so a stricter bound here would false-block offers the server
   * would have accepted (guardrail.ts:84).
   */
  const offerMaximum = Math.max(1, availableQty);
  const quantity = positiveInt(draft.quantity, 1);
  const buyer = candidates.find((candidate) => candidate.buyerId === draft.buyerId) ?? null;

  const verdict = evaluateOffer({
    policy,
    blockedActionKinds,
    productId,
    currentPriceCents,
    availableQty,
    buyerId: buyer?.buyerId ?? '',
    quantity,
    priceCents,
    candidates,
  });

  /*
   * An event may forbid targeted offers outright. Say so WHERE the control
   * would have been, rather than rendering controls whose action the server is
   * guaranteed to refuse.
   */
  if (verdict.code === 'kind-blocked') {
    return <p className="offer-composer-note">{verdict.message}</p>;
  }

  const sendable = verdict.sendable && buyer !== null && priceCents !== null && !disabled;

  return (
    <div className={className}>
      <BuyerPicker
        productId={productId}
        title={title}
        candidates={candidates}
        value={draft.buyerId}
        loading={buyersLoading}
        disabled={disabled}
        onChange={(buyerId) => onDraftChange({ buyerId })}
      />
      <label className="offer-composer-field">
        <span>Offer qty</span>
        <input
          aria-label={`Offer quantity for ${title}`}
          type="text"
          inputMode="numeric"
          max={offerMaximum}
          value={draft.quantity}
          disabled={disabled}
          onChange={(event) => onDraftChange({ quantity: event.target.value })}
        />
      </label>
      <label className="offer-composer-field">
        <span>Offer price</span>
        <input
          aria-label={`Offer price for ${title}`}
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={draft.price}
          disabled={disabled}
          onChange={(event) => onDraftChange({ price: event.target.value })}
        />
      </label>
      <button
        type="button"
        className="button"
        disabled={!sendable}
        title={verdict.message ?? undefined}
        onClick={() => {
          if (buyer && priceCents !== null) onSend(buyer, quantity, priceCents);
        }}
      >
        Send offer
      </button>
      {/*
        The refusal REASON, not just a dead button. A disabled control with no
        stated cause is the thing sellers report as "the app is broken".
      */}
      {verdict.message && verdict.code !== 'ok' ? (
        <p className="offer-composer-note" role="status">{verdict.message}</p>
      ) : null}
    </div>
  );
}

export default OfferComposer;
