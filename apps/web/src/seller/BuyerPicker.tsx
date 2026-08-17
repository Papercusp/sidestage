import { useId } from 'react';
import type { BuyerCandidate } from './offer-guard';
import './buyer-picker.css';

export interface BuyerPickerProps {
  /** Used only to keep labels and test ids unique per row. */
  productId: string;
  title: string;
  /** Buyers actually present in the event, from `buyerCandidates`. */
  candidates: readonly BuyerCandidate[];
  /** The selected buyer id, or '' for none. Controlled by the owning surface. */
  value: string;
  onChange: (buyerId: string) => void;
  disabled?: boolean;
  /**
   * True while the presence query is still in flight, so an empty list reads as
   * "not known yet" instead of "nobody is here" — the two say opposite things
   * to a seller and only one of them is a reason to stop.
   */
  loading?: boolean;
}

function candidateLabel(candidate: BuyerCandidate): string {
  return candidate.source === 'bidder'
    ? `${candidate.displayName} · bidder`
    : candidate.displayName;
}

/**
 * Chooses the recipient of a targeted offer from the buyers the server says are
 * in this event.
 *
 * Deliberately NOT a text input. A typed buyer id is an opaque string the
 * seller cannot verify: the server's only check is that it is non-empty
 * (guardrail.ts:78), so a typo composes a perfectly valid offer addressed to
 * nobody, and it fails silently downstream rather than at the control. Every
 * option here came from `event.chat.presence` (a 35s server-side TTL) or from
 * the live auction's bidder, so an offer can only be addressed to someone the
 * server has actually seen in this event.
 *
 * When there is nobody to choose, the control says so and stays disabled rather
 * than falling back to free text — an offer to an absent buyer is not a
 * capability worth preserving.
 */
export function BuyerPicker({
  productId,
  title,
  candidates,
  value,
  onChange,
  disabled = false,
  loading = false,
}: BuyerPickerProps) {
  const noteId = useId();
  const empty = candidates.length === 0;
  const selectedMissing = value !== '' && !candidates.some((candidate) => candidate.buyerId === value);

  return (
    <div className="buyer-picker" data-testid={`buyer-picker-${productId}`}>
      <label className="buyer-picker-field">
        <span className="sr-only">{`Offer buyer for ${title}`}</span>
        <select
          aria-label={`Offer buyer for ${title}`}
          aria-describedby={noteId}
          value={selectedMissing ? '' : value}
          disabled={disabled || empty}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">
            {loading && empty ? 'Loading buyers…' : empty ? 'No buyers in the room' : 'Choose a buyer…'}
          </option>
          {candidates.map((candidate) => (
            <option key={candidate.buyerId} value={candidate.buyerId}>
              {candidateLabel(candidate)}
            </option>
          ))}
        </select>
      </label>
      <span className={`buyer-picker-note${empty ? ' is-empty' : ''}`} id={noteId}>
        {loading && empty
          ? 'Checking who is in the room…'
          : empty
            ? 'Nobody is in this event yet'
            : `${candidates.length} in the room`}
      </span>
    </div>
  );
}

export default BuyerPicker;
